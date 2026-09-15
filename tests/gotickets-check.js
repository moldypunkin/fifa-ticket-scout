// GoTickets plumbing: site keys, url handling, manifest wiring, event ids, and
// that what the popup claims matches what the service worker can parse. The
// listing parser is gotickets-parse-check.js; the save path is
// gotickets-e2e-check.js.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const got = fs.readFileSync(EXT + "gotickets-adapter.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const LIVE_PATH = "/tickets/1984079/trans-siberian-orchestra-tickets/t-mobile-center-kansas-city-mo-12-29-2026";
const LIVE_URL = "https://gotickets.com" + LIVE_PATH + "?orderBy=Price%3A+Low+to+High&quantity=2";

out("--- site keys ---");
const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \\{[^}]*\\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
const labels = grabMap(popup, "SITE_LABELS");
const brands = grabMap(popup, "SITE_BRANDS");
const fees = grabMap(popup, "FEE_MULTIPLIER_BY_SITE");
const tags = grabMap(popup, "SITE_FILE_TAGS");
check("SITE_LABELS", labels.gotickets === "GoTickets", labels.gotickets);
check("SITE_BRANDS", brands.gotickets === "GoTickets Scout", brands.gotickets);
check("FEE_MULTIPLIER", fees.gotickets === 1.0, String(fees.gotickets));
check("SITE_FILE_TAGS", tags.gotickets === "gotickets", tags.gotickets);

out("");
out("--- siteFromUrl agrees in background and popup ---");
const mk = (src) => eval("(" + deCatch(extractFn(src, "siteFromUrl")) + ")");
const bgSite = mk(bg), popupSite = mk(popup);
check("background: gotickets", bgSite(LIVE_URL) === "gotickets", bgSite(LIVE_URL));
check("popup: gotickets", popupSite(LIVE_URL) === "gotickets", popupSite(LIVE_URL));
for (const pair of [
  ["https://gametime.co/x/events/68af55be0dcf1d7f796e5e89", "gametime"],
  ["https://www.vividseats.com/x/production/6965630", "vividseats"],
  ["https://tix.axs.com/qyNwCQAAAACR8mTJAAAAACb", "axs"],
  ["https://www.tickpick.com/buy-x/6789012/", "tickpick"],
  ["https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "ticketmaster"],
]) check(pair[1] + " unaffected", bgSite(pair[0]) === pair[1], bgSite(pair[0]));

out("");
out("--- manifest ---");
check("host permission", mf.host_permissions.indexOf("*://*.gotickets.com/*") >= 0);
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("gotickets"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("event-info.js loads first", !!main && main.js[0] === "event-info.js");
check("adapter shipped", !!main && main.js.includes("gotickets-adapter.js"));
check("injected.js loads last", !!main && main.js[main.js.length - 1] === "injected.js");
check("content bridge", mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("gotickets")));

out("");
out("--- event id: the live url and the traps around it ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(got, "getGoTicketsEventId") + ")");
const at = (pathname, search) => { global.window.location = { pathname, search: search || "" }; return getId(); };
check("live url", at(LIVE_PATH, "?orderBy=Price%3A+Low+to+High&quantity=2") === "1984079",
  String(at(LIVE_PATH)));
check("the slug's date is not the id", at(LIVE_PATH) !== "2026" && at(LIVE_PATH) !== "12");
check("the quantity filter is not the id", at("/tickets/", "?quantity=2") === null);
check("bare /tickets/<id>", at("/tickets/1984079") === "1984079");
check("eventId query param", at("/x", "?eventId=1984079") === "1984079");
check("home page is not an event", at("/") === null);
check("a short number is rejected", at("/tickets/12/x") === null);

out("");
out("--- the popup derives the same id the parser stores under ---");
const popupId = (u) => {
  if (!/gotickets\.com/.test(u)) return null;
  const m = u.match(/\/tickets\/(\d{4,})(?:[/?#]|$)/i)
    || u.match(/[?&](?:eventId|event_id|productionId)=(\d{4,})/i);
  return m ? m[1] : null;
};
check("popup agrees on the live url", popupId(LIVE_URL) === "1984079", String(popupId(LIVE_URL)));
check("popup keys off gotickets:<id>", /gotickets:\$\{gotEventId\}/.test(popup));
// The parser takes the id from the listings request path; it must be the same
// number the page url carries or seats land where the dashboard does not look.
const apiId = ("https://gotickets.com/rest/events/1984079/listings".match(/\/rest\/events\/(\d+)\/listings/) || [])[1];
check("the listings url yields the same id", apiId === popupId(LIVE_URL), apiId);

out("");
out("--- capture ---");
check("probe disarmed", /const DISCOVERY_SITE = null;/.test(inj));
check("the discovery-only capture block is gone", !/if \(isGoTickets\) return false;/.test(inj));
check("listings endpoint matched", /\["\/listings", "\/rest\/listing-attributes"\]/.test(inj));
// "/listings" alone would not catch the attribute table.
check("\"/listings\" does not already cover the attribute table",
  "/rest/listing-attributes".indexOf("/listings") === -1);
check("the site chain has a GoTickets branch", /\} else if \(isGoTickets\) \{/.test(inj));
check("event info wired", /isGoTickets \? window\.__goticketsAdapter/.test(inj));
check("its logs reach Download logs", /"\[GOT\]", "\[GOT-PROBE\]"/.test(inj));
check("the dispatch requires the listings path",
  /\\\/rest\\\/events\\\/\(\\d\+\)\\\/listings/.test(bg));

out("");
out("--- what the popup claims matches what exists ---");
const passive = grabMap(popup, "PASSIVE_SITE_LABELS");
const hasParser = /function saveGoTicketsSeats/.test(bg);
check("there is a parser", hasParser);
check("advertised as passive capture", passive.gotickets === "GoTickets", JSON.stringify(passive));
check("claim and parser agree", hasParser === !!passive.gotickets);
check("no longer flagged unsupported", !/unsupported: isGoTicketsEvent/.test(popup));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
