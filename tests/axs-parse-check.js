// AXS listing parser, against listings copied verbatim from the capture on the
// Broncos-at-Chiefs onsale (Arrowhead Stadium), 1797 listings.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const deCatch = (s) => s.replace(/catch \{/g, "catch (e) {");
const fn = (name) => eval("(" + deCatch(extractFn(bg, name)) + ")");
const axsPrice = fn("axsPrice");
const axsIsParking = fn("axsIsParking");
const axsAttributes = fn("axsAttributes");
const axsSectionName = fn("axsSectionName");
const axsOnsaleToken = fn("axsOnsaleToken");

// ── the captured rows ──────────────────────────────────────────────────────
const FIRST = {
  id: "VB17047084306", row: "40",
  notes: "Please note that you will need to use an iOS or Android mobile device to gain entry to your event.",
  quantity: 10, splits: [1, 2, 3, 4, 5, 6, 7, 8, 10],
  price: 188, allInPrice: 225.34, faceValue: null, stockType: "Ticketmaster Transfer",
  inHandDate: "09/12/26", groupId: 424039,
  isElectronicDelivery: true, isEticket: false, isFlashSeats: false,
  isInstantDownload: false, isInstantElectronicTransfer: false,
  isMobileScreencap: false, isWillCall: false, isZoneSeating: false,
  priceBreakdown: { price: 188, serviceFee: 33.84, total: 225.34 },
  section: { id: 330, name: "Upper Level 330", longSectionName: "Upper Level 330" },
  featured: false, tags: null, premiumPerks: [], seatFeatures: [],
};

const MIDDLE = {
  id: "VB17049776147", row: "11", notes: "xfer xfer Side View Verified Chiefs Ticket",
  quantity: 3, splits: [1, 2, 3], price: 502, allInPrice: 595.86,
  stockType: "Ticketmaster Transfer", inHandDate: "09/14/26", groupId: 424045,
  isZoneSeating: false,
  priceBreakdown: { price: 502, serviceFee: 90.36, total: 595.86 },
  section: { id: 125, name: "Lower Level 125", longSectionName: "Lower Level 125" },
  featured: false, tags: null, premiumPerks: [],
  seatFeatures: ["Restricted/Obstructed View"],
};

const LAST = {
  id: "VB17021485157", row: "7", quantity: 3, splits: [3],
  price: 4360, allInPrice: 5148.3, stockType: "Ticketmaster Transfer",
  inHandDate: "09/13/26", groupId: 424043, isZoneSeating: false,
  priceBreakdown: { price: 4360, serviceFee: 784.8, total: 5148.3 },
  section: { id: 227, name: "Club Level 227", longSectionName: "Club Level 227" },
  featured: false, tags: null, premiumPerks: [], seatFeatures: [],
};

out("--- price: DOLLARS here, unlike Gametime's cents ---");
// The magnitudes are what prove the unit: a serviceFee of 33.84 against a price
// of 188 is a ~18% fee in dollars, and nonsense as cents. Reading these as
// cents would report a $225 ticket as $2.25, and reading Gametime's cents as
// dollars turns a $30 seat into $3,000 — both look plausible in a listing,
// which is why each site's unit is pinned rather than inferred.
check("225.34 all-in, not the 188 base", axsPrice(FIRST) === 225.34, String(axsPrice(FIRST)));
// The breakdown does NOT enumerate the whole fee, which is worth pinning:
// price + serviceFee falls short of total by exactly 3.50 on all three sampled
// listings (221.84 vs 225.34, 592.36 vs 595.86, 5144.80 vs 5148.30). Some flat
// per-ticket component is not broken out. So never compute the all-in figure
// from the parts — read `total` / `allInPrice`, which already contains it.
for (const l of [FIRST, MIDDLE, LAST]) {
  const parts = l.priceBreakdown.price + l.priceBreakdown.serviceFee;
  const gap = Math.round((l.priceBreakdown.total - parts) * 100) / 100;
  check("total exceeds price+serviceFee by 3.50 in " + l.section.name, gap === 3.5,
    parts.toFixed(2) + " vs " + l.priceBreakdown.total + " (gap " + gap + ")");
}
check("so the parser reads the total, not the parts",
  /listing && listing\.allInPrice/.test(bg) && !/serviceFee \+/.test(bg));
check("middle: 595.86", axsPrice(MIDDLE) === 595.86, String(axsPrice(MIDDLE)));
check("last: 5148.30", axsPrice(LAST) === 5148.3, String(axsPrice(LAST)));
check("falls back to the breakdown total",
  axsPrice({ priceBreakdown: { total: 99.5 }, price: 80 }) === 99.5);
check("falls back to the base price", axsPrice({ price: 80 }) === 80);
check("zero is not a price", axsPrice({ allInPrice: 0, price: 0 }) === null);
check("an empty listing yields null", axsPrice({}) === null);
check("fee multiplier stays 1.0 for axs",
  /axs: 1\.0/.test(fs.readFileSync(EXT + "popup.js", "utf8")));

out("");
out("--- quantity comes from quantity, never from splits ---");
// FIRST sells in nine different lot sizes and holds ten seats. A parser reading
// `splits` would report nine.
const qtyOf = (l) => Number(l.quantity) || 1;
check("ten seats, not nine splits", qtyOf(FIRST) === 10, String(qtyOf(FIRST)));
check("middle is three", qtyOf(MIDDLE) === 3);
check("a single-split listing is still its quantity", qtyOf(LAST) === 3, String(qtyOf(LAST)));
check("the parser reads quantity", /Number\(listing\.quantity\) \|\| 1/.test(bg));
check("splits is never read as a count", !/Number\(listing\.splits/.test(bg));

out("");
out("--- section and row ---");
check("section name", axsSectionName(FIRST) === "Upper Level 330", axsSectionName(FIRST));
check("falls back to longSectionName",
  axsSectionName({ section: { longSectionName: "Club Level 227" } }) === "Club Level 227");
check("no section is not a crash", axsSectionName({}) === "");
check("row is carried", String(FIRST.row) === "40");
// AXS publishes no seat numbers at all.
check("seat is left blank", /seat: "",/.test(bg));

out("");
out("--- the block is the section number alone ---");
const axsBlockName = fn("axsBlockName");
// AXS names sections with their level, and the level is already in the Area
// column, so the dashboard read "Block Upper Level 330 - Upper Level".
check("Upper Level 330 -> 330", axsBlockName(FIRST) === "330", axsBlockName(FIRST));
check("Lower Level 125 -> 125", axsBlockName(MIDDLE) === "125", axsBlockName(MIDDLE));
check("Club Level 227 -> 227", axsBlockName(LAST) === "227", axsBlockName(LAST));
check("a lettered section keeps its letter",
  axsBlockName({ section: { name: "Upper Level 330A" } }) === "330A",
  axsBlockName({ section: { name: "Upper Level 330A" } }));
// Nothing to shorten to: these must not become empty.
check("a name with no number is kept whole",
  axsBlockName({ section: { name: "Penthouse" } }) === "Penthouse");
check("an odd name is kept whole",
  axsBlockName({ section: { name: "(Block)" } }) === "(Block)");
check("no section is not a crash", axsBlockName({}) === "");
// The curated tier maps are keyed by exactly this, so shortening helps twice.
check("the bare number is what the tier maps use",
  /const block = axsBlockName\(listing\)/.test(bg));

out("");
out("--- area falls back to the section prefix when mapinfo is late ---");
// mapinfo and offers arrive independently and offers came first on the live
// page, so the Area column cannot depend on the group index being ready.
const prefix = (block) => block.replace(/\s*[0-9]+[A-Za-z]?\s*$/, "").trim();
check("Upper Level 330 -> Upper Level", prefix("Upper Level 330") === "Upper Level");
check("Club Level 227 -> Club Level", prefix("Club Level 227") === "Club Level");
check("Lower Level 125 -> Lower Level", prefix("Lower Level 125") === "Lower Level");
check("a lettered section still trims", prefix("Upper Level 330A") === "Upper Level");
check("a name with no number is untouched", prefix("Penthouse") === "Penthouse");
check("the parser prefers the mapinfo group name",
  /groupNames\[String\(listing\.groupId\)\]/.test(bg));
// The prefix has to come off the FULL name. Taking it from `block` would find
// nothing to strip — that is "330" — and the Area column would go blank
// wherever mapinfo had not arrived.
check("the prefix is taken from the full section name",
  /fullSection\.replace\(/.test(bg), "taking it from `block` yields an empty Area");

out("");
out("--- parking ---");
check("a normal section is not parking", !axsIsParking(FIRST));
check("named parking is excluded", axsIsParking({ section: { name: "Parking Lot C" } }));
check("numbered lot is excluded", axsIsParking({ section: { name: "Lot 5" } }));
check("no section is not a crash", !axsIsParking({}));

out("");
out("--- attributes ---");
const a1 = axsAttributes(FIRST);
check("stock type is kept", a1.indexOf("Ticketmaster Transfer") >= 0, a1.join(" | "));
const a2 = axsAttributes(MIDDLE);
check("seat features are kept", a2.indexOf("Restricted/Obstructed View") >= 0, a2.join(" | "));
check("a null tags array is not a crash", axsAttributes({ tags: null }).length === 0);
// A zone listing is not a specific seat in that section, which matters next to
// a row number.
check("zone seating is flagged",
  axsAttributes({ isZoneSeating: true }).indexOf("Zone seating") >= 0);
check("and not flagged when false",
  axsAttributes({ isZoneSeating: false }).indexOf("Zone seating") === -1);

out("");
out("--- event identity, including the date ---");
const axsIndexEventInfo = fn("axsIndexEventInfo");
const isoToDisplayDate = fn("isoToDisplayDate");
// The captured /axsmarketplace/eventinfo payload, verbatim. 448 bytes, and the
// only AXS response carrying a date at all.
const EVENTINFO = {
  id: 6491101,
  name: "Denver Broncos at Kansas City Chiefs (Monday Night Football)",
  image: "https://static.discovery-prod.axs.com/axs/bundles/aegaxs/images/veritix/sports/football/1_678_399.jpg",
  utcDate: "2026-09-15T00:15:00", localDate: "2026-09-14T19:15:00",
  venueName: "Arrowhead Stadium",
  venueAddress: { addressLine: "1 Arrowhead Dr.", city: "Kansas City",
                  stateCode: "MO", postalCode: "64129", countryCode: "US",
                  regionId: 48, phone: null },
};
// localDate and utcDate fall on DIFFERENT CALENDAR DAYS here — a 19:15 kickoff
// local is 00:15 the next day UTC — so picking the wrong one is a whole-day
// error, not an hours-off one. The venue clock is what is printed on a ticket.
check("local date wins over utc",
  isoToDisplayDate(EVENTINFO.localDate) === "14-09-2026 - 19:15",
  isoToDisplayDate(EVENTINFO.localDate));
check("and utc would have said the 15th",
  isoToDisplayDate(EVENTINFO.utcDate) === "15-09-2026 - 00:15",
  isoToDisplayDate(EVENTINFO.utcDate));
check("the parser prefers localDate", /body\.localDate \|\| body\.utcDate/.test(bg));
check("garbage yields null", isoToDisplayDate("nonsense") === null);
// It must agree with event-info.js, which is what the popup renders.
const ei = fs.readFileSync(EXT + "event-info.js", "utf8");
const shared = eval("(" + extractFn(ei, "normalizeEventDate") + ")");
check("agrees with event-info.js",
  shared("2026-09-14T19:15:00") === isoToDisplayDate("2026-09-14T19:15:00"));

out("");
out("--- the onsale token keys every payload ---");
const OFFERS = "https://unifiedapicommerce-us.axs.com/axsmarketplace/offers" +
  "?onsaleID=qyNwCQAAAACR8mTJAAAAACb%2Fv%2F2F%2F%2FwD&flow=best_available";
const MAPINFO = "https://unifiedapicommerce-us.axs.com/axsmarketplace/mapinfo" +
  "?onsaleID=qyNwCQAAAACR8mTJAAAAACb%2Fv%2F2F%2F%2FwD&flow=best_available";
check("token from the offers url", axsOnsaleToken(OFFERS) === "qyNwCQAAAACR8mTJAAAAACb",
  axsOnsaleToken(OFFERS));
check("mapinfo yields the same token", axsOnsaleToken(MAPINFO) === axsOnsaleToken(OFFERS));
// This is the value the popup derives from the tab url; if they disagree the
// seats are stored where the dashboard will not look.
check("and it matches what the page url gives",
  axsOnsaleToken(OFFERS) === "qyNwCQAAAACR8mTJAAAAACb");
check("no onsaleID yields nothing",
  axsOnsaleToken("https://unifiedapicommerce-us.axs.com/axsmarketplace/offers") === "");
check("a short token is rejected",
  axsOnsaleToken("https://x.axs.com/offers?onsaleID=abc") === "");

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
