// ✨ Explain on a conflict: WHO is at fault when there is nothing to explain.
//
// `explainConflict` answered one expected "Couldn't read the conflict." for
// three different situations, and `expected` is what keeps a result out of the
// crash reporter. Only one of the three is a state the user is simply in — the
// file was resolved (in a terminal, or another window) while the panel was
// open. The other two are ours: a request that named no file at all, and a
// conflicted file whose sides git would not hand over.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { conflictToExplain } from "../src/main/aiBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import { removeTempRepo } from "./tmpRepo";

const repo = mkdtempSync(join(tmpdir(), "gs-explain-"));
const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
for (const [k, v] of [
  ["user.email", "t@t"],
  ["user.name", "t"],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
]) {
  git("config", k, v);
}
writeFileSync(join(repo, "notes.txt"), "one\ntwo\n");
writeFileSync(join(repo, "other.txt"), "one\ntwo\n");
git("add", ".");
git("commit", "-qm", "base");
git("checkout", "-q", "-b", "side");
writeFileSync(join(repo, "notes.txt"), "one\nSIDE\n");
writeFileSync(join(repo, "other.txt"), "one\nSIDE\n");
git("commit", "-qam", "side");
git("checkout", "-q", "main");
writeFileSync(join(repo, "notes.txt"), "one\nMAIN\n");
writeFileSync(join(repo, "other.txt"), "one\nMAIN\n");
git("commit", "-qam", "main");
try {
  git("merge", "side"); // stops on both files
} catch {
  /* exit 1 — the conflict is the point */
}
// Resolve ONE of the two, as someone would from a terminal while the panel is open.
writeFileSync(join(repo, "other.txt"), "one\nboth\n");
git("add", "other.txt");

const ctx = new GitContext({ root: repo });
after(() => {
  ctx.dispose();
  removeTempRepo(repo);
});

test("a conflicted file comes back with its three sides", async () => {
  const got = await conflictToExplain(ctx, "notes.txt");
  assert.ok("conflict" in got, JSON.stringify(got));
  assert.equal(got.conflict.path, "notes.txt");
  assert.match(got.conflict.ours, /MAIN/);
  assert.match(got.conflict.theirs, /SIDE/);
  assert.match(got.conflict.base ?? "", /two/);
});

test("a file resolved since the panel opened is a state, and says so", async () => {
  const got = await conflictToExplain(ctx, "other.txt");
  assert.ok("refusal" in got);
  assert.equal(got.refusal.expected, true, "resolving a file is not a defect");
  assert.match(got.refusal.message, /isn't conflicted any more/);
  assert.equal(reportableResultMessage(got.refusal), undefined, "…and it files no report");
});

test("a request that names no file is ours, and reports", async () => {
  const got = await conflictToExplain(ctx, undefined);
  assert.ok("refusal" in got);
  assert.notEqual(got.refusal.expected, true, "every Explain door names its file — no path is our bug");
  assert.equal(reportableResultMessage(got.refusal), got.refusal.message);
});

test("a STILL-conflicted file whose sides git will not give us reports", async () => {
  // `git show :2:` failing on a file the index says is unmerged is not the user
  // resolving anything — it is a read that failed, and the one we must hear of.
  const failingShow = {
    process: {
      run: (args: string[], opts?: Parameters<GitContext["process"]["run"]>[1]) =>
        args[0] === "show"
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: simulated" })
          : ctx.process.run(args, opts),
    },
  } as unknown as Pick<GitContext, "process">;
  const got = await conflictToExplain(failingShow, "notes.txt");
  assert.ok("refusal" in got);
  assert.notEqual(got.refusal.expected, true);
  assert.equal(reportableResultMessage(got.refusal), "Couldn't read the conflict.");
});

test("when git cannot even say whether the file is conflicted, that reports too", async () => {
  const nothingWorks = {
    process: { run: () => Promise.resolve({ code: 128, stdout: "", stderr: "fatal: simulated" }) },
  } as unknown as Pick<GitContext, "process">;
  const got = await conflictToExplain(nothingWorks, "notes.txt");
  assert.ok("refusal" in got);
  assert.notEqual(got.refusal.expected, true, "an unanswerable status is not 'resolved'");
});
