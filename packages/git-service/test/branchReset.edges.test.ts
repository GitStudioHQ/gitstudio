import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import { isResetRefusal, planReset, resetQuestion, resetTargetOf, runReset, type ResetPlan, type ResetTarget } from "../src/branchReset";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// "Reset '<branch>' to '<remote branch>'" at the edges branchReset.test.ts
// leaves: a door naming something that is not a remote branch, a remote
// nobody configured, the branch vanishing between steps, and untracked files
// sitting where the target has a FILE.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

/** master (base) and feature, both pushed to a local bare origin; feature is checked out. */
function scene(name: string): { r: Repo; proc: GitProcess; base: string } {
  const r = makeRepo(`reset-edges-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("f.txt", "base\n");
  const base = r.commitAll("base");
  const srv = mkdtempSync(join(tmpdir(), `gs-reset-edges-${name}-`));
  cleanup.push(() => removeTempRepo(srv));
  r.git("init", "-q", "--bare", srv);
  r.git("remote", "add", "origin", srv);
  r.git("push", "-q", "-u", "origin", "master");
  r.git("checkout", "-q", "-b", "feature");
  r.git("push", "-q", "-u", "origin", "feature");
  const proc = new GitProcess({ cwd: r.root });
  cleanup.push(() => proc.dispose());
  return { r, proc, base };
}

async function target(proc: GitProcess, fullName: string, to?: string): Promise<ResetTarget> {
  const t = await resetTargetOf(proc, fullName, to);
  assert.ok(!isResetRefusal(t), JSON.stringify(t));
  return t;
}

async function plan(proc: GitProcess, t: ResetTarget): Promise<ResetPlan> {
  const p = await planReset(proc, t);
  assert.ok(!isResetRefusal(p), JSON.stringify(p));
  return p;
}

test("a door that names something other than a remote branch is refused in words", async () => {
  const { proc } = scene("notremote");
  assert.deepEqual(await resetTargetOf(proc, "refs/heads/feature", "refs/heads/master"), {
    refused: "refs/heads/master is not a remote branch.",
  });
  assert.deepEqual(await resetTargetOf(proc, "refs/tags/v1"), { refused: "refs/tags/v1 is not a local branch." });
});

test("a remote-tracking ref under no configured remote is refused, and a slashed remote name is found whole", async () => {
  const { r, proc, base } = scene("remotes");
  r.git("update-ref", "refs/remotes/lonely", base);
  assert.deepEqual(await resetTargetOf(proc, "refs/heads/feature", "refs/remotes/lonely"), {
    refused: "lonely does not belong to a remote this repository knows.",
  });
  // "team/eu" is a remote; its branch "x" is refs/remotes/team/eu/x.
  r.git("remote", "add", "team/eu", r.git("config", "remote.origin.url").trim());
  r.git("update-ref", "refs/remotes/team/eu/x", base);
  const t = await target(proc, "refs/heads/feature", "refs/remotes/team/eu/x");
  assert.equal(t.remote, "team/eu");
  assert.equal(t.targetName, "team/eu/x");
});

test("planReset refuses when the branch is gone since the target was read, or the target is gone and the fetch failed", async () => {
  const { r, proc } = scene("gone");
  r.git("branch", "doomed");
  r.git("branch", "--set-upstream-to=origin/master", "doomed");
  const t = await target(proc, "refs/heads/doomed");
  r.git("branch", "-D", "doomed");
  assert.deepEqual(await planReset(proc, t), { refused: "'doomed' is not in this repository any more — refresh and try again." });

  const ft = await target(proc, "refs/heads/feature");
  r.git("update-ref", "-d", "refs/remotes/origin/feature");
  assert.deepEqual(await planReset(proc, ft, { fetchFailed: true }), {
    refused: "There is no 'origin/feature' to reset to, and origin couldn't be reached to fetch it.",
  });
});

test("untracked files under a path the target has as a FILE count as overwritten", async () => {
  const { r, proc } = scene("overwrite");
  // The remote's feature adds a FILE "build"; locally "build" is an untracked folder.
  r.write("build", "the file\n");
  r.commitAll("add build file");
  r.git("push", "-q", "origin", "feature");
  r.git("reset", "-q", "--hard", "HEAD~1");
  r.write("build/out.txt", "local output\n");
  r.write("build/deep/more.txt", "more\n");
  r.write("unrelated.txt", "stays\n");
  const p = await plan(proc, await target(proc, "refs/heads/feature"));
  assert.equal(p.current, true);
  assert.equal(p.behind, 1);
  assert.equal(p.untrackedOverwritten, 2);
  const q = resetQuestion(p);
  assert.equal(q.kind, "confirm");
  assert.match(q.kind === "confirm" ? q.message : "", /2 untracked files will be overwritten by what 'origin\/feature' has at their paths\./);
});

test("runReset refuses when the branch vanished, or when which branch is checked out changed, and runs nothing", async () => {
  const { r, proc } = scene("runrefused");
  r.write("f.txt", "ahead\n");
  r.commitAll("local only");
  const p = await plan(proc, await target(proc, "refs/heads/feature"));
  assert.equal(p.current, true);
  const tip = r.sha("feature");

  // HEAD moved to another branch: the plan said "checked out", now it isn't.
  r.git("checkout", "-q", "master");
  assert.deepEqual(await runReset(proc, p), {
    ok: false,
    stderr: "",
    refused: "Which branch is checked out changed while you were being asked. Nothing was reset — try again.",
  });
  assert.equal(r.sha("feature"), tip, "feature was not reset");

  // The branch is gone altogether.
  r.git("branch", "-D", "feature");
  assert.deepEqual(await runReset(proc, p), {
    ok: false,
    stderr: "",
    refused: "'feature' is not in this repository any more. Nothing was reset.",
  });
});
