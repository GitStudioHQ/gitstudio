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

/** `--name: value;` pairs declared inside the first rule whose selector matches `selector`. */
function declsIn(css: string, selector: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.set(d[1], d[2].replace(/\s+/g, " ").trim());
    }
    break;
  }
  return out;
}

/**
 * tokens.css derives its --gs-* colours on `:root` from --vscode-* names. The
 * desktop declares those names on BODY, where a :root declaration cannot see
 * them — so on the desktop every such token computed to nothing (the
 * dashboard's conflict dot was transparent). The desktop re-derives them on
 * the merge components' roots. This pins that every bare --gs-* the merge
 * stylesheets use, whose shared definition leans on a --vscode-* name, is in
 * that block — with tokens.css's own formula, so the two cannot drift.
 */
test("the desktop re-derives, on the merge roots, every host-derived token the merge stylesheets use", () => {
  const root = declsIn(TOKENS, /^:root$/);
  const desktop = declsIn(DESKTOP, /^\.ms-shell,\s*\.cd-dash$/);
  // Tokens the desktop supplies itself with a literal (--gs-accent on :root,
  // --gs-amber per theme) resolve anyway. Everything else must be re-derived.
  const ownLiterals = new Set(
    [...DESKTOP.replace(/\.ms-shell,\s*\.cd-dash\s*\{[^}]*\}/, "").matchAll(/(--gs-[a-zA-Z0-9-]+)\s*:\s*#/g)].map((m) => m[1]),
  );
  assert.ok(root.size > 10 && desktop.size > 0, "both blocks were found");
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const [file, css] of Object.entries(SHARED)) {
    for (const name of bare(css, "--gs-")) {
      const shared = root.get(name);
      if (!shared || !/var\(--vscode-|var\(--gs-(fg|bg)\b/.test(shared)) continue;
      if (!desktop.has(name) && !ownLiterals.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  for (const [name, value] of desktop) {
    if (root.get(name) !== value) drifted.push(`${name}: desktop "${value}" vs tokens.css "${root.get(name)}"`);
  }
  assert.deepEqual(missing.sort(), [], `not re-derived on .ms-shell/.cd-dash:\n${missing.join("\n")}`);
  assert.deepEqual(drifted, [], `re-derived differently from tokens.css:\n${drifted.join("\n")}`);
});

test("the desktop harness proves EVERY --gs-* the merge stylesheets use resolves (its list is complete)", () => {
  // The textual checks above see only BARE uses and the first :root block; a
  // token defined in a later block (or used with a fallback that itself does
  // not resolve) slips past them. The harness check
  // the-merge-surfaces-resolve-every-shared-token reads the COMPUTED value of
  // each token inside the real dashboard, merge shell and legend, in both
  // themes — this pins its list against the stylesheets.
  const checks = readFileSync(
    fileURLToPath(new URL("../../../apps/desktop/harness/checks.js", import.meta.url)),
    "utf8",
  );
  const listed = new Set(
    [...(/const MERGE_SHARED_TOKENS = \[([\s\S]*?)\];/.exec(checks)?.[1] ?? "").matchAll(/"(--gs-[a-zA-Z0-9-]+)"/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(listed.size > 10, "the harness list was found");
  const used = new Set<string>();
  for (const css of Object.values(SHARED)) {
    for (const m of css.matchAll(/var\(\s*(--gs-[a-zA-Z0-9-]+)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((t) => !listed.has(t)).sort();
  const stale = [...listed].filter((t) => !used.has(t)).sort();
  assert.deepEqual(missing, [], `the harness does not check: ${missing.join(", ")}`);
  assert.deepEqual(stale, [], `the harness checks tokens no merge stylesheet uses: ${stale.join(", ")}`);
});

test("the census sees the stylesheets it claims to check", () => {
  // A check that matches nothing passes forever.
  for (const [file, css] of Object.entries(SHARED)) {
    assert.ok(/var\(\s*--vscode-/.test(css), `${file} uses no --vscode-* at all — has it moved?`);
  }
  assert.ok(declared(DESKTOP).has("--vscode-foreground"), "the desktop stylesheet was read");
});
