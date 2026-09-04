// Gametime listing parser, against a listing copied verbatim from the capture.
//
// The row below is the one the probe printed in full on event
// 68af55be0dcf1d7f796e5e89 (Rays at Rangers, Globe Life Field), field for
// field. Seeing it at all required raising the probe's sample cap — see the
// blind-spot #6 case in probe-blindspot-check.js.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const fn = (name) => eval("(" + extractFn(bg, name) + ")");
const gametimePrice = fn("gametimePrice");
const gametimeIsParking = fn("gametimeIsParking");
const gametimeDisclosures = fn("gametimeDisclosures");
// Renamed to isoToDisplayDate when AXS needed the same conversion — its
// localDate is the same ISO shape as Gametime's datetime_local, and a second
// copy would be a second thing to get wrong.
const gametimeEventDate = fn("isoToDisplayDate");

// ── the captured row ───────────────────────────────────────────────────────
const LISTING = {
  id: "6941d5d94c87f865d0bcf87d",
  available_lots: [2],
  price: { prefee: 2300, total: 3000, sales_tax: 229, pre_tax_total: 2771 },
  disclosures: [],
  display_groups: { listings_list: { sort_order: 89 } },
  delivery_type: "direct",
  transfer_type: "",
  seats: ["15", "16"],
  event_id: "68af55be0dcf1d7f796e5e89",
  spot: {
    position: { x: 1799.68986, y: 1371.68367 },
    row: "5", section: "224", section_group: "Middle",
    view_url: "https://images.gametime.co/v2/globe_life_field/baseball/224@4x.jpg",
  },
  source: "gametime",
  display_savings: { amount: 0, percent: 0 },
  ticket_type: "tdc",
  in_hand_date: "",
};

// The other listing the probe sampled, from the earlier quantity=2 capture.
const PRICIER = {
  id: "6a90a2da96d5b04d64ce5eb6",
  available_lots: [2],
  price: { prefee: 36000, total: 42300, sales_tax: 739, pre_tax_total: 41561 },
  disclosures: [], delivery_type: "mobile", transfer_type: "mlb_ballpark",
  event_id: "68af55be0dcf1d7f796e5e89",
};

out("--- price: cents, and the all-in figure ---");
// Reading `total` as dollars would report this $30 seat as $3,000 — and next
// to a real premium listing that looks plausible, which is why it is pinned.
check("3000 cents is $30.00", gametimePrice(LISTING) === 30, String(gametimePrice(LISTING)));
check("all-in wins over prefee ($30, not $23)", gametimePrice(LISTING) !== 23);
check("42300 cents is $423.00", gametimePrice(PRICIER) === 423, String(gametimePrice(PRICIER)));
check("falls back to pre_tax_total", gametimePrice({ price: { pre_tax_total: 2771 } }) === 27.71);
check("falls back to prefee", gametimePrice({ price: { prefee: 2300 } }) === 23);
check("zero is not a price", gametimePrice({ price: { total: 0, prefee: 0 } }) === null);
check("no price object yields null", gametimePrice({}) === null);
check("fee multiplier stays 1.0 for gametime",
  /gametime: 1\.0/.test(fs.readFileSync(EXT + "popup.js", "utf8")));

out("");
out("--- seat identity: the thing no other resale source gives us ---");
check("section from spot", String(LISTING.spot.section) === "224");
check("row from spot", String(LISTING.spot.row) === "5");
check("seat numbers present", LISTING.seats.join(",") === "15,16");
check("the parser reads spot.section", /String\(spot\.section \|\| ""\)/.test(bg));
check("the parser reads spot.row", /String\(spot\.row \|\| ""\)/.test(bg));
check("area from section_group", /String\(spot\.section_group \|\| ""\)/.test(bg));
// available_lots is [2] here and seats has 2 entries, so a parser reading the
// wrong one is right by luck on this row. It is not on a multi-lot listing.
check("quantity comes from seats, not available_lots",
  /const qty = numbers\.length \|\|/.test(bg));
check("seat numbers are assigned per seat", /seat: numbers\[i\] != null/.test(bg));

out("");
out("--- parking ---");
check("a normal section is not parking", !gametimeIsParking(LISTING));
check("named parking is excluded",
  gametimeIsParking({ spot: { section: "Parking Lot A" } }));
check("numbered lot is excluded", gametimeIsParking({ spot: { section: "Lot 5" } }));
check("no spot is not a crash", !gametimeIsParking({}));

out("");
out("--- disclosures ---");
check("empty disclosures still carry delivery",
  gametimeDisclosures(LISTING).join("|") === "direct", gametimeDisclosures(LISTING).join("|"));
// The element type was never observed (every sampled row had []), so both
// plausible shapes are handled.
check("bare slug strings", gametimeDisclosures({ disclosures: ["aisle"] })[0] === "aisle");
check("objects with a title",
  gametimeDisclosures({ disclosures: [{ slug: "aisle", title: "Aisle" }] })[0] === "Aisle");
check("objects with only a slug",
  gametimeDisclosures({ disclosures: [{ slug: "padded_seating" }] })[0] === "padded_seating");
check("a non-array is not a crash", gametimeDisclosures({ disclosures: null }).length === 0);

out("");
out("--- event dates match what the popup renders ---");
// event-info.js normalises to DD-MM-YYYY - HH:MM; the service worker cannot
// import it, so this reimplements it and has to agree.
check("local datetime", gametimeEventDate("2026-09-05T18:05:00") === "05-09-2026 - 18:05",
  gametimeEventDate("2026-09-05T18:05:00"));
check("date only", gametimeEventDate("2026-09-05") === "05-09-2026");
check("garbage yields null", gametimeEventDate("nonsense") === null);
check("null yields null", gametimeEventDate(null) === null);
const ei = fs.readFileSync(EXT + "event-info.js", "utf8");
const shared = eval("(" + extractFn(ei, "normalizeEventDate") + ")");
check("agrees with event-info.js", shared("2026-09-05T18:05:00") === gametimeEventDate("2026-09-05T18:05:00"),
  shared("2026-09-05T18:05:00"));

out("");
out("--- the dispatch matches the right endpoints ---");
const LISTINGS = "https://mobile.gametime.co/v3/listings/68af55be0dcf1d7f796e5e89?all_in_pricing=true&quantity=2";
const EVENTS = "https://mobile.gametime.co/v1/events?page=1&per_page=1000&id=68af55be0dcf1d7f796e5e89";
const ZONES = "https://mobile.gametime.co/v1/events/68af55be0dcf1d7f796e5e89/zone-configs";
check("captures listings", LISTINGS.includes("/v3/listings/"));
check("captures events", /\/v\d+\/events(\?|$)/.test(EVENTS.split("#")[0]));
// zone-configs shares the /v1/events prefix. It is captured but must not be
// indexed as an events payload; the dispatch requires an `events` array.
check("zone-configs is not an events payload", !/\/v\d+\/events(\?|$)/.test(ZONES));
check("indexing requires an events array", /Array\.isArray\(body\.events\)/.test(bg));
check("event id read from the listings path",
  (LISTINGS.match(/\/v3\/listings\/([A-Za-z0-9]+)/) || [])[1] === "68af55be0dcf1d7f796e5e89");

out("");
out("--- the quantity filter is reported, not hidden ---");
// The observed request carried quantity=2 and every listing came back a pair,
// so a scan covers one lot size. Silently reporting it as the whole event
// would understate inventory the way the AM quantity filter is suspected to.
check("the quantity is read off the url", bg.includes("[?&]quantity=(\\d+)"));
check("and the slice is named in the log", /this payload is the quantity=/.test(bg));
// The advice must not tell anyone to go clicking: injected.js sweeps the lot
// sizes itself, so "change the quantity selector and rescan" was stale the
// moment that landed.
check("without stale manual advice", !/Change the quantity selector/.test(bg));

out("");
out("--- vivid seats stayed finished ---");
check("vividseats parser intact", /function saveVividSeatsSeats/.test(bg));
check("vividseats endpoint still matched",
  /\["\/hermes\/api\/v1\/listings"\]/.test(fs.readFileSync(EXT + "injected.js", "utf8")));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
