import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromGitUriQuery, nativeDiffSides, revOfGitRef } from "../src/changes/nativeDiffSides";
import { commandsRun, installUris, resetRecorders, vs, type U } from "./commitViewCovKit";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { RevisionNavigator } = require("../src/history/revisionNavigation") as typeof import("../src/history/revisionNavigation");
/* eslint-enable @typescript-eslint/no-require-imports */

installUris();

// #87: a diff opened from the Changes list on GitStudio's own gitstudio-rev:
// URIs is one VS Code's own selective staging does not recognise — "Stage
// Selected Ranges" silently did nothing there, and the diff gutter's per-change
// "+" was not offered. A plain modification vscode.git has reported opens on
// vscode.git's URIs instead; everything else keeps GitStudio's diff.

// vscode.git's Status values (git.d.ts, API v1).
const INDEX_MODIFIED = 0;
const INDEX_ADDED = 1;
const INDEX_RENAMED = 3;
const MODIFIED = 5;
const DELETED = 6;
const UNTRACKED = 7;
const BOTH_MODIFIED = 18;

test("an unstaged modification: the index (vscode.git's \"~\") against the working file — what Git: Open Changes opens", () => {
  assert.deepEqual(nativeDiffSides("unstaged", MODIFIED), { left: { ref: "~" }, right: "file" });
});

test("a staged modification: HEAD against the index, both vscode.git's", () => {
  assert.deepEqual(nativeDiffSides("staged", INDEX_MODIFIED), {
    left: { ref: "HEAD", original: true },
    right: { ref: "" },
  });
});

test("everything unusual keeps GitStudio's own diff", () => {
  for (const [kind, status] of [
    ["unstaged", UNTRACKED],
    ["unstaged", DELETED],
    ["staged", INDEX_ADDED],
    ["staged", INDEX_RENAMED],
    ["merge", BOTH_MODIFIED],
    ["merge", MODIFIED],
    ["unstaged", undefined], // a change vscode.git has not reported (the eager path)
  ] as const) {
    assert.equal(nativeDiffSides(kind, status), undefined, `${kind} / ${status}`);
  }
});

test("only the change vscode.git reported is opened natively; the eager path passes no URI maker", () => {
  const src = readFileSync(join(__dirname, "..", "src", "changes", "commitView.ts"), "utf8");
  const calls = src.split("openChangeDiff(").slice(1).map((c) => c.slice(0, c.indexOf(");")));
  assert.equal(calls.length, 2, "two call sites");
  assert.match(calls[0], /this\.repos\.gitUri\(uri, ref\)/, "the vscode.git branch hands over vscode.git's URIs");
  assert.doesNotMatch(calls[1], /gitUri/, "the eager branch (no vscode.git change) does not");
});

// ── round 2: the history commands read vscode.git's URIs too ────────────────

const gitUri = (path: string, ref: string) => ({
  scheme: "git",
  path,
  query: JSON.stringify({ path, ref }),
  fsPath: path,
});

test("a git: URI's query names the file and the ref; anything else is not one", () => {
  assert.deepEqual(fromGitUriQuery(JSON.stringify({ path: "/repo/a.ts", ref: "~" })), { path: "/repo/a.ts", ref: "~" });
  assert.deepEqual(fromGitUriQuery(JSON.stringify({ path: "/repo/a.ts", ref: "HEAD", submoduleOf: "/x" })), {
    path: "/repo/a.ts",
    ref: "HEAD",
  });
  assert.equal(fromGitUriQuery("rev=&root=%2Frepo"), undefined);
  assert.equal(fromGitUriQuery(JSON.stringify({ path: "/repo/a.ts" })), undefined);
  assert.equal(revOfGitRef("~"), "");
  assert.equal(revOfGitRef(""), "");
  assert.equal(revOfGitRef("HEAD"), "HEAD");
  assert.equal(revOfGitRef("0123abcd"), "0123abcd");
});

test("Open Changes from a staged diff's git: side opens the file against HEAD, not 'Open a file in a Git repository first'", async () => {
  resetRecorders();
  const said = (vs as unknown as { __said: { message: string }[] }).__said;
  said.length = 0;
  const entry = { root: "/repo", ctx: {} };
  const repos = {
    getAll: () => [entry],
    findByPath: (p: string) => (p.startsWith("/repo/") ? entry : undefined),
  };
  const navigator = new RevisionNavigator(repos as never);
  await navigator.openChanges(gitUri("/repo/src/a.ts", "") as never);
  const diff = commandsRun.find((c) => c.id === "vscode.diff");
  assert.ok(diff, `a diff opened (said: ${JSON.stringify(said)})`);
  assert.equal((diff.args[0] as U).scheme, "gitstudio-rev");
  assert.match((diff.args[0] as U).query, /rev=HEAD/);
  assert.equal((diff.args[1] as U).fsPath, "/repo/src/a.ts");
  assert.deepEqual(said, []);
});
