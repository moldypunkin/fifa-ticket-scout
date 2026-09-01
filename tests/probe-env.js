// Shared harness: load injected.js's probe into globals so tests can call it.
// Kept in one place because the probe's internals move as discovery evolves.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");

module.exports = function setupProbe(logged) {
  const inj = fs.readFileSync(
    EXT + "injected.js", "utf8");

  // EVERY uppercase numeric const from injected.js, not an allow-list. Naming
  // the prefixes meant PROBE_/SMALL_ were lifted but RAW_BODY_MAX was not, and
  // a `length <= undefined` guard silently never fired — the third time that
  // exact drift cost a debugging round.
  for (const m of inj.matchAll(/const ([A-Z][A-Z0-9_]*) = (\d+);/g)) {
    global[m[1]] = Number(m[2]);
  }
  global.PROBE_SKIP = eval(inj.match(/const PROBE_SKIP = (\/.*?\/i);/)[1]);
  global.DISCOVERY_SITE = "SH";
  global.toAbsoluteUrl = (u) => String(u);
  global.setTimeout = (fn) => { global.__timer = fn; return 1; };
  global.probeBest = new Map();
  // Parsed from injected.js rather than duplicated: a counter added there
  // but missing here reads as undefined, and a `counter < N` guard then
  // silently never fires — which looked like the feature was broken.
  global.probeStats = eval("(" + inj.match(/const probeStats = (\{[^}]*\})/)[1] + ")");
  global.probeSummaryTimer = null;
  global.console = { log: (m) => logged.push(String(m)) };

  // EVERY function injected.js declares inside its IIFE, lifted into globals.
  //
  // These used to be enumerated one at a time, and each new helper the probe
  // grew (dumpMaps, probeResponseInner, probeSummary) failed as "not defined"
  // until someone added it here. Extracting them all removes the step.
  const declared = [];
  for (const m of inj.matchAll(/^  (?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)) {
    declared.push(m[1]);
  }
  for (const name of declared) {
    try {
      global[name] = eval("(" + extractFn(inj, name) + ")");
    } catch (e) {
      // A function this harness cannot lift is only a problem if a test needs
      // it; failing silently here keeps unrelated suites runnable.
    }
  }

  const probeResponse = eval("(" + extractFn(inj, "probeResponse") + ")");

  return { inj, probeResponse, MIN: global.PROBE_MIN_CHARS, stats: global.probeStats };
};
