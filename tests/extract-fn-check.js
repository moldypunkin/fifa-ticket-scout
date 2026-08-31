// The extractor is the foundation every other suite stands on, so it gets its
// own tests — including the two bugs that previously broke it.
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
let fail = 0;
const out = console.log;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; out(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else out(`ok   ${l}`);
};

out("--- brace inside a string literal (bug #1) ---");
const s1 = `function a(t) {\n  if (!t.startsWith("{")) return 0;\n  return 1;\n}\nfunction b() {}`;
eq("stops at a's real close", extractFn(s1, "a").endsWith("return 1;\n}"), true);
eq("does not swallow b", /function b/.test(extractFn(s1, "a")), false);

out("--- indentation is irrelevant (bug #2) ---");
const s2 = `      function deep() {\n            const x = { y: 1 };\n            return x;\n      }\nconst after = 1;`;
eq("extracts regardless of indent", extractFn(s2, "deep").trim().endsWith("}"), true);
eq("stops before `after`", /const after/.test(extractFn(s2, "deep")), false);

out("--- comments containing braces ---");
const s3 = `function c() {\n  // a stray { in a comment\n  /* and } here */\n  return 2;\n}\nlet z;`;
eq("comment braces ignored", extractFn(s3, "c").endsWith("return 2;\n}"), true);

out("--- template literals ---");
const s4 = "function d(x) {\n  return `val ${x} }` + '}';\n}\nlet q;";
eq("template + string braces ignored", extractFn(s4, "d").endsWith("'}';\n}"), true);

out("--- async and nesting ---");
const s5 = `async function e() {\n  for (const a of b) { if (a) { return { k: 1 }; } }\n}\n`;
eq("async supported", extractFn(s5, "e").startsWith("function e"), true);
eq("nested braces balanced", extractFn(s5, "e").trim().endsWith("}"), true);

out("--- duplicate definitions are fatal ---");
const s6 = `function f() { return 1; }\nfunction f() { return 2; }`;
let threw = null;
try { extractFn(s6, "f"); } catch (e) { threw = e.message; }
eq("throws", !!threw, true);
eq("names the lines", /lines 1, 2/.test(threw || ""), true);

out("--- missing function ---");
threw = null;
try { extractFn("function g(){}", "nope"); } catch (e) { threw = e.message; }
eq("reports not found", /not found: nope/.test(threw || ""), true);

out("--- a call is not a declaration ---");
const s7 = `function h() { return 1; }\nconst r = h();\nfoo.h(1);`;
eq("only the declaration counts", extractFn(s7, "h"), "function h() { return 1; }");

out("--- against the real files ---");
const fs = require("fs");
const dir = EXT;
for (const [file, fn] of [
  ["background.js", "siteFromUrl"], ["background.js", "facetListPrice"],
  ["background.js", "buildOfferPriceMap"], ["background.js", "saveTickPickSeats"],
  ["injected.js", "dumpShape"], ["injected.js", "toAbsoluteUrl"],
  ["event-info.js", "readEventInfo"], ["event-info.js", "pageIdentity"],
  ["popup.js", "siteFromUrl"],
]) {
  const src = fs.readFileSync(dir + file, "utf8");
  let ok = false, why = "";
  try { const body = extractFn(src, fn); ok = body.length > 10 && body.trim().endsWith("}"); }
  catch (e) { why = e.message; }
  eq(`${file}:${fn}`, ok, true);
  if (!ok && why) out("       " + why);
}

out(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
