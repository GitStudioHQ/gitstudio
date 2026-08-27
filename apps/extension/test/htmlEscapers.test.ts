// Every panel in this extension builds HTML by concatenating strings, and each
// one carries its own little `esc()` because most of them live inside a webview
// script that cannot import anything. Five copies of the same three-line
// function is a shape where one copy quietly falls out of step — and one had:
//
//   apps/extension/src/ai/aiCommands.ts escaped & < > but not the QUOTE, so a
//   markdown link URL walked straight out of the href it was written into:
//     [t](https://a"onmouseover="alert(1))
//   became  <a href="https://a"onmouseover="alert(1" …>  — a live handler on
//   the anchor. The webview CSP (script-src with a nonce, no 'unsafe-inline')
//   meant it would not have run, but the markup should never have been built.
//
// An escaper that misses `"` is only safe if its output never lands in an
// attribute, and that is not a property anyone can keep true by hand across
// five files. So it is checked here instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The body of every `function esc(...)`, wherever it is declared. */
function escapers(): Array<{ file: string; body: string; line: number }> {
  const found: Array<{ file: string; body: string; line: number }> = [];
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8");
    const re = /function\s+esc\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const brace = src.indexOf("{", m.index + m[0].length);
      if (brace < 0) continue;
      let depth = 1;
      let i = brace + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      found.push({
        file: relative(ROOT, file),
        body: src.slice(brace, i),
        line: src.slice(0, m.index).split("\n").length,
      });
    }
  }
  return found;
}

test("the extension has the html escapers we think it does", () => {
  const all = escapers();
  assert.ok(
    all.length >= 4,
    `expected several esc() definitions, found ${all.length} — has the declaration style changed?`,
  );
});

test("every esc() escapes the quote, not just the angle brackets", () => {
  const failures = escapers()
    .filter((e) => !/&quot;|&#0*34;/.test(e.body))
    .map((e) => `${e.file}:${e.line}`);
  assert.deepEqual(
    failures,
    [],
    `these escapers leave " intact, so anything they escape is unsafe in an ` +
      `attribute: ${failures.join(", ")}`,
  );
});

test("every esc() escapes the ampersand first", () => {
  // `&` has to go first or the escaper double-encodes its own output:
  // "<" -> "&lt;" -> "&amp;lt;" if & is replaced after <.
  for (const e of escapers()) {
    const amp = e.body.search(/&amp;/);
    const lt = e.body.search(/&lt;/);
    if (amp < 0 || lt < 0) continue;
    assert.ok(
      amp < lt,
      `${e.file}:${e.line} replaces & after < — its own output gets re-escaped`,
    );
  }
});

test("every esc() covers the four characters that matter", () => {
  for (const e of escapers()) {
    for (const [what, re] of [
      ["&", /&amp;/],
      ["<", /&lt;/],
      [">", /&gt;/],
      ['"', /&quot;|&#0*34;/],
    ] as Array<[string, RegExp]>) {
      assert.match(e.body, re, `${e.file}:${e.line} does not escape ${what}`);
    }
  }
});
