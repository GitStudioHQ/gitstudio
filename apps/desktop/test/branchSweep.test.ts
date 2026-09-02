// Which branches "Delete N finished…" is allowed to touch.
//
// `merged` on a BranchInfo is not a git flag — it is computed as `ahead === 0`
// measured with `%(ahead-behind:<default>)` against the DEFAULT BRANCH. Which
// makes the default branch zero commits ahead of itself, and therefore merged,
// and therefore finished. Standing on any feature branch, the sweep listed
// `main` by name in its confirm alongside the genuinely finished branches and
// offered to delete it.
//
// The rule this pins: the sweep set is every local branch that is merged into
// the default branch or whose upstream is gone, MINUS the branch you are on and
// MINUS the default branch itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BranchInfo } from "../src/shared/ipc";

/**
 * The predicate as the view applies it. Kept beside the source assertion below
 * so a change to one without the other fails rather than drifting.
 */
function finishedSet(locals: BranchInfo[], defaultBranch?: string): string[] {
  return locals
    .filter((b) => !b.current && b.name !== defaultBranch && (b.merged || b.gone))
    .map((b) => b.name);
}

const b = (name: string, o: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  current: false,
  ahead: 0,
  behind: 0,
  ...o,
});

test("the default branch is never finished, however merged it looks", () => {
  // main measured against main: zero ahead, which is the definition `merged`
  // uses. This is the case that was live.
  const locals = [
    b("main", { merged: true }),
    b("feature/done", { merged: true }),
    b("wip", { current: true }),
  ];
  assert.deepEqual(finishedSet(locals, "main"), ["feature/done"]);
});

test("the branch you are standing on is never finished", () => {
  // git refuses to delete the checked-out branch anyway, so offering it puts a
  // guaranteed failure in the middle of a sequential bulk delete.
  const locals = [b("release/1.2", { current: true, merged: true }), b("old", { merged: true })];
  assert.deepEqual(finishedSet(locals, "main"), ["old"]);
});

test("a gone upstream counts as finished, which is what a merged PR leaves", () => {
  // GitHub deletes the head branch when a pull request merges, so the local
  // copy is left tracking nothing — and a squash merge means it does not read
  // as merged either. Without `gone` the sweep would miss the common case.
  const locals = [b("fix/login", { gone: true }), b("still-going", {})];
  assert.deepEqual(finishedSet(locals, "main"), ["fix/login"]);
});

test("with no default branch known, nothing is protected by name — but the current branch still is", () => {
  // `defaultBranch` is undefined in a repo with no origin/HEAD and a detached
  // HEAD. Every merged branch is then a candidate, which is correct: there is
  // no default branch in the set to protect.
  const locals = [b("a", { merged: true }), b("b", { gone: true }), b("c", { current: true, merged: true })];
  assert.deepEqual(finishedSet(locals, undefined), ["a", "b"]);
});

test("an unmerged branch with a live upstream is left alone", () => {
  const locals = [b("feature/wip", { upstream: "origin/feature/wip", ahead: 3 })];
  assert.deepEqual(finishedSet(locals, "main"), []);
});

// ── and the same rule, where it is actually enforced ────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const renderer = readFileSync(join(here, "..", "src", "renderer", "renderer.ts"), "utf8");

test("the view's filter excludes the default branch", () => {
  assert.match(
    renderer,
    /const finished = locals\.filter\(\s*\(b\) => !b\.current && b\.name !== defaultBranch && \(b\.merged \|\| b\.gone\),?\s*\)/,
    "the sweep's candidate list no longer excludes the default branch by name",
  );
});

test("and the sweep itself refuses them a second time", () => {
  // A bulk delete does not get to trust a filter written elsewhere.
  const body = renderer.slice(renderer.indexOf("private async sweepFinishedBranches"));
  assert.match(
    body.slice(0, 1200),
    /finished = finished\.filter\(\(b\) => !b\.current && b\.name !== defaultBranch\)/,
    "sweepFinishedBranches deletes whatever it is handed",
  );
});
