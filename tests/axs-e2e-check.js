// Run the real saveAxsSeats against the captured rows, end to end.
//
// Every other AXS assertion tests a helper in isolation or reads the source as
// text. This one loads background.js into a stubbed service worker, feeds it
// all four payloads the way the page delivers them, and inspects what lands in
// storage — the only check that would catch the parser wiring the right
// helpers together wrongly, or one payload clobbering another's fields.
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

const TOKEN = "qyNwCQAAAACR8mTJAAAAACb";
const OFFERS_URL = "https://unifiedapicommerce-us.axs.com/axsmarketplace/offers" +
  "?onsaleID=qyNwCQAAAACR8mTJAAAAACb%2Fv%2F2F%2F%2FwD&flow=best_available";

// /axsmarketplace/mapinfo — group names for the Area column.
const MAPINFO = { groups: [
  { id: 424039, name: "Upper Level - Endzone", hasTickets: true },
  { id: 424045, name: "Lower Level - Corner", hasTickets: true },
  { id: 424043, name: "Club Level - Sideline", hasTickets: true },
] };

// /veritix/start-flow — the session payload. It carries the name and venue but
// no date, so it is the fallback behind eventinfo. It is NOT the inventory,
// though it was captured as if it were for a long time.
const STARTFLOW = { onsaleInformation: {
  venues: [{ venueID: 1, name: "Arrowhead Stadium", city: "Kansas City", state: "MO" }],
  groups: [{ offerGroupID: "13198585", products: [
    { id: "13198561", description: "Denver Broncos at Kansas City Chiefs (Monday Night Football)",
      eventID: 747922 }] }],
} };

const OFFERS = { meta: {}, listings: [
  { id: "VB17047084306", row: "40", quantity: 10, splits: [1,2,3,4,5,6,7,8,10],
    price: 188, allInPrice: 225.34, stockType: "Ticketmaster Transfer", groupId: 424039,
    isZoneSeating: false, priceBreakdown: { price: 188, serviceFee: 33.84, total: 225.34 },
    section: { id: 330, name: "Upper Level 330" }, tags: null, premiumPerks: [], seatFeatures: [] },
  { id: "VB17049776147", row: "11", quantity: 3, splits: [1,2,3],
    price: 502, allInPrice: 595.86, stockType: "Ticketmaster Transfer", groupId: 424045,
    isZoneSeating: false, priceBreakdown: { price: 502, serviceFee: 90.36, total: 595.86 },
    section: { id: 125, name: "Lower Level 125" }, tags: null, premiumPerks: [],
    seatFeatures: ["Restricted/Obstructed View"] },
  // A section whose group is NOT in mapinfo: Area must fall back to the prefix.
  { id: "VB17021485157", row: "7", quantity: 2, splits: [2],
    price: 4360, allInPrice: 5148.3, stockType: "Ticketmaster Transfer", groupId: 999999,
    isZoneSeating: false, section: { id: 227, name: "Club Level 227" },
    tags: null, premiumPerks: [], seatFeatures: [] },
  { id: "PARKING1", row: "", quantity: 4, price: 40, allInPrice: 45,
    section: { id: 900, name: "Parking Lot C" }, groupId: 424039, seatFeatures: [] },
] };

// /axsmarketplace/eventinfo — the only payload with a date. Fed BEFORE
// start-flow so the ordering that would clobber it is the one under test:
// start-flow carries a name and venue but no date, and must not blank it.
const EVENTINFO = {
  id: 6491101,
  name: "Denver Broncos at Kansas City Chiefs (Monday Night Football)",
  utcDate: "2026-09-15T00:15:00", localDate: "2026-09-14T19:15:00",
  venueName: "Arrowhead Stadium",
};

ctx.axsIndexMap(TOKEN, MAPINFO);
ctx.axsIndexEventInfo(TOKEN, EVENTINFO);
ctx.axsIndexEvent(TOKEN, STARTFLOW);
ctx.saveAxsSeats(TOKEN, OFFERS, 1, "axs", null).then(() => {
  const game = stored["axs:" + TOKEN];
  const seats = Object.values(game.seats);
  let fail = 0;
  const check = (l, c, d) => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

  check("15 seats from 3 listings (10+3+2), parking dropped", seats.length === 15, String(seats.length));
  check("no parking seat survived", !seats.some((s) => /parking/i.test(s.block)));

  console.log("");
  console.log("--- identity comes from the payloads, not the ticket page ---");
  // tix.axs.com's own JSON-LD reads as "FanSight", so the page itself is no
  // help; eventinfo is the source, with start-flow behind it.
  check("event name", game.match.name === "Denver Broncos at Kansas City Chiefs (Monday Night Football)",
    game.match.name);
  check("venue", game.match.venue === "Arrowhead Stadium", game.match.venue);
  // The venue clock, not UTC: those fall on different calendar days here.
  check("date from eventinfo localDate", game.match.date === "14-09-2026 - 19:15",
    game.match.date);
  check("start-flow did not blank the date", game.match.date !== null,
    "a later payload with no date must not clear one already known");
  check("stored under the onsale token", !!game, "axs:" + TOKEN);

  console.log("");
  console.log("--- seat detail ---");
  // Block is the section number alone now — "330", not "Upper Level 330". The
  // level is not lost, it is what the Area column carries.
  const upper = seats.filter((s) => s.block === "330");
  check("a 10-seat listing became 10 seats", upper.length === 10, String(upper.length));
  check("225.34 stored as 225340 thousandths", upper[0].price === 225340, String(upper[0].price));
  check("row carried", upper[0].row === "40", upper[0].row);
  check("seat left blank", upper[0].seat === "", JSON.stringify(upper[0].seat));
  check("area from the mapinfo group", upper[0].area === "Upper Level - Endzone", upper[0].area);
  check("the level survives in Area, not the block",
    upper[0].block === "330" && /Upper Level/.test(upper[0].area),
    upper[0].block + " / " + upper[0].area);
  check("stock type kept", upper[0].attributes.indexOf("Ticketmaster Transfer") >= 0,
    upper[0].attributes.join("|"));
  check("tier assigned", upper[0].tier != null, String(upper[0].tier));
  check("site tagged", seats.every((s) => s.site === "axs"));

  const lower = seats.filter((s) => s.block === "125");
  check("obstructed view kept", lower[0].attributes.indexOf("Restricted/Obstructed View") >= 0,
    lower[0].attributes.join("|"));

  console.log("");
  console.log("--- an unmapped group falls back to the section prefix ---");
  const club = seats.filter((s) => s.block === "227");
  check("2 seats", club.length === 2, String(club.length));
  check("area is the prefix", club[0].area === "Club Level", club[0].area);
  check("5148.30 stored as 5148300", club[0].price === 5148300, String(club[0].price));

  check("keys are unique per seat", new Set(Object.keys(game.seats)).size === 15,
    String(new Set(Object.keys(game.seats)).size));

  console.log(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
