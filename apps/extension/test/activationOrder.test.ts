import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// activate() wires dozens of pieces in one long function, and a closure that
// reaches a `const` declared FURTHER DOWN is a temporal dead zone: the merge
// experience's refresh hook closed over `stagingRefresh` about 140 lines
// before it existed. Safe only while nothing called the hook before that line
// ran — and if activation threw in between, the hook threw ReferenceError for
// the rest of the session. The binding is now declared before its first use.

const src = readFileSync(fileURLToPath(new URL("../src/extension.ts", import.meta.url)), "utf8");

test("stagingRefresh is declared before anything closes over it", () => {
  const decl = src.search(/\b(const|let) stagingRefresh\b/);
  assert.ok(decl > 0, "declared in extension.ts");
  const uses = [...src.matchAll(/\bstagingRefresh\b(?!:)/g)].map((m) => m.index ?? 0).filter((i) => i !== decl + src.slice(decl).indexOf("stagingRefresh"));
  const code = uses.filter((i) => {
    // Ignore mentions in comments.
    const lineStart = src.lastIndexOf("\n", i) + 1;
    return !/^\s*(\/\/|\*)/.test(src.slice(lineStart, i));
  });
  const first = Math.min(...code);
  assert.ok(decl < first, `first use at ${first} precedes the declaration at ${decl}`);
});
