// Removing a worktree from the desktop's Branches ▸ Worktrees, through the REAL
// bridge against real git — the sibling of the extension's Worktrees view
// (apps/extension/test/worktreesDoors.test.ts), which shares the plumbing.
//
// The renderer used to promise "any uncommitted work goes with it", send a
// plain remove, and toast git's refusal: a dirty worktree was never removed,
// a locked one could not be (git wants --force twice), and the main one was
// offered at all. Now what removing takes is read first (worktree:removal)
// and the remove runs as agreed (worktree:remove).

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { GitHubBridge } from "../src/main/githubBridge";
import { reportableResultMessage } from "../src/main/expectedError";

// Made in os.tmpdir()'s own spelling — the 8.3 C:\Users\RUNNER~1\… on a
// Windows runner, /var/… on macOS — so the bridge is asked about a folder in
// another spelling than git's (C:/Users/runneradmin/…, /private/var/…), as a
// tab or a window can ask it, on macOS as on Windows. A path the bridge SAYS
// is in the disk's own spelling, with the system's separators:
// realpathSync.native.
const scratch = mkdtempSync(join(tmpdir(), "gs-desktop-wt-"));
after(() => removeTempRepo(scratch));
let seq = 0;

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A main worktree and, under wt/: clean, locked (with a reason), dirty, and one whose folder is gone. */
function scene() {
  const base = join(scratch, `s${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  const git = at(app);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  writeFileSync(join(app, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const path = (n: string) => join(base, "wt", n);
  for (const b of ["clean", "locked", "dirty", "gone"]) git("worktree", "add", "-q", "-b", b, path(b));
  git("worktree", "lock", "--reason", "on a USB drive", path("locked"));
  writeFileSync(join(path("dirty"), "new.txt"), "n\n");
  rmSync(path("gone"), { recursive: true, force: true });
  return { app, git, path };
}

async function bridgeOn(dir: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(dir);
  return new GitBridge(repos);
}

test("the list says which worktree is main, which folder is gone, and why one is locked", async () => {
  const s = scene();
  const list = await (await bridgeOn(s.app)).worktreeList();
  const by = (b: string) => list.find((w) => w.branch === b);
  assert.equal(by("main")?.main, true);
  assert.equal(by("clean")?.main, false);
  assert.equal(by("gone")?.missing, true);
  assert.equal(by("clean")?.missing, false);
  assert.equal(by("locked")?.lockReason, "on a USB drive");
  // Shown in the system's spelling — git's C:/Users/runneradmin/… is
  // C:\Users\runneradmin\… on Windows — while `path` stays git's own, to send back.
  assert.equal(by("clean")?.shownPath, realpathSync.native(s.path("clean")));
  assert.equal(by("clean")?.current, false);
  assert.equal(by("main")?.current, true, "this tab's own");
});

test("removal is read before anything is asked: refused for main and this window's own, facts for the rest", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  assert.deepEqual(await bridge.worktreeRemoval({ path: s.app }), { kind: "main" });
  assert.deepEqual(await bridge.worktreeRemoval({ path: join(s.app, "..", "nowhere") }), { kind: "notListed" });
  const locked = await bridge.worktreeRemoval({ path: s.path("locked") });
  assert.equal(locked.kind, "present");
  assert.equal(locked.kind === "present" && locked.lockReason, "on a USB drive");
  const dirty = await bridge.worktreeRemoval({ path: s.path("dirty") });
  assert.deepEqual(dirty.kind === "present" && dirty.changes, ["new.txt"]);
  assert.equal((await bridge.worktreeRemoval({ path: s.path("gone") })).kind, "missing");

  // From inside a linked worktree, that one is this window's.
  const inside = await bridgeOn(s.path("clean"));
  assert.deepEqual(await inside.worktreeRemoval({ path: s.path("clean") }), { kind: "current" });
  const refused = await inside.worktreeRemove({ path: s.path("clean") });
  assert.equal(refused.ok, false);
  assert.ok(existsSync(s.path("clean")), "the window's own folder stays");
});

test("a worktree another repository tab has open is refused too — its folder stays under that tab (#32)", async () => {
  const s = scene();
  // The window has the repository AND its worktree open, as two tabs; the
  // repository's tab is in front, asking to remove the worktree.
  const repos = new RepoStore([]);
  await repos.open(s.app);
  await repos.open(s.path("clean"));
  await repos.open(s.app); // back to the repository's tab
  assert.equal(repos.state().tabs.length, 2, "two tabs");
  const bridge = new GitBridge(repos);
  assert.deepEqual(await bridge.worktreeRemoval({ path: s.path("clean") }), { kind: "openInTab" });
  const refused = await bridge.worktreeRemove({ path: s.path("clean"), pastLock: true, discardChanges: true, listed: [] });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.expected, true, "the user's state, said — never a crash report");
  assert.equal(reportableResultMessage(refused), undefined);
  assert.match(!refused.ok ? (refused.message ?? "") : "", /open in another tab of this window/);
  assert.ok(existsSync(s.path("clean")), "the other tab's folder stays");
  // A worktree no tab has open is still the facts, as before.
  assert.equal((await bridge.worktreeRemoval({ path: s.path("locked") })).kind, "present");
});

test("the list marks the worktree another tab has open by main's own comparison, however that tab spells it (#32)", async () => {
  const s = scene();
  // The worktree's tab was opened through a symlink, and kept that spelling:
  // its root is not git's path as text (the renderer compared them as text,
  // and the row lost its "open in a tab" while its Remove was refused).
  const link = join(s.app, "..", "tab-link-to-clean");
  symlinkSync(s.path("clean"), link);
  const repos = new RepoStore([], { discover: async (cwd) => cwd });
  await repos.open(s.app);
  await repos.open(link);
  await repos.open(s.app); // back to the repository's tab
  const bridge = new GitBridge(repos);
  const list = await bridge.worktreeList();
  const by = (b: string) => list.find((w) => w.branch === b);
  assert.ok(
    repos.state().tabs.some((t) => t.root === link) && by("clean")?.path !== link,
    "precondition: the tab's root and git's path are two spellings",
  );
  assert.equal(by("clean")?.openInTab, true, "the worktree the other tab has open");
  assert.deepEqual(await bridge.worktreeRemoval({ path: by("clean")!.path }), { kind: "openInTab" }, "…and its Remove is refused by the same comparison");
  assert.equal(by("main")?.openInTab, false, "this tab's own is `current`, not another's");
  assert.equal(by("main")?.current, true);
  assert.equal(by("locked")?.openInTab, false, "a worktree no tab has open");
  assert.equal(by("gone")?.openInTab, false, "a gone folder is nobody's to lose");

  // The tab closed: asked again, the list says so.
  assert.equal(repos.closeTab(link), true);
  assert.equal((await bridge.worktreeList()).find((w) => w.branch === "clean")?.openInTab, false);
});

test("a worktree whose folder is gone can be forgotten while its (gone) tab is still open (#32)", async () => {
  const s = scene();
  // The worktree open as a tab of its own, then its folder deleted on disk:
  // the tab stays, struck through. There is no folder to delete from under
  // it, so the tab is no reason to refuse — and "Forget that worktree in
  // Worktrees" is what the words for a branch held by it say to do.
  const repos = new RepoStore([]);
  await repos.open(s.app);
  await repos.open(s.path("clean"));
  await repos.open(s.app);
  rmSync(s.path("clean"), { recursive: true, force: true });
  const bridge = new GitBridge(repos);
  assert.equal((await bridge.worktreeRemoval({ path: s.path("clean") })).kind, "missing");
  const r = await bridge.worktreeRemove({ path: s.path("clean") });
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.doesNotMatch(s.git("worktree", "list"), /clean/, "git no longer lists it");
  assert.equal(repos.state().tabs.length, 2, "its tab is still there, gone");
});

test("removal names a merge stopped in that worktree", async () => {
  const s = scene();
  const clean = s.path("clean");
  const c = at(clean);
  writeFileSync(join(clean, "a.txt"), "clean\n");
  c("commit", "-qam", "clean change");
  writeFileSync(join(s.app, "a.txt"), "main\n");
  s.git("commit", "-qam", "main change");
  assert.throws(() => c("merge", "main"));
  const r = await (await bridgeOn(s.app)).worktreeRemoval({ path: clean });
  assert.equal(r.kind === "present" && r.operation, "merge");
});

test("a locked worktree goes when removing it past the lock was agreed", async () => {
  const s = scene();
  const r = await (await bridgeOn(s.app)).worktreeRemove({ path: s.path("locked"), pastLock: true });
  assert.ok(r.ok, r.message);
  assert.equal(existsSync(s.path("locked")), false);
  assert.equal(s.git("branch", "--list", "locked"), "locked", "the branch stays");
});

test("a dirty worktree goes when its changes were agreed to — and is refused, intact, when they were not", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  const kept = await bridge.worktreeRemove({ path: s.path("dirty") });
  assert.equal(kept.ok, false);
  assert.ok(existsSync(join(s.path("dirty"), "new.txt")));
  const r = await bridge.worktreeRemove({ path: s.path("dirty"), discardChanges: true });
  assert.ok(r.ok, r.message);
  assert.equal(existsSync(s.path("dirty")), false);
});

test("a change made while the question was open: nothing is deleted, the lock goes back, and the fresh facts come back to ask again — not a crash report", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  // Clean and locked when asked (an agent's worktree between writes).
  const plan = await bridge.worktreeRemoval({ path: s.path("locked") });
  assert.deepEqual(plan.kind === "present" && plan.changes, []);
  writeFileSync(join(s.path("locked"), "agent.txt"), "work\n");
  const r = await bridge.worktreeRemove({ path: s.path("locked"), discardChanges: false, pastLock: true });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "the person's state, not a failure");
  assert.equal(reportableResultMessage(r), undefined, "never filed as a crash report");
  assert.doesNotMatch(r.message ?? "", /fatal|--force/, "not git's words");
  const now = r.changedSince;
  assert.equal(now?.kind, "present", "the facts it holds now, for the question asked again");
  assert.deepEqual(now?.kind === "present" && now.changes, ["agent.txt"]);
  assert.equal(now?.kind === "present" && now.lockReason, "on a USB drive");
  assert.ok(existsSync(join(s.path("locked"), "agent.txt")), "nothing deleted");
  assert.match(s.git("worktree", "list", "--porcelain"), /locked on a USB drive/, "locked again, with its reason");
});

test("dirty when asked: a file the question never listed stops the discard — nothing runs, and the fresh facts come back", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  const plan = await bridge.worktreeRemoval({ path: s.path("dirty") });
  const listed = plan.kind === "present" ? plan.changes : undefined;
  assert.deepEqual(listed, ["new.txt"]);
  writeFileSync(join(s.path("dirty"), "written-while-asking.txt"), "agent output\n");
  const r = await bridge.worktreeRemove({ path: s.path("dirty"), discardChanges: true, listed });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.equal(reportableResultMessage(r), undefined);
  assert.deepEqual(r.changedSince?.kind === "present" && [...(r.changedSince.changes ?? [])].sort(), ["new.txt", "written-while-asking.txt"]);
  assert.ok(existsSync(join(s.path("dirty"), "written-while-asking.txt")), "the file nobody was told of is still there");

  // Asked again with all of it listed, it goes.
  const again = await bridge.worktreeRemove({
    path: s.path("dirty"),
    discardChanges: true,
    listed: r.changedSince?.kind === "present" ? r.changedSince.changes : undefined,
  });
  assert.ok(again.ok, again.message);
  assert.equal(existsSync(s.path("dirty")), false);
});

test("a worktree whose folder is gone is forgotten", async () => {
  const s = scene();
  const r = await (await bridgeOn(s.app)).worktreeRemove({ path: s.path("gone") });
  assert.ok(r.ok, r.message);
  assert.ok(!s.git("worktree", "list", "--porcelain").includes("refs/heads/gone"));
});

test("opened through a symlink, the window's own worktree is still the current one — and still refused", async () => {
  const s = scene();
  const link = join(s.app, "..", "link-to-clean");
  symlinkSync(s.path("clean"), link);
  const bridge = await bridgeOn(link);
  const list = await bridge.worktreeList();
  assert.deepEqual(
    list.filter((w) => w.current).map((w) => w.branch),
    ["clean"],
    "exactly one current row, the worktree the window has open",
  );
  assert.deepEqual(await bridge.worktreeRemoval({ path: s.path("clean") }), { kind: "current" });
});

// ── A branch another worktree has checked out ───────────────────────────────
// git refuses to check it out a second time or to delete it, in its own words
// ("already used by worktree at …", "cannot delete branch … used by worktree
// at …"). The bridge says where it is, in words, and runs nothing.

test("checking out a branch another worktree has says where it is, and runs nothing", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  const sha = s.git("rev-parse", "HEAD");
  const r = await bridge.commitAction({ action: "checkout-ref", sha, name: "clean", fullName: "refs/heads/clean" });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "the person's state, not a failure to report");
  assert.equal(
    r.message,
    `'clean' is checked out in the worktree at ${realpathSync.native(s.path("clean"))}, and a branch can be checked out in only one worktree at a time. Work on it there, or create a new branch from it here.`,
  );
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");
});

test("checking out a pull request whose pr/<n> another worktree has says where it is, and fetches nothing", async () => {
  const s = scene();
  // An origin with GitHub's pull/7/head, and pr/7 checked out in a worktree
  // (a previous checkout, moved there).
  const origin = join(s.app, "..", "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", s.app, origin]);
  at(origin)("update-ref", "refs/pull/7/head", s.git("rev-parse", "HEAD"));
  s.git("remote", "add", "origin", origin);
  s.git("worktree", "add", "-q", "-b", "pr/7", s.path("pr7"));
  const before = s.git("rev-parse", "refs/heads/pr/7");
  const repos = new RepoStore([]);
  await repos.open(s.app);
  const r = await new GitHubBridge(repos).prCheckout(7);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "the person's state, not a failure");
  assert.equal(reportableResultMessage(r), undefined, "never filed as a crash report");
  assert.equal(
    r.message,
    `'pr/7' is checked out in the worktree at ${realpathSync.native(s.path("pr7"))}, and a branch can be checked out in only one worktree at a time. Work on it there, or create a new branch from it here.`,
  );
  assert.equal(s.git("rev-parse", "refs/heads/pr/7"), before);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");

  // Its folder gone, it says to forget that worktree first.
  rmSync(s.path("pr7"), { recursive: true, force: true });
  const gone = await new GitHubBridge(repos).prCheckout(7);
  assert.equal(gone.expected, true);
  assert.match(gone.message ?? "", /whose folder is gone — git still keeps the branch for it\. Forget that worktree in Worktrees, then check it out\./);
});

test("deleting a branch another worktree has says where it is, and the branch stays", async () => {
  const s = scene();
  const r = await (await bridgeOn(s.app)).branchDelete({ fullName: "refs/heads/clean", force: true });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.match(r.message ?? "", /^'clean' is checked out in the worktree at .*, so it can't be deleted\./);
  assert.equal(s.git("branch", "--list", "clean"), "+ clean");

  // The worktree whose folder is gone still holds `gone`: forget it first.
  const g = await (await bridgeOn(s.app)).branchDelete({ fullName: "refs/heads/gone" });
  assert.equal(g.ok, false);
  assert.match(g.message ?? "", /whose folder is gone — git still keeps the branch for it\. Forget that worktree in Worktrees, then delete it\./);
});
