import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The composer's two buttons, per state, in the real page commitView.ts
// serves. The primary never offers a push that cannot work — a detached HEAD
// (every stopped rebase is one) or a repository with no remote — and says why
// instead; and "Commit all N" never counts a conflicted file, which the host
// will not sweep into a commit.
//
// Which push is primary (Commit vs Commit & Push) is the owner's open
// question and is not decided here: only the cells where a push is impossible.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage;
before(async () => {
  if (skip) return;
  page = await ChangesPage.open("dark", { width: 520, height: 640 });
});
after(async () => {
  if (page) await page.close();
});

const BASE = stateMessage({ local: [{ name: "main", current: true, upstream: "origin/main" }] });
const STAGED = [{ path: "src/a.ts", status: "M" }];

interface Buttons {
  mode: string;
  primary: string;
  primaryDisabled: boolean;
  primaryTip: string;
  primaryAria: string;
  commit: string;
  commitDisabled: boolean;
}

async function buttonsFor(state: Record<string, unknown>): Promise<Buttons> {
  await page.send({ ...BASE, staged: [], unstaged: [], merge: [], operation: undefined, ...state });
  return page.eval<Buttons>(`(function () {
    var p = document.getElementById("commit-push"), c = document.getElementById("commit");
    return {
      mode: p.dataset.mode,
      primary: document.getElementById("main-label").textContent,
      primaryDisabled: p.disabled,
      primaryTip: p.dataset.tip || "",
      primaryAria: p.getAttribute("aria-label") || "",
      commit: document.getElementById("commit-label").textContent,
      commitDisabled: c.disabled,
    };
  })()`);
}

test("staged work on a tracked branch: Commit & Push, as before", { skip }, async () => {
  const b = await buttonsFor({ staged: STAGED, stagedCount: 1 });
  assert.equal(b.mode, "commitpush");
  assert.equal(b.primary, "Commit & Push");
  assert.equal(b.primaryDisabled, false);
  assert.equal(b.commit, "Commit 1");
});

test("staged work on a detached HEAD: no push is offered, and the tip says why", { skip }, async () => {
  const b = await buttonsFor({
    staged: STAGED, stagedCount: 1, detached: true, branch: "a1b2c3d", upstream: undefined, canPublish: true, unpushed: 2,
  });
  assert.equal(b.mode, "none");
  assert.equal(b.primaryDisabled, true);
  assert.match(b.primaryTip, /detached/i);
  assert.equal(b.commit, "Commit 1");
  assert.equal(b.commitDisabled, false, "committing is still one click away");
});

test("unpushed commits on a detached HEAD: no 'Publish N'", { skip }, async () => {
  const b = await buttonsFor({ detached: true, branch: "a1b2c3d", upstream: undefined, canPublish: true, unpushed: 3 });
  assert.equal(b.mode, "none");
  assert.equal(b.primaryDisabled, true);
  assert.match(b.primaryTip, /detached/i);
});

// Every stopped rebase is a detached HEAD, and "create a branch here" is
// harmful there: the branch would point at a half-rebased commit. The host
// knows the operation (changesPushDoors.test.ts) and sends the reason; the
// tip and the button's name are the host's words.
const REBASING =
  "A rebase of topic is in progress, so there is no branch to push until it finishes. " +
  "Finish it with Continue Rebase and these commits land on topic.";

test("staged work during a stopped rebase: the reason is to finish it, never to create a branch", { skip }, async () => {
  const b = await buttonsFor({
    staged: STAGED,
    stagedCount: 1,
    detached: true,
    branch: "a1b2c3d",
    upstream: undefined,
    canPublish: false,
    unpushed: 0,
    operation: {
      kind: "rebase",
      title: "Rebasing topic onto main · commit 2 of 2",
      conflicts: 0,
      canContinue: true,
      continueLabel: "Continue Rebase",
      abortLabel: "Abort Rebase",
    },
    detachedReason: REBASING,
  });
  assert.equal(b.mode, "none");
  assert.equal(b.primaryDisabled, true);
  assert.equal(b.primaryTip, REBASING);
  assert.equal(b.primaryAria, "Push — " + REBASING);
  assert.doesNotMatch(b.primaryTip + b.primaryAria, /create a branch/i);
  assert.equal(b.commitDisabled, false, "committing the resolution is still one click away");
});

test("staged work in a repository with no remote: no push is offered, and the tip says why", { skip }, async () => {
  const b = await buttonsFor({ staged: STAGED, stagedCount: 1, upstream: undefined, canPublish: false, unpushed: 4 });
  assert.equal(b.mode, "none");
  assert.equal(b.primaryDisabled, true);
  assert.match(b.primaryTip, /no remote/i);
});

test("an unpublished branch before the host has looked for a remote keeps Commit & Push (no flicker)", { skip }, async () => {
  const b = await buttonsFor({ staged: STAGED, stagedCount: 1, upstream: undefined, canPublish: undefined });
  assert.equal(b.mode, "commitpush");
});

test("an unpublished branch with a remote still offers Publish", { skip }, async () => {
  const b = await buttonsFor({ upstream: undefined, canPublish: true, unpushed: 2 });
  assert.equal(b.mode, "push");
  assert.equal(b.primary, "Publish 2");
});

test("only conflicted files: Commit is not offered as 'Commit all 1'", { skip }, async () => {
  const b = await buttonsFor({ merge: [{ path: "c.txt", status: "!" }] });
  assert.equal(b.commit, "Commit");
  assert.equal(b.commitDisabled, true);
});

const PREVIEW = {
  type: "pushPreview",
  hasUpstream: true,
  target: "origin/main",
  branch: "main",
  base: "0000000",
  canPush: true,
  ahead: 1,
  behind: 1,
  additions: 1,
  deletions: 0,
  commits: [{ sha: "a".repeat(40), subject: "amended", author: "t", date: 0 }],
  files: [{ path: "a.txt", status: "M", additions: 1, deletions: 0 }],
};

async function focusedInPushModal(needsForce: boolean): Promise<string> {
  await page.send(BASE);
  await page.send({ ...PREVIEW, needsForce });
  const label = await page.eval<string>(`(function () {
    var a = document.activeElement;
    return a && a.closest(".push-modal") ? a.textContent.trim() : "(outside the dialog)";
  })()`);
  await page.eval(`(function () { var c = Array.prototype.find.call(document.querySelectorAll(".push-modal .pm-btn"), function (b) { return b.textContent.trim() === "Cancel"; }); if (c) c.click(); })()`);
  return label;
}

test("the push review starts on Push for an ordinary push", { skip }, async () => {
  assert.equal(await focusedInPushModal(false), "Push");
});

test("the push review never starts on Force push: Enter must not force-push", { skip }, async () => {
  assert.equal(await focusedInPushModal(true), "Cancel");
});

test("conflicted files beside ordinary edits: 'Commit all' counts only the edits", { skip }, async () => {
  const b = await buttonsFor({ merge: [{ path: "c.txt", status: "!" }], unstaged: [{ path: "o.txt", status: "M" }] });
  assert.equal(b.commit, "Commit all 1");
});
