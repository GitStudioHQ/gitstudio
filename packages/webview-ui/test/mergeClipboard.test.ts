import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, mergePageUrl, runMergePage } from "./fixtures/mergeViewPage";

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

// What VS Code's webview host does with Cmd/Ctrl+C, X and V (its
// pre/index.html): the keydown is prevented, and the workbench then runs
// document.execCommand("copy" | "cut" | "paste") on the webview's focused
// element. On Chromium's EditContext element Cut and Paste do nothing there
// (#84), while Copy still works. The synthetic ClipboardEvents above cannot
// see that: Monaco handles those events on either input. So this runs the
// command itself, as a user gesture over DevTools. Paste needs a DOM-paste
// permission no headless Chrome grants (execCommand("paste") is refused on
// any input), so Cut stands in for it: the same command check, which an
// EditContext element fails.
const EXEC_ROUTE = `(async () => {
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = gsMerge;
  const host = document.getElementById("host");
  const surfaces = {
    "merge Result": () => {
      const v = new W.MergeView(host);
      v.render(W.payload());
      return { v, editable: v.result, side: v.left, text: () => v.getResultText() };
    },
    "editable diff side": () => {
      const v = new W.DiffView(host);
      v.render({ leftLabel: "HEAD", rightLabel: "Working", leftText: "header\\nkeep\\n", rightText: "header\\nkept\\n", fileName: "x.txt", rightEditable: true });
      return { v, editable: v.right, side: v.left, text: () => v.getRightText() };
    },
  };
  let got = null;
  const grab = (e) => { got = e.clipboardData.getData("text/plain"); };
  document.addEventListener("copy", grab);
  document.addEventListener("cut", grab);
  for (const [name, mount] of Object.entries(surfaces)) {
    const { v, editable, side, text } = mount();
    await sleep(50);
    const before = text();
    got = null;
    editable.setSelection(new W.monaco.Selection(1, 1, 1, 7));
    editable.focus();
    document.execCommand("copy");
    expect(got === "header", name + ": execCommand copy puts the selection on the clipboard: " + JSON.stringify(got));
    got = null;
    document.execCommand("cut");
    await sleep(50);
    expect(got === "header", name + ": execCommand cut puts the selection on the clipboard: " + JSON.stringify(got));
    expect(text() === before.slice(6), name + ": execCommand cut removes the selection: " + JSON.stringify(text().slice(0, 12)));
    const sideBefore = side.getValue();
    side.setSelection(new W.monaco.Selection(1, 1, 1, 7));
    side.focus();
    document.execCommand("cut");
    await sleep(50);
    expect(side.getValue() === sideBefore, name + ": execCommand cut cannot change the read-only side");
    v.dispose();
  }
  return { fails };
})()`;

test("VS Code's execCommand route cuts in the merge Result and an editable diff side (#84)", { skip }, async (t) => {
  const { Browser } = await import("../../../scripts/merge-e2e/cdp");
  const had = process.env.GS_CHROME;
  process.env.GS_CHROME = CHROME!;
  let browser: Awaited<ReturnType<typeof Browser.launch>>;
  try {
    browser = await Browser.launch({ width: 1400, height: 800 });
  } catch (err) {
    // cdp.ts drives only a windowless shell (chromeNoNetwork.test.ts skips alike).
    t.skip(`cdp.ts has no browser here: ${(err as Error).message}`);
    return;
  } finally {
    if (had === undefined) delete process.env.GS_CHROME;
    else process.env.GS_CHROME = had;
  }
  try {
    const page = await browser.newPage(1400, 800, 1);
    await browser.goto(page, await mergePageUrl());
    await page.waitFor("window.gsMerge", 20_000, "the merge page's bundle");
    // One evaluation as a user gesture: VS Code runs the command from the
    // person's keypress, and Chrome lets a page write the clipboard only then.
    const r = await page.send<{ result: { value?: { fails: string[] } }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: EXEC_ROUTE,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    assert.deepEqual(r.result.value?.fails, []);
  } finally {
    await browser.close();
  }
});

// The textarea input has one more habit the EditContext one lacked: Monaco
// prevents the default of every Escape typed into it. The shell reads a
// prevented Escape as claimed by the editor, so with the textarea Escape
// stopped being Close from inside a pane. The shell test (mergeShell.test.ts)
// presses Escape on a fake view, which cannot show it; this presses it on the
// real editors' focused input (memory: dispatch on the FOCUSED element).
test("Escape typed in a real editor pane is still Close; one that cancels a selection is not", { skip }, async () => {
  const verdict = await runMergePage(CHROME!, `
    const W = gsMerge;
    const posted = [];
    let view;
    const root = document.createElement("div");
    root.style.cssText = "position:absolute;inset:0";
    document.body.appendChild(root);
    const shell = new W.MergeShell(root, W.payload(), {
      adapter: { post: (m) => posted.push(m) },
      createView: (c) => (view = new W.MergeView(c)),
      isMac: true,
      armMs: 60000,
    });
    await sleep(100);
    const esc = () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    for (const [name, editor] of [["Result", view.result], ["Yours", view.left], ["Theirs", view.right]]) {
      posted.length = 0;
      editor.setSelection(new W.monaco.Selection(1, 1, 1, 4));
      editor.focus();
      await sleep(20);
      expect(document.activeElement && document.activeElement.closest(".monaco-editor"), name + ": the keyboard is in the editor");
      esc();
      await sleep(20);
      expect(editor.getSelection().isEmpty() && posted.length === 0, name + ": Escape with a selection cancels it and does not close (" + JSON.stringify(posted) + ")");
      esc();
      await sleep(20);
      expect(JSON.stringify(posted) === JSON.stringify([{ type: "cancel", mode: "exit" }]), name + ": Escape again is Close (" + JSON.stringify(posted) + ")");
    }
    shell.dispose && shell.dispose();
  `);
  assert.deepEqual(verdict.fails, [], JSON.stringify(verdict.notes));
});
