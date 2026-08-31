// Shared harness: load injected.js's probe into globals so tests can call it.
// Kept in one place because the probe's internals move as discovery evolves.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");

module.exports = function setupProbe(logged) {
  const inj = fs.readFileSync(
    EXT + "injected.js", "utf8");

  global.PROBE_MIN_CHARS = Number(inj.match(/PROBE_MIN_CHARS = (\d+)/)[1]);
  global.PROBE_SKIP = eval(inj.match(/const PROBE_SKIP = (\/.*?\/i);/)[1]);
  global.DISCOVERY_SITE = "SH";
  global.toAbsoluteUrl = (u) => String(u);
  global.setTimeout = (fn) => { global.__timer = fn; return 1; };
  global.probeBest = new Map();
  global.probeStats = { seen: 0, small: 0, skipped: 0, nonJson: 0, dup: 0, reported: 0, errors: 0, htmlReported: 0 };
  global.probeSummaryTimer = null;
  global.console = { log: (m) => logged.push(String(m)) };

  global.dumpShape = eval("(" + extractFn(inj, "dumpShape") + ")");
  global.probeSummary = eval("(" + extractFn(inj, "probeSummary") + ")");
  global.probeResponseInner = eval("(" + extractFn(inj, "probeResponseInner") + ")");
  const probeResponse = eval("(" + extractFn(inj, "probeResponse") + ")");

  return { inj, probeResponse, MIN: global.PROBE_MIN_CHARS, stats: global.probeStats };
};
