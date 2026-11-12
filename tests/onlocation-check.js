// On Location (TicketNetwork / Seatics).
//
// The one source whose listings are not on the network. Five discovery rounds
// ruled out fetch, XHR, WebSocket, JSONP and the server-rendered html, and the
// Seatics framework does not fetch tickets either — it reads config.tickets,
// handed to it by the page. They only exist as page state, at
// Seatics.TicketConnector.SectionsByName[<section>].tickets, so the adapter
// reads them there and posts them under a synthetic path.
//
// Two halves are pinned here: the adapter's read of that state, and the
// parser's handling of what it posts.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const EVENT = "1001555732";
const URL_ = "https://onlocationexp.com/e/sports/ncaa-mens-college-world-series-ticket-" +
  "(game-1)-and-tailgate-experience/charles-schwab-field-omaha/june-18-2027-" + EVENT;

// ─── the adapter's read of Seatics state ────────────────────────────────────

// Verbatim shape from a live event, including the back-reference that makes
// these records impossible to JSON.stringify.
function seaticsState() {
  const SectionsByName = {};
  const add = (bare, level, rows) => {
    const sec = { level: {}, zones: [], rows: [], rowNames: [], hasTickets: true,
                  sectionNumber: bare, canonicalName: bare, tickets: [] };
    for (const r of rows) {
      const t = {
        tgCanonSec: "", tgUserSec: bare, tgUserRow: r.row, tgQty: r.qty,
        tgPrice: r.price, tgAllInPrice: r.allIn == null ? r.price : r.allIn,
        tgServiceFee: r.fee || 0, tgDeliveryFee: 0,
        tgID: r.id, tgTGcode: r.id, tgNotes: r.notes || "", tgUserSeats: "",
        tgType: 1, tgCType: r.ctype || "R", tgIsZoneTicket: !!r.zone,
        tgRange: [r.qty, r.qty], splits: r.splits || [r.qty],
        sawFaceValue: false, tgOnMap: true,
      };
      t.section = sec;        // the cycle
      sec.tickets.push(t);
    }
    sec.level = { sections: [sec] };
    // Seatics indexes every section TWICE, under the bare number and under its
    // prefixed name, both pointing at the SAME array. This is the trap: a
    // census of a 52-listing event counted 104.
    SectionsByName[bare] = sec;
    SectionsByName[level + " " + bare] = sec;
  };

  add("102", "LOWER LEVEL", [
    { id: "73469762", row: "12", qty: 2, price: 310, splits: [2] },
    { id: "73469795", row: "4", qty: 2, price: 320, splits: [2] },
    { id: "73473513", row: "3", qty: 8, price: 320, splits: [1, 2, 3, 4, 5, 6, 8] },
  ]);
  add("210", "CLUB", [
    { id: "73480001", row: "A", qty: 4, price: 510, notes: "Limited view", zone: true },
  ]);
  return { TicketConnector: { SectionsByName: SectionsByName, processTickets: function () { return 1; } },
           config: {} };
}

function loadAdapter(href) {
  const u = new URL(href);
  const logs = [];
  const posted = [];
  const win = {
    location: { href: href, hostname: u.hostname, pathname: u.pathname,
                search: u.search, origin: u.origin },
    postMessage: (m) => posted.push(m),
  };
  const ctx = {
    window: win, document: {},
    console: { log: (...a) => logs.push(a.join(" ")) },
    setInterval: () => 1, clearInterval: () => {},
    URL, URLSearchParams, JSON, Object, Array, Number, Math, String, Boolean,
    Set, isFinite, RegExp, Error, parseInt, parseFloat,
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(down(fs.readFileSync(EXT + "onlocation-adapter.js", "utf8")), ctx,
    { filename: "onlocation-adapter.js" });
  return { ctx, win, logs, posted };
}

out("--- the adapter reads Seatics' own state ---");
const a = loadAdapter(URL_);
a.win.Seatics = seaticsState();
a.win.__eventInfo = { read: () => ({ name: "NCAA Men's College World Series", date: null, venue: "Charles Schwab Field Omaha" }) };

const collected = a.win.__onlocationAdapter.collectTickets();
// Four listings live in the fixture; eight rows are reachable through the two
// section aliases. Counting rows rather than ids doubles every listing.
check("each listing is kept once", collected.length === 4, String(collected.length));
check("and the duplicates are reported",
  a.logs.some((l) => /duplicate row\(s\) dropped/.test(l)),
  a.logs.find((l) => /duplicate/.test(l)));

const byId = {};
for (const t of collected) byId[t.tgID] = t;
check("section comes from the record", byId["73469762"].tgUserSec === "102");
// The level is ONLY in the prefixed key ("LOWER LEVEL 102"); the record itself
// has an empty tgCanonSec, so without this the Area column would be blank.
check("the level comes from the prefixed alias", byId["73469762"].level === "LOWER LEVEL",
  byId["73469762"].level);
check("and for a club section", byId["73480001"].level === "CLUB", byId["73480001"].level);
check("no seat numbers are invented", collected.every((t) => t.tgUserSeats === ""));
// splits is the purchasable lot sizes. Reading it as a count would turn one
// 8-seat listing into seven phantom ones.
check("splits are carried, not counted",
  byId["73473513"].splits.join(",") === "1,2,3,4,5,6,8" && byId["73473513"].tgQty === 8,
  byId["73473513"].splits.join(","));

out("");
out("--- what it posts ---");
a.win.__onlocationAdapter.pushTickets("test");
check("one message", a.posted.length === 1, String(a.posted.length));
const msg = a.posted[0] || {};
check("on the shared capture channel", msg.type === "FIFA_TICKET_SCOUT", msg.type);
check("under the synthetic path", /\/__scout\/seatics-tickets$/.test(msg.url || ""), msg.url);
check("carrying the url's event id", msg.body && msg.body.eventId === EVENT,
  msg.body && msg.body.eventId);
check("and the listings", msg.body && msg.body.tickets.length === 4);
// Re-posting an unchanged set would churn storage and reset the merge.
check("an unchanged set is not posted again", a.win.__onlocationAdapter.pushTickets("again") === false);

// ─── the parser ─────────────────────────────────────────────────────────────

let stored = null;
const bgLogs = [];
function loadBackground() {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const ctx = {
    console: { log: (...x) => bgLogs.push(x.join(" ")), warn: noop, error: noop },
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String,
    Number, Boolean, Error, TypeError, isFinite, isNaN, parseInt, parseFloat, Set, Map,
    WeakMap, encodeURIComponent, decodeURIComponent, Uint8Array, ArrayBuffer,
    TextEncoder: function () { this.encode = () => new Uint8Array(0); },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    crypto: { subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) }, getRandomValues: (x) => x },
    location: { href: "chrome-extension://test/background.js" },
  };
  ctx.chrome = {
    runtime: { id: "t", lastError: null, onMessage: listener, onInstalled: listener,
               onStartup: listener, sendMessage: noop, getURL: (x) => x,
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
    for (const f of files) {
      vm.runInContext(down(fs.readFileSync(EXT + f, "utf8")), ctx, { filename: f });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(down(fs.readFileSync(EXT + "background.js", "utf8")), ctx,
    { filename: "background.js" });
  return ctx;
}

const bg = loadBackground();
const INFO = { name: "2027 NCAA Baseball College World Series - Game 1", date: "18-06-2027",
               venue: "Charles Schwab Field Omaha" };

out("");
out("--- the parser ---");
bg.saveOnLocationSeats(EVENT, msg.body, 1, "onlocation", INFO).then(() => {
  const game = stored["onlocation:" + EVENT] || {};
  const records = Object.values(game.seats || {});
  const rows = bg.expandSeatCounts(records);
  const rec = (id) => records.find((r) => r.block && game.seats["ol:" + id] === r);

  check("one record per listing", records.length === 4, String(records.length));
  // Four listings holding 2 + 2 + 8 + 4 tickets.
  check("16 tickets between them", rows.length === 16, String(rows.length));
  // One stored record standing for its quantity, the shape the GA work added
  // in v3.7.0 — these tickets are indistinguishable, so copies hold nothing.
  check("quantity is a count, not copies",
    game.seats["ol:73473513"].count === 8, String(game.seats["ol:73473513"].count));

  out("");
  out("--- pricing ---");
  // tgAllInPrice, stored in thousandths like every other source.
  check("the all-in price is stored", game.seats["ol:73469762"].price === 310000,
    String(game.seats["ol:73469762"].price));
  check("and a dearer listing", game.seats["ol:73480001"].price === 510000,
    String(game.seats["ol:73480001"].price));
  // The open question, said out loud every scan rather than assumed once.
  const priceLine = bgLogs.find((l) => /On Location prices/.test(l)) || "";
  check("an all-in that never beats base is reported as unconfirmed",
    /UNCONFIRMED against checkout/.test(priceLine), priceLine);

  out("");
  out("--- the rest of the row ---");
  check("no seat number is invented",
    records.every((r) => r.seat === ""), records.map((r) => r.seat).join("|"));
  check("the row survives", game.seats["ol:73469762"].row === "12");
  check("the level becomes the area", game.seats["ol:73469762"].area === "LOWER LEVEL",
    game.seats["ol:73469762"].area);
  // "R" is the only class seen; it is mapped, not guessed at, and an unknown
  // class is carried through as itself rather than filed as resale.
  check("tgCType R reads as resale",
    records.every((r) => r.category === "resale"), records.map((r) => r.category).join(","));
  check("tiered from the venue map", records.every((r) => !!r.tier));
  check("a zone listing says so",
    game.seats["ol:73480001"].attributes.indexOf("Zone seating") !== -1,
    game.seats["ol:73480001"].attributes.join("|"));
  check("seller notes are kept",
    game.seats["ol:73480001"].attributes.indexOf("Limited view") !== -1);
  check("the splits are an attribute, not a quantity",
    game.seats["ol:73473513"].attributes.some((x) => /sells in 1,2,3,4,5,6,8/.test(x)),
    game.seats["ol:73473513"].attributes.join("|"));
  check("every row says which site it came from",
    records.every((r) => r.site === "onlocation"));
  void rec;

  out("");
  out("--- a listing that does carry fees ---");
  // The same parser on an event where the all-in figure rises above the base:
  // the unconfirmed warning must then NOT fire.
  stored = null;
  bgLogs.length = 0;
  const withFees = { eventId: EVENT, tickets: [{
    tgID: "9001", tgUserSec: "118", tgUserRow: "7", tgUserSeats: "", tgQty: 2,
    tgPrice: 310, tgAllInPrice: 394, tgServiceFee: 62, tgDeliveryFee: 22,
    tgNotes: "", tgCType: "R", tgIsZoneTicket: false, splits: [2], level: "LOWER LEVEL",
  }] };
  return bg.saveOnLocationSeats(EVENT, withFees, 1, "onlocation", INFO).then(() => {
    const g = stored["onlocation:" + EVENT];
    check("the all-in figure wins over the base", g.seats["ol:9001"].price === 394000,
      String(g.seats["ol:9001"].price));
    const line = bgLogs.find((l) => /On Location prices/.test(l)) || "";
    check("and it is no longer called unconfirmed",
      !/UNCONFIRMED/.test(line) && /1 of 1 listing\(s\) have tgAllInPrice above/.test(line),
      line);

    out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
    process.exit(fail ? 1 : 0);
  });
}).catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
