// The graph's one-commit menu (runCommitAction) and the several-commit menu's
// refusals (runMultiCommitAction), through the REAL doors against real
// repositories: what each item asks, what git then says, and what the user is
// told. The arms dropCommit / multiCommitActions / refCheckout already pin are
// not repeated; this is the rest — checkout's choices, detach, branch/tag,
// revert of a merge, reset's three modes, copy, and the refusals.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kit from "./graphPanel.kit";
import { GitContext } from "@gitstudio/git-service/GitContext";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { runCommitAction, runMultiCommitAction, commitActionItems, refMenuItems, commitMenuItemsFor } =
  require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");

const live: { dispose(): void }[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
  kit.resetRecords();
});

function repo(): kit.Repo {
  const r = kit.mkRepo();
  live.push(r);
  return r;
}
const head = (r: kit.Repo) => r.git("rev-parse", "HEAD");
const branch = (r: kit.Repo) => r.git("rev-parse", "--abbrev-ref", "HEAD");
const subjects = (r: kit.Repo) => r.git("log", "--format=%s").split("\n");
const ref = (kind: string, fullName: string) => ({ name: fullName.replace(/^refs\/(heads|tags|remotes)\//, ""), fullName, kind });
const status = () => kit.said.filter((s) => s.kind === "status").map((s) => s.text);
const told = (kind: string) => kit.said.filter((s) => s.kind === kind).map((s) => s.text);

// ── The menu as items ────────────────────────────────────────────────────────

test("the quick-pick flavour of the menu lists the same actions, in the same order", () => {
  const items = commitActionItems();
  assert.deepEqual(
    items.map((i) => i.id),
    ["checkout", "detach", "branch", "tag", "cherryPick", "revert", "reset", "interactiveRebase", "", "copySha", "copyMessage"],
  );
  assert.match(items[0].label, /^\$\(git-commit\) Checkout Commit$/);
});

test("per-ref items: every branch but the current one, remote branches without an ellipsis, tags with one", () => {
  const items = refMenuItems([
    ref("currentHead", "refs/heads/main"),
    ref("head", "refs/heads/feature"),
    ref("remoteHead", "refs/remotes/origin/feature"),
    ref("tag", "refs/tags/v1"),
  ] as never);
  assert.deepEqual(
    items.map((i) => [i.id, i.label]),
    [
      ["ref:refs/heads/feature", "Checkout feature"],
      ["ref:refs/remotes/origin/feature", "Checkout origin/feature"],
      ["ref:refs/tags/v1", "Checkout v1…"],
      ["", ""],
    ],
  );
  assert.deepEqual(refMenuItems([ref("currentHead", "refs/heads/main")] as never), [], "no refs to offer: no separator either");
});

test("the menu leaves Drop out for a commit git cannot drop — the branch's only one, or one off HEAD's line", async () => {
  const r = repo();
  const only = r.commit("only");
  const ids = async (sha: string) => (await commitMenuItemsFor(r.ctx as never, sha)).map((i) => i.id);
  assert.ok(!(await ids(only)).includes("drop"), "the branch's only commit");
  r.git("checkout", "-q", "-b", "side");
  const s1 = r.commit("s1");
  r.git("checkout", "-q", "main");
  r.commit("m1");
  assert.ok(!(await ids(s1)).includes("drop"), "not on HEAD's line");
  assert.ok((await ids("not-a-sha")).includes("checkout"), "an unreadable commit still gets a menu");
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test("Copy SHA and Copy Message copy exactly that, change nothing, and say so", async () => {
  const r = repo();
  const sha = r.commit("the subject");
  assert.equal(await runCommitAction("copySha", r.ctx as never, { sha, subject: "the subject" }), false);
  assert.equal(kit.clip.text, sha);
  assert.equal(await runCommitAction("copyMessage", r.ctx as never, { sha, subject: "the subject" }), false);
  assert.equal(kit.clip.text, "the subject");
  assert.deepEqual(status(), [`$(check) Copied ${sha.slice(0, 7)}`, "$(check) Copied commit message"]);
  assert.equal(await runCommitAction("no-such-item", r.ctx as never, { sha, subject: "" }), false);
});

// ── Checkout Commit ──────────────────────────────────────────────────────────

test("Checkout Commit on the branch you are on says so and runs nothing", async () => {
  const r = repo();
  const sha = r.commit("a");
  const changed = await runCommitAction("checkout", r.ctx as never, { sha, subject: "a", refs: [ref("currentHead", "refs/heads/main")] as never });
  assert.equal(changed, false);
  assert.deepEqual(status(), ["$(check) Already on main"]);
  assert.equal(kit.asked.length, 0);
});

test("Checkout Commit on a branch tip offers that branch or a detached HEAD — and the branch is what it switches to", async () => {
  const r = repo();
  const a = r.commit("a");
  r.git("branch", "feature");
  r.commit("b");
  const refs = [ref("head", "refs/heads/feature")] as never;
  kit.dialog.pick = undefined;
  assert.equal(await runCommitAction("checkout", r.ctx as never, { sha: a, subject: "a", refs }), false, "cancelled");
  assert.equal(branch(r), "main");
  assert.equal(kit.asked[0].title, `Check out ${a.slice(0, 7)}`);
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.label), ["Switch to feature", "Detach HEAD here"]);

  kit.dialog.pick = "feature";
  assert.equal(await runCommitAction("checkout", r.ctx as never, { sha: a, subject: "a", refs }), true);
  assert.equal(branch(r), "feature");
});

test("Checkout Commit with several branches on it: the picked one; Detach HEAD here detaches", async () => {
  const r = repo();
  const a = r.commit("a");
  r.git("branch", "one");
  r.git("branch", "two");
  r.commit("b");
  const refs = [ref("head", "refs/heads/one"), ref("head", "refs/heads/two")] as never;
  kit.dialog.pick = (q) => q.choices!.find((c) => c.label === "Detach HEAD here")!.id;
  assert.equal(await runCommitAction("checkout", r.ctx as never, { sha: a, subject: "a", refs }), true);
  assert.equal(branch(r), "HEAD", "detached");
  assert.equal(head(r), a);
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.label), ["Switch to one", "Switch to two", "Detach HEAD here"]);
});

test("a branch picked that is no longer on the commit is refused with a way forward", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  kit.dialog.pick = "ghost";
  // The menu's refs say "ghost" is here; the id the dialog returns names a
  // branch that is not among them any more.
  const changed = await runCommitAction("checkout", r.ctx as never, {
    sha: a,
    subject: "a",
    refs: [ref("head", "refs/heads/other"), ref("head", "refs/heads/more")] as never,
  });
  assert.equal(changed, false);
  assert.deepEqual(told("error"), ["GitStudio: ghost is not a branch on this commit any more — refresh and try again."]);
});

test("Checkout Commit with no branch on it detaches after asking; No leaves HEAD alone", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  kit.dialog.confirm = false;
  assert.equal(await runCommitAction("checkout", r.ctx as never, { sha: a, subject: "a", refs: [] }), false);
  assert.equal(branch(r), "main");
  assert.equal(kit.asked[0].title, `Check out ${a.slice(0, 7)}?`);
  assert.match(kit.asked[0].text, /detached HEAD/);
  kit.dialog.confirm = true;
  assert.equal(await runCommitAction("detach", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(head(r), a);
  assert.deepEqual(status(), ["$(check) Checked out"]);
});

test("a checkout git refuses over an unresolved conflict is a warning in the conflict's words, not a crash", async () => {
  const r = repo();
  const base = r.commit("base", "f.txt", "a\n");
  r.git("checkout", "-q", "-b", "side");
  r.commit("s", "f.txt", "side\n");
  r.git("checkout", "-q", "main");
  r.commit("m", "f.txt", "main\n");
  assert.throws(() => r.git("merge", "side"));
  const changed = await runCommitAction("detach", r.ctx as never, { sha: base, subject: "base" });
  assert.equal(changed, true);
  assert.equal(told("error").length, 0, "not shown as a failure");
  const warn = told("warning");
  assert.equal(warn.length, 1);
  assert.match(warn[0], /conflict/i);
});

// ── Refs by full name ────────────────────────────────────────────────────────

test("Checkout <tag> asks first (it detaches); Cancel does nothing, Checkout lands on the tag", async () => {
  const r = repo();
  const a = r.commit("a");
  r.git("tag", "v1");
  r.commit("b");
  kit.dialog.confirm = false;
  assert.equal(await runCommitAction("ref:refs/tags/v1", r.ctx as never, { sha: a, subject: "a" }), false);
  assert.equal(branch(r), "main");
  assert.equal(kit.asked[0].title, "Check out tag v1?");
  kit.dialog.confirm = true;
  assert.equal(await runCommitAction("ref:refs/tags/v1", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(head(r), a);
  assert.equal(branch(r), "HEAD");
});

test("a ref outside the branch, remote and tag namespaces checks nothing out, silently", async () => {
  const r = repo();
  const a = r.commit("a");
  assert.equal(await runCommitAction("ref:HEAD", r.ctx as never, { sha: a, subject: "a" }), false);
  assert.equal(branch(r), "main");
  assert.equal(kit.said.length, 0);
});

test("a branch deleted since the menu opened: git's refusal is shown, and HEAD stays", async () => {
  const r = repo();
  const a = r.commit("a");
  assert.equal(await runCommitAction("ref:refs/heads/vanished", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(branch(r), "main");
  const errors = told("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: Checkout failed/);
  assert.match(errors[0], /vanished/);
});

/** A clone whose local main has one commit origin/main does not. */
function aheadOfOrigin() {
  const up = repo();
  up.commit("up");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gs-graphkit-clone-")));
  execFileSync("git", ["clone", "-q", up.dir, dir]);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "mine");
  const ctx = new GitContext({ root: dir });
  live.push({ dispose: () => (ctx.dispose(), rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })) });
  return { dir, git, ctx, origin: git("rev-parse", "origin/main") };
}

test("Checkout origin/main over a local main with its own commit asks; Cancel keeps both as they are", async () => {
  const c = aheadOfOrigin();
  const mine = c.git("rev-parse", "HEAD");
  kit.dialog.pick = undefined;
  assert.equal(await runCommitAction("ref:refs/remotes/origin/main", c.ctx as never, { sha: c.origin, subject: "up" }), false);
  assert.equal(kit.asked[0].title, "Check out 'origin/main'");
  assert.deepEqual(kit.asked[0].choices!.map((x) => x.id), ["checkout", "reset"]);
  assert.equal(c.git("rev-parse", "HEAD"), mine);
});

test("…Reset main to origin/main, declined at its confirmation, changes nothing", async () => {
  const c = aheadOfOrigin();
  const mine = c.git("rev-parse", "HEAD");
  kit.dialog.pick = "reset";
  kit.dialog.confirm = false;
  assert.equal(await runCommitAction("ref:refs/remotes/origin/main", c.ctx as never, { sha: c.origin, subject: "up" }), false);
  assert.equal(c.git("rev-parse", "HEAD"), mine);
});

test("…Reset main to origin/main, confirmed, moves the branch you are on and needs no switch", async () => {
  const c = aheadOfOrigin();
  kit.dialog.pick = "reset";
  kit.dialog.confirm = true;
  assert.equal(await runCommitAction("ref:refs/remotes/origin/main", c.ctx as never, { sha: c.origin, subject: "up" }), true);
  assert.equal(c.git("rev-parse", "HEAD"), c.origin);
  assert.equal(c.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
});

// ── Branch / tag here ────────────────────────────────────────────────────────

test("Create Branch / Tag Here: a cancelled name creates nothing; a name creates it at the commit and you stay put", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  kit.dialog.input = undefined;
  assert.equal(await runCommitAction("branch", r.ctx as never, { sha: a, subject: "a" }), false);
  assert.equal(await runCommitAction("tag", r.ctx as never, { sha: a, subject: "a" }), false);
  assert.equal(r.git("branch", "--list", "topic"), "");
  kit.dialog.input = "topic";
  assert.equal(await runCommitAction("branch", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(r.git("rev-parse", "topic"), a);
  assert.equal(branch(r), "main");
  kit.dialog.input = "rel-1";
  assert.equal(await runCommitAction("tag", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(r.git("rev-parse", "rel-1^{commit}"), a);
  assert.match(kit.asked.at(-1)!.text, /the tag stays local until you push it/);
  assert.deepEqual(status(), ["$(check) Created branch topic", "$(check) Created tag rel-1"]);
});

test("a branch name git refuses is shown with git's reason", async () => {
  const r = repo();
  const a = r.commit("a");
  kit.dialog.input = "main";
  assert.equal(await runCommitAction("branch", r.ctx as never, { sha: a, subject: "a" }), true);
  const errors = told("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Create branch failed/);
  assert.match(errors[0], /already exists/);
});

// ── Revert ───────────────────────────────────────────────────────────────────

/** main: base ← m1 ← merge(side: s1). */
function merged() {
  const r = repo();
  r.commit("base", "base.txt");
  r.git("checkout", "-q", "-b", "side");
  r.commit("s1", "s1.txt");
  r.git("checkout", "-q", "main");
  r.commit("m1", "m1.txt");
  r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  return { r, merge: head(r) };
}

test("reverting a merge asks which side to keep; Cancel reverts nothing", async () => {
  const { r, merge } = merged();
  kit.dialog.pick = undefined;
  assert.equal(await runCommitAction("revert", r.ctx as never, { sha: merge, subject: "merge side" }), false);
  assert.equal(head(r), merge);
  const q = kit.asked[0];
  assert.equal(q.title, `Revert the merge ${merge.slice(0, 7)}`);
  assert.equal(q.text, "A merge has two sides, so git needs to know which one to keep.");
  assert.deepEqual(q.choices!.map((c) => [c.id, c.label]), [
    ["1", "Keep the branch this was merged into"],
    ["2", "Keep the branch that was merged in"],
  ]);
});

test("reverting a merge keeping its first parent takes the merged-in side's changes back out", async () => {
  const { r, merge } = merged();
  kit.dialog.pick = "1";
  assert.equal(await runCommitAction("revert", r.ctx as never, { sha: merge, subject: "merge side" }), true);
  assert.equal(r.git("log", "-1", "--format=%s"), 'Revert "merge side"');
  assert.equal(r.git("ls-files"), "base.txt\nm1.txt");
  assert.deepEqual(status(), [`$(check) Reverted ${merge.slice(0, 7)}`]);
});

test("an octopus merge offers every parent by number", async () => {
  const r = repo();
  r.commit("base", "base.txt");
  for (const b of ["b1", "b2"]) {
    r.git("checkout", "-q", "-b", b, "main");
    r.commit(b, `${b}.txt`);
  }
  r.git("checkout", "-q", "main");
  r.git("merge", "-q", "--no-ff", "-m", "octopus", "b1", "b2");
  kit.dialog.pick = undefined;
  await runCommitAction("revert", r.ctx as never, { sha: head(r), subject: "octopus" });
  assert.equal(kit.asked[0].text, "This merge has 3 parents. Which one should be kept as the mainline?");
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.label), ["Keep parent 1", "Keep parent 2", "Keep parent 3"]);
});

test("reverting a change that is already undone says so, rather than a reasonless failure", async () => {
  const r = repo();
  r.commit("base", "f.txt", "a\n");
  const change = r.commit("change", "f.txt", "b\n");
  r.git("revert", "--no-edit", change);
  const changed = await runCommitAction("revert", r.ctx as never, { sha: change, subject: "change" });
  assert.equal(changed, true);
  assert.deepEqual(told("info"), [`GitStudio: Nothing to revert — ${change.slice(0, 7)} is already undone on this branch.`]);
  assert.equal(told("error").length, 0);
});

test("a revert that conflicts is paused for the user, not reported as a failure", async () => {
  const r = repo();
  r.commit("base", "f.txt", "a\n");
  const change = r.commit("change", "f.txt", "b\n");
  r.commit("later", "f.txt", "c\n");
  assert.equal(await runCommitAction("revert", r.ctx as never, { sha: change, subject: "change" }), true);
  const warn = told("warning");
  assert.equal(warn.length, 1);
  assert.match(warn[0], new RegExp(`Revert of ${change.slice(0, 7)} needs a decision`));
  assert.equal(told("error").length, 0);
  r.git("revert", "--abort");
});

// ── Reset ────────────────────────────────────────────────────────────────────

test("Reset offers Soft, Mixed and Hard; Cancel moves nothing", async () => {
  const r = repo();
  const a = r.commit("a");
  const b = r.commit("b");
  kit.dialog.pick = undefined;
  assert.equal(await runCommitAction("reset", r.ctx as never, { sha: a, subject: "a" }), false);
  assert.equal(head(r), b);
  assert.equal(kit.asked[0].title, `Reset current branch to ${a.slice(0, 7)}`);
  assert.equal(kit.asked[0].text, "a");
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.id), ["--soft", "--mixed", "--hard"]);
});

test("Reset --soft keeps the undone commit's change staged; --mixed keeps it unstaged", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  kit.dialog.pick = "--soft";
  assert.equal(await runCommitAction("reset", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(head(r), a);
  assert.equal(r.git("diff", "--cached", "--name-only"), "b.txt");
  kit.dialog.pick = "--mixed";
  assert.equal(await runCommitAction("reset", r.ctx as never, { sha: a, subject: "a" }), true);
  assert.equal(r.git("diff", "--cached", "--name-only"), "");
  assert.equal(r.git("status", "--porcelain"), "?? b.txt");
  assert.equal(kit.asked.filter((q) => q.kind === "confirm").length, 0, "neither needs a second question");
});

test("Reset --hard asks a second time, saying no copy is kept without Undo; declining keeps the edits", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  r.write("a.txt", "edited\n");
  kit.dialog.pick = "--hard";
  kit.dialog.confirm = false;
  assert.equal(await runCommitAction("reset", r.ctx as never, { sha: a, subject: "a" }), false);
  const q = kit.asked.find((x) => x.kind === "confirm")!;
  assert.equal(q.title, "Discard all uncommitted changes?");
  assert.match(q.text, /git keeps no copy of them, so nothing can bring them back\.$/);
  assert.equal(r.git("status", "--porcelain"), "M a.txt");
});

test("Reset --hard under Undo says Undo can bring the edits back, and runs inside the Undo envelope", async () => {
  const r = repo();
  const a = r.commit("a");
  r.commit("b");
  r.write("a.txt", "edited\n");
  const wrapped: string[] = [];
  const undo = async <T>(label: string, fn: () => Promise<T>) => {
    wrapped.push(label);
    return fn();
  };
  kit.dialog.pick = "--hard";
  kit.dialog.confirm = true;
  assert.equal(await runCommitAction("reset", r.ctx as never, { sha: a, subject: "a" }, undo), true);
  assert.match(kit.asked.find((x) => x.kind === "confirm")!.text, /GitStudio's Undo can put the branch back and bring those edits back with it/);
  assert.deepEqual(wrapped, [`Reset to ${a.slice(0, 7)} (--hard)`]);
  assert.equal(head(r), a);
  assert.equal(r.git("status", "--porcelain"), "");
});

// ── Drop: refusals ───────────────────────────────────────────────────────────

test("Drop over uncommitted changes is refused before anything is asked", async () => {
  const r = repo();
  r.commit("a");
  const b = r.commit("b");
  r.commit("c");
  r.write("a.txt", "dirty\n");
  assert.equal(await runCommitAction("drop", r.ctx as never, { sha: b, subject: "b" }), false);
  assert.equal(kit.asked.length, 0);
  assert.equal(told("warning").length, 1);
  assert.deepEqual(subjects(r), ["c", "b", "a"]);
});

test("Drop with another branch on a replayed commit asks about it; Cancel drops nothing", async () => {
  const r = repo();
  r.commit("a");
  const b = r.commit("b");
  r.commit("c");
  r.git("branch", "keep", "HEAD");
  r.commit("d");
  kit.dialog.pick = "no";
  assert.equal(await runCommitAction("drop", r.ctx as never, { sha: b, subject: "b" }), false);
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.id), ["carry", "only", "no"]);
  assert.deepEqual(subjects(r), ["d", "c", "b", "a"]);
});

// ── Several commits: refusals ────────────────────────────────────────────────

const noCompare = { compare: async () => assert.fail("nothing to compare") };

test("Compare needs exactly two commits; an unknown item does nothing", async () => {
  const r = repo();
  const a = r.commit("a");
  const b = r.commit("b");
  const c = r.commit("c");
  assert.equal(await runMultiCommitAction("compareTwo", r.ctx as never, [c, b, a], noCompare), false);
  assert.deepEqual(told("warning"), ["GitStudio: select exactly two commits to compare them."]);
  assert.equal(await runMultiCommitAction("nope", r.ctx as never, [c, b], noCompare), false);
});

test("Cherry-pick N with a commit git cannot read, or a merge among them, is refused with the reason", async () => {
  const { r, merge } = merged();
  const m1 = r.git("rev-parse", "HEAD^1");
  assert.equal(await runMultiCommitAction("cherryPickMany", r.ctx as never, ["0000000000000000000000000000000000000000", m1], noCompare), false);
  assert.match(told("warning")[0], /could not be read any more/);
  assert.equal(await runMultiCommitAction("revertMany", r.ctx as never, [merge, m1], noCompare), false);
  assert.equal(told("warning")[1], `GitStudio: ${merge.slice(0, 7)} is a merge commit — revert it on its own, where you can choose which side to keep.`);
});

test("Squash N with the message left empty squashes nothing", async () => {
  const r = repo();
  r.commit("a");
  const b = r.commit("b");
  const c = r.commit("c");
  kit.dialog.input = undefined;
  assert.equal(await runMultiCommitAction("squashMany", r.ctx as never, [c, b], noCompare), false);
  assert.equal(kit.asked[0].kind, "input");
  assert.equal(kit.asked[0].value, "b\n\nc", "pre-filled with every message, oldest first");
  assert.deepEqual(subjects(r), ["c", "b", "a"]);
});
