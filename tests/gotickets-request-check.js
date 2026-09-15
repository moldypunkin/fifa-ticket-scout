// The GoTickets listings request is a POST whose body carries the filters that
// limit the response (2,554 tickets available, 244 returned on the live
// event). The page passes a Request object, so the body is in the Request's
// stream rather than in `init.body` — the first log read init only and printed
// "body: none". This executes the real fetch hook with a Request-shaped object
// and checks that the body is read, the filters are visible, long token-like
// strings are not, and the page's own request still gets its body.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");
const source = down(fs.readFileSync(EXT + "injected.js", "utf8"));

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const LIVE = "https://gotickets.com/tickets/1984079/trans-siberian-orchestra-tickets/t-mobile-center-kansas-city-mo-12-29-2026?orderBy=Price%3A+Low+to+High&quantity=1";
const LISTINGS = "https://gotickets.com/rest/events/1984079/listings";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRETSECRETSECRETSECRETSECRET";
const BODY = JSON.stringify({ quantity: 1, sort: "PRICE_ASC", pageSize: 58, page: 0,
  challenge: { token: TOKEN, number: 41327 }, sectionIds: [1891434, 1891461] });

function run(makeCall) {
  const u = new URL(LIVE);
  const logs = [];
  let pageReadBody = null;
  const resp = { ok: true, status: 200, headers: { get: () => "application/json" },
    clone: () => ({ text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) }),
    text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) };
  const win = {
    location: { href: LIVE, hostname: u.hostname, pathname: u.pathname, search: u.search },
    addEventListener() {}, postMessage() {},
    // The "network": what the page's own request actually sent.
    fetch: (input, init) => {
      if (input && typeof input.text === "function" && !(init && init.body)) {
        return input.text().then((t) => { pageReadBody = t; return resp; });
      }
      pageReadBody = init && init.body;
      return Promise.resolve(resp);
    },
    XMLHttpRequest: function () {},
  };
  win.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {}, addEventListener() {} };
  const ctx = { window: win,
    document: { cookie: "", title: "", querySelector: () => null, querySelectorAll: () => [], documentElement: {} },
    navigator: { userAgent: "t" },
    console: { log: (...a) => logs.push(a.join(" ")), warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String, Number,
    Boolean, Error, TypeError, isFinite, parseInt, parseFloat, Set, Map,
    encodeURIComponent, decodeURIComponent,
    // Browsers always define Headers. The fetch hook's header capture — code
    // from the first release — tests `init.headers instanceof Headers`, and
    // without this the sandbox throws a ReferenceError the real page never
    // would. A plain object is not an instance, so it takes the spread path.
    Headers: function Headers() {} };
  ctx.XMLHttpRequest = win.XMLHttpRequest; ctx.fetch = win.fetch;
  ctx.localStorage = { getItem: () => null, setItem() {} };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "injected.js" });
  return makeCall(ctx.window.fetch)
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => ({ logs, pageReadBody }));
}

// A Request-shaped object: a one-shot body stream, like the real thing.
//
// Each object — the original and every clone — gets its OWN consumed flag.
// That is what a real Request.clone() provides, and it is exactly what the log
// relies on. The first version of this fake kept one flag shared by the
// original and its clones, so reading the clone for the log made the page's own
// request fail with "body already used": a failure of the fake, not the hook.
function requestLike(url, method, body, headerNames) {
  const make = () => {
    let consumed = false;
    const r = {
      url, method,
      headers: { keys: () => headerNames[Symbol.iterator]() },
      text: () => {
        if (consumed) return Promise.reject(new TypeError("body already used"));
        consumed = true;
        return Promise.resolve(body);
      },
    };
    r.clone = () => make();  // a genuinely independent stream
    return r;
  };
  return make();
}

run((fetch) => fetch(requestLike(LISTINGS, "POST", BODY, ["baggage", "content-type", "sentry-trace"])))
  .then(({ logs, pageReadBody }) => {
    out("--- a POST passed as a Request object ---");
    const line = logs.find((l) => /\[GOT\] listings request \(fetch\)/.test(l)) || "";
    check("the request is described", !!line, line || "(no line)");
    check("method is POST", /: POST https:\/\/gotickets\.com\/rest\/events\/1984079\/listings/.test(line));
    check("the body is read from the Request, not reported as none", !/body: none/.test(line), line);
    check("quantity is visible", /"quantity":1/.test(line), line);
    check("sort is visible", /"sort":"PRICE_ASC"/.test(line));
    check("page size is visible", /"pageSize":58/.test(line));
    check("an array of ids is visible", /"sectionIds":\[1891434,1891461\]/.test(line));
    check("a long token is NOT logged", line.indexOf("SECRET") === -1 && line.indexOf("eyJhbGci") === -1, line);
    check("it is replaced by its length", /<string, \d+ chars>/.test(line));
    check("header names only", /headers: baggage,content-type,sentry-trace/.test(line));
    // The load-bearing check: reading the body for the log must not consume the
    // page's own one-shot stream, or GoTickets would stop loading listings.
    check("the page's own request still sent its body", pageReadBody === BODY,
      pageReadBody == null ? "body was consumed by the log" : String(pageReadBody).slice(0, 60));

    return run((fetch) => fetch(LISTINGS, { method: "POST", body: BODY,
      headers: { "content-type": "application/json" } }));
  })
  .then(({ logs, pageReadBody }) => {
    out("");
    out("--- a POST with a string body in init ---");
    const line = logs.find((l) => /\[GOT\] listings request \(fetch\)/.test(l)) || "";
    check("described", /"quantity":1/.test(line), line);
    check("token hidden here too", line.indexOf("SECRET") === -1);
    check("the page's request is untouched", pageReadBody === BODY);

    return run((fetch) => fetch("https://gotickets.com/rest/regions"));
  })
  .then(({ logs }) => {
    out("");
    out("--- other GoTickets requests are not described ---");
    check("no request line for /rest/regions",
      !logs.some((l) => /\[GOT\] listings request/.test(l)));

    out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { out("THREW: " + (e && e.stack)); process.exit(1); });
