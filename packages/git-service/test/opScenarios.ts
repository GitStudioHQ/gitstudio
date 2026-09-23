// Every stopped state the state table covers, built with real git (the rows of
// PLAN §4 P2 "THE STATE TABLE"; scripts ported from scratchpad
// merge/git-semantics/{scenarios,continue,extra}.sh).

import { join } from "node:path";
import { makeRepo, topoRepo, FIVE, edit, seqEditor, type Repo } from "./opRepo";

export interface Stopped {
  r: Repo;
  /** Commits worth naming in assertions. */
  sha: Record<string, string>;
}

/** On master: `git merge test` (topo) — f.txt conflicts. */
export function mergeStop(): Stopped {
  const r = topoRepo("merge");
  const sha = { master: r.sha("master"), test: r.sha("test") };
  r.tryGit("merge", "test");
  return { r, sha };
}

/** On test: `git rebase master` (merge backend) — stops at T2, commit 2 of 3. */
export function rebaseMergeStop(): Stopped {
  const r = topoRepo("rebase-merge");
  r.git("checkout", "-q", "test");
  const sha = { master: r.sha("master"), test: r.sha("test"), t2: r.sha("test~1"), t3: r.sha("test") };
  r.tryGit("rebase", "master");
  return { r, sha };
}

/** On test: `git rebase --apply master` — stops at T2, commit 2 of 3. */
export function rebaseApplyStop(): Stopped {
  const r = topoRepo("rebase-apply");
  r.git("checkout", "-q", "test");
  const sha = { master: r.sha("master"), test: r.sha("test"), t2: r.sha("test~1"), t3: r.sha("test") };
  r.tryGit("rebase", "--apply", "master");
  return { r, sha };
}

/** `rebase --rebase-merges` stopped while re-creating `Merge branch 'side' into feat`. */
export function rebaseMergeStepStop(): Stopped {
  const r = makeRepo("rebase-merges");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "feat");
  r.git("checkout", "-q", "-b", "side");
  r.write("f.txt", edit(FIVE, { two: "two-side" }));
  r.commitAll("side: line 2");
  r.git("checkout", "-q", "feat");
  r.write("f.txt", edit(FIVE, { two: "two-feat" }));
  r.commitAll("feat: line 2");
  r.tryGit("merge", "-q", "side");
  r.write("f.txt", edit(FIVE, { two: "two-merged" }));
  r.git("add", "f.txt");
  r.git("commit", "-q", "--no-edit");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { five: "five-master" }));
  r.commitAll("master: line 5");
  r.git("checkout", "-q", "feat");
  const sha = { feat: r.sha("feat"), master: r.sha("master") };
  r.tryGit("rebase", "--rebase-merges", "master");
  return { r, sha };
}

/** On master: `git cherry-pick test~1` (T2). */
export function cherryPickStop(): Stopped {
  const r = topoRepo("cherry-pick");
  const sha = { master: r.sha("master"), t2: r.sha("test~1") };
  r.tryGit("cherry-pick", sha.t2);
  return { r, sha };
}

/** On master: `git cherry-pick master..test` — T1 applies, stops at T2, T3 queued. */
export function cherryPickRangeStop(): Stopped {
  const r = topoRepo("cherry-range");
  const sha = { master: r.sha("master"), t2: r.sha("test~1"), t3: r.sha("test") };
  r.tryGit("cherry-pick", "master..test");
  return { r, sha };
}

/** On master: revert M1 after M2 changed the same line. */
export function revertStop(): Stopped {
  const r = makeRepo("revert");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.write("f.txt", edit(FIVE, { three: "three-M1" }));
  const m1 = r.commitAll("M1 line 3");
  r.write("f.txt", edit(FIVE, { three: "three-M2" }));
  const m2 = r.commitAll("M2 line 3 again");
  r.tryGit("revert", "--no-edit", m1);
  return { r, sha: { m1, m2 } };
}

/** On master: `git am -3` of T2's patch — f.txt conflicts. */
export function am3Stop(): Stopped {
  const r = topoRepo("am3");
  const patches = join(r.root, ".git", "p-am3");
  r.git("format-patch", "-q", "-1", "test~1", "-o", patches);
  const sha = { master: r.sha("master") };
  r.tryGit("am", "-3", join(patches, "0001-test-edit-line-3.patch"));
  return { r, sha };
}

/** On master: plain `git am` of T2's patch — refuses to apply, nothing unmerged. */
export function amPlainStop(): Stopped {
  const r = topoRepo("am-plain");
  const patches = join(r.root, ".git", "p-am");
  r.git("format-patch", "-q", "-1", "test~1", "-o", patches);
  const sha = { master: r.sha("master") };
  r.tryGit("am", join(patches, "0001-test-edit-line-3.patch"));
  return { r, sha };
}

/** `git stash pop` conflicting with a commit made since. */
export function stashStop(): Stopped {
  const r = makeRepo("stash");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.write("f.txt", edit(FIVE, { three: "three-stashed" }));
  r.git("stash", "-q");
  r.write("f.txt", edit(FIVE, { three: "three-committed" }));
  const master = r.commitAll("committed line 3");
  r.tryGit("stash", "pop");
  return { r, sha: { master } };
}

/** `git rebase --autostash master` whose autostash conflicts on the way back. */
export function autostashStop(): Stopped {
  const r = makeRepo("autostash");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "test");
  r.write("t.txt", "t\n");
  r.commitAll("T");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { three: "three-master" }));
  r.commitAll("M1");
  r.git("checkout", "-q", "test");
  r.write("f.txt", edit(FIVE, { three: "three-dirty" }));
  r.tryGit("rebase", "--autostash", "master");
  return { r, sha: { test: r.sha("test") } };
}

/** A clean repository: nothing stopped. */
export function cleanRepo(): Stopped {
  const r = makeRepo("clean");
  r.write("f.txt", FIVE);
  const master = r.commitAll("base");
  return { r, sha: { master } };
}

/** Unmerged files with no operation and no stash markers (a stash pop whose markers were edited away). */
export function bareUnmergedStop(): Stopped {
  const s = stashStop();
  s.r.write("f.txt", edit(FIVE, { three: "three-by-hand" }));
  return s;
}

/**
 * `git rebase -i master` on a two-commit test branch, with `exec false`
 * after the first pick and `break` at the end, and optionally `edit` on the
 * first pick. Stops at the first pause.
 */
export function pauseStop(kind: "edit" | "break" | "exec"): Stopped {
  const r = makeRepo(`pause-${kind}`);
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "test");
  r.write("a.txt", "a\n");
  const a = r.commitAll("A");
  r.write("b.txt", "b\n");
  const b = r.commitAll("B");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { one: "one-master" }));
  r.commitAll("M");
  r.git("checkout", "-q", "test");
  const body =
    kind === "edit"
      ? `t=t.replace(/^pick /m,"edit ")`
      : kind === "break"
        ? `t=t.replace(/^(pick [^\\n]*\\n)/m,"$1break\\n")`
        : `t=t.replace(/^(pick [^\\n]*\\n)/m,"$1exec false\\n")`;
  r.gitEnv({ GIT_SEQUENCE_EDITOR: seqEditor(r, body), GIT_EDITOR: "true" }, "rebase", "-i", "master");
  return { r, sha: { a, b } };
}
