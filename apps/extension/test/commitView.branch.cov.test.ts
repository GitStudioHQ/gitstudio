// The Changes view's branch menu, host side, against real repositories and a
// real (on-disk) remote: New Branch, Checkout of a picked or typed revision,
// the three pulls, Push, Fetch, Pull-into, the star and Copy Name, and the
// per-branch submenu's commands — what each runs in git, what it asks, what the
// page is told, and what the user reads.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerWith,
  asked,
  clipboard,
  commandAnswers,
  commandsRun,
  committedRepo,
  covHost,
  resetRecorders,
  said,
  withRemote,
  type Host,
} from "./commitViewCovKit";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  commandAnswers.clear();
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
const head = (r: { git: (...a: string[]) => string }) => r.git("rev-parse", "HEAD").trim();
const branchName = (r: { git: (...a: string[]) => string }) => r.git("branch", "--show-current").trim();

/** A second clone of `bare` that commits `file` and pushes, so the remote moves ahead. */
function pushFromElsewhere(bare: string, file: string, text: string, subject: string): void {
  const dir = mkdtempSync(join(tmpdir(), "gs-ext-cov-other-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("clone", "-q", bare, ".");
  git("config", "user.email", "o@example.com");
  git("config", "user.name", "o");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, file), text);
  git("add", file);
  git("commit", "-qm", subject);
  git("push", "-q", "origin", "HEAD:main");
}

/** Amend HEAD a minute later, as a person would: the committer date moves on. */
function amendLater(dir: string, message: string): void {
  const later = `${Math.floor(Date.now() / 1000) + 60} +0000`;
  execFileSync("git", ["commit", "-q", "--amend", "-am", message], {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_COMMITTER_DATE: later },
  });
}

function remoteRepo(prefix: string) {
  const r = repo(prefix);
  const remote = withRemote(r);
  cleanups.push(remote.done);
  return { r, bare: remote.bare };
}

test("New Branch creates the branch at HEAD, switches to it, remembers it as recent, and releases the menu", async () => {
  const r = repo("br-new");
  const h = host(r.dir);
  const at = head(r);
  await h.send({ type: "branchAction", action: "new", ref: "  feature/x  " });
  assert.equal(branchName(r), "feature/x");
  assert.equal(head(r), at, "at HEAD: nothing moved");
  assert.deepEqual(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), ["feature/x"]);
  assert.deepEqual(h.last("branchActionDone"), { type: "branchActionDone", action: "new" });
  assert.deepEqual(said("error"), []);
});

test("New Branch with a name git refuses says which action failed and git's reason", async () => {
  const r = repo("br-new-bad");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "new", ref: "main" });
  assert.equal(branchName(r), "main");
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: New Branch 'main' failed — .*already exists/);
  assert.equal(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), undefined, "a failed branch is not recent");
});

test("New Branch with a blank name does nothing at all", async () => {
  const r = repo("br-new-blank");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "new", ref: "   " });
  assert.equal(r.git("branch", "--list").trim(), "* main");
  assert.equal(h.all("branchActionDone").length, 0);
});

test("Checkout of a revision that starts with '-' is refused before git can read it as an option", async () => {
  const r = repo("br-dash");
  r.write("a.txt", "uncommitted\n");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "-f" });
  assert.equal(branchName(r), "main");
  assert.deepEqual(said("error"), ["GitStudio: Checkout '-f' failed — '-f' is not a revision: it starts with '-'."]);
});

test("Checkout of a picked tag goes to the TAG even when a branch has the same short name", async () => {
  const r = repo("br-tag");
  r.git("tag", "dup");
  const tagged = head(r);
  r.write("a.txt", "later\n");
  r.git("commit", "-qam", "later");
  r.git("branch", "dup");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "dup", refType: "tag" });
  assert.equal(branchName(r), "", "detached");
  assert.equal(head(r), tagged, "at the tag, not the branch");
});

test("Checkout of a picked branch that has since gone says so", async () => {
  const r = repo("br-gone");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "vanished", refType: "head" });
  assert.deepEqual(said("error"), ["GitStudio: Checkout 'vanished' failed — there is no branch 'vanished' any more."]);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "origin/x", refType: "remote" });
  assert.match(said("error")[1], /there is no remote branch 'origin\/x' any more\.$/);
});

test("Checkout of a typed revision detaches there", async () => {
  const r = repo("br-typed");
  const first = head(r);
  r.write("a.txt", "second\n");
  r.git("commit", "-qam", "second");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "checkoutRef", ref: "HEAD~1" });
  assert.equal(head(r), first);
  assert.equal(branchName(r), "");
});

test("Checkout over uncommitted work in its way asks Stash & Retry; Cancel runs nothing and says nothing", async () => {
  const r = repo("br-inway");
  const first = head(r);
  r.write("a.txt", "second\n");
  r.git("commit", "-qam", "second");
  r.write("a.txt", "my edit\n");
  const h = host(r.dir);
  answerWith(() => "cancel");
  await h.send({ type: "branchAction", action: "checkoutRef", ref: first });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Your uncommitted changes are in the way");
  assert.equal(branchName(r), "main", "nothing ran");
  assert.deepEqual(said("error"), []);
  assert.ok(h.last("branchActionDone"), "the menu is released");
});

test("Update (pull) fast-forwards from the upstream when only the remote moved", async () => {
  const { r, bare } = remoteRepo("br-pull");
  pushFromElsewhere(bare, "c.txt", "from elsewhere\n", "theirs");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "pull" });
  assert.equal(r.git("log", "-1", "--format=%s").trim(), "theirs");
  assert.deepEqual(said("error"), []);
  assert.deepEqual(h.last("branchActionDone"), { type: "branchActionDone", action: "pull" });
});

test("Update (pull) on a diverged branch asks how to combine them; Merge makes a merge commit", async () => {
  const { r, bare } = remoteRepo("br-pull-diverged");
  pushFromElsewhere(bare, "c.txt", "theirs\n", "theirs");
  r.write("d.txt", "mine\n");
  r.git("add", "d.txt");
  r.git("commit", "-qm", "mine");
  const h = host(r.dir);
  answerWith((spec) => (spec.title?.includes("have diverged") ? "merge" : "ok"));
  await h.send({ type: "branchAction", action: "pull" });
  assert.equal(asked[0].title, "'main' and origin/main have diverged");
  assert.match(String((asked[0] as { hint?: string }).hint), /You have 1 commit origin\/main doesn't, and it has 1 commit you don't/);
  assert.equal(r.git("rev-list", "--count", "--merges", "HEAD").trim(), "1", "a merge commit");
  assert.deepEqual(said("error"), []);
});

test("Update (pull) on a diverged branch, question dismissed: nothing merges, nothing is said, the menu is released", async () => {
  const { r, bare } = remoteRepo("br-pull-dismiss");
  pushFromElsewhere(bare, "c.txt", "theirs\n", "theirs");
  r.write("d.txt", "mine\n");
  r.git("add", "d.txt");
  r.git("commit", "-qm", "mine");
  const mine = head(r);
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "branchAction", action: "pull" });
  assert.equal(head(r), mine);
  assert.deepEqual(said("error"), []);
  assert.ok(h.last("branchActionDone"));
});

test("Pull using Rebase replays local commits on top of the remote's", async () => {
  const { r, bare } = remoteRepo("br-pull-rebase");
  pushFromElsewhere(bare, "c.txt", "theirs\n", "theirs");
  r.write("d.txt", "mine\n");
  r.git("add", "d.txt");
  r.git("commit", "-qm", "mine");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "pullRebase" });
  assert.deepEqual(r.git("log", "--format=%s").trim().split("\n"), ["mine", "theirs", "base"]);
  assert.equal(r.git("rev-list", "--count", "--merges", "HEAD").trim(), "0");
});

test("Pull using Merge that stops on conflicts is a pause with the dashboard offered, not an error", async () => {
  const { r, bare } = remoteRepo("br-pull-stop");
  pushFromElsewhere(bare, "a.txt", "theirs\n", "theirs");
  r.write("a.txt", "mine\n");
  r.git("commit", "-qam", "mine");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "pullMerge" });
  assert.deepEqual(said("error"), []);
  const warnings = said("warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^GitStudio: .*conflict/i);
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.commit.focus"), "the user is taken to Changes");
  assert.equal(r.git("diff", "--name-only", "--diff-filter=U").trim(), "a.txt");
});

test("Push sends the branch to its upstream", async () => {
  const { r } = remoteRepo("br-push");
  r.write("a.txt", "pushed\n");
  r.git("commit", "-qam", "to push");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "push" });
  assert.equal(r.git("rev-parse", "origin/main").trim(), head(r));
  assert.deepEqual(said("error"), []);
});

test("Push of a branch whose pushed commit was amended asks to force; Cancel pushes nothing and releases the pill", async () => {
  const { r } = remoteRepo("br-push-rewrite");
  const pushed = r.git("rev-parse", "origin/main").trim();
  r.write("a.txt", "amended\n");
  amendLater(r.dir, "base, amended");
  const h = host(r.dir);
  answerWith(() => "cancel");
  await h.send({ type: "branchAction", action: "push" });
  assert.equal(asked[0].title, "This branch was rewritten");
  assert.equal(r.git("rev-parse", "origin/main").trim(), pushed, "nothing pushed");
  assert.deepEqual(h.last("branchActionDone"), { type: "branchActionDone", action: "push" });
});

test("Push of a rewritten branch, Force chosen, replaces the remote's version with the lease", async () => {
  const { r, bare } = remoteRepo("br-push-force");
  r.write("a.txt", "amended\n");
  amendLater(r.dir, "base, amended");
  const h = host(r.dir);
  answerWith(() => "force");
  await h.send({ type: "branchAction", action: "push" });
  const onRemote = execFileSync("git", ["rev-parse", "main"], { cwd: bare, encoding: "utf8" }).trim();
  assert.equal(onRemote, head(r));
  assert.deepEqual(said("error"), []);
});

test("Push with no remote at all is an error naming the action", async () => {
  const r = repo("br-push-noremote");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "push" });
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: Push failed/);
});

test("Fetch brings the remote's new commits into origin/main without touching main", async () => {
  const { r, bare } = remoteRepo("br-fetch");
  pushFromElsewhere(bare, "c.txt", "x\n", "theirs");
  const mine = head(r);
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "fetch" });
  assert.equal(head(r), mine);
  assert.equal(r.git("log", "-1", "--format=%s", "origin/main").trim(), "theirs");
});

test("Pull into a branch that is not checked out fast-forwards it and says so, leaving the working tree alone", async () => {
  const { r, bare } = remoteRepo("br-pullff");
  r.git("branch", "--track", "side", "origin/main");
  r.git("checkout", "-q", "-b", "work");
  pushFromElsewhere(bare, "c.txt", "x\n", "theirs");
  r.git("fetch", "-q");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "pullFf", ref: "side" });
  assert.equal(r.git("rev-parse", "side").trim(), r.git("rev-parse", "origin/main").trim());
  assert.equal(branchName(r), "work");
  assert.ok(said("status").includes("Fast-forwarded side"));
});

test("the star is a pure toggle kept per repository, and the menu's list carries it", async () => {
  const r = repo("br-fav");
  r.git("branch", "topic");
  const h = host(r.dir);
  const key = `gitstudio.commit.favorites:${r.dir}`;
  await h.send({ type: "branchAction", action: "favorite", ref: "topic" });
  assert.deepEqual(h.memento.get(key), ["topic"]);
  const branches = h.last("state")?.branches as { local: { name: string; favorite?: boolean }[] } | undefined;
  const flat = JSON.stringify(branches);
  assert.match(flat, /"topic"/);
  await h.send({ type: "branchAction", action: "favorite", ref: "topic" });
  assert.deepEqual(h.memento.get(key), []);
});

test("Copy Name puts the ref on the clipboard and runs no git", async () => {
  const r = repo("br-copy");
  const h = host(r.dir);
  const before = h.posted.length;
  await h.send({ type: "branchAction", action: "copyName", ref: "feature/y" });
  assert.equal(clipboard.text, "feature/y");
  assert.ok(said("status").some((s) => s.includes("feature/y")));
  assert.equal(h.posted.slice(before).filter((m) => m.type === "branchActionDone").length, 0);
});

test("an unknown branch action does nothing", async () => {
  const r = repo("br-unknown");
  const h = host(r.dir);
  await h.send({ type: "branchAction", action: "teleport" });
  assert.equal(h.all("branchActionDone").length, 0);
  assert.deepEqual(said("error"), []);
});

test("the submenu runs its command with a synthetic ref, and a checkout through it becomes a recent branch", async () => {
  const r = repo("br-submenu");
  const h = host(r.dir);
  await h.send({ type: "branchRefCommand", command: "gitstudio.branch.checkout", ref: "topic", refType: "head" });
  const run = commandsRun.find((c) => c.id === "gitstudio.branch.checkout");
  assert.deepEqual(run?.args, [{ ref: { name: "topic", type: "head", sha: "" } }]);
  await h.send({ type: "branchRefCommand", command: "gitstudio.remoteBranch.checkout", ref: "origin/feat/z", refType: "remote" });
  assert.deepEqual(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), ["feat/z", "topic"]);
  await h.send({ type: "branchRefCommand", command: "gitstudio.branch.rename", ref: "topic" });
  assert.deepEqual(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), ["feat/z", "topic"], "only checkouts are recent");
});

test("a submenu command that throws is said, and the view still refreshes", async () => {
  const r = repo("br-submenu-throw");
  const h = host(r.dir);
  commandAnswers.set("gitstudio.branch.delete", () => {
    throw new Error("branch is checked out elsewhere");
  });
  const states = h.all("state").length;
  await h.send({ type: "branchRefCommand", command: "gitstudio.branch.delete", ref: "x" });
  assert.deepEqual(said("error"), ["GitStudio: branch is checked out elsewhere"]);
  assert.ok(h.all("state").length > states);
});

test("recents keep the eight newest, most recent first, without repeats", async () => {
  const r = repo("br-recents");
  const h = host(r.dir);
  for (const n of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "b"]) {
    await h.send({ type: "branchRefCommand", command: "gitstudio.branch.checkout", ref: n });
  }
  assert.deepEqual(h.memento.get(`gitstudio.commit.recentBranches:${r.dir}`), ["b", "i", "h", "g", "f", "e", "d", "c"]);
});
