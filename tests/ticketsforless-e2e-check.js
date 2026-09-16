// Run the real saveTicketsForLessSeats end to end and inspect what lands in
// storage.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let stored = null;
const bgLogs = [];
const ctx = {
  console: { log: (...a) => bgLogs.push(a.join(" ")), warn: () => {}, error: () => {} },
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
  runtime: { id: "t", lastError: null, onMessage: listener, onInstalled: listener, onStartup: listener,
             sendMessage: noop, getURL: (p) => p, getManifest: () => ({ version: "0" }) },
  storage: {
    local: {
      get: (k, cb) => { const v = stored ? { games: stored } : {}; if (typeof k === "function") k(v); else if (cb) cb(v); return Promise.resolve(v); },
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

const EVENT_ID = "7730195";
const BODY = {
  siteConfig: { venueLevelColors: [] },
  event: { name: "Kansas City Chiefs vs Indianapolis Colts", dateLocal: "2026-09-20T19:20:00",
           venue: { name: "Arrowhead Stadium" }, performers: [] },
  cartItems: [],
  tickets: [
    { id: "4301087", sec: "334", row: "14", qty: 1, splits: 1, notes: "Uppers XFER", price: 98,
      faceValue: 87, serviceFee: 0, delivery: ["M"], features: null, mapSection: "334", seats: "21" },
    { id: "4304064", sec: "115", row: "26", qty: 5, splits: 23, notes: "Goal to 10 Yard Line Lowers XFER",
      price: 244, faceValue: 217, serviceFee: 0, delivery: ["M"], features: null, mapSection: "115",
      seats: "15-19" },
    { id: "4488928", sec: "Penthouse", row: "1", qty: 2, splits: 2, notes: "Penthouse Suite", price: 1451,
      faceValue: 1295, serviceFee: 0, delivery: ["M"], features: null, mapSection: "PENTHOUSE",
      seats: "29-30" },
    // A range that disagrees with the quantity: 4 seats listed, a 2-seat range.
    { id: "9000001", sec: "230", row: "3", qty: 4, splits: 4, notes: "", price: 150, serviceFee: 0,
      delivery: ["M"], features: null, mapSection: "230", seats: "7-8" },
    { id: "9000002", sec: "Parking Lot C", row: "", qty: 2, price: 40, mapSection: "LOT C", seats: "" },
  ],
};

ctx.saveTicketsForLessSeats(EVENT_ID, BODY, 1, "ticketsforless", null).then(() => {
  const game = stored["ticketsforless:" + EVENT_ID];
  const seats = Object.values(game.seats);
  let fail = 0;
  const check = (l, c, d) => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

  check("12 seats (1+5+2+4), parking dropped", seats.length === 12, String(seats.length));
  check("keys unique per seat", new Set(Object.keys(game.seats)).size === 12);
  check("no parking seat", !seats.some((s) => /parking/i.test(s.block)));

  console.log("");
  console.log("--- identity ---");
  check("name", game.match.name === "Kansas City Chiefs vs Indianapolis Colts", game.match.name);
  check("date", game.match.date === "20-09-2026 - 19:20", game.match.date);
  check("venue", game.match.venue === "Arrowhead Stadium", game.match.venue);

  console.log("");
  console.log("--- seat numbers land on the seats ---");
  const s115 = seats.filter((s) => s.block === "115").map((s) => s.seat).sort((a, b) => a - b);
  check("section 115 row 26 is seats 15-19", s115.join(",") === "15,16,17,18,19", s115.join(","));
  const s334 = seats.find((s) => s.block === "334");
  check("section 334 is seat 21", s334.seat === "21", s334.seat);
  check("98 stored as 98000 thousandths", s334.price === 98000, String(s334.price));
  check("row carried", s334.row === "14");
  check("seller notes kept", s334.attributes.indexOf("Uppers XFER") >= 0);
  const mismatch = seats.filter((s) => s.block === "230");
  check("a mismatched range yields 4 seats", mismatch.length === 4, String(mismatch.length));
  check("and none of them gets an invented number", mismatch.every((s) => s.seat === ""),
    mismatch.map((s) => s.seat).join(","));
  check("site tagged", seats.every((s) => s.site === "ticketsforless"));
  // Arrowhead is a curated venue, keyed by the bare number sec already is.
  check("curated tier resolves for section 334", !/^(Upper|Lower|Club \/ Mezz|Other)\b/.test(s334.tier),
    s334.tier);

  console.log("");
  console.log("--- the logs say what happened ---");
  const summary = bgLogs.find((l) => /TicketsForLess: \d+ seats from/.test(l)) || "";
  check("summary line", /12 seats from 5 listings, 3 with seat numbers/.test(summary), summary);
  check("the mismatch is reported", /1 whose seat range did not match the quantity/.test(summary));
  check("parking reported", /1 parking excluded/.test(summary));
  check("event and siteConfig keys logged once",
    bgLogs.filter((l) => /event keys = .*siteConfig keys = /.test(l)).length === 1);

  console.log(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
