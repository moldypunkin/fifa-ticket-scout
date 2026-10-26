// Auto-pull: TicketPortal's "⇣ Pull" opens a page with #ts-auto, and the
// background downloads the CSV once the page has finished loading, then closes
// the tab. Three things matter, and each has its own section:
//   1. the background's copies of popup code (fees, file tags, TM event ids)
//      have not drifted from the popup's — they price and name the file;
//   2. the "is the page done?" rule never exports a page that may be partial,
//      because the portal treats the file as the whole picture and a partial
//      one would wipe real listings off its board;
//   3. the popup button and the auto-pull write the same file.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const content = fs.readFileSync(EXT + "content.js", "utf8");
const popupHtml = fs.readFileSync(EXT + "popup.html", "utf8");
const csvSrc = fs.readFileSync(EXT + "csv-export.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

// node 12 predates ?. and ??; Chrome supports both.
const down = (s) => s
  .replace(/\?\.\[/g, "[")
  .replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.")
  .replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const grabMap = (src, name) =>
  eval("(" + src.match(new RegExp("const " + name + " = \\{[^}]*\\}"))[0]
    .replace(new RegExp("^const " + name + " = "), "") + ")");
const grabRe = (src, name) => {
  const m = src.match(new RegExp("const " + name + " = (/.*/[a-z]*);"));
  return m ? m[1] : null;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

out("--- 1. the background's copies match the popup ---");
for (const name of ["FEE_MULTIPLIER_BY_SITE", "FEE_FLAT_BY_SITE"]) {
  check(name + " identical", same(grabMap(bg, name), grabMap(popup, name)));
}
// SITE_FILE_TAGS spans lines; grabMap's [^}]* still reads it whole.
check("SITE_FILE_TAGS identical", same(grabMap(bg, "SITE_FILE_TAGS"), grabMap(popup, "SITE_FILE_TAGS")));
check("siteFileTag identical", extractFn(bg, "siteFileTag") === extractFn(popup, "siteFileTag"));
check("ticketmasterEventIdFromUrl identical",
  extractFn(bg, "ticketmasterEventIdFromUrl") === extractFn(popup, "ticketmasterEventIdFromUrl"));
for (const name of ["TM_EVENT_ID_RE", "TM_AM_EVENT_ID_RE"]) {
  check(name + " identical", !!grabRe(bg, name) && grabRe(bg, name) === grabRe(popup, name), grabRe(bg, name));
}

// feeUSD is centsToUSD with the popup's globals passed in. Same numbers for
// every site, with and without an event fee table.
{
  global.FEE_MULTIPLIER_BY_SITE = grabMap(popup, "FEE_MULTIPLIER_BY_SITE");
  global.FEE_FLAT_BY_SITE = grabMap(popup, "FEE_FLAT_BY_SITE");
  const feeUSD = eval("(" + down(extractFn(bg, "feeUSD")) + ")");
  const centsToUSD = eval("(" + down(extractFn(popup, "centsToUSD")) + ")");
  let mismatches = 0;
  const sites = Object.keys(global.FEE_MULTIPLIER_BY_SITE).concat(["somewhere-new"]);
  for (const site of sites) {
    for (const fees of [null, { pct: 7 }, { flat: 3.5 }, { pct: 10, flat: 2 }]) {
      for (const cents of [0, 12345, 99999000]) {
        global.currentSite = site; global.currentFees = fees;
        if (Math.abs(feeUSD(cents, site, fees) - centsToUSD(cents)) > 1e-9) mismatches++;
      }
    }
  }
  check("feeUSD == centsToUSD across every site and fee table", mismatches === 0, mismatches + " mismatch(es)");
}

out("\n--- 2. the page-done rule ---");
global.AUTO_MAX_MS = Number(bg.match(/const AUTO_MAX_MS = (\d+);/)[1]);
global.AUTO_STABLE_MS = Number(bg.match(/const AUTO_STABLE_MS = (\d+);/)[1]);
const verdict = eval("(" + down(extractFn(bg, "autoPullVerdict")) + ")");
const T0 = 1000000;
const job = (o) => Object.assign({ armedAt: T0, freshFor: "seatgeek:1", scanStatus: null, lastCount: 50, stableSince: T0 }, o);
const settled = T0 + AUTO_STABLE_MS + 1;
check("settled page exports", verdict(job({}), "seatgeek:1", 50, settled) === "export");
check("count still changing waits", verdict(job({ lastCount: 40 }), "seatgeek:1", 50, settled) === "wait");
check("not stable long enough waits", verdict(job({}), "seatgeek:1", 50, T0 + AUTO_STABLE_MS - 1) === "wait");
check("zero listings waits", verdict(job({ lastCount: 0 }), "seatgeek:1", 0, settled) === "wait");
check("scan in progress waits, however stable",
  verdict(job({ scanStatus: "scanning" }), "seatgeek:1", 50, settled) === "wait");
check("scan complete exports", verdict(job({ scanStatus: "complete" }), "seatgeek:1", 50, settled) === "export");
check("scan error gives up", !/^(wait|export)$/.test(verdict(job({ scanStatus: "error" }), "seatgeek:1", 50, settled)));
// The case the freshness gate exists for: the stored event still holds an
// EARLIER visit's seats, so the count is non-zero and stable before this page
// has sent anything. That must never export.
check("old seats from an earlier visit never export",
  verdict(job({ freshFor: null }), "seatgeek:1", 50, settled) === "wait");
check("no event known yet waits", verdict(job({}), null, 0, settled) === "wait");
check("timeout with nothing captured gives up",
  /no listings/.test(verdict(job({ lastCount: 0 }), "seatgeek:1", 0, T0 + AUTO_MAX_MS + 1)));
check("timeout while still changing gives up rather than exporting",
  /never settled/.test(verdict(job({ lastCount: 40 }), "seatgeek:1", 50, T0 + AUTO_MAX_MS + 1)));

// The 2026-10-26 SeatGeek miss: its listings were saved, then a same-page
// address change wiped tabGameMap, and the pull lost its event and waited for
// ever. The event the seats were saved under must outlive that.
const gameKeyOf = eval("(" + extractFn(bg, "autoPullGameKey") + ")");
check("event survives tabGameMap being wiped", gameKeyOf({ freshFor: "seatgeek:17956823" }, undefined) === "seatgeek:17956823");
check("before any save, falls back to tabGameMap", gameKeyOf({ freshFor: null }, "seatgeek:1") === "seatgeek:1");
check("nothing known -> null", gameKeyOf({ freshFor: null }, undefined) === null);
check("the tick uses it, not tabGameMap alone",
  /const gameKey = autoPullGameKey\(job, tabGameMap\[tabId\]\);/.test(extractFn(bg, "autoPullTick")));

out("\n--- mergeSeats: this page's seats only ---");
global.autoPull = {};
const mergeSeats = eval("(" + extractFn(bg, "mergeSeats") + ")");
const old = { a: { price: 1 }, b: { price: 2 } };
check("no auto-pull: merges as before", same(Object.keys(mergeSeats(old, { c: {} }, 7, "k")).sort(), ["a", "b", "c"]));
autoPull[7] = { done: false, freshFor: null };
check("first save after arming replaces", same(Object.keys(mergeSeats(old, { c: {} }, 7, "k")), ["c"]));
check("later saves merge", same(Object.keys(mergeSeats({ c: {} }, { d: {} }, 7, "k")).sort(), ["c", "d"]));
check("another tab is untouched", same(Object.keys(mergeSeats(old, { c: {} }, 8, "k")).sort(), ["a", "b", "c"]));
const rawMerges = (bg.match(/games\[gameKey\]\.seats = \{ \.\.\.games\[gameKey\]\.seats, \.\.\.seats \};/g) || []).length;
const viaHelper = (bg.match(/games\[gameKey\]\.seats = mergeSeats\(games\[gameKey\]\.seats, seats, tabId, gameKey\);/g) || []).length;
check("every save path goes through mergeSeats", rawMerges === 0 && viaHelper === 11, `${rawMerges} raw, ${viaHelper} via helper`);

out("\n--- 3. one CSV builder, shared ---");
const ctx = {};
new Function("self", csvSrc)(ctx);
const build = ctx.buildScoutCsv;
const game = {
  site: "seatgeek",
  match: { name: "Chiefs vs. Broncos", date: "02-11-2026 - 12:00", venue: "Arrowhead", currency: "USD" },
  seats: {
    x: { block: "112", area: "Lower", row: "5", seat: "3", category: "C", price: 20000, exclusive: true },
    y: { block: "101", area: "Lower, East", row: "2", seat: "1", category: "C", price: 10000, exclusive: true },
    z: { block: "101", area: "Lower", row: "2", seat: "2", category: "C", price: 5000, exclusive: false },
  },
};
const opts = { gameKey: "seatgeek:9", now: new Date(2026, 10, 1, 9, 5), priceUSD: (c) => c / 1000,
  tierFor: () => "Lower (100s)", fileTag: (s) => s };
const r = build(game, opts);
const lines = r.csv.split("\n");
check("header block", lines[0] === "# Match: Chiefs vs. Broncos" && lines[2] === "# Venue: Arrowhead" && lines[4] === "# Site: seatgeek");
check("falls back to the game key for Performance ID", lines[5] === "# Performance ID: seatgeek:9");
check("Total Seats counts exportable seats only", lines.includes("# Total Seats: 2") && r.count === 2);
check("no Auto line from the button", !r.csv.includes("# Auto:"));
check("Auto line from an auto-pull", build(game, Object.assign({ auto: true }, opts)).csv.includes("\n# Auto: yes\n"));
check("cheapest first, comma area quoted",
  lines[lines.indexOf("Block,Area,Row,Seat,Seat_Range,Category,Tier,Price_USD,Exclusive") + 1] === '101,"Lower, East",2,1,,C,Lower (100s),10.00,true');
check("filename = site_match_stamp", r.filename === "seatgeek_Chiefs_vs__Broncos_20261101_0905.csv", r.filename);
check("nothing to export -> null", build({ seats: {} }, opts) === null && build(null, opts) === null);
check("popup loads csv-export.js before popup.js",
  popupHtml.indexOf('src="csv-export.js"') > 0 && popupHtml.indexOf('src="csv-export.js"') < popupHtml.indexOf('src="popup.js"'));
check("background imports csv-export.js", /importScripts\([^)]*"csv-export\.js"/.test(bg));
check("popup's button uses the builder", /buildScoutCsv\(game, \{/.test(extractFn(popup, "exportCSV")));
check("background's auto-pull uses the builder", /buildScoutCsv\(game, \{/.test(extractFn(bg, "autoPullExport")));

out("\n--- wiring ---");
check("manifest has the downloads permission", (mf.permissions || []).includes("downloads"));
const marker = content.match(/if \(!(\/.*\/)\.test\(location\.hash\)\) return;/);
const re = marker ? eval(marker[1]) : null;
check("content.js reads the #ts-auto marker", !!re);
if (re) {
  check("marker: #ts-auto", re.test("#ts-auto"));
  check("marker: alongside a site's own hash", re.test("#seats&ts-auto"));
  check("marker: not a lookalike", !re.test("#ts-autograph") && !re.test("") && !re.test("#nots-auto"));
}
check("content.js arms before it relays any traffic",
  content.indexOf("AUTO_PULL_ARM") > 0 && content.indexOf("AUTO_PULL_ARM") < content.indexOf('window.addEventListener("message"'));
check("background routes AUTO_PULL_ARM", /message\.type === "AUTO_PULL_ARM"/.test(bg));
check("scan progress reaches the auto-pull", /autoPull\[tabId\]\.scanStatus = message\.status/.test(bg));
// One human click per page: the auto-pull may close the tab it was handed,
// but it must never open one.
const block = bg.slice(bg.indexOf("// ==== auto-pull"), bg.indexOf("// ==== auto-pull — END"));
check("auto-pull never opens a tab", !/chrome\.tabs\.create|chrome\.windows\.create|tabs\.update/.test(block));

out(`\n${fail ? fail + " FAILED" : "all passed"}`);
process.exit(fail ? 1 : 0);
