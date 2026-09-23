// "Commit & Push" offers a force push after any non-fast-forward rejection,
// saying "The remote still has the version of this commit you rewrote … uses
// --force-with-lease, which still refuses if someone else has pushed."
//
// It does not refuse when somebody else's commits have already been FETCHED:
// the lease is the remote-tracking ref, and it matches the remote. The same
// rejection ("non-fast-forward") comes back for a colleague's push as for an
// amend, so the offer was made for both — and accepting it for the first
// deleted the colleague's work from the remote. The bridge now refuses a force
// push that would replace anything other than our own rewrites.
import "./hermeticGit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";

function setup(): { work: string; other: string; remote: string; cleanup: () => void } {
  const root = mkdtempSync(`${tmpdir()}/gs-force-`);
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  const other = `${root}/other`;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, work]);
  for (const [k, v] of [
    ["user.email", "me@example.com"],
    ["user.name", "me"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
  ]) {
    execFileSync("git", ["config", k, v], { cwd: work });
  }
  writeFileSync(`${work}/a.txt`, "a\n");
  execFileSync("git", ["add", "."], { cwd: work });
  // Dated in the past: a rewrite is recognised by being committed LATER than
  // what it replaces (see SyncOps.rewroteUpstream), and an amend in the same
  // second as the commit would otherwise make this test race the clock.
  execFileSync("git", ["commit", "-qm", "mine, pushed"], {
    cwd: work,
    env: { ...process.env, GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" },
  });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: work });
  execFileSync("git", ["clone", "-q", remote, other]);
  for (const [k, v] of [
    ["user.email", "colleague@example.com"],
    ["user.name", "colleague"],
    ["commit.gpgsign", "false"],
  ]) {
    execFileSync("git", ["config", k, v], { cwd: other });
  }
  return { work, other, remote, cleanup: () => removeTempRepo(root) };
}

const log = (dir: string): string =>
  execFileSync("git", ["log", "--format=%s", "main"], { cwd: dir, encoding: "utf8" }).trim();

async function bridgeOn(work: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(work);
  return new GitBridge(repos);
}

test("a force push over a colleague's FETCHED commits is refused, and nothing is deleted", async () => {
  const { work, other, remote, cleanup } = setup();
  try {
    writeFileSync(`${other}/b.txt`, "b\n");
    execFileSync("git", ["add", "."], { cwd: other });
    execFileSync("git", ["commit", "-qm", "theirs"], { cwd: other });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });
    writeFileSync(`${work}/c.txt`, "c\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "mine, new"], { cwd: work });
    execFileSync("git", ["fetch", "-q"], { cwd: work });

    const bridge = await bridgeOn(work);
    const plain = await bridge.syncPush(undefined);
    assert.equal(plain.ok, false, "precondition: the plain push is refused non-fast-forward");

    const forced = await bridge.syncPush({ force: true });
    assert.equal(forced.ok, false, "the force is refused");
    assert.equal(forced.expected, true, "…as a state of the repository, not a crash");
    assert.equal(reportableResultMessage(forced), undefined);
    assert.match(forced.message ?? "", /not yours to replace/);
    assert.match(log(remote), /^theirs\n/, "the colleague's commit is still on the remote");
  } finally {
    cleanup();
  }
});

test("a force push after amending a pushed commit still goes through", async () => {
  const { work, remote, cleanup } = setup();
  try {
    execFileSync("git", ["commit", "-q", "--amend", "-m", "mine, reworded"], { cwd: work });
    const bridge = await bridgeOn(work);
    const forced = await bridge.syncPush({ force: true });
    assert.equal(forced.ok, true, forced.message);
    assert.equal(log(remote), "mine, reworded");
  } finally {
    cleanup();
  }
});

// The rewrite test is passed by somebody else's version of the SAME commit:
// amended on another machine (same author, same author date, committed
// earlier) and pushed, then fetched here in the background — the editor's
// autofetch, a terminal. Amend here, press Force push, and the lease — the
// remote-tracking ref, which that fetch set — was satisfied: the other
// amendment was deleted. The engine now refuses a force leased on a tip this
// branch never had, and the bridge says it as the same state as a colleague's
// commits: `expected`, with `pullFirst` so the renderer offers Pull.
test("a same-author amend fetched in the background is not overwritten, and Pull is offered", async () => {
  const { work, remote, cleanup } = setup();
  const laptop = `${remote}-laptop`;
  try {
    execFileSync("git", ["clone", "-q", remote, laptop]);
    for (const [k, v] of [
      ["user.email", "me@example.com"],
      ["user.name", "me"],
      ["commit.gpgsign", "false"],
    ]) {
      execFileSync("git", ["config", k, v], { cwd: laptop });
    }
    const at = (committed: number) => ({
      ...process.env,
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: `${committed} +0000`,
    });
    execFileSync("git", ["commit", "-q", "--amend", "-m", "mine, fixed on the laptop"], { cwd: laptop, env: at(1700000050) });
    execFileSync("git", ["push", "-q", "--force", "origin", "main"], { cwd: laptop });
    execFileSync("git", ["fetch", "-q"], { cwd: work }); // in the background
    execFileSync("git", ["commit", "-q", "--amend", "-m", "mine, reworded here"], { cwd: work, env: at(1700000100) });

    const bridge = await bridgeOn(work);
    const forced = await bridge.syncPush({ force: true });
    assert.equal(forced.ok, false, "the force is refused");
    assert.equal(forced.expected, true, "…as a state of the repository, not a crash");
    assert.equal(reportableResultMessage(forced), undefined);
    assert.equal(forced.pullFirst, true, "with the way on: pull it in");
    assert.match(forced.message ?? "", /never had/);
    assert.equal(log(remote), "mine, fixed on the laptop", "the other amendment is still on the remote");
  } finally {
    removeTempRepo(laptop);
    cleanup();
  }
});

test("a colleague's fetched commits are refused with Pull offered too", async () => {
  const { work, other, cleanup } = setup();
  try {
    writeFileSync(`${other}/b.txt`, "b\n");
    execFileSync("git", ["add", "."], { cwd: other });
    execFileSync("git", ["commit", "-qm", "theirs"], { cwd: other });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });
    execFileSync("git", ["commit", "-q", "--amend", "-m", "mine, reworded"], { cwd: work });
    execFileSync("git", ["fetch", "-q"], { cwd: work });
    const forced = await (await bridgeOn(work)).syncPush({ force: true });
    assert.equal(forced.ok, false);
    assert.equal(forced.pullFirst, true);
  } finally {
    cleanup();
  }
});
