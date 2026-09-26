import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ChangesPage } from "./changesPage";

// Squash N Commits…'s message editor (issue #32), in the real page
// commitView.ts serves, in a windowless Chrome: the host's input dialog as a
// textarea pre-filled with every message, the caret at the START — the text
// is there to be edited, and a first keystroke that replaced it all would
// throw the combined messages away — while every other pre-filled input keeps
// selecting its value, as it always has.
//
// GS_SHOTS_DIR set: a screenshot of the editor in each theme lands there.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const MESSAGE = "feat: the parser\n\nReads the header.\n\nwip\n\nfix: an off-by-one";
const SQUASH = {
  kind: "input",
  title: "Squash 3 commits",
  hint: "1a2b3c4, 5d6e7f8 and 9a0b1c2 on main will become one commit with the message below. One later commit will be replayed on top, with a new SHA. Undo is available afterwards.",
  value: MESSAGE,
  multiline: true,
  selectOnOpen: false,
  validate: "nonEmpty",
  confirmLabel: "Squash Commits",
};

interface Field {
  tag: string;
  value: string;
  start: number;
  end: number;
  focused: boolean;
  scrollTop: number;
}
const field = (p: ChangesPage): Promise<Field> =>
  p.eval<Field>(`(function () {
    var t = document.querySelector(".rp-inputwrap textarea, .rp-inputwrap input");
    return t ? { tag: t.tagName, value: t.value, start: t.selectionStart, end: t.selectionEnd, focused: document.activeElement === t, scrollTop: t.scrollTop } : null;
  })()`);

for (const theme of ["dark", "light"] as const) {
  let page: ChangesPage;
  before(async () => {
    if (chrome) page = await ChangesPage.open(theme, { width: 560, height: 640 });
  });
  after(async () => {
    if (page) await page.close();
  });

  test(`the squash editor opens with every message and the caret at the start (${theme})`, { skip }, async () => {
    await page.send({ type: "dialog", dialogId: "sq1", spec: SQUASH });
    await page.page.waitFor(`!!document.querySelector(".rp-inputwrap textarea")`);
    const f = await field(page);
    assert.equal(f.tag, "TEXTAREA");
    assert.equal(f.value, MESSAGE);
    assert.deepEqual([f.start, f.end], [0, 0], "nothing selected: the caret is at the start");
    assert.ok(f.focused, "the editor has the keyboard");
    const title = await page.eval<string>(`(document.querySelector(".rp-dialog .rp-title, .rp-title") || {}).textContent || ""`);
    assert.match(title, /Squash 3 commits/);
    if (process.env.GS_SHOTS_DIR) await page.screenshot(join(process.env.GS_SHOTS_DIR, `ext-squash-editor-${theme}.png`));

    // Typing edits the message rather than replacing it.
    await page.type("feat: one commit\n\n");
    assert.equal((await field(page)).value, "feat: one commit\n\n" + MESSAGE);
    await page.key("Escape");
  });

  test(`any other pre-filled input still selects its value on open (${theme})`, { skip }, async () => {
    await page.send({ type: "dialog", dialogId: "in1", spec: { kind: "input", title: "Rename branch", value: "feature/x", confirmLabel: "Rename" } });
    await page.page.waitFor(`!!document.querySelector(".rp-inputwrap input")`);
    const f = await field(page);
    assert.deepEqual([f.start, f.end], [0, "feature/x".length], "the whole value is selected, so typing replaces it");
    await page.key("Escape");
  });
}
