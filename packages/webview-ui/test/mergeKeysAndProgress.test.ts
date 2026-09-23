import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * Two P1-review findings in the merge view's plumbing:
 *
 * 1. `editor.addCommand` registers into Monaco's PAGE-GLOBAL keybinding
 *    service with no when-clause, so once a MergeView existed, F7 and ⌘Z/⌘Y
 *    in ANY Monaco editor on the page — the desktop's diff, a commit-message
 *    editor — drove the merge's history and navigation. They are scoped to the
 *    merge's own editors by a per-view context key.
 * 2. `counts.hasProgress` flipped to true only in the 120 ms re-align debounce
 *    after a keystroke, so a shell asking "any progress?" right after typing
 *    (the D7 whitespace confirm) was told no, and discarded the typing.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const MOUNT = `
  const W = gsMerge;
  let counts = null;
  const view = new W.MergeView(host);
  view.onCountsChanged = (c) => { counts = c; };
  view.render(W.payload({ op: W.REBASE_OP }));
  const mac = /Mac/.test(navigator.platform);
  /** A real keydown on whatever has the keyboard (memory: harness-synthetic-events). */
  const press = (key, code, keyCode, mods = {}) => {
    const t = document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...mods }));
  };
`;

test("⌘Z in ANOTHER Monaco editor on the page leaves the merge's history alone", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    // Something to undo: accept every Yours change.
    view.acceptAllLeft();
    const afterAccept = counts.pending;
    expect(afterAccept < counts.total, "precondition: the accept changed the counts");
    // Precondition: the key DOES reach the merge from its own editor.
    view.result.focus();
    press("z", "KeyZ", 90, mac ? { metaKey: true } : { ctrlKey: true });
    await sleep(50);
    const undoneHere = counts.pending;
    expect(undoneHere > afterAccept, "precondition: ⌘Z in the merge's own editor undoes the accept (" + undoneHere + ")");
    press("z", "KeyZ", 90, mac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
    await sleep(50);
    expect(counts.pending === afterAccept, "precondition: ⇧⌘Z redoes it");
    // Another editor on the same page — the desktop's diff, a message box.
    const other = document.createElement("div");
    other.style.cssText = "position:absolute;left:0;top:620px;width:400px;height:120px";
    document.body.appendChild(other);
    const ed = W.monaco.editor.create(other, { value: "hello\\n", language: "plaintext" });
    ed.focus();
    ed.trigger("keyboard", "type", { text: "x" });
    press("z", "KeyZ", 90, mac ? { metaKey: true } : { ctrlKey: true });
    await sleep(50);
    expect(counts.pending === afterAccept, "the merge's accept is NOT undone by ⌘Z in another editor (" + counts.pending + ")");
    press("F7", "F7", 118);
    await sleep(50);
    notes.other = ed.getValue();
    ed.dispose();
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("F7 in another Monaco editor does not move the merge", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    view.result.setPosition({ lineNumber: 1, column: 1 });
    const other = document.createElement("div");
    other.style.cssText = "position:absolute;left:0;top:620px;width:400px;height:120px";
    document.body.appendChild(other);
    const ed = W.monaco.editor.create(other, { value: "hello\\n", language: "plaintext" });
    ed.focus();
    press("F7", "F7", 118);
    await sleep(50);
    const pos = view.result.getPosition();
    expect(pos.lineNumber === 1, "the merge's cursor did not jump to a change (" + pos.lineNumber + ")");
    // …while F7 inside the merge still navigates.
    view.result.focus();
    press("F7", "F7", 118);
    await sleep(50);
    expect(view.result.getPosition().lineNumber > 1, "F7 in the merge moves to the next change (" + view.result.getPosition().lineNumber + ")");
    ed.dispose();
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("the 2-way diff's F7 is scoped the same way (the sibling registration)", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    const press = (key, code, keyCode) => {
      const t = document.activeElement || document.body;
      t.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    };
    const dv = new W.DiffView(host);
    dv.render({ leftLabel: "HEAD", rightLabel: "Working", leftText: "a\\nb\\nc\\nd\\ne\\n", rightText: "a\\nB\\nc\\nd\\nE\\n", fileName: "x.txt", rightEditable: false });
    dv.right.setPosition({ lineNumber: 1, column: 1 });
    const other = document.createElement("div");
    other.style.cssText = "position:absolute;left:0;top:620px;width:400px;height:120px";
    document.body.appendChild(other);
    const ed = W.monaco.editor.create(other, { value: "hello\\n", language: "plaintext" });
    ed.focus();
    press("F7", "F7", 118);
    await sleep(50);
    expect(dv.right.getPosition().lineNumber === 1, "F7 elsewhere does not move the diff (" + dv.right.getPosition().lineNumber + ")");
    dv.right.focus();
    press("F7", "F7", 118);
    await sleep(50);
    expect(dv.right.getPosition().lineNumber === 2, "F7 in the diff moves to its next change (" + dv.right.getPosition().lineNumber + ")");
    ed.dispose();
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("typing is progress IMMEDIATELY, not after the re-align debounce", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    expect(counts.hasProgress === false, "fresh");
    view.result.setPosition({ lineNumber: 1, column: 1 });
    view.result.trigger("keyboard", "type", { text: "x" });
    // No sleep: a confirm asked in the same tick must already know.
    expect(counts.hasProgress === true, "hasProgress is true in the same tick as the keystroke");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});
