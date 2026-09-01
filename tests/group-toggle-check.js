// The Category | Tier switch.
//
// It used to blank itself when neither axis had two buckets. That read as a
// broken control, and it appeared and disappeared mid-session: every non-FIFA
// adapter stamps a constant `category`, and StubHub/TickPick capture in
// filtered chunks, so early scans often have one tier too. It now always
// renders, with the unswitchable side disabled.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(EXT + "popup.js", "utf8");
const css = fs.readFileSync(EXT + "popup.css", "utf8");

const down = (s) => s.replace(/(\w|\))\?\./g, "$1.").replace(/ \?\? /g, " || ");

// Minimal DOM: the function only needs one element with innerHTML plus
// querySelectorAll/addEventListener on the result.
let el;
function makeEl() {
  return {
    innerHTML: "",
    querySelectorAll: () => [],
  };
}
global.document = { getElementById: () => el };
global.escapeHtml = (s) => String(s);
// Stand-in for tiers.js: tier is the first character of the section.
global.VenueTiers = {
  tierFor: (venue, block) => "T" + String(block)[0],
  diagnose: (venue) => ({
    venue: venue || null,
    key: venue ? String(venue).toLowerCase() : "",
    matched: venue === "Michigan Stadium",
    sections: venue === "Michigan Stadium" ? 47 : 0,
  }),
};
const renderGroupToggle = eval("(" + down(extractFn(src, "renderGroupToggle")) + ")");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

const render = (seats, venue, mode) => { el = makeEl(); renderGroupToggle(seats, venue, mode); return el.innerHTML; };
const seat = (cat, block) => ({ category: cat, block, row: "1" });

out("--- the regression: one bucket on both axes ---");
// A StubHub chunk: constant category, all seats in one section.
const oneEach = [seat("resale", "101"), seat("resale", "102")];
let html = render(oneEach, "Michigan Stadium", "tier");
check("toggle still renders", html.length > 0, html.length + " chars");
check("has both buttons", (html.match(/data-group="/g) || []).length === 2,
  String((html.match(/data-group="/g) || []).length) + " button(s)");
check("Category side present", /data-group="category"/.test(html));
check("Tier side present", /data-group="tier"/.test(html));
check("the dead side is disabled", /disabled/.test(html));
check("disabled side explains itself", /title="Only one category/.test(html), (html.match(/title="[^"]*"/) || [])[0]);

out("--- the active side is never disabled ---");
html = render(oneEach, "Michigan Stadium", "tier");
const tierBtn = html.slice(html.indexOf('data-group="tier"') - 120, html.indexOf('data-group="tier"') + 40);
check("active tier button not disabled", !/disabled[^>]*data-group="tier"/.test(html), tierBtn.replace(/\s+/g, " ").trim().slice(0, 90));
html = render(oneEach, "Michigan Stadium", "category");
check("active category button not disabled when it is the mode",
  !/disabled[^>]*data-group="category"/.test(html));

out("--- both axes populated: nothing disabled ---");
const varied = [seat("CAT 1", "101"), seat("CAT 2", "301")];
html = render(varied, "Michigan Stadium", "category");
check("no disabled buttons", !/disabled/.test(html));
check("counts shown", /group-toggle-count">2</.test(html), (html.match(/group-toggle-count">\d</g) || []).join(" "));

out("--- counts are accurate ---");
const mixed = [seat("resale", "101"), seat("resale", "102"), seat("resale", "301")];
html = render(mixed, "Michigan Stadium", "tier");
// categories: {resale} = 1 ; tiers: T1 (101,102) and T3 (301) = 2
const catCell = (html.match(/Category\s*<span class="group-toggle-count">(\d+)</) || [])[1];
check("category count is 1", catCell === "1", "got " + catCell);
const tierCell = (html.match(/Tier\s*<span class="group-toggle-count">(\d+)</) || [])[1];
check("tier count is 2", tierCell === "2", "got " + tierCell);

out("--- the tier-source hint still works ---");
html = render(mixed, "Michigan Stadium", "tier");
check("matched venue named", /47 mapped sections/.test(html));
html = render(mixed, null, "tier");
check("missing venue warned", /no venue/.test(html) && /group-toggle-warn/.test(html));
html = render(mixed, "Nowhere Arena", "tier");
check("unmapped venue warned", /unmapped/.test(html) && /group-toggle-warn/.test(html));

out("--- the one-category hint reaches tier mode too ---");
// Previously this hint only rendered in category mode, i.e. not where the
// user is actually sitting on a resale site.
html = render(oneEach, "Michigan Stadium", "tier");
const hasCatHint = /one category/.test(html) || /Only one category/.test(html);
check("single-category explained in tier mode", hasCatHint);

out("--- css backs the disabled state ---");
check("disabled rule exists", /\.group-toggle-btn(:disabled|\.disabled)/.test(css));
check("hover does not re-highlight it", /\.group-toggle-btn(\.disabled|:disabled):hover/.test(css));

out("--- no stale blanking path remains ---");
// Scope this to the function: other render helpers legitimately blank their
// own containers, so scanning the whole file gives a false positive.
const fnSrc = extractFn(src, "renderGroupToggle");
check("no blanking early-return inside renderGroupToggle",
  !/innerHTML\s*=\s*""/.test(fnSrc),
  (fnSrc.match(/.*innerHTML\s*=\s*"".*/) || [""])[0].trim());

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
