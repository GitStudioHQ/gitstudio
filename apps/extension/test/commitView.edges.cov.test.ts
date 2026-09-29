// The Changes view's host at its edges: no repository open, a folder git
// cannot read, a repository with no commits yet, and a merge stopped on
// conflicts that the branch doors must not end behind the user's back.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerWith,
  asked,
  commandAnswers,
  committedRepo,
  covHost,
  installUris,
  opened,
  resetRecorders,
  said,
  scratchRepo,
  withRemote,
  type Host,
} from "./commitViewCovKit";

installUris();

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  commandAnswers.clear();
  answerWith(() => "ok");
});

function host(root: string, opts?: Parameters<typeof covHost>[1]): Host {
  const h = covHost(root, opts);
  cleanups.push(h.dispose);
  return h;
}
function repo(prefix: string) {
  const r = committedRepo(prefix);
  cleanups.push(r.done);
  return r;
}

test("with no repository open, every door is a quiet no-op: only the ones that must answer the page do", async () => {
  const r = repo("edges-norepo");
  const h = host(r.dir, { noRepo: true });
  await h.idle();
  const before = h.posted.length;
  const messages: Record<string, unknown>[] = [
    { type: "stage", path: "a.txt" },
    { type: "stagePaths", paths: ["a.txt"] },
    { type: "unstage", path: "a.txt" },
    { type: "discard", path: "a.txt" },
    { type: "discardPaths", paths: ["a.txt"] },
    { type: "openDiff", path: "a.txt" },
    { type: "openFile", path: "a.txt" },
    { type: "stageAll" },
    { type: "stageAllForCommit" },
    { type: "unstageAll" },
    { type: "discardAll" },
    { type: "discardFolder", paths: ["a.txt"] },
    { type: "requestHunks", path: "a.txt" },
    { type: "stageHunk", path: "a.txt", hunkIndex: 0 },
    { type: "branchAction", action: "push" },
    { type: "branchRefCommand", command: "gitstudio.branch.checkout", ref: "x" },
    { type: "requestPushPreview" },
    { type: "pushCommitFiles", sha: "0".repeat(40) },
    { type: "openPushCommitFile", sha: "0".repeat(40), path: "a.txt" },
    { type: "openPushFileDiff", path: "a.txt" },
    { type: "confirmPush" },
    { type: "discardLocalCommits" },
    { type: "newBranchFromPush", ref: "x" },
    { type: "stashOpenAll", sha: "0".repeat(40) },
    { type: "resolveConflicts" },
    { type: "generateMessage" },
    { type: "stashReadFiles", sha: "0".repeat(40) },
  ];
  for (const m of messages) await h.send(m);
  const answered = h.posted.slice(before).map((m) => m.type).filter((t) => t !== "state");
  assert.deepEqual(answered, ["generateDone", "stashFilesRead"]);
  assert.deepEqual(h.last("stashFilesRead"), { type: "stashFilesRead", sha: "0".repeat(40), files: null });
  assert.equal(asked.length, 0, "nothing was asked");
  assert.deepEqual(said("error"), []);
  assert.deepEqual(said("warning"), []);
  assert.equal(opened.length, 0);
});

test("Switch Repository from the view's header, with no repository open, says there is none", async () => {
  const r = repo("edges-switch");
  const h = host(r.dir, { noRepo: true });
  await h.send({ type: "switchRepo" });
  assert.deepEqual(said("info"), ["GitStudio: No repository is open."]);
});

// Over a folder whose .git git cannot read (a `.git` file pointing nowhere),
// RefProvider.getHead used to answer a DETACHED head with an empty sha instead
// of failing, so the review opened saying "HEAD is detached … Create a branch
// here to push them", and Push failed with that same reason — advice about a
// state the repository was not in. Now git's own refusal ("not a git
// repository") comes back in "couldn't prepare the push".
test("a folder git cannot read fails the push review with git's reason, not a detached-HEAD story", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-ext-cov-notgit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  writeFileSync(join(dir, ".git"), "gitdir: ./nowhere\n");
  const h = host(dir);
  await h.send({ type: "requestPushPreview" });
  assert.equal(h.all("pushPreview").length, 0);
  assert.match(said("error")[0], /^GitStudio: couldn't prepare the push — ./);
});

test("toggling Amend in a repository with no commits yet prefills nothing", async () => {
  const r = scratchRepo("edges-nocommits");
  cleanups.push(r.done);
  const h = host(r.dir);
  await h.send({ type: "amendToggled", amend: true });
  const state = h.last("state") as Record<string, unknown>;
  assert.equal(state.hasRepo, true);
  assert.equal(state.lastMessage, undefined);
});

test("Commit all that git cannot stage (the index is locked) says so and commits nothing", async () => {
  const r = repo("edges-commitall-locked");
  r.write("a.txt", "changed\n");
  const h = host(r.dir);
  const lock = join(r.dir, ".git", "index.lock");
  writeFileSync(lock, "");
  try {
    await h.send({ type: "commit", message: "all" });
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  assert.equal(r.git("log", "--format=%s").trim(), "base");
  assert.match(said("error")[0], /^GitStudio: couldn't stage the changes — ./);
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: false });
});

/** main and topic both edit a.txt; merging topic stops on it. */
function stoppedMerge(prefix: string) {
  const r = repo(prefix);
  r.git("checkout", "-q", "-b", "topic");
  r.write("a.txt", "theirs\n");
  r.git("commit", "-qam", "topic");
  r.git("checkout", "-q", "main");
  r.write("a.txt", "ours\n");
  r.git("commit", "-qam", "ours");
  try {
    r.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    /* stops on the conflict */
  }
  return r;
}
const merging = (r: { dir: string }) => existsSync(join(r.dir, ".git", "MERGE_HEAD"));

test("New Branch over a stopped merge is refused by the door and said as a pause, not an error — the merge survives", async () => {
  const r = stoppedMerge("edges-new-over-merge");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "new", ref: "escape" });
  assert.equal(r.git("branch", "--list", "escape").trim(), "", "no branch was made");
  assert.ok(merging(r), "the merge is still stopped");
  assert.deepEqual(said("error"), []);
  assert.equal(said("warning").length, 1);
  assert.ok(h.last("branchActionDone"));
});

test("New branch… from the push review over a stopped merge keeps the review open and the merge stopped", async () => {
  const r = stoppedMerge("edges-newpush-over-merge");
  const h = host(r.dir);
  await h.send({ type: "newBranchFromPush", ref: "escape" });
  assert.equal(r.git("branch", "--list", "escape").trim(), "");
  assert.ok(merging(r));
  assert.equal(h.all("pushDone").length, 0, "the review stays open");
  assert.deepEqual(said("error"), []);
});

test("Checkout of a revision over a stopped merge is refused and said, not run", async () => {
  const r = stoppedMerge("edges-checkout-over-merge");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "HEAD~1" });
  assert.equal(r.git("branch", "--show-current").trim(), "main");
  assert.ok(merging(r));
  assert.deepEqual(said("error"), []);
  assert.equal(said("warning").length, 1);
});

test("Open All Changes of a stash where VS Code has no multi-file diff opens the stash as one patch", async () => {
  const r = repo("edges-stash-patch");
  r.write("a.txt", "stashed\n");
  r.git("stash", "push", "-q", "-m", "one");
  const sha = r.git("rev-parse", "stash@{0}").trim();
  const h = host(r.dir);
  await h.send({ type: "stashOpenAll", sha });
  assert.equal(opened.length, 1, "the patch opened in an editor");
  await h.send({ type: "stashOpenAll", sha: "" });
  assert.equal(opened.length, 1, "no stash named, nothing opened");
});

test("a push the remote rejects in a hook is an error carrying git's reason", async () => {
  const r = repo("edges-push-hook");
  const remote = withRemote(r);
  cleanups.push(remote.done);
  const hook = join(remote.bare, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'pushes are frozen' >&2\nexit 1\n", { mode: 0o755 });
  r.write("a.txt", "new\n");
  r.git("commit", "-qam", "try");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "push" });
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: Push failed — .*pushes are frozen/s);
});
