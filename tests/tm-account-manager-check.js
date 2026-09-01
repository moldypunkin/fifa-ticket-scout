// Ticketmaster Account Manager (am.ticketmaster.com) — a white-label portal on
// a Ticketmaster host with no /event/ segment:
//   https://am.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA=
// The adapter reported "No event ID on this page" and sat idle.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const tm = fs.readFileSync(EXT + "ticketmaster-adapter.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");

const down = (s) => s.replace(/(\w+)\?\./g, "($1 || {}).").replace(/ \?\? /g, " || ");
global.URLSearchParams = URLSearchParams;
global.TM_EVENT_ID = eval(tm.match(/const TM_EVENT_ID = (\/.*?\/);/)[1]);
global.AM_EVENT_ID = eval(tm.match(/const AM_EVENT_ID = (\/.*?\/i);/)[1]);
global.isAccountManager = eval("(" + extractFn(tm, "isAccountManager") + ")");
global.document = { querySelector: () => null, querySelectorAll: () => [] };
const getId = eval("(" + down(extractFn(tm, "getTicketmasterEventId")) + ")");

const at = (href) => {
  const u = new URL(href);
  global.window = { location: { hostname: u.hostname, pathname: u.pathname, search: u.search, href } };
  return getId();
};

let fail = 0;
const out = console.log;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; out(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else out(`ok   ${l}`);
};

out("--- the reported url ---");
eq("mizzou AM page resolves", at("https://am.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA="), "MjZQGjAxQVA=");
eq("other tenants work too", at("https://am.ticketmaster.com/badgers/buy/ism/AbCd1234XyZ="), "AbCd1234XyZ=");
eq("other buy flows", at("https://am.ticketmaster.com/mizzou/buy/resale/QQQQ1111ZZ=="), "QQQQ1111ZZ==");
eq("trailing path tolerated", at("https://am.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA=/seats"), "MjZQGjAxQVA=");
eq("query string tolerated", at("https://am.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA=?x=1"), "MjZQGjAxQVA=");

out("--- host gating: the AM rule must not leak ---");
eq("normal TM /buy/ path is NOT treated as AM",
   at("https://www.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA="), null);
eq("AM landing page has no id", at("https://am.ticketmaster.com/mizzou/"), null);
eq("AM account page has no id", at("https://am.ticketmaster.com/mizzou/manage"), null);

out("--- existing shapes still work ---");
eq("modern id", at("https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"), "Z7r9jZ1A7qIaF");
eq("legacy hex id", at("https://www.ticketmaster.com/event/0F006482E69174BF"), "0F006482E69174BF");
eq("hyphenated id kept whole", at("https://www.ticketmaster.com/event/Z7r9jZ1A7-3jg"), "Z7r9jZ1A7-3jg");
eq("slug + event", at("https://www.ticketmaster.com/michigan-vs-oklahoma-09-12-2026/event/Z7r9jZ1A7qIaF"), "Z7r9jZ1A7qIaF");
eq("query param form", at("https://www.ticketmaster.com/checkout?eventId=Z7r9jZ1A7qIaF"), "Z7r9jZ1A7qIaF");

out("--- the popup must agree, or it scans a page it cannot show ---");
const popupId = eval("(" + down(extractFn(popup, "ticketmasterEventIdFromUrl")) + ")");
global.TM_EVENT_ID_RE = eval(popup.match(/const TM_EVENT_ID_RE = (\/.*?\/);/)[1]);
global.TM_AM_EVENT_ID_RE = eval(popup.match(/const TM_AM_EVENT_ID_RE = (\/.*?\/i);/)[1]);
for (const [url, want] of [
  ["https://am.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA=", "MjZQGjAxQVA="],
  ["https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "Z7r9jZ1A7qIaF"],
  ["https://www.ticketmaster.com/mizzou/buy/ism/MjZQGjAxQVA=", null],
  ["https://seatgeek.com/x/nfl/18014270", null],
]) eq(`popup: ${url.slice(8, 58)}`, popupId(url), want);

out("--- discovery is armed for AM only ---");
// AM is parsed now (venueAvailability + priceData), so the probe is
// disarmed. What must remain is the capture and the parser.
eq("discovery not armed for AM", /DISCOVERY_SITE = isTicketmasterAM/.test(inj), false);
eq("AM inventory is captured", /"\/v810\/venueAvailability\/", "\/v810\/priceData\/"/.test(inj), true);
eq("AM parser present", /function saveAmSeats/.test(fs.readFileSync(EXT + "background.js", "utf8")), true);
eq("scoped to the am host", /am\\.ticketmaster\\.com\$/.test(inj) || /am\.ticketmaster/.test(inj), true);
eq("not armed for other sites", !/DISCOVERY_SITE = is(StubHub|SeatGeek|Evenue|TickPick|Axs)/.test(inj), true);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
