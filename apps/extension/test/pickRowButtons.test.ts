// A pick row's own buttons (issue #111): Open File at Revision and Line
// History pick a commit to diff it, and each row also carries "Show in Commit
// Graph". Run in headless Chrome from the shipped template (changesViewPage.ts).
//
// The rules the page must keep:
//   · a single pick's row draws its buttons, named for a screen reader; a
//     multi-pick's never does;
//   · pressing a button answers with the row AND the button; the row's own
//     click still answers with the row alone;
//   · Enter on a focused button presses that button — it never picks the row
//     the keyboard's highlight is on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { changesViewPage, findChrome, runChangesView, statePayload } from "./changesViewPage";

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

const spec = {
  kind: "pick",
  title: "Open f.txt at Revision",
  hint: "Pick a revision to diff against your working tree.",
  filter: false,
  choices: ["v3", "v2", "v1"].map((label, i) => ({
    id: String(i),
    label,
    icon: "git-commit",
    detail: `abc000${i}`,
    buttons: [{ id: "showInGraph", icon: "git-commit", title: "Show in Commit Graph" }],
  })),
};

test("a pick row's button answers with the row and the button; the row alone answers with the row", { skip }, async () => {
  const page = changesViewPage({
    theme: "dark",
    harness: `
    post(${JSON.stringify(statePayload())});
    await tick();
    const spec = ${JSON.stringify(spec)};
    const answers = () => posted.filter((m) => m && m.type === "dialogResult");

    post({ type: "dialog", dialogId: "d1", spec });
    await tick();
    let rows = [...document.querySelectorAll(".rp-panel .rp-choice")];
    expect(rows.length === 3, "three rows: " + rows.length);
    const btns = rows.map((r) => r.querySelector("button.rp-choice-btn"));
    expect(btns.every((b) => b && b.getAttribute("aria-label") === "Show in Commit Graph"
      && (b.title || b.dataset.tip) === "Show in Commit Graph"), "every row has its named button, with its tooltip");
    expect(btns.every((b) => b.classList.contains("codicon-git-commit")), "drawn with its icon");
    const box = btns[1].getBoundingClientRect();
    expect(box.width > 8 && box.height > 8, "the button has a size: " + box.width + "x" + box.height);
    expect(getComputedStyle(btns[1]).cursor === "pointer", "and reads as pressable");
    btns[1].click();
    let a = answers().pop();
    expect(a && a.dialogId === "d1" && a.dialogValue === "1" && a.dialogButton === "showInGraph",
      "the button answers with its row and itself: " + JSON.stringify(a));
    expect(!document.querySelector(".rp-panel"), "and closes the list");

    post({ type: "dialog", dialogId: "d2", spec });
    await tick();
    document.querySelectorAll(".rp-panel .rp-choice")[2].click();
    a = answers().pop();
    expect(a && a.dialogId === "d2" && a.dialogValue === "2" && !("dialogButton" in a),
      "the row's own click answers with the row alone: " + JSON.stringify(a));

    // Enter on a focused button: the button, not the highlighted first row.
    post({ type: "dialog", dialogId: "d3", spec });
    await tick();
    const third = document.querySelectorAll(".rp-panel .rp-choice")[2].querySelector("button.rp-choice-btn");
    third.focus();
    expect(document.activeElement === third, "Tab can reach a row's button");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    third.dispatchEvent(enter);
    expect(!enter.defaultPrevented, "the panel leaves the key to the button");
    expect(!answers().some((m) => m.dialogId === "d3"), "Enter on the button did not pick the highlighted row");
    third.click(); // what the browser does with an Enter it was left
    a = answers().pop();
    expect(a && a.dialogId === "d3" && a.dialogValue === "2" && a.dialogButton === "showInGraph", JSON.stringify(a));

    // A multi-pick draws no row buttons.
    post({ type: "dialog", dialogId: "d4", spec: { ...spec, kind: "multiPick", confirmLabel: "OK" } });
    await tick();
    expect(document.querySelectorAll(".rp-panel .rp-choice").length === 3, "the multi-pick opens");
    expect(!document.querySelector(".rp-panel .rp-choice-btn"), "with no row buttons");
    `,
  });
  const v = await runChangesView(CHROME!, page);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});
