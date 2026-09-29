// SyncOps when git itself cannot answer a question it asks along the way — a
// `git remote` that fails, a status or rev-list that errors, a pull that
// leaves conflicts with no operation marker. Real git does not fail these on
// demand, so a real repository is driven through a GitProcess that answers
// the one command under test with a canned failure (see routedProc); every
// other command is real, and the assertions are on the repository and the
// result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { SyncOps } from "../src/SyncOps";
import { makeRepo } from "./opRepo";
import { bareRepo, routedProc, starts, synced } from "./syncOps.fixture";
import { removeTempRepo } from "./tmpRepo";

test("when `git remote` fails, a first push publishes nowhere rather than guessing", async () => {
  const r = makeRepo("remote-fails");
  const bare = bareRepo("remote-fails");
  try {
    r.write("f.txt", "x\n");
    r.commitAll("base");
    r.git("remote", "add", "origin", bare);
    const ctx = r.ctx();
    const pushed: string[][] = [];
    const proc = routedProc(ctx.process, (args) => {
      if (args[0] === "push") pushed.push(args);
      return args.length === 1 && args[0] === "remote" ? { code: 128, stderr: "fatal: broken config" } : undefined;
    });
    const out = await new SyncOps(proc).push();
    assert.equal(out.ok, false);
    assert.deepEqual(pushed, [["push"]], "no remote and no --set-upstream were chosen for it");
    const refs = execFileSync("git", ["for-each-ref"], { cwd: bare, encoding: "utf8" });
    assert.equal(refs.trim(), "", "nothing reached the remote");
  } finally {
    r.cleanup();
    removeTempRepo(bare);
  }
});

test("a rev-list that fails counts as nothing ahead or behind, never as garbage", async () => {
  const s = synced("revlist");
  try {
    s.me.write("a.txt", "a\n");
    s.me.commitAll("a");
    const ctx = s.ctx();
    const proc = routedProc(ctx.process, (args) =>
      starts(args, "rev-list", "--left-right") ? { code: 128, stderr: "fatal: bad revision" } : undefined,
    );
    assert.deepEqual(await new SyncOps(proc).aheadBehind(), { ahead: 0, behind: 0 });
    assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 1, behind: 0 }, "the real count, for contrast");
  } finally {
    s.cleanup();
  }
});

/** me and the remote both edited f.txt's second line, so a merge conflicts. */
function conflicting(name: string): ReturnType<typeof synced> {
  const s = synced(name);
  const o = s.other();
  o.write("f.txt", "base\ntheirs\n");
  o.commitAll("theirs");
  o.git("push", "-q", "origin", "main");
  s.me.write("f.txt", "base\nmine\n");
  s.me.commitAll("mine");
  s.me.git("fetch", "-q");
  return s;
}

test("a pull that leaves conflicts but no operation marker is named after the mode that was asked for", async () => {
  for (const mode of ["rebase", "merge"] as const) {
    const s = synced(`nomarker-${mode}`);
    try {
      s.me.write("f.txt", "base\nstashed\n");
      s.me.git("stash", "-q");
      s.me.write("f.txt", "base\ncommitted\n");
      s.me.commitAll("committed");
      const ctx = s.ctx();
      // The "pull" is a stash pop that conflicts: files left unmerged, and
      // neither MERGE_HEAD nor a rebase directory — a shape git's pull does
      // not normally leave, which the fallback exists for.
      const proc = routedProc(ctx.process, (args) => {
        if (args[0] !== "pull") return undefined;
        assert.notEqual(s.me.tryGit("stash", "pop"), 0, "fixture: the pop conflicts");
        return { code: 1, stderr: "CONFLICT (content): Merge conflict in f.txt" };
      });
      const r = await new SyncOps(proc).pull({ mode });
      assert.equal(r.ok, false);
      assert.deepEqual(r.stopped, { operation: mode, conflicted: ["f.txt"] });
    } finally {
      s.cleanup();
    }
  }
});

test("a status that cannot be read after a failed pull claims no stop and no dirty tree", async () => {
  const s = conflicting("status-fails");
  try {
    const ctx = s.ctx();
    const proc = routedProc(ctx.process, (args) => {
      if (args[0] === "pull") return { code: 1, stderr: "fatal: the remote hung up" };
      if (args[0] === "status") return { code: 128, stderr: "fatal: index file corrupt" };
      return undefined;
    });
    s.me.write("scratch.txt", "untracked\n");
    const r = await new SyncOps(proc).pull({ mode: "merge" });
    assert.equal(r.ok, false);
    assert.equal(r.stderr, "fatal: the remote hung up", "git's own words, passed on");
    assert.equal(r.stopped, undefined, "unknown is not 'stopped on conflicts'");
    assert.equal(r.dirty, undefined, "and not 'your work is in the way'");
    assert.equal(r.blocked, undefined);
  } finally {
    s.cleanup();
  }
});

test("a rebasing pull refused for something other than uncommitted work is not reported as dirty", async () => {
  const s = conflicting("rebase-128");
  try {
    const ctx = s.ctx();
    const refuse = routedProc(ctx.process, (args) =>
      args[0] === "pull" ? { code: 128, stderr: "fatal: refusing for another reason" } : undefined,
    );
    // Clean tree: nothing tracked is changed, so nothing is in the way.
    const clean = await new SyncOps(refuse).pull({ mode: "rebase" });
    assert.equal(clean.ok, false);
    assert.equal(clean.dirty, undefined);

    // A tracked change, but rebase.autoStash would have stashed it for git.
    s.me.write("f.txt", "base\nmine, edited again\n");
    s.me.git("config", "rebase.autoStash", "true");
    const stashed = await new SyncOps(refuse).pull({ mode: "rebase" });
    assert.equal(stashed.dirty, undefined, "autoStash: the edit was never in the way");

    // The same refusal without autoStash is the edit in the way.
    s.me.git("config", "rebase.autoStash", "false");
    const dirty = await new SyncOps(refuse).pull({ mode: "rebase" });
    assert.deepEqual(dirty.dirty, { paths: ["f.txt"], rebase: true });

    // Exit 1 from a rebasing pull is the incoming commits' files, as for a
    // merge — and rebase.autoStash, not merge.autoStash, decides whether a
    // tracked edit counts.
    const failOne = routedProc(ctx.process, (args) =>
      args[0] === "pull" ? { code: 1, stderr: "error: would be overwritten" } : undefined,
    );
    assert.deepEqual((await new SyncOps(failOne).pull({ mode: "rebase" })).dirty, { paths: ["f.txt"] });
    s.me.git("config", "merge.autoStash", "true");
    assert.deepEqual(
      (await new SyncOps(failOne).pull({ mode: "rebase" })).dirty,
      { paths: ["f.txt"] },
      "merge.autoStash does not stash for a rebase",
    );
    s.me.git("config", "rebase.autoStash", "true");
    assert.equal((await new SyncOps(failOne).pull({ mode: "rebase" })).dirty, undefined, "rebase.autoStash does");
  } finally {
    s.cleanup();
  }
});
