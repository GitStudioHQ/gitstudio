// The push review — the Changes view's Push… dialog — for ANOTHER worktree
// (the Worktrees view's Push…), and its commit rows, which are the shared
// rows the Worktrees view draws: each commit opens to its own files.
//
// Host half against real git with a real remote (test/changesHost.ts); page
// half in a windowless Chrome (test/changesPage.ts). Also the question with a
// checkbox ("Also delete the branch") the Worktrees view asks through this
// view's dialogs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { changesHost, scratchRepo, answerWith, asked } from "./changesHost";
import { ChangesPage, stateMessage } from "./changesPage";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { promptChoose } from "../src/ui/dialogs";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const f of cleanups) await f();
});
const skip = ChangesPage.chrome() ? false : "no windowless Chrome on this machine (set GS_CHROME)";

/** main here, published; a linked worktree on `topic` with two commits not pushed. */
function scene() {
  const repo = scratchRepo("push-wt");
  cleanups.push(repo.done);
  const bare = mkdtempSync(join(tmpdir(), "gs-ext-push-wt-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  writeFileSync(join(repo.dir, "a.txt"), "one\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "one");
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  repo.git("branch", "topic");
  repo.git("push", "-q", "-u", "origin", "refs/heads/topic:refs/heads/topic");
  const topic = mkdtempSync(join(tmpdir(), "gs-ext-push-wt-topic-"));
  execFileSync("git", ["worktree", "add", "-q", "-f", topic, "topic"], { cwd: repo.dir });
  const t = (...a: string[]) => execFileSync("git", a, { cwd: topic, encoding: "utf8" }).trim();
  writeFileSync(join(topic, "t.txt"), "t1\n");
  t("add", ".");
  t("commit", "-qm", "topic one");
  writeFileSync(join(topic, "a.txt"), "changed on topic\n");
  t("commit", "-qam", "topic two");
  return { repo, bare, topic, t };
}

test("the review for another worktree lists THAT worktree's commits, says whose they are, and pushes its branch", async () => {
  const s = scene();
  const host = changesHost(s.repo.dir);
  cleanups.push(host.dispose);
  await host.send({ type: "ready" });
  const ctx = new GitContext({ root: s.topic });
  host.posted.length = 0;
  await host.provider.openPushReview({ entry: { root: s.topic, ctx }, name: "topic-wt", shownPath: "~/topic-wt", release: () => ctx.dispose() });
  const preview = host.posted.find((m) => m.type === "pushPreview") as Record<string, unknown> | undefined;
  assert.ok(preview);
  assert.equal(preview.target, "origin/topic");
  assert.deepEqual((preview.commits as { subject: string }[]).map((c) => c.subject), ["topic two", "topic one"]);
  assert.deepEqual(preview.worktree, { name: "topic-wt", shownPath: "~/topic-wt" });
  assert.equal((preview.commits as { parents: string[] }[])[0].parents.length, 1, "each commit carries its parent, for its own files");

  // One commit's own files.
  const sha = (preview.commits as { sha: string }[])[0].sha;
  host.posted.length = 0;
  await host.send({ type: "pushCommitFiles", sha });
  const files = host.posted.find((m) => m.type === "pushCommitFiles");
  assert.deepEqual(files, { type: "pushCommitFiles", sha, files: [{ path: "a.txt", oldPath: undefined, status: "M", additions: 1, deletions: 1 }] });
  // A commit git can't read (gone since the review opened): null — "Couldn't
  // read this commit's files" — never an empty list, "No file changes".
  host.posted.length = 0;
  await host.send({ type: "pushCommitFiles", sha: "0123456789abcdef0123456789abcdef01234567" });
  assert.deepEqual(host.posted.find((m) => m.type === "pushCommitFiles"), { type: "pushCommitFiles", sha: "0123456789abcdef0123456789abcdef01234567", files: null });

  // Push: the worktree's branch reaches origin; this window's branch is untouched.
  const mainBefore = s.repo.git("rev-parse", "main").trim();
  host.posted.length = 0;
  await host.send({ type: "confirmPush" });
  const done = host.posted.find((m) => m.type === "pushDone");
  assert.equal(done?.ok, true, String(done?.error));
  const remoteTopic = execFileSync("git", ["rev-parse", "refs/heads/topic"], { cwd: s.bare, encoding: "utf8" }).trim();
  assert.equal(remoteTopic, s.t("rev-parse", "HEAD"));
  assert.equal(s.repo.git("rev-parse", "main").trim(), mainBefore);

  // The view's own Push is this window's repository again.
  host.posted.length = 0;
  await host.send({ type: "requestPushPreview" });
  assert.equal(host.posted.find((m) => m.type === "pushPreview"), undefined, "main has nothing to push");
});

test("a review that replaces another never kills the first one's git — its context is let go only with the view", async () => {
  const s = scene();
  const host = changesHost(s.repo.dir);
  await host.send({ type: "ready" });
  const released: string[] = [];
  const target = (name: string) => {
    const ctx = new GitContext({ root: s.topic });
    return { entry: { root: s.topic, ctx }, name, shownPath: "~/t", release: () => (released.push(name), ctx.dispose()) };
  };
  await host.provider.openPushReview(target("first"));
  await host.provider.openPushReview(target("second"));
  await host.send({ type: "requestPushPreview" });
  assert.deepEqual(released, [], "a push the first review started may still be running");
  host.dispose();
  assert.deepEqual(released, [], "only the review's CURRENT target is its own to dispose — and there is none now");
  // With a worktree review open when the view goes, that one is let go.
  const h2 = changesHost(s.repo.dir);
  await h2.send({ type: "ready" });
  await h2.provider.openPushReview(target("third"));
  h2.dispose();
  assert.deepEqual(released, ["third"]);
});

test("Undo commits… in another worktree's review resets THAT worktree, keeping the changes", async () => {
  const s = scene();
  const host = changesHost(s.repo.dir);
  cleanups.push(host.dispose);
  await host.send({ type: "ready" });
  const ctx = new GitContext({ root: s.topic });
  await host.provider.openPushReview({ entry: { root: s.topic, ctx }, name: "topic-wt", shownPath: "~/topic-wt", release: () => ctx.dispose() });
  answerWith((spec) => (spec.kind === "pick" ? "keep" : undefined));
  const mainBefore = s.repo.git("rev-parse", "HEAD").trim();
  await host.send({ type: "discardLocalCommits" });
  assert.equal(s.t("rev-parse", "HEAD"), s.t("rev-parse", "origin/topic"), "its two commits undone");
  assert.match(s.t("status", "--porcelain"), /M {2}a\.txt|A {2}t\.txt/);
  assert.equal(s.repo.git("rev-parse", "HEAD").trim(), mainBefore, "this window's HEAD did not move");
  answerWith(() => "ok");
});

test("the review's commits open to their own files, drawn by the shared rows; a file under one opens what THAT commit did", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 640 });
  cleanups.push(() => page.close());
  await page.send(stateMessage({ local: [{ name: "main", current: true, upstream: "origin/main" }] }));
  const a = "a".repeat(40);
  const p = "b".repeat(40);
  await page.send({
    type: "pushPreview", hasUpstream: true, target: "origin/topic", branch: "topic", base: p,
    canPush: true, ahead: 1, behind: 0, needsForce: false, additions: 1, deletions: 1,
    commits: [{ sha: a, parents: [p], subject: "topic two", author: "Ada", date: 1700000000 }],
    files: [{ path: "src/a.txt", status: "M", additions: 1, deletions: 1 }],
    worktree: { name: "topic-wt", shownPath: "~/topic-wt" },
  });
  const where = await page.eval<string>(`document.querySelector(".push-modal .pm-where").textContent`);
  assert.equal(where, "From the worktree topic-wt — ~/topic-wt");
  const row = await page.eval<{ expanded: string | null; tag: string; cursor: string }>(`(function () {
    var r = document.querySelector(".push-modal .cr-commit");
    return { expanded: r.getAttribute("aria-expanded"), tag: r.tagName, cursor: getComputedStyle(r).cursor };
  })()`);
  assert.deepEqual(row, { expanded: "false", tag: "DIV", cursor: "pointer" }, "a commit row is a control now");
  await page.eval(`window.__posted.length = 0; document.querySelector(".push-modal .cr-commit").click()`);
  assert.deepEqual(await page.posted(), [{ type: "pushCommitFiles", sha: a }]);
  await page.send({ type: "pushCommitFiles", sha: a, files: [{ path: "src/a.txt", status: "M", additions: 1, deletions: 1 }] });
  await page.eval(`window.__posted.length = 0; document.querySelector(".push-modal .cr-commit-files .cr-file").click()`);
  assert.deepEqual(await page.posted(), [
    { type: "openPushCommitFile", sha: a, parent: p, path: "src/a.txt", status: "M" },
  ]);
  // The aggregate files list is the same rows; a click opens the fork-point diff.
  await page.eval(`window.__posted.length = 0; document.querySelector(".push-modal .pm-body > .cr-file").click()`);
  assert.deepEqual(await page.posted(), [{ type: "openPushFileDiff", path: "src/a.txt" }]);
  assert.deepEqual(page.page.errors, []);
});

test("a question with a checkbox: unchecked by default, and what is checked comes back with the answer", { skip }, async () => {
  const page = await ChangesPage.open("light", { width: 460, height: 640 });
  cleanups.push(() => page.close());
  await page.send(stateMessage({ local: [{ name: "main", current: true }] }));
  const spec = {
    kind: "pick",
    title: "Remove worktree feat?",
    message: "It has 1 uncommitted change:\n  a.txt",
    filter: false,
    choices: [
      { id: "stash", label: "Stash & Remove", description: "Its 1 uncommitted change go into a stash." },
      { id: "discard", label: "Discard Changes and Remove", danger: true },
    ],
    options: [{ id: "deleteBranch", label: "Also delete the branch feat", description: "It is fully merged into main, so no commit is lost.", checked: false }],
  };
  await page.send({ type: "dialog", dialogId: "q1", spec });
  const box = await page.eval<{ checked: boolean; label: string; msg: string }>(`(function () {
    var i = document.querySelector(".rp-panel .rp-option input[type=checkbox]");
    return { checked: i.checked, label: i.parentElement.textContent, msg: document.querySelector(".rp-panel .rp-msg").textContent };
  })()`);
  assert.equal(box.checked, false);
  assert.match(box.label, /Also delete the branch feat/);
  assert.match(box.msg, /It has 1 uncommitted change/);
  await page.eval(`window.__posted.length = 0; document.querySelector(".rp-panel .rp-option input").click()`);
  await page.eval(`document.querySelector(".rp-panel .rp-choice").click()`);
  assert.deepEqual(await page.posted(), [{ type: "dialogResult", dialogId: "q1", dialogValue: "stash", dialogOptions: ["deleteBranch"] }]);

  // A confirm with the box left alone answers with none checked; dismissed answers nothing.
  await page.send({ type: "dialog", dialogId: "q2", spec: { kind: "confirm", title: "Remove worktree feat?", message: "Deletes its folder.", confirmLabel: "Remove", danger: true, options: spec.options } });
  await page.eval(`window.__posted.length = 0; Array.prototype.find.call(document.querySelectorAll(".rp-foot button"), function (b) { return b.textContent === "Remove"; }).click()`);
  assert.deepEqual(await page.posted(), [{ type: "dialogResult", dialogId: "q2", dialogValue: "ok", dialogOptions: [] }]);
  await page.send({ type: "dialog", dialogId: "q3", spec: { kind: "confirm", title: "t", message: "m", confirmLabel: "Remove", options: spec.options } });
  await page.eval(`window.__posted.length = 0`);
  await page.key("Escape");
  assert.deepEqual(await page.posted(), [{ type: "dialogResult", dialogId: "q3" }]);
});

test("promptChoose: one way is a confirm, several a pick; the checked options come back from the host", async () => {
  const s = scratchRepo("choose");
  cleanups.push(s.done);
  const host = changesHost(s.dir);
  cleanups.push(host.dispose);
  asked.length = 0;
  answerWith(() => "ok");
  const one = await promptChoose({ title: "T", message: "M", choices: [{ id: "remove", label: "Remove", danger: true }], options: [{ id: "x", label: "X" }] });
  assert.deepEqual(asked.at(-1), { kind: "confirm", title: "T", message: "M", confirmLabel: "Remove", danger: true, options: [{ id: "x", label: "X" }] });
  assert.deepEqual(one, { id: "remove", options: [] });
  answerWith((spec) => (spec.kind === "pick" ? "b" : undefined));
  const two = await promptChoose({ title: "T", message: "M", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.equal(asked.at(-1)?.kind, "pick");
  assert.deepEqual(two, { id: "b", options: [] });
  answerWith(() => "ok");
});
