// The Changes view's staging doors, host side, against real git: what one
// request from the page makes the host ask, do, post back and say.
//
//   · a multi-selection Discard asks ONE question that names the count, and
//     discards every file (it used to be one confirm per file, each dismissing
//     the last, so only the final file went);
//   · a refused stage is reported: the page is told which rows to put back
//     ("opFailed") and the user is told git's reason (it used to be ignored,
//     and the row snapped back four seconds later without a word);
//   · the discard question says what happens to a file that is partly staged
//     — `git checkout --` keeps the staged part — instead of promising a
//     return to the committed version.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerWith, asked, changesHost, scratchRepo, vscode } from "./changesHost";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

function repoWithEdits(names: string[]): ReturnType<typeof scratchRepo> {
  const repo = scratchRepo("changes-doors");
  cleanups.push(repo.done);
  for (const n of names) writeFileSync(join(repo.dir, n), "committed\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  for (const n of names) writeFileSync(join(repo.dir, n), "edited\n");
  return repo;
}

test("Discard on a multi-selection asks once, names the count, and discards every file", async () => {
  const repo = repoWithEdits(["a.txt", "b.txt", "c.txt", "d.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  asked.length = 0;
  answerWith(() => "ok");
  await host.send({ type: "discardPaths", paths: ["a.txt", "b.txt", "c.txt"] });
  assert.deepEqual(
    asked.map((q) => q.title),
    ["Discard changes in 3 files?"],
    "one question for the whole selection",
  );
  for (const n of ["a.txt", "b.txt", "c.txt"]) {
    assert.equal(readFileSync(join(repo.dir, n), "utf8"), "committed\n", `${n} is discarded`);
  }
  assert.equal(readFileSync(join(repo.dir, "d.txt"), "utf8"), "edited\n", "an unselected file is untouched");
});

test("Discard on a multi-selection that is dismissed discards nothing", async () => {
  const repo = repoWithEdits(["a.txt", "b.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  asked.length = 0;
  answerWith(() => undefined);
  await host.send({ type: "discardPaths", paths: ["a.txt", "b.txt"] });
  assert.equal(asked.length, 1);
  for (const n of ["a.txt", "b.txt"]) {
    assert.equal(readFileSync(join(repo.dir, n), "utf8"), "edited\n");
  }
});

test("Stage on a multi-selection stages every file in one request", async () => {
  const repo = repoWithEdits(["a.txt", "b.txt", "c.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.send({ type: "stagePaths", paths: ["a.txt", "b.txt", "c.txt"] });
  assert.deepEqual(repo.git("diff", "--cached", "--name-only").split("\n").filter(Boolean), ["a.txt", "b.txt", "c.txt"]);
});

test("a stage git refuses is reported: the page puts the rows back, and the user hears why", async () => {
  const repo = repoWithEdits(["a.txt", "b.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  // Another git that never lets go of the index.
  const lock = join(repo.dir, ".git", "index.lock");
  writeFileSync(lock, "");
  vscode.__said.length = 0;
  host.posted.length = 0;
  try {
    await host.send({ type: "stagePaths", paths: ["a.txt", "b.txt"] });
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  const failed = host.posted.find((m) => m.type === "opFailed");
  assert.ok(failed, "the page is told the op failed");
  assert.deepEqual(failed.paths, ["a.txt", "b.txt"]);
  const errors = vscode.__said.filter((s) => s.kind === "error").map((s) => s.message);
  assert.equal(errors.length, 1, errors.join(" | "));
  assert.match(errors[0], /^GitStudio: couldn't stage 2 files — .*index\.lock/);
});

test("a single-file stage git refuses names the file", async () => {
  const repo = repoWithEdits(["a.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  const lock = join(repo.dir, ".git", "index.lock");
  writeFileSync(lock, "");
  vscode.__said.length = 0;
  host.posted.length = 0;
  try {
    await host.send({ type: "stage", path: "a.txt" });
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  assert.deepEqual(host.posted.find((m) => m.type === "opFailed")?.paths, ["a.txt"]);
  assert.match(vscode.__said.find((s) => s.kind === "error")?.message ?? "", /^GitStudio: couldn't stage a\.txt — /);
});

test("the discard question says a partly staged file keeps its staged part — and it does", async () => {
  const repo = repoWithEdits(["a.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  repo.git("add", "a.txt"); // "edited" is staged
  writeFileSync(join(repo.dir, "a.txt"), "edited again\n"); // and more on top
  asked.length = 0;
  answerWith(() => "ok");
  await host.send({ type: "discard", path: "a.txt" });
  assert.equal(asked.length, 1);
  assert.match(String(asked[0].message), /the part you staged stays staged/);
  assert.doesNotMatch(String(asked[0].message), /goes back to its committed/);
  assert.equal(readFileSync(join(repo.dir, "a.txt"), "utf8"), "edited\n", "the staged version is what remains");
});

test("the discard question for a file with nothing staged still says it goes back to its committed version", async () => {
  const repo = repoWithEdits(["a.txt"]);
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  asked.length = 0;
  answerWith(() => "ok");
  await host.send({ type: "discard", path: "a.txt" });
  assert.match(String(asked[0].message), /goes back to its committed version/);
  assert.equal(readFileSync(join(repo.dir, "a.txt"), "utf8"), "committed\n");
});
