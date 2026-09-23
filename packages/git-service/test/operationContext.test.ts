import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeRepo, topoRepo, reporterRepo, seqEditor, type Repo } from "./opRepo";
import * as S from "./opScenarios";
import { kindOf, mergeLabel, shortName } from "../src/OperationProvider";

// W1 (PLAN §3.2): the NAMES a stop is described with, derived the way git
// itself records them — never `name-rev` (it answered "remotes/origin/HEAD"),
// never a ref rebuilt from a short name (memory: git-refname-short-is-
// ambiguous), and every candidate checked to RESOLVE to the commit it names.

const sha7 = (s: string): string => s.slice(0, 7);

async function viewOf(r: Repo) {
  return r.ctx().operation.view();
}

/** A bare remote with the repository's branches, fetched as `origin`. */
function withOrigin(r: Repo): string {
  const remote = join(r.root, "..", `${r.root.split(/[\\/]/).pop()}-remote.git`);
  r.git("clone", "-q", "--bare", r.root, remote);
  r.git("remote", "add", "origin", remote);
  r.git("fetch", "-q", "origin");
  return remote;
}

// ── onto ────────────────────────────────────────────────────────────────────

test("onto: what the user typed, from the reflog's start entry", async () => {
  const r = topoRepo("onto-typed");
  try {
    r.git("tag", "v1", "master");
    r.git("checkout", "-q", "test");
    r.tryGit("rebase", "v1");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "v1", "the tag the rebase was started with, not the branch beside it");
    assert.ok(v.title.startsWith("Rebasing test onto v1 · commit 2 of 3"), v.title);
  } finally {
    r.cleanup();
  }
});

test("onto: a branch and a tag with the same name never reads as heads/<name>", async () => {
  const r = topoRepo("same-name");
  try {
    r.git("branch", "release", "master");
    r.git("tag", "release", "master");
    r.git("checkout", "-q", "test");
    r.tryGit("rebase", "refs/heads/release");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "release");
    assert.equal(v.theirs.paneTitle, "Already rebased commits and commits from release");
    assert.doesNotMatch(JSON.stringify(v), /heads\//, "no ambiguous short form anywhere");
  } finally {
    r.cleanup();
  }
});

test("onto: the branch moved after the rebase started — the sha and subject, and 'Already rebased commits'", async () => {
  const r = topoRepo("onto-moved");
  try {
    const onto = r.sha("master");
    r.git("checkout", "-q", "test");
    r.tryGit("rebase", "master");
    r.git("update-ref", "refs/heads/master", r.sha("master~1"));
    const v = await viewOf(r);
    assert.equal(v.theirs.name, sha7(onto));
    assert.equal(v.theirs.paneTitle, "Already rebased commits", "no name to promise");
    assert.ok(
      v.title.startsWith(`Rebasing test onto ${sha7(onto)} (master: edit lines 3 and 5) · commit 2 of 3`),
      v.title,
    );
  } finally {
    r.cleanup();
  }
});

test("onto: a bare `git rebase` names the configured upstream", async () => {
  const r = topoRepo("bare-rebase");
  try {
    withOrigin(r);
    r.git("checkout", "-q", "test");
    r.git("branch", "-q", "--set-upstream-to=origin/master");
    r.tryGit("rebase");
    const v = await viewOf(r);
    assert.equal(v.kind, "rebase");
    assert.equal(v.theirs.name, "origin/master");
  } finally {
    r.cleanup();
  }
});

test("onto: `pull --rebase` (the reflog holds only a sha) falls through to the ref at onto", async () => {
  const r = topoRepo("pull-rebase");
  try {
    withOrigin(r);
    // Local master one behind, so only origin/master sits at onto.
    r.git("checkout", "-q", "test");
    r.git("branch", "-f", "master", "master~1");
    r.tryGit("pull", "--rebase", "origin", "master");
    const v = await viewOf(r);
    assert.equal(v.kind, "rebase");
    assert.equal(v.theirs.name, "origin/master");
    assert.doesNotMatch(v.theirs.name, /^[0-9a-f]{7,}$/, "never the raw sha when a name exists");
  } finally {
    r.cleanup();
  }
});

test("onto: `--onto master test~2` rebases the last two commits onto master", async () => {
  const r = topoRepo("onto-flag");
  try {
    r.git("checkout", "-q", "test");
    r.tryGit("rebase", "--onto", "master", "test~2");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "master");
    assert.deepEqual(v.step, { n: 1, m: 2, unit: "commit" });
  } finally {
    r.cleanup();
  }
});

test("a detached-HEAD rebase names the branch by its short orig-head", async () => {
  const r = topoRepo("detached");
  try {
    const orig = r.sha("test");
    r.git("checkout", "-q", "--detach", "test");
    r.tryGit("rebase", "master");
    const v = await viewOf(r);
    assert.equal(v.yours.name, sha7(orig));
    assert.equal(v.theirs.name, "master");
  } finally {
    r.cleanup();
  }
});

test("`rebase -i --root` goes onto a new root", async () => {
  const r = topoRepo("root");
  try {
    r.git("checkout", "-q", "test");
    r.gitEnv(
      { GIT_SEQUENCE_EDITOR: seqEditor(r, `t=t.replace(/^pick /m,"edit ")`), GIT_EDITOR: "true" },
      "rebase",
      "-i",
      "--root",
    );
    const v = await viewOf(r);
    assert.equal(v.kind, "rebase");
    assert.equal(v.theirs.name, "new root");
    assert.equal(v.theirs.paneTitle, "Already rebased commits");
    assert.ok(v.title.startsWith("Rebasing test onto a new root · commit 1 of 4"), v.title);
    assert.equal(v.pause?.reason, "edit");
  } finally {
    r.cleanup();
  }
});

// ── merge incoming ──────────────────────────────────────────────────────────

test("merge: a local branch", async () => {
  const s = S.mergeStop();
  try {
    const v = await viewOf(s.r);
    assert.equal(v.theirs.name, "test");
    assert.equal(v.title, "Merging test into master");
  } finally {
    s.r.cleanup();
  }
});

test("merge: a remote-tracking branch", async () => {
  const r = topoRepo("merge-remote");
  try {
    withOrigin(r);
    r.git("branch", "-D", "test");
    r.tryGit("merge", "origin/test");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "origin/test");
  } finally {
    r.cleanup();
  }
});

test("merge: a bare sha nobody names reads as '{sha7} {subject}'", async () => {
  const r = topoRepo("merge-sha");
  try {
    const t2 = r.sha("test~1");
    r.tryGit("merge", sha7(t2));
    const v = await viewOf(r);
    assert.equal(v.theirs.name, `${sha7(t2)} test: edit line 3`);
    assert.equal(v.title, `Merging ${sha7(t2)} test: edit line 3 into master`);
  } finally {
    r.cleanup();
  }
});

test("merge: `git pull` reads as '{branch} (from {remote})'", async () => {
  const r = topoRepo("pull-merge");
  try {
    withOrigin(r);
    r.git("branch", "-D", "test");
    r.tryGit("pull", "--no-rebase", "origin", "test");
    const v = await viewOf(r);
    assert.equal(v.kind, "merge");
    assert.equal(v.theirs.name, "test (from origin)");
    assert.equal(v.title, "Merging test (from origin) into master");
  } finally {
    r.cleanup();
  }
});

test("merge: a MERGE_MSG that lies (`merge -m`) is not believed", async () => {
  const r = topoRepo("merge-lie");
  try {
    r.tryGit("merge", "-m", "Merge branch 'nonsense'", "test");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "test");
  } finally {
    r.cleanup();
  }
});

test("merge: two branches at MERGE_HEAD — MERGE_MSG's name breaks the tie, when it resolves", async () => {
  const r = topoRepo("merge-tie");
  try {
    r.git("branch", "zeta", "test");
    r.tryGit("merge", "zeta");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "zeta", "not the alphabetically-first 'test'");
  } finally {
    r.cleanup();
  }
});

test("merge: a branch and a tag of the same name at MERGE_HEAD read as the branch, never heads/<name>", async () => {
  const r = topoRepo("merge-same-name");
  try {
    r.git("branch", "release", "test");
    r.git("tag", "release", "test");
    r.tryGit("merge", "refs/heads/release");
    const v = await viewOf(r);
    assert.equal(v.theirs.name, "release");
  } finally {
    r.cleanup();
  }
});

test("merge into a detached HEAD: current is the short sha", async () => {
  const r = topoRepo("merge-detached");
  try {
    const m = r.sha("master");
    r.git("checkout", "-q", "--detach", "master");
    r.tryGit("merge", "test");
    const v = await viewOf(r);
    assert.equal(v.yours.name, sha7(m));
    assert.equal(v.title, `Merging test into ${sha7(m)}`);
  } finally {
    r.cleanup();
  }
});

// ── detect(): the cheap answer agrees with the view ─────────────────────────

test("detect() names the same kind and backend as view() for every row", async () => {
  const rows: Array<() => S.Stopped> = [
    S.mergeStop,
    S.rebaseMergeStop,
    S.rebaseApplyStop,
    S.rebaseMergeStepStop,
    S.cherryPickStop,
    S.revertStop,
    S.am3Stop,
    S.amPlainStop,
    S.stashStop,
    S.cleanRepo,
    S.bareUnmergedStop,
  ];
  for (const build of rows) {
    const { r } = build();
    try {
      const ctx = r.ctx();
      const [d, ins] = await Promise.all([ctx.operation.detect(), ctx.operation.inspect()]);
      assert.equal(d.kind, ins.view.kind);
      assert.equal(d.backend, ins.view.backend);
      assert.equal(d.unmerged, ins.unmerged.length);
    } finally {
      r.cleanup();
    }
  }
});

test("the episode is stable while nothing moves, and changes with the stop", async () => {
  const r = reporterRepo();
  try {
    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    const a = await ctx.operation.view();
    const b = await ctx.operation.view();
    assert.equal(a.episode, b.episode);
    assert.notEqual(a.episode, "none");
    await ctx.conflictOps.takeRole("f.txt", "yours");
    assert.equal((await ctx.operation.view()).episode, a.episode, "resolving is not a new stop");
    await ctx.operation.continue();
    assert.equal((await ctx.operation.view()).episode, "none");
  } finally {
    r.cleanup();
  }
});

test("a repository with no commits yet, and a folder that is no repository, both read as nothing stopped", async () => {
  const r = makeRepo("unborn");
  try {
    const v = await viewOf(r);
    assert.equal(v.kind, "none");
    assert.equal(v.yours.name, "master");
  } finally {
    r.cleanup();
  }
});

// ── Pure parts ──────────────────────────────────────────────────────────────

test("kindOf: THE precedence — a merge step is a rebase, am is not a rebase", () => {
  const none = {
    mergeHead: false,
    rebaseMerge: false,
    rebaseApply: false,
    applying: false,
    cherryPickHead: false,
    revertHead: false,
    sequencer: false,
  };
  assert.deepEqual(kindOf({ ...none, rebaseMerge: true, mergeHead: true }, false), {
    kind: "rebase-merge-step",
    backend: "merge",
  });
  assert.deepEqual(kindOf({ ...none, rebaseMerge: true }, false), { kind: "rebase", backend: "merge" });
  assert.deepEqual(kindOf({ ...none, rebaseApply: true }, false), { kind: "rebase", backend: "apply" });
  assert.deepEqual(kindOf({ ...none, rebaseApply: true, applying: true }, false), { kind: "am" });
  assert.deepEqual(kindOf({ ...none, cherryPickHead: true, mergeHead: true }, false), { kind: "cherry-pick" });
  assert.deepEqual(kindOf({ ...none, revertHead: true }, false), { kind: "revert" });
  assert.deepEqual(kindOf({ ...none, mergeHead: true }, true), { kind: "merge" }, "stash markers never outrank a real operation");
  assert.deepEqual(kindOf({ ...none, sequencer: true }, false), { kind: "cherry-pick" });
  assert.deepEqual(kindOf(none, true), { kind: "stash" });
  assert.deepEqual(kindOf(none, false), { kind: "none" });
});

test("mergeLabel reads the label a merge todo line re-creates", () => {
  assert.equal(mergeLabel("merge -C 0123abcd side # Merge branch 'side' into feat"), "side");
  assert.equal(mergeLabel("m -c 0123abcd topic"), "topic");
  assert.equal(mergeLabel("merge a b # octopus"), "a, b");
  assert.equal(mergeLabel("pick 0123abcd x"), undefined);
});

test("shortName strips only the namespace git writes", () => {
  assert.equal(shortName("refs/heads/feature/x"), "feature/x");
  assert.equal(shortName("refs/remotes/origin/main"), "origin/main");
  assert.equal(shortName("refs/tags/v1.2"), "v1.2");
  assert.equal(shortName("master"), "master");
});
