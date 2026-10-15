// The section filter box above the category tabs.
//
// It is applied once in renderDashboard, before the stats, the category tabs,
// the best deals and the block table are drawn, so every source gets it and
// every panel shows the same seats. The matching has to cope with how
// differently the sources write a section: a bare "114" on TicketsForLess, a
// prefixed "Club 114" on a marketplace, "NS:33" on Evenue before the prefix is
// stripped.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const html = fs.readFileSync(EXT + "popup.html", "utf8");
const css = fs.readFileSync(EXT + "popup.css", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

global.escapeRegExp = eval("(" + extractFn(popup, "escapeRegExp") + ")");
const terms = eval("(" + extractFn(popup, "sectionFilterTerms") + ")");
const matches = eval("(" + extractFn(popup, "seatMatchesSection") + ")");
const hit = (filter, block) => matches({ block }, terms(filter));

out("--- what the user types ---");
check("one section", JSON.stringify(terms("114")) === '["114"]');
check("a comma list", JSON.stringify(terms("114, 115")) === '["114","115"]');
check("spaces work too", JSON.stringify(terms("114 115")) === '["114","115"]');
check("case is ignored", JSON.stringify(terms("club a")) === '["CLUB","A"]');
check("empty is no filter", terms("").length === 0);
check("spaces alone are no filter", terms("   ").length === 0);

out("");
out("--- matching a seat's block ---");
check("exact", hit("114", "114"));
check("a different section does not match", !hit("114", "214"));
check("115 is not 114", !hit("114", "115"));
// Marketplaces prefix the level onto the section.
check("finds the number inside a prefixed block", hit("114", "Club 114"));
check("and inside an Evenue block", hit("33", "NS:33"));
check("lower case input", hit("club", "Club 114"));
// Typing narrows as you go: "11" should still be showing 114 and 115.
check("a partial number still narrows", hit("11", "114") && hit("11", "115"));
// But a single character must not: "C" would otherwise match Club, Concourse
// and every section with a C in it.
check("a single letter does not match everything", !hit("C", "Club 114"));
check("a single letter still matches itself", hit("C", "C"));
check("several terms are an OR", hit("114, 115", "115") && !hit("114, 115", "116"));
check("no filter keeps every seat", hit("", "anything"));
check("a seat with no block is dropped by a filter", !hit("114", ""));
check("and kept when there is no filter", hit("", ""));
// Regex characters in a section name must not blow up the match.
check("a section with a regex character is literal", hit("A+", "A+") === true);
check("and does not match a different one", !hit("A+", "AAA"));

out("");
out("--- applied to the whole dashboard, once ---");
const applyFn = extractFn(popup, "applySectionFilter");
check("there is a single apply step", /seats\.filter\(/.test(applyFn));
// If this moves below any of the renderers, the panels stop agreeing: the
// stats would count every seat while the deals list shows one section.
const dash = extractFn(popup, "renderDashboard");
const atApply = dash.indexOf("applySectionFilter");
check("filtered before anything is rendered", atApply !== -1
  && atApply < dash.indexOf("renderStatsBar")
  && atApply < dash.indexOf("renderCategorySections")
  && atApply < dash.indexOf("renderBlockTable")
  && atApply < dash.indexOf("renderMatchInfo"));
check("the seat count in the header follows the filter",
  /renderMatchInfo\(match, seats\.length\)/.test(dash));
// Every source stores the section in `block`, so none needs its own handling.
check("matches on block, which every parser fills", /seat && seat\.block/.test(
  extractFn(popup, "seatMatchesSection")));

out("");
out("--- the box itself ---");
check("input in the markup", /id="sectionFilter"/.test(html));
// It must live in popup.html, not in rendered html: the dashboard redraws on
// every keystroke, and an input inside that html would lose focus each time.
check("it is not rebuilt by the renderers", !/id="sectionFilter"/.test(popup)
  || !/innerHTML[\s\S]{0,200}id="sectionFilter"/.test(popup));
check("a clear button", /id="sectionFilterClear"/.test(html));
check("a count beside it", /id="sectionFilterInfo"/.test(html));
check("styled", /\.section-filter-input/.test(css) && /\.section-filter-row/.test(css));
check("the no-match state is styled", /\.section-filter-input\.no-match/.test(css));
check("wired once", /input\.dataset\.wired/.test(popup));
check("escape clears it", /e\.key === "Escape"/.test(popup));
// "no seats in 114" is the difference between a filter that matched nothing
// and an event that captured nothing.
check("an empty result says so", /no seats in \$\{terms\.join/.test(popup));
// A filter restored from last session looks exactly like a broken capture.
check("not persisted to storage", !/filters:[\s\S]{0,120}sectionFilter/.test(popup)
  && !/sectionFilter:/.test(popup));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
