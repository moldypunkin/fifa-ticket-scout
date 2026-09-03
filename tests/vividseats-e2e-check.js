// Run the real saveVividSeatsSeats against the captured rows, end to end.
//
// Every other Vivid Seats assertion tests a helper in isolation or reads the
// source as text. This one loads background.js into a stubbed service worker,
// calls the save function, and inspects what lands in storage — the only check
// that would catch the parser wiring the right helpers together wrongly.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let stored = null;
const ctx = {
  console: { log: (...a) => console.log("  bg>", a.join(" ")), warn: () => {}, error: (...a) => console.log("  ERR", a.join(" ")) },
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

const body = {
  global: { listingCount: 455, ticketCount: 1607, venueCapacity: 14000,
            mapTitle: "CFG Bank Arena", productionId: 6965630, productionName: "Kacey Musgraves" },
  groups: [{ i: "408358", n: "Upper Level" }, { i: "408360", n: "Theater Boxes" },
           { i: "408357", n: "Lower Level" }],
  sections: [],
  tickets: [
    { s: "Section 208", r: "G", q: "1", p: "33.15", i: "VB17016531865", d: "208",
      n: "Mobile Tickets.", c: "408358", stp: "Ticketmaster Transfer", aip: "47.00",
      sectionName: "Section 208", row: "G", quantity: "1", allInPricePerTicket: "47.00",
      badges: [{ category: "PRICE", title: "Lowest Price in Section" }], perks: [] },
    { s: "Theater Box 103B", r: "AA", q: "6", p: "136.00", i: "VB17005031145", d: "1032",
      n: "Actual 1st row of section.", c: "408360", stp: "Ticketmaster Transfer", aip: "185.00",
      sectionName: "Theater Box 103B", row: "AA", quantity: "6", allInPricePerTicket: "185.00",
      badges: [{ category: "SCARCITY", title: "Last Ticket in Section" }], perks: ["Seated Together"] },
    { s: "Section 104", r: "C", q: "1", p: "307.00", i: "VB16936621448", d: "104",
      n: "estimated delivery date is 09/04/26.", c: "408357", stp: "Ticketmaster Transfer",
      aip: "417.00", sectionName: "Section 104", row: "C", quantity: "1",
      allInPricePerTicket: "417.00", badges: [], perks: [] },
    { s: "Parking Pass", r: "", q: "2", p: "20.00", i: "VBPARK1", d: "P1", c: "408358",
      sectionName: "Parking Pass", row: "", quantity: "2", allInPricePerTicket: "25.00",
      badges: [], perks: [] },
  ],
};

ctx.saveVividSeatsSeats("6965630", body, 1, "vividseats", null).then(() => {
  const game = stored["vividseats:6965630"];
  const seats = Object.values(game.seats);
  let fail = 0;
  const check = (l, c, d) => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

  console.log("");
  check("8 seats from 3 listings (1+6+1), parking dropped", seats.length === 8, String(seats.length));
  check("event name from the payload", game.match.name === "Kacey Musgraves", game.match.name);
  check("venue from mapTitle", game.match.venue === "CFG Bank Arena", game.match.venue);
  check("no parking seat survived", !seats.some((s) => /parking/i.test(s.block)));

  const box = seats.filter((s) => s.block === "Theater Box 103B");
  check("the 6-seat listing became 6 seats", box.length === 6, String(box.length));
  check("stored in thousandths (185.00 -> 185000)", box[0].price === 185000, String(box[0].price));
  check("area resolved from the group id", box[0].area === "Theater Boxes", box[0].area);
  check("row carried", box[0].row === "AA", box[0].row);
  check("seat left blank", box[0].seat === "", JSON.stringify(box[0].seat));
  check("perk kept", box[0].attributes.indexOf("Seated Together") >= 0, box[0].attributes.join(" | "));
  check("keys are unique per seat", new Set(Object.keys(game.seats)).size === 8);
  check("site tagged", seats.every((s) => s.site === "vividseats"));
  check("tier assigned", box[0].tier != null, String(box[0].tier));

  const cheap = seats.find((s) => s.block === "Section 208");
  check("cheapest is the all-in 47.00, not 33.15", cheap.price === 47000, String(cheap.price));

  console.log(fail ? "\n" + fail + " FAILURES" : "\nend-to-end ok");
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
