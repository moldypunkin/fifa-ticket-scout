// Evenue plumbing + the probe's new non-JSON reporting (Evenue is a legacy
// CGI platform, so its inventory may be HTML rather than JSON).
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const dir = EXT;
const read = (f) => fs.readFileSync(dir + f, "utf8");
const bg = read("background.js"), popup = read("popup.js"), inj = read("injected.js");
const ev = read("evenue-adapter.js");
const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = require("console").log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

out("--- site keys cover all six sites ---");
const grab = (src, name) => eval("(" + src.match(new RegExp("const " + name + " = \{[^}]*\}"))[0].replace(new RegExp("^const " + name + " = "), "") + ")");
const labels = grab(popup, "SITE_LABELS"), fees = grab(popup, "FEE_MULTIPLIER_BY_SITE"), brands = grab(popup, "SITE_BRANDS");
for (const s of ["resale","lms","ticketmaster","seatgeek","stubhub","evenue"]) {
  check(`labels ${s}`, !!labels[s], labels[s]);
  check(`brands ${s}`, !!brands[s], brands[s]);
  check(`fees ${s}`, typeof fees[s] === "number", String(fees[s]));
}

out("\n--- siteFromUrl ---");
const bgSite = eval("(" + deCatch(extractFn(bg, "siteFromUrl", "")) + ")");
const pSite = eval("(" + deCatch(extractFn(popup, "siteFromUrl", "")) + ")");
const evUrl = "https://evenue.net/cgi-bin/ncommerce3/SEGetEventInfo?ticketCode=ABC123&linkID=xyz";
check("background: evenue", bgSite(evUrl) === "evenue", bgSite(evUrl));
check("popup: evenue", pSite(evUrl) === "evenue", pSite(evUrl));
check("stubhub unaffected", bgSite("https://www.stubhub.com/x/event/160425133") === "stubhub");
check("seatgeek unaffected", bgSite("https://seatgeek.com/x/nfl/18014270") === "seatgeek");

out("\n--- evenue event id from query params ---");
global.window = { location: {} }; global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(ev, "getEvenueEventId") + ")");
const tryUrl = (search, pathname = "/cgi-bin/ncommerce3/SEGetEventInfo") => {
  global.window.location = { pathname, search };
  return getId();
};
check("ticketCode wins", tryUrl("?ticketCode=ABC123&linkID=xyz") === "ABC123", String(tryUrl("?ticketCode=ABC123&linkID=xyz")));
check("eventId form", tryUrl("?eventId=998877") === "998877");
check("linkID fallback", tryUrl("?linkID=zz9") === "zz9");
check("no params -> null on cgi path", tryUrl("") === null, String(tryUrl("")));
check("numeric path tail accepted", tryUrl("", "/events/998877") === "998877", String(tryUrl("", "/events/998877")));
check("cgi script name NOT taken as id", tryUrl("", "/cgi-bin/ncommerce3/EVExecMacro") === null, String(tryUrl("", "/cgi-bin/ncommerce3/EVExecMacro")));

out("\n--- popup and adapter agree on the id ---");
const popupId = (u) => {
  if (!/evenue\.net/.test(u)) return null;
  for (const k of ["ticketCode","eventId","eventID","event_id","performanceId","linkID"]) {
    const m = u.match(new RegExp("[?&]" + k + "=([A-Za-z0-9_-]+)"));
    if (m) return m[1];
  }
  return null;
};
check("same id from the same url", popupId(evUrl) === "ABC123", String(popupId(evUrl)));
check("popup keys off evenue:<id>", /`evenue:\$\{evEventId\}`/.test(popup));
check("no fallback to a cached game", /!isTicketmasterEvent && !detected\.passive/.test(popup));

out("\n--- evenue is parsed now, discovery retired ---");
check("captures the seat-availability path", /"\/pac-api\/"/.test(inj));
check("discovery not armed for evenue", !/DISCOVERY_SITE = isEvenue/.test(inj), (inj.match(/const DISCOVERY_SITE = .*/) || [""])[0]);
check("background parses evenue", /function saveEvenueSeats/.test(bg));
check("columns mapped by name", /function evenueColumnIndex/.test(bg));
check("EV tags registered for the log relay", /"\[EV\]"/.test(inj));
out("\n--- large non-JSON is now named, not just counted ---");
const logged = [];
const setupProbe = require("./probe-env");
const probe = setupProbe(logged).probeResponse;
global.DISCOVERY_SITE = "EV";
global.probeStats.htmlReported = 0;

const html = "<html><head><title>Tickets</title></head><body>" +
  "<table>" + "<tr><td>Sec 101</td><td>Row 5</td><td>$45.00</td></tr>".repeat(400) + "</table>" +
  "</body></html>";
logged.length = 0;
probe("https://evenue.net/cgi-bin/ncommerce3/EVExecMacro?linkID=zz9", html);
check("reported", logged.length >= 3, logged.length + " lines");
check("says non-JSON with size", logged.some((l) => /non-JSON \d+\.\dkB/.test(l)), logged[0]);
check("shows how it starts", logged.some((l) => /starts: <html>/.test(l)), logged[1]);
check("counts tables and rows", logged.some((l) => /html: 1 tables, 400 rows/.test(l)), logged[2]);
check("counted as nonJson", global.probeStats.nonJson === 1, JSON.stringify(global.probeStats));

out("\n--- small non-JSON stays quiet ---");
logged.length = 0;
probe("https://evenue.net/small", "<html><body>hi</body></html>");
check("silent", logged.length === 0, logged[0]);

out("\n--- same non-JSON path reported once ---");
logged.length = 0;
probe("https://evenue.net/cgi-bin/ncommerce3/EVExecMacro?linkID=other", html);
check("deduped by path", logged.length === 0, logged.length + " lines");

out("\n--- JSON path still works if evenue turns out to be JSON ---");
logged.length = 0;
const json = JSON.stringify({ listings: Array.from({ length: 50 }, (_, i) => ({ section: "101", row: "5", price: 45 + i, quantity: 2 })) });
probe("https://evenue.net/api/inventory", json + " ".repeat(25000));
check("json reported", logged.some((l) => /CANDIDATE listings/.test(l)), logged.find((l) => /BEST/.test(l)));

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
