// Ticketmaster resale listings that publish no seat places.
//
// On a Nebraska event (Z7r9jZ1A7Oaq7, Memorial Stadium) 867 of 1,429 listings
// came back like this — a section, a count, and an empty places array:
//
//   {"available":true,"inventoryTypes":["resale"],"offerTypes":["thirdparty"],
//    "offers":["HB6..."],"seating":"reserved","section":"3","count":2,"places":[]}
//
// The parser only ever built seats from `places`, so all 867 vanished without a
// word, taking sections 204, 206, 207, 223, 402-411 and others with them. The
// dashboard showed 1,739 seats and looked complete; section 206 was on the map
// with a $1,005.70 listing and nowhere in the popup.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

let stored = null;
const logs = [];
const ctx = {
  console: { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {} },
  setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String, Number,
  Boolean, Error, TypeError, isFinite, isNaN, parseInt, parseFloat, Set, Map, WeakMap,
  encodeURIComponent, decodeURIComponent, Uint8Array, ArrayBuffer,
  TextEncoder: function () { this.encode = () => new Uint8Array(0); },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  crypto: { subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) }, getRandomValues: (a) => a },
  location: { href: "chrome-extension://test/background.js" },
};
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
ctx.chrome = {
  runtime: { id: "t", lastError: null, onMessage: listener, onInstalled: listener,
             onStartup: listener, sendMessage: noop, getURL: (p) => p,
             getManifest: () => ({ version: "0" }) },
  storage: {
    local: {
      get: (k, cb) => {
        const v = { license: { level: 3 } };
        if (stored) v.games = stored;
        if (typeof k === "function") k(v); else if (cb) cb(v);
        return Promise.resolve(v);
      },
      set: (v) => { if (v.games) stored = v.games; return Promise.resolve(); },
      remove: () => Promise.resolve(),
    },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: noop },
    onChanged: listener,
  },
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: noop, create: noop, onUpdated: listener, onRemoved: listener },
  alarms: { create: noop, clear: noop, onAlarm: listener },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
};
ctx.self = ctx; ctx.globalThis = ctx;
ctx.importScripts = (...files) => {
  for (const f of files) vm.runInContext(down(fs.readFileSync(EXT + f, "utf8")), ctx, { filename: f });
};
vm.createContext(ctx);
vm.runInContext(down(fs.readFileSync(EXT + "background.js", "utf8")), ctx, { filename: "background.js" });

// Verbatim from the live response, bar the offer ids being shortened.
const unplaced = (section, count, offerId) => ({
  available: true, inventoryTypes: ["resale"], offerTypes: ["thirdparty"],
  offers: [offerId], seating: "reserved", section, count, places: [],
});

const BODY = {
  facets: [
    // A listing with real places, to prove the normal path is untouched.
    // Base32 of "32:10:1" and "32:10:2", the encoding decodePlaceId expects.
    { available: true, inventoryTypes: ["standard"], offers: ["o-placed"],
      section: "32", places: ["GMZDUMJQHIYQ", "GMZDUMJQHIZA"] },
    unplaced("206", 2, "o-206"),
    // A GA section: no seat places, and the whole allocation in `count`. This
    // is what used to come back as exactly 200.
    unplaced("GA FLOOR", 1500, "o-ga"),
    // Two listings in the SAME section: the second must not overwrite the first.
    unplaced("3", 2, "o-3a"),
    unplaced("3", 4, "o-3b"),
    // No section at all — nothing to file it under, so it stays dropped.
    unplaced("", 2, "o-nosec"),
  ],
  // `prices: {}` is for the harness, not the browser: down-levelling `?.` for
  // node 12 turns `o?.prices?.total` into `o.prices.total`, which throws on an
  // offer that has no prices object. Chrome runs the optional chain as written.
  _embedded: {
    offer: [
      { offerId: "o-placed", totalPrice: 97.79, currency: "USD", prices: {} },
      { offerId: "o-206", totalPrice: 1005.70, currency: "USD", prices: {} },
      { offerId: "o-ga", totalPrice: 89.50, currency: "USD", prices: {} },
      { offerId: "o-3a", totalPrice: 265.93, currency: "USD", prices: {} },
      { offerId: "o-3b", totalPrice: 150, currency: "USD", prices: {} },
      { offerId: "o-nosec", totalPrice: 100, currency: "USD", prices: {} },
    ],
  },
};

const EVENT = "Z7r9jZ1A7Oaq7";
const INFO = { name: "Washington at Nebraska", date: "31-10-2026",
               venue: "Nebraska Memorial Stadium" };

ctx.saveTicketmasterSeats(EVENT, BODY, 1, "ticketmaster", INFO).then(() => {
  const game = stored["ticketmaster:" + EVENT] || {};
  const records = Object.values(game.seats || {});
  const inSection = (sec) => records.filter((s) => s.block === sec);
  // What the popup and the CSV both read: one row per ticket.
  const rows = ctx.expandSeatCounts(records);
  const rowsIn = (sec) => rows.filter((s) => s.block === sec);

  out("--- the listing that was on the map and not in the popup ---");
  // One record now, carrying its count, instead of two copies of itself.
  check("section 206 is stored once", inSection("206").length === 1,
    String(inSection("206").length));
  check("as a count of 2", inSection("206")[0].count === 2,
    String(inSection("206")[0].count));
  check("and expands back to 2 rows", rowsIn("206").length === 2,
    String(rowsIn("206").length));
  check("priced at $1,005.70", rowsIn("206").every((s) => s.price === 1005700),
    rowsIn("206").map((s) => s.price).join(","));
  // Ticketmaster publishes no row or seat for these, and inventing one would be
  // worse than leaving it blank: the popup already groups unnumbered seats.
  check("no row or seat is invented",
    rowsIn("206").every((s) => s.row === "" && s.seat === ""));
  check("tagged as resale, not standard",
    rowsIn("206").every((s) => s.category === "resale"), rowsIn("206")[0].category);
  check("tiered from the venue map", rowsIn("206").every((s) => !!s.tier));

  out("");
  out("--- a GA section is kept whole ---");
  // The bug this fixes. `count` was clamped to 200, so two unrelated events
  // both reported exactly 200 available and the real figure was nowhere —
  // not in the dashboard and not in the logs either.
  check("the whole allocation is stored", inSection("GA FLOOR")[0].count === 1500,
    String(inSection("GA FLOOR")[0].count));
  check("not truncated to 200", inSection("GA FLOOR")[0].count !== 200);
  check("and it expands to 1,500 rows", rowsIn("GA FLOOR").length === 1500,
    String(rowsIn("GA FLOOR").length));
  // One record for 1,500 tickets is the whole reason the ceiling could go:
  // chrome.storage.local has ~10MB and no unlimitedStorage permission.
  check("1,500 tickets cost one stored record", inSection("GA FLOOR").length === 1,
    String(inSection("GA FLOOR").length));
  check("the rows carry no count of their own",
    rowsIn("GA FLOOR").every((s) => s.count === undefined));

  out("");
  out("--- two listings in one section ---");
  // Keyed on the section alone, the four-seat listing would replace the
  // two-seat one and the section would read 4 seats at one price.
  check("both listings survive", inSection("3").length === 2, String(inSection("3").length));
  check("6 tickets between them", rowsIn("3").length === 6, String(rowsIn("3").length));
  const prices = rowsIn("3").map((s) => s.price).sort((a, b) => a - b);
  check("each keeps its own price",
    prices.filter((p) => p === 150000).length === 4 &&
    prices.filter((p) => p === 265930).length === 2, prices.join(","));

  out("");
  out("--- the normal path is untouched ---");
  check("placed seats still carry their row and seat",
    inSection("32").length === 2 && inSection("32").every((s) => s.row && s.seat),
    inSection("32").map((s) => s.row + "/" + s.seat).join(","));
  check("and their price", inSection("32").every((s) => s.price === 97790));
  // A seat with a real place is one ticket and must not sprout a count.
  check("and no count", inSection("32").every((s) => s.count === undefined));

  out("");
  out("--- what still cannot be kept ---");
  check("a listing with no section is dropped", records.every((s) => s.block !== ""));
  check("and reported", logs.some((l) => /had no section either and are still dropped/.test(l)),
    logs.find((l) => /still dropped/.test(l)));

  out("");
  out("--- the log says what happened ---");
  const line = logs.find((l) => /published no seat places/.test(l)) || "";
  check("the count of recovered seats", /1508 seat\(s\) across 3 section\(s\)/.test(line), line);
  check("the placed listing is not counted among them", !/4 section/.test(line), line);
  check("totals include them", rows.length === 1510, String(rows.length));

  out("");
  out("--- the counts are printed, largest first ---");
  // Without this line there is no way to tell a GA section holding 200 from
  // one holding 1,500: the dashboard shows rows, not the figure behind them.
  const counts = logs.find((l) => /unplaced counts/.test(l)) || "";
  check("the raw counts are logged", /GA FLOOR\u00d71500/.test(counts)
    || /GA FLOOR×1500/.test(counts), counts);
  check("largest first", counts.indexOf("GA FLOOR") < counts.indexOf("206"), counts);
  const bulk = logs.find((l) => /hold 200\+ tickets each/.test(l)) || "";
  check("a bulk listing is called out on its own", /GA FLOOR/.test(bulk), bulk);
  check("and says the ceiling is gone", /truncate/.test(bulk), bulk);

  out("");
  out("--- an upgrade does not double-count ---");
  // Before this change the same inventory was stored one record per ticket,
  // keyed unplaced:<block>:<offer>:<index>. Those keys are never written now,
  // and mergeSeats keeps what it does not overwrite, so they would sit beside
  // the counted record and be counted all over again.
  const g = stored["ticketmaster:" + EVENT];
  g.seats["unplaced:206:o-206:0"] = Object.assign({}, inSection("206")[0], { count: undefined });
  g.seats["unplaced:206:o-206:1"] = Object.assign({}, inSection("206")[0], { count: undefined });
  return ctx.saveTicketmasterSeats(EVENT, BODY, 1, "ticketmaster", INFO).then(() => {
    const after = Object.values(stored["ticketmaster:" + EVENT].seats || {});
    check("the old one-per-ticket records are dropped",
      Object.keys(stored["ticketmaster:" + EVENT].seats).every((k) => !/^unplaced:.*:\d+$/.test(k)),
      Object.keys(stored["ticketmaster:" + EVENT].seats).filter((k) => /^unplaced:.*:\d+$/.test(k)).join(","));
    check("and section 206 still reads 2", ctx.expandSeatCounts(after)
      .filter((s) => s.block === "206").length === 2);
    check("the shed records are reported",
      logs.some((l) => /stored\s+one per ticket/.test(l) || /one per ticket/.test(l)),
      logs.find((l) => /one per ticket/.test(l)));

    out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
    process.exit(fail ? 1 : 0);
  });
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
