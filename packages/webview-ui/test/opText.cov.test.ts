import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConflictShape, OperationKind, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  abortConfirm,
  appendName,
  continueBlockedText,
  directionParts,
  directionText,
  hasText,
  opChipLabel,
  opNoun,
  otherRole,
  roleWord,
  sha7,
  shapeWord,
  sideName,
  sideOf,
  skipConfirm,
  stepText,
  successCard,
  willDropText,
} from "../src/conflicts/opText";
import { FakeElement, FakeText, installFakeDom } from "./fakeDom.cov";

// The rest of the operation vocabulary: the chip, the step line, the direction
// bar, the blocked-Continue reason, the willDrop warning — pinned as strings,
// since every host prints exactly these.

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string, description = "") => ({
  role,
  stage,
  name,
  paneTitle: name,
  description,
});
const op = (over: Partial<OperationView> = {}): OperationView => ({
  kind: "merge",
  title: "",
  yours: side("yours", 2, "main"),
  theirs: side("theirs", 3, "feature"),
  verbs: { continue: "Continue Merge", abort: "Abort Merge" },
  canContinue: true,
  canSkip: false,
  episode: "e",
  ...over,
});

const KINDS: OperationKind[] = ["merge", "rebase", "rebase-merge-step", "cherry-pick", "revert", "am", "stash", "none"];

test("the small helpers: sha7, role words, the other role, the side a role names", () => {
  assert.equal(sha7("0123456789abcdef"), "0123456");
  assert.equal(sha7(undefined), "");
  assert.equal(sha7("abc"), "abc");
  assert.equal(roleWord("yours"), "Yours");
  assert.equal(roleWord("theirs"), "Theirs");
  assert.equal(otherRole("yours"), "theirs");
  assert.equal(otherRole("theirs"), "yours");
  const o = op();
  assert.equal(sideOf(o, "yours").name, "main");
  assert.equal(sideOf(o, "theirs").name, "feature");
});

test("every operation kind has a chip label and a noun", () => {
  assert.deepEqual(
    KINDS.map((kind) => opChipLabel(op({ kind }))),
    [
      "Merge in progress",
      "Rebase in progress",
      "Rebase in progress",
      "Cherry-pick in progress",
      "Revert in progress",
      "Applying patches",
      "Applying a stash",
      "Unmerged files",
    ],
  );
  assert.deepEqual(
    KINDS.map((kind) => opNoun(kind)),
    ["merge", "rebase", "rebase", "cherry-pick", "revert", "patch series", "stash apply", "merge"],
  );
});

test("a paused rebase says paused, whatever else the view carries", () => {
  assert.equal(opChipLabel(op({ kind: "rebase", pause: { reason: "edit", detail: "Paused to edit 1a2b3c4" } })), "Rebase paused");
});

test("the step line joins the step and what is queued, and is empty with neither", () => {
  assert.equal(stepText(op({ step: { n: 1, m: 3, unit: "commit" } })), "commit 1 of 3");
  assert.equal(stepText(op({ step: { n: 2, m: 5, unit: "patch" }, queued: 2 })), "patch 2 of 5 · 2 more queued");
  assert.equal(stepText(op({ queued: 1 })), "1 more queued");
  assert.equal(stepText(op({ step: { n: 0, m: 0, unit: "step" }, queued: 0 })), "", "an empty sequence says nothing");
  assert.equal(stepText(op()), "");
});

test("the direction bar reads from → verb → to with each side's role and name", () => {
  const rebase = op({
    kind: "rebase",
    yours: side("yours", 3, "test"),
    theirs: side("theirs", 2, "master"),
    direction: { from: "yours", verb: "onto", to: "theirs" },
  });
  const parts = directionParts(rebase)!;
  assert.equal(parts.from.name, "test");
  assert.equal(parts.verb, "onto");
  assert.equal(parts.to.name, "master");
  assert.equal(directionText(rebase), "YOURS test → onto → THEIRS master");

  const merge = op({ direction: { from: "theirs", verb: "into", to: "yours" } });
  assert.equal(directionText(merge), "THEIRS feature → into → YOURS main");
});

test("an operation with no direction has no bar at all", () => {
  assert.equal(directionParts(op({ kind: "none" })), undefined);
  assert.equal(directionText(op({ kind: "none" })), "");
});

test("the willDrop warning names the commit, shortened, and the branch it leaves", () => {
  assert.equal(willDropText(op()), "", "nothing to warn about");
  assert.equal(
    willDropText(op({ willDrop: { sha: "1a2b3c4d5e6f", subject: "tidy imports", branch: "test" } })),
    "Your resolution leaves 1a2b3c4 “tidy imports” with no changes, so continuing drops it from test. " +
      "Keep editing if you meant to keep it.",
  );
});

test("a blocked Continue gives the host's own reason first", () => {
  assert.equal(
    continueBlockedText(op({ canContinue: false, continueBlocked: "app.ts still has conflict markers staged" }), 3),
    "app.ts still has conflict markers staged",
  );
});

test("a blocked Continue counts what is left to resolve, in the singular for one", () => {
  assert.equal(continueBlockedText(op({ canContinue: false }), 1), "Resolve the last conflicted file first.");
  assert.equal(continueBlockedText(op({ canContinue: false }), 4), "Resolve the 4 conflicted files first.");
});

test("nothing left to resolve and still no Continue: Skip is named as the way out", () => {
  assert.equal(
    continueBlockedText(op({ kind: "rebase", canContinue: false, canSkip: true }), 0),
    "Nothing is left to commit at this step: it is already on the branch. Skip it, or abort.",
  );
  assert.equal(
    continueBlockedText(op({ kind: "am", canContinue: false, canSkip: true }), 0),
    "git couldn't apply this patch. Skip it, or abort.",
  );
});

test("with nothing pending and no reason to give, the blocked text is empty", () => {
  assert.equal(continueBlockedText(op({ canContinue: true }), 0), "");
  assert.equal(continueBlockedText(op({ canContinue: false, canSkip: false }), 0), "");
});

test("a side is named from the reader's point of view, or by its pane label without an operation", () => {
  assert.equal(sideName(op(), "yours", "ignored"), "yours (main)");
  assert.equal(sideName(op({ theirs: side("theirs", 3, "") }), "theirs", "ignored"), "theirs", "a nameless side is its role");
  assert.equal(sideName(undefined, "theirs", "Incoming"), "“Incoming”");
});

test("only text and added-on-both-sides (or no shape) merge line by line", () => {
  assert.equal(hasText(undefined), true);
  assert.equal(hasText("text"), true);
  assert.equal(hasText("added-both"), true);
  for (const s of ["binary", "too-large", "submodule", "symlink", "modify-delete", "both-deleted", "added-one-side"] as ConflictShape[]) {
    assert.equal(hasText(s), false, s);
  }
});

test("each no-text shape has its own short word, and plain text has none", () => {
  const words = (["binary", "too-large", "modify-delete", "both-deleted", "added-one-side", "added-both", "text"] as ConflictShape[]).map(shapeWord);
  assert.deepEqual(words, [
    "binary",
    "too large to merge here",
    "deleted on one side",
    "deleted on both sides",
    "added on one side",
    "added on both sides",
    "",
  ]);
});

test("Skip with no commit named says 'This commit', and a single pick's Skip ends the pick", () => {
  const s = skipConfirm(op({ kind: "cherry-pick", verbs: { continue: "Continue", skip: "Skip this commit", abort: "Abort" } }));
  assert.equal(s.question, "Skip this commit?");
  assert.equal(s.confirm, "Skip this commit");
  assert.equal(s.detail, "This commit is left out, and that ends the cherry-pick. This cannot be undone from here.");
});

test("Skip without a verb of its own is just 'Skip', and a merge-kind finishes without it", () => {
  const s = skipConfirm(op({ kind: "rebase", commit: { sha: "abcdef0123", subject: "wip" } }));
  assert.equal(s.question, "Skip?");
  assert.equal(s.detail, "abcdef0 “wip” is left out, and the rebase finishes without it. This cannot be undone from here.");
});

test("a picked range with more queued: the success card says how many are behind it", () => {
  assert.deepEqual(successCard(op({ kind: "cherry-pick", queued: 1, verbs: { continue: "Continue Cherry-pick", abort: "Abort" } })), {
    title: "This commit resolved",
    note: "Continue Cherry-pick to commit it and go on to the next pick (1 more is queued). It stops again if one conflicts.",
  });
  assert.match(successCard(op({ kind: "revert", queued: 3, verbs: { continue: "Continue Revert", abort: "Abort" } })).note, /next revert \(3 more are queued\)/);
});

test("the abort confirm for an ordinary operation names it and what it discards", () => {
  const a = abortConfirm(op({ kind: "cherry-pick", verbs: { abort: "Abort Cherry-pick" } }));
  assert.equal(a.question, "Abort the cherry-pick?");
  assert.match(a.detail, /before the cherry-pick started/);
  assert.equal(a.confirm, "Abort Cherry-pick");
});

test("appendName writes a branch as text with a break after each slash, never as markup", (t) => {
  t.after(installFakeDom());
  const node = new FakeElement("span");
  node.textContent = "stale";
  appendName(node as unknown as HTMLElement, "feature/<img src=x onerror=alert(1)>/fix");
  assert.equal(node.textContent, "feature/<img src=x onerror=alert(1)>/fix");
  assert.equal(node.title, "feature/<img src=x onerror=alert(1)>/fix");
  assert.deepEqual(
    node.childNodes.map((n) => (n instanceof FakeText ? `"${n.data}"` : n.tagName.toLowerCase())),
    ['"feature"', '"/"', "wbr", '"<img src=x onerror=alert(1)>"', '"/"', "wbr", '"fix"'],
  );
  assert.equal(node.children.filter((c) => c.tagName !== "WBR").length, 0, "the only elements made are the break opportunities");
});

test("appendName keeps a leading slash's break and writes no empty text nodes", (t) => {
  t.after(installFakeDom());
  const node = new FakeElement("span");
  appendName(node as unknown as HTMLElement, "/main");
  assert.deepEqual(
    node.childNodes.map((n) => (n instanceof FakeText ? n.data : n.tagName.toLowerCase())),
    ["/", "wbr", "main"],
  );
});
