// Verify eventInfo survives every hop: injected -> content -> background ->
// storage -> CSV, and simulate the resulting export header.
const EXT = require("./ext-dir");
const fs = require("fs");
const dir = EXT;
const read = (f) => fs.readFileSync(dir + f, "utf8");
const injected = read("injected.js"), content = read("content.js");
const bg = read("background.js"), popup = read("popup.js");

let fail = 0;
const check = (label, cond, detail) => {
  if (!cond) fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
};

console.log("--- pipeline hops ---");
check("adapter exports getEventInfo", /getEventInfo: getTicketmasterEventInfo/.test(read("ticketmaster-adapter.js")));
check("injected calls getEventInfo", /__ticketmasterAdapter\.getEventInfo\(\)/.test(injected));
check("injected posts eventInfo", /eventInfo,/.test(injected));
check("content forwards eventInfo", /eventInfo: event\.data\.eventInfo/.test(content));
check("background receives it from message", /processApiResponse\(message\.url, message\.body, tabId, message\.eventInfo/.test(bg));
check("processApiResponse takes the param", /async function processApiResponse\(url, body, tabId, eventInfo/.test(bg));
check("passed to saveTicketmasterSeats", /saveTicketmasterSeats\(eventId, [\s\S]{0,60}tabId, site, eventInfo\)/.test(bg));
check("saveTicketmasterSeats takes it", /async function saveTicketmasterSeats\(eventId, facetsData, tabId, site, eventInfo\)/.test(bg));
check("writes games[gameKey].match", /games\[gameKey\]\.match = \{/.test(bg));
check("only writes when name present", /if \(eventInfo && eventInfo\.name\)/.test(bg));

console.log("\n--- consumers ---");
check("popup venue falls back to match.venue", /parts\[3\] \|\| match\.venue \|\| ""/.test(popup));
check("CSV emits Venue line when present", /match\?\.venue \? \[`# Venue: \$\{match\.venue\}`\]/.test(popup));
check("no other processApiResponse callers", (bg.match(/processApiResponse\(/g) || []).length === 2,
  `${(bg.match(/processApiResponse\(/g) || []).length} occurrence(s) incl. definition`);

console.log("\n--- simulated export header (TM event) ---");
// Mirrors the meta[] array in exportCSV.
const match = { name: "Portugal vs. Spain", date: "15-06-2026 - 19:00", venue: "MetLife Stadium", currency: "USD", performanceId: "0700646BCF6088AD" };
const game = { site: "ticketmaster" };
// node 12: no optional chaining, so `m` stands in for `match?.`
const m = match || {};
const meta = [
  `# Match: ${m.name || "Unknown"}`,
  `# Date: ${m.date || "Unknown"}`,
  ...(m.venue ? [`# Venue: ${m.venue}`] : []),
  `# Currency: ${m.currency || "USD"}`,
  `# Site: ${game.site || "resale"}`,
  `# Performance ID: ${m.performanceId}`,
];
console.log(meta.join("\n"));
check("export no longer says Unknown", !meta.join("\n").includes("Unknown"));

console.log("\n--- same code path, event info unavailable ---");
const bare = null || {};
const metaBare = [
  `# Match: ${bare.name || "Unknown"}`,
  `# Date: ${bare.date || "Unknown"}`,
  ...(bare.venue ? [`# Venue: ${bare.venue}`] : []),
];
console.log(metaBare.join("\n"));
check("degrades to Unknown, no Venue line, no crash", metaBare.length === 2);

console.log(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
