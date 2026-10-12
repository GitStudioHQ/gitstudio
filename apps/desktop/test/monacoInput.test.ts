import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY Monaco editor the app mounts types through Monaco's textarea
 * (`editContext: false`), never Chromium's EditContext (Monaco 0.55's
 * default).
 *
 * Two reasons, both measured:
 * - VS Code delivers Cut and Paste to a webview as `document.execCommand`,
 *   which an EditContext element ignores (#84) — the shared merge and diff
 *   views run in the extension's webviews.
 * - The app's page keys (← and Esc go Back, ? opens the cheat sheet, / jumps
 *   to a filter) stand down while you type, and they tell typing by the
 *   focused element: INPUT, TEXTAREA or contentEditable. An EditContext
 *   element is a DIV that is none of those, so an editor on it looked like
 *   the page — and once some editors moved to the textarea, the same key did
 *   different things in the Split and the Unified diff.
 *
 * So one input everywhere, and a new editor that forgets it fails here. The
 * harness check `keys-typed-in-an-editor-stay-in-it` presses the keys.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const ROOTS = ["apps/desktop/src", "packages/webview-ui/src"];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The source with comments blanked out (strings kept), offsets unchanged. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The text from `open` (an opening paren or brace) to its partner. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let quote = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced from offset ${open}`);
}

const NO_EDIT_CONTEXT = /\beditContext\s*:\s*false\b/;

interface Site {
  where: string;
  ok: boolean;
}

function sites(): Site[] {
  const found: Site[] = [];
  for (const root of ROOTS) {
    for (const file of tsFiles(join(ROOT, root))) {
      const src = code(readFileSync(file, "utf8"));
      // A shared options object spread into the editors (mergeView, diffView).
      const shared = /const\s+SHARED_OPTIONS\b[^=]*=\s*\{/.exec(src);
      const sharedOk = shared ? NO_EDIT_CONTEXT.test(balanced(src, shared.index + shared[0].length - 1)) : false;
      for (const m of src.matchAll(/monaco\.editor\.(create|createDiffEditor)\s*\(/g)) {
        const call = balanced(src, m.index + m[0].length - 1);
        const line = src.slice(0, m.index).split("\n").length;
        found.push({
          where: `${relative(ROOT, file)}:${line} (${m[1]})`,
          ok: NO_EDIT_CONTEXT.test(call) || (sharedOk && /\.\.\.SHARED_OPTIONS\b/.test(call)),
        });
      }
    }
  }
  return found;
}

test("every Monaco editor in the app and its shared views uses Monaco's textarea input", () => {
  const all = sites();
  // The merge's three panes, the diff's two, the Unified diff, the Code
  // viewer: a scan that finds fewer has stopped seeing them, and would pass.
  assert.ok(all.length >= 7, `found only ${all.length} editors: ${all.map((s) => s.where).join(", ")}`);
  const bad = all.filter((s) => !s.ok).map((s) => s.where);
  assert.deepEqual(bad, [], "editors left on EditContext (pass editContext: false)");
});

test("the scan reads a forgotten option as forgotten", () => {
  const src = code(`
    // monaco.editor.create(commented, { out })
    const a = monaco.editor.create(el, { readOnly: true, label: "(x" });
    const b = monaco.editor.createDiffEditor(el, { editContext: false, renderSideBySide: false });
  `);
  const calls = [...src.matchAll(/monaco\.editor\.(create|createDiffEditor)\s*\(/g)].map((m) =>
    NO_EDIT_CONTEXT.test(balanced(src, m.index + m[0].length - 1)),
  );
  assert.deepEqual(calls, [false, true]);
});
