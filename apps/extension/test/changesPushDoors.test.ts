// The Changes view's push review on a detached HEAD, host side, against real
// git with a real remote.
//
// A detached HEAD (every stopped rebase is one) has no branch to push. The
// review used to title itself "Push to origin/<sha>" with Push enabled, and
// pressing it failed with "No remote is configured to publish to." — the wrong
// reason, in a repository that has one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
});
