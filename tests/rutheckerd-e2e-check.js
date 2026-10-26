// Run the real saveSyosSeats end to end and inspect what lands in storage.
//
// Seat shapes are verbatim from performance 33816 at Ruth Eckerd Hall, with the
// status changed where an available seat is needed — that capture happened to
// catch a screen where every sampled seat was sold.
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

const PERF = "33816";
const INIT_URL = "https://secure.rutheckerdhall.com/api/syos/GetInitData?performanceId=33816&packageId=0&priceTypeIds=";
const SEATS_URL = "https://secure.rutheckerdhall.com/api/syos/GetSeatList?performanceId=33816&packageId=0&facilityId=35&screenId=7&priceTypeIds=";
const SEATS_URL_6 = SEATS_URL.replace("screenId=7", "screenId=6");

const INIT = {
  ScreenZoneList: [{ screen_no: 7, zone_no: 5152, default_price: 0 }],
  Pricing: [
    { is_default: true, is_promo: false, rank: 0, PerSeatFee: 21, zone_no: 5152,
      price_type: 5, price_type_desc: "Full Price", price: 83,
      description: "Price Level 2", available: true },
    { is_default: true, is_promo: false, rank: 0, PerSeatFee: 17, zone_no: 5153,
      price_type: 5, price_type_desc: "Full Price", price: 63,
      description: "Price Level 3", available: true },
  ],
  ProductionSeasonId: 33733, PerformanceId: 33816, FacilityId: 35,
  AvailablePrices: [{ Price: 104, ZoneNo: 5152 }, { Price: 80, ZoneNo: 5153 }],
  MaxSeats: 8, IsSeatMapAvailable: true,
  Screens: [
    { ScreenId: 1, ScreenMapId: 35, ScreenDescription: "Front Orchestra",
      MinPrice: null, MaxPrice: null, PriceType: "Full Price", IsSYOS: true,
      IsAvailable: false },
    { ScreenId: 6, ScreenMapId: 35, ScreenDescription: "Upper Orchestra East",
      MinPrice: "80.00", MaxPrice: "104.00", PriceType: "Full Price", IsSYOS: true,
      IsAvailable: true },
    { ScreenId: 7, ScreenMapId: 35, ScreenDescription: "Upper Orchestra West",
      MinPrice: "80.00", MaxPrice: "104.00", PriceType: "Full Price", IsSYOS: true,
      IsAvailable: true },
  ],
};

const seat = (no, num, row, section, zone, statusDesc, status) => ({
  CustomFill: "#172550", GraphicType: "CIRCLE", ZoneLabel: "Upper Orch West",
  IconCharacter: "2", display_letter: " ", seat_desc: "", seat_no: no,
  seat_num: num, seat_row: row, seat_status: status, seat_status_desc: statusDesc,
  seat_type: 1, section, xpos: 36, ypos: 12, zone_no: zone,
});

const SEATS_SCREEN_7 = {
  holdCodes: [{ hc_no: 1, hc_desc: "Production Hold", blackout_ind: "N" }],
  seats: [
    seat(94515, "34", "T", 11, 5151, "Unavailable", -1),
    seat(94151, "76", "Y", 16, 5152, "Unavailable", 13),
    seat(93191, "81", "LL", 24, 5153, "Unavailable", 13),
    seat(94001, "12", "U", 16, 5152, "Available", 0),
    seat(94002, "13", "U", 16, 5152, "Available", 0),
    seat(93500, "5", "LL", 24, 5153, "Available", 0),
    // A zone nothing priced: dropped rather than shown at a guessed price.
    seat(93900, "9", "Z", 16, 9999, "Available", 0),
  ],
  nonSeats: [],
  sections: [
    { section: 16, section_desc: "Upper Orchestra West" },
    { section: 24, section_desc: "Upper Orchestra West Rear" },
    { section: 11, section_desc: "Upper Orchestra West Front" },
  ],
  ScreenZoneList: [{ screen_no: 7, zone_no: 5152, default_price: 83 }],
  ZoneColorList: [
    { zone_no: 5153, zone_color: "#001DB0", zone_label: "Price Level 3", price: 80 },
    { zone_no: 5152, zone_color: "#172550", zone_label: "Price Level 2", price: 104 },
  ],
  AvailablePrices: [{ Price: 104, ZoneNo: 5152 }],
};

const SEATS_SCREEN_6 = {
  seats: [seat(80001, "1", "A", 16, 5152, "Available", 0)],
  sections: [{ section: 16, section_desc: "Upper Orchestra East" }],
  ZoneColorList: [{ zone_no: 5152, zone_label: "Price Level 2", price: 104 }],
};

const INFO = { name: "An Evening With Someone", date: "26-10-2026 - 19:30",
               venue: "Ruth Eckerd Hall" };

(async () => {
  ctx.syosIndexInit(PERF, INIT);
  await ctx.saveSyosSeats(PERF, SEATS_SCREEN_7, 1, "rutheckerd", INFO, SEATS_URL);

  const game = stored["rutheckerd:" + PERF] || {};
  const seats = Object.values(game.seats || {});

  out("--- only the seats actually on sale ---");
  // Seven in the payload: three sold, one in an unpriced zone, three sellable.
  check("3 seats stored", seats.length === 3, String(seats.length));
  check("nothing with status -1", !seats.some((s) => s.seat === "34"));
  check("nothing with status 13", !seats.some((s) => s.seat === "76"));
  check("and nothing from an unpriced zone", !seats.some((s) => s.seat === "9"));

  out("");
  out("--- the all-in zone price ---");
  const z2 = seats.filter((s) => s.price === 104000);
  const z3 = seats.filter((s) => s.price === 80000);
  check("price level 2 seats are $104.00", z2.length === 2, String(z2.length));
  check("price level 3 seats are $80.00", z3.length === 1, String(z3.length));
  // 83 + 21 = 104. Storing the base would understate every seat by its fee.
  check("the per-seat fee is included, not dropped",
    !seats.some((s) => s.price === 83000 || s.price === 63000));

  out("");
  out("--- the section is named, not numbered ---");
  // "16" would tier as Other and read as a section number that is not one.
  check("section 16 is Upper Orchestra West",
    seats.some((s) => s.block === "Upper Orchestra West"),
    seats.map((s) => s.block).join(","));
  check("section 24 is its own name",
    seats.some((s) => s.block === "Upper Orchestra West Rear"));
  check("rows come through", seats.every((s) => s.row), seats.map((s) => s.row).join(","));
  check("seat numbers come through", seats.map((s) => s.seat).sort().join(",") === "12,13,5");
  check("site tagged", seats.every((s) => s.site === "rutheckerd"));

  out("");
  out("--- identity ---");
  check("name", game.match.name === "An Evening With Someone", game.match.name);
  check("venue", game.match.venue === "Ruth Eckerd Hall", game.match.venue);
  check("keyed by performance", game.match.performanceId === PERF);

  out("");
  out("--- a capture of one screen is partial, and says so ---");
  const partial = logs.find((l) => /not captured yet/.test(l)) || "";
  check("the unopened screen is named", /6 Upper Orchestra East/.test(partial), partial);
  // Screen 1 is IsAvailable false: not on sale, so not something to chase.
  check("a screen that is not on sale is not chased", !/Front Orchestra/.test(partial));
  check("the status values are reported",
    logs.some((l) => /seat_status_desc values seen/.test(l)));

  out("");
  out("--- a second screen adds to the same event ---");
  await ctx.saveSyosSeats(PERF, SEATS_SCREEN_6, 1, "rutheckerd", INFO, SEATS_URL_6);
  const after = Object.values(stored["rutheckerd:" + PERF].seats || {});
  check("seats accumulate rather than replace", after.length === 4, String(after.length));
  check("the new screen's seat is there", after.some((s) => s.seat === "1" && s.row === "A"));
  // seat_no is unique across the venue, so re-opening a screen must not double.
  await ctx.saveSyosSeats(PERF, SEATS_SCREEN_6, 1, "rutheckerd", INFO, SEATS_URL_6);
  const again = Object.values(stored["rutheckerd:" + PERF].seats || {});
  check("re-opening a screen does not double it", again.length === 4, String(again.length));
  check("and now every screen is accounted for",
    logs.some((l) => /all 2 screen\(s\) captured/.test(l)),
    logs.filter((l) => /screen\(s\)/.test(l)).pop());

  out("");
  out("--- a screen opened before the prices arrive ---");
  // GetInitData may not have landed yet; the seat payload prices its own zones.
  stored = null;
  const fresh = Object.assign({}, SEATS_SCREEN_7);
  await ctx.saveSyosSeats("99999", fresh, 2, "rutheckerd", INFO,
    SEATS_URL.replace("33816", "99999"));
  const solo = Object.values((stored["rutheckerd:99999"] || {}).seats || {});
  check("still priced from its own payload", solo.length === 3, String(solo.length));

  out(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
