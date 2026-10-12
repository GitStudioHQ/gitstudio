// Diffs GitStudio opens from its own views keep VS Code's diff editor when
// the default diff viewer setting (gitstudio.merge.useAsDefaultDiffViewer)
// is on: the router in @gitstudio/merge-vscode/diffAutoRoute leaves alone a
// diff marked with ownDiffs.ts just before it opens. There, the Changes list
// keeps its staging tools and keyboard focus stays in the diff.
//
//   · every opener marks the diff it opens, at the moment it opens it;
//   · nothing in the extension runs `vscode.diff` around the mark: a new
//     opener (or one rewritten in a merge) that calls it directly is named.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- the stand-in is in place (changesHost) */
const vscode = require("vscode") as Record<string, Record<string, unknown>>;
const own = require("@gitstudio/merge-vscode/ownDiffs") as typeof import("@gitstudio/merge-vscode/ownDiffs");
const rev = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { openCompareFileDiff } = require("../src/compare/refCompare") as typeof import("../src/compare/refCompare");
const review = require("../src/pr/reviewDiff") as typeof import("../src/pr/reviewDiff");
/* eslint-enable @typescript-eslint/no-require-imports */

// URIs with a real toString, so a mark is told apart from any other diff.
type U = { scheme: string; path: string; query: string; fsPath: string; toString(): string };
const uri = (c: { scheme: string; path: string; query?: string }): U => ({
  scheme: c.scheme,
  path: c.path,
  query: c.query ?? "",
  fsPath: c.path,
  toString: () => `${c.scheme}://${c.path}${c.query ? `?${c.query}` : ""}`,
});
Object.assign(vscode.Uri, { from: uri, file: (p: string) => uri({ scheme: "file", path: p }) });

/** Each `vscode.diff` run, and whether its two sides were marked as GitStudio's own when it ran. */
const opened: { left: string; right: string; marked: boolean }[] = [];
vscode.commands.executeCommand = (async (id: string, ...args: unknown[]) => {
  if (id !== "vscode.diff") return;
  const [left, right] = [String(args[0]), String(args[1])];
  opened.push({ left, right, marked: own.isOwnDiff(left, right) });
}) as never;

test("every GitStudio opener marks the diff it opens as its own", async () => {
  const root = "/w/repo";
  const cases: [string, () => Promise<void>][] = [
    // The Changes list, the graph's and the commit window's files, blame, line history, worktrees.
    ["openSidesDiff", () => rev.openSidesDiff(root, "a.ts", { left: { rev: "HEAD" }, right: { rev: undefined } }, "a.ts (Working Tree)")],
    // File history Back/Forward, Open File at Revision.
    ["openRevisionDiff", () => rev.openRevisionDiff(root, "b.ts", "HEAD~1", "HEAD")],
    // Compare branches.
    ["openCompareFileDiff", () => openCompareFileDiff({ root, refA: "main", refB: "feature", path: "c.ts" })],
    // Pull request review and a PR's commit.
    ["openPrFileDiff", () => review.openPrFileDiff({ owner: "o", repo: "r" }, { number: 7, headSha: "h".repeat(40) }, { filename: "d.ts" } as never, "b".repeat(40))],
    ["openCommitFileDiff", () => review.openCommitFileDiff({ owner: "o", repo: "r" }, { sha: "c".repeat(40), short: "ccccccc" }, "p".repeat(40), { filename: "e.ts" } as never)],
  ];
  const unmarked: string[] = [];
  for (const [name, open] of cases) {
    const before = opened.length;
    await open();
    assert.equal(opened.length, before + 1, `${name} opened one diff`);
    if (!opened[before].marked) unmarked.push(name);
  }
  assert.deepEqual(unmarked, []);
});

test("the Timeline's GitStudio entries open through the internal command that marks the diff", () => {
  const src = (p: string): string => readFileSync(join(__dirname, "..", "src", p), "utf8");
  assert.equal(rev.OPEN_NATIVE_DIFF_COMMAND, "gitstudio.openNativeDiff");
  assert.match(src("history/fileTimelineProvider.ts"), /command: OPEN_NATIVE_DIFF_COMMAND,/);
  assert.match(src("extension.ts"), /registerCommand\(OPEN_NATIVE_DIFF_COMMAND, openWithoutRouting\)/);
});

test("nothing in the extension runs vscode.diff around the mark", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  const srcDir = join(__dirname, "..", "src");
  walk(srcDir);
  const direct: string[] = [];
  for (const file of files) {
    // Comments may name it; code may not run it (executeCommand) or hand it to VS Code to run (a command object).
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/executeCommand\(\s*["'`]vscode\.diff["'`]|command:\s*["'`]vscode\.diff["'`]/.test(code)) {
      direct.push(file.slice(srcDir.length + 1));
    }
  }
  assert.deepEqual(direct, [], "open GitStudio's diffs with openWithoutRouting (@gitstudio/merge-vscode/ownDiffs)");
});
