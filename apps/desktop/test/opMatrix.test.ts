import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * THE TABLE.
 *
 * Every mid-operation state the Changes banner can show, crossed with the shape
 * the working tree is in, asserting three things per cell: what the banner
 * NAMES the operation, which of its buttons can act, and — where it matters —
 * what the repository looks like after the button is pressed.
 *
 * This exists because three consecutive fix waves each shipped a defect with
 * the same signature: a change correct about the state it was aimed at and
 * wrong about a neighbouring one nobody re-tested. Each of those would have
 * been one red cell here.
 *
 *   · A rebase paused at `edit` — which the user ASKED for — was reported as
 *     "nothing left to commit" and its primary button became `rebase --skip`,
 *     which hard-resets the working tree.
 *   · Fixing that by dropping rebase from the predicate entirely left an
 *     apply-backend rebase with NO way to finish: `--continue` is refused on an
 *     emptied patch, and `--skip`, which git itself names, had no button left.
 *   · `rebase --rebase-merges` stopping on a `merge` step leaves MERGE_HEAD and
 *     `rebase-merge/` at once; "merging first" named it a merge, so Abort ran
 *     `git merge --abort` — discarding a hand resolution and leaving the rebase
 *     running underneath it.
 *
 * A cell asserts CAPABILITY (`canContinue` / `canSkip`), not a button label, so
 * it holds whatever the banner chooses to render. The renderer reads the same
 * two fields; it no longer re-derives them, which is the other half of why this
 * class of defect kept recurring.
 */

interface Repo {
  root: string;
  git: (...a: string[]) => string;
  tryGit: (...a: string[]) => void;
  bridge: () => Promise<GitBridge>;
}

function repo(name: string): Repo {
  const root = mkdtempSync(`${tmpdir()}/gs-matrix-${name}-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const tryGit = (...a: string[]): void => {
    try {
      execFileSync("git", a, { cwd: root, stdio: "ignore" });
    } catch {
      /* the stop is the point */
    }
  };
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  return {
    root,
    git,
    tryGit,
    bridge: async () => {
      const repos = new RepoStore([]);
      await repos.open(root);
      return new GitBridge(repos);
    },
  };
}

/** base → (main: "main side") + (side: "their side"), conflicting on f.txt. */
function diverge(r: Repo): { main: string; sideSha: string } {
  writeFileSync(`${r.root}/f.txt`, "base\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
  const main = r.git("rev-parse", "--abbrev-ref", "HEAD").trim();
  r.git("checkout", "-qb", "side");
  writeFileSync(`${r.root}/f.txt`, "their side\n");
  r.git("commit", "-qam", "their change");
  writeFileSync(`${r.root}/g.txt`, "second\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "their second change");
  const sideSha = r.git("rev-parse", "HEAD~1").trim();
  r.git("checkout", "-q", main);
  writeFileSync(`${r.root}/f.txt`, "main side\n");
  r.git("commit", "-qam", "our change");
  return { main, sideSha };
}

/** Resolve every conflict by keeping OUR side, and stage it. */
function resolveKeepingOurs(r: Repo): void {
  writeFileSync(`${r.root}/f.txt`, "main side\n");
  r.git("add", "f.txt");
}

/** Resolve with something genuinely new, so there IS a commit to record. */
function resolveWithNewContent(r: Repo): void {
  writeFileSync(`${r.root}/f.txt`, "a real resolution\n");
  r.git("add", "f.txt");
}

// ── The table ────────────────────────────────────────────────────────────────

test("merge: conflicted, then resolved", async () => {
  const r = repo("merge");
  try {
    diverge(r);
    r.tryGit("merge", "side");
    const b = await r.bridge();

    let st = await b.opState();
    assert.equal(st.kind, "merge", "named a merge");
    assert.equal(st.conflicts, 1);
    assert.equal(st.canContinue, false, "cannot continue while conflicted");
    assert.equal(st.canSkip, false, "there is no `git merge --skip`");

    // Resolved to exactly OUR side: git still allows an empty merge commit, so
    // Continue is right here and Skip must not appear.
    resolveKeepingOurs(r);
    st = await b.opState();
    assert.equal(st.canContinue, true, "an empty merge commit is legal — Continue finishes it");
    assert.equal(st.canSkip, false, "and Skip is still not a thing git offers");
    assert.equal((await b.mergeContinue()).ok, true, "and it works");
    assert.equal((await b.opState()).kind, null, "the merge is over");
  } finally {
    removeTempRepo(r.root);
  }
});

test("rebase, merge backend: conflicted, then resolved to our own side", async () => {
  const r = repo("rebasemerge");
  try {
    const { main } = diverge(r);
    r.git("checkout", "-q", "side");
    r.tryGit("rebase", main);
    const b = await r.bridge();

    let st = await b.opState();
    assert.equal(st.kind, "rebase", "named a rebase");
    assert.equal(st.canContinue, false, "not while conflicted");
    assert.equal(st.canSkip, false, "the merge backend's --continue drops an emptied commit itself");

    // Resolved to the base's side: the commit is now empty.
    resolveKeepingOurs(r);
    st = await b.opState();
    assert.equal(st.nothingToCommit, true, "there is nothing left to record");
    assert.equal(st.canContinue, true, "but --continue handles that on this backend");
    assert.equal(st.canSkip, false, "so no hard-resetting Skip is offered");
    assert.equal((await b.rebaseContinue()).ok, true, "and Continue really does finish it");
    assert.equal((await b.opState()).kind, null, "the rebase is over");
    assert.equal(existsSync(`${r.root}/g.txt`), true, "with the rest of the branch replayed");
  } finally {
    removeTempRepo(r.root);
  }
});

test("rebase, APPLY backend: an emptied patch can still be finished", async () => {
  const r = repo("rebaseapply");
  try {
    const { main } = diverge(r);
    r.git("checkout", "-q", "side");
    // The backend a `rebase.backend = apply` config, `--whitespace=`, `-C<n>`
    // or a plain `git rebase --apply` selects — and `git pull --rebase` honours.
    r.tryGit("rebase", "--apply", main);
    const b = await r.bridge();

    let st = await b.opState();
    assert.equal(st.kind, "rebase", "still a rebase, not an `am`");
    assert.equal(st.canContinue, false, "not while conflicted");

    resolveKeepingOurs(r);
    st = await b.opState();
    assert.equal(st.nothingToCommit, true, "the patch is now empty");
    assert.equal(
      st.canContinue,
      false,
      "and THIS backend refuses --continue — offering it is a button that can never work",
    );
    assert.equal(
      st.canSkip,
      true,
      "so Skip is offered, which is what git's own advice names: without it the rebase has no way to finish",
    );

    assert.equal((await b.rebaseSkip()).ok, true, "and Skip finishes it");
    assert.equal((await b.opState()).kind, null, "the rebase is over");
    assert.equal(existsSync(`${r.root}/g.txt`), true, "with the rest of the branch replayed");
  } finally {
    removeTempRepo(r.root);
  }
});

test("rebase paused at an `edit` stop: Continue only, never Skip", async () => {
  const r = repo("editstop");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("branch", "trunk");
    writeFileSync(`${r.root}/a.txt`, "a\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "the commit to edit");

    const seq = `${r.root}/seq.sh`;
    writeFileSync(seq, '#!/bin/sh\nsed -i.bak "s/^pick /edit /" "$1"\n');
    execFileSync("chmod", ["+x", seq]);
    execFileSync("git", ["rebase", "-i", "trunk"], {
      cwd: r.root,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: seq, GIT_EDITOR: "true" },
      stdio: "ignore",
    });

    const b = await r.bridge();
    const st = await b.opState();
    assert.equal(st.kind, "rebase");
    assert.equal(st.conflicts, 0, "nothing is conflicted — the pause was deliberate");
    assert.equal(st.nothingToCommit, true, "and the index matches HEAD, exactly like an empty patch");
    assert.equal(st.canContinue, true, "Continue is the way on");
    assert.equal(
      st.canSkip,
      false,
      "and Skip must NOT be offered: `rebase --skip` hard-resets the amend this pause exists to make",
    );
  } finally {
    removeTempRepo(r.root);
  }
});

test("a rebase stopped inside a merge step is a rebase, not a merge", async () => {
  const r = repo("rebasemerges");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD").trim();
    r.git("branch", "trunk");

    // A topic merged into the branch, so --rebase-merges has a merge to replay.
    r.git("checkout", "-qb", "topic");
    writeFileSync(`${r.root}/f.txt`, "topic\n");
    r.git("commit", "-qam", "topic change");
    r.git("checkout", "-q", main);
    writeFileSync(`${r.root}/f.txt`, "mainline\n");
    r.git("commit", "-qam", "mainline change");
    r.tryGit("merge", "topic");
    if (existsSync(`${r.root}/.git/MERGE_HEAD`)) {
      writeFileSync(`${r.root}/f.txt`, "merged by hand\n");
      r.git("add", "f.txt");
      r.git("commit", "-qm", "merge topic");
    }
    // Move trunk forward so replaying conflicts.
    r.git("checkout", "-q", "trunk");
    writeFileSync(`${r.root}/f.txt`, "trunk moved\n");
    r.git("commit", "-qam", "trunk moves");
    r.git("checkout", "-q", main);
    r.tryGit("rebase", "--rebase-merges", "trunk");

    const b = await r.bridge();
    const st = await b.opState();
    if (st.kind === null) return; // git resolved it without stopping — nothing to assert
    assert.equal(
      st.kind,
      "rebase",
      `a stop inside a rebase is a rebase even when MERGE_HEAD is set (merging=${st.merging}, rebasing=${st.rebasing}). ` +
        "Naming it a merge points Abort at `git merge --abort`, which discards the resolution and leaves the rebase running.",
    );
  } finally {
    removeTempRepo(r.root);
  }
});

test("cherry-pick: conflicted, empty, and resolved", async () => {
  const r = repo("pick");
  try {
    const { sideSha } = diverge(r);
    r.tryGit("cherry-pick", sideSha);
    const b = await r.bridge();

    let st = await b.opState();
    assert.equal(st.kind, "cherry-pick");
    assert.equal(st.canContinue, false, "not while conflicted");
    assert.equal(st.canSkip, true, "but Skip is always available to the sequencer");

    // Resolved to our own side — the pick is now empty and git refuses it.
    resolveKeepingOurs(r);
    st = await b.opState();
    assert.equal(st.nothingToCommit, true);
    assert.equal(st.canContinue, false, "an empty pick cannot be continued");
    assert.equal(st.canSkip, true, "Skip is the way out, and git names it");
    assert.equal((await b.cherryPickContinue()).expected, true, "and the refusal is a condition, not a crash");
    assert.equal((await b.cherryPickSkip()).ok, true, "Skip works");
    assert.equal((await b.opState()).kind, null, "the pick is over");
  } finally {
    removeTempRepo(r.root);
  }
});

test("cherry-pick resolved with real content can be continued", async () => {
  const r = repo("pickreal");
  try {
    const { sideSha } = diverge(r);
    r.tryGit("cherry-pick", sideSha);
    const b = await r.bridge();
    resolveWithNewContent(r);

    const st = await b.opState();
    assert.equal(st.nothingToCommit, false, "there IS something to record");
    assert.equal(st.canContinue, true, "so Continue is offered");
    assert.equal((await b.cherryPickContinue()).ok, true, "and it works");
    assert.equal((await b.opState()).kind, null);
  } finally {
    removeTempRepo(r.root);
  }
});

test("revert: conflicted, then resolved", async () => {
  const r = repo("revert");
  try {
    writeFileSync(`${r.root}/f.txt`, "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "one");
    writeFileSync(`${r.root}/f.txt`, "two\n");
    r.git("commit", "-qam", "two");
    const two = r.git("rev-parse", "HEAD").trim();
    writeFileSync(`${r.root}/f.txt`, "three\n");
    r.git("commit", "-qam", "three");
    r.tryGit("revert", "--no-edit", two);
    const b = await r.bridge();

    let st = await b.opState();
    assert.equal(st.kind, "revert");
    assert.equal(st.canContinue, false, "not while conflicted");
    assert.equal(st.canSkip, true);

    writeFileSync(`${r.root}/f.txt`, "reverted properly\n");
    r.git("add", "f.txt");
    st = await b.opState();
    assert.equal(st.canContinue, true);
    assert.equal((await b.revertContinue()).ok, true);
    assert.equal((await b.opState()).kind, null);
  } finally {
    removeTempRepo(r.root);
  }
});

test("am: a patch that will not apply is named, and can be skipped", async () => {
  const r = repo("am");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD").trim();
    r.git("checkout", "-qb", "series");
    writeFileSync(`${r.root}/f.txt`, "from patch one\n");
    r.git("commit", "-qam", "patch one");
    writeFileSync(`${r.root}/g.txt`, "second\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "patch two");
    writeFileSync(`${r.root}/series.patch`, r.git("format-patch", "-2", "--stdout"));
    r.git("checkout", "-q", main);
    writeFileSync(`${r.root}/f.txt`, "diverged\n");
    r.git("commit", "-qam", "diverged");
    r.tryGit("am", "series.patch");

    const b = await r.bridge();
    const st = await b.opState();
    assert.equal(st.kind, "am", "an am is named as itself, never as a rebase");
    assert.equal(st.rebasing, false, "and the rebase verbs, which git refuses here, are not offered");
    assert.equal(st.canSkip, true, "git's own advice on this screen is `am --skip`");

    assert.equal((await b.amSkip()).ok, true, "and it works");
    assert.equal(existsSync(`${r.root}/g.txt`), true, "the rest of the series still applied");
    assert.equal((await b.opState()).kind, null, "the session is over");
  } finally {
    removeTempRepo(r.root);
  }
});

test("a clean repo is in no operation at all", async () => {
  const r = repo("clean");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const st = await (await r.bridge()).opState();
    assert.equal(st.kind, null, "no banner");
    assert.equal(st.canContinue, false);
    assert.equal(st.canSkip, false);
    assert.equal(st.nothingToCommit, false, "and nothing claims otherwise");
  } finally {
    removeTempRepo(r.root);
  }
});

/**
 * The one cell that is about a WRITE rather than a state: Skip is offered only
 * where git names it, because `git rebase --skip` hard-resets the working tree
 * — it reverts unrelated unstaged edits, which no other skip does.
 */
test("rebase --skip is destructive, which is why it is never the default way on", async () => {
  const r = repo("skipdestroys");
  try {
    const { main } = diverge(r);
    r.git("checkout", "-q", "side");
    r.tryGit("rebase", "--apply", main);
    resolveKeepingOurs(r);
    // An unrelated edit, sitting in the working tree.
    writeFileSync(`${r.root}/unrelated.txt`, "work in progress\n");
    r.git("add", "unrelated.txt");
    r.git("commit", "-qm", "unrelated");
    writeFileSync(`${r.root}/unrelated.txt`, "EDITED, not staged\n");

    const b = await r.bridge();
    assert.equal((await b.opState()).canSkip, true, "Skip is the only way on here");
    await b.rebaseSkip();

    assert.notEqual(
      readFileSync(`${r.root}/unrelated.txt`, "utf8"),
      "EDITED, not staged\n",
      "rebase --skip really does hard-reset the tree — which is why the banner asks before running it",
    );
  } finally {
    removeTempRepo(r.root);
  }
});

/**
 * "Uncheck all" is not `git merge --quit`.
 *
 * `unstageAll` was one line — `git reset`, no pathspec — and a bare `git reset`
 * clears MERGE_HEAD. So unchecking everything mid-merge silently ENDED the
 * merge: the next Commit recorded a one-parent commit carrying the merged
 * content, with no second parent, and `git merge --abort` afterwards answers
 * "There is no merge to abort". Its neighbour `stageAll` goes to real trouble
 * over conflicts; this one had no conflict check and no in-progress check.
 */
test("unstaging everything mid-merge leaves the merge in progress", async () => {
  const r = repo("unstageall");
  try {
    diverge(r);
    r.tryGit("merge", "side");
    const b = await r.bridge();
    assert.equal((await b.opState()).kind, "merge", "a merge is in progress");

    resolveWithNewContent(r);
    assert.equal((await b.unstageAll()).ok, true, "unchecking everything succeeds");

    const st = await b.opState();
    assert.equal(st.kind, "merge", "and the merge is STILL in progress");
    assert.equal(existsSync(`${r.root}/.git/MERGE_HEAD`), true, "MERGE_HEAD survives");
    assert.equal(
      r.git("diff", "--cached", "--name-only").trim(),
      "",
      "with the index emptied, which is what the control claims to do",
    );
  } finally {
    removeTempRepo(r.root);
  }
});
