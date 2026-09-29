// The Branches view's branch / remote / tag / remote-management doors, driven
// as the view drives them (a tree node's `{ ref }`, or no node from the
// palette), against real git: a work repository with a bare "origin" beside it
// on disk. Each cell checks what the repository looks like afterwards, and
// what the person was told and asked.
//
// vscodeStub.cjs stands in for VS Code and records every message; the dialog
// host answers each question from the cell's script, by its title.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  workspace: Record<string, unknown>;
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const actions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

// `gitstudio.fetch.prune` — the one setting these doors read.
const settings = new Map<string, unknown>();
vscode.workspace.getConfiguration = (section?: string) => ({
  get: (key: string, fallback?: unknown) => {
    const k = `${section}.${key}`;
    return settings.has(k) ? settings.get(k) : fallback;
  },
});

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-branch-doors-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let seq = 0;

// ── The dialog host: every question is recorded, and answered by title. ──
let asked: DialogSpec[] = [];
let script: [RegExp, string][] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const hit = script.find(([re]) => re.test(spec.title));
    return hit ? { value: hit[1] } : undefined;
  },
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    g("config", k, v);
  }
}

interface World {
  dir: string;
  remote: string;
  git: (...a: string[]) => string;
  origin: (...a: string[]) => string;
  repos: never;
  refreshed: () => number;
  refresh: () => void;
}

const opened: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of opened) c.dispose();
});

/** main on "origin" (a bare repository on disk), checked out and tracking. */
function world(opts: { remote?: boolean } = {}): World {
  const base = join(scratch, `w${++seq}`);
  const remote = join(base, "remote.git");
  const dir = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  identify(git);
  writeFileSync(join(dir, "f.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  let origin: (...a: string[]) => string = () => {
    throw new Error("no remote in this world");
  };
  if (opts.remote !== false) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    origin = at(remote);
    identify(origin);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
  }
  const ctx = new GitContext({ root: dir });
  opened.push(ctx);
  const entry = { ctx, root: dir };
  const repos = { getActive: () => entry, getAll: () => [entry], getUndoLedger: () => undefined } as never;
  let n = 0;
  return { dir, remote, git, origin, repos, refreshed: () => n, refresh: () => void n++ };
}

const noRepo = { getActive: () => undefined, getAll: () => [], getUndoLedger: () => undefined } as never;

function reset(answers: [RegExp, string][] = []): void {
  asked = [];
  script = answers;
  vscode.__said.length = 0;
}
const node = (name: string, type = "head") => ({ ref: { name, type, sha: "" } });
const said = (kind: string): string[] => vscode.__said.filter((m) => m.kind === kind).map((m) => m.message);
const titles = (): string[] => asked.map((s) => s.title);
const has = (g: (...a: string[]) => string, ref: string): boolean => {
  try {
    g("rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};
const cfg = (g: (...a: string[]) => string, key: string): string => {
  try {
    return g("config", "--get", key);
  } catch {
    return "";
  }
};

// ── No repository ────────────────────────────────────────────────────────────

test("every door, with no repository open, says so and asks nothing", async () => {
  reset([[/./, "ok"]]);
  const refresh = () => assert.fail("nothing ran, so nothing refreshes");
  await actions.checkoutBranch(noRepo, node("main"), refresh);
  await actions.renameBranch(noRepo, node("main"), refresh);
  await actions.deleteBranch(noRepo, node("main"), refresh);
  await actions.pushBranch(noRepo, node("main"), refresh);
  await actions.setUpstream(noRepo, node("main"), refresh);
  await actions.newBranchFrom(noRepo, node("main"), refresh);
  await actions.createWorktreeForBranch(noRepo, node("main"), refresh);
  await actions.checkoutRemoteBranch(noRepo, undefined, refresh);
  await actions.deleteRemoteBranch(noRepo, undefined, refresh);
  await actions.checkoutTag(noRepo, undefined, refresh);
  await actions.deleteTag(noRepo, undefined, refresh);
  await actions.pushTag(noRepo, undefined, refresh);
  await actions.fetchAll(noRepo, refresh);
  await actions.addRemote(noRepo, refresh);
  await actions.manageRemotes(noRepo, refresh);
  await actions.resetBranchToUpstream(noRepo, node("main"), refresh);
  await actions.mergeBranchIntoCurrent(noRepo, node("main"), refresh);
  await actions.rebaseCurrentOnto(noRepo, node("main"), refresh);
  assert.deepEqual(asked, []);
  const infos = said("info");
  assert.equal(infos.length, 18);
  for (const m of infos) assert.equal(m, "GitStudio: No repository is open.");
});

// ── Rename ───────────────────────────────────────────────────────────────────

test("rename: an unpublished branch is renamed, and nothing is asked about a remote", async () => {
  const w = world();
  w.git("branch", "topic");
  reset([[/^Rename branch topic$/, "topic-2"]]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.deepEqual(titles(), ["Rename branch topic"]);
  const spec = asked[0] as { value?: string; validate?: string };
  assert.equal(spec.value, "topic", "the box starts on the old name");
  assert.equal(spec.validate, "refName");
  assert.ok(has(w.git, "refs/heads/topic-2"));
  assert.ok(!has(w.git, "refs/heads/topic"));
  assert.deepEqual(said("status"), ["$(check) Renamed to topic-2"]);
  assert.equal(w.refreshed(), 1);
});

test("rename: the same name, or a dismissed box, changes nothing", async () => {
  const w = world();
  w.git("branch", "topic");
  reset([[/^Rename branch/, "topic"]]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  reset();
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.ok(has(w.git, "refs/heads/topic"));
  assert.equal(w.refreshed(), 0);
  assert.deepEqual(vscode.__said, []);
});

test("rename: onto a name that is taken says what failed, and both branches stay", async () => {
  const w = world();
  w.git("branch", "topic");
  w.git("branch", "taken");
  reset([[/^Rename branch topic$/, "taken"]]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  const [err] = said("error");
  assert.match(err, /^GitStudio: Rename branch failed — .*already exists/);
  assert.ok(has(w.git, "refs/heads/topic"));
  assert.equal(w.refreshed(), 0);
});

test("rename a published branch → Rename on origin: the new name is pushed and tracked, the old one deleted there", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/topic");
  w.git("branch", "-q", "--track", "topic", "refs/remotes/origin/topic");
  reset([
    [/^Rename branch topic$/, "topic-2"],
    [/^Rename topic on origin too\?$/, "rename"],
  ]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.deepEqual(titles(), ["Rename branch topic", "Rename topic on origin too?"]);
  assert.ok(has(w.origin, "refs/heads/topic-2"), "pushed under the new name");
  assert.ok(!has(w.origin, "refs/heads/topic"), "the old name is gone from the remote");
  assert.equal(cfg(w.git, "branch.topic-2.merge"), "refs/heads/topic-2", "tracks the new name");
  assert.ok(said("status").includes("$(check) Renamed on origin: topic → topic-2"));
});

test("rename a published branch → Publish, keep: both names are on the remote, and the new one is tracked", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/topic");
  w.git("branch", "-q", "--track", "topic", "refs/remotes/origin/topic");
  reset([
    [/^Rename branch topic$/, "topic-2"],
    [/too\?$/, "publish"],
  ]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.ok(has(w.origin, "refs/heads/topic-2"));
  assert.ok(has(w.origin, "refs/heads/topic"), "the old remote branch is left in place");
  assert.equal(cfg(w.git, "branch.topic-2.merge"), "refs/heads/topic-2");
  assert.ok(said("status").includes("$(check) Published topic-2 to origin"));
});

test("rename a published branch → Keep tracking: git's default, the remote untouched", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/topic");
  w.git("branch", "-q", "--track", "topic", "refs/remotes/origin/topic");
  reset([
    [/^Rename branch topic$/, "topic-2"],
    [/too\?$/, "keep"],
  ]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.ok(!has(w.origin, "refs/heads/topic-2"));
  assert.equal(cfg(w.git, "branch.topic-2.merge"), "refs/heads/topic", "still tracks the old name");
  assert.deepEqual(said("status"), ["$(check) Renamed to topic-2"]);
});

test("rename a published branch whose publish is refused: says it is renamed locally and still tracks the old name", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/topic");
  w.git("branch", "-q", "--track", "topic", "refs/remotes/origin/topic");
  // The remote goes away between the listing and the push.
  rmSync(w.remote, { recursive: true, force: true });
  reset([
    [/^Rename branch topic$/, "topic-2"],
    [/too\?$/, "rename"],
  ]);
  await actions.renameBranch(w.repos, node("topic"), w.refresh);
  assert.ok(has(w.git, "refs/heads/topic-2"), "the local rename stands");
  const errs = said("error");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^GitStudio: renamed locally, but publishing topic-2 failed — .*\. It still tracks origin\/topic\.$/s);
});

test("rename a tag node is refused: it is not a local branch", async () => {
  const w = world();
  w.git("tag", "v1");
  reset([[/./, "x"]]);
  await actions.renameBranch(w.repos, node("v1", "tag"), w.refresh);
  assert.deepEqual(asked, []);
  assert.deepEqual(said("error"), ["GitStudio: v1 is not a local branch."]);
});

test("a branch deleted since the menu was drawn is said to be gone, and nothing is asked", async () => {
  const w = world();
  reset([[/./, "ok"]]);
  await actions.renameBranch(w.repos, node("gone"), w.refresh);
  await actions.deleteBranch(w.repos, node("gone"), w.refresh);
  await actions.pushBranch(w.repos, node("gone"), w.refresh);
  await actions.mergeBranchIntoCurrent(w.repos, node("gone"), w.refresh);
  await actions.rebaseCurrentOnto(w.repos, node("gone"), w.refresh);
  await actions.newBranchFrom(w.repos, node("gone"), w.refresh);
  await actions.resetBranchToUpstream(w.repos, node("gone"), w.refresh);
  await actions.checkoutBranch(w.repos, node("gone"), w.refresh);
  assert.deepEqual(asked, []);
  const errs = said("error");
  assert.equal(errs.length, 8);
  for (const e of errs) assert.equal(e, "GitStudio: gone is not in this repository any more — refresh and try again.");
});

// ── Delete ───────────────────────────────────────────────────────────────────

test("delete a merged branch: asked once, as a danger, then it is gone", async () => {
  const w = world();
  w.git("branch", "merged");
  reset([[/^Delete branch merged\?$/, "ok"]]);
  await actions.deleteBranch(w.repos, node("merged"), w.refresh);
  assert.deepEqual(titles(), ["Delete branch merged?"]);
  assert.equal((asked[0] as { danger?: boolean }).danger, true);
  assert.ok(!has(w.git, "refs/heads/merged"));
  assert.deepEqual(said("status"), ["$(check) Deleted merged"]);
  assert.equal(w.refreshed(), 1);
});

test("delete, declined: the branch stays", async () => {
  const w = world();
  w.git("branch", "keep");
  reset();
  await actions.deleteBranch(w.repos, node("keep"), w.refresh);
  assert.ok(has(w.git, "refs/heads/keep"));
  assert.equal(w.refreshed(), 0);
});

function unmerged(w: World): void {
  w.git("checkout", "-q", "-b", "wip");
  w.git("commit", "-q", "--allow-empty", "-m", "only here");
  w.git("checkout", "-q", "main");
}

test("delete an unmerged branch: asked again to force, and force-deleted on yes", async () => {
  const w = world();
  unmerged(w);
  reset([
    [/^Delete branch wip\?$/, "ok"],
    [/^wip is not fully merged$/, "ok"],
  ]);
  await actions.deleteBranch(w.repos, node("wip"), w.refresh);
  assert.deepEqual(titles(), ["Delete branch wip?", "wip is not fully merged"]);
  assert.equal((asked[1] as { confirmLabel?: string }).confirmLabel, "Force Delete");
  assert.ok(!has(w.git, "refs/heads/wip"));
  assert.deepEqual(said("status"), ["$(check) Deleted wip"]);
});

test("delete an unmerged branch, force declined: the branch and its commit stay, nothing is reported", async () => {
  const w = world();
  unmerged(w);
  reset([[/^Delete branch wip\?$/, "ok"]]);
  await actions.deleteBranch(w.repos, node("wip"), w.refresh);
  assert.ok(has(w.git, "refs/heads/wip"));
  assert.deepEqual(vscode.__said, []);
  assert.equal(w.refreshed(), 0);
});

test("delete the checked-out branch: git's refusal is said with the action's name", async () => {
  const w = world();
  reset([[/^Delete branch main\?$/, "ok"]]);
  await actions.deleteBranch(w.repos, node("main"), w.refresh);
  assert.ok(has(w.git, "refs/heads/main"));
  const [err] = said("error");
  assert.match(err, /^GitStudio: Delete branch failed — /);
});

// ── Push / publish ───────────────────────────────────────────────────────────

test("push an unpublished branch with one remote: published there without asking which, and tracked", async () => {
  const w = world();
  w.git("branch", "topic");
  reset();
  await actions.pushBranch(w.repos, node("topic"), w.refresh);
  assert.deepEqual(asked, [], "one remote: nothing to choose");
  assert.ok(has(w.origin, "refs/heads/topic"));
  assert.equal(cfg(w.git, "branch.topic.remote"), "origin");
  assert.deepEqual(said("status"), ["$(check) Published topic to origin"]);
});

test("push an unpublished branch with two remotes: asks which, and publishes to the one picked", async () => {
  const w = world();
  const fork = join(w.dir, "..", "fork.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", fork]);
  w.git("remote", "add", "fork", fork);
  w.git("branch", "topic");
  reset([[/^Publish to which remote\?$/, "fork"]]);
  await actions.pushBranch(w.repos, node("topic"), w.refresh);
  assert.deepEqual(titles(), ["Publish to which remote?"]);
  const choices = (asked[0] as { choices: { id: string }[] }).choices.map((c) => c.id);
  assert.deepEqual(choices.sort(), ["fork", "origin"]);
  assert.ok(has(at(fork), "refs/heads/topic"));
  assert.ok(!has(w.origin, "refs/heads/topic"));
});

test("publish with no remote picked (dismissed) pushes nothing", async () => {
  const w = world();
  const fork = join(w.dir, "..", "fork.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", fork]);
  w.git("remote", "add", "fork", fork);
  w.git("branch", "topic");
  reset();
  await actions.pushBranch(w.repos, node("topic"), w.refresh);
  assert.ok(!has(w.origin, "refs/heads/topic"));
  assert.ok(!has(at(fork), "refs/heads/topic"));
  assert.equal(w.refreshed(), 0);
});

test("publish with no remotes at all says there are none", async () => {
  const w = world({ remote: false });
  w.git("branch", "topic");
  reset();
  await actions.pushBranch(w.repos, node("topic"), w.refresh);
  assert.deepEqual(said("info"), ["GitStudio: no remotes configured."]);
  assert.deepEqual(asked, []);
});

test("push a tracked branch that is NOT checked out pushes that branch, not HEAD", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/topic");
  w.git("branch", "-q", "--track", "topic", "refs/remotes/origin/topic");
  const tip = w.git("commit-tree", "HEAD^{tree}", "-p", "refs/heads/topic", "-m", "on topic");
  w.git("update-ref", "refs/heads/topic", tip);
  w.git("commit", "-q", "--allow-empty", "-m", "on main, not to be pushed");
  const mainBefore = w.origin("rev-parse", "refs/heads/main");
  reset();
  await actions.pushBranch(w.repos, node("topic"), w.refresh);
  assert.equal(w.origin("rev-parse", "refs/heads/topic"), tip);
  assert.equal(w.origin("rev-parse", "refs/heads/main"), mainBefore, "main on the remote is untouched");
  assert.deepEqual(said("status"), ["$(check) Pushed topic"]);
});

// ── Set upstream ─────────────────────────────────────────────────────────────

test("set upstream from the palette: picks the branch, then a remote branch (not origin/HEAD), and tracks it", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/other");
  w.git("fetch", "-q", "origin");
  w.git("remote", "set-head", "origin", "main");
  w.git("branch", "topic");
  reset([
    [/^Set the upstream for which branch\?$/, "topic"],
    [/^Set upstream for topic$/, "refs/remotes/origin/other"],
  ]);
  await actions.setUpstream(w.repos, undefined, w.refresh);
  assert.deepEqual(titles(), ["Set the upstream for which branch?", "Set upstream for topic"]);
  const offered = (asked[1] as { choices: { id: string; label: string }[] }).choices;
  assert.deepEqual(
    offered.map((c) => c.id).sort(),
    ["refs/remotes/origin/main", "refs/remotes/origin/other"],
    "the remote's HEAD pointer is not offered",
  );
  assert.ok(offered.some((c) => c.label === "origin/other"));
  assert.equal(cfg(w.git, "branch.topic.merge"), "refs/heads/other");
  assert.deepEqual(said("status"), ["$(check) Set upstream of topic → origin/other"]);
});

test("set upstream, the remote branch not picked: nothing changes", async () => {
  const w = world();
  w.git("branch", "topic");
  reset();
  await actions.setUpstream(w.repos, node("topic"), w.refresh);
  assert.deepEqual(titles(), ["Set upstream for topic"]);
  assert.equal(cfg(w.git, "branch.topic.merge"), "");
});

// ── New branch ───────────────────────────────────────────────────────────────

test("new branch from a ref, Create Only: made at that ref, and HEAD stays", async () => {
  const w = world();
  const base = w.git("rev-parse", "HEAD");
  w.git("tag", "v1");
  w.git("commit", "-q", "--allow-empty", "-m", "later");
  reset([
    [/^New branch from v1$/, "from-tag"],
    [/^Create from-tag$/, "only"],
  ]);
  await actions.newBranchFrom(w.repos, node("v1", "tag"), w.refresh);
  assert.deepEqual(titles(), ["New branch from v1", "Create from-tag"]);
  assert.equal((asked[0] as { hint?: string }).hint, "The branch starts at v1.");
  assert.equal(w.git("rev-parse", "refs/heads/from-tag"), base);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.deepEqual(said("status"), ["$(check) Created from-tag"]);
});

test("new branch with no node, Create and Switch: starts at HEAD and is checked out", async () => {
  const w = world();
  const head = w.git("rev-parse", "HEAD");
  reset([
    [/^New branch$/, "fresh"],
    [/^Create fresh$/, "switch"],
  ]);
  await actions.newBranchFrom(w.repos, undefined, w.refresh);
  assert.equal((asked[0] as { hint?: string }).hint, "The branch starts at HEAD.");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "fresh");
  assert.equal(w.git("rev-parse", "HEAD"), head);
  assert.deepEqual(said("status"), ["$(check) Created fresh"]);
});

test("new branch: backing out of either question creates nothing", async () => {
  const w = world();
  reset();
  await actions.newBranchFrom(w.repos, node("main"), w.refresh);
  reset([[/^New branch from main$/, "half"]]);
  await actions.newBranchFrom(w.repos, node("main"), w.refresh);
  assert.deepEqual(titles(), ["New branch from main", "Create half"]);
  assert.ok(!has(w.git, "refs/heads/half"));
  assert.equal(w.refreshed(), 0);
});

test("new branch over a name that exists: Create Only says git's refusal", async () => {
  const w = world();
  w.git("branch", "dup");
  reset([
    [/^New branch/, "dup"],
    [/^Create dup$/, "only"],
  ]);
  await actions.newBranchFrom(w.repos, undefined, w.refresh);
  assert.match(said("error")[0] ?? "", /^GitStudio: Create branch failed — .*already exists/);
});

// ── Remote branches ──────────────────────────────────────────────────────────

test("check out a remote branch from the palette: a local branch is made, tracking it, and checked out", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/feature");
  w.git("fetch", "-q", "origin");
  reset([[/^Check out which remote branch\?$/, "origin/feature"]]);
  await actions.checkoutRemoteBranch(w.repos, undefined, w.refresh);
  const offered = (asked[0] as { choices: { id: string; icon?: string }[] }).choices;
  assert.ok(offered.every((c) => c.icon === "cloud"));
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature");
  assert.equal(cfg(w.git, "branch.feature.merge"), "refs/heads/feature");
  assert.equal(w.refreshed(), 1);
});

test("the palette's pick, with nothing of that kind, says there is nothing to choose from", async () => {
  const w = world({ remote: false });
  reset([[/./, "x"]]);
  await actions.checkoutRemoteBranch(w.repos, undefined, w.refresh);
  await actions.checkoutTag(w.repos, undefined, w.refresh);
  await actions.deleteTag(w.repos, undefined, w.refresh);
  assert.deepEqual(asked, []);
  assert.deepEqual(said("info"), [
    "GitStudio: this repository has no remote branches to choose from.",
    "GitStudio: this repository has no tags to choose from.",
    "GitStudio: this repository has no tags to choose from.",
  ]);
});

test("delete a remote branch: confirmed as a danger, then gone from the remote; the local one stays", async () => {
  const w = world();
  w.git("push", "-q", "-u", "origin", "main:refs/heads/feature");
  w.git("branch", "feature", "refs/remotes/origin/feature");
  reset([[/^Delete feature on origin\?$/, "ok"]]);
  await actions.deleteRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.equal((asked[0] as { danger?: boolean }).danger, true);
  assert.ok(!has(w.origin, "refs/heads/feature"));
  assert.ok(has(w.git, "refs/heads/feature"));
  assert.deepEqual(said("status"), ["$(check) Deleted origin/feature"]);
});

test("delete a remote branch, declined: the remote keeps it", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/feature");
  reset();
  await actions.deleteRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.ok(has(w.origin, "refs/heads/feature"));
  assert.equal(w.refreshed(), 0);
});

// ── Tags ─────────────────────────────────────────────────────────────────────

test("check out a tag: asked, then HEAD is detached at the tag", async () => {
  const w = world();
  const tagged = w.git("rev-parse", "HEAD");
  w.git("tag", "v1");
  w.git("commit", "-q", "--allow-empty", "-m", "later");
  reset([[/^Check out tag v1\?$/, "ok"]]);
  await actions.checkoutTag(w.repos, node("v1", "tag"), w.refresh);
  assert.equal(w.git("rev-parse", "HEAD"), tagged);
  assert.throws(() => w.git("symbolic-ref", "-q", "HEAD"), "detached");
});

test("check out a tag, declined: HEAD stays on its branch", async () => {
  const w = world();
  w.git("tag", "v1");
  reset();
  await actions.checkoutTag(w.repos, node("v1", "tag"), w.refresh);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
});

test("delete a tag picked from the palette: gone locally", async () => {
  const w = world();
  w.git("tag", "v1");
  w.git("tag", "v2");
  reset([
    [/^Select a tag to delete$/, "v2"],
    [/^Delete tag v2\?$/, "ok"],
  ]);
  await actions.deleteTag(w.repos, undefined, w.refresh);
  assert.ok(has(w.git, "refs/tags/v1"));
  assert.ok(!has(w.git, "refs/tags/v2"));
  assert.deepEqual(said("status"), ["$(check) Deleted tag v2"]);
});

test("delete a tag, declined: it stays", async () => {
  const w = world();
  w.git("tag", "v1");
  reset();
  await actions.deleteTag(w.repos, node("v1", "tag"), w.refresh);
  assert.ok(has(w.git, "refs/tags/v1"));
});

test("delete a tag beside a branch of the same name deletes the TAG, not the branch", async () => {
  const w = world();
  w.git("branch", "release");
  w.git("tag", "release");
  reset([[/^Delete tag release\?$/, "ok"]]);
  // The ref list names the tag "tags/release" beside the branch.
  await actions.deleteTag(w.repos, node("tags/release", "tag"), w.refresh);
  assert.ok(!has(w.git, "refs/tags/release"));
  assert.ok(has(w.git, "refs/heads/release"));
});

test("push a tag: to the only remote, without asking which", async () => {
  const w = world();
  w.git("tag", "v1");
  reset();
  await actions.pushTag(w.repos, node("v1", "tag"), w.refresh);
  assert.deepEqual(asked, []);
  assert.ok(has(w.origin, "refs/tags/v1"));
  assert.deepEqual(said("status"), ["$(check) Pushed tag v1 to origin"]);
});

test("push a tag with no remote: says so, and pushes nothing", async () => {
  const w = world({ remote: false });
  w.git("tag", "v1");
  reset();
  await actions.pushTag(w.repos, node("v1", "tag"), w.refresh);
  assert.deepEqual(said("info"), ["GitStudio: no remotes configured."]);
});

// ── Fetch ────────────────────────────────────────────────────────────────────

/** A commit lands on origin's main behind the work repository's back. */
function remoteAdvances(w: World): string {
  const sha = w.origin("commit-tree", "main^{tree}", "-p", "main", "-m", "on the remote");
  w.origin("update-ref", "refs/heads/main", sha);
  return sha;
}

test("fetch all: the remote's new commit is in the remote-tracking branch, and a vanished branch is pruned", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/doomed");
  w.origin("update-ref", "-d", "refs/heads/doomed");
  const sha = remoteAdvances(w);
  settings.delete("gitstudio.fetch.prune");
  reset();
  await actions.fetchAll(w.repos, w.refresh);
  assert.equal(w.git("rev-parse", "refs/remotes/origin/main"), sha);
  assert.ok(!has(w.git, "refs/remotes/origin/doomed"), "prune is on by default");
  assert.deepEqual(said("status"), ["$(check) Fetched all remotes"]);
});

test("fetch all with pruning turned off keeps the stale remote-tracking branch", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/doomed");
  w.origin("update-ref", "-d", "refs/heads/doomed");
  settings.set("gitstudio.fetch.prune", false);
  try {
    reset();
    await actions.fetchAll(w.repos, w.refresh);
    assert.ok(has(w.git, "refs/remotes/origin/doomed"));
  } finally {
    settings.delete("gitstudio.fetch.prune");
  }
});

test("fetch all against a remote that is gone says Fetch failed", async () => {
  const w = world();
  rmSync(w.remote, { recursive: true, force: true });
  reset();
  await actions.fetchAll(w.repos, w.refresh);
  assert.match(said("error")[0] ?? "", /^GitStudio: Fetch failed — /);
  assert.equal(w.refreshed(), 0);
});

// ── Remotes ──────────────────────────────────────────────────────────────────

test("add remote: asks the name, then the URL, and adds it trimmed", async () => {
  const w = world({ remote: false });
  const other = join(w.dir, "..", "other.git");
  execFileSync("git", ["init", "-q", "--bare", other]);
  reset([
    [/^Add remote$/, " upstream "],
    [/^Add remote {2}upstream $/, ` ${other} `],
  ]);
  await actions.addRemote(w.repos, w.refresh);
  assert.deepEqual(titles(), ["Add remote", "Add remote  upstream "]);
  assert.equal((asked[0] as { validate?: string }).validate, "remoteName");
  assert.equal((asked[1] as { validate?: string }).validate, "url");
  assert.equal(cfg(w.git, "remote.upstream.url"), other);
  assert.deepEqual(said("status"), ["$(check) Added remote  upstream "]);
});

test("add remote, backing out at the URL, adds nothing", async () => {
  const w = world({ remote: false });
  reset([[/^Add remote$/, "upstream"]]);
  await actions.addRemote(w.repos, w.refresh);
  assert.equal(w.git("remote"), "");
});

test("manage remotes with none: offers to add one, and adds it", async () => {
  const w = world({ remote: false });
  reset([
    [/^No remotes configured$/, "ok"],
    [/^Add remote$/, "origin"],
    [/^Add remote origin$/, "/some/where.git"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.deepEqual(titles(), ["No remotes configured", "Add remote", "Add remote origin"]);
  assert.equal(cfg(w.git, "remote.origin.url"), "/some/where.git");
});

test("manage remotes with none, declined: nothing is added", async () => {
  const w = world({ remote: false });
  reset();
  await actions.manageRemotes(w.repos, w.refresh);
  assert.deepEqual(titles(), ["No remotes configured"]);
  assert.equal(w.git("remote"), "");
});

test("manage remotes lists each remote with its URL, and Add remote… last", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "gitstudio:add-remote"],
    [/^Add remote$/, "second"],
    [/^Add remote second$/, "/x.git"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  const choices = (asked[0] as { choices: { id: string; description?: string }[] }).choices;
  assert.deepEqual(choices.map((c) => c.id), ["origin", "gitstudio:add-remote"]);
  assert.equal(choices[0].description, w.remote);
  assert.equal(cfg(w.git, "remote.second.url"), "/x.git");
});

test("manage remotes → Fetch: brings the remote's new commit in", async () => {
  const w = world();
  const sha = remoteAdvances(w);
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "fetch"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.equal(w.git("rev-parse", "refs/remotes/origin/main"), sha);
  assert.deepEqual(said("status"), ["$(check) Fetched origin"]);
});

test("manage remotes → Prune: drops a remote-tracking branch the server no longer has", async () => {
  const w = world();
  w.git("push", "-q", "origin", "main:refs/heads/doomed");
  w.origin("update-ref", "-d", "refs/heads/doomed");
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "prune"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.ok(!has(w.git, "refs/remotes/origin/doomed"));
  assert.deepEqual(said("status"), ["$(check) Pruned origin"]);
});

test("manage remotes → Edit URL: the box starts on the current URL, and the new one is set", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "url"],
    [/^Edit URL of origin$/, " /new/place.git "],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.equal((asked[2] as { value?: string }).value, w.remote);
  assert.equal(cfg(w.git, "remote.origin.url"), "/new/place.git");
  assert.deepEqual(said("status"), ["$(check) Updated origin URL"]);
});

test("manage remotes → Rename: the remote and its remote-tracking branches take the new name", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "rename"],
    [/^Rename origin$/, "upstream"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.equal(w.git("remote"), "upstream");
  assert.ok(has(w.git, "refs/remotes/upstream/main"));
  assert.deepEqual(said("status"), ["$(check) Renamed remote to upstream"]);
});

test("manage remotes → Rename to the same name, or Edit URL dismissed: nothing changes", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "rename"],
    [/^Rename origin$/, "origin"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "url"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  assert.equal(w.git("remote"), "origin");
  assert.equal(cfg(w.git, "remote.origin.url"), w.remote);
  assert.equal(w.refreshed(), 0);
});

test("manage remotes → Remove: confirmed as a danger, then the remote is gone", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "remove"],
    [/^Remove remote origin\?$/, "ok"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  const actionsOffered = (asked[1] as { choices: { id: string; danger?: boolean }[] }).choices;
  assert.deepEqual(actionsOffered.map((c) => c.id), ["fetch", "prune", "url", "rename", "remove"]);
  assert.equal(actionsOffered.find((c) => c.id === "remove")?.danger, true);
  assert.equal(w.git("remote"), "");
  assert.ok(!has(w.git, "refs/remotes/origin/main"));
  assert.deepEqual(said("status"), ["$(check) Removed remote origin"]);
});

test("manage remotes → Remove, declined, or no action picked: the remote stays", async () => {
  const w = world();
  reset([
    [/^Manage remotes$/, "origin"],
    [/^Remote: origin$/, "remove"],
  ]);
  await actions.manageRemotes(w.repos, w.refresh);
  reset([[/^Manage remotes$/, "origin"]]);
  await actions.manageRemotes(w.repos, w.refresh);
  reset();
  await actions.manageRemotes(w.repos, w.refresh);
  assert.equal(w.git("remote"), "origin");
  assert.equal(w.refreshed(), 0);
});

// ── Merge / rebase, asked and declined ───────────────────────────────────────

test("merge: the question names the branch, and a yes merges it with git's own message", async () => {
  const w = world();
  w.git("checkout", "-q", "-b", "side");
  writeFileSync(join(w.dir, "side.txt"), "side\n");
  w.git("add", ".");
  w.git("commit", "-qm", "side work");
  w.git("checkout", "-q", "main");
  w.git("commit", "-q", "--allow-empty", "-m", "main moves on");
  reset([[/^Merge side into the current branch\?$/, "ok"]]);
  await actions.mergeBranchIntoCurrent(w.repos, node("side"), w.refresh);
  assert.equal(w.git("log", "-1", "--format=%s"), "Merge branch 'side'");
  assert.deepEqual(said("status"), ["$(check) Merged side"]);
});

test("merge or rebase, declined: HEAD does not move", async () => {
  const w = world();
  w.git("checkout", "-q", "-b", "side");
  w.git("commit", "-q", "--allow-empty", "-m", "side");
  w.git("checkout", "-q", "main");
  const head = w.git("rev-parse", "HEAD");
  reset();
  await actions.mergeBranchIntoCurrent(w.repos, node("side"), w.refresh);
  await actions.rebaseCurrentOnto(w.repos, node("side"), w.refresh);
  assert.deepEqual(titles(), ["Merge side into the current branch?", "Rebase the current branch onto side?"]);
  assert.equal(w.git("rev-parse", "HEAD"), head);
  assert.equal(w.refreshed(), 0);
});

test("rebase onto a branch: the current branch's commits are replayed on top of it", async () => {
  const w = world();
  w.git("checkout", "-q", "-b", "side");
  writeFileSync(join(w.dir, "side.txt"), "side\n");
  w.git("add", ".");
  w.git("commit", "-qm", "side work");
  w.git("checkout", "-q", "main");
  writeFileSync(join(w.dir, "main.txt"), "main\n");
  w.git("add", ".");
  w.git("commit", "-qm", "main work");
  const side = w.git("rev-parse", "side");
  reset([[/^Rebase the current branch onto side\?$/, "ok"]]);
  await actions.rebaseCurrentOnto(w.repos, node("side"), w.refresh);
  assert.equal(w.git("rev-parse", "HEAD~1"), side);
  assert.equal(w.git("log", "-1", "--format=%s"), "main work");
  assert.deepEqual(said("status"), ["$(check) Rebased onto side"]);
});

test("merging a ref that no longer resolves is an error, not a paused merge", async () => {
  const w = world();
  w.git("branch", "side");
  const tip = w.git("rev-parse", "side");
  reset([
    [
      /^Merge side into/,
      "ok",
    ],
  ]);
  // The branch is listed by its full name; then removed before git runs.
  const ref = { ref: { name: "side", type: "head", sha: tip, fullName: "refs/heads/side" } };
  w.git("branch", "-D", "side");
  await actions.mergeBranchIntoCurrent(w.repos, ref, w.refresh);
  assert.match(said("error")[0] ?? "", /^GitStudio: Merge failed/);
  assert.deepEqual(said("warning"), []);
});

// ── Checkout over a local branch with commits of its own (#32) ───────────────

/** origin/feature, and a local feature two commits ahead of it, not checked out. */
function localAhead(w: World): { remoteTip: string; localTip: string } {
  w.git("push", "-q", "origin", "main:refs/heads/feature");
  w.git("fetch", "-q", "origin");
  w.git("branch", "-q", "--track", "feature", "refs/remotes/origin/feature");
  const remoteTip = w.git("rev-parse", "refs/remotes/origin/feature");
  let tip = remoteTip;
  for (const m of ["mine one", "mine two"]) tip = w.git("commit-tree", "HEAD^{tree}", "-p", tip, "-m", m);
  w.git("update-ref", "refs/heads/feature", tip);
  return { remoteTip, localTip: tip };
}

test("check out origin/feature over a local feature with its own commits asks first; backing out changes nothing", async () => {
  const w = world();
  const { localTip } = localAhead(w);
  reset();
  await actions.checkoutRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.deepEqual(titles(), ["Check out 'origin/feature'"]);
  assert.match((asked[0] as { hint?: string }).hint ?? "", /with 2 commits that 'origin\/feature' doesn't have\./);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(w.git("rev-parse", "refs/heads/feature"), localTip);
});

test("check out origin/feature → Switch to local: lands on feature with its commits kept", async () => {
  const w = world();
  const { localTip } = localAhead(w);
  reset([[/^Check out 'origin\/feature'$/, "checkout"]]);
  await actions.checkoutRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature");
  assert.equal(w.git("rev-parse", "HEAD"), localTip);
});

test("check out origin/feature → Reset: feature is made to match origin/feature, then checked out", async () => {
  const w = world();
  const { remoteTip } = localAhead(w);
  reset([
    [/^Check out 'origin\/feature'$/, "reset"],
    [/./, "ok"],
  ]);
  await actions.checkoutRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.equal(asked.length, 2, "the reset asks, saying what would be lost");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature");
  assert.equal(w.git("rev-parse", "HEAD"), remoteTip);
  assert.ok(w.refreshed() >= 1);
});

test("check out origin/feature → Reset, then the reset declined: feature keeps its commits and HEAD stays", async () => {
  const w = world();
  const { localTip } = localAhead(w);
  reset([[/^Check out 'origin\/feature'$/, "reset"]]);
  await actions.checkoutRemoteBranch(w.repos, node("origin/feature", "remote"), w.refresh);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(w.git("rev-parse", "refs/heads/feature"), localTip);
});

test("a branch whose name reads as an option is not checked out, and the refusal says why instead of 'refresh'", async () => {
  const w = world();
  w.git("update-ref", "refs/heads/-f", "HEAD");
  reset();
  await actions.checkoutBranch(w.repos, { ref: { name: "-f", type: "head", sha: "", fullName: "refs/heads/-f" } }, w.refresh);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  const warnings = said("warning");
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /refresh/);
  assert.deepEqual(said("error"), []);
});
