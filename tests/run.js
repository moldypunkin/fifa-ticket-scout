// Run every *-check.js in this directory and summarise.
//
//   node tests/run.js            all suites
//   node tests/run.js stubhub    only suites whose name contains "stubhub"
//
// Each suite is a standalone script that exits non-zero on failure, so they
// can also be run individually when one is being debugged.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const filter = process.argv[2] || "";
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith("-check.js"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.log(filter ? `no suites match "${filter}"` : "no suites found");
  process.exit(1);
}

let passed = 0;
const failed = [];
for (const f of files) {
  let ok = true, output = "";
  try {
    output = execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8" });
  } catch (e) {
    ok = false;
    output = (e.stdout || "") + (e.stderr || "");
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${f}`);
  if (ok) passed++;
  else {
    failed.push(f);
    // Only the failing lines, so one broken suite does not bury the summary.
    const lines = output.split("\n").filter((l) => /^FAIL|Error|Cannot find/.test(l));
    for (const l of lines.slice(0, 6)) console.log(`        ${l}`);
  }
}

console.log(`\n${passed}/${files.length} suites passing`);
if (failed.length) {
  console.log(`failing: ${failed.join(", ")}`);
  process.exit(1);
}
