// Execute EVERY loadable unit, not just injected.js.
//
// injected-load-check covers the page-context script. But the extension has
// several independent load contexts, and a throw in any one is fatal to that
// context alone: the service worker (importScripts plus top-level work), the
// popup and its scripts, the content script, and each MAIN-world adapter.
// A text-based suite cannot see a temporal dead zone or a missing global in
// any of them — that class of bug already shipped once.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

// node 12 predates ?. and ??; Chrome supports both.
const down = (s) => s
  .replace(/\?\.\[/g, "[")
  .replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.")
  .replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

function baseGlobals(logs) {
  return {
    console: {
      log: (...a) => logs.push(a.join(" ")),
      warn: () => {},
      error: (...a) => logs.push("ERR " + a.join(" ")),
    },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    URL, URLSearchParams, JSON, Math, Date, Promise, RegExp, Object, Array, String, Number,
    Boolean, Error, TypeError, isFinite, isNaN, parseInt, parseFloat, Set, Map, WeakMap,
    encodeURIComponent, decodeURIComponent, Uint8Array, ArrayBuffer,
    TextEncoder: function TextEncoder() { this.encode = () => new Uint8Array(0); },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  };
}

// The chrome.* surface the extension actually touches.
function chromeStub() {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  return {
    runtime: {
      id: "test", lastError: null, onMessage: listener, onInstalled: listener,
      onStartup: listener, sendMessage: noop, getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.0.0" }),
    },
    storage: {
      local: {
        get: (k, cb) => { if (typeof k === "function") k({}); else if (cb) cb({}); return Promise.resolve({}); },
        set: (v, cb) => { if (cb) cb(); return Promise.resolve(); },
        remove: (k, cb) => { if (cb) cb(); return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: noop },
      onChanged: listener,
    },
    tabs: { query: (q, cb) => { if (cb) cb([]); }, sendMessage: noop, create: noop,
            onUpdated: listener, onRemoved: listener },
    alarms: { create: noop, clear: noop, onAlarm: listener },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
  };
}

function domElement() {
  return {
    innerHTML: "", textContent: "", value: "", href: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, removeAttribute() {}, focus() {}, click() {},
  };
}

out("--- the service worker: background.js and its importScripts ---");
{
  const logs = [];
  const ctx = baseGlobals(logs);
  ctx.chrome = chromeStub();
  ctx.crypto = {
    subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) },
    getRandomValues: (a) => a,
  };
  ctx.location = { href: "chrome-extension://test/background.js" };
  ctx.self = ctx;
  ctx.globalThis = ctx;

  const imported = [];
  ctx.importScripts = (...files) => {
    for (const f of files) {
      imported.push(f);
      const p = EXT + f;
      if (!fs.existsSync(p)) throw new Error("importScripts missing file: " + f);
      vm.runInContext(down(fs.readFileSync(p, "utf8")), ctx, { filename: f });
    }
  };
  vm.createContext(ctx);

  let err = null;
  try {
    vm.runInContext(down(fs.readFileSync(EXT + "background.js", "utf8")), ctx, { filename: "background.js" });
  } catch (e) { err = e && e.message; }

  check("background.js loads", !err, err);
  check("importScripts ran", imported.length >= 1, imported.join(", "));
  check("VenueTiers defined after load", !!ctx.VenueTiers, typeof ctx.VenueTiers);
  check("tierFor is callable", !!(ctx.VenueTiers && typeof ctx.VenueTiers.tierFor === "function"));
  check("nothing logged to console.error", !logs.some((l) => l.indexOf("ERR ") === 0),
    logs.find((l) => l.indexOf("ERR ") === 0));
}

out("");
out("--- the popup: its scripts, in the order popup.html declares them ---");
{
  const logs = [];
  const ctx = baseGlobals(logs);
  ctx.chrome = chromeStub();
  ctx.document = {
    getElementById: () => domElement(), querySelector: () => domElement(),
    querySelectorAll: () => [], createElement: () => domElement(),
    addEventListener: () => {}, body: domElement(), title: "", readyState: "complete",
  };
  ctx.window = {
    location: { href: "chrome-extension://test/popup.html", search: "" },
    addEventListener: () => {}, close: () => {}, open: () => {},
  };
  ctx.navigator = { clipboard: { writeText: () => Promise.resolve() }, userAgent: "test" };
  ctx.Blob = function Blob() {};
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.URL.createObjectURL = () => "blob:test";
  ctx.URL.revokeObjectURL = () => {};

  const html = fs.readFileSync(EXT + "popup.html", "utf8");
  const scripts = [];
  for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1])) scripts.push(m[1]);
  }
  check("popup declares scripts", scripts.length > 0, scripts.join(" -> "));

  let failedAt = null, err = null;
  for (const f of scripts) {
    if (!fs.existsSync(EXT + f)) { failedAt = f; err = "file missing"; break; }
    try {
      vm.runInContext(down(fs.readFileSync(EXT + f, "utf8")), ctx, { filename: f });
    } catch (e) { failedAt = f; err = e && e.message; break; }
  }
  check("all popup scripts load in order", !failedAt, failedAt ? failedAt + ": " + err : "");
  check("VenueTiers available to the popup", !!ctx.VenueTiers);
}

out("");
out("--- the content script ---");
{
  const logs = [];
  const ctx = baseGlobals(logs);
  ctx.chrome = chromeStub();
  ctx.window = {
    location: { href: "https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF",
                pathname: "/event/Z7r9jZ1A7qIaF", search: "", hostname: "www.ticketmaster.com" },
    addEventListener: () => {}, postMessage: () => {},
  };
  ctx.location = ctx.window.location;
  ctx.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
  ctx.history = { replaceState: () => {} };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  let err = null;
  try {
    vm.runInContext(down(fs.readFileSync(EXT + "content.js", "utf8")), ctx, { filename: "content.js" });
  } catch (e) { err = e && e.message; }
  check("content.js loads", !err, err);
}

out("");
out("--- each MAIN-world adapter, on its own site ---");
{
  const ADAPTERS = [
    ["event-info.js", "https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"],
    ["ticketmaster-adapter.js", "https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"],
    ["seatgeek-adapter.js", "https://seatgeek.com/chiefs/nfl/18014270"],
    ["stubhub-adapter.js", "https://www.stubhub.com/chiefs/event/158234567/"],
    ["evenue-adapter.js", "https://kuathletics.evenue.net/event/F26/02"],
    ["tickpick-adapter.js", "https://www.tickpick.com/buy-chiefs/6789012/"],
    ["axs-adapter.js", "https://www.axs.com/events/123456/chiefs"],
  ];
  for (const pair of ADAPTERS) {
    const file = pair[0], href = pair[1];
    if (!fs.existsSync(EXT + file)) { check(file + " exists", false); continue; }
    const logs = [];
    const u = new URL(href);
    const ctx = baseGlobals(logs);
    ctx.window = {
      location: { href, hostname: u.hostname, pathname: u.pathname, search: u.search },
      addEventListener: () => {}, postMessage: () => {},
    };
    ctx.document = { cookie: "", title: "", querySelector: () => null, querySelectorAll: () => [] };
    ctx.localStorage = { getItem: () => null, setItem: () => {} };
    ctx.navigator = { userAgent: "test" };
    ctx.self = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    let err = null;
    try {
      vm.runInContext(down(fs.readFileSync(EXT + file, "utf8")), ctx, { filename: file });
    } catch (e) { err = e && e.message; }
    check(file + " loads", !err, err);
  }
}

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
