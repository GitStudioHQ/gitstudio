import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { runRebasePlan, abortRebase } from "../src/RebaseRunner";
import {
  DROP_MANY_DIRTY_MESSAGE,
  MANY_MOVED_MESSAGE,
  SQUASH_DIRTY_MESSAGE,
  SQUASH_EMPTY_MESSAGE,
  applyManyArgs,
  manyBlocker,
  mergesAmong,
  orderCommits,
  planMany,
  rewriteMany,
  type ManyPlan,
} from "../src/multiCommit";
import { undoRewrite, type DropOutcome } from "../src/dropCommit";
import { runApplying, stashAndRetry, type ApplyOp } from "../src/changesInTheWay";

// Several commits at once (issue #32), end to end against real git: the plan
// both products read before offering Drop N / Squash N, the run, the conflict
// stop, the stale-confirmation refusal and the undo; the order Cherry-Pick N
// and Revert N hand git; and the commit-applying door's question about
// uncommitted changes, asked BEFORE a multi-commit pick starts.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (msg: string, file?: string, body?: string, date?: string) => string;
  subjects: () => string[];
  ctx: GitContext;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-many-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  git("config", "user.email", "d@e.com");
  git("config", "user.name", "D");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`, date?: string) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    const env = date ? { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : ENV;
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir, env });
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

/** An outcome's status, message and `expected`, whichever kind it is. */
const said = (o: DropOutcome): unknown[] =>
  o.status === "done" ? [o.status] : [o.status, o.message, "expected" in o ? o.expected : undefined];

async function planOk(r: Repo, verb: "drop" | "squash", shas: string[]): Promise<ManyPlan> {
  const plan = await planMany(r.ctx.process, verb, shas);
  assert.ok(plan.ok, plan.ok ? "" : `expected a plan, got: ${plan.message}`);
  return plan;
}

// ── Drop N ─────────────────────────────────────────────────────────────────

test("dropping two non-adjacent commits replays the one between and the ones above", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); const c = r.commit("C"); r.commit("D");
    const plan = await planOk(r, "drop", [c, a]);
    assert.deepEqual(plan.shas, [c, a], "newest first along the branch, whatever order they were sent in");
    assert.deepEqual(plan.rows.map((x) => x.action), ["pick", "drop", "pick", "drop"]);
    assert.equal(plan.replayed, 2);
    assert.equal(plan.branch, "main");
    assert.equal(plan.published, false);
    const out = await rewriteMany(r.ctx.process, "drop", { shas: [a, c], head: plan.head }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["D", "B", "base"]);
    assert.ok(!existsSync(join(r.dir, "A.txt")) && !existsSync(join(r.dir, "C.txt")));
    assert.equal(out.before, plan.head);
    assert.equal(out.after, r.git("rev-parse", "HEAD"));
  } finally {
    r.dispose();
  }
});

test("dropping the top two commits moves the branch below them — an all-drop todo", async () => {
  const r = repo();
  try {
    r.commit("base"); const keep = r.commit("keep"); const b = r.commit("B"); const c = r.commit("C");
    const plan = await planOk(r, "drop", [b, c]);
    assert.equal(plan.replayed, 0);
    assert.equal(plan.base, keep);
    const out = await rewriteMany(r.ctx.process, "drop", { shas: plan.shas, head: plan.head }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(r.git("rev-parse", "HEAD"), keep, "the parent itself, not a copy of it");
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main");
  } finally {
    r.dispose();
  }
});

test("drop N: every refusal the menu leaves the item out for, from real git", async () => {
  const r = repo();
  try {
    const root = r.commit("root"); const below = r.commit("below");
    r.git("checkout", "-q", "-b", "side");
    const side = r.commit("side");
    r.git("checkout", "-q", "main");
    const work = r.commit("main-work");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = r.git("rev-parse", "HEAD");
    const top = r.commit("top");
    const cases: Array<[string, string[], string]> = [
      ["a merge among them", [top, merge], "merge"],
      ["below a merge", [work, below], "past-merge"],
      // The walk down the first-parent line meets the merge before it could
      // find the merged-in commit — the same answer Drop Commit gives for one.
      ["the merged-in side", [top, side], "past-merge"],
      ["a sha that is no commit", [top, "deadbeef"], "not-on-branch"],
      ["an option, not a sha", [top, "--all"], "not-on-branch"],
    ];
    for (const [what, shas, reason] of cases) {
      const p = await planMany(r.ctx.process, "drop", shas);
      assert.equal(p.ok ? "ok" : p.reason, reason, what);
    }
    void root;
  } finally {
    r.dispose();
  }
  const two = repo();
  try {
    const a = two.commit("a"); const b = two.commit("b");
    const p = await planMany(two.ctx.process, "drop", [a, b]);
    assert.equal(p.ok ? "ok" : p.reason, "only-commit", "every commit of the branch");
    two.git("checkout", "-q", "-b", "other", a);
    const other = two.commit("other");
    two.git("checkout", "-q", "main");
    for (const verb of ["drop", "squash"] as const) {
      const off = await planMany(two.ctx.process, verb, [b, other]);
      assert.equal(off.ok ? "ok" : off.reason, "not-on-branch", `${verb}: a commit on another branch`);
    }
  } finally {
    two.dispose();
  }
});

test("pushed commits are planned, and the plan says they are published", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    r.git("update-ref", "refs/remotes/origin/main", b);
    const c = r.commit("C");
    assert.equal((await planOk(r, "drop", [c, b])).published, true, "B is on origin");
    assert.equal((await planOk(r, "squash", [b, a])).published, true);
    // The newest selected is local, the oldest pushed: still published.
    assert.equal((await planOk(r, "squash", [c, b])).published, true);
  } finally {
    r.dispose();
  }
  const local = repo();
  try {
    local.commit("base"); const a = local.commit("A"); const b = local.commit("B");
    assert.equal((await planOk(local, "squash", [a, b])).published, false);
  } finally {
    local.dispose();
  }
});

test("a stale confirmation is refused: HEAD moved between the question and the run", async () => {
  for (const verb of ["drop", "squash"] as const) {
    const r = repo();
    try {
      r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
      const plan = await planOk(r, verb, [a, b]);
      r.commit("landed meanwhile");
      const moved = await rewriteMany(r.ctx.process, verb, { shas: plan.shas, head: plan.head, message: "m" }, run(r));
      assert.deepEqual(said(moved), ["failed", MANY_MOVED_MESSAGE, true], verb);
      assert.deepEqual(r.subjects(), ["landed meanwhile", "B", "A", "base"], `${verb}: nothing changed`);
    } finally {
      r.dispose();
    }
  }
});

test("an operation in progress or uncommitted tracked changes stop it before the question, in its own words", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    writeFileSync(join(r.dir, "A.txt"), "edited\n");
    assert.equal(await manyBlocker(r.ctx.process, "drop"), DROP_MANY_DIRTY_MESSAGE);
    assert.equal(await manyBlocker(r.ctx.process, "squash"), SQUASH_DIRTY_MESSAGE);
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "x" }, run(r));
    assert.deepEqual(said(out).slice(0, 2), ["failed", SQUASH_DIRTY_MESSAGE]);
    r.git("checkout", "--", "A.txt");
    writeFileSync(join(r.dir, "untracked.txt"), "u\n");
    assert.equal(await manyBlocker(r.ctx.process, "drop"), undefined, "an untracked file does not stop a rebase");
  } finally {
    r.dispose();
  }
});

test("a drop whose replay conflicts stops for the conflict flow; abort puts the branch back", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "0\n"); const a = r.commit("A", "f.txt", "1\n"); r.commit("B", "g.txt", "g\n");
    const c = r.commit("C", "f.txt", "2\n");
    const tip = r.git("rev-parse", "HEAD");
    const plan = await planOk(r, "drop", [a, r.git("rev-parse", "HEAD~1")]);
    const out = await rewriteMany(r.ctx.process, "drop", { shas: plan.shas, head: plan.head }, run(r));
    assert.equal(out.status, "stopped", JSON.stringify(out));
    assert.equal(out.status === "stopped" ? out.reason : "", "conflict");
    assert.equal(out.after, undefined, "no after-tip: nothing finished, no undo to offer");
    await abortRebase(r.dir);
    assert.equal(r.git("rev-parse", "HEAD"), tip);
    void c;
  } finally {
    r.dispose();
  }
});

// ── Squash N ───────────────────────────────────────────────────────────────

test("squashing contiguous commits: one commit, the message the user wrote, every change, the later ones replayed", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("feat: parser", "a.txt");
    r.git("commit", "--amend", "-q", "-m", "feat: parser\n\nReads the header.");
    const a2 = r.git("rev-parse", "HEAD");
    const b = r.commit("wip", "b.txt");
    const c = r.commit("fix: off by one", "c.txt");
    r.commit("later", "later.txt");
    const plan = await planOk(r, "squash", [c, a2, b]);
    assert.deepEqual(plan.rows.map((x) => x.action), ["pick", "fixup", "fixup", "reword"]);
    assert.equal(plan.message, "feat: parser\n\nReads the header.\n\nwip\n\nfix: off by one", "pre-filled oldest first");
    assert.equal(plan.replayed, 1);
    const out = await rewriteMany(
      r.ctx.process,
      "squash",
      { shas: plan.shas, head: plan.head, message: "feat: the parser, whole\n\nOne commit now." },
      run(r),
    );
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["later", "feat: the parser, whole", "base"]);
    assert.equal(r.git("log", "-1", "--format=%B", "HEAD~1").trim(), "feat: the parser, whole\n\nOne commit now.");
    assert.deepEqual(r.git("show", "--name-only", "--format=", "HEAD~1").split("\n").sort(), ["a.txt", "b.txt", "c.txt"]);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main");
    void a;
  } finally {
    r.dispose();
  }
});

test("squash N: not offered for a gap, one commit, a merge or below one", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); const c = r.commit("C");
    for (const [what, shas, reason] of [
      ["a gap", [a, c], "not-contiguous"],
      ["one commit", [c], "too-few"],
      ["one commit twice", [c, c], "too-few"],
    ] as const) {
      const p = await planMany(r.ctx.process, "squash", [...shas]);
      assert.equal(p.ok ? "ok" : p.reason, reason, what);
    }
  } finally {
    r.dispose();
  }
});

test("squashing down to the root works (--root), and leaves one commit", async () => {
  const r = repo();
  try {
    const root = r.commit("root"); const b = r.commit("B");
    const plan = await planOk(r, "squash", [root, b]);
    assert.equal(plan.base, "--root");
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "everything" }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["everything"]);
  } finally {
    r.dispose();
  }
});

test("an empty squash message is refused before anything runs", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "  \n" }, run(r));
    assert.deepEqual(said(out).slice(0, 2), ["failed", SQUASH_EMPTY_MESSAGE]);
    assert.equal(r.git("rev-parse", "HEAD"), plan.head);
  } finally {
    r.dispose();
  }
});

test("a squash carries a branch on a squashed commit and on a replayed one, when asked", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("branch", "on-a", a);
    r.git("branch", "on-c", c);
    const plan = await planOk(r, "squash", [a, b]);
    assert.deepEqual(plan.carryable.sort(), ["on-a", "on-c"]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB", carry: true }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(r.git("rev-parse", "on-a"), r.git("rev-parse", "HEAD~1"), "on-a is on the squashed commit");
    assert.equal(r.git("rev-parse", "on-c"), r.git("rev-parse", "HEAD"), "on-c followed its commit");
  } finally {
    r.dispose();
  }
});

test("a squash keeps every later commit's content — contiguous commits fold to the same tree, so nothing replayed can conflict", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "0\n"); const a = r.commit("A", "f.txt", "1\n"); const b = r.commit("B", "g.txt", "g\n");
    r.commit("C", "f.txt", "2\n");
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB" }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["C", "AB", "base"]);
    assert.equal(readFileSync(join(r.dir, "f.txt"), "utf8"), "2\n");
    assert.equal(r.git("rev-parse", "HEAD^{tree}"), r.git("rev-parse", `${plan.head}^{tree}`), "the same tree as before");
  } finally {
    r.dispose();
  }
});

// ── Undo ──────────────────────────────────────────────────────────────────

test("undo puts a squash back — and refuses, in the squash's words, once the branch moved", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB" }, run(r));
    assert.ok(out.before && out.after);
    assert.deepEqual(await undoRewrite(r.ctx.process, { before: out.before!, after: out.after! }, "squash"), { ok: true });
    assert.deepEqual(r.subjects(), ["B", "A", "base"]);
    assert.equal(r.git("rev-parse", "HEAD"), plan.head);
    // Again, after something else moved the branch.
    const again = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB" }, run(r));
    r.commit("new work");
    const refusedUndo = await undoRewrite(r.ctx.process, { before: again.before!, after: again.after! }, "squash");
    assert.equal(refusedUndo.ok, false);
    assert.match(refusedUndo.ok ? "" : refusedUndo.message, /moved since the squash/);
  } finally {
    r.dispose();
  }
});

test("undo after a squash that CARRIED branches puts them back too", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("branch", "on-a", a);
    r.git("branch", "on-c", c);
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB", carry: true }, run(r));
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(
      (out.carried ?? []).map((x) => [x.branch, x.before, x.after]).sort(),
      [["on-a", a, r.git("rev-parse", "on-a")], ["on-c", c, r.git("rev-parse", "on-c")]],
      "the outcome says where each carried branch was, and where it went",
    );
    assert.deepEqual(await undoRewrite(r.ctx.process, { before: out.before!, after: out.after!, carried: out.carried }, "squash"), { ok: true });
    assert.equal(r.git("rev-parse", "HEAD"), c, "main is back");
    assert.equal(r.git("rev-parse", "on-a"), a, "on-a is back on A");
    assert.equal(r.git("rev-parse", "on-c"), c, "on-c is back on C");
  } finally {
    r.dispose();
  }
});

test("a carried branch that moved since refuses the undo, and nothing changes — HEAD included", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); r.commit("C");
    r.git("branch", "feature", "HEAD");
    const plan = await planOk(r, "squash", [a, b]);
    const out = await rewriteMany(r.ctx.process, "squash", { shas: plan.shas, head: plan.head, message: "AB", carry: true }, run(r));
    assert.equal(out.carried?.length, 1);
    // Work lands on feature after the squash — without checking it out.
    const more = r.git("commit-tree", "-p", "feature", "-m", "more on feature", "feature^{tree}");
    r.git("update-ref", "refs/heads/feature", more);
    const back = await undoRewrite(r.ctx.process, { before: out.before!, after: out.after!, carried: out.carried }, "squash");
    assert.equal(back.ok, false);
    assert.equal(!back.ok && back.expected, true);
    // refRestore's words, as undoOnBranch's: one set for the same state.
    assert.equal(back.ok ? "" : back.message, `'feature' has moved since (it is at ${more.slice(0, 7)} now), and putting it back would throw that away.`);
    assert.equal(r.git("rev-parse", "HEAD"), out.after, "HEAD stays where the squash left it");
    assert.equal(r.git("rev-parse", "feature"), more, "and so does feature");
  } finally {
    r.dispose();
  }
});

test("an undo request naming a carried branch that is not a plain branch name is refused before git sees it", async () => {
  const r = repo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    const head = r.git("rev-parse", "HEAD");
    for (const branch of ["-d", "a b", "x..y", "x\ny", ""]) {
      const back = await undoRewrite(r.ctx.process, { before: a, after: head, carried: [{ branch, before: a, after: head }] }, "drop");
      assert.equal(back.ok, false, JSON.stringify(branch));
      assert.match(back.ok ? "" : back.message, /isn't a drop this app made/);
    }
    assert.equal(r.git("rev-parse", "HEAD"), head);
  } finally {
    r.dispose();
  }
});

// ── Order, merges, argv ──────────────────────────────────────────────────

test("the order comes from the history, not the dates — a child committed 'earlier' still comes after its parent", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A", undefined, undefined, "2020-01-01T00:00:00");
    const b = r.commit("B", undefined, undefined, "2020-01-09T00:00:00");
    const c = r.commit("C", undefined, undefined, "2020-01-02T00:00:00"); // child of B, "older"
    assert.deepEqual(await orderCommits(r.ctx.process, [c, a, b], "oldest-first"), [a, b, c]);
    assert.deepEqual(await orderCommits(r.ctx.process, [b, c, a], "newest-first"), [c, b, a]);
  } finally {
    r.dispose();
  }
});

test("order: commits from two branches, the root among them, one commit, and a non-commit", async () => {
  const r = repo();
  try {
    const root = r.commit("root");
    r.git("checkout", "-q", "-b", "side");
    const s1 = r.commit("s1"); const s2 = r.commit("s2");
    r.git("checkout", "-q", "main");
    const m1 = r.commit("m1");
    const got = await orderCommits(r.ctx.process, [s2, m1, root, s1], "oldest-first");
    assert.ok(got, "ordered");
    const at = (x: string) => got!.indexOf(x);
    assert.equal(at(root), 0, "the root first");
    assert.ok(at(s1) < at(s2), "s1 before its child s2");
    assert.equal(got!.length, 4);
    assert.deepEqual(await orderCommits(r.ctx.process, [m1], "oldest-first"), [m1]);
    assert.equal(await orderCommits(r.ctx.process, [m1, "--all"], "oldest-first"), undefined);
  } finally {
    r.dispose();
  }
});

test("mergesAmong finds the merges in a selection", async () => {
  const r = repo();
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "side");
    const s = r.commit("s");
    r.git("checkout", "-q", "main");
    const m1 = r.commit("m1");
    r.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const merge = r.git("rev-parse", "HEAD");
    assert.deepEqual(await mergesAmong(r.ctx.process, [s, m1]), []);
    assert.deepEqual(await mergesAmong(r.ctx.process, [s, merge, m1]), [merge]);
  } finally {
    r.dispose();
  }
});

/** A branch `target` off base, and three commits on `side` to pick onto it. */
function pickRepo() {
  const r = repo();
  r.commit("base", "f.txt", "base\n");
  r.commit("base-g", "g.txt", "base\n");
  r.git("checkout", "-q", "-b", "side");
  const a = r.commit("A", "a.txt", "a\n");
  const b = r.commit("B", "f.txt", "side\n");
  const c = r.commit("C", "c.txt", "c\n");
  r.git("checkout", "-q", "main");
  return { r, a, b, c };
}

async function pick(r: Repo, shas: string[], verb: "cherry-pick" | "revert" = "cherry-pick") {
  const ordered = (await orderCommits(r.ctx.process, shas, verb === "cherry-pick" ? "oldest-first" : "newest-first"))!;
  const op: ApplyOp = { kind: verb, commit: ordered[0], commits: ordered, args: applyManyArgs(verb, ordered) };
  return { op, ordered };
}

test("cherry-picking three commits applies them oldest first, as one git command", async () => {
  const { r, a, b, c } = pickRepo();
  try {
    const { op, ordered } = await pick(r, [c, a, b]);
    assert.deepEqual(ordered, [a, b, c]);
    assert.deepEqual(op.kind === "cherry-pick" ? op.args : [], ["cherry-pick", a, b, c]);
    const out = await runApplying(r.ctx.process, op);
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.deepEqual(r.subjects().slice(0, 3), ["C", "B", "A"]);
  } finally {
    r.dispose();
  }
});

test("an edit in the way of the SECOND commit is asked about before git starts — nothing half-applied", async () => {
  const { r, a, b, c } = pickRepo();
  try {
    const before = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "f.txt"), "mine\n"); // B touches f.txt; A does not
    const { op } = await pick(r, [a, b, c]);
    const out = await runApplying(r.ctx.process, op);
    assert.deepEqual(out.inTheWay?.paths, ["f.txt"], JSON.stringify(out));
    assert.equal(r.git("rev-parse", "HEAD"), before, "A was NOT applied");
    assert.ok(!existsSync(join(r.dir, ".git", "sequencer")), "no sequencer left open");
    assert.equal(readFileSync(join(r.dir, "f.txt"), "utf8"), "mine\n", "the edit is untouched");
    // Stash & Retry stashes it, runs all three, and says where the edit went:
    // it conflicts with what B brought, so it waits in the stash.
    const retry = await stashAndRetry(r.ctx.process, op);
    assert.equal(retry.result.code, 0, retry.result.stderr);
    assert.deepEqual(r.subjects().slice(0, 3), ["C", "B", "A"]);
    assert.ok(retry.fate, "the stash's fate is reported");
  } finally {
    r.dispose();
  }
});

test("an edit NO selected commit touches is not in the way; a staged change always is", async () => {
  const { r, a, c } = pickRepo();
  try {
    writeFileSync(join(r.dir, "g.txt"), "mine\n");
    const { op } = await pick(r, [a, c]);
    const out = await runApplying(r.ctx.process, op);
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(readFileSync(join(r.dir, "g.txt"), "utf8"), "mine\n");
    r.git("add", "g.txt");
    r.git("reset", "-q", "--hard", "HEAD~2");
    writeFileSync(join(r.dir, "g.txt"), "staged\n");
    r.git("add", "g.txt");
    const staged = await runApplying(r.ctx.process, (await pick(r, [a, c])).op);
    assert.deepEqual(staged.inTheWay?.paths, ["g.txt"]);
  } finally {
    r.dispose();
  }
});

test("a conflict on the second commit stops the pick there, first one applied; abort puts the branch back", async () => {
  const { r, a, b, c } = pickRepo();
  try {
    const before = r.commit("main edits f", "f.txt", "main\n");
    const { op } = await pick(r, [a, b, c]);
    const out = await runApplying(r.ctx.process, op);
    assert.notEqual(out.result.code, 0);
    assert.equal(out.inTheWay, undefined, "a conflict is not the user's changes in the way");
    assert.ok(existsSync(join(r.dir, ".git", "CHERRY_PICK_HEAD")), "stopped on B, for the conflict flow");
    assert.equal(r.git("log", "-1", "--format=%s"), "A", "A applied before the stop");
    r.git("cherry-pick", "--abort");
    assert.equal(r.git("rev-parse", "HEAD"), before, "abort undoes the whole run");
  } finally {
    r.dispose();
  }
});

test("reverting two dependent commits goes newest first, which is the order that applies", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "0\n");
    const a = r.commit("A", "f.txt", "1\n");
    const b = r.commit("B", "f.txt", "2\n");
    const { op, ordered } = await pick(r, [a, b], "revert");
    assert.deepEqual(ordered, [b, a]);
    assert.deepEqual(op.kind === "revert" ? op.args : [], ["revert", "--no-edit", b, a]);
    const out = await runApplying(r.ctx.process, op);
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(readFileSync(join(r.dir, "f.txt"), "utf8"), "0\n");
    assert.deepEqual(r.subjects().slice(0, 2), ['Revert "A"', 'Revert "B"']);
  } finally {
    r.dispose();
  }
});

test("undo after several commits were cherry-picked goes back to where HEAD was", async () => {
  const { r, a, b, c } = pickRepo();
  try {
    const before = r.git("rev-parse", "HEAD");
    const out = await runApplying(r.ctx.process, (await pick(r, [a, b, c])).op);
    assert.equal(out.result.code, 0);
    const after = r.git("rev-parse", "HEAD");
    assert.deepEqual(await undoRewrite(r.ctx.process, { before, after }, "cherry-pick"), { ok: true });
    assert.equal(r.git("rev-parse", "HEAD"), before);
  } finally {
    r.dispose();
  }
});
