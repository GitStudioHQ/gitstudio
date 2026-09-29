import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { defaultBranchOf, parseRefFacts } from "../src/worktreeState";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// The Worktrees surface's reads at their edges: a repository with no remote
// and no main/master names its default branch after the main worktree's, a
// failed read answers "nothing" rather than throwing, and a commit with an
// empty message still has a subject to show.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function repo(name: string, branch = "master"): Repo {
  const r = makeRepo(`wtstate-edges-${name}`);
  cleanup.push(() => r.cleanup());
  if (branch !== "master") r.git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

test("with no remote HEAD and no main/master, the default branch is the main worktree's", async () => {
  const r = repo("trunk", "trunk");
  const { signal } = new AbortController();
  const snap = await r.ctx().worktrees.snapshot({ signal });
  assert.deepEqual(snap.defaultBranch, { ref: "refs/heads/trunk", name: "trunk", local: "trunk" });
  assert.deepEqual(snap.remotes, []);
  // …and with nothing at all to go on, there is none.
  assert.equal(defaultBranchOf(parseRefFacts(""), [{ path: "/r", head: "", bare: true }]), undefined);
});

test("a remote HEAD that points outside the remote's own namespace keeps its full short name", () => {
  const facts = parseRefFacts("");
  facts.remoteHeads.set("origin", "refs/remotes/mirror/main");
  assert.deepEqual(defaultBranchOf(facts, []), { ref: "refs/remotes/mirror/main", name: "mirror/main", local: "mirror/main" });
});

test("outside a repository the snapshot is empty and a worktree's commits read as none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-wtstate-norepo-"));
  const ctx = new GitContext({ root: dir });
  cleanup.push(() => {
    ctx.dispose();
    removeTempRepo(dir);
  });
  const snap = await ctx.worktrees.snapshot();
  assert.deepEqual(snap, { worktrees: [], remotes: [] });
  assert.deepEqual(await ctx.worktrees.commits(dir, ["HEAD"], 5), { commits: [], more: false });
});

test("the main worktree's status is undefined when git can't read it, and a message-less commit reads '(no message)'", async () => {
  const r = repo("status");
  r.git("commit", "-q", "--allow-empty", "--allow-empty-message", "-m", "");
  const ctx = r.ctx();
  const snap = await ctx.worktrees.snapshot();
  const main = snap.worktrees[0];
  const { signal } = new AbortController();
  const { commits, more } = await ctx.worktrees.commits(r.root, ["HEAD"], 1, { signal });
  assert.equal(more, true, "there is an older commit past the limit");
  assert.equal(commits[0].subject, "(no message)");
  assert.equal(commits[0].author, "Dev");

  // Make the index unreadable: status fails, and the row shows no status rather than a wrong one.
  r.write(".git/index", "garbage");
  assert.equal(await ctx.worktrees.status(main, snap), undefined);
});
