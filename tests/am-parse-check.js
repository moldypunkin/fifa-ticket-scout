// Parse the REAL Account Manager payloads captured from Mizzou event 7524
// (host id 060064A9DD13378D).
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");

const down = (s) => s.replace(/(\w+)\?\./g, "($1 || {}).").replace(/ \?\? /g, " || ");
const parseDelimited = eval("(" + down(extractFn(bg, "amParseDelimited", "")) + ")");
global.amParseDelimited = parseDelimited;
const priceMapOf = eval("(" + down(extractFn(bg, "amPriceMap", "")) + ")");
const sectionPrice = eval("(" + down(extractFn(bg, "amSectionPrice", "")) + ")");

// The header is verbatim from venueAvailability/buy. The ROWS are built from
// it rather than hand-copied: transcribing one from a wrapped screenshot gave
// 20 fields against an 18-column header, and the miscount looked like a parser
// bug. Values are the real ones; only the alignment is reconstructed.
const AVAIL_HEADER = "sectionName~totalAvailableSeat~priceCode~isWheelChairEnabled~adaCodes~socialDistanceAvailableSeat~isOV~adaSeatCount~resaleSeatsCount~ptxSeatCount~seatAttributes~crc~prc~priceCodeAvailabilityAda~parentPriceCodeAvailCount~parentPriceSdAvailCount~restrictedAreas~id";
const AVAIL_COLS = AVAIL_HEADER.split("~");
const row = (fields) => AVAIL_COLS.map((c) => (fields[c] === undefined ? "" : String(fields[c]))).join("~");
const AVAIL = { data: { section: { header: AVAIL_HEADER, data: [
  row({ sectionName: "101", totalAvailableSeat: 10, priceCode: "G,F", restrictedAreas: "6,4", id: "GEYDC" }),
  row({ sectionName: "102", totalAvailableSeat: 8,  priceCode: "G",   restrictedAreas: "3",   id: "GEYDE" }),
  row({ sectionName: "116", totalAvailableSeat: 12, priceCode: "G,F", id: "GEYTM" }),
  row({ sectionName: "301", totalAvailableSeat: 10, priceCode: "L", isWheelChairEnabled: 1,
        adaCodes: "WC", resaleSeatsCount: 10, id: "GMYDC" }),
  row({ sectionName: "999", totalAvailableSeat: 0,  priceCode: "G",   id: "GEYDX" }),
] } } };

// Verbatim from priceData/buy.
const PD_HEADER = "ticketType~completePriceCode~amount~name~fundDescription~fundAmount~isAdditional~minLimit~maxLimit~description~isFlatUpgrade~components~serviceChargeId";
const mk = (code, amount, base) =>
  ({ description: "", maxContigSeats: 5,
     data: [`_AS~${code}S~${amount}~Reserved - Single Game~~~0~1~999~Reserved - Single Game~0~[${base},0,8,0,0,0,0,0,0,0,0,0]~`],
     isNft: false });
const PRICE = { data: { priceCode: { header: PD_HEADER, data: {
  A: mk("A", 92, 92), B: mk("B", 75, 67), C: mk("C", 50, 42), D: mk("D", 50, 42),
  E: mk("E", 50, 42), F: mk("F", 35, 27), G: mk("G", 35, 27), I: mk("I", 50, 42),
  L: mk("L", 35, 27) } } } };

let fail = 0;
const out = console.log;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; out(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else out(`ok   ${l}`);
};

out("--- columns are read by NAME from the header ---");
const secs = parseDelimited(AVAIL.data.section);
eq("all rows parsed", secs.length, 5);
eq("section 101", { s: secs[0].sectionName, n: secs[0].totalAvailableSeat, p: secs[0].priceCode },
   { s: "101", n: "10", p: "G,F" });
eq("wheelchair flag read", secs[3].isWheelChairEnabled, "1");
eq("ada code read", secs[3].adaCodes, "WC");
eq("resale count read", secs[3].resaleSeatsCount, "10");
eq("trailing id read", secs[0].id, "GEYDC");
eq("no header -> nothing", parseDelimited({ data: ["a~b"] }), []);
eq("no rows -> nothing", parseDelimited({ header: "a~b" }), []);
eq("garbage -> nothing", parseDelimited(null), []);

out("--- price codes map to the all-in amount ---");
const pm = priceMapOf(PRICE);
eq("nine codes", Object.keys(pm).length, 9);
eq("A = 92", pm.A, 92);
eq("B = 75 (67 base + 8)", pm.B, 75);
eq("F = 35", pm.F, 35);
eq("L = 35", pm.L, 35);
eq("no price data -> empty", priceMapOf({}), {});

out("--- a section quotes its cheapest code ---");
eq("G,F -> 35", sectionPrice("G,F", pm).price, 35);
eq("single L -> 35", sectionPrice("L", pm).price, 35);
eq("A,F -> 35 not 92", sectionPrice("A,F", pm).price, 35);
eq("both codes kept", sectionPrice("A,F", pm).codes, ["A", "F"]);
eq("both prices kept", sectionPrice("A,F", pm).prices, [92, 35]);
eq("unknown code -> null", sectionPrice("Z", pm).price, null);
eq("empty -> null", sectionPrice("", pm).price, null);
eq("whitespace tolerated", sectionPrice(" g , f ", pm).price, 35);

out("--- expansion (mirrors saveAmSeats) ---");
function expand(sections, priceMap) {
  const seats = {};
  let noPrice = 0, empty = 0;
  for (const sec of sections) {
    const block = String(sec.sectionName || "");
    const available = Number(sec.totalAvailableSeat) || 0;
    if (!block || available <= 0) { empty++; continue; }
    const r = sectionPrice(sec.priceCode, priceMap);
    if (r.price == null) { noPrice++; continue; }
    for (let i = 0; i < available; i++) {
      seats[`${block}-${i}`] = {
        block, row: "", seat: "", price: Math.round(r.price * 1000),
        accessible: String(sec.isWheelChairEnabled) === "1",
      };
    }
  }
  return { seats, noPrice, empty };
}
const r = expand(secs, pm);
eq("10+8+12+10 seats", Object.keys(r.seats).length, 40);
eq("zero-availability section skipped", r.empty, 1);
eq("section 101 seat", r.seats["101-0"], { block: "101", row: "", seat: "", price: 35000, accessible: false });
eq("wheelchair section flagged", r.seats["301-0"].accessible, true);
eq("$35 renders", 35000 / 1000, 35);
eq("keys unique per section", new Set(Object.keys(r.seats)).size, 40);

out("--- pairing: both payloads required ---");
eq("dispatch holds partial payloads", /amPending\[amEventId\]/.test(bg), true);
eq("parses only when both present", /pending\.availability && pending\.priceData/.test(bg), true);
eq("keyed per event", /const amPending = \{\};/.test(bg), true);
eq("says what it is waiting on", /waiting on \$\{waiting\}/.test(bg), true);

out("--- capture is wired for AM only ---");
eq("AM captures the ISM paths", /"\/v810\/venueAvailability\/", "\/v810\/priceData\/"/.test(inj), true);
eq("other ticketmaster still passive-off", /isTicketmaster && !isTicketmasterAM\) return false/.test(inj), true);
eq("event id travels with the payload", /amEventId: isTicketmasterAM/.test(inj), true);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
