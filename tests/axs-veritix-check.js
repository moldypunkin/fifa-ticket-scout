// AXS Veritix inventory — the tix.axs.com shop pages.
//
// Three rounds of captures came back empty because the patterns named
// start-flow and pre-flow specifically. start-flow is 1.3MB of offers, fees and
// parking upsells whose largest array holds 19 items; the seats were one
// directory over the whole time, at /veritix/inventory/V2/<token>/offer/search.
//
// Shapes verbatim from the Jimmy Carr onsale at The Midland Theatre
// (token Z4khGgAAAAABU4y2AgAAAACZ): 592 standard seats, 26 ADA, 11 AXS Premium.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
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

const bg = fs.readFileSync(EXT + "background.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");

const TOKEN = "Z4khGgAAAAABU4y2AgAAAACZ";
const RAW = TOKEN + "%2Fv%2F%2F%2FwD%2F%2F%2F%2F%2FA2F4cwD%2F%2F%2F%2F%2F%2F%2F%2F%2F%2Fw%3D%3D";
const PRICE_URL = `https://unifiedapicommerce-us.axs.com/veritix/inventory/v4/${RAW}/price?flow=pick_a_seat_2d`;
const SEARCH_URL = `https://unifiedapicommerce-us.axs.com/veritix/inventory/V2/${RAW}/offer/search`;

// Price levels as the live /price response carries them: hundredths, with the
// base and the fees as separate components.
const level = (id, label, base, fee) => ({
  label, priceLevelID: id, availability: {}, order: 1,
  prices: [{ base, priceTypeID: "45003", allocationProfileId: 0,
    priceComponents: [
      { name: "Base Component", amount: base, calculationMethod: "Flat", base: true },
      { name: "Service Fee", amount: fee, calculationMethod: "Flat", base: false },
    ] }],
});

const PRICE = {
  currency: "USD", taxes: [], fees: [],
  offerPrices: [
    { offerID: "45517907", offerGroupID: "45517908", offerName: "Jimmy Carr",
      offerType: "Single",
      zonePrices: [{ productID: "45517260", zoneID: 1, eventID: "1176",
        priceLevels: [level(6591, "P1", 6075, 1200), level(6592, "P2", 5075, 1000),
                      level(6593, "P3", 4375, 900), level(6594, "P4", 3075, 700)],
        priceTypes: [] }],
      fees: [] },
    // ADA and premium are separate offers with their own prices, which is why
    // the lookup is by offer AND level rather than level alone.
    { offerID: "45517971", offerName: "ADA", offerType: "Single",
      zonePrices: [{ priceLevels: [level(6591, "P1", 6075, 1200)] }], fees: [] },
    { offerID: "45517944", offerName: "AXS Premium", offerType: "Single",
      zonePrices: [{ priceLevels: [level(6591, "P1", 9900, 2000)] }], fees: [] },
  ],
};

const item = (sectionID, sectionLabel, rowID, rowLabel, number, priceLevelID, status, extra) =>
  Object.assign({
    id: 6, sectionID, sectionLabel, rowID, rowLabel, info1: "", info2: "",
    number, displayOrder: 1, neighborhoodID: 0,
    neighborhoodPrintDescription: "Admissions", statusCode: 6,
    statusCodeLabel: status, offerID: "45517907", isGASection: false,
    priceLevelID, seatType: "STANDARD", disabilityTypes: [],
  }, extra || {});

const SEARCH = {
  offers: [
    { category: "standard", offerGroupID: "45517908", offerID: "45517907",
      productID: "45517260", itemTypeID: "EVT", eventID: "1176", zoneID: "1",
      items: [
        item(2, "101", 21, "8", "1", 6591, "Open"),
        item(2, "101", 21, "9", "2", 6591, "Open"),
        item(9, "402", 80, "C", "14", 6593, "Open"),
        // A level the price payload never mentioned: dropped, not guessed.
        item(9, "402", 80, "C", "15", 9999, "Open"),
      ] },
    { category: "ada", offerID: "45517971", items: [
      item(2, "101", 24, "11", "3", 6591, "ADA",
        { offerID: "45517971", seatType: "ACCESSIBLE", disabilityTypes: ["WC"] }),
    ] },
    { category: "premium", offerID: "45517944", items: [
      item(7, "303", 119, "A", "5", 6591, "AXS Premium POSTED AEG",
        { offerID: "45517944" }),
    ] },
  ],
};

const INFO = { name: "The Midland Theatre - Select", date: null, venue: "The Midland Theatre" };

(async () => {
  out("--- the token the dashboard looks up ---");
  const tokenOf = eval("(" + down(extractFn(bg, "axsVeritixToken")) + ")");
  check("from offer/search", tokenOf(SEARCH_URL) === TOKEN, tokenOf(SEARCH_URL));
  check("from price", tokenOf(PRICE_URL) === TOKEN, tokenOf(PRICE_URL));
  check("v4 and V2 both work", tokenOf(PRICE_URL) === tokenOf(SEARCH_URL));
  // The popup keys tix.axs.com on the leading run of the url's first segment.
  const popupToken = ("https://tix.axs.com/" + RAW + "/shop/search")
    .match(/^https?:\/\/[^/]*tix\.axs\.com\/([A-Za-z0-9_-]{12,})/i)[1];
  check("and it is what the popup keys on", tokenOf(SEARCH_URL) === popupToken,
    tokenOf(SEARCH_URL) + " vs " + popupToken);
  check("a short path yields nothing", tokenOf("https://x/veritix/inventory/V2/ab/offer/search") === "");

  out("");
  out("--- price: every component, not just the base ---");
  ctx.axsIndexVeritixPrices(TOKEN, PRICE);
  await ctx.saveAxsVeritixSeats(TOKEN, SEARCH, 1, "axs", INFO);
  const game = stored["axs:" + TOKEN] || {};
  const seats = Object.values(game.seats || {});
  const p1 = seats.filter((s) => s.block === "101" && s.category === "standard");
  // 6075 + 1200 = 7275 hundredths = $72.75. The base alone would understate
  // every seat by its fee.
  check("level 6591 is $72.75", p1.every((s) => s.price === 72750),
    p1.map((s) => s.price).join(","));
  const p3 = seats.filter((s) => s.block === "402");
  check("level 6593 is $52.75", p3.every((s) => s.price === 52750),
    p3.map((s) => s.price).join(","));
  check("the components are logged with their calculation methods",
    logs.some((l) => /built from Base Component=6075\(Flat\) \+ Service Fee=1200\(Flat\) = \$72\.75/.test(l)),
    logs.find((l) => /built from/.test(l)));
  // The components alone read low against the site — a seat shown at $34.75
  // rings up at $45.71 — so the separate fees table is printed for working out
  // what else applies, rather than its arithmetic being guessed at.
  check("the fees table is printed for checking",
    logs.some((l) => /AXS Veritix fees table:/.test(l)));
  check("so are the offer's fee assignments",
    logs.some((l) => /fee assignments:/.test(l)));

  out("");
  out("--- the seats ---");
  check("5 seats, the unpriced one dropped", seats.length === 5, String(seats.length));
  check("section and row come through",
    seats.some((s) => s.block === "101" && s.row === "8" && s.seat === "1"),
    seats.map((s) => `${s.block}/${s.row}/${s.seat}`).join(" "));
  check("a level with no price is not guessed", !seats.some((s) => s.seat === "15"));
  check("and is reported", logs.some((l) => /1 with no price for their level/.test(l)),
    logs.find((l) => /seats from/.test(l)));
  check("site tagged axs", seats.every((s) => s.site === "axs"));

  out("");
  out("--- three offers, three prices for one price level ---");
  // Same level 6591 at three prices: standard $72.75, ADA $72.75, premium
  // $119.00. Looking price up by level alone would price the premium seat as
  // standard.
  const premium = seats.find((s) => s.category === "premium");
  check("the premium seat is $119.00", premium.price === 119000, String(premium.price));
  const ada = seats.find((s) => s.category === "ada");
  check("the ADA seat keeps the standard price", ada.price === 72750, String(ada.price));
  check("ADA is flagged accessible", ada.accessible === true);
  check("and its status is kept as an attribute",
    ada.attributes.indexOf("ADA") !== -1, ada.attributes.join(","));
  check("a standard open seat carries no attribute",
    seats.find((s) => s.seat === "1").attributes.length === 0);
  // Section 101 appears in both the standard and the ADA offer; keyed on the
  // section alone they would overwrite each other.
  check("the ADA copy of section 101 does not replace the standard seats",
    seats.filter((s) => s.block === "101").length === 3,
    String(seats.filter((s) => s.block === "101").length));

  out("");
  out("--- what came from where, said out loud ---");
  check("the offers are named with their counts",
    logs.some((l) => /standard×4, ada×1, premium×1/.test(l)),
    logs.find((l) => /seats from/.test(l)));
  check("the statuses are reported",
    logs.some((l) => /statusCodeLabel values: "Open"x4, "ADA"x1/.test(l)),
    logs.find((l) => /statusCodeLabel/.test(l)));

  out("");
  out("--- identity ---");
  // "The Midland Theatre - Select" is the page's own heading, not the show.
  check("the venue heading is not taken as the event name",
    game.match.name !== "The Midland Theatre - Select", game.match.name);
  check("the venue is kept", game.match.venue === "The Midland Theatre");

  out("");
  out("--- wiring ---");
  check("the inventory family is captured", /"\/veritix\/inventory\/"/.test(inj));
  check("start-flow and pre-flow still are",
    /"\/veritix\/start-flow\/"/.test(inj) && /"\/veritix\/pre-flow\/"/.test(inj));
  check("the dispatch routes offer/search", /offer\\\/search/.test(bg));
  check("and the price payload", /\\\/price\(\\\?\|\$\)/.test(bg));
  check("seats merge through mergeSeats",
    /games\[gameKey\]\.seats = mergeSeats\(games\[gameKey\]\.seats, seats, tabId, gameKey\);/
      .test(extractFn(bg, "saveAxsVeritixSeats")));
  check("the popup prefers the token key", /if \(axsTokenKey && games\[axsTokenKey\]\)/.test(popup));

  out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
