// Every Evenue school, end to end, in one run.
//
// Evenue is Paciolan and each school runs its own build: Kansas prices seats on
// the row, Nebraska prices only the seats it has already sold, Colorado prices
// none of them and ships the table in the page. Fixing one school kept denting
// another because they all went through the same guesses. This suite runs the
// REAL saveEvenueSeats/saveEvenuePriceLevels against each school's own captured
// payload, so a change that suits the school in front of you fails here for the
// ones that are not.
//
// Adding a school: add a fixture below and an entry in EVENUE_SCHOOLS.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

// A fresh service worker per school: storage, logs and the module-level maps
// (held fee rules, parked seat payloads) must not leak between them.
function freshWorker() {
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
        // enforceGameLimit reads the licence tier; without one every save is
        // treated as the free tier and drops the other school's event.
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
  return { ctx, logs, games: () => stored || {} };
}

const HEADERS = ["LEVELSECTIONCD", "ROWCD", "SEATCD", "PRICELEVELCD", "SEATSTATUS",
  "MARKER_ID", "SEAT_MARKER_ACTIVE", "SLP_PRICE", "AVAILABLE", "HIDDEN"];
const row = (sec, rw, seat, pl, status, price, avail, hidden) =>
  [sec, rw, seat, pl, status, null, null, price, avail, hidden || 0];

// ─── Kansas: the price is on the row ──────────────────────────────────────
// kuathletics F26:02, as the probe printed it. No price table needed.
const KANSAS = {
  url: "https://kuathletics.evenue.net/pac-api/seat-availability/event-id/977:F26:02/seats",
  eventId: "F26:02",
  seats: [[
    row("KU:101", "10", "1", "4", "%", 32039, 0),
    row("KU:101", "10", "10", "4", "O", 32039, 1),
    row("KU:101", "10", "11", "4", "O", 32039, 1),
  ], HEADERS],
  eventInfo: { name: "Kansas vs Kansas State", date: "15-11-2026 - 14:00", venue: "Memorial Stadium" },
  expect: { seats: 2, cheapest: 320390, source: "inline" },
};

// ─── Nebraska: only the SOLD seats carry a price ──────────────────────────
// huskers F26:06. The seats on sale have SLP_PRICE null and no price table ever
// arrives, so nothing is stored — and crucially no price is borrowed from the
// sold rows beside them ($220 season seats against a $102 sale price).
const NEBRASKA = {
  url: "https://huskers.evenue.net/pac-api/seat-availability/event-id/126:F26:06/seats",
  eventId: "F26:06",
  seats: [[
    row("ES:3", "10", "1", "1", "a", 22000, 0),
    row("ES:3", "10", "10", "1", "X", 22000, 0),
    row("NS:33", "55", "16", "1", "u", null, 1),
    row("NS:33", "55", "17", "1", "u", null, 1),
  ], HEADERS],
  eventInfo: { name: "Nebraska vs Washington", date: null, venue: "Memorial Stadium" },
  expect: { seats: 0, unpriced: 2 },
};

// ─── Colorado: the price table is in the page ─────────────────────────────
// cubuffs F26:F02. Seats carry no price; the 7-level table arrives as the
// page's own ssrData. Charges nothing, and the page names only the opponent.
const COLORADO = {
  url: "https://cubuffs.evenue.net/pac-api/seat-availability/event-id/244:F26:F02/seats",
  ssrUrl: "https://cubuffs.evenue.net/pac-api/ssr/__NEXT_DATA__",
  eventId: "F26:F02",
  seats: [[
    row("CU:201", "5", "1", "5", "O", null, 1),
    row("CU:201", "5", "2", "5", "O", null, 1),
    row("CU:101", "3", "7", "6", "O", null, 1),
    row("CU:101", "3", "8", "6", "X", null, 0),
  ], HEADERS],
  detail: {
    SEASONCD: "F26", ITEMCD: "F02", ITEMNAME: "TT (FB)", SSEVENTNAME: "Texas Tech",
    EVENTNAME: "Texas Tech (FB)", SEASON_NAME: "2026 Football",
    EVENTDT: "2026-10-03T19:30:00", EVENTDTFAC: "2026-10-03T17:30:00",
    FAC_TITLE: "Folsom Field", ITEM_FEES: null,
    PL_PT_PRICES: [{ PRICELEVELCD: "5", PRICE: 9000 }, { PRICELEVELCD: "6", PRICE: 39000 }],
  },
  eventInfo: { name: "TT (FB)", date: null, venue: "Folsom Field",
               host: "University of Colorado" },
  expect: { seats: 3, cheapest: 90000, priciest: 390000, source: "levels",
            name: "University of Colorado vs Texas Tech", date: "03-10-2026 - 17:30" },
};

async function runSchool(school, fixture) {
  const w = freshWorker();
  const key = "evenue:" + fixture.eventId;
  if (fixture.detail) {
    await w.ctx.saveEvenuePriceLevels([fixture.detail], 1, "evenue", fixture.eventInfo,
      fixture.ssrUrl);
  }
  await w.ctx.saveEvenueSeats(fixture.eventId, fixture.seats, 1, "evenue",
    fixture.eventInfo, fixture.url);
  const game = w.games()[key] || {};
  const seats = Object.values(game.seats || {});
  return { w, game, seats, logs: w.logs };
}

(async () => {
  out("--- the profile each school resolves to ---");
  {
    const w = freshWorker();
    const prof = (u) => w.ctx.evenueProfile(u);
    check("Kansas", prof(KANSAS.url).label === "Kansas", prof(KANSAS.url).label);
    check("Nebraska", prof(NEBRASKA.url).label === "Nebraska", prof(NEBRASKA.url).label);
    check("Colorado", prof(COLORADO.url).label === "Colorado", prof(COLORADO.url).label);
    const unknown = prof("https://hokies.evenue.net/event/F26/01");
    check("a school nobody has opened gets the default", unknown.label === null, String(unknown.label));
    check("and is named by its subdomain", unknown.key === "hokies", unknown.key);
    check("the default does not force a price source", unknown.priceSource === null);
    // Each school states where its prices come from, so drift is visible.
    check("Kansas prices inline", prof(KANSAS.url).priceSource === "inline");
    check("Nebraska prices from levels", prof(NEBRASKA.url).priceSource === "levels");
    check("Colorado prices from levels", prof(COLORADO.url).priceSource === "levels");
    // Only Colorado's page title names the host school.
    check("the host is joined on for Colorado only",
      prof(COLORADO.url).hostFromTitle === true && prof(KANSAS.url).hostFromTitle === false
      && prof(NEBRASKA.url).hostFromTitle === false);
  }

  out("");
  out("--- Kansas: priced on the row ---");
  {
    const r = await runSchool("Kansas", KANSAS);
    check("2 available seats", r.seats.length === KANSAS.expect.seats, String(r.seats.length));
    check("priced from the row, $320.39", r.seats[0].price === KANSAS.expect.cheapest,
      String(r.seats[0] && r.seats[0].price));
    check("the sold seat is excluded", !r.seats.some((s) => s.seat === "1"));
    check("the page's event name is kept", r.game.match.name === "Kansas vs Kansas State",
      r.game.match && r.game.match.name);
    check("the log names the school",
      r.logs.some((l) => /Evenue \(Kansas\): 2 available seats/.test(l)),
      r.logs.find((l) => /available seats/.test(l)));
    check("and says the prices were inline",
      r.logs.some((l) => /2 priced inline/.test(l)));
  }

  out("");
  out("--- Nebraska: only sold seats carry a price ---");
  {
    const r = await runSchool("Nebraska", NEBRASKA);
    check("no seats stored", r.seats.length === 0, String(r.seats.length));
    // The regression that matters: $220 is a season seat, the sale price is $102.
    check("no price is borrowed from the sold rows beside them",
      !r.seats.some((s) => s.price === 220000));
    check("the unpriced seats are counted, not guessed",
      r.logs.some((l) => /2 had no price/.test(l)),
      r.logs.find((l) => /available seats/.test(l)));
    check("the payload is held for a price table that may yet arrive",
      r.logs.some((l) => /holding .* payload for F26:06/.test(l)));
  }

  out("");
  out("--- Colorado: priced from the table in the page ---");
  {
    const r = await runSchool("Colorado", COLORADO);
    check("3 available seats", r.seats.length === COLORADO.expect.seats, String(r.seats.length));
    const prices = r.seats.map((s) => s.price).sort((a, b) => a - b);
    check("level 5 is $90.00", prices[0] === COLORADO.expect.cheapest, String(prices[0]));
    check("level 6 is $390.00", prices[prices.length - 1] === COLORADO.expect.priciest,
      String(prices[prices.length - 1]));
    check("the sold seat is excluded", r.seats.length === 3);
    check("the host school is joined to the opponent",
      r.game.match.name === COLORADO.expect.name, r.game.match && r.game.match.name);
    check("the date comes from the facility's clock",
      r.game.match.date === COLORADO.expect.date, r.game.match && r.game.match.date);
    check("the venue is Folsom Field", r.game.match.venue === "Folsom Field");
    check("and says the prices came from the level table",
      r.logs.some((l) => /3 priced from the level table/.test(l)));
  }

  out("");
  out("--- one school's quirks do not reach another ---");
  {
    // Colorado joins its host school on; Kansas must not, or every Kansas event
    // gets renamed by whatever its page title happens to end with.
    const kansasWithHost = await runSchool("Kansas",
      Object.assign({}, KANSAS, { eventInfo: Object.assign({}, KANSAS.eventInfo,
        { name: null, host: "University of Kansas" }) }));
    const named = kansasWithHost.game.match && kansasWithHost.game.match.name;
    check("Kansas is not renamed by its page title", !/University of Kansas vs/.test(String(named)),
      String(named));

    // Nebraska holds its payload; that must not leave Colorado's seats parked.
    const colorado = await runSchool("Colorado", COLORADO);
    check("Colorado's seats are not held", colorado.seats.length === 3,
      String(colorado.seats.length));
    check("nothing is held for Colorado",
      !colorado.logs.some((l) => /holding .* payload for F26:F02/.test(l)));
  }

  out("");
  out("--- fees are per event, never per site ---");
  {
    const w = freshWorker();
    const rule = w.ctx.evenueFeeRule;
    // Colorado publishes an empty table and charges nothing; Nebraska charges
    // 7%; the flat $5 constant was measured at a fourth school and fits neither.
    check("Colorado: nothing", JSON.stringify(rule("{}")) === '{"pct":0,"flat":0,"tiers":0}',
      JSON.stringify(rule("{}")));
    check("Nebraska: 7%", rule({ tiers: { "0-Infinity": { ticketFeePct: 7, facFeePct: 0,
      ticketFeeAmt: 0, facFeeAmt: 0 } } }).pct === 7);
    check("an unreadable table leaves the fallback alone", rule("not json") === null);
  }

  out(fail ? "\n" + fail + " FAILURES" : "\nevery school still behaves");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
