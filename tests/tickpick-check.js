// TickPick plumbing + discovery armed. No parser yet by design.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const dir = EXT;
const read = (f) => fs.readFileSync(dir + f, "utf8");
const bg = read("background.js"), popup = read("popup.js"), inj = read("injected.js");
const tp = read("tickpick-adapter.js");
const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = require("console").log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

out("--- all seven site keys ---");
const grab = (src, name) => eval("(" + src.match(new RegExp("const " + name + " = \{[^}]*\}"))[0].replace(new RegExp("^const " + name + " = "), "") + ")");
const labels = grab(popup, "SITE_LABELS"), fees = grab(popup, "FEE_MULTIPLIER_BY_SITE"), brands = grab(popup, "SITE_BRANDS");
for (const s of ["resale","lms","ticketmaster","seatgeek","stubhub","evenue","tickpick"]) {
  check(`labels ${s}`, !!labels[s], labels[s]);
  check(`brands ${s}`, !!brands[s], brands[s]);
  check(`fees ${s}`, typeof fees[s] === "number", String(fees[s]));
}

out("\n--- siteFromUrl agrees, others unaffected ---");
const bgSite = eval("(" + deCatch(extractFn(bg, "siteFromUrl", "")) + ")");
const pSite = eval("(" + deCatch(extractFn(popup, "siteFromUrl", "")) + ")");
const tpUrl = "https://www.tickpick.com/buy-kansas-city-chiefs-tickets-arrowhead-11-22-26-1pm/6789012/";
check("background: tickpick", bgSite(tpUrl) === "tickpick", bgSite(tpUrl));
check("popup: tickpick", pSite(tpUrl) === "tickpick", pSite(tpUrl));
for (const [u, want] of [
  ["https://kuathletics.evenue.net/event/F26/02", "evenue"],
  ["https://www.stubhub.com/x/event/160425133", "stubhub"],
  ["https://seatgeek.com/x/nfl/18014270", "seatgeek"],
  ["https://www.ticketmaster.com/event/0700646BCF6088AD", "ticketmaster"],
]) check(`${want} unaffected`, bgSite(u) === want, bgSite(u));

out("\n--- tickpick event id ---");
global.window = { location: {} }; global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(tp, "getTickPickEventId") + ")");
const at = (pathname, search = "") => { global.window.location = { pathname, search }; return getId(); };
check("long slug + trailing id", at("/buy-kansas-city-chiefs-tickets-arrowhead-11-22-26-1pm/6789012/") === "6789012", String(at("/buy-kansas-city-chiefs-tickets-arrowhead-11-22-26-1pm/6789012/")));
check("short /e/ form", at("/e/6789012") === "6789012");
check("query param", at("/whatever", "?eventId=6789012") === "6789012");
check("short number ignored", at("/browse/page/2") === null, String(at("/browse/page/2")));
check("non-event page", at("/") === null);

out("\n--- popup derives the same id ---");
const popupId = (u) => {
  if (!/tickpick\.com/.test(u)) return null;
  const m = u.match(/\/e\/(\d+)/i) || u.match(/\/(\d{5,})(?:[/?#]|$)/);
  return m ? m[1] : null;
};
check("popup agrees with adapter", popupId(tpUrl) === "6789012", String(popupId(tpUrl)));
check("popup keys off tickpick:<id>", /`tickpick:\$\{tpEventId\}`/.test(popup));
check("no fallback to a cached game", /!isTicketmasterEvent && !detected\.passive/.test(popup));

out("\n--- tickpick parsed, discovery retired ---");
check("discovery not armed for tickpick", !/DISCOVERY_SITE = isTickPick/.test(inj), (inj.match(/const DISCOVERY_SITE = .*/) || [""])[0]);
check("tickpick captured via MATCH_PATTERNS", /\["\/listings\/internal\/event-v2\/"\]/.test(inj));
check("tickpick parser present", /function saveTickPickSeats/.test(bg));
check("parking excluded", /function tickPickIsParking/.test(bg));
check("TP tags registered", /"\[TP\]"/.test(inj) && /"\[TP-PROBE\]"/.test(inj));
check("evenue still captured", /"\/pac-api\/"/.test(inj));
check("evenue parser intact", /function saveEvenueSeats/.test(bg));
check("stubhub parser intact", /function saveStubHubSeats/.test(bg));
check("seatgeek parser intact", /function saveSeatGeekSeats/.test(bg));
check("event info wired for tickpick", /isTickPick \? window\.__tickpickAdapter/.test(inj));

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
