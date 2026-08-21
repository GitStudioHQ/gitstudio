import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRewritableChain } from "../src/rebaseChain";
import { buildRebasePlan } from "../src/rebasePlan";
import { runRebasePlan } from "../src/RebaseRunner";
import { moveToGap } from "@gitstudio/engine/rebase/chain";
import { GitContext } from "../src/GitContext";

// The whole drag-to-reorder path, end to end, against real git.
//
// This is the test that matters: everything else pins a piece. This one starts
// from "the user dragged row 0 into gap 2" and asserts on the repository
// afterwards — because the feature rewrites history from a pointer gesture, and
// a wrong answer here is somebody's work.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (args: string[]) => string;
  commit: (msg: string) => void;
  subjects: (ref?: string) => string[];
  ctx: GitContext;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-reorder-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  git(["config", "user.email", "d@e.com"]);
  git(["config", "user.name", "D"]);
  git(["config", "commit.gpgsign", "false"]);
  const commit = (msg: string) => {
    writeFileSync(join(dir, `${msg}.txt`), `${msg}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", msg]);
  };
  const subjects = (ref = "HEAD") =>
    git(["log", "--format=%s", ref]).split("\n").filter(Boolean);
  const ctx = new GitContext({ root: dir });
  return {
    dir, git, commit, subjects, ctx,
    dispose: () => {
      ctx.dispose();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 120 });
      } catch {
        /* git background processes may still hold it; the temp dir is disposable */
      }
    },
  };
}

/** Exactly what graphPanel.reorderCommits does, minus the vscode dialogs. */
async function applyReorder(
  r: Repo,
  from: number,
  gap: number,
  opts: { carry?: boolean } = {},
): Promise<{ status: string }> {
  const chain = await readRewritableChain(r.ctx.process);
  const current = r.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const order = moveToGap(chain.shas, from, gap);
  const rows = order.map((sha) => ({
    sha,
    action: "pick",
    subject: r.git(["log", "-1", "--format=%s", sha]),
    // Mirrors graphPanel.carryableBranches: the branch being rebased is
    // EXCLUDED. git moves it itself, and naming it in an update-ref line makes
    // the whole rebase fail with "cannot lock ref".
    branches: opts.carry
      ? r.git(["branch", "--points-at", sha, "--format=%(refname:short)"])
          .split("\n").filter(Boolean).filter((b) => b !== current)
      : undefined,
  }));
  const built = buildRebasePlan(rows, { updateRefs: !!opts.carry });
  assert.ok(built.ok, built.ok ? "" : built.message);
  return runRebasePlan(r.dir, {
    base: chain.base ?? "--root",
    todo: built.todo,
    rewordMessages: built.rewordMessages,
  });
}

test("dragging a commit down reorders exactly those commits", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.commit("B"); r.commit("C");
    // Display is newest-first: C, B, A, base. Drag C (index 0) below B.
    const before = r.subjects();
    assert.deepEqual(before, ["C", "B", "A", "base"]);

    const out = await applyReorder(r, 0, 2);
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["B", "C", "A", "base"]);
  } finally {
    r.dispose();
  }
});

test("dragging up works, and the file contents travel with the commits", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.commit("B"); r.commit("C");
    const out = await applyReorder(r, 2, 0); // A to the top
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["A", "C", "B", "base"]);
    // Every file still present: a reorder must not lose content.
    for (const f of ["base", "A", "B", "C"]) {
      assert.equal(r.git(["cat-file", "-e", `HEAD:${f}.txt`]), "", `${f}.txt survived`);
    }
  } finally {
    r.dispose();
  }
});

test("published commits are untouched — the chain never included them", async () => {
  const r = repo();
  try {
    const bare = mkdtempSync(join(tmpdir(), "gs-reorder-bare-"));
    try {
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: ENV });
      r.commit("base"); r.commit("pushed");
      r.git(["remote", "add", "origin", bare]);
      r.git(["push", "-q", "-u", "origin", "main"]);
      const publishedSha = r.git(["rev-parse", "HEAD"]);
      r.commit("A"); r.commit("B");

      const chain = await readRewritableChain(r.ctx.process);
      assert.deepEqual(
        chain.shas.map((s) => r.git(["log", "-1", "--format=%s", s])),
        ["B", "A"],
        "only the unpushed commits are in play",
      );

      const out = await applyReorder(r, 0, 2);
      assert.equal(out.status, "done", JSON.stringify(out));
      assert.deepEqual(r.subjects(), ["A", "B", "pushed", "base"]);
      assert.equal(
        r.git(["rev-parse", "HEAD~2"]),
        publishedSha,
        "the published commit keeps its identity — it was never rewritten",
      );
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 20, retryDelay: 120 });
    }
  } finally {
    r.dispose();
  }
});

test("a merge below the chain survives the reorder above it", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A");
    r.git(["checkout", "-q", "-b", "side"]); r.commit("side-1");
    r.git(["checkout", "-q", "main"]);
    r.git(["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    r.commit("X"); r.commit("Y");

    const chain = await readRewritableChain(r.ctx.process);
    assert.equal(chain.stop, "merge");
    assert.deepEqual(chain.shas.map((s) => r.git(["log", "-1", "--format=%s", s])), ["Y", "X"]);

    const out = await applyReorder(r, 0, 2);
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects().slice(0, 3), ["X", "Y", "merge side"]);
    // The merge is still a merge — not flattened.
    assert.equal(
      r.git(["rev-list", "--merges", "--count", "HEAD"]),
      "1",
      "the merge below the chain is intact",
    );
    assert.ok(r.subjects().includes("side-1"), "the merged branch's commit survived");
  } finally {
    r.dispose();
  }
});

test("carrying branches: they land on the rewritten commits", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.git(["branch", "feat-1"]);
    r.commit("B"); r.git(["branch", "feat-2"]); r.commit("C");

    const out = await applyReorder(r, 2, 0, { carry: true }); // A to the top
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.deepEqual(r.subjects(), ["A", "C", "B", "base"]);
    assert.equal(r.subjects("feat-1")[0], "A");
    assert.equal(r.subjects("feat-2")[0], "B");
    for (const b of ["feat-1", "feat-2"]) {
      execFileSync("git", ["merge-base", "--is-ancestor", b, "main"], {
        cwd: r.dir, env: ENV,
      });
    }
  } finally {
    r.dispose();
  }
});

test("NOT carrying branches leaves them where they were, off the new history", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.git(["branch", "feat-1"]);
    r.commit("B"); r.commit("C");
    const oldA = r.git(["rev-parse", "feat-1"]);

    const out = await applyReorder(r, 2, 0, { carry: false });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(r.git(["rev-parse", "feat-1"]), oldA, "the branch did not move");
    // And it is NOT an ancestor of the rewritten branch — the honest cost of
    // "this branch only", which the dialog says out loud.
    let isAncestor = true;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", "feat-1", "main"], {
        cwd: r.dir, env: ENV, stdio: "ignore",
      });
    } catch {
      isAncestor = false;
    }
    assert.equal(isAncestor, false, "left on a parallel line, as documented");
  } finally {
    r.dispose();
  }
});

test("a conflicting reorder stops cleanly instead of corrupting anything", async () => {
  const r = repo();
  try {
    // Two commits editing the SAME line: swapping them cannot apply cleanly.
    writeFileSync(join(r.dir, "f.txt"), "one\n");
    r.git(["add", "-A"]); r.git(["commit", "-q", "-m", "base"]);
    writeFileSync(join(r.dir, "f.txt"), "two\n");
    r.git(["add", "-A"]); r.git(["commit", "-q", "-m", "A"]);
    writeFileSync(join(r.dir, "f.txt"), "three\n");
    r.git(["add", "-A"]); r.git(["commit", "-q", "-m", "B"]);

    const out = await applyReorder(r, 0, 2); // swap A and B
    assert.equal(out.status, "stopped", `expected a stop, got ${JSON.stringify(out)}`);
    // git leaves the rebase open for the user; nothing is silently wrong.
    const inProgress = r.git(["rev-parse", "--git-path", "rebase-merge"]);
    assert.ok(inProgress.length > 0);
    r.git(["rebase", "--abort"]);
    assert.deepEqual(r.subjects(), ["B", "A", "base"], "abort restores the original order");
  } finally {
    r.dispose();
  }
});

test("a no-op drop rewrites nothing at all", async () => {
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.commit("B");
    const before = r.git(["rev-parse", "HEAD"]);
    const chain = await readRewritableChain(r.ctx.process);
    // Both gaps touching the dragged row are no-ops.
    assert.deepEqual(moveToGap(chain.shas, 0, 0), chain.shas);
    assert.deepEqual(moveToGap(chain.shas, 0, 1), chain.shas);
    assert.equal(r.git(["rev-parse", "HEAD"]), before, "nothing ran");
  } finally {
    r.dispose();
  }
});

test("naming the branch being rebased in update-ref breaks the whole rebase", async () => {
  // The bug this file caught, pinned as behaviour so it cannot come back.
  // graphPanel.carryableBranches excludes the current branch for exactly this
  // reason; without it "carry branches" fails 100% of the time, because HEAD's
  // branch is always the top of the chain.
  const r = repo();
  try {
    r.commit("base"); r.commit("A"); r.commit("B");
    const chain = await readRewritableChain(r.ctx.process);
    const order = moveToGap(chain.shas, 0, 2);
    const built = buildRebasePlan(
      order.map((sha) => ({
        sha,
        action: "pick",
        subject: r.git(["log", "-1", "--format=%s", sha]),
        // Deliberately WRONG: includes "main", the branch being rebased.
        branches: r.git(["branch", "--points-at", sha, "--format=%(refname:short)"])
          .split("\n").filter(Boolean),
      })),
      { updateRefs: true },
    );
    assert.ok(built.ok);
    const out = await runRebasePlan(r.dir, {
      base: chain.base ?? "--root",
      todo: built.todo,
      rewordMessages: built.rewordMessages,
    });
    assert.notEqual(
      out.status,
      "done",
      "git must refuse to update the ref it is rebasing — if this ever passes, " +
        "the exclusion in carryableBranches may no longer be needed",
    );
    assert.match(
      "message" in out ? out.message : "",
      /cannot lock ref|update_ref failed/i,
      `expected git's ref-lock refusal, got: ${JSON.stringify(out)}`,
    );
    try { r.git(["rebase", "--abort"]); } catch { /* may not be mid-rebase */ }
  } finally {
    r.dispose();
  }
});
