// One stored seat record standing for many tickets.
//
// Ticketmaster publishes a GA section as a section and a count with no seats
// named, so storing one record per ticket wrote N identical copies — and the
// count was clamped to 200 to stop that getting out of hand, which is why two
// unrelated events both reported exactly "200 available". The record now
// carries its count and the readers expand it, so the clamp could go.
//
// What matters here is that expansion is faithful (the rows are what the count
// says), that the copies are distinct objects, and that both readers actually
// do it — a reader that forgot would show one ticket where there are 1,500.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const ctx = { console, Object, Array, Number, Math, String, Boolean, isFinite, JSON };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(EXT + "seat-counts.js", "utf8"), ctx, { filename: "seat-counts.js" });
const expand = ctx.expandSeatCounts;
const countOf = ctx.seatCountOf;

const seat = (over) => Object.assign({ block: "GA", row: "", seat: "", price: 89500 }, over);

out("--- how many tickets a record stands for ---");
check("no count is one ticket", countOf(seat()) === 1);
check("a count of 1 is one ticket", countOf(seat({ count: 1 })) === 1);
check("a count of 1500 is 1500", countOf(seat({ count: 1500 })) === 1500);
// A payload that says something impossible should not erase the listing or
// multiply it: one ticket is the safe reading, and it is what every source
// other than this branch stores anyway.
check("zero is one ticket", countOf(seat({ count: 0 })) === 1);
check("negative is one ticket", countOf(seat({ count: -4 })) === 1);
check("nonsense is one ticket", countOf(seat({ count: "many" })) === 1);
check("null is one ticket", countOf(seat({ count: null })) === 1);
check("a fraction floors", countOf(seat({ count: 2.7 })) === 2);

out("");
out("--- expanding ---");
const one = seat();
const rows = expand([one]);
check("a plain record yields one row", rows.length === 1, String(rows.length));
// Nothing to copy, so it is the stored object itself — the same as before any
// of this existed.
check("and is passed through untouched", rows[0] === one);

const many = expand([seat({ count: 3 })]);
check("a count of 3 yields 3 rows", many.length === 3, String(many.length));
// buildAllClusters() tracks the seats it has consumed in a Set keyed on
// identity. Three references to one object would collapse to a single cluster
// member and the row would read "single seat" for a listing of three.
check("the rows are distinct objects",
  many[0] !== many[1] && many[1] !== many[2] && many[0] !== many[2]);
check("each carries the listing's price", many.every((s) => s.price === 89500));
check("and its block", many.every((s) => s.block === "GA"));
// From here on the rows ARE the count. Leaving `count` on them invites a
// second multiplication by whatever reads them next.
check("count is stripped from the rows", many.every((s) => s.count === undefined));

const mixed = expand([seat({ count: 2 }), seat({ block: "101", row: "4", seat: "7" }), seat({ count: 3 })]);
check("a mixed list totals correctly", mixed.length === 6, String(mixed.length));
check("the placed seat keeps its row and seat",
  mixed.filter((s) => s.block === "101").length === 1
  && mixed.find((s) => s.block === "101").seat === "7");

out("");
out("--- empty and absent input ---");
check("no seats yields no rows", expand([]).length === 0);
check("undefined yields no rows", expand(undefined).length === 0);
check("null yields no rows", expand(null).length === 0);

out("");
out("--- the bound on one record ---");
// A ceiling has to exist or a malformed count hangs the popup. The difference
// from the 200 clamp is that this one is far above any real allocation AND
// says when it bites, instead of passing a truncated figure off as the whole.
const MAX = ctx.SEAT_COUNT_MAX_EXPAND;
check("the bound is far above any real GA section", MAX >= 50000, String(MAX));
const huge = expand([seat({ count: MAX + 500 })]);
check("expansion stops at the bound", huge.length === MAX, String(huge.length));
check("and reports what it could not draw", huge.truncated.length === 1
  && huge.truncated[0].want === MAX + 500 && huge.truncated[0].used === MAX,
  JSON.stringify(huge.truncated));
check("an ordinary list reports nothing truncated", expand([seat({ count: 9 })]).truncated.length === 0);

out("");
out("--- both readers expand ---");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const html = fs.readFileSync(EXT + "popup.html", "utf8");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const csv = fs.readFileSync(EXT + "csv-export.js", "utf8");

const dash = extractFn(popup, "renderDashboard");
check("the dashboard expands the stored records", /expandSeatCounts\(/.test(dash), dash.slice(0, 80));
// Expanded first, filtered second. The other way round, a GA section would be
// filtered as one seat and then expanded to its full count anyway, so the
// header would disagree with the rows under it.
check("before the section filter is applied",
  dash.indexOf("expandSeatCounts") < dash.indexOf("applySectionFilter"));
// The Best Value tab reads storage itself rather than taking the dashboard's
// list, so it needs its own expansion — a GA section left as one record would
// score as a single seat against its peers.
check("the deals tab expands too", /expandSeatCounts\(/.test(extractFn(popup, "renderDealsTab")));
check("the CSV takes an expander", /o\.expand/.test(csv));
check("and defaults to leaving records alone", /function \(x\) \{ return x; \}/.test(csv));

out("");
out("--- it is loaded wherever it is used ---");
// The popup gets it from a script tag and the worker from importScripts. Miss
// either and expandSeatCounts is undefined at the moment the dashboard draws.
check("popup.html loads it", /<script src="seat-counts\.js">/.test(html));
check("before popup.js", html.indexOf("seat-counts.js") < html.indexOf("popup.js"));
check("the worker imports it", /importScripts\([^)]*"seat-counts\.js"/.test(bg));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
