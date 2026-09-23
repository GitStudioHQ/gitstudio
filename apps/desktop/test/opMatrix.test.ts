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

    // A NODE sequence editor: `#!/bin/sh` + `chmod` + `sed -i.bak` is three
    // POSIX-only mechanisms in one line, none of which works on a Windows
    // runner — and `sed -i.bak` left a stray backup file beside the todo.
    const seq = `${r.root}/seq.cjs`;
    writeFileSync(
      seq,
      'const fs=require("fs");const p=process.argv[2];' +
        'fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^pick /gm,"edit "));\n',
    );
    execFileSync("git", ["rebase", "-i", "trunk"], {
      cwd: r.root,
      env: {
        ...process.env,
        GIT_SEQUENCE_EDITOR: `node "${seq.replace(/\\/g, "/")}"`,
        GIT_EDITOR: "true",
      },
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

// ── Merge parity: the same table through the role-based `op:*` channels ─────
//
// The capability table now lives in the shared OperationProvider; `opState`
// adapts it (the cells above stay exactly as they were) and `op:*` drives it.
// These cells cover what the move added: the operations the banner could not
// see (a stash re-apply), the gates it lacked (staged markers, an unstaged
// change a rebase refuses), and each verb's effect on the repository.

test("am: op:abort runs `am --abort` — never `rebase --abort`, which git refuses here", async () => {
  const r = repo("am-abort");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD").trim();
    r.git("checkout", "-qb", "series");
    writeFileSync(`${r.root}/f.txt`, "from patch one\n");
    r.git("commit", "-qam", "patch one");
    writeFileSync(`${r.root}/series.patch`, r.git("format-patch", "-1", "--stdout"));
    r.git("checkout", "-q", main);
    writeFileSync(`${r.root}/f.txt`, "diverged\n");
    r.git("commit", "-qam", "diverged");
    const before = r.git("rev-parse", "HEAD").trim();
    r.tryGit("am", "-3", "series.patch");

    const b = await r.bridge();
    const st = await b.opState();
    assert.equal(st.kind, "am");
    assert.equal(st.conflicts, 1);
    assert.equal(st.canSkip, true);
    const out = await b.opAbort();
    assert.equal(out.ok, true, out.message);
    assert.equal(existsSync(`${r.root}/.git/rebase-apply`), false, "the am session is over");
    assert.equal(r.git("rev-parse", "HEAD").trim(), before);
  } finally {
    removeTempRepo(r.root);
  }
});

test("a rebase stopped inside a merge step: op:abort ends the REBASE", async () => {
  const r = repo("mergestep-abort");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD").trim();
    r.git("branch", "trunk");
    r.git("checkout", "-qb", "topic");
    writeFileSync(`${r.root}/f.txt`, "topic\n");
    r.git("commit", "-qam", "topic change");
    r.git("checkout", "-q", main);
    writeFileSync(`${r.root}/g.txt`, "mainline\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "mainline change");
    r.git("merge", "-q", "--no-ff", "-m", "merge topic", "topic");
    r.git("checkout", "-q", "trunk");
    writeFileSync(`${r.root}/f.txt`, "trunk moved\n");
    r.git("commit", "-qam", "trunk moves");
    r.git("checkout", "-q", main);
    const tip = r.git("rev-parse", "HEAD").trim();
    r.tryGit("rebase", "--rebase-merges", "trunk");

    const b = await r.bridge();
    const snap = await b.conflictState();
    assert.notEqual(snap.op.kind, "none", "the fixture stops");
    assert.equal((await b.opState()).kind, "rebase", "a rebase, whatever else is set");
    const out = await b.opAbort();
    assert.equal(out.ok, true, out.message);
    assert.equal(existsSync(`${r.root}/.git/rebase-merge`), false);
    assert.equal(existsSync(`${r.root}/.git/MERGE_HEAD`), false);
    assert.equal(r.git("rev-parse", "HEAD").trim(), tip, "back where it started");
  } finally {
    removeTempRepo(r.root);
  }
});

test("merge with conflict markers staged: Continue is not offered, and op:continue says which file", async () => {
  const r = repo("markers");
  try {
    diverge(r);
    r.tryGit("merge", "side");
    r.git("add", "f.txt"); // markers and all
    const b = await r.bridge();
    const st = await b.opState();
    assert.equal(st.conflicts, 0, "git thinks it is resolved");
    assert.equal(st.canContinue, false, "the app does not");
    const out = await b.opContinue({});
    assert.equal(out.refused, "blocked");
    assert.equal(out.message, "f.txt still has conflict markers staged");
    assert.equal(existsSync(`${r.root}/.git/MERGE_HEAD`), true, "nothing was committed");
  } finally {
    removeTempRepo(r.root);
  }
});

test("rebase with an unstaged change to a tracked file: Continue is not offered, and the real reason is given", async () => {
  const r = repo("unstaged");
  try {
    const { main } = diverge(r);
    r.git("checkout", "-q", "side");
    r.tryGit("rebase", main);
    const b = await r.bridge();
    await b.conflictTakeRole({ path: "f.txt", role: "yours" });
    // A tracked file that exists at this point of the rebase (base's f.txt is
    // the only one), edited and not staged.
    writeFileSync(`${r.root}/f.txt`, "an edit nobody staged\n");
    const st = await b.opState();
    assert.equal(st.canContinue, false);
    const out = await b.opContinue({});
    assert.equal(out.refused, "blocked");
    assert.match(out.message ?? "", /^f\.txt has changes that aren't staged/);
  } finally {
    removeTempRepo(r.root);
  }
});

test("rebase (merge backend) resolved to its base's side: legacy Continue unchanged, op:continue asks first", async () => {
  const r = repo("willdrop");
  try {
    const { main } = diverge(r);
    r.git("checkout", "-q", "side");
    r.tryGit("rebase", main);
    const b = await r.bridge();
    resolveKeepingOurs(r);
    const st = await b.opState();
    assert.equal(st.canContinue, true, "the capability the banner reads is unchanged");
    const asked = await b.opContinue({});
    assert.equal(asked.refused, "confirm-drop", "but the role-based Continue will not drop a commit unasked");
    assert.equal(asked.view.willDrop?.subject, "their change");
    const out = await b.opContinue({ confirmDrop: true });
    assert.equal(out.ok, true, out.message);
    assert.equal((await b.opState()).kind, null);
  } finally {
    removeTempRepo(r.root);
  }
});

test("stash pop: no banner kind (byte-compatible), but conflict:state names it and op:abort keeps the stash", async () => {
  const r = repo("stash");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(`${r.root}/f.txt`, "stashed\n");
    r.git("stash", "-q");
    writeFileSync(`${r.root}/f.txt`, "committed\n");
    r.git("commit", "-qam", "committed");
    r.tryGit("stash", "pop");
    const b = await r.bridge();
    const st = await b.opState();
    assert.equal(st.kind, null, "GitOpState has no stash kind — unchanged");
    assert.equal(st.conflicts, 1);
    const snap = await b.conflictState();
    assert.equal(snap.op.kind, "stash");
    assert.equal(snap.op.yours.stage, 3, "your stashed changes are Yours");
    const out = await b.opAbort();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("ls-files", "-u").trim(), "");
    assert.equal(r.git("stash", "list").trim().split("\n").length, 1, "the stash entry is kept");
    assert.equal(readFileSync(`${r.root}/f.txt`, "utf8"), "committed\n");
  } finally {
    removeTempRepo(r.root);
  }
});

test("op:* with nothing stopped are refused as conditions, not crashes", async () => {
  const r = repo("idle");
  try {
    writeFileSync(`${r.root}/f.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const b = await r.bridge();
    for (const out of [await b.opContinue({}), await b.opSkip(), await b.opAbort()]) {
      assert.equal(out.ok, false);
      assert.equal(out.refused, "not-allowed");
      assert.equal(out.expected, true);
    }
  } finally {
    removeTempRepo(r.root);
  }
});
