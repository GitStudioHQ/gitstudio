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
 * The shared packages speak a VS Code vocabulary the desktop has to supply.
 *
 * `packages/webview-ui/src/styles/tokens.css` derives its whole palette from
 * `--vscode-*` names — in the extension the editor provides them; in the desktop
 * nobody does. Undeclared, each resolves to `var(undefined)`, which is invalid
 * at computed-value time: the property does not apply and the element silently
 * keeps whatever it inherited. `--gs-amber` is
 * `var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow))`,
 * and with neither declared a tag chip in the Commits graph rendered as bare
 * body text in the light theme — no ink, no pill, nothing in the source saying
 * why.
 *
 * This asserts the desktop declares every name the shared file consumes, so the
 * next one added upstream fails here instead of quietly rendering as nothing.
 */
test("the desktop declares every --vscode-* the shared tokens consume", () => {
  const shared = readFileSync(
    resolve(HERE, "../../../packages/webview-ui/src/styles/tokens.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const consumed = new Set(
    [...shared.matchAll(/var\(\s*(--vscode-[a-zA-Z0-9-]+)/g)].map((m) => m[1]),
  );
  assert.ok(consumed.size > 10, `the shared file consumes VS Code names (${consumed.size})`);
  const declared = new Set(
    [...css.matchAll(/(--vscode-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  const missing = [...consumed].filter((t) => !declared.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `the desktop never declares these, so they render as nothing: ${missing.join(", ")}`,
  );
});
