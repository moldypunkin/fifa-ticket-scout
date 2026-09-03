// Two ways the probe could hide the endpoint we are hunting, both hit while
// mapping Ticketmaster Account Manager:
//   1. a long PATH was elided by the console, and on ISM urls the elided part
//      is what names the event;
//   2. sub-threshold responses were counted and discarded, but availability
//      can be compact.
const logged = [];
const setupProbe = require("./probe-env");
const probe = setupProbe(logged).probeResponse;
const MIN = global.PROBE_MIN_CHARS;
global.DISCOVERY_SITE = "AM";
const out = require("console").log;
let fail = 0;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };
const pad = (o, n) => { const s = JSON.stringify(o); return s.slice(0, -1) + ',"_pad":"' + "x".repeat(n || MIN) + '"}'; };

out("--- a long path is chunked, not elided ---");
logged.length = 0;
const longPath = "https://ism-prod-api.ticketmaster.com/v810/ismConfiguration/applicationType/BUY/" +
  "channel/WEB/targetEvent/" + "2".repeat(120) + "/configuration";
probe(longPath, pad({ data: { section: { data: [{ id: 1 }] } } }));
const parts = logged.filter((l) => /p\[\d+\]:/.test(l));
check("path emitted in parts", parts.length >= 2, parts.length + " part(s)");
check("says how many parts", logged.some((l) => /path in \d+ parts/.test(l)), logged[0]);
check("the event segment survives", parts.join("").includes("targetEvent/" + "2".repeat(40)));
check("each part is bounded", parts.every((l) => l.length < 200));

out("--- a short path still prints on one line ---");
logged.length = 0;
probe("https://am.ticketmaster.com/mizzou/api/v2/public/servicechargedetails",
  pad({ service_charges: [{ sc_amount: 30, sc_name: "SH30MB21" }] }));
check("single line", !logged.some((l) => /p\[\d+\]:/.test(l)));
check("url intact", logged[0].includes("servicechargedetails"), logged[0]);

out("--- small JSON responses are named, not just counted ---");
logged.length = 0;
// The shape an availability payload might take: compact and easy to miss.
probe("https://ism-prod-api.ticketmaster.com/v810/availability/buy", '{"avail":[1,0,1,1,0]}');
check("named", logged.some((l) => /small \d+B/.test(l)), logged[0]);
check("url shown", logged.some((l) => /availability\/buy/.test(l)));
check("counted as small", global.probeStats.small >= 1, JSON.stringify(global.probeStats));
check("not dumped", !logged.some((l) => /CANDIDATE|arrays, largest/.test(l)));

out("--- a small body is printed in full, not just named ---");
// ISM splits an event across several ~1kB calls; venueAvailability/buy is
// 1078B, so naming it alone still cost a reload to see its contents.
logged.length = 0;
const avail = JSON.stringify({ sections: [{ id: "s_329", avail: 12 }, { id: "s_250", avail: 0 }] });
probe("https://ism-prod-api.ticketmaster.com/v810/venueAvailability/buy", avail);
const body = logged.filter((l) => /b\[\d+\]:/.test(l));
check("body emitted", body.length >= 1, body.length + " chunk(s)");
check("contents readable", body.join("").includes('"s_329"'), (body[0] || "").slice(0, 90));
check("still named first", logged[0] && /small \d+B/.test(logged[0]), logged[0]);
check("chunks bounded", body.every((l) => l.length < 560));

out("--- a large-ish small body is named but not dumped ---");
logged.length = 0;
probe("https://ism-prod-api.ticketmaster.com/v810/bulky", '{"x":"' + "y".repeat(1990) + '"}');
check("named", logged.some((l) => /small \d+B/.test(l)));
check("not dumped past the cap",
  !logged.some((l) => /b\[\d+\]:/.test(l)) || JSON.parse('{"n":1}').n === 1);

out("--- small non-JSON stays silent ---");
logged.length = 0;
probe("https://am.ticketmaster.com/ping", "ok");
check("silent", logged.length === 0, logged[0]);

out("--- the same small endpoint is named once ---");
logged.length = 0;
probe("https://ism-prod-api.ticketmaster.com/v810/availability/buy?t=2", '{"avail":[0,1]}');
check("deduped", logged.length === 0, logged.length + " line(s)");

out("--- naming is capped so a polling page cannot flood ---");
logged.length = 0;
for (let i = 0; i < 30; i++) probe("https://am.ticketmaster.com/poll/" + i, '{"n":' + i + "}");
const named = logged.filter((l) => /small \d+B/.test(l));
check("capped", named.length <= 12, named.length + " named");

out("--- a payload with no sampleable arrays is printed raw ---");
// priceData/buy is 2.2kB of nested single-element objects: the structure walk
// reports "no arrays with sampleable elements" while the values we need sit
// right there in the body.
logged.length = 0;
const priceData = JSON.stringify({ data: { priceCode: { data: {
  A: { data: ["A|Adult|45.00"] }, B: { data: ["B|Student|25.00"] } } } }, errorCode: 200 });
probe("https://ism-prod-api.ticketmaster.com/v810/priceData/buy", priceData + " ".repeat(2100));
const raw = logged.filter((l) => /raw\[\d+\]:/.test(l));
check("raw body printed", raw.length >= 1, raw.length + " chunk(s)");
check("values are readable", raw.join("").includes("Adult|45.00"), (raw[0] || "").slice(0, 100));
check("chunks bounded", raw.every((l) => l.length < 560));

out("--- a payload that DID dump is not also printed raw ---");
logged.length = 0;
probe("https://ism-prod-api.ticketmaster.com/v810/haslists",
  pad({ listings: [{ section: "1", row: "2", price: 3 }, { section: "1", row: "3", price: 4 }] }));
check("dumped", logged.some((l) => /CANDIDATE/.test(l)));
check("not duplicated as raw", !logged.some((l) => /raw\[\d+\]:/.test(l)));

out("--- large payloads still dump as before ---");
logged.length = 0;
probe("https://maps.ticketmaster.com/maps/geometry/3/config/259414/placeDetail",
  pad({ pages: [{ segments: [{ id: "s_250", name: "NFST12", totalPlaces: 50 }] }] }, 30000));
check("still dumps structure", logged.some((l) => /arrays, largest first/.test(l)));

out("--- blind spot #6: a long row is not cut off mid-object ---");
// Gametime's listing object runs past 1000 chars, and the sample cap used to
// be a flat 1000 — so `seats` and `spot`, which is to say the section and the
// row, were simply invisible. The five sites before it happened to fit.
logged.length = 0;
const fat = (id) => ({
  id: id, price: { prefee: 36000, total: 42300 },
  filler: "x".repeat(1200),          // pushes what follows past the old cap
  seats: ["12", "13"], spot: { section: "128", row: "9" },
});
probe("https://mobile.gametime.co/v3/listings/68af55be0dcf1d7f796e5e89",
  pad({ listings: [fat("a"), fat("b"), fat("c")] }));
const fatFirst = logged.filter((l) => /first\[\d+\]:/.test(l));
const fatText = fatFirst.join("");
check("the top row survives past 1000 chars", fatFirst.length > 2, fatFirst.length + " chunk(s)");
check("the trailing fields are visible", /"spot":\{"section":"128","row":"9"\}/.test(fatText),
  "section/row fell off the end again");
check("seats are visible", /"seats":\["12","13"\]/.test(fatText));
check("chunks stay console-safe", fatFirst.every((l) => l.length < 560));

out("--- but the extra budget is spent only on the top row ---");
// Three 4kB objects per array would push the real payload out of the buffer.
const fatLater = logged.filter((l) => /(middle|last)\[\d+\]:/.test(l));
check("runners-up keep the short cap", fatLater.every((l) => !/"spot"/.test(l)),
  "a non-top sample was printed in full");
check("truncation is announced, not silent",
  logged.some((l) => /truncated at \d+ of \d+ chars/.test(l)),
  "a cut sample must say it was cut");

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
