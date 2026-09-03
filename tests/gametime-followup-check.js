// The page's own listings request is FILTERED: it carries the quantity
// selector, and the response holds only listings sold in that lot size. So a
// single capture is a slice of the event.
//
// injected.js already had machinery for this (built for StubHub); this asserts
// it is wired for Gametime and, more importantly, that the broadened request
// keeps `all_in_pricing`. Dropping that would not change how many listings
// arrive — it would silently change what every price MEANS, from all-in to
// pre-fee, which is the kind of bug that reads as plausible for weeks.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

const down = (s) => s
  .replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");
const source = down(fs.readFileSync(EXT + "injected.js", "utf8"));

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const EVENT_ID = "68af55be0dcf1d7f796e5e89";
const PAGE_URL = "https://mobile.gametime.co/v3/listings/" + EVENT_ID +
  "?all_in_pricing=true&quantity=2&jitter_cheapest=0";

const listing = (id) => ({
  id: id, available_lots: [2], price: { total: 3000, prefee: 2300 },
  seats: ["1", "2"], spot: { section: "224", row: "5", section_group: "Middle" },
});
// What the page's filtered request returns, and what the broadened one does.
const FILTERED = { listings: [listing("a1"), listing("a2")] };
const FULL = { listings: [listing("a1"), listing("a2"), listing("b1"), listing("b2"), listing("b3")] };

const requested = [];
const attempts = [];
const posted = [];

function makeResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true, status: 200,
    clone: () => ({ text: () => Promise.resolve(text), json: () => Promise.resolve(payload) }),
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(payload),
  };
}

const logs = [];
const win = {
  location: {
    href: "https://gametime.co/mlb-baseball/rays-at-rangers-tickets/9-5-2026-arlington/events/" + EVENT_ID,
    hostname: "gametime.co",
    pathname: "/mlb-baseball/rays-at-rangers-tickets/9-5-2026-arlington/events/" + EVENT_ID,
    search: "",
  },
  addEventListener: () => {},
  postMessage: (m) => posted.push(m),
  fetch: (url, init) => {
    const href = String(url);
    requested.push(href);
    attempts.push({ href: href, credentials: init && init.credentials,
                    hasHeaders: !!(init && init.headers) });
    // The page's own request is answered with the filtered set.
    if (requested.length === 1) return Promise.resolve(makeResponse(FILTERED));
    // Reproduce the live failure: gametime.co asking mobile.gametime.co is
    // cross-origin, and the browser rejects credentialed requests there. Only
    // the plain, cookie-less attempt is allowed to succeed.
    const last = attempts[attempts.length - 1];
    if (last.credentials !== "omit" || last.hasHeaders) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve(makeResponse(FULL));
  },
  XMLHttpRequest: function () {},
};
win.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {}, addEventListener() {} };

const ctx = {
  window: win,
  document: { cookie: "", title: "", querySelector: () => null, querySelectorAll: () => [], documentElement: {} },
  navigator: { userAgent: "test" },
  console: { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {} },
  setTimeout: (fn) => { if (typeof fn === "function") fn(); return 1; },
  clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String, Number,
  Boolean, Error, TypeError, isFinite, parseInt, parseFloat, Set, Map,
  encodeURIComponent, decodeURIComponent,
};
ctx.XMLHttpRequest = win.XMLHttpRequest;
ctx.fetch = win.fetch;
ctx.localStorage = { getItem: () => null, setItem: () => {} };
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(source, ctx, { filename: "injected.js" });

out("--- the site is recognised and hooked ---");
check("fetch was patched", ctx.window.fetch !== undefined && requested.length === 0);
check("recognised as Gametime", logs.some((l) => /Running on Gametime/.test(l)),
  (logs[0] || "(no log)").slice(0, 70));

// Drive the page's own request through the patched hook.
ctx.window.fetch(PAGE_URL)
  .then(() => new Promise((r) => setImmediate(r)))
  .then(() => new Promise((r) => setImmediate(r)))
  .then(() => new Promise((r) => setImmediate(r)))
  .then(() => {
    out("");
    out("--- the page's own request is captured ---");
    check("the page request went out", requested.length >= 1, requested[0]);
    check("its payload was posted to the worker",
      posted.some((m) => m && m.type === "FIFA_TICKET_SCOUT"), String(posted.length) + " message(s)");

    out("");
    out("--- and a broadened request follows ---");
    const followUps = requested.slice(1);
    check("a follow-up was issued", followUps.length >= 1,
      followUps.length ? followUps[0] : "none — the filtered slice is all we would get");

    if (followUps.length) {
      const u = new URL(followUps[0]);
      // `quantity` is REQUIRED: the live endpoint answers 400 without it, so
      // the follow-up varies it instead of removing it.
      check("quantity is still present", u.searchParams.has("quantity"), u.search);
      check("but a different lot size is asked for",
        u.searchParams.get("quantity") !== "2", u.searchParams.get("quantity"));
      check("no follow-up ever drops quantity",
        followUps.every((h) => new URL(h).searchParams.has("quantity")),
        "dropping it returns HTTP 400");
      // The load-bearing assertion in this file.
      check("all_in_pricing was KEPT", u.searchParams.get("all_in_pricing") === "true",
        "without it price.total silently becomes the pre-fee figure");
      check("same endpoint and event", u.pathname === "/v3/listings/" + EVENT_ID, u.pathname);
      check("the extra listings were posted on",
        posted.length >= 2, String(posted.length) + " message(s)");

      const asked = followUps.map((h) => new URL(h).searchParams.get("quantity"));
      check("the whole lot-size range is swept", new Set(asked).size >= 7,
        "asked for " + [...new Set(asked)].join(", "));
      check("it does not re-ask for the one the page already got",
        asked.indexOf("2") === -1, "asked for 2 again");
    }

    out("");
    out("--- a rejected strategy does not end the follow-up ---");
    // The live failure: "[GT] follow-up stopped: Failed to fetch." with 283 of
    // the listings in hand. gametime.co asking mobile.gametime.co is
    // cross-origin, and a credentialed request there is rejected outright by
    // the browser whenever the server answers Access-Control-Allow-Origin: *.
    // One attempt meant one refusal ended everything.
    const followAttempts = attempts.slice(1);
    check("more than one combination was tried", followAttempts.length > 1,
      followAttempts.length + " attempt(s)");
    check("it starts with the highest-fidelity attempt",
      followAttempts[0] && followAttempts[0].credentials === "include",
      followAttempts[0] && followAttempts[0].credentials);
    check("it falls back to a plain request",
      followAttempts.some((a) => a.credentials === "omit" && !a.hasHeaders));
    check("and one of them actually succeeded",
      logs.some((l) => /follow-up succeeded with/.test(l)),
      logs.find((l) => /follow-up (succeeded|attempt)/.test(l)) || "(none)");
    check("each refusal is named, not swallowed",
      logs.some((l) => /follow-up attempt ".*" failed: Failed to fetch/.test(l)),
      logs.find((l) => /attempt .* failed/.test(l)) || "(none)");
    check("the listings still arrived", posted.length >= 2,
      posted.length + " message(s) to the worker");

    out("");
    out("--- the working combination is remembered across the sweep ---");
    // Live, the sweep is eight requests. Without this, each one first burned a
    // request on the credentialed attempt the browser always rejects — the log
    // showed "page headers + cookies failed" seven times over. That is double
    // the traffic to a bot-protected endpoint for an already-known refusal.
    const failedAttempts = logs.filter((l) => /follow-up attempt .* failed/.test(l));
    const successes = logs.filter((l) => /follow-up succeeded with/.test(l));
    check("the losing strategy is not retried every time",
      failedAttempts.length <= 2, failedAttempts.length + " failed attempt(s) across the sweep");
    check("and success is announced once, not per request",
      successes.length === 1, successes.length + " success line(s)");
    // Deliberately not asserted here: "one request per lot size". In this
    // harness every attempt IS a request, so that comparison holds even with
    // the memo removed — it cannot fail, and a check that cannot fail is worse
    // than none. The two counts above carry it: 1 failure and 1 success line
    // across the sweep, against 7 of each without the memo.

    out("");
    out("--- a price is not mistaken for an inventory total ---");
    // A Gametime listing holds price: { total: 3000 } — cents. The total-
    // finder used to walk into the listings array and read that $30.00 seat as
    // "3000 reported for the event". Harmless here, fatal on an event with
    // more listings than its top price in cents: `have >= total` reads as
    // "the first response already holds everything" and cancels the follow-up.
    check("no bogus total from a listing price",
      !logs.some((l) => /\[GT\] inventory:.*3000 reported/.test(l)),
      logs.find((l) => /\[GT\] inventory/.test(l)) || "");
    check("it says so plainly instead",
      logs.some((l) => /\[GT\] inventory:.*no total reported/.test(l)),
      logs.find((l) => /\[GT\] inventory/.test(l)) || "");
    check("the follow-up was not cancelled", requested.length >= 2,
      "a phantom total would have stopped it here");

    out("");
    out("--- the shortfall is explained in the log, not silent ---");
    check("it says how many the page itself got",
      logs.some((l) => /\[GT\] inventory: \d+ in this response/.test(l)),
      logs.find((l) => /\[GT\] inventory/.test(l)) || "(not logged)");
    check("each lot size is reported",
      logs.some((l) => /\[GT\] quantity=\d+: \d+ listing\(s\), \d+ new/.test(l)),
      logs.find((l) => /quantity=\d+:/.test(l)) || "(not logged)");
    check("and the sweep is summarised",
      logs.some((l) => /swept quantity over \d+ value\(s\)/.test(l)),
      logs.find((l) => /swept/.test(l)) || "(not logged)");

    out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { out("THREW: " + (e && e.stack)); process.exit(1); });
