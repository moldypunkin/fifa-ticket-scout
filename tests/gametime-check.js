// Gametime plumbing: site keys, url handling, manifest wiring and event ids.
// The listing parser itself is gametime-parse-check.js, and the save path is
// gametime-e2e-check.js.
//
// The one lesson carried over from Vivid Seats: a site can have its flag, its
// capture guard and its DISCOVERY_SITE tag all wired correctly and still be
// dead, because the site if/else chain in injected.js ends in an `else` that
// returns before installing the fetch/XHR hooks. This file asserts the branch
// exists; injected-load-check.js proves it by executing the script.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const gt = fs.readFileSync(EXT + "gametime-adapter.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

out("--- site keys cover every source, including the new one ---");
const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \\{[^}]*\\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
const labels = grabMap(popup, "SITE_LABELS");
const fees = grabMap(popup, "FEE_MULTIPLIER_BY_SITE");
const brands = grabMap(popup, "SITE_BRANDS");
const tags = grabMap(popup, "SITE_FILE_TAGS");
for (const s of ["resale", "lms", "ticketmaster", "seatgeek", "stubhub",
                 "evenue", "tickpick", "axs", "vividseats", "gametime"]) {
  check("SITE_LABELS " + s, !!labels[s], labels[s]);
  check("SITE_BRANDS " + s, !!brands[s], brands[s]);
  check("FEE_MULTIPLIER " + s, typeof fees[s] === "number", String(fees[s]));
  // resale and lms carry their own FIFA-specific slugs; every other site
  // should name itself in an export filename rather than rely on the fallback.
  if (s !== "resale" && s !== "lms") {
    check("SITE_FILE_TAGS " + s, !!tags[s], tags[s]);
  }
}

out("");
out("--- siteFromUrl agrees in background and popup ---");
const mk = (src) => eval("(" + deCatch(extractFn(src, "siteFromUrl")) + ")");
const bgSite = mk(bg), popupSite = mk(popup);
const gtUrl = "https://gametime.co/nfl-football/chiefs-at-broncos-tickets/" +
  "9-14-2026-denver-empower-field/events/6512ab34cd56ef7890123456";
check("background: gametime", bgSite(gtUrl) === "gametime", bgSite(gtUrl));
check("popup: gametime", popupSite(gtUrl) === "gametime", popupSite(gtUrl));
for (const pair of [
  ["https://www.vividseats.com/x/production/6965630", "vividseats"],
  ["https://www.axs.com/events/123456/x", "axs"],
  ["https://www.tickpick.com/buy-x/6789012/", "tickpick"],
  ["https://seatgeek.com/x/nfl/18014270", "seatgeek"],
  ["https://www.stubhub.com/x/event/158234567/", "stubhub"],
  ["https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "ticketmaster"],
]) check(pair[1] + " unaffected", bgSite(pair[0]) === pair[1], bgSite(pair[0]));

out("");
out("--- manifest ---");
check("host permission", mf.host_permissions.some((h) => h.includes("gametime")));
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("gametime"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("adapter shipped", !!main && main.js.includes("gametime-adapter.js"));
check("event-info.js loads first", !!main && main.js.indexOf("event-info.js") === 0);
check("injected.js loads last", !!main && main.js[main.js.length - 1] === "injected.js");
check("content bridge", mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("gametime")));
check("adapter file exists", fs.existsSync(EXT + "gametime-adapter.js"));

out("");
out("--- event id extraction ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(gt, "getGametimeEventId") + ")");
const at = (pathname, search) => {
  global.window.location = { pathname, search: search || "" };
  return getId();
};
check("events path", at("/nfl-football/x-tickets/9-14-2026-denver/events/6512ab34cd56ef7890123456")
  === "6512ab34cd56ef7890123456",
  String(at("/nfl-football/x-tickets/9-14-2026-denver/events/6512ab34cd56ef7890123456")));
check("short base62 token", at("/concert/x-tickets/baltimore/events/aB3xY9z") === "aB3xY9z");
check("singular /event/", at("/event/6512ab34cd56ef7890123456") === "6512ab34cd56ef7890123456");
check("bare 24-hex in path", at("/x/6512ab34cd56ef7890123456") === "6512ab34cd56ef7890123456");
check("query param", at("/whatever", "?eventId=6512ab34cd56ef7890123456")
  === "6512ab34cd56ef7890123456");
check("non-event page", at("/") === null, String(at("/")));
check("browse page is not an event", at("/nfl-football") === null, String(at("/nfl-football")));
// The slug carries a date and a city; neither may be mistaken for an id.
check("date slug is not an id", at("/concert/kacey-musgraves-tickets/9-5-2026-baltimore") === null,
  String(at("/concert/kacey-musgraves-tickets/9-5-2026-baltimore")));
check("a short /events/ tail is rejected", at("/events/ab") === null, String(at("/events/ab")));

out("");
out("--- the popup derives the same id ---");
const popupId = (u) => {
  if (!/gametime\.co/.test(u)) return null;
  const m = u.match(/\/events?\/([A-Za-z0-9][A-Za-z0-9_-]{5,})/i)
    || u.match(/\/([0-9a-f]{24})(?:[/?#]|$)/i)
    || u.match(/[?&]event_?[iI]d=([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
};
check("popup agrees with adapter", popupId(gtUrl) === "6512ab34cd56ef7890123456", String(popupId(gtUrl)));
check("popup keys off gametime:<id>", /gametime:\$\{gtEventId\}/.test(popup));
check("other sites unaffected", popupId("https://www.vividseats.com/x/production/6965630") === null);

out("");
out("--- discovery is disarmed now that the endpoints are known ---");
check("not armed for GT", !/DISCOVERY_SITE = isGametime/.test(inj));
check("the discovery-only capture block is gone", !/if \(isGametime\) return false;/.test(inj));
check("both endpoints in MATCH_PATTERNS",
  /\["\/v3\/listings\/", "\/v1\/events"\]/.test(inj));
check("parser exists", /function saveGametimeSeats/.test(bg));
check("event indexer exists", /function gametimeIndexEvents/.test(bg));
check("event info wired", /isGametime \? window\.__gametimeAdapter/.test(inj));
// The bug that cost a round trip on Vivid Seats: flag wired, branch missing,
// so the IIFE hit the Unknown branch and returned before hooking anything.
check("the site chain has a Gametime branch", /\} else if \(isGametime\) \{/.test(inj),
  "without this injected.js returns before installing the fetch/XHR hooks");

out("");
out("--- it is a full passive-capture site now ---");
const passiveLabels = grabMap(popup, "PASSIVE_SITE_LABELS");
check("listed in PASSIVE_SITE_LABELS", passiveLabels.gametime === "Gametime",
  JSON.stringify(passiveLabels));
check("detected as passive", /isGametimeEvent \? "gametime"/.test(popup));
check("no longer flagged unsupported", !/unsupported: isGametimeEvent/.test(popup));
// The bring-up branch stays for the next site, but names it from SITE_LABELS
// rather than hard-coding one.
check("the empty state names the site from SITE_LABELS",
  /SITE_LABELS\[detected\.unsupported\]/.test(popup));

out("");
out("--- vivid seats stayed finished ---");
// Adding a site has broken the previous one before; assert the last one is
// still parsed and still disarmed.
check("vividseats parser intact", /function saveVividSeatsSeats/.test(bg));
check("vividseats still passive", passiveLabels.vividseats === "Vivid Seats");
check("vividseats not re-armed", !/DISCOVERY_SITE = isVividSeats/.test(inj));
check("vividseats endpoint still matched", /\["\/hermes\/api\/v1\/listings"\]/.test(inj));

out("");
out("--- existing sources still wired ---");
for (const pair of [["saveSeatGeekSeats", "seatgeek"], ["saveStubHubSeats", "stubhub"],
                    ["saveEvenueSeats", "evenue"], ["saveTickPickSeats", "tickpick"],
                    ["saveAmSeats", "account manager"]]) {
  check(pair[1] + " parser intact", bg.includes("function " + pair[0]));
}

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
