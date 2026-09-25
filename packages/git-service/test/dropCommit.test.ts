import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { runRebasePlan, abortRebase } from "../src/RebaseRunner";
import {
  DROP_DIRTY_MESSAGE,
  DROP_MOVED_MESSAGE,
  dropBlocker,
  dropCommit,
  planDropCommit,
  undoDrop,
  type DropPlan,
} from "../src/dropCommit";
import { buildRebasePlan } from "../src/rebasePlan";
import { dropOutcomeMessage } from "@gitstudio/engine/rebase/drop";

// Drop Commit (issue #32), end to end against real git: the plan both products
// read before offering the item, the checks before the confirmation, the run,
// the conflict stop, and the desktop's undo. The extension's and desktop's own
// tests drive their doors over this same module.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  subjects: () => string[];
  ctx: GitContext;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-drop-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  git("config", "user.email", "d@e.com");
  git("config", "user.name", "D");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const subjects = () => git("log", "--format=%s").split("\n").filter(Boolean);
  const ctx = new GitContext({ root: dir });
  return {
    dir, git, commit, subjects, ctx,
    dispose: () => {
      ctx.dispose();
      removeTempRepo(dir);
    },
  };
}

const run = (r: Repo) => (plan: Parameters<typeof runRebasePlan>[1]) => runRebasePlan(r.dir, plan);

async function planOk(r: Repo, sha: string): Promise<DropPlan> {
  const plan = await planDropCommit(r.ctx.process, sha);
  assert.ok(plan.ok, plan.ok ? "" : `expected a plan, got: ${plan.message}`);
  return plan;
}

async function drop(r: Repo, sha: string, carry = false) {
  const plan = await planOk(r, sha);
  return { plan, out: await dropCommit(r.ctx.process, { sha: plan.sha, head: plan.head, carry }, run(r)) };
}

test("dropping the tip moves the branch to its parent", async () => {
  const r = repo();
  try {
    r.commit("base"); const b = r.commit("B"); const c = r.commit("C");
    const { plan, out } = await drop(r, c);
    assert.equal(plan.replayed, 0);
    assert.equal(plan.base, b);
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["B", "base"]);
    assert.equal(r.git("rev-parse", "HEAD"), b, "the parent itself, not a copy of it");
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main", "still on the branch");
    assert.equal(out.before, c);
    assert.equal(out.after, b);
    assert.ok(!existsSync(join(r.dir, "C.txt")), "the dropped commit's file is gone");
  } finally {
    r.dispose();
  }
});

test("dropping a middle commit replays the later ones and keeps their content", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); r.commit("C");
    const { plan, out } = await drop(r, a);
    assert.equal(plan.replayed, 2);
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["C", "B", "base"]);
    assert.ok(!existsSync(join(r.dir, "A.txt")));
    for (const f of ["base", "B", "C"]) assert.ok(existsSync(join(r.dir, `${f}.txt`)), `${f}.txt survived`);
  } finally {
    r.dispose();
  }
});

test("dropping the oldest commit — the root — makes the next one the new root", async () => {
  const r = repo();
  try {
    const root = r.commit("root"); r.commit("A"); r.commit("B");
    const { plan, out } = await drop(r, root);
    assert.equal(plan.base, "--root");
    assert.equal(plan.replayed, 2);
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["B", "A"]);
    assert.equal(r.git("rev-list", "--max-parents=0", "HEAD").split("\n").length, 1);
    assert.ok(!existsSync(join(r.dir, "root.txt")));
  } finally {
    r.dispose();
  }
});

test("dropping the oldest UNPUSHED commit stops at the published history below it", async () => {
  const r = repo();
  try {
    r.commit("base"); const pushed = r.commit("pushed");
    r.git("update-ref", "refs/remotes/origin/main", pushed);
    const a = r.commit("A"); r.commit("B");
    const { plan, out } = await drop(r, a);
    assert.equal(plan.published, false);
    assert.equal(plan.base, pushed, "runs onto the published parent, which is left alone");
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["B", "pushed", "base"]);
    assert.equal(r.git("rev-parse", "HEAD~1"), pushed, "the published commit keeps its identity");
  } finally {
    r.dispose();
  }
});

test("the only commit on the branch is not droppable", async () => {
  const r = repo();
  try {
    const only = r.commit("only");
    const plan = await planDropCommit(r.ctx.process, only);
    assert.equal(plan.ok, false);
    assert.equal(!plan.ok && plan.reason, "only-commit");
  } finally {
    r.dispose();
  }
});

test("a merge commit, a commit below a merge, and a commit on another branch are not droppable", async () => {
  const r = repo();
  try {
    r.commit("base"); const below = r.commit("below");
    r.git("checkout", "-q", "-b", "side");
    const side = r.commit("side");
    r.git("checkout", "-q", "main");
    r.commit("main-work");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = r.git("rev-parse", "HEAD");
    const above = r.commit("above");

    const reason = async (sha: string) => {
      const p = await planDropCommit(r.ctx.process, sha);
      return p.ok ? "ok" : p.reason;
    };
    assert.equal(await reason(merge), "merge");
    assert.equal(await reason(below), "past-merge");
    // side IS an ancestor of HEAD now — through the merge's second parent,
    // which is not the first-parent line — so it is past the merge too.
    assert.equal(await reason(side), "past-merge");
    assert.equal(await reason(above), "ok");

    // And a commit on a branch HEAD does not contain at all.
    r.git("checkout", "-q", "-b", "other", below);
    const other = r.commit("other");
    r.git("checkout", "-q", "main");
    assert.equal(await reason(other), "not-on-branch");
    assert.equal(await reason("0000000000000000000000000000000000000000"), "not-on-branch");
    assert.equal(await reason("not a sha; rm -rf"), "not-on-branch");
  } finally {
    r.dispose();
  }
});

test("a later commit that conflicts when replayed STOPS the rebase for the conflict flow, and abort restores the tip", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "one\n");
    const a = r.commit("A", "f.txt", "one\ntwo\n");
    r.commit("B", "f.txt", "one\ntwo\nthree\n"); // needs A's line as context
    const tip = r.git("rev-parse", "HEAD");
    const { plan, out } = await drop(r, a);
    assert.equal(out.status, "stopped", JSON.stringify(out));
    assert.equal(out.status === "stopped" && out.reason, "conflict");
    assert.equal(out.after, undefined, "a stop offers no undo tip — abort is the way back");
    assert.match(dropOutcomeMessage(plan.shortSha, out), /hit a conflict .* abort to put the branch back/);
    assert.ok(existsSync(join(r.git("rev-parse", "--absolute-git-dir"), "rebase-merge")), "the rebase is left open");
    assert.match(await dropBlocker(r.ctx.process) ?? "", /A rebase is still in progress/, "and a second drop is refused over it");

    const aborted = await abortRebase(r.dir);
    assert.equal(aborted.status, "done", JSON.stringify(aborted));
    assert.equal(r.git("rev-parse", "HEAD"), tip, "abort puts the branch back as it was");
  } finally {
    r.dispose();
  }
});

test("uncommitted changes to tracked files refuse the drop before anything is rewritten", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    const tip = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "base.txt"), "edited\n");
    assert.equal(await dropBlocker(r.ctx.process), DROP_DIRTY_MESSAGE);
    const { out } = await drop(r, a);
    assert.equal(out.status, "failed");
    assert.equal(out.status === "failed" && out.expected, true, "the user's state, never a crash report");
    assert.equal(r.git("rev-parse", "HEAD"), tip, "nothing rewritten");
    assert.equal(r.git("status", "--porcelain"), "M base.txt", "and the edit is untouched");
  } finally {
    r.dispose();
  }
});

test("an untracked file does not block a drop — git's own rule", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A");
    writeFileSync(join(r.dir, "scratch.log"), "x\n");
    assert.equal(await dropBlocker(r.ctx.process), undefined);
  } finally {
    r.dispose();
  }
});

test("an operation in progress refuses the drop, in the words every door uses", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "one\n");
    r.git("checkout", "-q", "-b", "side");
    const pick = r.commit("side edit", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    const a = r.commit("A", "f.txt", "main\n");
    const tip = r.git("rev-parse", "HEAD");
    const cp = spawnSync("git", ["cherry-pick", pick], { cwd: r.dir, env: ENV });
    assert.notEqual(cp.status, 0, "the pick stops on a conflict");
    const said = await dropBlocker(r.ctx.process);
    assert.match(said ?? "", /cherry-pick is still in progress/i);
    assert.match(said ?? "", /before dropping a commit\.$/);
    const out = await dropCommit(r.ctx.process, { sha: a, head: tip }, run(r));
    assert.equal(out.status, "failed");
    assert.equal(r.git("rev-parse", "HEAD"), tip);
  } finally {
    r.dispose();
  }
});

test("a published commit is droppable, and the plan says it is published", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    r.git("update-ref", "refs/remotes/origin/main", r.git("rev-parse", "HEAD"));
    const plan = await planOk(r, a);
    assert.equal(plan.published, true);
    const out = await dropCommit(r.ctx.process, { sha: plan.sha, head: plan.head }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["B", "base"]);
    assert.equal(r.git("rev-parse", "origin/main"), plan.head, "the remote-tracking ref is not touched");
  } finally {
    r.dispose();
  }
});

test("a confirmation that went stale is refused — HEAD moved since the plan", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A");
    const plan = await planOk(r, a);
    r.commit("landed meanwhile");
    const out = await dropCommit(r.ctx.process, { sha: plan.sha, head: plan.head }, run(r));
    assert.equal(out.status, "failed");
    assert.equal(out.status === "failed" && out.message, DROP_MOVED_MESSAGE);
    assert.deepEqual(r.subjects(), ["landed meanwhile", "A", "base"]);
  } finally {
    r.dispose();
  }
});

test("branches pointing at replayed commits are listed, and carried only when asked", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); r.commit("C");
    r.git("branch", "feature", b);
    r.git("branch", "at-dropped", a);
    const plan = await planOk(r, a);
    assert.deepEqual(plan.carryable, ["feature"], "the dropped commit's own branch and main are not carried");

    const out = await dropCommit(r.ctx.process, { sha: plan.sha, head: plan.head, carry: true }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(r.git("log", "-1", "--format=%s", "feature"), "B");
    assert.equal(r.git("merge-base", "--is-ancestor", "feature", "HEAD"), "", "feature follows the rewrite");
    assert.equal(r.git("rev-parse", "at-dropped"), a, "a branch ON the dropped commit keeps it");
  } finally {
    r.dispose();
  }
});

test("undo puts the branch back on the original tip", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    const tip = r.git("rev-parse", "HEAD");
    const { out } = await drop(r, a);
    assert.equal(out.status, "done");
    const back = await undoDrop(r.ctx.process, { before: out.before!, after: out.after! });
    assert.deepEqual(back, { ok: true });
    assert.equal(r.git("rev-parse", "HEAD"), tip);
    assert.deepEqual(r.subjects(), ["B", "A", "base"]);
    assert.equal(r.git("status", "--porcelain"), "", "working tree matches the restored tip");
  } finally {
    r.dispose();
  }
});

test("undo after dropping the tip goes forward again, even onto a published parent", async () => {
  const r = repo();
  try {
    r.commit("base"); const pushed = r.commit("pushed");
    r.git("update-ref", "refs/remotes/origin/main", pushed);
    const tip = r.commit("local");
    const { out } = await drop(r, tip);
    assert.equal(r.git("rev-parse", "HEAD"), pushed);
    assert.deepEqual(await undoDrop(r.ctx.process, { before: out.before!, after: out.after! }), { ok: true });
    assert.equal(r.git("rev-parse", "HEAD"), tip);
  } finally {
    r.dispose();
  }
});

test("undo refuses once the branch has moved on, and changes nothing", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    const { out } = await drop(r, a);
    const later = r.commit("after the drop");
    const back = await undoDrop(r.ctx.process, { before: out.before!, after: out.after! });
    assert.equal(back.ok, false);
    assert.equal(!back.ok && back.expected, true);
    assert.equal(r.git("rev-parse", "HEAD"), later);
  } finally {
    r.dispose();
  }
});

test("the planner's all-drop guard still stands unless the drop asks past it", () => {
  const rows = [{ sha: "a1b2c3d", action: "drop", subject: "tip" }];
  assert.equal(buildRebasePlan(rows).ok, false, "the Rebase view keeps its refusal");
  const built = buildRebasePlan(rows, { allowDropAll: true });
  assert.ok(built.ok);
  assert.equal(built.ok && built.todo, "drop a1b2c3d tip\n");
});
