import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, "../src/renderer/styles/app.css"), "utf8");

/**
 * A `var(--name)` naming a token nothing declares is invisible: the property
 * simply does not apply, and the element silently keeps whatever it inherited.
 *
 * This is not hypothetical. The staging checkbox — the entire staging model in
 * that mode — asked for `accent-color: var(--accent)` when the token is
 * `--gs-accent`, so the most-clicked control in the app rendered as a stock
 * macOS blue tick in a purple app. The hunk rows beside it reached for
 * `var(--hover)`, `var(--border)`, `var(--fg)` and `var(--fg-muted)`, none of
 * which this stylesheet has ever declared, so they had no hover feedback and no
 * left rule at all. Every one of those looked like a design choice.
 *
 * A fallback (`var(--x, red)`) is a deliberate opt-out and is allowed; a bare
 * reference to a name nobody declares is the bug.
 */
test("every CSS variable is declared, or carries a fallback", () => {
  // Strip comments first: this file documents the bug above by quoting the
  // broken declaration, and a comment is not a use.
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const bare = new Set(
    [...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)].map((m) => m[1]),
  );
  const missing = [...bare].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `these tokens are used with no declaration and no fallback: ${missing.join(", ")}`,
  );
});

/**
 * The desktop consumes a handful of VS Code semantic names from the shared CSS
 * it inherited from the extension. Undeclared, each one fell through to a
 * literal tuned for a dark editor — which is how "Sign out" ended up a 3.61:1
 * red on the LIGHT page. Both themes must state them.
 */
test("the VS Code semantic inks are declared in both themes", () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = css.slice(css.indexOf("body.vscode-light {"));
  assert.ok(light.length > 0, "the light theme block exists");
  for (const token of ["--vscode-errorForeground", "--vscode-editorError-foreground"]) {
    assert.ok(
      new RegExp(`${token}\\s*:`).test(css),
      `${token} is declared for the dark theme`,
    );
    assert.ok(
      new RegExp(`${token}\\s*:`).test(light),
      `${token} is re-declared for the light theme`,
    );
  }
});
