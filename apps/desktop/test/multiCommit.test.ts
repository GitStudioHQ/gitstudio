// Several commits at once from the graph (issue #32) — the main process's
// half: `commits:menu` (what the menu for a selection may offer),
// `commits:plan` / `commits:rewrite` / `commits:undo` (Drop N and Squash N,
// and the Undo for every one of them), and `commit:action` with `shas`
// (Cherry-pick N and Revert N through the commit-applying door). Real git,
// with the IPC wrapper's report rule applied to every refusal.

import "./hermeticGit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { CommitsPlanWire } from "../src/shared/ipc";

interface W {
  dir: string;
  git: (...a: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  subjects: () => string[];
  rebase: RebaseBridge;
  bridge: GitBridge;
  cleanup: () => void;
}

async function workspace(): Promise<W> {
  const dir = mkdtempSync(join(tmpdir(), "gs-desktop-many-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`): string => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const repos = new RepoStore([]);
  await repos.open(dir);
  return {
    dir,
    git,
    commit,
    subjects: () => git("log", "--format=%s").split("\n").filter(Boolean),
    rebase: new RebaseBridge(repos),
    bridge: new GitBridge(repos),
    cleanup: () => removeTempRepo(dir),
  };
}

type Ok = Extract<CommitsPlanWire, { ok: true }>;
async function plan(w: W, verb: "drop" | "squash", shas: string[], preflight = false): Promise<Ok> {
  const p = await w.rebase.commitsPlan({ verb, shas, preflight });
  assert.ok(p.ok, p.ok ? "" : p.message);
  return p;
}

// ── The menu ────────────────────────────────────────────────────────────────

test("commits:menu answers what the menu for a selection may offer — one row per kind of selection", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const b = w.commit("B"); const c = w.commit("C");
    w.git("checkout", "-q", "-b", "side", b); const s = w.commit("S");
    w.git("checkout", "-q", "main");
    w.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = w.git("rev-parse", "HEAD");
    const t1 = w.commit("T1"); const t2 = w.commit("T2"); const t3 = w.commit("T3");
    const TABLE: Array<[string, string[], { apply: boolean; drop: boolean; squash: boolean }]> = [
      ["contiguous above the merge", [t3, t2], { apply: true, drop: true, squash: true }],
      ["a gap above the merge", [t3, t1], { apply: true, drop: true, squash: false }],
      ["a merge among them", [t1, merge], { apply: false, drop: false, squash: false }],
      ["below the merge", [c, b], { apply: true, drop: false, squash: false }],
      ["the merged-in side", [t1, s], { apply: true, drop: false, squash: false }],
      ["one commit", [t3], { apply: false, drop: false, squash: false }],
      ["not shas", ["--all", "HEAD"], { apply: false, drop: false, squash: false }],
    ];
    for (const [what, shas, want] of TABLE) {
      assert.deepEqual(await w.rebase.commitsMenu({ shas }), want, what);
    }
  } finally {
    w.cleanup();
  }
});

// ── Drop N / Squash N ──────────────────────────────────────────────────────

test("drop N: the plan names every commit, the preflight says what stops it, the run drops them, Undo restores", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); w.commit("B"); const c = w.commit("C");
    const tip = w.git("rev-parse", "HEAD");
    const p = await plan(w, "drop", [c, a]);
    assert.deepEqual(p.commits.map((x) => x.subject), ["C", "A"]);
    assert.equal(p.replayed, 1);
    assert.equal(p.blocked, undefined);
    writeFileSync(join(w.dir, "A.txt"), "edited\n");
    assert.match((await plan(w, "drop", [c, a], true)).blocked ?? "", /then drop the commits\./);
    w.git("checkout", "--", "A.txt");
    const out = await w.rebase.commitsRewrite({ verb: "drop", shas: p.shas, head: p.head });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(w.subjects(), ["B", "base"]);
    const back = await w.rebase.commitsUndo({ before: out.before!, after: out.after!, what: "drop" });
    assert.deepEqual(back, { ok: true, changed: true });
    assert.equal(w.git("rev-parse", "HEAD"), tip);
  } finally {
    w.cleanup();
  }
});

test("squash N: the pre-filled message, the user's message used, Undo restores; an empty one is refused", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); const b = w.commit("B"); w.commit("C");
    const tip = w.git("rev-parse", "HEAD");
    const p = await plan(w, "squash", [b, a]);
    assert.equal(p.message, "A\n\nB");
    const empty = await w.rebase.commitsRewrite({ verb: "squash", shas: p.shas, head: p.head, message: " " });
    assert.equal(empty.status, "failed");
    assert.equal(reportableResultMessage(empty), undefined, "expected, never filed");
    const out = await w.rebase.commitsRewrite({ verb: "squash", shas: p.shas, head: p.head, message: "AB" });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(w.subjects(), ["C", "AB", "base"]);
    await w.rebase.commitsUndo({ before: out.before!, after: out.after!, what: "squash" });
    assert.equal(w.git("rev-parse", "HEAD"), tip);
  } finally {
    w.cleanup();
  }
});

test("squash N that carried a branch: the outcome names it, and Undo puts it back too", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); const b = w.commit("B"); const c = w.commit("C");
    w.git("branch", "feature", c);
    const p = await plan(w, "squash", [b, a]);
    assert.deepEqual(p.carryable, ["feature"]);
    const out = await w.rebase.commitsRewrite({ verb: "squash", shas: p.shas, head: p.head, message: "AB", carry: true });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(out.carried, [{ branch: "feature", before: c, after: w.git("rev-parse", "feature") }], "the wire carries where it went");
    const back = await w.rebase.commitsUndo({ before: out.before!, after: out.after!, what: "squash", carried: out.carried });
    assert.deepEqual(back, { ok: true, changed: true });
    assert.equal(w.git("rev-parse", "HEAD"), c);
    assert.equal(w.git("rev-parse", "feature"), c, "feature is back on C");
  } finally {
    w.cleanup();
  }
});

test("comparing two commits: a file's diff names each side by its short sha, as the pickers do", async () => {
  const w = await workspace();
  try {
    w.commit("base", "f.txt", "0\n"); const a = w.commit("A", "f.txt", "1\n"); const b = w.commit("B", "f.txt", "2\n");
    for (const mode of ["two-dot", "three-dot"] as const) {
      const d = await w.bridge.compareFileDiff({ base: a, head: b, path: "f.txt", mode });
      assert.ok(d, mode);
      assert.ok(!/[0-9a-f]{12,}/.test(`${d!.leftLabel} ${d!.rightLabel}`), `${mode}: no long shas (${d!.leftLabel} | ${d!.rightLabel})`);
      assert.match(d!.leftLabel, new RegExp(`^${a.slice(0, 7)}\\b`), mode);
      assert.equal(d!.rightLabel, `${b.slice(0, 7)} f.txt`, mode);
    }
    // A branch keeps its name.
    const d = await w.bridge.compareFileDiff({ base: a, head: "main", path: "f.txt", mode: "two-dot" });
    assert.equal(d?.rightLabel, "main f.txt");
  } finally {
    w.cleanup();
  }
});

test("refusals are the user's state — expected, never filed: a gap, a stale head, an undo after the branch moved", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); w.commit("B"); const c = w.commit("C");
    const gap = await w.rebase.commitsPlan({ verb: "squash", shas: [c, a] });
    assert.equal(gap.ok, false);
    assert.equal(reportableResultMessage(gap as never), undefined);
    const p = await plan(w, "drop", [c, a]);
    w.commit("landed meanwhile");
    const stale = await w.rebase.commitsRewrite({ verb: "drop", shas: p.shas, head: p.head });
    assert.equal(stale.status, "failed");
    assert.match(stale.message ?? "", /The branch has moved since you chose these commits/);
    assert.equal(reportableResultMessage(stale), undefined);
    const bad = await w.rebase.commitsUndo({ before: "x", after: "y", what: "squash" });
    assert.equal(bad.ok, false);
  } finally {
    w.cleanup();
  }
});

// ── Cherry-pick N / Revert N through commit:action ─────────────────────────

async function sideRepo(w: W): Promise<{ a: string; b: string; c: string }> {
  w.commit("base", "f.txt", "0\n");
  w.git("checkout", "-q", "-b", "side");
  const a = w.commit("A", "a.txt"); const b = w.commit("B", "f.txt", "side\n"); const c = w.commit("C", "c.txt");
  w.git("checkout", "-q", "main");
  return { a, b, c };
}

test("cherry-pick N: oldest first in one run, and the two tips and the branch its Undo moves between", async () => {
  const w = await workspace();
  try {
    const { a, b, c } = await sideRepo(w);
    const before = w.git("rev-parse", "HEAD");
    const r = await w.bridge.commitAction({ action: "cherry-pick", sha: c, shas: [c, b, a] });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(w.subjects().slice(0, 3), ["C", "B", "A"]);
    assert.equal(r.before, before);
    assert.equal(r.after, w.git("rev-parse", "HEAD"));
    assert.equal(r.branch, "refs/heads/main", "the branch it moved, by full name, for its Undo");
    const back = await w.rebase.commitsUndo({ before: r.before!, after: r.after!, what: "cherry-pick", branch: r.branch });
    assert.equal(back.ok, true);
    assert.equal(w.git("rev-parse", "HEAD"), before);
  } finally {
    w.cleanup();
  }
});

test("cherry-pick N over an edit in the way of a later one: asked before git starts, then Stash & Retry runs them all", async () => {
  const w = await workspace();
  try {
    const { a, b } = await sideRepo(w);
    const before = w.git("rev-parse", "HEAD");
    writeFileSync(join(w.dir, "f.txt"), "mine\n");
    const req = { action: "cherry-pick" as const, sha: b, shas: [b, a] };
    const r = await w.bridge.commitAction(req);
    assert.equal(r.ok, false);
    assert.equal(r.expected, true);
    assert.deepEqual(r.inTheWay?.files, ["f.txt"]);
    assert.equal(w.git("rev-parse", "HEAD"), before, "nothing picked");
    assert.ok(!existsSync(join(w.dir, ".git", "sequencer")));
    const again = await w.bridge.commitAction({ ...req, stashFirst: r.inTheWay!.root });
    assert.equal(again.ok, true, again.message);
    assert.deepEqual(w.subjects().slice(0, 2), ["B", "A"]);
  } finally {
    w.cleanup();
  }
});

test("a conflict part-way is `paused` for the conflict flow — expected, first one applied", async () => {
  const w = await workspace();
  try {
    const { a, b } = await sideRepo(w);
    w.commit("main edit", "f.txt", "main\n");
    const r = await w.bridge.commitAction({ action: "cherry-pick", sha: b, shas: [b, a] });
    assert.equal(r.ok, false);
    assert.equal(r.paused, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.match(r.message ?? "", /Cherry-picking 2 commits stopped on a commit that needs you/);
    assert.equal(reportableResultMessage(r), undefined, "never filed");
    assert.equal(w.git("log", "-1", "--format=%s"), "A");
    assert.ok(existsSync(join(w.dir, ".git", "CHERRY_PICK_HEAD")));
  } finally {
    w.cleanup();
  }
});

test("revert N: newest first; a merge among them is refused in words; junk shas are refused", async () => {
  const w = await workspace();
  try {
    w.commit("base", "f.txt", "0\n");
    const a = w.commit("A", "f.txt", "1\n"); const b = w.commit("B", "f.txt", "2\n");
    const r = await w.bridge.commitAction({ action: "revert", sha: b, shas: [b, a] });
    assert.equal(r.ok, true, r.message);
    assert.equal(readFileSync(join(w.dir, "f.txt"), "utf8"), "0\n");
    w.git("checkout", "-q", "-b", "side", a); w.commit("S", "s.txt");
    w.git("checkout", "-q", "main");
    w.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = w.git("rev-parse", "HEAD");
    const m = await w.bridge.commitAction({ action: "revert", sha: merge, shas: [merge, b] });
    assert.equal(m.ok, false);
    assert.match(m.message ?? "", /is a merge commit — revert it on its own/);
    assert.equal(reportableResultMessage(m), undefined);
    const junk = await w.bridge.commitAction({ action: "cherry-pick", sha: b, shas: ["--all", "HEAD"] });
    assert.equal(junk.ok, false, "a selection that is not commits never reaches git");
  } finally {
    w.cleanup();
  }
});
