// The cheapest-seat audit must name the offer behind the lowest price, since
// that is the seat a user compares against the live site.
const EXT = require("./ext-dir");
const fs = require("fs");
const src = fs.readFileSync(EXT + "background.js", "utf8");
let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

out("--- audit is wired ---");
check("keeps raw offers by id", /const offerById = \{\};/.test(src));
check("records how each price was reached", /priceAudit\.push\(\{/.test(src));
check("records the source", /source: facetListPrice\(facet\) != null \? "facet\.listPriceRange" : "offer map"/.test(src));
check("sorts ascending and takes 3", /sort\(\(a, b\) => a\.dollars - b\.dollars\)\.slice\(0, 3\)/.test(src));
check("sums charges", /charges \|\| \[\]\)\.reduce/.test(src));
check("reports sellableQuantities", /sellableQuantities/.test(src));
check("audit sits inside the diagnostics try", /diagnostics must never break a scan/.test(src));

out("\n--- the pricing path itself is unchanged ---");
check("still prefers facet.listPriceRange", /facetListPrice\(facet\)\s*\n?\s*\?\?/.test(src));
check("still uses the dearest offer", /Math\.max\.apply\(null, offerCandidates\)/.test(src));
check("still stores thousandths", /Math\.round\(dollars \* 1000\)/.test(src));

out("\n--- simulate the audit against the logged offer ---");
// Offer exactly as the service worker printed it.
const offer = { rank: 0, listPrice: 265, faceValue: 265, totalPrice: 316.01, noChargesPrice: 265,
  charges: [{ reason: "service", type: "fee", amount: 51.01 }], sellableQuantities: [2] };
const pick = (o) => {
  const candidates = [o.totalPrice, o.total, o.faceValue, o.listPrice, o.price, o.amount];
  for (const c of candidates) if (typeof c === "number" && isFinite(c) && c > 0) return c;
  return null;
};
check("pick() takes totalPrice", pick(offer) === 316.01, String(pick(offer)));
const sum = offer.charges.reduce((t, c) => t + c.amount, 0);
check("listPrice + charges == totalPrice", +(offer.listPrice + sum).toFixed(2) === offer.totalPrice,
  `${offer.listPrice} + ${sum} = ${(offer.listPrice + sum).toFixed(2)}`);
check("so totalPrice is all-in for THIS offer", offer.totalPrice > offer.listPrice);

out("\n--- the reported discrepancy is not the service fee ---");
const scout = 182.45, site = 187.92;
const gap = +(site / scout - 1).toFixed(4);
check("gap is ~3%", gap > 0.029 && gap < 0.031, (gap * 100).toFixed(2) + "%");
const feeRatio = +(offer.totalPrice / offer.listPrice - 1).toFixed(4);
check("service fee is ~19%, a different magnitude", feeRatio > 0.19 && feeRatio < 0.20, (feeRatio * 100).toFixed(2) + "%");
check("so a missing service fee cannot explain it", Math.abs(gap - feeRatio) > 0.15);

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
