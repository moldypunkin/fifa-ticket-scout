// Output-format guarantees of the discovery probe. Rescued from probe-check.js
// and shape-dump-check.js, which tested the removed SeatGeek-era functions
// (SG_PROBE_*, dumpListingsShape) but held three assertions nothing else made.
const logged = [];
const setupProbe = require("./probe-env");
const probe = setupProbe(logged).probeResponse;
const MIN = global.PROBE_MIN_CHARS;
global.DISCOVERY_SITE = "TP";
const out = require("console").log;
let fail = 0;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };
const pad = (o, n) => { const s = JSON.stringify(o); return s.slice(0, -1) + ',"_pad":"' + "x".repeat(n || MIN) + '"}'; };

out("--- size and url are reported together ---");
logged.length = 0;
probe("https://api.example.test/1.0/listings/event/42", pad({ listings: [{ section: "1", price: 2 }] }));
const head = logged[0] || "";
check("first line has the tag", /^\[TP-PROBE\]/.test(head), head);
check("first line has a kB size", /\d+\.\dkB/.test(head), head);
check("first line has the url path", /api\.example\.test\/1\.0\/listings\/event\/42/.test(head), head);
check("second line lists top-level keys", /keys: .*listings/.test(logged[1] || ""), logged[1]);

out("--- every emitted line carries the tag, for the log relay ---");
// injected.js only forwards console lines whose prefix is in LOG_PREFIXES, so
// an untagged line never reaches Download logs.
check("all tagged", logged.every((l) => l.startsWith("[TP-PROBE]")),
  logged.find((l) => !l.startsWith("[TP-PROBE]")));

out("--- an array-rooted payload is handled ---");
logged.length = 0;
const rooted = JSON.stringify([{ section: "1", row: "2", price: 3 }, { section: "1", row: "3", price: 4 }]);
probe("https://api.example.test/array-root", rooted + " ".repeat(MIN));
check("reported", logged.length > 0, logged.length + " lines");
check("described as an array", /array\[\d+\] of/.test(logged[1] || ""), logged[1]);
check("did not throw", !logged.some((l) => /ERROR/.test(l)));

out("--- a query string is chunked, not elided ---");
logged.length = 0;
const long = "a=" + "1".repeat(400) + "&b=2";
probe("https://api.example.test/q?" + long, pad({ listings: [{ price: 1, section: "1" }] }));
const qLines = logged.filter((l) => /q\[\d+\]:/.test(l));
check("query emitted in chunks", qLines.length >= 2, qLines.length + " chunk(s)");
check("chunks bounded", qLines.every((l) => l.length < 220));

out("--- malformed and empty payloads ---");
logged.length = 0;
probe("https://api.example.test/bad", "{ not json at all" + "x".repeat(MIN));
check("unparsed body does not throw", !logged.some((l) => /ERROR/.test(l)));
logged.length = 0;
probe("https://api.example.test/empty", pad({ a: 1 }));
check("payload with no arrays handled", logged.length > 0 && !logged.some((l) => /ERROR/.test(l)));

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
