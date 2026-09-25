// Parse the REAL Evenue rows captured from kuathletics event F26:02.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(EXT + "background.js", "utf8");
const colIndex = eval("(" + extractFn(src, "evenueColumnIndex", "") + ")");
const split = eval("(" + extractFn(src, "evenueSplitPayload", "") + ")");

// Exactly as the probe printed them.
const HEADERS = ["LEVELSECTIONCD","ROWCD","SEATCD","PRICELEVELCD","SEATSTATUS","MARKER_ID","SEAT_MARKER_ACTIVE","SLP_PRICE","AVAILABLE","HIDDEN"];
const ROWS = [
  ["KU:101","10","1","4","%",null,null,32039,0,0],
  ["KU:101","10","10","4","O",null,null,32039,1,0],
  ["KU:101","10","11","4","O",null,null,32039,1,0],
];

let fail = 0;
const out = require("console").log;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; out(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else out(`ok   ${l}`);
};

out("--- payload split (rows vs header row) ---");
let s = split([ROWS, HEADERS]);
eq("finds rows", s.rows.length, 3);
eq("finds headers", s.headers, HEADERS);
// Order must not matter — the header row is identified by content.
s = split([HEADERS, ROWS]);
eq("header first still works", s.headers, HEADERS);
eq("rows still found", s.rows.length, 3);
eq("garbage payload", split("nope"), { rows: null, headers: null });
eq("missing header row", split([ROWS]).headers, null);

out("\n--- column mapping is by NAME ---");
const idx = colIndex(HEADERS);
eq("LEVELSECTIONCD", idx.LEVELSECTIONCD, 0);
eq("SLP_PRICE", idx.SLP_PRICE, 7);
eq("AVAILABLE", idx.AVAILABLE, 8);
eq("HIDDEN", idx.HIDDEN, 9);
// Reordering upstream must move the mapping with it, not corrupt prices.
const reordered = ["SLP_PRICE","LEVELSECTIONCD","ROWCD","SEATCD","AVAILABLE"];
eq("reordered header remaps", colIndex(reordered).SLP_PRICE, 0);
eq("case/whitespace tolerated", colIndex([" slp_price "]).SLP_PRICE, 0);

out("\n--- row -> seat (mirrors saveEvenueSeats) ---");
function expand(rows, headers) {
  const i = colIndex(headers);
  const seats = {};
  let unavailable = 0, missingPrice = 0;
  for (const row of rows) {
    if (Number(row[i.AVAILABLE]) !== 1) { unavailable++; continue; }
    if (i.HIDDEN !== undefined && Number(row[i.HIDDEN]) === 1) { unavailable++; continue; }
    const cents = Number(row[i.SLP_PRICE]);
    if (!isFinite(cents) || cents <= 0) { missingPrice++; continue; }
    const price = Math.round((cents / 100) * 1000);
    const raw = String(row[i.LEVELSECTIONCD] || "");
    const block = raw.includes(":") ? raw.split(":").pop() : raw;
    const rowCd = String(row[i.ROWCD] || "");
    const seatCd = String(row[i.SEATCD] || "");
    seats[`${block}-${rowCd}-${seatCd}`] = { block, row: rowCd, seat: seatCd, price };
  }
  return { seats, unavailable, missingPrice };
}
const r = expand(ROWS, HEADERS);
eq("only AVAILABLE=1 rows kept", Object.keys(r.seats).length, 2);
eq("unavailable counted", r.unavailable, 1);
eq("seat 1 (AVAILABLE=0) excluded", r.seats["101-10-1"], undefined);
eq("seat 10 parsed", r.seats["101-10-10"], { block: "101", row: "10", seat: "10", price: 320390 });
eq("section prefix stripped", r.seats["101-10-10"].block, "101");
eq("$320.39 renders", 320390 / 1000, 320.39);

out("\n--- guards ---");
eq("HIDDEN=1 excluded", expand([["KU:101","5","1","4","O",null,null,1000,1,1]], HEADERS).unavailable, 1);
eq("zero price excluded", expand([["KU:101","5","1","4","O",null,null,0,1,0]], HEADERS).missingPrice, 1);
eq("null price excluded", expand([["KU:101","5","1","4","O",null,null,null,1,0]], HEADERS).missingPrice, 1);
eq("section with no prefix", expand([["101","5","1","4","O",null,null,1000,1,0]], HEADERS).seats["101-5-1"].block, "101");
const strs = expand([["KU:101",10,1,"4","O",null,null,1000,1,0]], HEADERS).seats["101-10-1"];
eq("numeric row coerced to string", typeof strs.row, "string");
eq("numeric seat coerced to string", typeof strs.seat, "string");

out("\n--- a sold row's price is not an available seat's price ---");
// Nebraska F26:06: sold level-1 seats carry SLP_PRICE 22000 ($220) while the
// site quotes $102 for an available level-1 seat (NS:34 row 48), so the sold
// row prices a different product - a season or plan seat. Copying it across
// price levels would put a wrong price in front of a buyer.
eq("no price is derived from other rows", /evenueDeriveLevelPrices/.test(src), false);
eq("an available row with no price is dropped, not guessed",
  expand([["NS:33","55","21","1","u",null,null,null,1,0]], HEADERS).missingPrice, 1);
eq("and stores no seat", Object.keys(
  expand([["NS:33","55","21","1","u",null,null,null,1,0]], HEADERS).seats).length, 0);
// The hunt for the real single-game price.
eq("price candidates are logged", /function evenueLogPriceCandidates/.test(src), true);
eq("json-in-a-string is walked", /JSON\.parse\(t\)/.test(src), true);

out("\n--- server-rendered price data (Nebraska) ---");
// Nebraska renders discovery_eventDetailMPT into the page instead of fetching
// it, so no network capture can see it: MIN_PRICE=10200 sat in __NEXT_DATA__
// while every /pac-api/ response was priceless. injected.js posts that object
// to the worker as if it had arrived on /pac-api/, and the existing
// evenueFindEventDetails() recognises it by content.
const injSrc = fs.readFileSync(EXT + "injected.js", "utf8");
eq("the page's ssrData is posted",
  /postInventory\([^)]*\/pac-api\/ssr\/__NEXT_DATA__[^)]*, ssr\)/.test(injSrc), true);
eq("read from the Next.js props path",
  /\["props", "pageProps", "component", "props", "ssrData"\]/.test(injSrc), true);
// The url must reach the evenue branch in the worker, which keys off /pac-api/.
eq("the synthetic url routes to evenue", "/pac-api/ssr/__NEXT_DATA__".indexOf("/pac-api/"), 0);
const findDetails = eval("(" + extractFn(src, "evenueFindEventDetails") + ")");
const SSR = { discovery_eventDetailMPT: [
  { SEASONCD: "F26", ITEMCD: "06", PRICE: 0, MIN_PRICE: 10200, MAX_PRICE: 10500 }] };
eq("the event detail is found in the ssr blob", findDetails(SSR).length, 1);
const idFromDetail = eval("(" + extractFn(src, "evenueEventIdFromDetail") + ")");
eq("and yields the page's event id", idFromDetail(findDetails(SSR)[0]), "F26:06");
// When it carries no level table, the worker names its fields rather than
// guessing a price from the range.
eq("unusable price payloads report their fields",
  /the detail object [\s\S]{0,40}holds/.test(src), true);
eq("hunt-by-value is off in a release", /const EVENUE_HUNT_VALUES = \[\];/.test(src), true);

out("\n--- each event's own fee table (TIERED_FEES) ---");
// Colorado F26:F02 publishes {} and charges nothing; Nebraska F26:06 publishes
// 7%. The provisional flat $5 was measured at one school and is wrong for both,
// so the event's table wins and the constant is only the fallback.
const feeRule = eval("(" + extractFn(src, "evenueFeeRule") + ")");
const NEBRASKA = { roundingAmount: 100, tiers: { "0-Infinity": { feeAmount: 0,
  feePercentages: [7], facFeeAmt: 0, facFeePct: 0, ticketFeeAmt: 0, ticketFeePct: 7 } } };
eq("Nebraska: 7%, no flat", JSON.stringify(feeRule(NEBRASKA)), '{"pct":7,"flat":0,"tiers":1}');
eq("Colorado: an empty table means no fee", JSON.stringify(feeRule("{}")),
  '{"pct":0,"flat":0,"tiers":0}');
eq("a table arriving as text is parsed", feeRule(JSON.stringify(NEBRASKA)).pct, 7);
// feePercentages/feeAmount repeat the ticket+facility figures; counting both
// would double the fee.
eq("the total fields are not added again", feeRule(NEBRASKA).pct, 7);
eq("ticket and facility parts are summed",
  JSON.stringify(feeRule({ tiers: { "0-Infinity": { ticketFeeAmt: 250, facFeeAmt: 100,
    ticketFeePct: 5, facFeePct: 2 } } })), '{"pct":7,"flat":3.5,"tiers":1}');
eq("amounts are cents", feeRule({ tiers: { t: { ticketFeeAmt: 250 } } }).flat, 2.5);
eq("junk yields no rule, so the fallback stands", feeRule("not json"), null);
eq("no table yields no rule", feeRule(null), null);

// The popup applies it: base x (1 + pct) + flat, ahead of FEE_FLAT_BY_SITE.
const popupSrc = fs.readFileSync(EXT + "popup.js", "utf8");
eq("the popup prefers the event's fee rule",
  /if \(currentFees\) return base \* \(1 \+ \(currentFees\.pct \|\| 0\) \/ 100\) \+ \(currentFees\.flat \|\| 0\);/.test(popupSrc), true);
eq("and reads it off the active game", /currentFees = game\.fees/.test(popupSrc), true);
eq("the flat $5 stays as the fallback", /evenue: 5\.00/.test(popupSrc), true);
// A fee table that arrives before the seats must still reach the game.
eq("a held rule is attached when seats land", /evenuePendingFees\.get\(tabId\)/.test(src), true);

out("\n--- event identity from the detail object (Colorado) ---");
// cubuffs.evenue.net publishes only "TT (FB)" and no date on the page itself;
// the detail object carries the real name, date and venue. Field names taken
// from the live F26:F02 key list.
const detailIdentity = eval("(" + extractFn(src, "evenueDetailIdentity") + ")");
global.isoToDisplayDate = eval("(" + extractFn(src, "isoToDisplayDate").replace(/\?\?/g, "||") + ")");
global.bgLog = () => {};
global.evenueDetailKeysLogged = new Set();
// Exactly as the live F26:F02 payload prints them.
const CU = { ITEMCD: "F02", SEASONCD: "F26", ITEMNAME: "TT (FB)", SSEVENTNAME: "Texas Tech",
  EVENTNAME: "Texas Tech (FB)", SEASON_NAME: "2026 Football",
  EVENTDT: "2026-10-03T19:30:00", EVENTDTFAC: "2026-10-03T17:30:00",
  FAC_TITLE: "Folsom Field", FAC_SSTITLE: "Folsom Field", ITEM_FEES: null };
const cu = detailIdentity(CU, "F26:F02", "University of Colorado");
// The payload names only the visitor; the host comes from the page <title>,
// "Texas Tech | University of Colorado".
eq("host and opponent are joined", cu.name, "University of Colorado vs Texas Tech");
eq("the clean opponent wins over the sport code", detailIdentity(CU, "x", null).name, "Texas Tech");
eq("no host leaves the name alone", detailIdentity(CU, "y", null).name.indexOf(" vs "), -1);
eq("a name already naming the host is left alone",
  detailIdentity({ SSEVENTNAME: "Colorado vs Texas Tech" }, "z", "Colorado").name,
  "Colorado vs Texas Tech");
const adapterSrc = fs.readFileSync(EXT + "evenue-adapter.js", "utf8");
eq("the adapter reads the host off the title", /function getEvenueHostName/.test(adapterSrc), true);
eq("and ships it with the event info", /info\.host = getEvenueHostName\(\)/.test(adapterSrc), true);
// EVENTDTFAC is the facility's clock, which is what the ticket shows.
eq("date comes from EVENTDTFAC", cu.date, "03-10-2026 - 17:30");
eq("venue comes from FAC_TITLE", cu.venue, "Folsom Field");
eq("the internal code is not the name", cu.name === CU.ITEMNAME, false);
eq("no detail is not a crash", JSON.stringify(detailIdentity(null, "x", "Colorado")), "{}");
// A page name that is a real event name must not be replaced by the payload.
eq("the code test spots an internal code", /const isCode = /.test(src), true);
eq("a stored name is kept unless it is a code",
  /isCode\(pageName\) && ident\.name/.test(src), true);

out("\n--- wiring ---");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
eq("captures the seat-availability path", /"\/pac-api\/"/.test(inj), true);
eq("discovery not armed for evenue", /DISCOVERY_SITE = isEvenue/.test(inj), false);
eq("event info wired", /isEvenue \? window\.__evenueAdapter/.test(inj), true);
eq("background dispatches", /saveEvenueSeats\(eventId, body, tabId, site, eventInfo\)/.test(src), true);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
