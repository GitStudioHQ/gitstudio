import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

test("merge result has a native clipboard input and supports undoable paste/cut", { skip }, async () => {
  const verdict = await runMergePage(CHROME!, `
    const W = gsMerge;
    let counts;
    const view = new W.MergeView(host);
    view.onCountsChanged = (next) => { counts = next; };
    view.render(W.payload());
    const original = view.getResultText();
    const result = view.result;
    result.setSelection(new W.monaco.Selection(1, 1, 1, 7));
    result.focus();
    await sleep(50);
    expect(document.activeElement instanceof HTMLTextAreaElement,
      "clipboard commands target Monaco's textarea, not a non-editable EditContext div");

    // Headless scripts have no trusted user gesture for the OS clipboard.
    // Drive the browser events that native commands deliver to the input.
    const clipboardEvent = (type, text = "") => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      document.activeElement.dispatchEvent(new ClipboardEvent(type, {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
      return data.getData("text/plain");
    };
    const copied = clipboardEvent("copy");
    expect(copied === "header", "Copy puts the result selection on the clipboard: " + copied);
    expect(view.getResultText() === original, "Copy does not modify the result");

    // Synthetic paste carries real ClipboardEvent data: no OS clipboard read
    // permissions or machine clipboard contents are needed by this test.
    clipboardEvent("paste", "pasted\\nsecond");
    await sleep(300);
    expect(view.getResultText() === original.replace("header", "pasted\\nsecond"),
      "Paste replaces the selection with multiline text: " + JSON.stringify(view.getResultText()));
    expect(counts.hasProgress, "Paste immediately marks the merge as edited");
    view.undo();
    expect(view.getResultText() === original, "merge Undo restores pasted text");
    view.redo();
    expect(view.getResultText().startsWith("pasted\\nsecond"), "merge Redo restores the paste");
    view.undo();

    result.setSelection(new W.monaco.Selection(1, 1, 1, 7));
    result.focus();
    await sleep(300);
    const cut = clipboardEvent("cut");
    await sleep(50);
    expect(cut === "header", "Cut copies the selected text: " + cut);
    expect(view.getResultText() === original.slice(6), "Cut removes only the result selection");
    view.undo();
    expect(view.getResultText() === original, "merge Undo restores cut text");
    view.dispose();
  `);
  assert.deepEqual(verdict.fails, [], JSON.stringify(verdict.notes));
});

test("side panes remain read-only and retain native Copy after rebuilding the merge", { skip }, async () => {
  const verdict = await runMergePage(CHROME!, `
    const W = gsMerge;
    const view = mountView(W.payload());
    view.reset();
    for (const editor of [view.left, view.right]) {
      editor.setSelection(new W.monaco.Selection(1, 1, 1, 7));
      editor.focus();
      await sleep(50);
      expect(document.activeElement instanceof HTMLTextAreaElement, "side pane has a native clipboard input");
      const copied = new DataTransfer();
      document.activeElement.dispatchEvent(new ClipboardEvent("copy", {
        clipboardData: copied, bubbles: true, cancelable: true,
      }));
      expect(copied.getData("text/plain") === "header", "side selection can be copied");
      const before = editor.getValue();
      document.activeElement.dispatchEvent(new ClipboardEvent("cut", {
        clipboardData: new DataTransfer(), bubbles: true, cancelable: true,
      }));
      const data = new DataTransfer();
      data.setData("text/plain", "must not change a side");
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
      await sleep(50);
      expect(editor.getValue() === before, "Cut and Paste cannot modify read-only sides");
    }
    view.result.focus();
    expect(document.activeElement instanceof HTMLTextAreaElement,
      "rebuilt result still uses native clipboard-compatible input");
    view.dispose();
  `);
  assert.deepEqual(verdict.fails, [], JSON.stringify(verdict.notes));
});
