// Account Manager identifies an event by an opaque url token, but ISMDS needs
// Ticketmaster's own id. The page's /api/public/v2/events/<n> response carries
// both, so hostEventId is captured and used for the scan.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const tm = fs.readFileSync(EXT + "ticketmaster-adapter.js", "utf8");

const down = (s) => s.replace(/(\w+)\?\./g, "($1 || {}).").replace(/ \?\? /g, " || ");
let logged = [];
global.console = { log: (m) => logged.push(String(m)) };
const out = require("console").log;
let fail = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; out(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else out(`ok   ${l}`);
};

// The real payload, trimmed to the fields that matter.
const EVENTS_BODY = JSON.stringify({
  id: 7524, name: "Mizzou Football vs. Arkansas Pine-Bluff",
  code: "26FB01AP", hostEventId: "060064A9DD13378D",
  seasonId: 847, datetime: "2026-09-03T19:00:00-0500",
});
const EVENTS_URL = "https://am.ticketmaster.com/mizzou/api/public/v2/events/7524?_format=json&time=1788289980";

function setup(isAM) {
  global.window = { location: { hostname: isAM ? "am.ticketmaster.com" : "www.ticketmaster.com" } };
  global.isTicketmasterAM = isAM;
  logged = [];
  global.console = { log: (m) => logged.push(String(m)) };
  return eval("(" + down(extractFn(inj, "noteAmHostEventId")) + ")");
}

out("--- the host id is captured on AM ---");
let note = setup(true);
note(EVENTS_URL, EVENTS_BODY);
eq("hostEventId parked on window", global.window.__amHostEventId, "060064A9DD13378D");
eq("it says what it did", logged.some((l) => /host event id 060064A9DD13378D/.test(l)), true);
eq("it names the internal id too", logged.some((l) => /internal id 7524/.test(l)), true);

out("--- captured once, not on every poll ---");
logged = [];
note(EVENTS_URL, JSON.stringify({ id: 7524, hostEventId: "DIFFERENT00000AA" }));
eq("first value kept", global.window.__amHostEventId, "060064A9DD13378D");
eq("silent on the repeat", logged.length, 0);

out("--- it only fires on AM ---");
note = setup(false);
note(EVENTS_URL, EVENTS_BODY);
eq("nothing captured off AM", global.window.__amHostEventId, undefined);

out("--- other endpoints and junk are ignored ---");
note = setup(true);
note("https://am.ticketmaster.com/mizzou/api/member/eventmanager/v2/events/7524/options", EVENTS_BODY);
eq("wrong path ignored", global.window.__amHostEventId, undefined);
note("https://am.ticketmaster.com/mizzou/api/public/v2/events/7524", "not json at all");
eq("unparseable body ignored", global.window.__amHostEventId, undefined);
note("https://am.ticketmaster.com/mizzou/api/public/v2/events/7524", JSON.stringify({ id: 7524 }));
eq("missing hostEventId ignored", global.window.__amHostEventId, undefined);
note("https://am.ticketmaster.com/mizzou/api/public/v2/events/7524", JSON.stringify({ hostEventId: "short" }));
eq("implausible id rejected", global.window.__amHostEventId, undefined);

out("--- the adapter prefers it over the url token ---");
global.TM_EVENT_ID = eval(tm.match(/const TM_EVENT_ID = (\/.*?\/);/)[1]);
global.AM_EVENT_ID = eval(tm.match(/const AM_EVENT_ID = (\/.*?\/i);/)[1]);
global.isAccountManager = eval("(" + extractFn(tm, "isAccountManager") + ")");
global.URLSearchParams = URLSearchParams;
global.document = { querySelector: () => null, querySelectorAll: () => [] };
const getId = eval("(" + down(extractFn(tm, "getTicketmasterEventId")) + ")");

const at = (href, hostId) => {
  const u = new URL(href);
  global.window = { location: { hostname: u.hostname, pathname: u.pathname, search: u.search, href } };
  if (hostId) global.window.__amHostEventId = hostId;
  return getId();
};
eq("host id wins when known",
   at("https://am.ticketmaster.com/mizzou/buy/ism/MjZGQjAxQVA=", "060064A9DD13378D"), "060064A9DD13378D");
eq("falls back to the token before it is seen",
   at("https://am.ticketmaster.com/mizzou/buy/ism/MjZGQjAxQVA="), "MjZGQjAxQVA=");
eq("normal ticketmaster unaffected",
   at("https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "060064A9DD13378D"), "Z7r9jZ1A7qIaF");

out("--- BOTH request hooks must call it ---");
// It was wired to fetch only. The AM event payload arrives by XHR, so
// hostEventId was never captured and the scan kept using the url token — the
// symptom looked like the capture logic was wrong when it simply never ran.
const hooks = (inj.match(/noteAmHostEventId\(/g) || []).length;
eq("declared once, called from two hooks", hooks, 3);
eq("fetch hook calls it", /response\.clone\(\)\.text\(\)\.then\([\s\S]{0,60}noteAmHostEventId\(url, t\)/.test(inj), true);
eq("xhr hook calls it", /noteAmHostEventId\(this\._ftsUrl, body\)/.test(inj), true);
eq("xhr guard is AM-scoped", /if \(isTicketmasterAM && this\._ftsUrl\)/.test(inj), true);
eq("xhr reads responseText defensively", /try \{ body = this\.responseText; \}/.test(inj), true);

out("--- AM does not attempt the ISMDS scan at all ---");
// ISMDS is cross-origin from am.ticketmaster.com and blocked at the network
// layer, confirmed with a VALID ISMDS id. Attempting it only produced a
// "Failed to fetch" that read like a bug. Inventory comes from the page's own
// ISM calls instead.
eq("scan returns early on AM", /Account Manager: inventory is captured from the page/.test(inj), true);
eq("no dead branch left behind", /if \(false\)/.test(inj), false);
eq("no stale scanEventId reference", /scanEventId/.test(inj), false);
eq("facets still fetched on normal ticketmaster",
   /fetchFacets\(eventId, token, correlationId\)/.test(inj), true);

out("--- storage is keyed by the URL TOKEN, not the host id ---");
// The popup derives its key from the url and cannot see window.__amHostEventId,
// so seats stored under the host id would be invisible to it. The token is
// also stable from first paint, while the host id only appears after an XHR —
// keying on it would pair the two ISM payloads under different keys depending
// on arrival order.
eq("token helper exists", /function amUrlToken/.test(inj), true);
eq("payloads carry the token", /amEventId: isTicketmasterAM \? amUrlToken\(\)/.test(inj), true);
eq("host id is not the key", /amEventId: isTicketmasterAM \? \(window\.__amHostEventId/.test(inj), false);

out("--- event name/date come from AM's own API ---");
// AM publishes no JSON-LD, so the shared reader returns nulls and the popup
// sat on "Match data loading...". The events payload already being parsed for
// hostEventId carries both.
{
  const note = setup(true);
  // No __eventInfo stub on purpose: the date must parse without event-info.js,
  // since a missing helper previously produced a silent "?" in the popup.
  note(EVENTS_URL, JSON.stringify({
    id: 7524, name: "Mizzou Football vs. Arkansas Pine-Bluff",
    hostEventId: "060064A9DD13378D", datetime: "2026-09-03T19:00:00-0500",
    venue: { id: 1 },
  }));
  const info = global.window.__amEventInfo || {};
  eq("name captured", info.name, "Mizzou Football vs. Arkansas Pine-Bluff");
  eq("date normalised", info.date, "03-09-2026 - 19:00");
  eq("venue id noted", info.venueId, "1");
}

out("--- the venue name is resolved from the venues payload ---");
{
  const noteVenues = eval("(" + down(extractFn(inj, "amNoteVenues")) + ")");
  global.isTicketmasterAM = true;
  global.window.__amEventInfo = { venueId: "1" };
  noteVenues("https://am.ticketmaster.com/mizzou/api/admin/v2/venues?_format=json",
    JSON.stringify({ 1: { name: "Faurot Field" }, 2: { name: "Mizzou Arena" } }));
  eq("venue resolved", global.window.__amEventInfo.venue, "Faurot Field");

  // Field names are unconfirmed, so alternates are tried and a miss is safe.
  global.window.__amEventInfo = { venueId: "2" };
  noteVenues("https://x/api/admin/v2/venues", JSON.stringify({ 2: { venueName: "Alt Field" } }));
  eq("alternate field name", global.window.__amEventInfo.venue, "Alt Field");

  global.window.__amEventInfo = { venueId: "3" };
  noteVenues("https://x/api/admin/v2/venues", JSON.stringify({ 3: { someOtherKey: 1 } }));
  eq("no name field -> venue stays unset", global.window.__amEventInfo.venue, undefined);

  global.window.__amEventInfo = { venueId: "9" };
  noteVenues("https://x/api/admin/v2/venues", JSON.stringify({ 1: { name: "X" } }));
  eq("unknown id -> unset", global.window.__amEventInfo.venue, undefined);
}

out("--- venueName comes straight from ismConfiguration ---");
// Better than the venues list: no id lookup and no guessing at field names.
// Without a venue, tierFor() falls back to the section heuristic and the popup
// badge reads "no venue - heuristic".
{
  const noteName = eval("(" + down(extractFn(inj, "amNoteVenueName")) + ")");
  global.isTicketmasterAM = true;
  global.window.__amEventInfo = {};
  noteName("https://ism-prod-api.ticketmaster.com/v810/ismConfiguration/applicationType/buy/venueId/1",
    JSON.stringify({ data: { venueName: "Faurot Field", appConfiguration: {} }, errorCode: 200 }));
  eq("venue captured", global.window.__amEventInfo.venue, "Faurot Field");

  // A venue already resolved from the venues list must not be overwritten.
  global.window.__amEventInfo = { venue: "Already Known" };
  noteName("https://x/v810/ismConfiguration/x", JSON.stringify({ data: { venueName: "Other" } }));
  eq("existing venue kept", global.window.__amEventInfo.venue, "Already Known");

  global.window.__amEventInfo = {};
  noteName("https://x/v810/priceData/buy", JSON.stringify({ data: { venueName: "Wrong Endpoint" } }));
  eq("other endpoints ignored", global.window.__amEventInfo.venue, undefined);

  noteName("https://x/v810/ismConfiguration/x", "not json");
  eq("bad body ignored", global.window.__amEventInfo.venue, undefined);

  noteName("https://x/v810/ismConfiguration/x", JSON.stringify({ data: { venueName: "   " } }));
  eq("blank name ignored", global.window.__amEventInfo.venue, undefined);
}

out("--- pageEventInfo prefers the AM source on AM ---");
eq("AM branch present", /isTicketmasterAM && window\.__amEventInfo && window\.__amEventInfo\.name/.test(inj), true);
eq("both observers run on fetch", /noteAmHostEventId\(url, t\);[\s\S]{0,40}amNoteVenues\(url, t\)/.test(inj), true);
eq("both observers run on xhr", /noteAmHostEventId\(this\._ftsUrl, body\);[\s\S]{0,60}amNoteVenues\(this\._ftsUrl, body\)/.test(inj), true);

out("--- the dump budget is not spent on empty bodies ---");
eq("trivial bodies skipped", /const trivial = text\.trim\(\)\.length < 50;/.test(inj), true);
eq("budget raised to 8", /probeStats\.smallDumped < 8/.test(inj), true);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
