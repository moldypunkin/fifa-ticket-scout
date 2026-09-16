// TicketsForLess plumbing: site keys, url handling, manifest wiring, event ids,
// and that what the popup claims matches what the service worker can parse.
// The ticket parser is ticketsforless-parse-check.js; the save path is
// ticketsforless-e2e-check.js.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const tfl = fs.readFileSync(EXT + "ticketsforless-adapter.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

// The url observed live.
const LIVE_PATH = "/events/nfl-football-tickets/kansas-city-chiefs-vs-indianapolis-colts-2026-09-20-19-20-00-7730195";
const LIVE_URL = "https://www.ticketsforless.com" + LIVE_PATH;

out("--- site keys ---");
const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \\{[^}]*\\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
check("SITE_LABELS", grabMap(popup, "SITE_LABELS").ticketsforless === "TicketsForLess");
check("SITE_BRANDS", grabMap(popup, "SITE_BRANDS").ticketsforless === "TicketsForLess Scout");
check("FEE_MULTIPLIER", grabMap(popup, "FEE_MULTIPLIER_BY_SITE").ticketsforless === 1.0);
check("SITE_FILE_TAGS", grabMap(popup, "SITE_FILE_TAGS").ticketsforless === "ticketsforless");

out("");
out("--- siteFromUrl agrees in background and popup ---");
const mk = (src) => eval("(" + deCatch(extractFn(src, "siteFromUrl")) + ")");
const bgSite = mk(bg), popupSite = mk(popup);
check("background", bgSite(LIVE_URL) === "ticketsforless", bgSite(LIVE_URL));
check("popup", popupSite(LIVE_URL) === "ticketsforless", popupSite(LIVE_URL));
for (const pair of [
  ["https://gotickets.com/tickets/1984079/x", "gotickets"],
  ["https://gametime.co/x/events/68af55be0dcf1d7f796e5e89", "gametime"],
  ["https://www.tickpick.com/buy-x/6789012/", "tickpick"],
  ["https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF", "ticketmaster"],
]) check(pair[1] + " unaffected", bgSite(pair[0]) === pair[1], bgSite(pair[0]));

out("");
out("--- manifest ---");
check("host permission", mf.host_permissions.indexOf("*://*.ticketsforless.com/*") >= 0);
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("ticketsforless"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("event-info.js loads first", !!main && main.js[0] === "event-info.js");
check("adapter shipped", !!main && main.js.includes("ticketsforless-adapter.js"));
check("injected.js loads last", !!main && main.js[main.js.length - 1] === "injected.js");
check("content bridge", mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes("ticketsforless")));

out("");
out("--- event id: the live url and the traps in it ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(tfl, "getTicketsForLessEventId") + ")");
const at = (pathname, search) => { global.window.location = { pathname, search: search || "" }; return getId(); };
check("live url", at(LIVE_PATH) === "7730195", String(at(LIVE_PATH)));
// The slug carries "2026-09-20-19-20-00": a 4-digit year and 2-digit parts.
check("the date in the slug is not the id", ["2026", "09", "20", "19", "00"].indexOf(at(LIVE_PATH)) === -1);
check("query EventID", at("/x", "?EventID=7730195") === "7730195");
check("a quantity is not an id", at("/events/", "?quantity=2") === null);
check("home page is not an event", at("/") === null);

out("");
out("--- the popup and the api derive the same id ---");
const block = popup.match(/const isTicketsForLessSite[\s\S]*?const tflEventId = [^\n]+/);
check("popup detection block found", !!block);
// A direct eval keeps `const` declarations scoped to the eval, so the value is
// read as the eval's own completion value.
const popupId = (url) => eval(block[0] + ";\ntflEventId");
check("popup: live url", popupId(LIVE_URL) === "7730195", String(popupId(LIVE_URL)));
check("popup: other site", popupId("https://gotickets.com/tickets/1984079/x") === null);
check("popup keys off ticketsforless:<id>", /ticketsforless:\$\{tflEventId\}/.test(popup));
// The parser takes the id from the tickets request; it must match the page url
// or seats are stored where the dashboard does not look.
const apiId = ("https://www.ticketsforless.com/api/tickets/tfl?EventID=7730195".match(/[?&]eventid=(\d+)/i) || [])[1];
check("the tickets request yields the same id", apiId === popupId(LIVE_URL), apiId);

out("");
out("--- capture ---");
check("probe not armed for TicketsForLess", !/DISCOVERY_SITE = isTicketsForLess/.test(inj));
check("the discovery-only capture block is gone", !/if \(isTicketsForLess\) return false;/.test(inj));
check("tickets endpoint matched", /isTicketsForLess[\s\S]{0,400}\["\/api\/tickets\/"\]/.test(inj));
check("the site chain has a TicketsForLess branch", /\} else if \(isTicketsForLess\) \{/.test(inj));
check("event info wired", /isTicketsForLess \? window\.__ticketsforlessAdapter/.test(inj));
check("its logs reach Download logs", /"\[TFL\]", "\[TFL-PROBE\]"/.test(inj));

out("");
out("--- what the popup claims matches what exists ---");
const passive = grabMap(popup, "PASSIVE_SITE_LABELS");
const hasParser = /function saveTicketsForLessSeats/.test(bg);
check("there is a parser", hasParser);
check("advertised as passive capture", passive.ticketsforless === "TicketsForLess", JSON.stringify(passive));
check("claim and parser agree", hasParser === !!passive.ticketsforless);
check("no longer flagged unsupported", !/unsupported: isTicketsForLessEvent/.test(popup));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
