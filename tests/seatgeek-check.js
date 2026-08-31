// SeatGeek plumbing, and that the shared event-info refactor still holds.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const dir = EXT;
const read = (f) => fs.readFileSync(dir + f, "utf8");
const bg = read("background.js"), popup = read("popup.js");
const mf = JSON.parse(read("manifest.json"));
const sg = read("seatgeek-adapter.js"), tm = read("ticketmaster-adapter.js");
const shared = read("event-info.js"), inj = read("injected.js");

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
for (const s of ["resale", "lms", "ticketmaster", "seatgeek"]) {
  check(`SITE_LABELS has ${s}`, !!labels[s], labels[s]);
  check(`SITE_BRANDS has ${s}`, !!brands[s], brands[s]);
  check(`FEE_MULTIPLIER has ${s}`, typeof fees[s] === "number", String(fees[s]));
}

console.log("\n--- siteFromUrl agrees across popup and background ---");
const mk = (src) => eval("(" + extractFn(src, "siteFromUrl").replace(/catch \{/g, "catch (e) {") + ")");
const bgSite = mk(bg), popupSite = mk(popup);
const sgUrl = "https://seatgeek.com/fifa-tickets/soccer/2026-06-15/6789012";
check("background: seatgeek", bgSite(sgUrl) === "seatgeek", bgSite(sgUrl));
check("popup: seatgeek", popupSite(sgUrl) === "seatgeek", popupSite(sgUrl));
const tmUrl = "https://www.ticketmaster.com/event/0700646BCF6088AD";
check("ticketmaster still resolves", bgSite(tmUrl) === "ticketmaster" && popupSite(tmUrl) === "ticketmaster");

console.log("\n--- manifest ---");
check("seatgeek host permission", mf.host_permissions.some((h) => h.includes("seatgeek")));
const mainWorld = mf.content_scripts.filter((c) => c.world === "MAIN");
for (const cs of mainWorld) {
  check(`event-info.js before adapter for ${cs.matches.join(",")}`,
    !cs.js.some((f) => f.includes("adapter")) ||
    cs.js.indexOf("event-info.js") < cs.js.findIndex((f) => f.includes("adapter")),
    cs.js.join(" -> "));
}
check("seatgeek MAIN entry", mainWorld.some((c) => c.matches.join().includes("seatgeek")));
check("seatgeek content bridge",
  mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("seatgeek")));
for (const cs of mf.content_scripts) {
  for (const f of cs.js) check(`file exists: ${f}`, fs.existsSync(dir + f));
}

console.log("\n--- shared event-info ---");
check("event-info.js exposes read()", /window\.__eventInfo = \{[\s\S]{0,120}read: readEventInfo/.test(shared));
check("TM adapter delegates to it", /window\.__eventInfo\.read\("TM"\)/.test(tm));
check("SG adapter delegates to it", /window\.__eventInfo\.read\("SG"\)/.test(sg));
// TM mines JSON-LD for the event ID, which is a different job. What must not
// come back is a second implementation of name/date/venue reading.
check("TM does not re-implement event-info reading", !/startDate|normalizeEventDate/.test(tm));
check("TM guards against missing shared file", /event-info\.js not loaded/.test(tm));

console.log("\n--- seatgeek event id ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getEventId = eval("(" + extractFn(sg, "getSeatGeekEventId") + ")");
const tryUrl = (pathname, search = "") => {
  global.window.location = { pathname, search };
  return getEventId();
};
check("long path form", tryUrl("/fifa-tickets/soccer/2026-06-15/6789012") === "6789012");
check("short /e/ form", tryUrl("/e/6789012") === "6789012");
check("query param form", tryUrl("/whatever", "?event_id=6789012") === "6789012");
check("trailing slash tolerated", tryUrl("/fifa-tickets/soccer/6789012/") === "6789012");
check("short number not mistaken for id", tryUrl("/browse/page/2") === null);
check("non-event page -> null", tryUrl("/") === null);

console.log("\n--- passive capture, not an adapter-issued request ---");
check("adapter makes no request of its own", !/fetch\(/.test(sg));
check("adapter exposes no fetchListings", !/fetchListings/.test(sg));
check("injected matches the real endpoint", /\/api\/event_listings_v2/.test(inj));
check("probe scaffolding removed", !/SG_PROBE|probeSeatGeek|dumpListingsShape/.test(inj));
check("background parses listings", /saveSeatGeekSeats/.test(bg));
check("background keys off the id param", /extractParam\(url, "id"\)/.test(bg));
check("popup resolves seatgeek:<id>", /seatgeek:\$\{/.test(popup));

console.log(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
