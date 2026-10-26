// Ruth Eckerd Hall plumbing, while the source is in bring-up.
//
// No parser yet: the inventory endpoint is unknown and the discovery probe is
// armed to find it. What this suite pins is everything that has to be right
// BEFORE a parser exists — the id the page yields, that the popup derives the
// same one, and that the popup says "discovery running" rather than promising
// listings nothing is capturing.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const adapter = fs.readFileSync(EXT + "rutheckerd-adapter.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

// The url observed live, Queue-it token and analytics parameters included.
const LIVE_PATH = "/33733/33816";
const LIVE_URL = "https://secure.rutheckerdhall.com" + LIVE_PATH +
  "?_gl=1*xs0mo*_gcl_au*MTU2MDc5MDk0NC4xNzkzMDMxNTE1" +
  "&queueittoken=e_saftynetqueue2021v3~ts_1793031699~ce_true~rt_safetynet~h_bba84c12421f93a272d531e23826e17c38ae230baf4280a8dbe2938a2d644fed";

out("--- site keys ---");
const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \\{[^}]*\\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
check("SITE_LABELS", grabMap(popup, "SITE_LABELS").rutheckerd === "Ruth Eckerd Hall");
check("SITE_BRANDS", grabMap(popup, "SITE_BRANDS").rutheckerd === "Ruth Eckerd Hall Scout");
check("FEE_MULTIPLIER", grabMap(popup, "FEE_MULTIPLIER_BY_SITE").rutheckerd === 1.0);
check("SITE_FILE_TAGS", grabMap(popup, "SITE_FILE_TAGS").rutheckerd === "ruth-eckerd-hall");
// The background keeps its own copies for the auto-pull export; drift there
// prices or names the file differently from the popup button.
check("the background's fee copy agrees",
  grabMap(bg, "FEE_MULTIPLIER_BY_SITE").rutheckerd === 1.0);
check("the background's file tag agrees",
  grabMap(bg, "SITE_FILE_TAGS").rutheckerd === "ruth-eckerd-hall");

out("");
out("--- siteFromUrl agrees in background and popup ---");
const mk = (src) => eval("(" + deCatch(extractFn(src, "siteFromUrl")) + ")");
const bgSite = mk(bg), popupSite = mk(popup);
check("background", bgSite(LIVE_URL) === "rutheckerd", bgSite(LIVE_URL));
check("popup", popupSite(LIVE_URL) === "rutheckerd", popupSite(LIVE_URL));
for (const pair of [
  ["https://www.ticketsforless.com/events/x-7730195", "ticketsforless"],
  ["https://gotickets.com/tickets/1984079/x", "gotickets"],
  ["https://kuathletics.evenue.net/event/F26/02", "evenue"],
]) check(pair[1] + " unaffected", bgSite(pair[0]) === pair[1], bgSite(pair[0]));

out("");
out("--- manifest ---");
check("host permission", mf.host_permissions.indexOf("*://*.rutheckerdhall.com/*") >= 0);
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("rutheckerdhall"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("event-info.js loads first", !!main && main.js[0] === "event-info.js");
check("adapter shipped", !!main && main.js.includes("rutheckerd-adapter.js"));
check("injected.js loads last", !!main && main.js[main.js.length - 1] === "injected.js");
check("content bridge", mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("rutheckerdhall")));

out("");
out("--- event id: the live url and the traps in it ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(adapter, "getRuthEckerdEventId") + ")");
const at = (pathname, search) => {
  global.window.location = { pathname, search: search || "" };
  return getId();
};
// The SECOND number. The API keys every request on performanceId=33816, and
// the first is the production season — keying on the pair stored seats under
// "33733:33816" while the parser wrote "33816", so the capture worked and the
// dashboard showed nothing.
check("live url is the performance id", at(LIVE_PATH, "?queueittoken=e_saf~h_bba") === "33816",
  String(at(LIVE_PATH)));
check("the production season is not the id", at(LIVE_PATH) !== "33733");
// Queue-it issues a new token every visit. In the key it would scatter one
// event across dozens of entries, each holding part of the inventory.
check("the queue token is not in the id",
  at(LIVE_PATH, "?queueittoken=e_saf~ts_1793031699~h_bba").indexOf("queueit") === -1);
check("and neither is the analytics parameter",
  at(LIVE_PATH, "?_gl=1*xs0mo*_gcl_au*MTU2MDc5MDk0NA").indexOf("gcl") === -1);
check("a performance-only link", at("/33816") === "33816");
check("the home page is not an event", at("/") === null);
check("a short path is not an event", at("/1/2") === null, String(at("/1/2")));
check("a checkout step is not an event", at("/cart") === null);

out("");
out("--- the popup derives the same id ---");
const block = popup.match(/const isRuthEckerdSite[\s\S]*?const isRuthEckerdEvent = [^\n]+/);
check("popup detection block found", !!block);
const popupId = (url) => eval(block[0] + ";\nrehEventId");
check("popup: live url", popupId(LIVE_URL) === "33816", String(popupId(LIVE_URL)));
check("popup and adapter agree", popupId(LIVE_URL) === at(LIVE_PATH));
check("popup: another site", popupId("https://gotickets.com/tickets/1984079/x") === null);
check("popup keys off rutheckerd:<id>", /rutheckerd:\$\{rehEventId\}/.test(popup));

out("");
out("--- capture ---");
// Tessitura SYOS. Matched on the directory, not the two method names: SYOS
// ships other calls under it, background.js checks the payload shape before
// parsing, and a venue on a slightly different build would otherwise be
// invisible.
check("the SYOS directory is matched", /isRuthEckerd[\s\S]{0,600}\?\s*\["\/api\/syos\/"\]/.test(inj));
check("probe not armed for Ruth Eckerd", !/DISCOVERY_SITE = isRuthEckerd/.test(inj));
check("the site chain has a branch", /\} else if \(isRuthEckerd\) \{/.test(inj));
check("event info wired", /isRuthEckerd \? window\.__rutheckerdAdapter/.test(inj));
check("its logs reach Download logs", /"\[REH\]", "\[REH-PROBE\]"/.test(inj));
check("the dispatch requires the syos path", /site === "rutheckerd" && url\.includes\("\/api\/syos\/"\)/.test(bg));

out("");
out("--- prices: the zone, not the seat ---");
const zonePrices = eval("(" + extractFn(bg, "syosZonePrices") + ")");
// Both payloads price the zones, and they agree: Pricing has 83 + 21 for zone
// 5152, ZoneColorList has 104 for the same zone. That agreement is how the sum
// was confirmed rather than assumed.
const INIT = {
  Pricing: [
    { is_default: true, PerSeatFee: 21, zone_no: 5152, price_type: 5, price: 83,
      description: "Price Level 2", available: true },
    { is_default: true, PerSeatFee: 17, zone_no: 5153, price_type: 5, price: 63,
      description: "Price Level 3", available: true },
  ],
  ZoneColorList: [
    { zone_no: 5153, zone_label: "Price Level 3", price: 80 },
    { zone_no: 5152, zone_label: "Price Level 2", price: 104 },
  ],
  Screens: [
    { ScreenId: 1, ScreenDescription: "Front Orchestra", IsAvailable: false },
    { ScreenId: 6, ScreenDescription: "Upper Orchestra East", IsAvailable: true },
    { ScreenId: 7, ScreenDescription: "Upper Orchestra West", IsAvailable: true },
  ],
  FacilityId: 35, PerformanceId: 33816,
};
const prices = zonePrices(INIT);
check("zone 5152 is the all-in 104", prices["5152"] === 104, String(prices["5152"]));
check("zone 5153 is the all-in 80", prices["5153"] === 80, String(prices["5153"]));
// With only the parts, the fee still has to be added, or every seat reads low.
check("parts alone are summed",
  zonePrices({ Pricing: INIT.Pricing })["5152"] === 104,
  String(zonePrices({ Pricing: INIT.Pricing })["5152"]));
check("a zero price is not a price", zonePrices({ Pricing: [{ zone_no: 1, price: 0, PerSeatFee: 5 }] })["1"] === undefined);
check("an empty payload yields nothing", Object.keys(zonePrices({})).length === 0);

out("");
out("--- availability is the words, not the codes ---");
const isAvailable = eval("(" + extractFn(bg, "syosIsAvailable") + ")");
// The live capture showed seat_status -1 AND 13 both meaning "Unavailable", so
// the numbers are not a two-value flag; reading them would hide every seat or
// offer sold ones.
check("available", isAvailable({ seat_status_desc: "Available" }));
check("case and spacing do not matter", isAvailable({ seat_status_desc: " available " }));
check("unavailable at status -1", !isAvailable({ seat_status: -1, seat_status_desc: "Unavailable" }));
check("unavailable at status 13", !isAvailable({ seat_status: 13, seat_status_desc: "Unavailable" }));
check("a hold code is not available", !isAvailable({ seat_status_desc: "Hold - Production" }));
check("no description is not available", !isAvailable({}));

out("");
out("--- the performance id, from the request or the payload ---");
const perfId = eval("(" + extractFn(bg, "syosPerformanceId") + ")");
check("from the seat request",
  perfId("https://secure.rutheckerdhall.com/api/syos/GetSeatList?performanceId=33816&packageId=0&facilityId=35&screenId=7", {}) === "33816");
check("from the init request",
  perfId("https://secure.rutheckerdhall.com/api/syos/GetInitData?performanceId=33816&packageId=0", {}) === "33816");
check("from the payload when the url has none",
  perfId("https://secure.rutheckerdhall.com/api/syos/GetInitData", { PerformanceId: 33816 }) === "33816");
check("nothing anywhere", perfId("https://x/api/syos/Other", {}) === "");
// The popup looks seats up under the SECOND number in the url, which is this
// one: a mismatch stores seats where the dashboard never looks.
// Compared WHOLE, not after stripping a prefix: an earlier version of this
// line ended in .split(":").pop(), which passed while the popup keyed on
// "33733:33816" and the parser wrote "33816". The test hid the bug it existed
// to catch.
check("the parser and the popup agree on the key, exactly",
  perfId("https://secure.rutheckerdhall.com/api/syos/GetSeatList?performanceId=33816&screenId=7", {})
  === popupId(LIVE_URL),
  perfId("https://secure.rutheckerdhall.com/api/syos/GetSeatList?performanceId=33816", {}) +
  " vs " + popupId(LIVE_URL));

out("");
out("--- what the popup claims matches what exists ---");
const passive = grabMap(popup, "PASSIVE_SITE_LABELS");
check("there is a parser", /async function saveSyosSeats/.test(bg));
check("advertised as passive capture", passive.rutheckerd === "Ruth Eckerd Hall",
  JSON.stringify(passive.rutheckerd));
check("no longer flagged unsupported", !/unsupported: isRuthEckerdEvent/.test(popup));
// Seats arrive one screen at a time, so a capture of one screen is partial by
// definition and the log has to say so.
check("unseen screens are reported", /screen\(s\) not captured yet/.test(bg));
check("and a complete capture says so", /all \$\{screens\.length\} screen\(s\) captured/.test(bg));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
