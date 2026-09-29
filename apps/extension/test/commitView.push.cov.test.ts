// The Changes view's push review, host side, against real repositories and an
// on-disk remote: what the review shows for a tracked, an unpublished and a
// rewritten branch; Push, Undo commits… and New branch… from it; and the diffs
// its rows open.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  answerWith,
  asked,
  commandsRun,
  committedRepo,
  covHost,
  installUris,
  resetRecorders,
  said,
  withRemote,
  type Host,
  type U,
} from "./commitViewCovKit";

installUris();

/* eslint-disable @typescript-eslint/no-require-imports -- the stand-in is in place (commitViewCovKit) */
const rev = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
/* eslint-enable @typescript-eslint/no-require-imports */

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  answerWith(() => "ok");
});

function host(root: string): Host {
  const h = covHost(root);
  cleanups.push(h.dispose);
  return h;
}
function repo(prefix: string) {
  const r = committedRepo(prefix);
  cleanups.push(r.done);
  return r;
}
type R = ReturnType<typeof repo>;
function remoteRepo(prefix: string): { r: R; bare: string } {
  const r = repo(prefix);
  const remote = withRemote(r);
  cleanups.push(remote.done);
  return { r, bare: remote.bare };
}
const onRemote = (bare: string, ref: string): string => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: bare, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
function commit(r: R, file: string, text: string, subject: string): string {
  r.write(file, text);
  r.git("add", file);
  r.git("commit", "-qm", subject);
  return r.git("rev-parse", "HEAD").trim();
}
function amendLater(dir: string, message: string): void {
  const later = `${Math.floor(Date.now() / 1000) + 60} +0000`;
  execFileSync("git", ["commit", "-q", "--amend", "-am", message], {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_COMMITTER_DATE: later },
  });
}
const lastDiff = (): { left: U; right: U; title: string } => {
  const d = [...commandsRun].reverse().find((c) => c.id === "vscode.diff");
  assert.ok(d, "a diff opened");
  return { left: d.args[0] as U, right: d.args[1] as U, title: String(d.args[2]) };
};

test("the review of a tracked branch lists the unpushed commits, their files and totals, and the target", async () => {
  const { r } = remoteRepo("push-tracked");
  const base = r.git("rev-parse", "HEAD").trim();
  commit(r, "a.txt", "a\nmore\n", "one");
  commit(r, "c.txt", "c\n", "two");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.equal(p.hasUpstream, true);
  assert.equal(p.target, "origin/main");
  assert.equal(p.branch, "main");
  assert.equal(p.base, base, "diffs are from the fork point");
  assert.equal(p.canPush, true);
  assert.equal(p.ahead, 2);
  assert.equal(p.behind, 0);
  assert.equal(p.needsForce, false);
  assert.deepEqual((p.commits as { subject: string }[]).map((c) => c.subject), ["two", "one"]);
  assert.deepEqual((p.files as { path: string }[]).map((f) => f.path).sort(), ["a.txt", "c.txt"]);
  assert.equal(p.additions, 2);
});

test("with nothing ahead of its upstream, the review says up to date and releases the spinner", async () => {
  const { r } = remoteRepo("push-nothing");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  assert.equal(h.all("pushPreview").length, 0);
  assert.ok(said("status").includes("$(check) Nothing to push — up to date"));
  assert.deepEqual(h.last("pushDone"), { type: "pushDone", ok: true, nothing: true });
});

test("an unpublished branch previews everything not on a remote, targets origin/<branch>, and Push publishes it tracking", async () => {
  const { r, bare } = remoteRepo("push-publish");
  const forkedAt = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "-b", "feature");
  const tip = commit(r, "f.txt", "f\n", "feature work");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.equal(p.hasUpstream, false);
  assert.equal(p.target, "origin/feature");
  assert.equal(p.base, forkedAt);
  assert.equal(p.ahead, 1);
  assert.equal(p.canPush, true);
  await h.send({ type: "confirmPush" });
  assert.equal(onRemote(bare, "refs/heads/feature"), tip);
  assert.equal(r.git("rev-parse", "--abbrev-ref", "feature@{upstream}").trim(), "origin/feature");
  assert.ok(said("status").includes("$(check) Pushed"));
  assert.deepEqual(h.last("pushDone"), { type: "pushDone", ok: true, error: undefined });
});

test("a branch with no commits of its own can still be published: the review lists no files", async () => {
  const { r, bare } = remoteRepo("push-empty-branch");
  r.git("checkout", "-q", "-b", "empty");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.equal(p.ahead, 0);
  assert.equal(p.base, "HEAD");
  assert.deepEqual(p.files, []);
  assert.equal(p.canPush, true);
  await h.send({ type: "confirmPush" });
  assert.equal(onRemote(bare, "refs/heads/empty"), r.git("rev-parse", "HEAD").trim());
});

test("in a repository with no remote the review cannot push and says why; a confirmed push fails with the same reason", async () => {
  const r = repo("push-noremote");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.equal(p.canPush, false);
  assert.equal(p.reason, "No remote is configured for this repository.");
  assert.equal(p.target, "main");
  assert.equal(p.base, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "a root commit diffs against the empty tree");
  await h.send({ type: "confirmPush" });
  assert.deepEqual(said("error"), ["GitStudio: Push failed — No remote is configured for this repository."]);
  assert.deepEqual(h.last("pushDone"), {
    type: "pushDone",
    ok: false,
    error: "No remote is configured for this repository.",
  });
});

test("a pushed commit amended since is a rewrite: the review offers the force, and a forced push replaces it", async () => {
  const { r, bare } = remoteRepo("push-rewrite");
  r.write("a.txt", "amended\n");
  amendLater(r.dir, "base, amended");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.equal(p.needsForce, true);
  assert.equal(p.ahead, 1);
  assert.equal(p.behind, 1);
  await h.send({ type: "confirmPush", force: true });
  assert.equal(onRemote(bare, "refs/heads/main"), r.git("rev-parse", "HEAD").trim());
  assert.deepEqual(said("error"), []);
});

test("a plain push of a diverged branch is refused, and git's reason reaches both the toast and the review", async () => {
  const { r } = remoteRepo("push-refused");
  r.write("a.txt", "amended\n");
  amendLater(r.dir, "base, amended");
  const h = host(r.dir);
  await h.send({ type: "confirmPush" });
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: Push failed — /);
  const done = h.last("pushDone") as { ok: boolean; error: string };
  assert.equal(done.ok, false);
  assert.ok(done.error.length > 0);
});

test("a committed file's diff in the review is the fork point against HEAD, named by the short sha", async () => {
  const { r } = remoteRepo("push-filediff");
  const base = r.git("rev-parse", "HEAD").trim();
  commit(r, "a.txt", "a\nmore\n", "one");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  await h.send({ type: "openPushFileDiff", path: "a.txt" });
  const d = lastDiff();
  assert.equal(d.title, `a.txt  (before ${base.slice(0, 7)} ↔ after HEAD)`);
  assert.equal(rev.fromRevisionUri(d.left as never).rev, base);
  assert.equal(rev.fromRevisionUri(d.right as never).rev, "HEAD");
  await h.send({ type: "openPushFileDiff", path: "" });
  assert.equal(commandsRun.filter((c) => c.id === "vscode.diff").length, 1, "no path, no diff");
});

test("a renamed file's review diff reads the left side under its old name; a root commit's is '(new file)'", async () => {
  const r = repo("push-filediff-rename");
  r.git("mv", "a.txt", "renamed.txt");
  r.git("commit", "-qm", "rename");
  const h = host(r.dir);
  await h.send({ type: "requestPushPreview" });
  await h.send({ type: "openPushFileDiff", path: "renamed.txt", oldPath: "a.txt" });
  const d = lastDiff();
  assert.equal(d.title, "renamed.txt  (before (new file) ↔ after HEAD)");
  assert.equal(rev.fromRevisionUri(d.left as never).readPath, "a.txt");
});

test("a commit in the review opens to its own files; a file under it opens what THAT commit did", async () => {
  const { r } = remoteRepo("push-commitfile");
  const parent = r.git("rev-parse", "HEAD").trim();
  const sha = commit(r, "c.txt", "c\n", "add c");
  const h = host(r.dir);
  await h.send({ type: "pushCommitFiles", sha });
  const files = h.last("pushCommitFiles") as { sha: string; files: { path: string; status: string }[] };
  assert.equal(files.sha, sha);
  assert.deepEqual(files.files.map((f) => [f.path, f.status]), [["c.txt", "A"]]);
  await h.send({ type: "openPushCommitFile", sha, parent, path: "dir/c.txt", status: "A" });
  const d = lastDiff();
  assert.equal(d.title, `c.txt (${sha.slice(0, 7)})`);
  await h.send({ type: "pushCommitFiles", sha: "not-a-sha" });
  await h.send({ type: "openPushCommitFile", sha: "not-a-sha", path: "c.txt" });
  assert.equal(h.all("pushCommitFiles").length, 1, "a malformed sha asks git nothing");
  assert.equal(commandsRun.filter((c) => c.id === "vscode.diff").length, 1);
});

test("Undo commits… on a tracked branch, Keep Staged: the commits are gone and their changes wait in the index", async () => {
  const { r } = remoteRepo("push-undo-soft");
  const base = r.git("rev-parse", "HEAD").trim();
  commit(r, "a.txt", "a two\n", "one");
  commit(r, "c.txt", "c\n", "two");
  const h = host(r.dir);
  answerWith(() => "keep");
  await h.send({ type: "discardLocalCommits" });
  assert.equal(asked[0].title, "Undo 2 local commits");
  assert.equal(r.git("rev-parse", "HEAD").trim(), base);
  assert.deepEqual(r.git("diff", "--cached", "--name-only").trim().split("\n").sort(), ["a.txt", "c.txt"]);
  assert.ok(said("status").includes("$(check) Undid 2 local commits"));
  assert.deepEqual(h.last("pushDone"), { type: "pushDone", ok: true, discarded: true, error: undefined });
});

test("Undo commits… on an unpublished branch, Unstage: the changes come back as edits", async () => {
  const { r } = remoteRepo("push-undo-mixed");
  const forked = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "-b", "feature");
  commit(r, "c.txt", "c\n", "only");
  const h = host(r.dir);
  answerWith(() => "unstage");
  await h.send({ type: "discardLocalCommits" });
  assert.equal(asked[0].title, "Undo 1 local commit");
  assert.equal(r.git("rev-parse", "HEAD").trim(), forked);
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "");
  assert.equal(r.git("ls-files", "--others", "--exclude-standard").trim(), "c.txt");
});

test("Undo commits… dismissed moves nothing", async () => {
  const { r } = remoteRepo("push-undo-dismiss");
  const tip = commit(r, "c.txt", "c\n", "only");
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "discardLocalCommits" });
  assert.equal(r.git("rev-parse", "HEAD").trim(), tip);
  assert.equal(h.all("pushDone").length, 0);
});

test("Undo commits… with nothing ahead says there is nothing to undo, and asks nothing", async () => {
  const { r } = remoteRepo("push-undo-none");
  const h = host(r.dir);
  await h.send({ type: "discardLocalCommits" });
  assert.equal(asked.length, 0);
  assert.ok(said("status").includes("$(info) No local commits to undo"));
});

test("Undo commits… never undoes a repository's first commit", async () => {
  const r = repo("push-undo-root");
  const h = host(r.dir);
  await h.send({ type: "discardLocalCommits" });
  assert.deepEqual(said("warning"), ["GitStudio: can't undo the repository's initial commit this way."]);
  assert.equal(asked.length, 0);
  assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "1");
});

test("New branch… from the review makes the branch at HEAD, switches to it, and closes the review", async () => {
  const { r } = remoteRepo("push-newbranch");
  const tip = commit(r, "c.txt", "c\n", "only");
  const h = host(r.dir);
  await h.send({ type: "newBranchFromPush", ref: " parked " });
  assert.equal(r.git("branch", "--show-current").trim(), "parked");
  assert.equal(r.git("rev-parse", "HEAD").trim(), tip);
  assert.ok(said("status").includes("$(check) Created & switched to parked"));
  assert.deepEqual(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), ["parked"]);
  assert.deepEqual(h.last("pushDone"), { type: "pushDone", ok: true, nothing: true });
});

test("New branch… with a taken name keeps the review open and says git's reason; a blank name does nothing", async () => {
  const { r } = remoteRepo("push-newbranch-bad");
  const h = host(r.dir);
  await h.send({ type: "newBranchFromPush", ref: "main" });
  assert.match(said("error")[0], /^GitStudio: couldn't create branch — .*already exists/);
  await h.send({ type: "newBranchFromPush", ref: "  " });
  assert.equal(said("error").length, 1);
  assert.equal(h.all("pushDone").length, 0, "the review stays open");
});

test("the review opened for a worktree (openPushReview) says whose commits they are, or that it has nothing to push", async () => {
  const { r } = remoteRepo("push-openreview");
  commit(r, "c.txt", "c\n", "only");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  let released = 0;
  const target = { entry: h.entry!, name: "wt-one", shownPath: "~/wt-one", release: () => void released++ };
  await h.provider.openPushReview(target);
  const p = h.last("pushPreview") as Record<string, unknown>;
  assert.deepEqual(p.worktree, { name: "wt-one", shownPath: "~/wt-one" });
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.commit.focus"), "the view is revealed first");
  await h.send({ type: "confirmPush" });
  await h.provider.openPushReview(target);
  assert.ok(said("status").includes("$(check) Nothing to push from wt-one — up to date"));
  assert.equal(released, 0, "a review never lets go of the context it acts on");
});
