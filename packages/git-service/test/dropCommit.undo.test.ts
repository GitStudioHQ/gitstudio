import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess, type GitRunResult, type GitRunWithInputOptions } from "../src/GitProcess";
import { runRebasePlan } from "../src/RebaseRunner";
import { dropCommit, planDropCommit, undoDrop, undoRewrite, type DropOutcome } from "../src/dropCommit";
import { operationInTheWayMessage } from "../src/stoppedOperation";
import { removeTempRepo } from "./tmpRepo";

// The way back from a drop (and from any rewrite that shares it: squash,
// drop-many, cherry-pick…), in the states the happy-path suite does not build:
// a merge left half-way, uncommitted work in the way of `reset --keep`, HEAD
// that changed branches or detached since, and git refusing a ref write.
// Every refusal must leave every ref exactly where it was.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  read: (file: string) => string;
  write: (file: string, body: string) => void;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-dropundo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.email", "d@e.com");
  git("config", "user.name", "D");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  git("config", "advice.detachedHead", "false");
  const write = (file: string, body: string) => writeFileSync(join(dir, file), body);
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    write(file, body);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, write, read: (f) => readFileSync(join(dir, f), "utf8"), dispose: () => removeTempRepo(dir) };
}

/** A real git, except commands `pick` matches exit 1 with "rigged refusal". */
class Refusing extends GitProcess {
  constructor(
    cwd: string,
    private readonly pick: (args: string[]) => boolean,
    private readonly stderr = "rigged refusal",
  ) {
    super({ cwd });
  }
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    if (this.pick(args)) return { code: 1, stdout: "", stderr: this.stderr };
    return super.run(args, opts);
  }
}

/**
 * base ── A (edits f.txt) ── B ── C   on main, with `side` at B and `other`
 * (a branch off base adding other.txt, for a clean `merge --no-commit`).
 * Drops A (carrying `side` when asked) and returns the outcome.
 */
async function dropped(r: Repo, carry: boolean): Promise<{ out: DropOutcome; a: string; b: string; c: string }> {
  r.commit("base", "f.txt", "f base\n");
  r.git("branch", "other");
  const a = r.commit("A", "f.txt", "f from A\n");
  const b = r.commit("B");
  r.git("branch", "side", b);
  const c = r.commit("C");
  r.git("checkout", "-q", "other");
  r.commit("O", "other.txt", "other\n");
  r.git("checkout", "-q", "main");
  const proc = new GitProcess({ cwd: r.dir });
  const plan = await planDropCommit(proc, a);
  if (!plan.ok) throw new Error(plan.message);
  const out = await dropCommit(proc, { sha: plan.sha, head: plan.head, carry }, (p) => runRebasePlan(r.dir, p));
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(r.read("f.txt"), "f base\n", "precondition: the drop took A's edit out");
  return { out, a, b, c };
}

const refs = (r: Repo) => r.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");

test("undoDrop for a drop made on a detached HEAD refuses once HEAD is on a branch", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    r.commit("B");
    r.git("checkout", "-q", "--detach");
    const proc = new GitProcess({ cwd: r.dir });
    const plan = await planDropCommit(proc, a);
    if (!plan.ok) return assert.fail(plan.message);
    const out = await dropCommit(proc, { sha: plan.sha, head: plan.head }, (p) => runRebasePlan(r.dir, p));
    assert.equal(out.branch, null, "a detached drop names no branch");
    r.git("checkout", "-q", "-b", "made-here");
    const before = refs(r);
    const back = await undoDrop(proc, { before: out.before!, after: out.after!, branch: out.branch });
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: "HEAD was detached when the commit was dropped, and it's on a branch now. Detach it again, then undo.",
    });
    assert.equal(refs(r), before, "no branch moved");
  } finally {
    r.dispose();
  }
});

test("undoDrop on its own branch refuses while a merge is in progress, in the words every door uses", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    r.git("merge", "--no-commit", "--no-ff", "other");
    const before = refs(r);
    const back = await undoDrop(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after!, branch: out.branch });
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: operationInTheWayMessage({ operation: "merge", unmerged: 0, kind: "reset" }),
    });
    assert.equal(refs(r), before);
    assert.equal(r.git("rev-parse", "-q", "--verify", "MERGE_HEAD").length > 0, true, "the merge is left as it was");
  } finally {
    r.dispose();
  }
});

test("undoDrop over uncommitted edits to a file the drop changed refuses, and keeps the edits", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    r.write("f.txt", "my own edit\n");
    const back = await undoDrop(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after!, branch: out.branch });
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: "Your uncommitted changes touch files the drop changed. Commit or stash them, then undo.",
    });
    assert.equal(r.read("f.txt"), "my own edit\n");
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});

test("undoDrop blocked by an UNTRACKED file in the way reports git's own reason", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A"); // adds A.txt
    r.commit("B");
    const proc = new GitProcess({ cwd: r.dir });
    const plan = await planDropCommit(proc, a);
    if (!plan.ok) return assert.fail(plan.message);
    const out = await dropCommit(proc, { sha: plan.sha, head: plan.head }, (p) => runRebasePlan(r.dir, p));
    r.write("A.txt", "untracked, mine\n");
    const back = await undoDrop(proc, { before: out.before!, after: out.after!, branch: out.branch });
    assert.equal(back.ok, false);
    assert.equal(!back.ok && back.expected, undefined, "not the uncommitted-changes case: git's refusal, unexplained");
    assert.match(!back.ok ? back.message : "", /A\.txt/);
    assert.equal(r.read("A.txt"), "untracked, mine\n");
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});

test("undoDrop of a branch not checked out here reports git refusing the ref write", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    r.git("checkout", "-q", "other");
    const proc = new Refusing(r.dir, (a) => a[0] === "update-ref" && a.includes("refs/heads/main"));
    const back = await undoDrop(proc, { before: out.before!, after: out.after!, branch: out.branch });
    assert.deepEqual(back, {
      ok: false,
      message: `Undo couldn't move 'main' back to ${out.before!.slice(0, 7)}: rigged refusal`,
    });
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});

test("undoDrop that puts the branch back but not a carried one says exactly that", async () => {
  const r = repo();
  try {
    const { out, c } = await dropped(r, true);
    assert.equal(out.carried?.[0]?.branch, "side");
    const proc = new Refusing(r.dir, (a) => a[0] === "update-ref" && a.includes("refs/heads/side"));
    const back = await undoDrop(proc, { before: out.before!, after: out.after!, branch: out.branch, carried: out.carried });
    assert.equal(back.ok, false);
    assert.match(!back.ok ? back.message : "", /^The dropped commit is back, but side isn't: Undo couldn't move 'side' back/);
    assert.equal(r.git("rev-parse", "main"), c, "main IS back");
  } finally {
    r.dispose();
  }
});

// ── undoRewrite: the shared way back ───────────────────────────────────────

test("undoRewrite with the rewrite's own branch puts THAT branch back, with a reflog naming the rewrite", async () => {
  const r = repo();
  try {
    const { out, c } = await dropped(r, false);
    r.git("checkout", "-q", "-b", "later-here"); // HEAD moves to a branch at the new tip
    const back = await undoRewrite(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after!, branch: out.branch }, "squash");
    assert.deepEqual(back, { ok: true });
    assert.equal(r.git("rev-parse", "main"), c);
    assert.equal(r.git("rev-parse", "later-here"), out.after, "the branch made since is untouched");
    assert.equal(r.git("reflog", "-1", "--format=%gs", "refs/heads/main"), "GitStudio undo: squash");
  } finally {
    r.dispose();
  }
});

test("undoRewrite of a rewrite made detached refuses once HEAD is on a branch", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    const back = await undoRewrite(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after!, branch: null }, "squash");
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: "HEAD was detached when the squash ran, and it's on a branch now. Detach it again, then undo.",
    });
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});

test("undoRewrite refuses while a merge is in progress", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    r.git("merge", "--no-commit", "--no-ff", "other");
    const back = await undoRewrite(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after! }, "cherry-pick");
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: operationInTheWayMessage({ operation: "merge", unmerged: 0, kind: "reset" }),
    });
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});

test("undoRewrite over uncommitted edits the rewrite touched refuses in its own words", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    r.write("f.txt", "edited after\n");
    const back = await undoRewrite(new GitProcess({ cwd: r.dir }), { before: out.before!, after: out.after! }, "squash");
    assert.deepEqual(back, {
      ok: false,
      expected: true,
      message: "Your uncommitted changes touch files the squash changed. Commit or stash them, then undo.",
    });
    assert.equal(r.read("f.txt"), "edited after\n");
  } finally {
    r.dispose();
  }
});

test("undoRewrite that cannot put a carried branch back says the branch is back but that one isn't", async () => {
  const r = repo();
  try {
    const { out, c } = await dropped(r, true);
    const proc = new Refusing(r.dir, (a) => a[0] === "update-ref" && a.includes("refs/heads/side"));
    const back = await undoRewrite(proc, { before: out.before!, after: out.after!, carried: out.carried }, "squash");
    assert.equal(back.ok, false);
    assert.match(!back.ok ? back.message : "", /^The branch is back, but side isn't: /);
    assert.equal(r.git("rev-parse", "main"), c);
  } finally {
    r.dispose();
  }
});

test("undoRewrite refuses tips, branches and carried entries it did not hand out, naming the operation", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, true);
    const proc = new GitProcess({ cwd: r.dir });
    const before = refs(r);
    const bad = [
      { before: out.before!, after: out.after!, branch: "main" }, // not a full refs/heads/ name
      { before: "HEAD~1", after: out.after! },
      { before: out.before!, after: out.after!, carried: [{ branch: "-f", before: out.before!, after: out.after! }] },
      { before: out.before!, after: out.after!, carried: [{ branch: "a..b", before: out.before!, after: out.after! }] },
      { before: out.before!, after: out.after!, carried: [{ branch: "x", before: "abc", after: out.after! }] },
    ];
    for (const u of bad) {
      assert.deepEqual(await undoRewrite(proc, u, "squash"), { ok: false, message: "That isn't a squash this app made." }, JSON.stringify(u));
    }
    assert.deepEqual(
      await undoDrop(proc, { before: out.before!, after: out.after!, carried: [{ branch: "has space", before: out.before!, after: out.after! }] }),
      { ok: false, message: "That isn't a drop this app made." },
    );
    assert.equal(refs(r), before, "nothing moved");
  } finally {
    r.dispose();
  }
});

test("a reset --keep refused with no words at all still gets a sentence, and nothing moves", async () => {
  const r = repo();
  try {
    const { out } = await dropped(r, false);
    const proc = new Refusing(r.dir, (a) => a[0] === "reset", "");
    const back = await undoRewrite(proc, { before: out.before!, after: out.after! }, "squash");
    assert.deepEqual(back, { ok: false, message: "Couldn't put the branch back." });
    assert.equal(r.git("rev-parse", "main"), out.after);
  } finally {
    r.dispose();
  }
});
