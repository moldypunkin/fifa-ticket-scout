// GoTickets listing parser, against the three listings the probe printed on
// event 1984079 (Trans-Siberian Orchestra, T-Mobile Center), copied verbatim.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const fn = (name) => eval("(" + extractFn(bg, name) + ")");
const goTicketsPrice = fn("goTicketsPrice");
const goTicketsBlockName = fn("goTicketsBlockName");
const goTicketsIsParking = fn("goTicketsIsParking");
global.isoToDisplayDate = fn("isoToDisplayDate");
const goTicketsEventIdentity = fn("goTicketsEventIdentity");
global.goTicketsAttributeNames = { "26": "Obstructed View", "69": "Wheelchair Accessible" };
const goTicketsAttributes = fn("goTicketsAttributes");

const MOBILE = [{ id: 1, enumName: "MOBILE", displayName: "Mobile Transfer",
  retailDisplayName: "Mobile Transfer",
  description: "Your tickets will be transferred to you electronically. Please note you need either an iOS or android mobile device to enter the event.",
  price: 6, physicalDelivery: false }];

const FIRST = { id: 7255422774, eventId: 1984079, section: "Lower 101", sectionId: 1891434,
  row: "31", notes: "", quantity: 2, validSplitQuantities: [2], flex: false, instant: false,
  displayPrice: 298, serviceFee: 29, powerSeller: false, inHandDate: "2026-12-28",
  stockType: "MOBILE_TICKETS", deliveryMethods: MOBILE, attributes: [],
  generalAdmission: false, allInPrice: 330, seatScore: 20.6, valueScore: 8.1 };

const MIDDLE = { id: 7180954288, eventId: 1984079, section: "Upper 205", sectionId: 1891461,
  row: "11", notes: "", quantity: 6, validSplitQuantities: [1, 2, 3, 4, 6], flex: true,
  instant: false, displayPrice: 148, serviceFee: 14, powerSeller: false,
  inHandDate: "2026-12-27", stockType: "MOBILE_TICKETS", deliveryMethods: MOBILE,
  attributes: [], generalAdmission: false, allInPrice: 168, seatScore: 19.3, valueScore: 9.2 };

const LAST = { id: 7200476971, eventId: 1984079, section: "Floor 5", sectionId: 1891431,
  row: "4", notes: "Delivery Delay", quantity: 4, validSplitQuantities: [1, 2, 3, 4],
  flex: false, instant: false, displayPrice: 865, serviceFee: 87, powerSeller: false,
  inHandDate: "2026-12-28", stockType: "MOBILE_TICKETS", deliveryMethods: MOBILE,
  attributes: [26], generalAdmission: false, allInPrice: 958, seatScore: 42.3, valueScore: 7.2 };

out("--- price: the all-in figure, in dollars ---");
check("330, not the 298 base", goTicketsPrice(FIRST) === 330, String(goTicketsPrice(FIRST)));
check("168", goTicketsPrice(MIDDLE) === 168);
check("958", goTicketsPrice(LAST) === 958);
// The parts do not reliably rebuild the total: two listings add up with the $6
// delivery fee, the third is $3 off. So the total is read, never computed.
check("parts + delivery match on MIDDLE", 148 + 14 + 6 === MIDDLE.allInPrice);
check("parts + delivery match on LAST", 865 + 87 + 6 === LAST.allInPrice);
check("but NOT on FIRST", 298 + 29 + 6 !== FIRST.allInPrice, "333 vs 330");
check("the parser never sums serviceFee", !/listing\.serviceFee\s*\+|\+\s*listing\.serviceFee/.test(bg));
check("falls back to displayPrice", goTicketsPrice({ displayPrice: 120 }) === 120);
check("zero is not a price", goTicketsPrice({ allInPrice: 0, displayPrice: 0 }) === null);
check("fee multiplier stays 1.0",
  /gotickets: 1\.0/.test(fs.readFileSync(EXT + "popup.js", "utf8")));

out("");
out("--- quantity comes from quantity, never from the split list ---");
// MIDDLE holds 6 seats but sells in 5 lot sizes.
check("MIDDLE is 6 seats", Number(MIDDLE.quantity) === 6);
check("the parser reads quantity", /Number\(listing\.quantity\) \|\| 1/.test(bg));
check("validSplitQuantities is never a count", !/Number\(listing\.validSplitQuantities/.test(bg));

out("");
out("--- block is the section number ---");
check("Lower 101 -> 101", goTicketsBlockName(FIRST) === "101", goTicketsBlockName(FIRST));
check("Upper 205 -> 205", goTicketsBlockName(MIDDLE) === "205");
check("Floor 5 -> 5", goTicketsBlockName(LAST) === "5");
check("VIP Packages kept whole", goTicketsBlockName({ section: "VIP Packages" }) === "VIP Packages");
check("no section is not a crash", goTicketsBlockName({}) === "");

out("");
out("--- attributes ---");
const a3 = goTicketsAttributes(LAST);
check("attribute id resolves to its name", a3.indexOf("Obstructed View") >= 0, a3.join(" | "));
check("delivery method kept", a3.indexOf("Mobile Transfer") >= 0);
check("notes kept", a3.indexOf("Delivery Delay") >= 0);
check("an unindexed id stays visible",
  goTicketsAttributes({ attributes: [999] }).indexOf("attribute 999") >= 0);
check("general admission flagged",
  goTicketsAttributes({ generalAdmission: true }).indexOf("General admission") >= 0);
check("empty notes are not added", goTicketsAttributes(FIRST).indexOf("") === -1);

out("");
out("--- parking ---");
check("a seating section is not parking", !goTicketsIsParking(FIRST));
check("parking is excluded", goTicketsIsParking({ section: "Parking Lot B" }));

out("");
out("--- event identity is defensive ---");
// The event object's fields were not visible in the capture.
const e1 = goTicketsEventIdentity({ name: "Trans-Siberian Orchestra", localDate: "2026-12-29T19:30:00",
  venue: { name: "T-Mobile Center" } });
check("name", e1.name === "Trans-Siberian Orchestra", e1.name);
check("date normalised for the popup", e1.date === "29-12-2026 - 19:30", e1.date);
check("venue from a nested object", e1.venue === "T-Mobile Center", e1.venue);
const e2 = goTicketsEventIdentity({ title: "X", eventDate: "2026-12-29", venueName: "Y" });
check("alternate field names", e2.name === "X" && e2.date === "29-12-2026" && e2.venue === "Y",
  JSON.stringify(e2));
// The real field names, from the live event's key list
// (…,eventTimeLocal,…,eventTimeUtc,…). A 7:30pm Kansas City show is 01:30 the
// next day in UTC, so taking the wrong one mislabels the event by a whole day.
const e3 = goTicketsEventIdentity({ name: "Trans-Siberian Orchestra",
  eventTimeLocal: "2026-12-29T19:30:00", eventTimeUtc: "2026-12-30T01:30:00" });
check("eventTimeLocal is read", e3.date === "29-12-2026 - 19:30", e3.date);
check("local wins over UTC", e3.date !== "30-12-2026 - 01:30");
check("UTC is the fallback",
  goTicketsEventIdentity({ eventTimeUtc: "2026-12-30T01:30:00" }).date === "30-12-2026 - 01:30");
check("no event is not a crash", JSON.stringify(goTicketsEventIdentity(null)) === "{}");
check("the real key list is logged", /GoTickets: event keys = /.test(bg));

out("");
out("--- the quantity question is answered in the log ---");
check("lot sizes are reported", /lot sizes offered = /.test(bg));
check("and whether any listing cannot sell as a pair", /cannot be bought as a pair/.test(bg));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
