// Conflicted files and the Changes view's Stage, host side, against a real
// stopped merge.
//
// `git add` on an unmerged file is how git is told the conflict is resolved,
// and git does not look inside. Every Stage in the Changes view used to run it
// on a conflicted row without a word, and "Commit all" swept conflicted files
// in with everything else — so a stopped merge or rebase could be committed
// with `<<<<<<<` in the tree. Now:
//
//   · an unmerged file that still has markers is held back — by a row's +, a
//     selection, a folder, Stage All — and the user is told which and why;
//     the rest of a bulk stage still happens;
//   · an unmerged file whose markers are gone stages (that IS resolving it);
//   · an ordinary file with marker-shaped lines stays stageable;
//   · "Commit all" never includes a conflicted file: with conflicts left and
//     nothing staged it says so and touches nothing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerWith, asked, changesHost, scratchRepo, vscode } from "./changesHost";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

/** main and topic both edit c.txt and r.txt; merging topic stops on both. r.txt is then resolved by hand. */
function stoppedMerge(): ReturnType<typeof scratchRepo> {
  const repo = scratchRepo("conflict-stage");
  cleanups.push(repo.done);
  const w = (n: string, t: string) => writeFileSync(join(repo.dir, n), t);
  w("c.txt", "base\n");
  w("r.txt", "base\n");
  w("o.txt", "other\n");
  w("doc.md", "docs\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-q", "-b", "topic");
  w("c.txt", "theirs\n");
  w("r.txt", "theirs\n");
  repo.git("commit", "-qam", "topic");
  repo.git("checkout", "-q", "main");
  w("c.txt", "ours\n");
  w("r.txt", "ours\n");
  repo.git("commit", "-qam", "main");
  try {
    repo.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    // stops on the conflicts, as intended
  }
  w("r.txt", "ours and theirs\n"); // resolved by hand: no markers, still unmerged
  w("o.txt", "other, edited\n"); // an ordinary edit
  // An ordinary file ABOUT conflicts: marker-shaped lines, never unmerged.
  w("doc.md", "<<<<<<< ours\nexample\n=======\nexample\n>>>>>>> theirs\n");
  return repo;
}

const unmerged = (repo: ReturnType<typeof scratchRepo>): string[] =>
  [...new Set(repo.git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean))].sort();
const stagedNames = (repo: ReturnType<typeof scratchRepo>): string[] =>
  repo.git("diff", "--cached", "--name-only", "--diff-filter=AMDR").split("\n").filter(Boolean).sort();
const warnings = (): string[] => vscode.__said.filter((s) => s.kind === "warning").map((s) => s.message);

test("a row's + on a conflicted file with markers stages nothing, puts the row back, and says why", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  vscode.__said.length = 0;
  await host.send({ type: "stage", path: "c.txt" });
  assert.deepEqual(unmerged(repo), ["c.txt", "r.txt"], "c.txt is still unmerged");
  assert.deepEqual(host.posted.filter((m) => m.type === "opFailed").map((m) => m.paths), [["c.txt"]]);
  assert.deepEqual(warnings(), [
    "GitStudio: c.txt still contains conflict markers. Staging it would mark the conflict resolved and commit the markers — resolve them first.",
  ]);
});

test("a conflicted file whose markers are gone stages — that is resolving it", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  vscode.__said.length = 0;
  await host.send({ type: "stage", path: "r.txt" });
  assert.deepEqual(unmerged(repo), ["c.txt"]);
  assert.deepEqual(warnings(), []);
});

test("a selection stages everything but the file with markers, and names it", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  vscode.__said.length = 0;
  await host.send({ type: "stagePaths", paths: ["c.txt", "r.txt", "o.txt", "doc.md"] });
  assert.deepEqual(unmerged(repo), ["c.txt"]);
  assert.ok(stagedNames(repo).includes("o.txt"));
  assert.ok(stagedNames(repo).includes("doc.md"), "a file that merely looks like a conflict still stages");
  assert.deepEqual(warnings(), [
    "GitStudio: Staged everything else. 1 file still contains conflict markers (c.txt) — staging a file with markers in it tells git the conflict is settled. Resolve them first.",
  ]);
});

// "Staged everything else." was said BEFORE the stage ran: when git then
// refused it (another git holding the index past the retries), a second toast
// said "couldn't stage", contradicting the first. The held-back files are
// named after the stage, and "everything else" is claimed only once it is.
test("a bulk stage git refuses never claims it staged everything else", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  const lock = join(repo.dir, ".git", "index.lock");
  writeFileSync(lock, "");
  vscode.__said.length = 0;
  try {
    await host.send({ type: "stagePaths", paths: ["c.txt", "o.txt"] });
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  assert.ok(!stagedNames(repo).includes("o.txt"), "git refused the stage");
  const said = vscode.__said.map((s) => `${s.kind}: ${s.message}`);
  assert.deepEqual(said.filter((m) => /Staged everything else/.test(m)), [], said.join(" | "));
  assert.ok(said.some((m) => /^error: GitStudio: couldn't stage o\.txt — /.test(m)), said.join(" | "));
  assert.ok(
    said.includes(
      "warning: GitStudio: c.txt still contains conflict markers. Staging it would mark the conflict resolved and commit the markers — resolve them first.",
    ),
    said.join(" | "),
  );
});

test("Stage All on the Merge Conflicts group holds back the file with markers", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  vscode.__said.length = 0;
  await host.send({ type: "stageAll", group: "merge" });
  assert.deepEqual(unmerged(repo), ["c.txt"]);
  assert.equal(warnings().length, 1);
});

// The toolbar's Stage All posts no group: it is the Changes group's Stage All
// (VS Code's "Stage All Changes"), and never marks a conflict resolved — not
// even one resolved by hand. That is why the page disables it when only
// conflicted files are left (changesToolbar.test.ts): there, a click staged
// nothing and said nothing.
test("the toolbar's Stage All stages the Changes group and leaves every conflicted file alone", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  vscode.__said.length = 0;
  await host.send({ type: "stageAll" });
  assert.deepEqual(unmerged(repo), ["c.txt", "r.txt"], "neither conflict was marked resolved");
  assert.ok(stagedNames(repo).includes("o.txt"));
  assert.ok(stagedNames(repo).includes("doc.md"));
  assert.deepEqual(warnings(), [], "nothing was held back, so there is nothing to explain");
});

test("the checklist's check-all holds back the file with markers", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.send({ type: "stageAllForCommit" });
  assert.deepEqual(unmerged(repo), ["c.txt"]);
  assert.ok(stagedNames(repo).includes("o.txt"));
});

test("'Commit all' with conflicts left and nothing staged stages nothing and says why", async () => {
  const repo = stoppedMerge();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  const head = repo.git("rev-parse", "HEAD");
  vscode.__said.length = 0;
  asked.length = 0;
  answerWith(() => "ok");
  await host.send({ type: "commit", message: "wip" });
  assert.deepEqual(asked, [], "no 'commit everything?' question");
  assert.deepEqual(unmerged(repo), ["c.txt", "r.txt"], "nothing was marked resolved");
  assert.equal(repo.git("rev-parse", "HEAD"), head, "no commit was made");
  assert.deepEqual(warnings(), [
    "GitStudio: 2 files still have conflicts. Resolve and stage them first — git can't commit while files are unmerged.",
  ]);
});
