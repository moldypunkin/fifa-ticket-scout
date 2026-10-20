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
  const seats = Object.values(game.seats || {});
  const inSection = (sec) => seats.filter((s) => s.block === sec);

  out("--- the listing that was on the map and not in the popup ---");
  check("section 206 is stored", inSection("206").length === 2,
    String(inSection("206").length));
  check("priced at $1,005.70", inSection("206").every((s) => s.price === 1005700),
    inSection("206").map((s) => s.price).join(","));
  // Ticketmaster publishes no row or seat for these, and inventing one would be
  // worse than leaving it blank: the popup already groups unnumbered seats.
  check("no row or seat is invented",
    inSection("206").every((s) => s.row === "" && s.seat === ""));
  check("tagged as resale, not standard",
    inSection("206").every((s) => s.category === "resale"), inSection("206")[0].category);
  check("tiered from the venue map", inSection("206").every((s) => !!s.tier));

  out("");
  out("--- two listings in one section ---");
  // Keyed on the section alone, the four-seat listing would replace the
  // two-seat one and the section would read 4 seats at one price.
  check("both listings survive", inSection("3").length === 6, String(inSection("3").length));
  const prices = inSection("3").map((s) => s.price).sort((a, b) => a - b);
  check("each keeps its own price",
    prices.filter((p) => p === 150000).length === 4 &&
    prices.filter((p) => p === 265930).length === 2, prices.join(","));

  out("");
  out("--- the normal path is untouched ---");
  check("placed seats still carry their row and seat",
    inSection("32").length === 2 && inSection("32").every((s) => s.row && s.seat),
    inSection("32").map((s) => s.row + "/" + s.seat).join(","));
  check("and their price", inSection("32").every((s) => s.price === 97790));

  out("");
  out("--- what still cannot be kept ---");
  check("a listing with no section is dropped", seats.every((s) => s.block !== ""));
  check("and reported", logs.some((l) => /had no section either and are still dropped/.test(l)),
    logs.find((l) => /still dropped/.test(l)));

  out("");
  out("--- the log says what happened ---");
  const line = logs.find((l) => /published no seat places/.test(l)) || "";
  check("the count of recovered seats", /8 seat\(s\) across 2 section\(s\)/.test(line), line);
  check("the placed listing is not counted among them", !/3 section/.test(line), line);
  check("totals include them", seats.length === 10, String(seats.length));

  out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
