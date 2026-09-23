import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This package is extension code that lives outside apps/extension, so the
// extension's own census tests (noVsCodePrompts, renameBystander,
// noLiteralNulBytes) cannot see it. The same rules, applied here.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*$/gm, "");
}

async function scan(rules: { pattern: RegExp; why: string }[], exempt = new Set<string>()): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await tsFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (exempt.has(rel)) continue;
    stripComments(await readFile(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        for (const { pattern, why } of rules) {
          if (pattern.test(line)) violations.push(`${rel}:${i + 1} — ${line.trim()}\n    ${why}`);
        }
      });
  }
  return violations;
}

test("no VS Code quick input or modal: a product asks through product.ask", async () => {
  // GitStudio's ask is its own in-view dialog (apps/extension/test/noVsCodePrompts.test.ts);
  // Merge Studio's modal lives in ITS product adapter, not in shared code.
  const v = await scan([
    { pattern: /showQuickPick\s*\(/, why: "use product.ask" },
    { pattern: /createQuickPick\s*[(<]/, why: "use product.ask" },
    { pattern: /showInputBox\s*\(/, why: "use product.ask" },
    { pattern: /modal\s*:\s*true/, why: "use product.ask" },
  ]);
  assert.deepEqual(v, [], v.join("\n\n"));
});

test("documents are written only by the two surfaces that own them", async () => {
  const owners = new Set(["mergeEditorProvider.ts", "diffPanel.ts"]);
  const v = await scan(
    [
      { pattern: /workspace\.applyEdit\s*\(/, why: "edits a document this surface does not own" },
      { pattern: /\b(?:document|doc|editor\.document)\.save\s*\(\s*\)/, why: "saves a document this surface does not own" },
    ],
    owners,
  );
  assert.deepEqual(v, [], v.join("\n\n"));
});

test("nothing that takes part in another extension's rename, and nothing process-wide", async () => {
  const v = await scan([
    {
      pattern:
        /languages\.register(?:Rename|Reference|DocumentHighlight|Definition|Declaration|Implementation|TypeDefinition|LinkedEditingRange|WorkspaceSymbol|DocumentSymbol|CodeActions|DocumentFormattingEdit|DocumentRangeFormattingEdit|OnTypeFormattingEdit)Provider\s*\(/,
      why: "takes part in another extension's rename / edit application",
    },
    { pattern: /workspace\.onWill(?:SaveTextDocument|RenameFiles|CreateFiles|DeleteFiles)\b/, why: "a will-participant" },
    { pattern: /workbench\.action\.files\.revert/, why: "reverts a document another extension may have edited" },
    {
      pattern: /process\.chdir\s*\(|process\.env\.[A-Za-z_]+\s*=[^=]|process\.env\[[^\]]+\]\s*=[^=]/,
      why: "process-wide state in a shared extension host",
    },
  ]);
  assert.deepEqual(v, [], v.join("\n\n"));
});

test("no source file contains a literal NUL byte (grep would skip it as binary)", async () => {
  const offenders: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if ((await readFile(file)).indexOf(0) >= 0) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, []);
});

test("the vscode-free modules really load without vscode (their tests depend on it)", async () => {
  // A runtime `import * as vscode` anywhere in these modules' graphs throws
  // "Cannot find module 'vscode'" here — which is exactly how they would fail
  // to be testable.
  for (const m of [
    "product",
    "autoRoute",
    "exitGuard",
    "payload",
    "mergeSession",
    "dashboardController",
    "outcome",
    "stageResolved",
    "gitWatch",
    "contract",
    "demoContent",
  ]) {
    await assert.doesNotReject(import(`../src/${m}`), `${m}.ts must stay vscode-free`);
  }
});
