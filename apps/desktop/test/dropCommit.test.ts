// Drop Commit from the graph's menu (issue #32) — the main process's half:
// `commit:dropPlan` (what the menu asks before it opens, and the drop asks
// again with `preflight`), `commit:drop` (the run) and `commit:undoDrop` (what
// the toast's Undo and ⌘Z call). Real git, through RebaseBridge, with the IPC
// wrapper's report rule applied to every refusal.

import "./hermeticGit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { DropPlanWire } from "../src/shared/ipc";

interface W {
  dir: string;
  git: (...a: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  subjects: () => string[];
  bridge: RebaseBridge;
  cleanup: () => void;
}

async function workspace(): Promise<W> {
  const dir = mkdtempSync(join(tmpdir(), "gs-desktop-drop-"));
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
    bridge: new RebaseBridge(repos),
    cleanup: () => removeTempRepo(dir),
  };
}

type Ok = Extract<DropPlanWire, { ok: true }>;
async function plan(w: W, sha: string, preflight = false): Promise<Ok> {
  const p = await w.bridge.dropPlan({ sha, preflight });
  assert.ok(p.ok, p.ok ? "" : p.message);
  return p;
}

test("the menu's question: droppable commits say so, with what dropping means", async () => {
  const w = await workspace();
  try {
    const root = w.commit("root"); const a = w.commit("A"); const tip = w.commit("tip");
    const p = await plan(w, a);
    assert.equal(p.replayed, 1);
    assert.equal(p.branch, "main");
    assert.equal(p.published, false);
    assert.equal(p.subject, "A");
    assert.equal(p.shortSha, a.slice(0, 7));
    assert.equal(p.blocked, undefined, "no preflight asked, none answered");
    assert.equal((await plan(w, tip)).replayed, 0);
    assert.equal((await plan(w, root)).replayed, 2);
  } finally {
    w.cleanup();
  }
});

test("merge commits, commits off the branch and the only commit are refused — expected, never filed", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const below = w.commit("below");
    w.git("checkout", "-q", "-b", "side"); w.commit("side");
    w.git("checkout", "-q", "main"); w.commit("main-work");
    w.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = w.git("rev-parse", "HEAD");
    w.git("checkout", "-q", "-b", "other", below); const other = w.commit("other");
    w.git("checkout", "-q", "main");
    for (const [sha, reason] of [[merge, "merge"], [below, "past-merge"], [other, "not-on-branch"]]) {
      const p = await w.bridge.dropPlan({ sha });
      assert.equal(p.ok, false);
      assert.equal(!p.ok && p.reason, reason);
      assert.equal(reportableResultMessage(p), undefined, `${reason} is a state, not a crash`);
    }
  } finally {
    w.cleanup();
  }
  const one = await workspace();
  try {
    const only = one.commit("only");
    const p = await one.bridge.dropPlan({ sha: only });
    assert.equal(!p.ok && p.reason, "only-commit");
  } finally {
    one.cleanup();
  }
});

test("drop the tip, then Undo puts it back", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const b = w.commit("B"); const c = w.commit("C");
    const p = await plan(w, c, true);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(w.git("rev-parse", "HEAD"), b);
    assert.equal(out.before, c);
    assert.equal(out.after, b);
    const back = await w.bridge.undoDrop({ before: out.before!, after: out.after! });
    assert.deepEqual(back, { ok: true, changed: true });
    assert.equal(w.git("rev-parse", "HEAD"), c, "undo restores the original tip");
  } finally {
    w.cleanup();
  }
});

test("drop a middle commit, then Undo restores the original tip", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); w.commit("B"); w.commit("C");
    const tip = w.git("rev-parse", "HEAD");
    const p = await plan(w, a, true);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(w.subjects(), ["C", "B", "base"]);
    await w.bridge.undoDrop({ before: out.before!, after: out.after! });
    assert.equal(w.git("rev-parse", "HEAD"), tip);
    assert.deepEqual(w.subjects(), ["C", "B", "A", "base"]);
  } finally {
    w.cleanup();
  }
});

test("drop the oldest commit on the branch (the root)", async () => {
  const w = await workspace();
  try {
    const root = w.commit("root"); w.commit("A"); w.commit("B");
    const p = await plan(w, root, true);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(w.subjects(), ["B", "A"]);
  } finally {
    w.cleanup();
  }
});

test("a conflicting replay stops for the conflict flow — not a failure, not filed, no Undo tip", async () => {
  const w = await workspace();
  try {
    w.commit("base", "f.txt", "one\n");
    const a = w.commit("A", "f.txt", "one\ntwo\n");
    w.commit("B", "f.txt", "one\ntwo\nthree\n");
    const p = await plan(w, a, true);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "stopped", JSON.stringify(out));
    assert.equal(out.reason, "conflict");
    assert.equal(out.after, undefined);
    assert.equal(reportableResultMessage(out), undefined);
    assert.ok(existsSync(join(w.git("rev-parse", "--absolute-git-dir"), "rebase-merge")), "the rebase is open for Continue/Skip/Abort");
    w.git("rebase", "--abort");
    assert.equal(w.git("rev-parse", "HEAD"), p.head, "Abort puts the branch back as it was");
  } finally {
    w.cleanup();
  }
});

test("uncommitted changes: the preflight says so before the question, and the drop refuses", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A");
    const tip = w.git("rev-parse", "HEAD");
    writeFileSync(join(w.dir, "base.txt"), "edited\n");
    const p = await plan(w, a, true);
    assert.match(p.blocked ?? "", /uncommitted changes/);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "failed");
    assert.equal(out.expected, true);
    assert.equal(reportableResultMessage(out), undefined);
    assert.equal(w.git("rev-parse", "HEAD"), tip);
  } finally {
    w.cleanup();
  }
});

test("an operation in progress: the preflight names it", async () => {
  const w = await workspace();
  try {
    w.commit("base", "f.txt", "one\n");
    w.git("checkout", "-q", "-b", "side");
    const pick = w.commit("side edit", "f.txt", "side\n");
    w.git("checkout", "-q", "main");
    const a = w.commit("A", "f.txt", "main\n");
    assert.notEqual(spawnSync("git", ["cherry-pick", pick], { cwd: w.dir }).status, 0);
    const p = await plan(w, a, true);
    assert.match(p.blocked ?? "", /cherry-pick is still in progress.*before dropping a commit/);
  } finally {
    w.cleanup();
  }
});

test("a published commit is offered, and the plan says it is published", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); w.commit("B");
    w.git("update-ref", "refs/remotes/origin/main", w.git("rev-parse", "HEAD"));
    assert.equal((await plan(w, a)).published, true);
  } finally {
    w.cleanup();
  }
});

test("Undo after the branch moved on refuses, expected, and changes nothing", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); w.commit("B");
    const p = await plan(w, a, true);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    const later = w.commit("later");
    const back = await w.bridge.undoDrop({ before: out.before!, after: out.after! });
    assert.equal(back.ok, false);
    assert.equal(back.expected, true);
    assert.equal(w.git("rev-parse", "HEAD"), later);
  } finally {
    w.cleanup();
  }
});

test("a stale confirmation is refused: HEAD moved between the question and the run", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A");
    const p = await plan(w, a, true);
    w.commit("landed");
    const out = await w.bridge.drop({ sha: p.sha, head: p.head });
    assert.equal(out.status, "failed");
    assert.equal(out.expected, true);
    assert.deepEqual(w.subjects(), ["landed", "A", "base"]);
  } finally {
    w.cleanup();
  }
});

test("carry moves a branch that points at a replayed commit", async () => {
  const w = await workspace();
  try {
    w.commit("base"); const a = w.commit("A"); const b = w.commit("B"); w.commit("C");
    w.git("branch", "feature", b);
    const p = await plan(w, a, true);
    assert.deepEqual(p.carryable, ["feature"]);
    const out = await w.bridge.drop({ sha: p.sha, head: p.head, carry: true });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(w.git("merge-base", "--is-ancestor", "feature", "HEAD"), "");
  } finally {
    w.cleanup();
  }
});
