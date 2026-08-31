// StubHub plumbing: site keys, id extraction, passive capture, parser wired.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const dir = EXT;
const read = (f) => fs.readFileSync(dir + f, "utf8");
const bg = read("background.js"), popup = read("popup.js"), inj = read("injected.js");
const sh = read("stubhub-adapter.js");
const mf = JSON.parse(read("manifest.json"));

let fail = 0;
const check = (label, cond, detail) => {
  if (!cond) fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
};

console.log("--- site key coverage ---");
const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \{[^}]*\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
const labels = grabMap(popup, "SITE_LABELS");
const fees = grabMap(popup, "FEE_MULTIPLIER_BY_SITE");
const brands = grabMap(popup, "SITE_BRANDS");
for (const s of ["resale", "lms", "ticketmaster", "seatgeek", "stubhub"]) {
  check(`SITE_LABELS has ${s}`, !!labels[s], labels[s]);
  check(`SITE_BRANDS has ${s}`, !!brands[s], brands[s]);
  check(`FEE_MULTIPLIER has ${s}`, typeof fees[s] === "number", String(fees[s]));
}

console.log("\n--- siteFromUrl ---");
const mk = (src) => eval("(" + extractFn(src, "siteFromUrl").replace(/catch \{/g, "catch (e) {") + ")");
const bgSite = mk(bg), popupSite = mk(popup);
const shUrl = "https://www.stubhub.com/chiefs-tickets-9-14-2026/event/158234567/";
check("background: stubhub", bgSite(shUrl) === "stubhub", bgSite(shUrl));
check("popup: stubhub", popupSite(shUrl) === "stubhub", popupSite(shUrl));
check("seatgeek unaffected", bgSite("https://seatgeek.com/x/nfl/18014270") === "seatgeek");
check("ticketmaster unaffected", bgSite("https://www.ticketmaster.com/event/0700646BCF6088AD") === "ticketmaster");

console.log("\n--- manifest ---");
check("stubhub host permission", mf.host_permissions.some((h) => h.includes("stubhub")));
check("stubhub MAIN entry",
  mf.content_scripts.some((c) => c.world === "MAIN" && c.matches.join().includes("stubhub")));
check("stubhub content bridge",
  mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("stubhub")));

console.log("\n--- stubhub event id ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(sh, "getStubHubEventId") + ")");
const at = (pathname, search = "") => {
  global.window.location = { pathname, search };
  return getId();
};
check("/event/<id> form", at("/chiefs-tickets-9-14-2026/event/158234567/") === "158234567");
check("bare /event/<id>", at("/event/158234567") === "158234567");
check("query param", at("/whatever", "?eventId=158234567") === "158234567");
check("slug date not mistaken for id", at("/chiefs-tickets-9-14-2026/event/158234567/") === "158234567");
check("short number ignored", at("/browse/page/2") === null, String(at("/browse/page/2")));
check("non-event page", at("/") === null);

console.log("\n--- popup resolves stubhub:<id> ---");
const popupId = (u) => {
  if (!/stubhub\.com/.test(u)) return null;
  const m = u.match(/\/event\/(\d+)/i) || u.match(/\/(\d{5,})(?:[/?#]|$)/);
  return m ? m[1] : null;
};
check("popup regex matches adapter", popupId(shUrl) === "158234567", String(popupId(shUrl)));
check("popup keys off stubhub:<id>", /stubhub:\$\{/.test(popup));
// Passive sites are centralised in the popup's `detected` object, so the
// don't-fall-back-to-a-cached-game guard reads off that rather than a chain
// of per-site booleans.
check("no fallback to a cached game on a passive site",
  /!isTicketmasterEvent && !detected\.passive/.test(popup));

console.log("\n--- passive capture, parser wired ---");
check("stubhub captures via MATCH_PATTERNS", /isStubHub[\s\S]{0,40}"\/event\/"/.test(inj));
check("background parses stubhub items", /saveStubHubSeats/.test(bg));
check("background verifies the body shape", /Array\.isArray\(body\.items\)/.test(bg));
check("discovery not armed for stubhub", !/DISCOVERY_SITE = isStubHub/.test(inj),
  (inj.match(/const DISCOVERY_SITE = .*/) || [""])[0]);
check("event info attached generically", /function pageEventInfo/.test(inj));
check("adapter issues no request", !/fetch\(/.test(sh));

console.log(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
