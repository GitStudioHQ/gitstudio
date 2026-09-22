import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The shared merge surfaces paint from a `--vscode-*` vocabulary, and the
 * desktop has no editor to supply it — the desktop's app.css must.
 *
 * An undeclared `var(--vscode-x)` with no fallback is invalid at computed-value
 * time: the property simply does not apply, and nothing says so. That is how a
 * tag chip in the graph once rendered as bare body text in the light theme
 * (memory: shared-package-token-boundary). The merge toolbar was the next one
 * in line: its primary button reads `var(--vscode-button-background)` with no
 * fallback, and the desktop had never mounted it — so on the desktop, Apply
 * would have been a transparent button.
 *
 * `apps/desktop/test/cssTokens.test.ts` checks the desktop's own stylesheet and
 * tokens.css. This checks the three stylesheets the merge experience adds on
 * top: every `--vscode-*` they use bare must be declared by the desktop, and
 * every bare `--gs-*` must be declared by the shared tokens (or the desktop).
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SHARED = {
  "shell.css": read("../src/styles/shell.css"),
  "conflicts.css": read("../src/styles/conflicts.css"),
  "diff.css": read("../src/styles/diff.css"),
};
const TOKENS = read("../src/styles/tokens.css");
const DESKTOP = read("../../../apps/desktop/src/renderer/styles/app.css");

const declared = (css: string): Set<string> =>
  new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));

/** Names used as `var(--name)` with NO fallback. */
function bare(css: string, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
    if (m[1].startsWith(prefix)) out.add(m[1]);
  }
  return out;
}

test("every bare --vscode-* the merge stylesheets use is declared by the desktop", () => {
  const desktop = declared(DESKTOP);
  const missing: string[] = [];
  for (const [file, css] of Object.entries(SHARED)) {
    const own = declared(css);
    for (const name of bare(css, "--vscode-")) {
      if (!desktop.has(name) && !own.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(
    missing.sort(),
    [],
    "the desktop does not declare these, and they have no fallback — on the desktop the property " +
      `silently does not apply:\n${missing.join("\n")}`,
  );
});

test("every bare --gs-* the merge stylesheets use is declared by the shared tokens", () => {
  const known = new Set([...declared(TOKENS), ...declared(DESKTOP)]);
  const missing: string[] = [];
  for (const [file, css] of Object.entries(SHARED)) {
    const own = declared(css);
    for (const name of bare(css, "--gs-")) {
      if (!known.has(name) && !own.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(missing.sort(), [], `undeclared tokens: ${missing.join(", ")}`);
});

test("the census sees the stylesheets it claims to check", () => {
  // A check that matches nothing passes forever.
  for (const [file, css] of Object.entries(SHARED)) {
    assert.ok(/var\(\s*--vscode-/.test(css), `${file} uses no --vscode-* at all — has it moved?`);
  }
  assert.ok(declared(DESKTOP).has("--vscode-foreground"), "the desktop stylesheet was read");
});
