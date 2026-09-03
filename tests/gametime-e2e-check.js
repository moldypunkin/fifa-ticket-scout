// Run the real saveGametimeSeats against the captured rows, end to end.
//
// Every other Gametime assertion tests a helper in isolation or reads the
// source as text. This one loads background.js into a stubbed service worker,
// feeds it both payloads the way the page delivers them, and inspects what
// lands in storage — the only check that would catch the parser wiring the
// right helpers together wrongly.
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

const EVENT_ID = "68af55be0dcf1d7f796e5e89";
const URL_WITH_Q = "https://mobile.gametime.co/v3/listings/" + EVENT_ID +
  "?all_in_pricing=true&quantity=2&jitter_cheapest=0";

// /v1/events, as the page delivers it: our event alongside a neighbouring
// fixture at the same venue. Taking events[0] would name this event wrongly.
const EVENTS = { events: [
  { event: { id: "68af55bebf6276ee588dd89b", name: "Wrong Game At The Same Venue",
             datetime_local: "2026-09-03T19:05:00" },
    venue: { name: "Globe Life Field", city: "Arlington" } },
  { event: { id: EVENT_ID, name: "Tampa Bay Rays at Texas Rangers",
             datetime_local: "2026-09-05T18:05:00", datetime_utc: "2026-09-05T23:05:00" },
    venue: { name: "Globe Life Field", city: "Arlington" } },
] };

const LISTINGS = { listings: [
  { id: "6941d5d94c87f865d0bcf87d", available_lots: [2],
    price: { prefee: 2300, total: 3000, sales_tax: 229, pre_tax_total: 2771 },
    disclosures: [], delivery_type: "direct", seats: ["15", "16"], event_id: EVENT_ID,
    spot: { row: "5", section: "224", section_group: "Middle" } },
  { id: "6a90a2da96d5b04d64ce5eb6", available_lots: [2],
    price: { prefee: 36000, total: 42300 }, disclosures: [], delivery_type: "mobile",
    seats: ["1", "2"], event_id: EVENT_ID,
    spot: { row: "A", section: "28", section_group: "Lower" } },
  // No seat numbers: quantity must fall back to the lot size.
  { id: "cccc0000cccc0000cccc0000", available_lots: [3],
    price: { total: 5000 }, seats: [], event_id: EVENT_ID,
    spot: { row: "12", section: "301", section_group: "Upper" } },
  { id: "dddd0000dddd0000dddd0000", available_lots: [1],
    price: { total: 1500 }, seats: ["7"], event_id: EVENT_ID,
    spot: { section: "Lot 5", section_group: "Parking" } },
  // "Seats 999-1000" in Block 312 Row 4, off the live dashboard. Blocks do not
  // hold a thousand seats, so these are reported rather than presented as real.
  { id: "eeee0000eeee0000eeee0000", available_lots: [2],
    price: { total: 1200 }, seats: ["999", "1000"], event_id: EVENT_ID,
    spot: { row: "4", section: "312", section_group: "Upper" } },
] };

ctx.gametimeIndexEvents(EVENTS);
ctx.saveGametimeSeats(EVENT_ID, LISTINGS, 1, "gametime", null, URL_WITH_Q).then(() => {
  const game = stored["gametime:" + EVENT_ID];
  const seats = Object.values(game.seats);
  let fail = 0;
  const check = (l, c, d) => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

  check("9 seats from 4 listings (2+2+3+2), parking dropped", seats.length === 9, String(seats.length));
  check("no parking seat survived", !seats.some((s) => /lot 5/i.test(s.block)));

  console.log("");
  console.log("--- event identity came from the right row of /v1/events ---");
  check("name matched by id, not events[0]",
    game.match.name === "Tampa Bay Rays at Texas Rangers", game.match.name);
  check("date normalised for the popup", game.match.date === "05-09-2026 - 18:05", game.match.date);
  check("venue carried", game.match.venue === "Globe Life Field", game.match.venue);

  console.log("");
  console.log("--- seat-level detail ---");
  const s224 = seats.filter((s) => s.block === "224").sort((a, b) => a.seat.localeCompare(b.seat));
  check("section 224 produced 2 seats", s224.length === 2, String(s224.length));
  check("seat numbers land on the seats", s224.map((s) => s.seat).join(",") === "15,16",
    s224.map((s) => s.seat).join(","));
  check("row carried", s224[0].row === "5", s224[0].row);
  check("area from section_group", s224[0].area === "Middle", s224[0].area);
  check("3000 cents stored as 30000 thousandths", s224[0].price === 30000, String(s224[0].price));
  check("delivery kept as an attribute", s224[0].attributes.indexOf("direct") >= 0,
    s224[0].attributes.join("|"));
  check("tier assigned", s224[0].tier != null, String(s224[0].tier));
  check("site tagged", seats.every((s) => s.site === "gametime"));

  console.log("");
  console.log("--- a listing with no seat numbers still yields its lot ---");
  const s301 = seats.filter((s) => s.block === "301");
  check("3 seats from available_lots [3]", s301.length === 3, String(s301.length));
  check("their seat field is blank", s301.every((s) => s.seat === ""));
  check("42300 cents is 423000 thousandths",
    seats.some((s) => s.price === 423000), "no $423 seat found");

  console.log("");
  console.log("--- implausible seat numbers are reported, not presented as real ---");
  const flagged = bgLogs.find((l) => /seat number\(s\) >= 900/.test(l));
  check("high seat numbers are flagged", !!flagged, flagged || "(not logged)");
  check("it names the values", !!flagged && /999, 1000/.test(flagged));
  check("and how far they spread", !!flagged && /block\/row combination\(s\)/.test(flagged),
    "spread is what distinguishes a placeholder from a real seat");
  // Still stored: they may be genuine, and dropping real inventory on a hunch
  // is worse than showing a number that looks odd.
  check("but the seats are still kept",
    seats.some((s) => s.seat === "999"), "a suspicious number must not be discarded");

  check("keys are unique per seat", new Set(Object.keys(game.seats)).size === 9,
    String(new Set(Object.keys(game.seats)).size));

  console.log(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
