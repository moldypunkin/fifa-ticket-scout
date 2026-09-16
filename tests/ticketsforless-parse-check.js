// TicketsForLess ticket parser, against the three tickets the probe printed on
// event 7730195 (Kansas City Chiefs vs Indianapolis Colts), copied verbatim.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const fn = (name) => eval("(" + extractFn(bg, name) + ")");
const tflPrice = fn("tflPrice");
const tflIsParking = fn("tflIsParking");
const tflSeatNumbers = fn("tflSeatNumbers");
const tflAttributes = fn("tflAttributes");
global.isoToDisplayDate = fn("isoToDisplayDate");
const tflEventIdentity = fn("tflEventIdentity");

const FIRST = { id: "4301087", sec: "334", row: "14", qty: 1, splits: 1, notes: "Uppers XFER",
  mark: true, type: 1, price: 98, priceSlash: null,
  meta: { inHandOn: 1789534800, type: "MF", hash: "vQjTNpfBMR5y95GxiG/YdTAyQjBWZEhhdnVLWXpteHpwalRaMkJsRHhvV040a0tJa2lTSUN1cmcvVVE9" },
  faceValue: 87, serviceFee: 0, delivery: ["M"], features: null, mapSection: "334", seats: "21" };

const MIDDLE = { id: "4304064", sec: "115", row: "26", qty: 5, splits: 23,
  notes: "Goal to 10 Yard Line Lowers XFER", mark: true, type: 1, price: 244, priceSlash: null,
  meta: { inHandOn: 1789534800, type: "MF", hash: "dRUT42CLS/xBbjSXpD09L2NodmY2TmZVQ2ZIQ3ppd0JqN1ZpbFJnemR1dHRFMlhZMFQ2WUkxNlpGZVE9" },
  faceValue: 217, serviceFee: 0, delivery: ["M"], features: null, mapSection: "115", seats: "15-19" };

const LAST = { id: "4488928", sec: "Penthouse", row: "1", qty: 2, splits: 2,
  notes: "Penthouse Suite. Shared Suite. Food And Beverages Included. All You Can Eat Included In Price Of Ticket. Includes Premium Open Bar. Includes Access To VIP Club/Lounge - XFER",
  mark: true, type: 1, price: 1451, priceSlash: null,
  meta: { inHandOn: 1789534800, type: "MF", hash: "pPWXEn6qA9k8fMRIvwirSk9TZUhNSmp3SWoxOUJuQmxSZUNTYmZ2ZkdGeGk4UzJINjdaN2swd3pvOTQ9" },
  faceValue: 1295, serviceFee: 0, delivery: ["M"], features: null, mapSection: "PENTHOUSE", seats: "29-30" };

out("--- price ---");
check("98 dollars", tflPrice(FIRST) === 98, String(tflPrice(FIRST)));
check("244", tflPrice(MIDDLE) === 244);
check("1451", tflPrice(LAST) === 1451);
check("price, not faceValue", tflPrice(FIRST) !== FIRST.faceValue);
check("serviceFee is 0 on every sample", [FIRST, MIDDLE, LAST].every((t) => t.serviceFee === 0));
check("a string price parses", tflPrice({ price: "120.50" }) === 120.5);
check("zero is not a price", tflPrice({ price: 0 }) === null);
check("no price yields null", tflPrice({}) === null);
check("fee multiplier stays 1.0", /ticketsforless: 1\.0/.test(fs.readFileSync(EXT + "popup.js", "utf8")));

out("");
out("--- seat numbers: expanded only when they match the quantity ---");
check("single seat", JSON.stringify(tflSeatNumbers(FIRST)) === '["21"]', JSON.stringify(tflSeatNumbers(FIRST)));
check("15-19 across 5 seats", tflSeatNumbers(MIDDLE).join(",") === "15,16,17,18,19",
  tflSeatNumbers(MIDDLE).join(","));
check("29-30 across 2 seats", tflSeatNumbers(LAST).join(",") === "29,30");
check("a comma list", tflSeatNumbers({ seats: "1,3,5", qty: 3 }).join(",") === "1,3,5");
check("spaces around the dash", tflSeatNumbers({ seats: "15 - 16", qty: 2 }).join(",") === "15,16");
// A range that disagrees with the quantity cannot say which seats are for
// sale; printing 15..19 against a 2-seat listing would invent seat numbers.
check("range larger than qty is not guessed", tflSeatNumbers({ seats: "15-19", qty: 2 }).length === 0);
check("range smaller than qty is not guessed", tflSeatNumbers({ seats: "15-16", qty: 4 }).length === 0);
check("a backwards range is rejected", tflSeatNumbers({ seats: "19-15", qty: 5 }).length === 0);
check("an absurd range is rejected", tflSeatNumbers({ seats: "1-500", qty: 500 }).length === 0);
check("non-numeric seats are rejected", tflSeatNumbers({ seats: "GA", qty: 1 }).length === 0);
check("empty seats", tflSeatNumbers({ seats: "", qty: 2 }).length === 0);
check("null seats", tflSeatNumbers({ seats: null, qty: 2 }).length === 0);

out("");
out("--- quantity is qty, never splits ---");
check("MIDDLE is 5 seats though splits is 23", MIDDLE.qty === 5 && MIDDLE.splits === 23);
check("the parser reads qty", /const qty = Number\(listing\.qty\) \|\| 1/.test(bg));
check("splits is never a count", !/Number\(listing\.splits/.test(bg));

out("");
out("--- sections ---");
check("sec is already the bare number", FIRST.sec === "334");
check("the parser uses sec for the block", /String\(listing\.sec \|\| listing\.mapSection \|\| ""\)/.test(bg));
check("Penthouse kept as named", LAST.sec === "Penthouse");

out("");
out("--- parking and attributes ---");
check("a seating section is not parking", !tflIsParking(FIRST));
check("penthouse is not parking", !tflIsParking(LAST));
check("parking is excluded", tflIsParking({ sec: "Parking Lot A" }));
check("seller notes are kept", tflAttributes(FIRST).join("|") === "Uppers XFER");
check("null features is not a crash", tflAttributes({ features: null }).length === 0);
check("feature strings are kept", tflAttributes({ features: ["Aisle"] })[0] === "Aisle");

out("");
out("--- event identity is defensive ---");
const e = tflEventIdentity({ name: "Kansas City Chiefs vs Indianapolis Colts",
  dateLocal: "2026-09-20T19:20:00", venue: { name: "GEHA Field at Arrowhead Stadium" } });
check("name", e.name === "Kansas City Chiefs vs Indianapolis Colts", e.name);
check("date", e.date === "20-09-2026 - 19:20", e.date);
check("venue", e.venue === "GEHA Field at Arrowhead Stadium", e.venue);
check("no event is not a crash", JSON.stringify(tflEventIdentity(null)) === "{}");
check("event and siteConfig keys are logged", /TicketsForLess: event keys = /.test(bg) && /siteConfig keys = /.test(bg));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
