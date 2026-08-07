import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// GitStudio asks its questions in its OWN dialogs, never in VS Code's.
//
// This is a guard, not a style rule. The quick input (showQuickPick /
// showInputBox) is the command palette wearing a different hat: it hijacks the
// top of the window, discards whatever you typed the moment focus moves, cannot
// complete over the refs our views already hold, and reads as "you are
// searching" when you are naming a branch. `{ modal: true }` is the same
// mistake one level up — an OS sheet unrelated to the surface you clicked.
//
// Those calls are easy to reach for and easy to reintroduce one at a time, and
// each one that slips back in is a place where the product stops feeling like
// itself. So the ban is enforced here rather than in review.
//
// Use promptInput / promptPick / promptPickMany / promptConfirm from
// src/ui/dialogs.ts instead. Non-modal toasts stay allowed: they report an
// outcome, they don't ask a question.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The dialog module itself names these APIs when explaining what it replaces. */
const EXEMPT = new Set(["ui/dialogs.ts"]);

const BANNED: { pattern: RegExp; use: string }[] = [
  {
    pattern: /vscode\.window\.showQuickPick\s*\(/,
    use: "promptPick / promptPickMany from src/ui/dialogs.ts",
  },
  {
    pattern: /vscode\.window\.createQuickPick\s*[(<]/,
    use: "promptPick from src/ui/dialogs.ts",
  },
  {
    pattern: /vscode\.window\.showInputBox\s*\(/,
    use: "promptInput from src/ui/dialogs.ts",
  },
  {
    pattern: /modal\s*:\s*true/,
    use: "promptConfirm / promptPick from src/ui/dialogs.ts",
  },
];

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line and block comments.
 *
 * Several files legitimately NAME the banned APIs while explaining why they
 * aren't used; matching raw text would make the honest comment the violation.
 * Crude but sufficient: we only need to not trip over prose, and a "//" inside a
 * string literal at worst hides a trailing violation on that same line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*$/gm, "");
}

test("no VS Code quick input or modal message box anywhere in the extension", async () => {
  const files = await tsFiles(SRC);
  assert.ok(files.length > 20, "expected to have scanned the extension sources");

  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (EXEMPT.has(rel)) {
      continue;
    }
    const code = stripComments(await readFile(file, "utf8"));
    code.split("\n").forEach((line, i) => {
      for (const { pattern, use } of BANNED) {
        if (pattern.test(line)) {
          violations.push(`${rel}:${i + 1} — ${line.trim()}\n    use ${use}`);
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `GitStudio must ask in its own dialogs, not VS Code's:\n\n${violations.join("\n\n")}\n`,
  );
});

test("the dialog host is registered at activation", async () => {
  // promptX() fails closed when no host is registered — the dialog simply never
  // appears. That degrades silently, so pin the wiring here.
  const entry = await readFile(join(SRC, "extension.ts"), "utf8");
  assert.match(entry, /registerDialogHost\(commitProvider\)/);
});
