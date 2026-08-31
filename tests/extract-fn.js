// Pull a function's source out of a file, for testing shipped code directly.
//
// History matters here:
//   1. Naive brace counting broke on `head.startsWith("{")` — a brace inside a
//      string literal.
//   2. Terminating on a closing brace at a fixed indent fixed that, then broke
//      when the files were reformatted upstream.
// So: count braces, but skip strings, template literals and comments. That is
// indentation-independent AND string-safe.
//
// It also HARD FAILS on duplicate definitions. A bad splice once left two
// copies of dumpShape in injected.js; the browser ran the second (stale) one
// while this helper silently read the first, so every test passed while the
// extension behaved as it had before the fix.
function findDeclarations(src, name) {
  // Scanned rather than regexed: the pattern needs several backslash escapes
  // and those do not survive every editing route intact.
  const needle = "function " + name;
  const isWord = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);
  const hits = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;

    // The char after the name must end it: `function foo(` not `function fooBar(`.
    let j = at + needle.length;
    while (src[j] === " ") j++;
    if (src[j] !== "(") continue;

    // What precedes must not make this a property or a longer word:
    // `obj.function`, `myfunction`. `async function` is fine.
    const before = src.slice(Math.max(0, at - 12), at);
    const prevChar = before.length ? before[before.length - 1] : "";
    if (isWord(prevChar) || prevChar === ".") continue;

    hits.push(at);
  }
  return hits;
}

module.exports = function extractFn(src, name /* , indent (ignored, kept for callers) */) {
  const hits = findDeclarations(src, name);
  if (hits.length === 0) throw new Error("not found: " + name);
  if (hits.length > 1) {
    const lines = hits.map((i) => src.slice(0, i).split("\n").length);
    throw new Error(
      `DUPLICATE DEFINITION: "${name}" declared ${hits.length} times ` +
      `(lines ${lines.join(", ")}). The browser runs the last one; this helper ` +
      `would have read the first.`
    );
  }

  const start = hits[0];
  let i = src.indexOf("{", start);
  if (i < 0) throw new Error("no body for " + name);

  let depth = 0;
  let quote = null;      // ' " or `
  let lineComment = false;
  let blockComment = false;

  for (; i < src.length; i++) {
    const c = src[i], next = src[i + 1];

    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === "\\") { i++; continue; }          // escaped char
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { lineComment = true; i++; continue; }
    if (c === "/" && next === "*") { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }

    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
};
module.exports.findDeclarations = findDeclarations;
