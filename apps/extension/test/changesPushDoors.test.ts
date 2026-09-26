// The Changes view's push review on a detached HEAD, host side, against real
// git with a real remote.
//
// A detached HEAD (every stopped rebase is one) has no branch to push. The
// review used to title itself "Push to origin/<sha>" with Push enabled, and
// pressing it failed with "No remote is configured to publish to." — the wrong
// reason, in a repository that has one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { changesHost, scratchRepo } from "./changesHost";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

const DETACHED = /HEAD is detached, so these commits are on no branch/;

function detachedWithRemote(): ReturnType<typeof scratchRepo> {
  const repo = scratchRepo("push-detached");
  cleanups.push(repo.done);
  const bare = mkdtempSync(join(tmpdir(), "gs-ext-push-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  writeFileSync(join(repo.dir, "a.txt"), "one\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "one");
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  repo.git("checkout", "-q", "--detach");
  writeFileSync(join(repo.dir, "a.txt"), "two\n");
  repo.git("commit", "-qam", "two, on no branch");
  return repo;
}

test("the push review on a detached HEAD cannot push, and says the HEAD is why", async () => {
  const repo = detachedWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "requestPushPreview" });
  const preview = host.posted.find((m) => m.type === "pushPreview");
  assert.ok(preview, "the review opens (it lists the commits and offers New branch…)");
  assert.equal(preview.canPush, false);
  assert.match(String(preview.reason), DETACHED);
  assert.doesNotMatch(String(preview.target), /^origin\//, "no pretend branch on the remote");
});

test("a push confirmed on a detached HEAD fails with the HEAD as the reason, not a missing remote", async () => {
  const repo = detachedWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "confirmPush" });
  const done = host.posted.find((m) => m.type === "pushDone");
  assert.equal(done?.ok, false);
  assert.match(String(done?.error), DETACHED);
});

test("the state tells the page a detached HEAD has nowhere to publish", async () => {
  const repo = detachedWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.idle();
  host.posted.length = 0;
  await host.send({ type: "ready" });
  await host.idle();
  const states = host.posted.filter((m) => m.type === "state");
  assert.ok(states.length > 0);
  assert.equal(states.at(-1)?.detached, true);
  assert.notEqual(states.at(-1)?.canPublish, true);
  assert.match(String(states.at(-1)?.detachedReason), DETACHED, "and why, for the button's tip");
});

// Every stopped rebase is a detached HEAD, and there "create a branch here" is
// harmful advice: a branch made mid-rebase points at a half-rebased commit.
// The commits reach the branch being rebased when the rebase finishes, and
// that is what the reason says — in the review, in a confirmed push's error,
// and in the state the page takes the button's tip from.

const REBASING = /^A rebase of topic is in progress.*Finish it with Continue Rebase and these commits land on topic\.$/;

/** topic's two commits rebased onto main: the first applies, the second stops on a conflict. */
function stoppedRebaseWithRemote(): ReturnType<typeof scratchRepo> {
  const repo = scratchRepo("push-rebasing");
  cleanups.push(repo.done);
  const bare = mkdtempSync(join(tmpdir(), "gs-ext-push-origin-"));
  cleanups.push(() => rmSync(bare, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const w = (n: string, t: string) => writeFileSync(join(repo.dir, n), t);
  w("a.txt", "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  repo.git("checkout", "-q", "-b", "topic");
  w("b.txt", "topic's own file\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "topic: b");
  w("a.txt", "topic\n");
  repo.git("commit", "-qam", "topic: a");
  repo.git("checkout", "-q", "main");
  w("a.txt", "main\n");
  repo.git("commit", "-qam", "main: a");
  repo.git("checkout", "-q", "topic");
  try {
    repo.git("rebase", "refs/heads/main");
  } catch {
    // stops on the conflict in a.txt, as intended
  }
  assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD").trim(), "HEAD", "the stop left HEAD detached");
  return repo;
}

test("the push review during a stopped rebase says to finish it, not to create a branch", async () => {
  const repo = stoppedRebaseWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "requestPushPreview" });
  const preview = host.posted.find((m) => m.type === "pushPreview");
  assert.ok(preview);
  assert.equal(preview.canPush, false);
  assert.match(String(preview.reason), REBASING);
  assert.doesNotMatch(String(preview.reason), /create a branch/i);
});

test("a push confirmed during a stopped rebase fails with the same reason", async () => {
  const repo = stoppedRebaseWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "confirmPush" });
  const done = host.posted.find((m) => m.type === "pushDone");
  assert.equal(done?.ok, false);
  assert.match(String(done?.error), REBASING);
});

test("the state gives the page the rebase's reason for its disabled push", async () => {
  const repo = stoppedRebaseWithRemote();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.idle();
  host.posted.length = 0;
  await host.send({ type: "ready" });
  await host.idle();
  const last = host.posted.filter((m) => m.type === "state").at(-1);
  assert.equal(last?.detached, true);
  assert.match(String(last?.detachedReason), REBASING);
});

test("a rebase that started on a detached HEAD: finish it, THEN create a branch", async () => {
  const repo = stoppedRebaseWithRemote();
  // The same stop, but begun from the commit rather than the branch.
  repo.git("rebase", "--abort");
  repo.git("checkout", "-q", "--detach", "refs/heads/topic");
  try {
    repo.git("rebase", "refs/heads/main");
  } catch {
    // stops on the conflict again
  }
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "requestPushPreview" });
  const preview = host.posted.find((m) => m.type === "pushPreview");
  assert.match(
    String(preview?.reason),
    /^A rebase is in progress on a detached HEAD.*Finish it with Continue Rebase, then create a branch to push them\.$/,
  );
});

// Not only a rebase: any operation stopped on a detached HEAD holds it there,
// and GitStudio's own New branch… is refused over a stop (it would end or
// move out from under it). So it is finish, then branch — named.
test("a cherry-pick stopped on a detached HEAD: finish it, then create a branch", async () => {
  const repo = scratchRepo("push-picking");
  cleanups.push(repo.done);
  const w = (n: string, t: string) => writeFileSync(join(repo.dir, n), t);
  w("a.txt", "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-q", "-b", "side");
  w("a.txt", "side\n");
  repo.git("commit", "-qam", "side: a");
  repo.git("checkout", "-q", "main");
  w("a.txt", "main\n");
  repo.git("commit", "-qam", "main: a");
  repo.git("checkout", "-q", "--detach");
  try {
    repo.git("cherry-pick", "refs/heads/side");
  } catch {
    // stops on the conflict in a.txt
  }
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  host.posted.length = 0;
  await host.send({ type: "requestPushPreview" });
  const preview = host.posted.find((m) => m.type === "pushPreview");
  assert.equal(
    preview?.reason,
    "A cherry-pick is in progress on a detached HEAD, so these commits are on no branch. " +
      "Finish it with Continue Cherry-pick, then create a branch to push them.",
  );
});
