import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// BranchOps against real git: each command changes exactly the ref it names —
// by full name wherever a tag could share the short one — and hands back git's
// verdict rather than throwing.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function scene(name: string): { r: Repo; A: string; B: string } {
  const r = makeRepo(`branchops-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("f.txt", "a\n");
  const A = r.commitAll("A");
  r.write("f.txt", "b\n");
  const B = r.commitAll("B");
  return { r, A, B };
}

function server(r: Repo, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gs-branchops-${name}-`));
  cleanup.push(() => removeTempRepo(dir));
  r.git("init", "-q", "--bare", dir);
  r.git("remote", "add", "origin", dir);
  return dir;
}

test("create makes a branch at a start point without moving HEAD; a taken name is refused", async () => {
  const { r, A } = scene("create");
  const ops = r.ctx().branches;
  const { signal } = new AbortController();
  const made = await ops.create("old", A, { signal });
  assert.equal(made.ok, true);
  assert.equal(made.code, 0);
  assert.equal(r.sha("refs/heads/old"), A);
  assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/master");
  const again = await ops.create("old");
  assert.equal(again.ok, false);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /already exists/);
});

test("checkout with detach leaves HEAD detached at the ref, even a branch", async () => {
  const { r, B } = scene("detach");
  const ops = r.ctx().branches;
  const res = await ops.checkout("master", { detach: true });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.tryGit("symbolic-ref", "-q", "HEAD"), 1, "detached");
  assert.equal(r.sha("HEAD"), B);
  const back = await ops.checkout("master");
  assert.equal(back.ok, true);
  assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/master");
  const bad = await ops.checkout("no-such-ref");
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /no-such-ref/);
});

test("checkoutNew from a remote-tracking ref switches to the new branch and tracks it", async () => {
  const { r, A } = scene("checkoutnew");
  server(r, "checkoutnew");
  r.git("push", "-q", "origin", `${A}:refs/heads/feature`);
  r.git("fetch", "-q", "origin");
  const ops = r.ctx().branches;
  const res = await ops.checkoutNew("feature", "origin/feature");
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/feature");
  assert.equal(r.sha("HEAD"), A);
  assert.deepEqual(await ops.upstreamOf("feature"), { remote: "origin", branch: "feature" });
  const plain = await ops.checkoutNew("plain");
  assert.equal(plain.ok, true);
  assert.equal(await ops.upstreamOf("plain"), null, "no start point, no upstream");
});

test("upstreamOf keeps a merge ref that is not under refs/heads as written, and is null for half a config", async () => {
  const { r } = scene("upstream");
  const ops = r.ctx().branches;
  r.git("config", "branch.master.remote", "origin");
  assert.equal(await ops.upstreamOf("master"), null, "a remote without a merge ref is no upstream");
  r.git("config", "branch.master.merge", "refs/pull/7/head");
  assert.deepEqual(await ops.upstreamOf("master"), { remote: "origin", branch: "refs/pull/7/head" });
});

test("setUpstream points a branch at a remote-tracking ref given by full name; a missing one is refused", async () => {
  const { r, B } = scene("setupstream");
  server(r, "setupstream");
  r.git("push", "-q", "origin", `${B}:refs/heads/elsewhere`);
  r.git("fetch", "-q", "origin");
  const ops = r.ctx().branches;
  const ok = await ops.setUpstream("master", "refs/remotes/origin/elsewhere");
  assert.equal(ok.ok, true, ok.stderr);
  assert.deepEqual(await ops.upstreamOf("master"), { remote: "origin", branch: "elsewhere" });
  const missing = await ops.setUpstream("master", "refs/remotes/origin/nope");
  assert.equal(missing.ok, false);
  assert.deepEqual(await ops.upstreamOf("master"), { remote: "origin", branch: "elsewhere" }, "unchanged");
});

test("mergeArgs names a remote-tracking branch the way git would, and adds no message for what it can't name", async () => {
  const { r, A } = scene("mergeargs");
  server(r, "mergeargs");
  // A commit master does not have yet (git names nothing already merged).
  const tree = r.git("rev-parse", `${A}^{tree}`).trim();
  const topic = r.git("commit-tree", tree, "-p", A, "-m", "topic work").trim();
  r.git("push", "-q", "origin", `${topic}:refs/heads/topic`);
  r.git("fetch", "-q", "origin");
  const ops = r.ctx().branches;
  assert.deepEqual(await ops.mergeArgs("refs/remotes/origin/topic", { noFf: true }), [
    "merge",
    "--no-ff",
    "--no-log",
    "-m",
    "Merge remote-tracking branch 'origin/topic'",
    "refs/remotes/origin/topic",
  ]);
  assert.deepEqual(await ops.mergeArgs("refs/heads/", { ffOnly: true }), ["merge", "--ff-only", "refs/heads/"], "no name under the namespace");
  assert.deepEqual(await ops.mergeArgs("refs/heads/missing"), ["merge", "refs/heads/missing"], "a ref git can't resolve: git reports it");
  assert.deepEqual(await ops.mergeArgs("topic"), ["merge", "topic"], "a short name is git's to name");
});

test("merge of a full branch name beside a same-named tag merges the BRANCH, recorded under its plain name", async () => {
  const { r, A } = scene("mergeambig");
  // branch "release" gets its own commit; a tag "release" sits on an older one.
  r.git("checkout", "-q", "-b", "release", A);
  r.write("r.txt", "release\n");
  const releaseTip = r.commitAll("on release");
  r.git("checkout", "-q", "master");
  r.git("tag", "release", A);
  const ops = r.ctx().branches;
  const res = await ops.merge("refs/heads/release", { noFf: true });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.sha("HEAD^2"), releaseTip, "the branch's tip was merged, not the tag's commit");
  assert.equal(r.git("log", "-1", "--format=%s").trim(), "Merge branch 'release'");
});

test("rebaseOnto replays the current branch onto another, and a conflict comes back as a failure with git's words", async () => {
  const { r, A, B } = scene("rebase");
  r.git("checkout", "-q", "-b", "side", A);
  r.write("g.txt", "g\n");
  r.commitAll("side adds g");
  const ops = r.ctx().branches;
  const res = await ops.rebaseOnto("master");
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.sha("HEAD~1"), B, "side now sits on master");

  r.git("checkout", "-q", "-b", "clash", A);
  r.write("f.txt", "clash\n");
  r.commitAll("clash edits f");
  const clash = await ops.rebaseOnto("master");
  assert.equal(clash.ok, false);
  assert.match(clash.stdout + clash.stderr, /CONFLICT/);
  r.git("rebase", "--abort");
});

test("deleteRemoteBranch deletes the remote BRANCH by full name, never a same-named tag there", async () => {
  const { r, A, B } = scene("delremote");
  const srv = server(r, "delremote");
  r.git("push", "-q", "origin", `${B}:refs/heads/release`, `${A}:refs/tags/release`);
  const ops = r.ctx().branches;
  const res = await ops.deleteRemoteBranch("origin", "release");
  assert.equal(res.ok, true, res.stderr);
  const onServer = r.git("--git-dir", srv, "for-each-ref", "--format=%(refname)").trim().split("\n");
  assert.deepEqual(onServer, ["refs/tags/release"], "the branch is gone and the tag stays");
  // Once gone, a second delete still never touches the tag.
  await ops.deleteRemoteBranch("origin", "release");
  assert.equal(r.git("--git-dir", srv, "rev-parse", "refs/tags/release").trim(), A);
});
