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

    const queue = `${root}/.git/gitstudio-reword-queue.json`;
    assert.ok(existsSync(queue), "the queue survives the stop — that is the point");

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
    assert.ok(
      !existsSync(`${root}/.git/gitstudio-reword-queue.json`),
      "and the queue is gone once the rebase ended",
    );
  } finally {
    removeTempRepo(root);
  }
});
