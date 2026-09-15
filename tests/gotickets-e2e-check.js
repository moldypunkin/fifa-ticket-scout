// Run the real saveGoTicketsSeats against the captured payload shape, end to
// end, and inspect what lands in storage.
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

const EVENT_ID = "1984079";
const MOBILE = [{ id: 1, displayName: "Mobile Transfer", price: 6 }];

const BODY = {
  event: { id: 1984079, name: "Trans-Siberian Orchestra", localDate: "2026-12-29T19:30:00",
           venue: { name: "T-Mobile Center" } },
  venueConfiguration: {
    groups: [{ id: 213199, name: "Floor" }, { id: 213200, name: "Lower Level" },
             { id: 213201, name: "Upper Level" }],
    sections: [{ id: 1891431, groupId: 213199, name: "Floor 5" },
               { id: 1891434, groupId: 213200, name: "Lower 101" },
               { id: 1891461, groupId: 213201, name: "Upper 205" }],
  },
  listings: [
    { id: 7255422774, section: "Lower 101", sectionId: 1891434, row: "31", quantity: 2,
      validSplitQuantities: [2], displayPrice: 298, serviceFee: 29, allInPrice: 330,
      deliveryMethods: MOBILE, attributes: [], generalAdmission: false, notes: "" },
    { id: 7180954288, section: "Upper 205", sectionId: 1891461, row: "11", quantity: 6,
      validSplitQuantities: [1, 2, 3, 4, 6], displayPrice: 148, serviceFee: 14, allInPrice: 168,
      deliveryMethods: MOBILE, attributes: [], generalAdmission: false, notes: "" },
    { id: 7200476971, section: "Floor 5", sectionId: 1891431, row: "4", quantity: 4,
      validSplitQuantities: [1, 2, 3, 4], displayPrice: 865, serviceFee: 87, allInPrice: 958,
      deliveryMethods: MOBILE, attributes: [26], generalAdmission: false, notes: "Delivery Delay" },
    // A single seat that cannot be bought as a pair.
    { id: 7000000001, section: "Upper 210", sectionId: 99999, row: "2", quantity: 1,
      validSplitQuantities: [1], displayPrice: 90, serviceFee: 9, allInPrice: 105,
      deliveryMethods: MOBILE, attributes: [], generalAdmission: false, notes: "" },
    { id: 7000000002, section: "Parking Lot A", sectionId: 1, row: "", quantity: 2,
      validSplitQuantities: [2], allInPrice: 40, deliveryMethods: [], attributes: [] },
  ],
};

ctx.goTicketsIndexAttributes([{ id: 26, name: "Obstructed View" }]);
ctx.saveGoTicketsSeats(EVENT_ID, BODY, 1, "gotickets", null).then(() => {
  const game = stored["gotickets:" + EVENT_ID];
  const seats = Object.values(game.seats);
  let fail = 0;
  const check = (l, c, d) => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

  check("13 seats (2+6+4+1), parking dropped", seats.length === 13, String(seats.length));
  check("no parking seat", !seats.some((s) => /parking/i.test(s.block)));
  check("keys unique per seat", new Set(Object.keys(game.seats)).size === 13);

  console.log("");
  console.log("--- identity from the payload's event object ---");
  check("name", game.match.name === "Trans-Siberian Orchestra", game.match.name);
  check("date", game.match.date === "29-12-2026 - 19:30", game.match.date);
  check("venue", game.match.venue === "T-Mobile Center", game.match.venue);

  console.log("");
  console.log("--- seat detail ---");
  const s101 = seats.filter((s) => s.block === "101");
  check("Lower 101 stored as block 101", s101.length === 2, String(s101.length));
  check("330 stored as 330000 thousandths", s101[0].price === 330000, String(s101[0].price));
  check("area from the venue group", s101[0].area === "Lower Level", s101[0].area);
  check("row carried", s101[0].row === "31");
  check("seat blank", s101[0].seat === "");
  check("site tagged", seats.every((s) => s.site === "gotickets"));
  const floor = seats.filter((s) => s.block === "5");
  check("attribute name resolved", floor[0].attributes.indexOf("Obstructed View") >= 0,
    floor[0].attributes.join(" | "));
  const unmapped = seats.filter((s) => s.block === "210");
  check("an unmapped section falls back to its own prefix", unmapped[0].area === "Upper",
    unmapped[0].area);

  console.log("");
  console.log("--- the quantity question is logged ---");
  const lot = bgLogs.find((l) => /lot sizes offered/.test(l)) || "";
  check("lot sizes reported", /lot sizes offered = 1,2,3,4,6/.test(lot), lot);
  check("the single-seat listing is counted", /1 of 5 listing\(s\) cannot be bought as a pair/.test(lot), lot);
  check("and reads as not filtered", /NOT filtered to quantity=2/.test(lot));
  check("event keys logged once", bgLogs.filter((l) => /event keys = /.test(l)).length === 1);

  // This fixture's event has no availableTickets. The inventory-count line must
  // still print — a live load produced NO line when the count was unusable,
  // and silence could not distinguish a stale build from an empty field.
  const inv = bgLogs.find((l) => /availableTickets not usable|ticket\(s\) available/.test(l)) || "";
  check("the inventory-count line prints even without a count", !!inv, inv || "(silent)");
  check("and reports the raw value", /raw value: undefined/.test(inv), inv);
  // 15, not 13: the comparison counts every listing's quantity, parking
  // included (2+6+4+1 seats plus a 2-ticket parking listing). Parking is
  // normally its own GoTickets event (the event carries parkingEventId), so it
  // should not appear in a real response to skew this.
  check("and the tickets actually listed", /lists 15 ticket\(s\)/.test(inv), inv);

  console.log(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
