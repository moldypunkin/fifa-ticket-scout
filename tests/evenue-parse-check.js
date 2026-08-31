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

out("\n--- wiring ---");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
eq("captures the seat-availability path", /"\/pac-api\/"/.test(inj), true);
eq("discovery not armed for evenue", /DISCOVERY_SITE = isEvenue/.test(inj), false);
eq("event info wired", /isEvenue \? window\.__evenueAdapter/.test(inj), true);
eq("background dispatches", /saveEvenueSeats\(eventId, body, tabId, site, eventInfo\)/.test(src), true);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
