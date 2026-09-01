// Payloads keyed by id rather than arrays of records.
//
// ISM ships sectionData (550kB) and the venues list this way. The probe only
// walked arrays, so both reported "no arrays with sampleable elements" and
// their contents stayed invisible — sectionData is the likely home of the
// per-seat availability the site's map clearly has.
const logged = [];
const setupProbe = require("./probe-env");
const probe = setupProbe(logged).probeResponse;
const MIN = global.PROBE_MIN_CHARS;
global.DISCOVERY_SITE = "AM";
const out = require("console").log;
let fail = 0;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };
const pad = (o, n) => { const s = JSON.stringify(o); return s.slice(0, -1) + ',"_pad":"' + "x".repeat(n || MIN) + '"}'; };

out("--- a keyed map is described, not dismissed ---");
logged.length = 0;
// Shaped like sectionData: data keyed by section, each with per-seat entries.
const sectionData = { data: {
  "101": { name: "101", seats: { GEYDC: { r: "7", s: "18", st: "A" }, GEYDD: { r: "7", s: "19", st: "A" } } },
  "102": { name: "102", seats: { GEYDE: { r: "3", s: "1", st: "H" } } },
  "121": { name: "121", seats: { GEZTA: { r: "7", s: "18", st: "A" } } },
}, errorCode: 200 };
probe("https://ism-prod-api.ticketmaster.com/v810/sectionData/applicationType/buy", pad(sectionData));
check("no longer says there is nothing", !logged.some((l) => /no arrays with sampleable elements/.test(l)));
check("reports keyed maps", logged.some((l) => /keyed map\(s\), largest first/.test(l)), logged.find((l) => /keyed map/.test(l)));
check("names the map path and key count", logged.some((l) => /\d+ keys @ data/.test(l)), logged.find((l) => /keys @/.test(l)));
check("emits a sample entry", logged.some((l) => /SAMPLE data\["101"\]/.test(l)), logged.find((l) => /SAMPLE/.test(l)));
const m = logged.filter((l) => /m\[\d+\]:/.test(l));
check("sample body printed", m.length >= 1, m.length + " chunk(s)");
check("per-seat detail visible", m.join("").includes('"s":"18"'), (m[0] || "").slice(0, 110));
check("chunks bounded", m.every((l) => l.length < 560));

out("--- the venues payload is now readable too ---");
logged.length = 0;
const venues = {};
for (let i = 1; i <= 19; i++) venues[String(i)] = { name: "Venue " + i, city: "Columbia" };
probe("https://am.ticketmaster.com/mizzou/api/admin/v2/venues", pad(venues));
check("map reported", logged.some((l) => /keyed map/.test(l)));
// 20, not 19: the padding key used to clear the size floor counts too.
check("all venue keys counted", logged.some((l) => /20 keys @ \(root\)/.test(l)),
  logged.find((l) => /keys @/.test(l)));
check("field names revealed", logged.join("").includes('"name":"Venue 1"'));

out("--- a map of tilde STRINGS is described (the sectionData shape) ---");
// ISM keys delimited rows by id. Requiring object VALUES meant sectionData
// (648kB) reported "nothing to sample" three runs running.
//
// Fixtures here are sized naturally rather than via pad(): the padding key is
// itself a long string, and it outranked the real data being tested.
logged.length = 0;
const sectionRows = {};
for (let i = 100; i < 160; i++) {
  sectionRows[String(i)] = i + "~7~18~A~GEZTAORRHIYQ~19~A~GEZTAORRHIZA~20~H~GEZTAORRHIZQ";
}
probe("https://ism-prod-api.ticketmaster.com/v810/sectionData/stringform",
  JSON.stringify({ data: sectionRows, errorCode: 200 }));
check("map reported", logged.some((l) => /keyed map/.test(l)), logged.find((l) => /keyed map/.test(l)));
check("all keys counted", logged.some((l) => /60 keys @ data/.test(l)), logged.find((l) => /keys @ data/.test(l)));
const sm = logged.filter((l) => /m\[\d+\]:/.test(l));
check("string value printed unquoted", sm.some((l) => /100~7~18~A~GEZTAORRHIYQ/.test(l)), (sm[0] || "").slice(0, 90));
check("more than one entry sampled", logged.filter((l) => /SAMPLE data\[/.test(l)).length >= 2);

out("--- a payload that is ONE long string still gets read ---");
logged.length = 0;
probe("https://ism-prod-api.ticketmaster.com/v810/blob",
  JSON.stringify({ data: "A~" + "1~2~3~".repeat(400), errorCode: 200 }));
check("long string reported", logged.some((l) => /long string @ data \(\d+ chars\)/.test(l)),
  logged.find((l) => /long string/.test(l)));
const ts = logged.filter((l) => /t\[\d+\]:/.test(l));
check("contents shown", ts.length >= 1 && /1~2~3~/.test(ts[0]), (ts[0] || "").slice(0, 80));

out("--- arrays still take precedence ---");
logged.length = 0;
probe("https://x.test/haslists", pad({ listings: [{ section: "1", row: "2", price: 3 }, { section: "1", row: "4", price: 5 }] }));
check("array dumped", logged.some((l) => /CANDIDATE listings/.test(l)));
check("not reported as a map", !logged.some((l) => /keyed map/.test(l)));

out("--- a payload with neither says so ---");
logged.length = 0;
// Sized by key COUNT, not padding: pad() appends a long string, which the
// long-string fallback would legitimately report.
const flat = {};
for (let i = 0; i < 400; i++) flat["k" + i] = i;
probe("https://x.test/flat", JSON.stringify(flat));
check("says nothing to sample",
  logged.some((l) => /no arrays, keyed maps or long strings to sample/.test(l)),
  logged[logged.length - 1]);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
