import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationView, SideRole } from "@gitstudio/host-bridge/conflictsProtocol";
import { buildNoTextPanel, describeNoText, fileLabel, noTextIcon } from "../src/noTextPanel";
import { FakeElement, installFakeDom } from "./fakeDom.cov";

// The panel that stands in for the three panes when a conflict has no text:
// what it says per shape, which buttons it offers, and what each one asks the
// host to do. Built over a hand-written fake DOM (test/fakeDom.cov.ts).

const base = { path: "assets/logo.png", yoursLabel: "Yours", theirsLabel: "Theirs" };

const op = (over: Partial<OperationView> = {}): OperationView =>
  ({
    kind: "rebase",
    title: "Rebasing test onto master",
    yours: { role: "yours", stage: 2, name: "test", paneTitle: "", description: "your commit 1a2b3c4 from test" },
    theirs: { role: "theirs", stage: 3, name: "master", paneTitle: "", description: "" },
    verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
    canContinue: false,
    canSkip: false,
    episode: "e1",
    ...over,
  }) as OperationView;

function build(input: Parameters<typeof buildNoTextPanel>[0]) {
  const calls: string[] = [];
  const restore = installFakeDom();
  try {
    const panel = buildNoTextPanel(input, {
      takeRole: (role: SideRole) => calls.push(`take:${role}`),
      deleteFile: () => calls.push("delete"),
    });
    const el = panel.element as unknown as FakeElement;
    const buttons = el.querySelectorAll("button");
    const part = (cls: string) => el.querySelector(`.${cls}`)!;
    return { panel, el, buttons, part, calls, restore };
  } catch (e) {
    restore();
    throw e;
  }
}

/** A button's own words, without the icon glyph it may carry. */
const label = (b: FakeElement) => b.childNodes.filter((n) => !(n instanceof FakeElement)).map((n) => n.textContent).join("");

test("fileLabel names the file by its last segment, whatever separator the host used", () => {
  assert.equal(fileLabel("/Users/me/repo/assets/logo.png"), "logo.png");
  assert.equal(fileLabel("C:\\repo\\assets\\logo.png"), "logo.png");
  assert.equal(fileLabel("vendor/lib/"), "lib", "a trailing separator does not leave an empty name");
  assert.equal(fileLabel("README"), "README");
  assert.equal(fileLabel("/"), "/", "nothing but separators falls back to the path itself");
});

test("each remaining shape explains itself in the reader's words", () => {
  const tooLarge = describeNoText({ ...base, path: "/abs/dump.sql", shape: "too-large" });
  assert.equal(tooLarge.title, "Too large to merge here");
  assert.match(tooLarge.detail, /^dump\.sql is larger than can be read in one go/);
  assert.match(tooLarge.detail, /would delete the rest/);

  const dd = describeNoText({ ...base, shape: "both-deleted", op: op() });
  assert.equal(dd.title, "Deleted on both sides");
  assert.match(dd.detail, /^logo\.png was deleted in yours \(test\) and in theirs \(master\)\./);

  const md = describeNoText({ ...base, shape: "modify-delete", op: op() });
  assert.equal(md.title, "Changed on one side, deleted on the other");
  assert.match(md.detail, /edited in yours \(test\) and deleted in theirs \(master\)/, "theirs is the missing side by default");

  const mdYours = describeNoText({ ...base, shape: "modify-delete", missingRole: "yours", op: op() });
  assert.match(mdYours.detail, /edited in theirs \(master\) and deleted in yours \(test\)/);

  const added = describeNoText({ ...base, shape: "added-one-side", missingRole: "yours" });
  assert.equal(added.title, "Added on one side only");
  assert.match(added.detail, /is new in “Theirs” and does not exist in “Yours”/, "with no operation the pane labels are quoted");

  const addedDefault = describeNoText({ ...base, shape: "added-one-side" });
  assert.match(addedDefault.detail, /is new in “Yours” and does not exist in “Theirs”/);
});

test("a submodule without both commits does not print a half-empty 'yours at …'", () => {
  const d = describeNoText({ ...base, path: "vendor/lib", shape: "submodule", commits: { yours: "1c34b25aaaa" } });
  assert.doesNotMatch(d.detail, /yours at/);
  assert.match(d.detail, /point it at different commits\. Accept one side/);
});

test("a shape the panel does not know still says there is nothing to merge, and wears the removal mark", () => {
  const d = describeNoText({ ...base, shape: "text" });
  assert.deepEqual(d, { title: "Nothing to merge line by line", detail: "logo.png has no text to merge here." });
  assert.match(noTextIcon("too-large"), /codicon-warning/);
  assert.match(noTextIcon("text"), /codicon-diff-removed/);
});

test("a file deleted on both sides offers one move, 'Delete the file', which asks the host to delete it", (t) => {
  const b = build({ ...base, shape: "both-deleted" });
  t.after(b.restore);
  assert.equal(b.buttons.length, 1);
  const [del] = b.buttons;
  assert.equal(label(del), "Delete the file");
  assert.ok(del.classList.contains("ms-danger"), "the one destructive move is marked as such");
  assert.match(del.innerHTML, /codicon-trash/);
  assert.equal(del.type, "button");
  assert.match(del.title, /Neither side has this file/);
  del.click();
  assert.deepEqual(b.calls, ["delete"]);
});

test("the panel shows the shape, its mark, its title and its explanation", (t) => {
  const b = build({ ...base, shape: "binary" });
  t.after(b.restore);
  assert.equal(b.el.className, "ms-notext");
  assert.equal(b.el.dataset.shape, "binary");
  assert.match(b.part("ms-notext-badge").innerHTML, /codicon-file-binary/);
  assert.equal(b.part("ms-notext-title").textContent, "Conflicted binary file");
  assert.match(b.part("ms-notext-desc").textContent, /^logo\.png is binary/);
  assert.equal(b.part("ms-notext-done").hidden, true, "nothing is resolved yet");
});

test("a hostile file name is set as text, never parsed as markup", (t) => {
  const b = build({ ...base, path: "x/<img src=x onerror=alert(1)>.png", shape: "binary" });
  t.after(b.restore);
  const desc = b.part("ms-notext-desc");
  assert.match(desc.textContent, /<img src=x onerror=alert\(1\)>\.png is binary/);
  assert.equal(desc.children.length, 0, "no element was created from the name");
  assert.match(desc.innerHTML, /&lt;img/, "serialised, the name is escaped text");
});

test("a binary file with no operation offers both sides by their button words", (t) => {
  const b = build({ ...base, shape: "binary" });
  t.after(b.restore);
  assert.deepEqual(b.buttons.map(label), ["Accept Yours", "Accept Theirs"]);
  assert.deepEqual(b.buttons.map((x) => x.title), [
    "Replace the file with yours and stage it",
    "Replace the file with theirs and stage it",
  ]);
  assert.ok(b.buttons.every((x) => !x.classList.contains("ms-danger")));
  b.buttons[1].click();
  b.buttons[0].click();
  assert.deepEqual(b.calls, ["take:theirs", "take:yours"]);
});

test("with an operation, a side's tooltip keeps its description, or names the side", (t) => {
  const b = build({ ...base, shape: "symlink", op: op() });
  t.after(b.restore);
  assert.deepEqual(b.buttons.map((x) => x.title), [
    "Keep your commit 1a2b3c4 from test and stage it",
    "Replace the file with theirs (master) and stage it",
  ]);
});

test("modify/delete: the side with no file reads 'Delete the file' and still takes that side", (t) => {
  const b = build({ ...base, shape: "modify-delete", missingRole: "theirs", op: op() });
  t.after(b.restore);
  assert.deepEqual(b.buttons.map(label), ["Accept Yours", "Delete the file"]);
  const del = b.buttons[1];
  assert.ok(del.classList.contains("ms-danger"));
  assert.equal(del.title, "Theirs (master) has no version of this file — accepting theirs removes it and stages the deletion");
  del.click();
  assert.deepEqual(b.calls, ["take:theirs"], "a delete here is taking theirs, not the DD delete");
});

test("modify/delete with no operation names the missing side by its word alone", (t) => {
  const b = build({ ...base, shape: "modify-delete", missingRole: "yours" });
  t.after(b.restore);
  assert.equal(label(b.buttons[0]), "Delete the file");
  assert.equal(b.buttons[0].title, "Yours has no version of this file — accepting yours removes it and stages the deletion");
});

test("a submodule's buttons point it at a side's commit, shortened to seven", (t) => {
  const b = build({
    ...base,
    path: "vendor/lib",
    shape: "submodule",
    op: op(),
    commits: { yours: "1c34b25aaaaaaaaa", theirs: undefined },
  });
  t.after(b.restore);
  assert.deepEqual(b.buttons.map((x) => x.title), [
    "Point the submodule at yours (test)'s commit 1c34b25 and stage it",
    "Point the submodule at theirs (master)'s commit and stage it",
  ]);
});

test("while busy the buttons are locked and a click does nothing; unbusy unlocks them", (t) => {
  const b = build({ ...base, shape: "binary" });
  t.after(b.restore);
  b.panel.setBusy(true);
  assert.ok(b.el.classList.contains("is-busy"));
  assert.ok(b.buttons.every((x) => x.disabled));
  b.buttons[0].click();
  assert.deepEqual(b.calls, [], "a locked button does not reach the host");
  b.panel.setBusy(false);
  assert.ok(!b.el.classList.contains("is-busy"));
  assert.ok(b.buttons.every((x) => !x.disabled));
  b.buttons[0].click();
  assert.deepEqual(b.calls, ["take:yours"]);
});

test("a resolution that worked replaces the buttons with what happened", (t) => {
  const b = build({ ...base, shape: "binary" });
  t.after(b.restore);
  b.panel.setResolved("Kept yours and staged logo.png", true);
  const done = b.part("ms-notext-done");
  assert.equal(done.hidden, false);
  assert.equal(done.textContent, "Kept yours and staged logo.png");
  assert.match(done.innerHTML, /codicon-check/);
  assert.ok(!done.classList.contains("is-warn"));
  assert.equal(b.part("ms-notext-actions").hidden, true);
  assert.ok(b.buttons.every((x) => x.disabled));
});

test("a resolution that failed warns, and leaves the buttons there to try again", (t) => {
  const b = build({ ...base, shape: "binary" });
  t.after(b.restore);
  b.panel.setBusy(true);
  b.panel.setResolved("git refused: index.lock exists", false);
  const done = b.part("ms-notext-done");
  assert.match(done.innerHTML, /codicon-warning/);
  assert.doesNotMatch(done.innerHTML, /codicon-check/);
  assert.ok(done.classList.contains("is-warn"));
  assert.equal(b.part("ms-notext-actions").hidden, false);
  assert.ok(b.buttons.every((x) => !x.disabled));
  // A later success clears the warning rather than stacking a second note.
  b.panel.setResolved("Kept theirs", true);
  assert.ok(!done.classList.contains("is-warn"));
  assert.equal(done.textContent, "Kept theirs");
});
