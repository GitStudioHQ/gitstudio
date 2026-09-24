import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The 2-way DiffView's copy arrow (left change → the editable right pane) at
 * the EDGES of the file — the twin of the merge view's accept writes, which
 * P1's review fixed there and found here (memory: fix-both-siblings).
 *
 * Copying every change from left to right must reproduce the left text byte
 * for byte. It did not: restoring a deleted unterminated last line glued it
 * onto the line above ("a\nbc\n" — line b corrupted), restoring one deleted
 * blank line and a removed final newline were no-ops, and undoing a line
 * added at the end left a trailing break. The writes now go through the same
 * line rules as the merge view (lineEdits.ts), and the arrows' repaint races a
 * timer instead of waiting on requestAnimationFrame alone.
 *
 * Latent in today's hosts (every caller passes rightEditable:false), live as
 * soon as an editable write-back diff routes through the shared view.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

test("copying every change reproduces the left text exactly, at the edges of the file too", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const { EndOfLineSequence } = gsMerge.monaco.editor;
    const cases = [
      ["restore a deleted last line (unterminated)", "a\\nb\\nc", "a\\nb"],
      ["restore a deleted last line (terminated)", "a\\nb\\nc\\n", "a\\nb\\n"],
      ["restore one deleted blank line", "a\\n\\nb", "a\\nb"],
      ["restore a removed final newline", "a\\nb\\n", "a\\nb"],
      ["undo a line added at the end", "a\\nb", "a\\nb\\nc"],
      ["undo a line added at the end (terminated)", "a\\nb\\n", "a\\nb\\nc\\n"],
      ["restore a deleted first line", "x\\na\\nb", "a\\nb"],
      ["restore the whole file into an empty one", "a\\nb", ""],
      ["restore a deleted last line into a one-line file", "a\\nb", "a"],
      ["empty the file", "", "a\\nb\\n"],
      ["middle and end at once", "a\\nB\\nc\\nd", "a\\nb\\nc"],
    ];
    // Every case three ways. As this platform makes the panes. With every
    // pane that has no line break of its own made CRLF — what Monaco does on
    // Windows, where a model with nothing to detect takes the platform's
    // line ending; CI's windows job restored "a\\nb" into an empty file as
    // "a\\r\\nb". And with both texts in CRLF, which the copy must keep
    // (here, a pane with no line break is made LF).
    const ways = [
      ["", (t) => t, false],
      ["panes made CRLF (Windows): ", (t) => t, true],
      ["CRLF text: ", (t) => t.replace(/\\n/g, "\\r\\n"), false],
    ];
    for (const [way, as, windows] of ways) {
      for (const [name, l, r] of cases) {
        const left = as(l);
        const right = as(r);
        host.replaceChildren();
        const dv = new gsMerge.DiffView(host);
        dv.render({ leftLabel: "HEAD", rightLabel: "Working", leftText: left, rightText: right, fileName: "x.txt", rightEditable: true });
        if (windows) {
          for (const e of [dv.left, dv.right]) {
            if (e.getModel().getLineCount() === 1) e.getModel().setEOL(EndOfLineSequence.CRLF);
          }
        }
        for (const b of [...dv.model.blocks].reverse()) dv.transferBlock(b);
        const got = dv.getRightText();
        expect(got === left, way + name + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(left));
        dv.dispose && dv.dispose();
      }
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("text the host pushes into a pane keeps its own line endings, whatever the pane was made with", { skip }, async () => {
  // A pane made from text with no line break takes the PLATFORM's line
  // ending (CRLF on Windows), and a refresh wrote its text in that one: a
  // file that was empty when the diff opened and gained LF lines outside it
  // read back CRLF from the pane that writes it back.
  const v = await runMergePage(CHROME!, `
    const { EndOfLineSequence } = gsMerge.monaco.editor;
    for (const [made, eol] of [["CRLF", EndOfLineSequence.CRLF], ["LF", EndOfLineSequence.LF]]) {
      host.replaceChildren();
      const dv = new gsMerge.DiffView(host);
      const p = { leftLabel: "HEAD", rightLabel: "Working", leftText: "a\\nb", rightText: "", fileName: "x.txt", rightEditable: true };
      dv.render(p);
      dv.right.getModel().setEOL(eol);
      // Setting it reads as the user's own edit; a refresh waits a second
      // after one, so as not to overwrite typing.
      await sleep(1100);
      for (const right of ["p\\nq", "p\\r\\nq\\r\\n", "", "p\\nq\\n"]) {
        dv.render({ ...p, rightText: right });
        const got = dv.getRightText();
        expect(got === right, "a pane made " + made + ", refreshed with " + JSON.stringify(right) + ": got " + JSON.stringify(got));
      }
      dv.dispose && dv.dispose();
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a copy leaves the NEIGHBOURING change where it was (no forced marker moves)", { skip }, async () => {
  // Two changes around one kept line: copying the first must not drag the
  // second's lines with it.
  const v = await runMergePage(CHROME!, `
    host.replaceChildren();
    const dv = new gsMerge.DiffView(host);
    const left = "a\\nX\\nkeep\\nY\\nz";
    dv.render({ leftLabel: "HEAD", rightLabel: "Working", leftText: left, rightText: "a\\nkeep\\nz", fileName: "x.txt", rightEditable: true });
    const [first] = dv.model.blocks;
    dv.transferBlock(first);
    expect(dv.getRightText() === "a\\nX\\nkeep\\nz", "first copy: " + JSON.stringify(dv.getRightText()));
    const second = dv.model.blocks[0];
    dv.transferBlock(second);
    expect(dv.getRightText() === left, "second copy: " + JSON.stringify(dv.getRightText()));
  `);
  assert.deepEqual(v.fails, []);
});

test("the copy arrows appear without an animation frame", { skip }, async () => {
  // scheduleButtons waited on requestAnimationFrame alone; an occluded window
  // or a headless run is served no frames, and the arrows never came.
  const v = await runMergePage(CHROME!, `
    window.requestAnimationFrame = () => 0;
    host.replaceChildren();
    const dv = new gsMerge.DiffView(host);
    dv.render({ leftLabel: "HEAD", rightLabel: "Working", leftText: "a\\nb\\nc", rightText: "a\\nc", fileName: "x.txt", rightEditable: true });
    // What a scroll or a resize does: throw the arrows away and ask for a
    // repaint (render() itself paints synchronously, so it proves nothing).
    document.querySelector(".jb-button-layer").replaceChildren();
    dv.scheduleButtons();
    await sleep(120);
    const arrows = document.querySelectorAll(".jb-change-actions .jb-btn-accept").length;
    notes.arrows = arrows;
    expect(arrows === 1, "one copy arrow for the one change, with no frame serviced (" + arrows + ")");
  `);
  assert.deepEqual(v.fails, []);
});
