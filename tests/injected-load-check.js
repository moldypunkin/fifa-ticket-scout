// Actually EXECUTE injected.js in a stubbed browser context, per site.
//
// Every other suite reads the file as text, so none could catch a temporal
// dead zone: `isTicketmasterAM` was declared beside DISCOVERY_SITE but used in
// MATCH_PATTERNS 200 lines earlier. `const` hoists into a TDZ, so the IIFE
// threw on load — for EVERY site, not just Account Manager — while every
// text-based assertion still passed.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

// node 12 predates ?. and ??; Chrome supports both.
const down = (s) => s
  .replace(/\?\.\[/g, "[")
  .replace(/\?\.\(/g, "(")
  // `]` matters too: args[0]?.url has a bracket before the operator.
  .replace(/(\w|\)|\])\?\./g, "$1.")
  .replace(/ \?\? /g, " || ");
const source = down(fs.readFileSync(EXT + "injected.js", "utf8"));

function makeContext(href) {
  const u = new URL(href);
  const logs = [];
  const listeners = [];
  const win = {
    location: { href, hostname: u.hostname, pathname: u.pathname, search: u.search },
    addEventListener: (t, fn) => listeners.push([t, fn]),
    postMessage: () => {},
    fetch: () => Promise.resolve({ ok: true, clone: () => ({ text: () => Promise.resolve("{}") }), json: () => Promise.resolve({}) }),
    XMLHttpRequest: function () {},
  };
  win.XMLHttpRequest.prototype = {
    open() {}, send() {}, setRequestHeader() {}, addEventListener() {},
  };
  const doc = {
    cookie: "",
    title: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: {},
  };
  const ctx = {
    window: win, document: doc, navigator: { userAgent: "test" },
    console: { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {} },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String, Number,
    Boolean, Error, TypeError, isFinite, parseInt, parseFloat, Set, Map, encodeURIComponent,
    decodeURIComponent,
  };
  // injected.js reaches for some of these bare, not via window., so they have
  // to exist as globals in the context AND as the same objects on window.
  ctx.XMLHttpRequest = win.XMLHttpRequest;
  ctx.fetch = win.fetch;
  ctx.localStorage = { getItem: () => null, setItem: () => {} };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, logs, win };
}

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

const SITES = [
  ["FIFA resale",   "https://fwc26-resale-usd.tickets.fifa.com/secure/selection/event/seat/performance/123"],
  ["Ticketmaster",  "https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"],
  ["TM Account Mgr","https://am.ticketmaster.com/mizzou/buy/ism/MjZGQjAxQVA="],
  ["SeatGeek",      "https://seatgeek.com/chiefs-tickets/nfl/2026-09-14/18014270"],
  ["StubHub",       "https://www.stubhub.com/chiefs-tickets/event/158234567/"],
  ["Evenue",        "https://kuathletics.evenue.net/event/F26/02"],
  ["TickPick",      "https://www.tickpick.com/buy-chiefs-tickets/6789012/"],
  ["AXS",           "https://www.axs.com/events/123456/chiefs-tickets"],
  ["unrelated site","https://example.com/"],
];

out("--- injected.js must load without throwing, on every site ---");
for (const [label, href] of SITES) {
  const { ctx, logs } = makeContext(href);
  let err = null;
  try {
    vm.runInContext(source, ctx, { filename: "injected.js" });
  } catch (e) {
    err = e && e.message;
  }
  check(`${label} loads`, !err, err);
  if (!err) {
    check(`${label} announced itself`, logs.some((l) => /FIFA Ticket Scout/.test(l)),
      (logs[0] || "(no log)").slice(0, 70));
  }
}

out("--- the hooks are actually installed ---");
{
  const { ctx } = makeContext("https://am.ticketmaster.com/mizzou/buy/ism/MjZGQjAxQVA=");
  const originalFetch = ctx.window.fetch;
  const originalOpen = ctx.window.XMLHttpRequest.prototype.open;
  vm.runInContext(source, ctx, { filename: "injected.js" });
  check("fetch was patched", ctx.window.fetch !== originalFetch);
  check("XHR.open was patched", ctx.window.XMLHttpRequest.prototype.open !== originalOpen);
}

out("--- loading twice is a no-op, not a double patch ---");
{
  const { ctx, logs } = makeContext("https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF");
  vm.runInContext(source, ctx, { filename: "injected.js" });
  const afterFirst = ctx.window.fetch;
  vm.runInContext(source, ctx, { filename: "injected.js" });
  check("guard held", ctx.window.fetch === afterFirst);
  check("did not re-announce", logs.filter((l) => /adapter loaded|Running on/.test(l)).length <= 1);
}

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
