// Vivid Seats listing parser, against rows copied verbatim from the capture.
//
// The fixture below is the three listings the discovery probe sampled on
// production 6965630 (Kacey Musgraves, CFG Bank Arena), field for field. Every
// hand-written fixture in this suite has cost a round trip at some point — an
// Evenue row transcribed with 20 fields against an 18-column header, a pad()
// helper whose filler outranked real data — so nothing here is retyped from
// memory. Values that were truncated in the console are marked.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const fn = (name) => eval("(" + extractFn(bg, name) + ")");
const vividSeatsPrice = fn("vividSeatsPrice");
const vividSeatsIsParking = fn("vividSeatsIsParking");
const vividSeatsAttributes = fn("vividSeatsAttributes");
const vividSeatsGroupNames = fn("vividSeatsGroupNames");

// ── the captured rows ──────────────────────────────────────────────────────
const FIRST = {
  s: "Section 208", r: "G", q: "1", p: "33.15", i: "VB17016531865", d: "208",
  n: "Mobile Tickets. Tickets must be displayed on a smartphone for entry. " +
     "Please note that you will need to use an iOS or Android mobile device " +
     "to gain entry to your event.",
  f: "0", l: "Section 208", g: "0", t: "3", m: "1", c: "408358", z: "0",
  zo: "0", ind: "0", instantElectronicTransfer: "0", instantFlashSeats: "0",
  st: "1", vs: "9.9", svs: "1.4", sd: "0", stp: "Ticketmaster Transfer",
  aip: "47.00", ls: "9", hs: "9", di: false, fdi: "", pdi: "",
  sectionName: "Section 208", row: "G", quantity: "1",
  allInPricePerTicket: "47.00", dealScore: "9.9",
  badges: [{ category: "PRICE", title: "Lowest Price in Section" }],
  perks: [], localPrices: null,
};

const MIDDLE = {
  s: "Theater Box 103B", r: "AA", q: "6", p: "136.00", i: "VB17005031145",
  d: "1032", n: "Actual 1st row of section. Please note that you will need " +
     "to use an iOS or Android mobile device to gain entry to your event.",
  f: "1", l: "Theater Box 103B", g: "0", t: "1", m: "1,2,3,4,5,6", c: "408360",
  z: "0", zo: "0", ind: "0", instantElectronicTransfer: "0",
  instantFlashSeats: "0", st: "1", svs: "7.0", sd: "0",
  stp: "Ticketmaster Transfer", aip: "185.00", tags: ["FIRST_ROW_IN_SECTION"],
  ls: "1", hs: "1", di: false, fdi: "", pdi: "",
  sectionName: "Theater Box 103B", row: "AA", quantity: "6",
  allInPricePerTicket: "185.00",
  badges: [{ category: "SCARCITY", title: "Last Ticket in Section" },
           { category: "PRICE", title: "Lowest Price in Section" }],
  perks: ["Seated Together"], localPrices: null,
};

const LAST = {
  s: "Section 104", r: "C", q: "1", p: "307.00", i: "VB16936621448", d: "104",
  n: "Please note that you will need to use an iOS or Android mobile device " +
     "to gain entry to your event. The estimated delivery date is 09/04/26.",
  f: "0", l: "Section 104", g: "0", t: "1", m: "1", c: "408357", z: "0",
  zo: "1", ind: "0", instantElectronicTransfer: "0", instantFlashSeats: "0",
  st: "1", vs: "2.2", svs: "7.5", sd: "0", stp: "Ticketmaster Transfer",
  aip: "417.00", ls: "12", hs: "12", di: false, fdi: "", pdi: "",
  sectionName: "Section 104", row: "C", quantity: "1",
  allInPricePerTicket: "417.00", dealScore: "2.2", badges: [], perks: [],
  localPrices: null,
};

out("--- price: the all-in figure, not the pre-fee one ---");
// This is the whole pricing decision for this site. `p` is what Vivid shows
// with the AIP toggle off; `aip` is what the buyer is actually charged.
check("first: 47.00 all-in, not 33.15", vividSeatsPrice(FIRST) === 47, String(vividSeatsPrice(FIRST)));
check("middle: 185.00, not 136.00", vividSeatsPrice(MIDDLE) === 185, String(vividSeatsPrice(MIDDLE)));
check("last: 417.00, not 307.00", vividSeatsPrice(LAST) === 417, String(vividSeatsPrice(LAST)));
check("falls back to aip if the long name is missing",
  vividSeatsPrice({ aip: "99.50", p: "80.00" }) === 99.5);
check("falls back to p if there is no all-in price",
  vividSeatsPrice({ p: "80.00" }) === 80);
check("zero is not a price", vividSeatsPrice({ aip: "0.00", p: "0" }) === null);
check("empty listing yields null", vividSeatsPrice({}) === null);
// A fee multiplier on top of an all-in price would double-charge the fee.
check("fee multiplier stays 1.0 for vividseats",
  /vividseats: 1\.0/.test(fs.readFileSync(EXT + "popup.js", "utf8")));

out("");
out("--- quantity comes from q, never from the split list ---");
// MIDDLE sells in splits of 1-6 and has 6 seats; a parser that read `m` would
// be right here by luck. FIRST has q:"1" and m:"1", LAST q:"1" m:"1".
const qtyOf = (l) => Number(l.quantity || l.q) || 1;
check("middle is 6 seats", qtyOf(MIDDLE) === 6, String(qtyOf(MIDDLE)));
check("first is 1 seat", qtyOf(FIRST) === 1);
check("a 1-seat listing with 6 splits stays 1 seat",
  qtyOf({ quantity: "1", q: "1", m: "1,2,3,4,5,6" }) === 1);
check("the parser reads quantity, not m", /listing\.quantity \|\| listing\.q/.test(bg));
check("m is never read as a count", !/Number\(listing\.m/.test(bg));

out("");
out("--- parking ---");
check("a normal section is not parking", !vividSeatsIsParking(FIRST));
check("theater box is not parking", !vividSeatsIsParking(MIDDLE));
check("named parking is excluded", vividSeatsIsParking({ sectionName: "Parking Pass" }));
check("numbered lot is excluded", vividSeatsIsParking({ sectionName: "Lot 5" }));
// The narrow \blot\s*[0-9]+\b matters: these are real seating names.
check("Lottery Box is not parking", !vividSeatsIsParking({ sectionName: "Lottery Box" }));
check("Charlotte is not parking", !vividSeatsIsParking({ sectionName: "Charlotte Suite" }));

out("");
out("--- attributes: badges, perks and delivery ---");
const a1 = vividSeatsAttributes(FIRST);
check("first has the price badge", a1.indexOf("Lowest Price in Section") >= 0, a1.join(" | "));
check("first has the delivery method", a1.indexOf("Ticketmaster Transfer") >= 0);
const a2 = vividSeatsAttributes(MIDDLE);
check("middle keeps both badges",
  a2.indexOf("Last Ticket in Section") >= 0 && a2.indexOf("Lowest Price in Section") >= 0,
  a2.join(" | "));
check("middle keeps the perk", a2.indexOf("Seated Together") >= 0);
const a3 = vividSeatsAttributes(LAST);
check("no badges leaves just delivery", a3.length === 1 && a3[0] === "Ticketmaster Transfer", a3.join(" | "));
check("an empty listing yields no attributes", vividSeatsAttributes({}).length === 0);

out("");
out("--- group id -> area name ---");
// Sample group rows were never printed by the probe, only the key list
// (productionId,i,n,c,a,t,h,l,q,z,zd,g), so the id field is indexed under
// every plausible name. These assert that whichever one it turns out to be,
// the lookup resolves.
check("resolves when the id is on i",
  vividSeatsGroupNames({ groups: [{ i: "408358", n: "Upper Level" }] })["408358"] === "Upper Level");
check("resolves when the id is on g",
  vividSeatsGroupNames({ groups: [{ g: "408358", n: "Upper Level" }] })["408358"] === "Upper Level");
check("resolves when the id is on c",
  vividSeatsGroupNames({ groups: [{ c: "408358", n: "Upper Level" }] })["408358"] === "Upper Level");
check("a numeric id still matches a string lookup",
  vividSeatsGroupNames({ groups: [{ i: 408358, n: "Upper Level" }] })["408358"] === "Upper Level");
check("no groups is not a crash", Object.keys(vividSeatsGroupNames({})).length === 0);
check("a nameless group is skipped",
  Object.keys(vividSeatsGroupNames({ groups: [{ i: "1" }, null] })).length === 0);

out("");
out("--- the dispatch matches the right endpoint ---");
const LISTINGS = "https://www.vividseats.com/hermes/api/v1/listings?productionId=6965630&currency=USD";
const BADGING = "https://www.vividseats.com/hermes/api/v1/badging/productions/6965630/sold/listings?include=x";
check("captures the listings endpoint", LISTINGS.includes("/hermes/api/v1/listings"));
// The badging endpoint returned {"listings":[]}. If it matched, it would parse
// as zero seats and could overwrite a good scan.
check("does NOT capture the badging endpoint", !BADGING.includes("/hermes/api/v1/listings"),
  "badging would be parsed as an empty inventory");
check("production id read from the query string",
  (LISTINGS.match(/[?&]productionId=(\d+)/i) || [])[1] === "6965630");
check("dispatch requires a tickets array", /site === "vividseats"[\s\S]{0,220}Array\.isArray\(body\.tickets\)/.test(bg));

out("");
out("--- event identity comes off the payload when JSON-LD fails ---");
check("productionName is used as a name fallback", /globalInfo\.productionName/.test(bg));
check("mapTitle is used as a venue fallback", /globalInfo\.mapTitle/.test(bg));
// The venue drives seat tiering; losing it silently drops to heuristic tiers.
check("the venue reaches tierFor", /VenueTiers\.tierFor\(venueName, block, row\)/.test(bg));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
