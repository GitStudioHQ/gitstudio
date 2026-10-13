// Where GitStudio's diffs open once the default diff viewer
// (gitstudio.merge.useAsDefaultDiffViewer) is on: each GitStudio view is a
// place in gitstudio.diff.comparisonIn, and every diff it opens goes through
// openDiff (src/merge/diffPlaces.ts) with that place. openDiff marks the diff
// for the router (@gitstudio/merge-vscode/ownDiffs): routable, with whether
// it was to take focus, where the place is ticked; VS Code's diff editor
// where it is not. Pull request diffs always keep VS Code's diff editor.
//
//   · the openers that run as functions mark their diff per the setting;
//   · every opener in the source names the place it belongs to;
//   · the setting's schema lists exactly the places the openers use;
//   · nothing runs `vscode.diff` (or the router's two primitives) around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- the stand-in is in place (changesHost) */
const vscode = require("vscode") as Record<string, Record<string, unknown>>;
const own = require("@gitstudio/merge-vscode/ownDiffs") as typeof import("@gitstudio/merge-vscode/ownDiffs");
const places = require("../src/merge/diffPlaces") as typeof import("../src/merge/diffPlaces");
const rev = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { openCompareFileDiff } = require("../src/compare/refCompare") as typeof import("../src/compare/refCompare");
const review = require("../src/pr/reviewDiff") as typeof import("../src/pr/reviewDiff");
const { openChangeDiff, ChangeFileNode } = require("../src/changes/changesView") as typeof import("../src/changes/changesView");
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

/** gitstudio.diff.comparisonIn as the user set it (undefined: the default, every place ticked). */
let comparisonIn: Record<string, boolean> | undefined;
Object.assign(vscode.workspace, {
  getConfiguration: (section: string) => ({
    get: (key: string) => (section === "gitstudio.diff" && key === "comparisonIn" ? comparisonIn : undefined),
  }),
  // The working files these tests name: on disk unless their name says "gone".
  fs: { stat: async (u: U) => { if (/gone/.test(u.path)) throw new Error("ENOENT"); return {}; } },
});

/** Each `vscode.diff` run, and how its two sides were marked when it ran. */
const opened: { left: string; right: string; own: boolean; routable?: { focus: boolean } }[] = [];
vscode.commands.executeCommand = (async (id: string, ...args: unknown[]) => {
  if (id !== "vscode.diff") return;
  const [left, right] = [String(args[0]), String(args[1])];
  opened.push({ left, right, own: own.isOwnDiff(left, right), routable: own.routableIntent(left, right) });
}) as never;

/** How one open was marked: "routable+focus", "routable" (keeps focus) or "own". */
async function markOf(open: () => Promise<unknown>): Promise<string> {
  const before = opened.length;
  await open();
  assert.equal(opened.length, before + 1, "one diff opened");
  const d = opened[before];
  if (d.routable && !d.own) return d.routable.focus ? "routable+focus" : "routable";
  if (d.own && !d.routable) return "own";
  return `confused ${JSON.stringify(d)}`;
}

const root = "/w/repo";
const file = (rel: string) => uri({ scheme: "file", path: `${root}/${rel}` });
const gitUri = (u: U, ref: string): U => uri({ scheme: "git", path: u.path, query: `ref=${ref}` });
const MODIFIED = 5, INDEX_MODIFIED = 0;
/** Every kind of Changes-list row, on vscode.git's URIs where it has them and on GitStudio's otherwise. */
const changesRows = (): [string, () => Promise<void>][] => [
  ["unstaged modified (vscode.git)", () => openChangeDiff(new ChangeFileNode("unstaged", root, { uri: file("a.ts"), status: MODIFIED } as never), gitUri as never)],
  ["staged modified (vscode.git)", () => openChangeDiff(new ChangeFileNode("staged", root, { uri: file("b.ts"), status: INDEX_MODIFIED } as never), gitUri as never)],
  ["staged rename", () => openChangeDiff(new ChangeFileNode("staged", root, { uri: file("new.ts"), originalUri: file("old.ts") } as never), gitUri as never)],
  ["unstaged deleted", () => openChangeDiff(new ChangeFileNode("unstaged", root, { uri: file("gone.txt") } as never), gitUri as never)],
  ["unstaged, before vscode.git", () => openChangeDiff(new ChangeFileNode("unstaged", root, { uri: file("c.ts") } as never))],
  ["merge", () => openChangeDiff(new ChangeFileNode("merge", root, { uri: file("m.ts") } as never))],
];
const functionOpeners = (): [string, () => Promise<void>][] => [
  ...changesRows().map(([what, open]): [string, () => Promise<void>] => [`changes: ${what}`, open]),
  ["history: openRevisionDiff", () => rev.openRevisionDiff(root, "h.ts", "HEAD~1", "HEAD")],
  ["compare: openCompareFileDiff", () => openCompareFileDiff({ root, refA: "main", refB: "feature", path: "c.ts" })],
  ["pullRequests: openPrFileDiff", () => review.openPrFileDiff({ owner: "o", repo: "r" }, { number: 7, headSha: "h".repeat(40) }, { filename: "d.ts" } as never, "b".repeat(40))],
  ["pullRequests: openCommitFileDiff", () => review.openCommitFileDiff({ owner: "o", repo: "r" }, { sha: "c".repeat(40), short: "ccccccc" }, "p".repeat(40), { filename: "e.ts" } as never)],
];

test("every place ticked (the default): GitStudio's diffs are routable and move focus; pull requests keep VS Code's diff editor", async () => {
  comparisonIn = undefined;
  const got: string[] = [];
  for (const [what, open] of functionOpeners()) got.push(`${what} → ${await markOf(open)}`);
  assert.deepEqual(got, functionOpeners().map(([what]) => `${what} → ${what.startsWith("pullRequests") ? "own" : "routable+focus"}`));
});

test("a place unticked keeps VS Code's diff editor there, and only there", async () => {
  comparisonIn = { changes: false };
  const got: string[] = [];
  for (const [what, open] of functionOpeners()) got.push(`${what} → ${await markOf(open)}`);
  assert.deepEqual(got, functionOpeners().map(([what]) => `${what} → ${what.startsWith("changes") || what.startsWith("pullRequests") ? "own" : "routable+focus"}`));
  comparisonIn = { history: false, compare: false };
  assert.equal(await markOf(() => rev.openRevisionDiff(root, "h.ts", "HEAD~1", "HEAD")), "own");
  assert.equal(await markOf(() => openCompareFileDiff({ root, refA: "main", refB: "feature", path: "c.ts" })), "own");
  assert.equal(await markOf(changesRows()[0][1]), "routable+focus");
  comparisonIn = undefined;
});

test("openDiff passes the opener's focus intent on: preserveFocus keeps focus where it is", async () => {
  comparisonIn = undefined;
  assert.equal(await markOf(() => places.openDiff(file("s.ts"), file("t.ts"), "s", { preview: true, preserveFocus: true }, "stashes")), "routable");
  assert.equal(await markOf(() => places.openDiff(file("s.ts"), file("u.ts"), "s", { preview: true }, "stashes")), "routable+focus");
});

// ── The source: each opener's place ──

const srcDir = join(__dirname, "..", "src");
function sources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p.slice(srcDir.length + 1));
    }
  };
  walk(srcDir);
  return files;
}
/** Code without comments. */
const code = (rel: string): string =>
  readFileSync(join(srcDir, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** The argument lists of every call to `fn` (balanced parentheses; good enough for this source). */
function callArgs(text: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.]|function )${fn}\\(`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    for (let i = m.index + fn.length; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        out.push(text.slice(m.index + fn.length + 1, i));
        break;
      }
    }
  }
  return out;
}
/** The place a call names: its last argument, a string literal. */
const placeOf = (args: string): string | undefined => /,\s*"([A-Za-z]+)",?\s*$/.exec(args)?.[1];

/** Which place each file's openers belong to. */
const EXPECTED: Record<string, string> = {
  "changes/changesView.ts": "changes",
  "graph/graphPanel.ts": "graph",
  "views/stashesView.ts": "stashes",
  "history/lineHistory.ts": "history",
  "history/revisionNavigation.ts": "history",
  "history/revisionContentProvider.ts": "history",
  "extension.ts": "history",
  "blame/blameController.ts": "blame",
  "compare/refCompare.ts": "compare",
  "views/worktreesWebview.ts": "worktrees",
  "changes/commitView.ts": "push",
  "pr/reviewDiff.ts": "pullRequests",
  "pr/prCreatePage.ts": "pullRequests",
};

test("every opener in the source names its place, and the place of the view it is in", () => {
  const found: Record<string, string[]> = {};
  for (const rel of sources()) {
    if (rel === "merge/diffPlaces.ts") continue;
    const text = code(rel);
    const calls = [...callArgs(text, "openDiff"), ...callArgs(text, "openSidesDiff")];
    // A call that hands its own `place` parameter on is the helper itself (openSidesDiff).
    const named = calls.filter((a) => !/,\s*place,?\s*$/.test(a));
    if (named.length) found[rel] = [...new Set(named.map((a) => placeOf(a) ?? `NO PLACE: ${a.slice(0, 60)}`))];
  }
  assert.deepEqual(found, Object.fromEntries(Object.entries(EXPECTED).map(([rel, place]) => [rel, [place]])));
});

test("the setting lists exactly the places the openers use, every one ticked by default", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { type: string; default: unknown; properties?: Record<string, { type: string; default: unknown }>; additionalProperties?: boolean }> }[] };
  };
  const setting = pkg.contributes.configuration.map((c) => c.properties["gitstudio.diff.comparisonIn"]).find(Boolean);
  assert.ok(setting, "gitstudio.diff.comparisonIn is contributed");
  const keys = Object.keys(setting.properties ?? {});
  assert.deepEqual(keys, ["vscode", ...places.DIFF_PLACES]);
  assert.equal(setting.type, "object");
  assert.equal(setting.additionalProperties, false);
  assert.deepEqual(setting.default, Object.fromEntries(keys.map((k) => [k, true])));
  for (const k of keys) assert.deepEqual(setting.properties?.[k], { type: "boolean", default: true }, k);
  // Every GitStudio place has an opener, and every opener's place (but pull requests) is in the setting.
  const used = new Set(Object.values(EXPECTED));
  used.delete("pullRequests");
  assert.deepEqual([...used].sort(), [...places.DIFF_PLACES].sort());
  // The `vscode` place is the router's: diffs that no GitStudio view opened.
  assert.match(code("merge/gitstudioMerge.ts"), /routeOtherDiffs: \(\) => comparisonIn\("vscode"\)/);
});

test("the Timeline's GitStudio entries open through the internal command, as file history", () => {
  assert.equal(rev.OPEN_HISTORY_DIFF_COMMAND, "gitstudio.openHistoryDiff");
  assert.match(code("history/fileTimelineProvider.ts"), /command: OPEN_HISTORY_DIFF_COMMAND,/);
  assert.match(code("extension.ts"), /registerCommand\(\s*OPEN_HISTORY_DIFF_COMMAND,[\s\S]*?openDiff\(left, right, title, options, "history"\)/);
});

test("nothing in the extension opens a diff around openDiff", () => {
  const direct: string[] = [];
  for (const rel of sources()) {
    const text = code(rel);
    if (/executeCommand\(\s*["'`]vscode\.diff["'`]|command:\s*["'`]vscode\.diff["'`]/.test(text)) direct.push(`${rel}: vscode.diff`);
    if (rel !== "merge/diffPlaces.ts" && /\b(openWithoutRouting|openRoutable)\(/.test(text)) direct.push(`${rel}: the router's primitive`);
  }
  assert.deepEqual(direct, [], "open GitStudio's diffs with openDiff (src/merge/diffPlaces.ts) and their place");
});
