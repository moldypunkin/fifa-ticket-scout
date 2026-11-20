// Starlight Theatre — the second Tessitura venue, sharing Ruth Eckerd's parser.
//
// Identified without a capture: the ticket url answers 302 to a Queue-it
// waiting room whose own parameters name the backend —
//   ?c=kcstarlight&e=safetynetlive&man=Send%20to%20TNEW%20Live%20Safety%20Net%20Queue
// TNEW is Tessitura Network Express Web, whose seat picker is SYOS.
//
// So what is pinned here is NOT a new parser. It is the venue layer, and the
// two things that go wrong when one parser serves two venues: a hardcoded
// site or venue leaking from the first one, and the popup and the adapter
// disagreeing about which number in the url identifies the event.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");

const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const csv = fs.readFileSync(EXT + "csv-export.js", "utf8");

const QUEUE = "?queueittoken=e_safetynetlive~q_a2cabd18-cf0a-4c9c-b169-4491e139b9b0" +
  "~ts_1795206999~ce_true~rt_safetynet~h_4cb18c04d0d734887b763068aed8a8d4b";
const LIVE = "https://tickets.kcstarlight.com/gruffalo/5426" + QUEUE;

// ─── the adapter's id ───────────────────────────────────────────────────────

function loadAdapter(href) {
  const u = new URL(href);
  const logs = [];
  const win = {
    location: { href: href, hostname: u.hostname, pathname: u.pathname,
                search: u.search, origin: u.origin },
    postMessage: () => {},
  };
  const ctx = {
    window: win, document: {},
    console: { log: (...a) => logs.push(a.join(" ")) },
    setInterval: () => 1, clearInterval: () => {},
    URL, URLSearchParams, JSON, Object, Array, Number, Math, String, Boolean,
    Set, isFinite, RegExp, Error, parseInt, parseFloat,
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(down(fs.readFileSync(EXT + "starlight-adapter.js", "utf8")), ctx,
    { filename: "starlight-adapter.js" });
  return win.__starlightAdapter;
}

out("--- the event id ---");
check("the live url resolves", loadAdapter(LIVE).getEventId() === "5426",
  loadAdapter(LIVE).getEventId());
// The whole point of taking it from the path: queueittoken is a session token
// full of digits, it changes on every visit, and one of its fields is a ten
// digit timestamp. In the key it would scatter one event across many.
check("the queue token never reaches the id",
  loadAdapter(LIVE).getEventId().indexOf("1795206999") === -1);
check("and without the token it is the same",
  loadAdapter("https://tickets.kcstarlight.com/gruffalo/5426").getEventId() === "5426");
check("a trailing slash is tolerated",
  loadAdapter("https://tickets.kcstarlight.com/gruffalo/5426/").getEventId() === "5426");
check("a deeper path still takes the last number",
  loadAdapter("https://tickets.kcstarlight.com/x/gruffalo/5426").getEventId() === "5426");
check("the venue home is not an event",
  loadAdapter("https://tickets.kcstarlight.com/") .getEventId() === null);
check("another site is not Starlight",
  loadAdapter("https://tickets.kcstarlight.com/gruffalo/5426").isStarlightSite() === true);

out("");
out("--- the popup derives the same id ---");
// Drift here is the Ruth Eckerd failure: seats stored under one key, looked up
// under another, nothing shown and nothing logged as wrong.
const block = popup.match(/const isStarlightSite[\s\S]*?const isStarlightEvent = [^\n]+/);
check("the popup block is there", !!block);
const popupId = (url) => eval(block[0] + ";\nstarEventId");
check("same id from the live url", popupId(LIVE) === "5426", popupId(LIVE));
check("same id with no query", popupId("https://tickets.kcstarlight.com/gruffalo/5426") === "5426");
check("and the queue token is kept out of it too",
  String(popupId(LIVE)).indexOf("1795206999") === -1);
check("the venue home yields nothing", popupId("https://tickets.kcstarlight.com/") === null);
check("another site is untouched",
  popupId("https://secure.rutheckerdhall.com/33733/33816") === null);

out("");
out("--- one parser, two venues ---");
// The parser was written for Ruth Eckerd and had its name baked into it twice.
// Either would have filed Starlight's seats as Ruth Eckerd's: the wrong brand
// and fee table from the site, and the wrong seating map from the venue, which
// tiers every seat wrongly without erroring.
const save = extractFn(bg, "saveSyosSeats");
check("the stored site comes from the payload", /\n      site,\n/.test(save),
  /site: "/.test(save) ? "still hardcoded" : "");
check("no venue name is hardcoded in it", !/"Ruth Eckerd Hall"/.test(save));
check("the fallback venue is looked up per site",
  /SYOS_VENUE_NAMES\[site\]/.test(save));
check("and Starlight has one", /starlight: "Starlight Theatre"/.test(bg));
check("both venues are in the dispatch set",
  /SYOS_SITES = \{[^}]*rutheckerd: 1[^}]*starlight: 1/.test(bg));
check("the dispatch still requires the syos path",
  /SYOS_SITES\[site\] && url\.includes\("\/api\/syos\/"\)/.test(bg));

out("");
out("--- the key that has to match ---");
// The parser stores under the performanceId the API reports; the popup looks
// up the number in the address bar. Nothing can prove they agree without a
// live capture, so the worker says which one it used, once per event.
check("the worker names the key it stored under",
  /SYOS: storing under \$\{site\}:\$\{eventId\}/.test(bg));
check("once per event, not once per screen", /syosKeyLogged\[/.test(bg));
check("the adapter tells you what to compare it with",
  /SYOS: storing under/.test(fs.readFileSync(EXT + "starlight-adapter.js", "utf8")));

out("");
out("--- wiring ---");
check("the site is recognised in the worker",
  /h\.includes\("kcstarlight"\)\) return "starlight"/.test(bg));
check("and in the popup", /h\.includes\("kcstarlight"\)\) return "starlight"/.test(popup));
check("injected.js has a branch", /\} else if \(isStarlight\) \{/.test(inj));
check("the adapter is wired for event info",
  /isStarlight \? window\.__starlightAdapter/.test(inj));
check("the SYOS directory is captured",
  /isRuthEckerd \|\| isStarlight/.test(inj));
check("it is a passive-capture site", /isOnLocation \|\| isStarlight;/.test(inj));
check("its logs reach Download logs", /"\[STAR\]"/.test(inj) || /isStarlight \? "STAR"/.test(inj));
// A venue box office sells its own tickets, so the export says primary.
check("the CSV calls it primary", /starlight: 1/.test(csv));

const manifest = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));
check("the host is permitted",
  manifest.host_permissions.some((h) => h.indexOf("kcstarlight") !== -1));
const scripts = manifest.content_scripts.filter(
  (c) => c.matches.some((m) => m.indexOf("kcstarlight") !== -1));
check("two content scripts, MAIN and isolated", scripts.length === 2,
  String(scripts.length));
check("the adapter loads before injected.js", scripts.some(
  (c) => c.js && c.js.indexOf("starlight-adapter.js") === 1
    && c.js.indexOf("injected.js") === 2));

const labels = eval("(" + popup.match(/const SITE_LABELS = \{[^}]*\};/)[0]
  .replace(/^const SITE_LABELS = /, "").replace(/;$/, "") + ")");
check("the dashboard has a label for it", labels.starlight === "Starlight Theatre",
  labels.starlight);

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
