import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropRefusalMessage } from "@gitstudio/engine/rebase/drop";
import { GitProcess, type GitRunResult, type GitRunWithInputOptions } from "../src/GitProcess";
import { dropCommit, planDropCommit, carriedBranches, isPublished, revParse } from "../src/dropCommit";
import { removeTempRepo } from "./tmpRepo";

// planDropCommit / dropCommit edges the end-to-end suite (dropCommit.test.ts)
// does not reach: a refused plan reaching the run door, the replay cap, a
// detached HEAD, and git failing part-way through the plan's reads.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (msg: string) => string;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-dropplan-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  git("config", "user.email", "d@e.com");
  git("config", "user.name", "D");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  git("config", "advice.detachedHead", "false");
  const commit = (msg: string) => {
    writeFileSync(join(dir, `${msg}.txt`), `${msg}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, dispose: () => removeTempRepo(dir) };
}

/** A real git, except commands `pick` matches answer with `answer`. */
class Rigged extends GitProcess {
  constructor(
    cwd: string,
    private readonly pick: (args: string[]) => boolean,
    private readonly answer: (real: () => Promise<GitRunResult>) => Promise<GitRunResult>,
  ) {
    super({ cwd });
  }
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    const real = () => super.run(args, opts);
    return this.pick(args) ? this.answer(real) : real();
  }
}

const neverRun = async () => {
  throw new Error("the rebase runner must not be called");
};

test("dropCommit of a commit that is not on the branch is refused in the plan's words, and runs nothing", async () => {
  const r = repo();
  try {
    r.commit("base");
    const tip = r.commit("A");
    const out = await dropCommit(new GitProcess({ cwd: r.dir }), { sha: "0".repeat(40), head: tip }, neverRun);
    assert.deepEqual(out, { status: "failed", expected: true, message: dropRefusalMessage("not-on-branch") });
    assert.equal(r.git("rev-parse", "HEAD"), tip);
  } finally {
    r.dispose();
  }
});

test("a commit further down than the replay cap is refused as too far", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    r.commit("B");
    r.commit("C");
    const proc = new GitProcess({ cwd: r.dir });
    const plan = await planDropCommit(proc, a, { maxReplay: 1 });
    assert.deepEqual(plan, { ok: false, reason: "too-far", message: dropRefusalMessage("too-far") });
    const within = await planDropCommit(proc, a, { maxReplay: 2 });
    assert.equal(within.ok, true, "two replays fit a cap of two");
    assert.equal(within.ok && within.replayed, 2);
  } finally {
    r.dispose();
  }
});

test("a plan made on a detached HEAD names no branch, and carries the branches on replayed commits", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    const b = r.commit("B");
    r.git("branch", "at-b", b);
    r.commit("C");
    r.git("checkout", "-q", "--detach");
    const plan = await planDropCommit(new GitProcess({ cwd: r.dir }), a);
    assert.ok(plan.ok);
    assert.equal(plan.branch, null);
    assert.deepEqual(plan.carryable.sort(), ["at-b", "main"], "main is not HEAD's branch here, so it is carryable too");
    assert.equal(plan.subject, "A");
    assert.equal(plan.shortSha, a.slice(0, 7));
  } finally {
    r.dispose();
  }
});

test("when the history walk fails the commit is not offered", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    r.commit("B");
    const proc = new Rigged(r.dir, (args) => args[0] === "rev-list" && args.includes("--first-parent"), async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: walk failed",
    }));
    assert.deepEqual(await planDropCommit(proc, a), {
      ok: false,
      reason: "not-on-branch",
      message: dropRefusalMessage("not-on-branch"),
    });
  } finally {
    r.dispose();
  }
});

test("walk lines without a subject still plan (with empty subjects), and blank ids are skipped", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    const b = r.commit("B");
    const proc = new Rigged(
      r.dir,
      (args) => args[0] === "rev-list" && args.includes("--first-parent"),
      async (real) => {
        const res = await real();
        // Strip each "\x1f<subject>" and add a line that is only whitespace-separated nothing.
        const stdout = `${res.stdout.split("\n").map((l) => l.split("\x1f")[0]).join("\n")}\n \x1f\n`;
        return { ...res, stdout };
      },
    );
    const plan = await planDropCommit(proc, a);
    assert.ok(plan.ok, plan.ok ? "" : plan.message);
    assert.equal(plan.subject, "");
    assert.deepEqual(plan.rows.map((x) => [x.sha, x.action, x.subject]), [
      [b, "pick", ""],
      [a, "drop", ""],
    ]);
  } finally {
    r.dispose();
  }
});

test("when the branch listing fails, the plan still stands — it just offers nothing to carry", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A");
    const b = r.commit("B");
    r.git("branch", "at-b", b);
    const proc = new Rigged(r.dir, (args) => args[0] === "for-each-ref", async () => ({ code: 1, stdout: "", stderr: "x" }));
    const plan = await planDropCommit(proc, a);
    assert.ok(plan.ok);
    assert.deepEqual(plan.carryable, []);
    assert.equal(plan.rows[0].branches, undefined);
  } finally {
    r.dispose();
  }
});

test("carriedBranches reports only the branches the rewrite actually moved", async () => {
  const r = repo();
  try {
    const base = r.commit("base");
    const a = r.commit("A");
    r.git("branch", "moved", base); // stands in for a branch the rewrite moved off `a`
    r.git("branch", "stayed", a);
    const got = await carriedBranches(new GitProcess({ cwd: r.dir }), [
      { sha: a, action: "pick", subject: "A", branches: ["moved", "stayed", "deleted-since"] },
      { sha: base, action: "pick", subject: "base" },
    ]);
    assert.deepEqual(got, [{ branch: "moved", before: a, after: base }]);
  } finally {
    r.dispose();
  }
});

test("revParse and isPublished answer from git, and say nothing for what git cannot resolve", async () => {
  const r = repo();
  try {
    const base = r.commit("base");
    const tip = r.commit("A");
    const proc = new GitProcess({ cwd: r.dir });
    assert.equal(await revParse(proc, "HEAD"), tip);
    assert.equal(await revParse(proc, "0".repeat(40) + "^{commit}"), undefined);
    assert.equal(await isPublished(proc, tip), false, "no remote-tracking ref reaches it");
    r.git("update-ref", "refs/remotes/origin/main", base);
    assert.equal(await isPublished(proc, base), true);
    assert.equal(await isPublished(proc, tip), false, "the remote is behind it");
  } finally {
    r.dispose();
  }
});
