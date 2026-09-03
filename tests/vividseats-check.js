// Vivid Seats plumbing. Discovery is armed; there is no parser yet by design.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const vs = fs.readFileSync(EXT + "vividseats-adapter.js", "utf8");
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
for (const s of ["resale", "lms", "ticketmaster", "seatgeek", "stubhub",
                 "evenue", "tickpick", "axs", "vividseats"]) {
  check("SITE_LABELS " + s, !!labels[s], labels[s]);
  check("SITE_BRANDS " + s, !!brands[s], brands[s]);
  check("FEE_MULTIPLIER " + s, typeof fees[s] === "number", String(fees[s]));
}

out("");
out("--- siteFromUrl agrees in background and popup ---");
const mk = (src) => eval("(" + deCatch(extractFn(src, "siteFromUrl")) + ")");
const bgSite = mk(bg), popupSite = mk(popup);
const vsUrl = "https://www.vividseats.com/nfl/kansas-city-chiefs-tickets/production/5432109";
check("background: vividseats", bgSite(vsUrl) === "vividseats", bgSite(vsUrl));
check("popup: vividseats", popupSite(vsUrl) === "vividseats", popupSite(vsUrl));
for (const pair of [
  ["https://www.axs.com/events/123456/x", "axs"],
  ["https://www.tickpick.com/buy-x/6789012/", "tickpick"],
  ["https://seatgeek.com/x/nfl/18014270", "seatgeek"],
  ["https://www.stubhub.com/x/event/158234567/", "stubhub"],
  ["https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "ticketmaster"],
]) check(pair[1] + " unaffected", bgSite(pair[0]) === pair[1], bgSite(pair[0]));

out("");
out("--- manifest ---");
check("host permission", mf.host_permissions.some((h) => h.includes("vividseats")));
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("vividseats"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("adapter shipped", !!main && main.js.includes("vividseats-adapter.js"));
check("event-info.js loads first", !!main && main.js.indexOf("event-info.js") === 0);
check("content bridge", mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("vividseats")));
check("adapter file exists", fs.existsSync(EXT + "vividseats-adapter.js"));

out("");
out("--- event id extraction ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(vs, "getVividSeatsEventId") + ")");
const at = (pathname, search) => {
  global.window.location = { pathname, search: search || "" };
  return getId();
};
check("production path", at("/nfl/kansas-city-chiefs-tickets/production/5432109") === "5432109",
  String(at("/nfl/kansas-city-chiefs-tickets/production/5432109")));
check("bare /production/<id>", at("/production/5432109") === "5432109");
check("trailing slash", at("/production/5432109/") === "5432109");
check("query param", at("/whatever", "?productionId=5432109") === "5432109");
check("numeric tail", at("/nfl/chiefs/5432109") === "5432109");
check("short number ignored", at("/browse/page/2") === null, String(at("/browse/page/2")));
check("non-event page", at("/") === null);
// The slug carries a date; it must not win over the production id.
check("slug date not mistaken for id",
  at("/nfl/chiefs-tickets-9-14-2026/production/5432109") === "5432109",
  String(at("/nfl/chiefs-tickets-9-14-2026/production/5432109")));

out("");
out("--- the popup derives the same id ---");
const popupId = (u) => {
  if (!/vividseats\.com/.test(u)) return null;
  const m = u.match(/\/production[s]?\/(\d+)/i)
    || u.match(/[?&]productionId=(\d+)/i)
    || u.match(/\/(\d{5,})(?:[/?#]|$)/);
  return m ? m[1] : null;
};
check("popup agrees with adapter", popupId(vsUrl) === "5432109", String(popupId(vsUrl)));
check("popup keys off vividseats:<id>", /vividseats:\$\{vsEventId\}/.test(popup));
check("other sites unaffected", popupId("https://www.axs.com/events/123456/x") === null);

out("");
out("--- discovery is disarmed now that the endpoint is known ---");
// An armed probe logs every response the page makes. package-check treats it
// as a release blocker; this asserts the same thing at the source.
// Note what is NOT asserted here: that DISCOVERY_SITE is null outright. The
// probe is armed for whichever site is currently in bring-up, and that is a
// fact about that site, not about this one. package-check.js is what blocks a
// release while any probe is armed.
check("not armed for VS", !/DISCOVERY_SITE = isVividSeats/.test(inj));
check("the discovery-only capture block is gone", !/if \(isVividSeats\) return false;/.test(inj));
check("endpoint is in MATCH_PATTERNS", /\["\/hermes\/api\/v1\/listings"\]/.test(inj));
check("event info wired", /isVividSeats \? window\.__vividseatsAdapter/.test(inj));

out("");
out("--- it is a full passive-capture site now ---");
const passiveLabels = grabMap(popup, "PASSIVE_SITE_LABELS");
check("listed in PASSIVE_SITE_LABELS", passiveLabels.vividseats === "Vivid Seats",
  JSON.stringify(passiveLabels));
check("detected as passive", /isVividSeatsEvent \? "vividseats"/.test(popup));
check("no longer flagged unsupported", !/unsupported: isVividSeatsEvent/.test(popup));
check("the bring-up empty state no longer names Vivid Seats",
  !/Vivid Seats not supported yet/.test(popup));
check("parser exists", /function saveVividSeatsSeats/.test(bg));
check("dispatch calls it", /await saveVividSeatsSeats\(/.test(bg));

out("");
out("--- existing sources still wired ---");
for (const pair of [["saveSeatGeekSeats", "seatgeek"], ["saveStubHubSeats", "stubhub"],
                    ["saveEvenueSeats", "evenue"], ["saveTickPickSeats", "tickpick"],
                    ["saveAmSeats", "account manager"]]) {
  check(pair[1] + " parser intact", bg.includes("function " + pair[0]));
}

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
