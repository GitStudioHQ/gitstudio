import { test } from "node:test";
import assert from "node:assert/strict";
import { refMenuItems } from "../src/renderer/refMenuItems";

// The app's graph menu offered only "Checkout" — a DETACHED checkout of the
// commit — even when the row you right-clicked was a branch tip (issues #12/#19).
// As @wkornewald put it: no need to check out a headless commit when the commit
// is the tip of a branch and you can check out the branch itself.

test("a local branch on the row becomes a plain checkout", () => {
  const items = refMenuItems([{ name: "main", kind: "head" }]);
  assert.deepEqual(items, [
    { label: "Checkout main", ref: { name: "main", kind: "head" } },
  ]);
});

test("the branch you are already on is skipped", () => {
  // The most common row to right-click, and switching to where you already are
  // is not an action.
  const items = refMenuItems([
    { name: "main", kind: "head", current: true },
    { name: "feature", kind: "head" },
  ]);
  assert.deepEqual(items.map((i) => i.label), ["Checkout feature"]);
});

test("a remote branch is offered, and carries its kind for the tracking checkout", () => {
  const items = refMenuItems([{ name: "origin/fix/login", kind: "remote" }]);
  assert.equal(items[0].label, "Checkout origin/fix/login");
  assert.equal(items[0].ref.kind, "remote");
  assert.equal(items[0].confirm, undefined, "it acts immediately, like the extension's");
});

test("origin/HEAD is never offered", () => {
  // A symbolic pointer at the remote's default branch: checking it out detaches
  // at whatever it points to. It rides along on a very common row.
  const items = refMenuItems([
    { name: "origin/HEAD", kind: "remote" },
    { name: "origin/main", kind: "remote" },
  ]);
  assert.deepEqual(items.map((i) => i.label), ["Checkout origin/main"]);
});

test("a tag is offered, asks first, and says so with an ellipsis", () => {
  // The one case where detaching is correct — there is no branch to attach to.
  const items = refMenuItems([{ name: "v1.2.0", kind: "tag" }]);
  assert.equal(items[0].label, "Checkout v1.2.0…");
  assert.match(items[0].confirm ?? "", /detached HEAD/);
});

test("order follows the row, so the branch you can see first is first", () => {
  const items = refMenuItems([
    { name: "release", kind: "head" },
    { name: "origin/release", kind: "remote" },
    { name: "v2", kind: "tag" },
  ]);
  assert.deepEqual(items.map((i) => i.label), [
    "Checkout release",
    "Checkout origin/release",
    "Checkout v2…",
  ]);
});

test("a row with no refs adds nothing, leaving the commit actions alone", () => {
  assert.deepEqual(refMenuItems([]), []);
  // …and a row whose only ref is the current branch also adds nothing.
  assert.deepEqual(refMenuItems([{ name: "main", kind: "head", current: true }]), []);
});

test("a local branch literally named like a tag is still treated as a branch", () => {
  // Kind drives behaviour, never the name — a branch called "v1.0" must attach,
  // not detach.
  const items = refMenuItems([{ name: "v1.0", kind: "head" }]);
  assert.equal(items[0].label, "Checkout v1.0");
  assert.equal(items[0].confirm, undefined);
  assert.equal(items[0].ref.kind, "head");
});
