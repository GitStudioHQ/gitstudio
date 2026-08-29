import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * Reword messages across a rebase that STOPS.
 *
 * The messages were handed to the run through a queue file in the run's TEMP
 * DIR, popped by COUNTING editor invocations. A conflict ends that process, and
 * `rebase --continue` then ran with `GIT_EDITOR=true` — a no-op — so every
 * reword after the stop point committed with its ORIGINAL message while the app
 * reported success: a green "Rebase continued." and a reloaded plan, with the
 * text the user typed gone and nothing said.
 *
 * Counting was the second half of the problem. `--continue` opens the editor for
 * the commit that stopped WHATEVER its verb, so a conflicted `pick` consumed the
 * next reword's message — putting it on a commit nobody reworded and shifting
 * every later one. The queue is keyed by SHA now, which also makes a queue left
 * behind by some other path inert: a foreign rebase's shas are not in it.
 */
function conflictingStack(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-rewordstop-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");

  writeFileSync(`${root}/shared.txt`, "base\n");
  writeFileSync(`${root}/other.txt`, "o\n");
  git("add", "-A");
  git("commit", "-qm", "m1");
  git("branch", "trunk");

  // trunk moves shared.txt, so replaying t2 onto it conflicts.
  git("checkout", "-qb", "feature");
  writeFileSync(`${root}/f1.txt`, "f1\n");
  git("add", "-A");
  git("commit", "-qm", "t1");
  writeFileSync(`${root}/shared.txt`, "feature side\n");
  git("commit", "-qam", "t2");
  writeFileSync(`${root}/f3.txt`, "f3\n");
  git("add", "-A");
  git("commit", "-qm", "t3");
  writeFileSync(`${root}/f4.txt`, "f4\n");
  git("add", "-A");
  git("commit", "-qm", "t4");

  git("checkout", "-q", "trunk");
  writeFileSync(`${root}/shared.txt`, "trunk side\n");
  git("commit", "-qam", "m2");
  git("checkout", "-q", "feature");
  return { root, git };
}

/**
 * Is a reword queue present anywhere for this repo?
 *
 * There are two homes on purpose: a STAGING copy in `.git` while the run is
 * starting (git has not created its state directory yet), and the real one
 * inside `.git/rebase-merge/` once the rebase has paused — where git owns its
 * lifetime and deletes it with the rebase, however the rebase ends.
 */
function queuePresent(root: string): { staging: boolean; inRebase: boolean } {
  return {
    staging: existsSync(`${root}/.git/gitstudio-reword-queue.json`),
    inRebase: existsSync(`${root}/.git/rebase-merge/gitstudio-reword-queue.json`),
  };
}

test("rewords queued after the stop point still land, on their own commits", async () => {
  const { root, git } = conflictingStack();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    const bridge = new GitBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    assert.equal(plan.ok, true, plan.message ?? "");

    // Reword t1, t3 and t4 — t2 is the one that will conflict.
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "t2" ? "pick" : "reword") as "pick" | "reword",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "t2" ? undefined : `R-${c.subject.toUpperCase()}`,
      branches: c.branches,
    }));

    const out = await rebase.apply({ base: "trunk", rows });
    assert.equal(out.status, "stopped", `it stops on t2's conflict (${out.status})`);

    // Resolve exactly as the user would, then continue.
    writeFileSync(`${root}/shared.txt`, "resolved\n");
    git("add", "shared.txt");
    const cont = await bridge.rebaseContinue();
    assert.equal(cont.ok, true, `continue succeeds (${cont.message ?? ""})`);

    const subjects = git("log", "--format=%s", "HEAD").trim().split("\n");
    assert.deepEqual(
      subjects,
      ["R-T4", "R-T3", "t2", "R-T1", "m2", "m1"],
      "every reword landed on ITS OWN commit, and the conflicted pick kept its message",
    );
  } finally {
    removeTempRepo(root);
  }
});

/** A queue left behind must be inert — it can only ever match its own shas. */
test("a leftover queue cannot rename someone else's commit", async () => {
  const { root, git } = conflictingStack();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "t2" ? "pick" : "reword") as "pick" | "reword",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "t2" ? undefined : `QUEUED-${c.subject}`,
    }));
    const out = await rebase.apply({ base: "trunk", rows });
    assert.equal(out.status, "stopped");

    // It survives the stop — inside git's own state directory, which is what
    // gives it exactly the rebase's lifetime.
    const q = queuePresent(root);
    assert.ok(q.inRebase, "the queue survives the stop, in git's rebase state dir");
    assert.ok(!q.staging, "and the staging copy is not left lying in .git");

    // Walk away from the rebase entirely, the way a terminal `git rebase --abort`
    // outside the app would, leaving the queue behind.
    git("rebase", "--abort");

    // Now run an UNRELATED rebase with a reword of our own, by hand.
    git("checkout", "-q", "-b", "elsewhere", "trunk");
    writeFileSync(`${root}/e.txt`, "e\n");
    git("add", "-A");
    git("commit", "-qm", "mine");
    const before = git("log", "-1", "--format=%s", "HEAD").trim();
    execFileSync("git", ["rebase", "trunk"], { cwd: root });
    assert.equal(
      git("log", "-1", "--format=%s", "HEAD").trim(),
      before,
      "a stale queue never touches a commit it does not name",
    );
  } finally {
    removeTempRepo(root);
  }
});

/** A clean run still installs every message, and leaves nothing behind. */
test("a rebase with no stop still rewords, and cleans up after itself", async () => {
  const { root, git } = conflictingStack();
  try {
    git("checkout", "-q", "feature");
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    // Rebase onto the branch's own base so nothing conflicts.
    const plan = await rebase.load({ base: "HEAD~2" });
    const rows = plan.commits.map((c) => ({
      action: "reword" as const,
      sha: c.sha,
      subject: c.subject,
      message: `W-${c.subject}`,
    }));
    const out = await rebase.apply({ base: "HEAD~2", rows });
    assert.equal(out.status, "done", out.message ?? "");
    const top = git("log", "-2", "--format=%s", "HEAD").trim().split("\n");
    assert.deepEqual(top, ["W-t4", "W-t3"], "both messages installed");
    const q2 = queuePresent(root);
    assert.ok(!q2.staging && !q2.inRebase, "and the queue is gone once the rebase ended");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The abort path must forget the queue.
 *
 * Keying by sha makes a stale queue inert against a FOREIGN rebase — but
 * `git rebase --abort` restores the ORIGINAL shas, so a queue abandoned by an
 * abort matches perfectly the next time that branch is rebased. An abandoned
 * draft then renamed a commit in a rebase nobody asked to reword, and the app
 * said "Rebase continued."
 *
 * Measured before the fix: FINAL log "ABANDONED-DRAFT | m2 | m1".
 */
test("aborting forgets the messages that were abandoned with it", async () => {
  const { root, git } = conflictingStack();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    const bridge = new GitBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "t2" ? "reword" : "pick") as "reword" | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "t2" ? "ABANDONED-DRAFT" : undefined,
    }));
    assert.equal((await rebase.apply({ base: "trunk", rows })).status, "stopped");

    // The user changes their mind and aborts — discarding that draft.
    const ab = await bridge.rebaseAbort();
    assert.equal(ab.ok, true, `abort succeeds (${ab.message ?? ""})`);
    const after = queuePresent(root);
    assert.ok(
      !after.staging && !after.inRebase,
      "the abandoned message is gone with the plan that carried it",
    );

    // Now an ORDINARY rebase of the same branch, with no reword asked for.
    const again = await bridge.branchRebase({ onto: "trunk" });
    assert.equal(again.ok, false, "it conflicts, as before");
    writeFileSync(`${root}/shared.txt`, "resolved\n");
    git("add", "shared.txt");
    const cont = await bridge.rebaseContinue();
    assert.equal(cont.ok, true, `continue succeeds (${cont.message ?? ""})`);

    assert.ok(
      !git("log", "--format=%s", "HEAD").includes("ABANDONED-DRAFT"),
      "and no commit wears a message the user threw away",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * An `edit` stop is a PAUSE, not an ending.
 *
 * `git rebase -i` exits 0 when it stops at an `edit` row — the user asked for
 * that pause — and treating exit 0 as finished toasted "Rebase complete." over
 * a detached, mid-rebase repo AND deleted the reword queue, so every reword
 * below the `edit` row then committed with its original message.
 */
test("an edit stop is reported as a pause, and keeps the rewords below it", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-editstop-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    for (const n of ["m1", "c1", "c2", "c3"]) {
      writeFileSync(`${root}/${n}.txt`, `${n}\n`);
      git("add", "-A");
      git("commit", "-qm", n);
      if (n === "m1") git("branch", "trunk");
    }

    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    const bridge = new GitBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    // Pause on c1 (the oldest), reword c3 (the newest) — below the stop in the
    // todo, so it is only reached after the user continues.
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "c1" ? "edit" : c.subject === "c3" ? "reword" : "pick") as
        | "edit"
        | "reword"
        | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "c3" ? "NEW-C3" : undefined,
    }));

    const out = await rebase.apply({ base: "trunk", rows });
    assert.equal(out.status, "stopped", `an edit row PAUSES the rebase (got ${out.status})`);
    assert.ok(
      queuePresent(root).inRebase,
      "and the messages queued below it are still there",
    );

    const cont = await bridge.rebaseContinue();
    assert.equal(cont.ok, true, `continue finishes it (${cont.message ?? ""})`);
    assert.equal(
      git("log", "-1", "--format=%s", "HEAD").trim(),
      "NEW-C3",
      "the reword below the pause still landed",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * An abort made OUTSIDE the app.
 *
 * This is the case the first fence got wrong, and it is worth spelling out
 * because the fence LOOKED right. The queue was stamped with the rebase's
 * identity — `rebase-merge/onto` plus `orig-head` — and a resume compared the
 * stamp before installing anything. But `git rebase --abort` RESTORES those
 * values, so rebasing the same branch onto the same base again produced a
 * byte-identical stamp, the comparison passed, and an abandoned draft renamed a
 * commit in a rebase nobody asked to reword. Measured with the stamp in place:
 *
 *     FINAL log: ABANDONED-DRAFT | m2 | m1
 *
 * The queue now lives inside git's own `rebase-merge/`, so git deletes it with
 * the directory — whoever aborts, from wherever. The location IS the fence, and
 * nothing in this codebase has to describe a lifetime it does not control.
 */
test("a rebase aborted outside the app takes its messages with it", async () => {
  const { root, git } = conflictingStack();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    const bridge = new GitBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "t2" ? "reword" : "pick") as "reword" | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "t2" ? "ABANDONED-DRAFT" : undefined,
    }));
    assert.equal((await rebase.apply({ base: "trunk", rows })).status, "stopped");

    // A terminal, the extension's own abort command, `git rebase --quit` —
    // anything that does not go through this app.
    git("rebase", "--abort");
    const left = queuePresent(root);
    assert.ok(!left.staging && !left.inRebase, "git took the queue with its own state");

    // The same branch, the same base, so the OLD stamp would have matched.
    const again = await bridge.branchRebase({ onto: "trunk" });
    assert.equal(again.ok, false, "it conflicts on the same commit, as before");
    writeFileSync(`${root}/shared.txt`, "resolved\n");
    git("add", "shared.txt");
    assert.equal((await bridge.rebaseContinue()).ok, true);

    assert.match(
      git("log", "--format=%s", "HEAD"),
      /MY-REAL-MESSAGE|t2/,
      "the commit kept its own message",
    );
    assert.ok(
      !git("log", "--format=%s", "HEAD").includes("ABANDONED-DRAFT"),
      "and not one the user had thrown away",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A second plan while one is already paused.
 *
 * git refuses the run — "It seems that there is already a rebase-merge
 * directory" — but only AFTER the new plan's queue has been written, and the
 * pause path then handed that queue to the rebase already in flight. So a plan
 * git never started still rewrote the message, while the outcome shown read as
 * "nothing happened". Measured: FINAL log "SECOND-DRAFT | m2 | m1".
 */
test("a second plan cannot overwrite the messages of the rebase already running", async () => {
  const { root, git } = conflictingStack();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const rebase = new RebaseBridge(repos);
    const bridge = new GitBridge(repos);

    const plan = await rebase.load({ base: "trunk" });
    const rows = (msg: string) =>
      plan.commits.map((c) => ({
        action: (c.subject === "t2" ? "pick" : "reword") as "pick" | "reword",
        sha: c.sha,
        subject: c.subject,
        message: c.subject === "t2" ? undefined : msg,
      }));

    assert.equal((await rebase.apply({ base: "trunk", rows: rows("FIRST-DRAFT") })).status, "stopped");

    const second = await rebase.apply({ base: "trunk", rows: rows("SECOND-DRAFT") });
    assert.equal(second.status, "failed", "the second plan is refused outright, not 'paused'");
    assert.match(
      second.message ?? "",
      /already in progress/i,
      "and says so in words the user can act on",
    );

    writeFileSync(`${root}/shared.txt`, "resolved\n");
    git("add", "shared.txt");
    assert.equal((await bridge.rebaseContinue()).ok, true);
    const log = git("log", "--format=%s", "HEAD");
    assert.ok(log.includes("FIRST-DRAFT"), "the running rebase kept ITS messages");
    assert.ok(!log.includes("SECOND-DRAFT"), "and the refused plan changed nothing");
  } finally {
    removeTempRepo(root);
  }
});
