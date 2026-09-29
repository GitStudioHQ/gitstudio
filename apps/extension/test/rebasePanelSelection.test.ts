import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MOD, RebasePanelPage, type Mods } from "./rebasePanelPage";

// The Interactive Rebase workspace with a long plan (issue #32: "in
// interactive rebase when doing e.g. 10 commits, I would love to select
// multiple and set the action at once"), in the real page the panel serves,
// in a windowless Chrome, with real key and mouse events.
//
// The rules are the shared engine's (engine/rebase/planEdit, unit-tested
// there); what these pin is that THIS page wires every one of them — the
// same tables the desktop's harness runs against its Rebase view:
//   · the keyboard: arrows move and the selection follows; Shift grows it
//     from the anchor; Home/End; Cmd/Ctrl+A; Escape collapses, and is left
//     alone when there is nothing to collapse;
//   · the pointer: plain, Cmd/Ctrl, Shift, both; a row's own dropdown;
//   · the action: git's todo letters and the toolbar set every selected row,
//     a modifier or a message box's typing does not; squash across a
//     selection folds into the kept commit below it, or keeps the oldest when
//     none is; the reason is said where it can be seen;
//   · moving: Alt+Up/Down and a drag carry the selection;
//   · and what reaches the host: the rows, in order, with their actions.

const chrome = RebasePanelPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: RebasePanelPage;
const N = 12;

before(async () => {
  if (chrome) page = await RebasePanelPage.open("dark", { height: 640 });
});
after(async () => {
  if (page) await page.close();
});

/** Start from a fresh plan: Reset, then the first row focused and selected. */
async function fresh(): Promise<void> {
  await page.eval(`(function () {
    document.getElementById("rb-reset").click();
    document.getElementById("rb-banner").hidden = true;
    window.__posted.length = 0;
  })()`);
  await page.clickRow(0);
}

interface Snap {
  selected: string;
  painted: string;
  focus: number;
  count: string;
  actions: string;
  order: string;
}
async function snap(): Promise<Snap> {
  return page.eval<Snap>(`(function () {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".rb-list .rb-row:not(.rb-base)"));
    var idx = function (pred) { return rows.map(function (r, i) { return pred(r) ? i : -1; }).filter(function (i) { return i >= 0; }).join(","); };
    // Painted = the row's computed background differs from the "onto" row's,
    // which is never selected and never hovered: a class with no rule behind
    // it would pass a class check.
    var plainBg = getComputedStyle(document.querySelector(".rb-row.rb-base")).backgroundColor;
    return {
      selected: idx(function (r) { return r.getAttribute("aria-selected") === "true"; }),
      painted: idx(function (r) { return getComputedStyle(r).backgroundColor !== plainBg; }),
      focus: rows.indexOf(document.activeElement),
      count: document.getElementById("rb-selcount").textContent,
      actions: rows.map(function (r) { return r.querySelector(".rb-action").value; }).join(","),
      order: rows.map(function (r) { return parseInt(r.dataset.sha.slice(0, 4), 16) - 1; }).join(","),
    };
  })()`);
}
const range = (a: number, b: number): string =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i).join(",");

test("the keyboard: arrows, Shift, Home/End, Cmd/Ctrl+A and Escape, cell by cell", { skip }, async () => {
  await fresh();
  let s = await snap();
  assert.equal(s.selected, "0");
  assert.equal(s.count, "1 selected");
  const tabStops = await page.eval<number>(`document.querySelectorAll(".rb-row[tabindex='0']").length`);
  assert.equal(tabStops, 1, "the list is one tab stop");
  const table: Array<[string, Mods, string, number]> = [
    ["ArrowDown", {}, "1", 1],
    ["ArrowDown", { shift: true }, "1,2", 2],
    ["ArrowDown", { shift: true }, "1,2,3", 3],
    ["ArrowUp", { shift: true }, "1,2", 2],
    ["ArrowUp", { shift: true }, "1", 1],
    ["ArrowUp", { shift: true }, "0,1", 0],
    ["ArrowUp", { shift: true }, "0,1", 0],
    ["End", { shift: true }, range(1, N - 1), N - 1],
    ["Home", {}, "0", 0],
    ["ArrowUp", {}, "0", 0],
    ["End", {}, String(N - 1), N - 1],
    ["ArrowDown", {}, String(N - 1), N - 1],
    ["Home", { shift: true }, range(0, N - 1), 0],
    ["Escape", {}, "0", 0],
    ["a", MOD, range(0, N - 1), 0],
    ["ArrowDown", {}, "1", 1],
  ];
  for (const [key, mods, sel, focus] of table) {
    const before = (await snap()).selected;
    await page.key(key, mods);
    s = await snap();
    const what = `${Object.keys(mods).join("+")}${Object.keys(mods).length ? "+" : ""}${key} from [${before}]`;
    assert.equal(s.selected, sel, `${what}: the selection`);
    assert.equal(s.painted, sel, `${what}: exactly those rows are painted selected`);
    assert.equal(s.focus, focus, `${what}: the row the keyboard is on`);
  }
  await page.key("ArrowDown", { shift: true });
  await page.key("ArrowDown", { shift: true });
  assert.equal((await snap()).count, "3 selected");

  // The row the keyboard reaches is on screen, clear of both bars — focus
  // alone scrolls to the window's edge, under the header or the footer.
  const clear = (): Promise<{ top: number; bottom: number; head: number; foot: number }> =>
    page.eval(`(function () {
      var r = document.activeElement.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom),
        head: Math.round(document.querySelector(".rb-head").getBoundingClientRect().bottom),
        foot: Math.round(document.getElementById("rb-foot").getBoundingClientRect().top) };
    })()`);
  await page.key("End");
  let at = await clear();
  assert.ok(at.bottom <= at.foot, `End: the last commit clears the footer (${at.bottom} vs ${at.foot})`);
  await page.key("Home");
  at = await clear();
  assert.ok(at.top >= at.head, `Home: the first commit clears the header (${at.top} vs ${at.head})`);
  await page.key("ArrowDown");
  await page.key("ArrowDown", { shift: true });
  await page.key("ArrowDown", { shift: true });
  // Escape on one row is not the list's: it is not swallowed.
  await page.key("Escape");
  const claimed = await page.eval<boolean>(`(function () {
    var e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
  assert.equal(claimed, false, "Escape on a single selection is left alone");
});

test("the pointer: plain, Cmd/Ctrl, Shift and both; a row's own dropdown", { skip }, async () => {
  await fresh();
  const table: Array<[number, Mods, string]> = [
    [1, {}, "1"],
    [3, MOD, "1,3"],
    [5, { shift: true }, "3,4,5"],
    [0, { shift: true, ...MOD }, "0,1,2,3,4,5"],
    [2, MOD, "0,1,3,4,5"],
    [4, {}, "4"],
    [4, MOD, ""],
    [6, {}, "6"],
  ];
  for (const [i, mods, sel] of table) {
    await page.clickRow(i, mods);
    const s = await snap();
    assert.equal(s.selected, sel, `click row ${i} ${JSON.stringify(mods)}: the selection`);
    assert.equal(s.painted, sel, `click row ${i} ${JSON.stringify(mods)}: and what is painted`);
  }
  assert.equal((await snap()).focus, 6, "the clicked row has the keyboard");
  const textSelected = await page.eval<boolean>(`!window.getSelection().isCollapsed`);
  assert.equal(textSelected, false, "Shift-clicks selected rows, not the text between them");

  // A row's dropdown, clicked: its row becomes the selection…
  const dd = await page.centre(".rb-action", 2);
  await page.eval(`document.querySelectorAll(".rb-list .rb-row:not(.rb-base)")[2].querySelector(".rb-action").focus()`);
  await page.settle();
  assert.equal((await snap()).selected, "2", "focusing a row's dropdown selects its row");
  // …and inside a selection keeps it.
  await page.clickRow(4, { shift: true });
  await page.eval(`document.querySelectorAll(".rb-list .rb-row:not(.rb-base)")[3].querySelector(".rb-action").focus()`);
  await page.settle();
  assert.equal((await snap()).selected, "2,3,4", "a dropdown inside the selection leaves it alone");
  void dd;

  // None selected: said, and the toolbar is closed.
  await page.clickRow(2);
  await page.clickRow(2, MOD);
  const t = await page.eval<{ count: string; disabled: boolean[] }>(`({
    count: document.getElementById("rb-selcount").textContent,
    disabled: Array.prototype.map.call(document.querySelectorAll(".rb-set"), function (b) { return b.disabled; }),
  })`);
  assert.equal(t.count, "None selected");
  assert.deepEqual(t.disabled, [true, true, true, true, true, true]);
});

test("the action: git's letters and the toolbar set every selected row; nothing else does", { skip }, async () => {
  await fresh();
  const words = await page.eval<Array<{ text: string; title: string }>>(
    `Array.prototype.map.call(document.querySelectorAll(".rb-set"), function (b) { return { text: b.textContent, title: b.title }; })`,
  );
  assert.deepEqual(words.map((w) => w.text), ["Pick", "Reword", "Squash", "Fixup", "Edit", "Drop"]);
  words.forEach((w, i) => assert.ok(w.title.endsWith(`(${"PRSFED"[i]})`), `${w.text}'s tooltip names its key: ${w.title}`));
  assert.equal(
    await page.eval(`Array.prototype.map.call(document.querySelectorAll(".rb-hint .rb-kbd"), function (k) { return k.textContent; }).join("")`),
    "PRSFED",
    "the hint names all six keys",
  );

  await page.clickRow(2, { shift: true });
  await page.key("d");
  let s = await snap();
  assert.equal(s.actions.split(",").slice(0, 3).join(","), "drop,drop,drop", "D drops every selected commit");
  assert.ok(s.actions.split(",").slice(3).every((a) => a === "pick"), "and nothing else");
  assert.equal(s.selected, "0,1,2", "the selection survives");
  assert.equal(s.focus, 2, "and so does the keyboard");

  const edit = await page.centre(".rb-set.a-edit");
  await page.clickAt(edit.x, edit.y);
  s = await snap();
  assert.equal(s.actions.split(",").slice(0, 3).join(","), "edit,edit,edit", "the toolbar's Edit sets all three");
  const bg = await page.eval<{ edit: string; pick: string }>(`({
    edit: getComputedStyle(document.querySelector(".rb-set.a-edit")).backgroundColor,
    pick: getComputedStyle(document.querySelector(".rb-set.a-pick")).backgroundColor,
  })`);
  assert.notEqual(bg.edit, bg.pick, "the toolbar shows Edit as what they are set to");

  // One row's dropdown sets that row only.
  await page.eval(`(function () {
    var sel = document.querySelectorAll(".rb-list .rb-row:not(.rb-base)")[1].querySelector(".rb-action");
    sel.value = "reword"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.settle();
  assert.equal((await snap()).actions.split(",").slice(0, 3).join(","), "edit,reword,edit");

  // What must not set anything.
  await page.clickRow(0);
  await page.clickRow(2, { shift: true });
  const before = (await snap()).actions;
  await page.key("d", MOD);
  assert.equal((await snap()).actions, before, "Cmd/Ctrl+D is not D");
  await page.key("p", { alt: true });
  assert.equal((await snap()).actions, before, "nor is Alt+P");
  await page.eval(`document.querySelectorAll(".rb-list .rb-row:not(.rb-base)")[1].querySelector(".rb-reword textarea").focus()`);
  await page.key("d");
  s = await snap();
  assert.equal(s.actions, before, "D typed into a message is a letter, not a drop");
  const typed = await page.eval<string>(`document.querySelectorAll(".rb-list .rb-row:not(.rb-base)")[1].querySelector(".rb-reword textarea").value`);
  assert.ok(typed.endsWith("d"), `and it was typed (${typed})`);
});

test("squash across a selection folds into the kept commit below it, or keeps the oldest, and the reason is on screen", { skip }, async () => {
  await fresh();
  // The ordinary case: a block in the middle folds, every commit of it, into
  // the kept commit under the block — nothing refused, nothing said.
  await page.clickRow(3);
  await page.clickRow(5, { shift: true });
  await page.key("s");
  const mid = (await snap()).actions.split(",");
  assert.equal(mid.slice(3, 6).join(","), "squash,squash,squash", "every selected commit folds, the oldest of them too");
  assert.ok(mid.slice(0, 3).concat(mid.slice(6)).every((a) => a === "pick"), `and nothing else changes (${mid})`);
  assert.equal(await page.eval(`document.getElementById("rb-banner").hidden`), true, "nothing was refused, so nothing is said");
  await page.key("p");
  assert.ok((await snap()).actions.split(",").every((a) => a === "pick"), "P puts them back");

  // Nothing kept below: the oldest stays, for the rest to fold into.
  await page.clickRow(N - 1);
  await page.key("s");
  let s = await snap();
  assert.equal(s.actions.split(",")[N - 1], "pick", "S on the oldest commit alone changes nothing");
  const banner = () =>
    page.eval<{ text: string; onScreen: boolean }>(`(function () {
      var b = document.getElementById("rb-banner");
      var r = b.getBoundingClientRect();
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: b.hidden ? "" : b.textContent, onScreen: !b.hidden && r.height > 0 && r.bottom <= innerHeight && !!hit && b.contains(hit) };
    })()`);
  let b = await banner();
  assert.match(b.text, /The oldest commit you keep can't be a squash — there's nothing below it to fold into\./);
  assert.ok(b.onScreen, "said where it can be read, however long the plan");

  await page.key("a", MOD);
  await page.key("s");
  s = await snap();
  const acts = s.actions.split(",");
  assert.ok(acts.slice(0, N - 1).every((a) => a === "squash"), `every newer commit folds (${s.actions})`);
  assert.equal(acts[N - 1], "pick", "the oldest stays, for the rest to fold into");
  b = await banner();
  assert.match(b.text, new RegExp(`Squash set on ${N - 1} commits\\. The oldest one stays Pick`));
  assert.ok(b.onScreen, "and said on screen");
  assert.equal(await page.eval(`document.getElementById("rb-apply").disabled`), false, "the plan can be started");

  // The toolbar is the same door.
  await page.clickRow(N - 1);
  const fixup = await page.centre(".rb-set.a-fixup");
  await page.clickAt(fixup.x, fixup.y);
  assert.equal((await snap()).actions.split(",")[N - 1], "pick");
  assert.match((await banner()).text, /can't be a fixup/);

  // And what reaches the host: every row, in order, with its action.
  await page.eval(`window.__posted.length = 0; document.getElementById("rb-apply").click()`);
  await page.settle();
  const posted = await page.posted();
  const apply = posted.find((m) => m.type === "apply") as { rows: Array<{ sha: string; action: string }> } | undefined;
  assert.ok(apply, "Start Rebase posts the plan");
  assert.deepEqual(
    apply!.rows.map((r) => r.action),
    [...Array(N - 1).fill("squash"), "pick"],
    "the host is sent exactly what the rows say",
  );
  await page.eval(`window.__send({ type: "result", outcome: { status: "failed", message: "x", expected: true } })`);
});

test("moving: Alt+Up/Down and a drag carry the selection", { skip }, async () => {
  await fresh();
  const head = async (n = 4): Promise<string> => (await snap()).order.split(",").slice(0, n).join(",");
  await page.clickRow(1);
  await page.clickRow(2, { shift: true });
  await page.key("ArrowUp", { alt: true });
  assert.equal(await head(), "1,2,0,3", "the block moves up one, together");
  let s = await snap();
  assert.equal(s.selected, "0,1", "still selected where it went");
  assert.equal(s.focus, 1, "and the keyboard went with it");
  await page.key("ArrowUp", { alt: true });
  assert.equal(await head(), "1,2,0,3", "against the top it stays");
  await page.key("ArrowDown", { alt: true });
  await page.key("ArrowDown", { alt: true });
  assert.equal(await head(), "0,3,1,2", "and down again, together");

  await page.clickRow(0);
  await page.clickRow(2, MOD);
  await page.key("ArrowDown", { alt: true });
  assert.equal(await head(), "3,0,2,1", "a scattered selection: each row one step");
  assert.equal((await snap()).selected, "1,3");

  // A drag: the pointer's DataTransfer cannot be scripted through CDP, so the
  // drag events are the page's own — fired on the rows, at real row halves.
  const drag = (from: number, onto: number, where: "before" | "after"): Promise<number> =>
    page.eval<number>(`(function () {
      var rows = document.querySelectorAll(".rb-list .rb-row:not(.rb-base)");
      var dt = new DataTransfer();
      var fire = function (type, el, y) {
        var e = new DragEvent(type, { bubbles: true, cancelable: true, clientY: y });
        Object.defineProperty(e, "dataTransfer", { value: dt });
        el.dispatchEvent(e);
      };
      var r = rows[${onto}].getBoundingClientRect();
      var y = r.top + r.height * (${JSON.stringify(where)} === "before" ? 0.25 : 0.75);
      fire("dragstart", rows[${from}], 0);
      var lifted = document.querySelectorAll(".rb-list .rb-row.dragging").length;
      fire("dragover", rows[${onto}], y);
      var line = rows[${onto}].classList.contains(${JSON.stringify(where === "before" ? "drop-before" : "drop-after")});
      fire("drop", rows[${onto}], y);
      fire("dragend", rows[${from}], 0);
      return line ? lifted : -1;
    })()`);
  const beforeDrag = (await snap()).order.split(",");
  await page.clickRow(0);
  await page.clickRow(1, { shift: true });
  assert.equal(await drag(1, 3, "after"), 2, "picking up a selected row lifts the selection, and the line is drawn below");
  await page.settle();
  s = await snap();
  assert.equal(
    s.order,
    [beforeDrag[2], beforeDrag[3], beforeDrag[0], beforeDrag[1], ...beforeDrag.slice(4)].join(","),
    "both land in the gap the line was drawn at, in order",
  );
  assert.equal(s.selected, "2,3");
  const beforeOne = s.order.split(",");
  assert.equal(await drag(6, 0, "before"), 1, "an unselected row is lifted alone");
  await page.settle();
  s = await snap();
  assert.equal(s.order.split(",")[0], beforeOne[6], "and lands above the row the line was drawn over");
  assert.equal(s.selected, "0");
});

test("VS Code's own Select All does not paint the page after Cmd/Ctrl+A", { skip }, async () => {
  await fresh();
  await page.key("a", MOD);
  // What VS Code runs in the webview when it hears Cmd/Ctrl+A.
  await page.eval(`document.execCommand("selectAll")`);
  await page.settle(120);
  assert.equal(await page.eval(`window.getSelection().isCollapsed`), true, "no page text is left selected");
  assert.equal((await snap()).selected, range(0, N - 1), "the rows are");
});

// A rebase that stops (a conflict, an edit) leaves the list editable and puts
// the way out — Continue Rebase, Skip, Abort Rebase — in the banner. The
// refusals the Set action bar and the P R S F E D keys made one keystroke away
// borrow that same banner: each must give it BACK, never leave a paused
// rebase with no way out on the page. The flash lasts 4 s, so these wait.
// (Last in the file: it leaves the page paused.)
test("a refusal borrows a paused rebase's banner and gives it back", { skip }, async () => {
  await fresh();
  const stopped = `window.__send({ type: "result", outcome: { status: "stopped", reason: "conflict", message: "" }, stop: { conflicts: 1, canSkip: true } })`;
  const banner = () =>
    page.eval<{ shown: boolean; text: string; buttons: string[] }>(`(function () {
      var b = document.getElementById("rb-banner");
      return { shown: !b.hidden && b.getBoundingClientRect().height > 0, text: b.textContent,
        buttons: Array.prototype.map.call(b.querySelectorAll("button"), function (x) { return x.textContent; }) };
    })()`);
  const wayOut = ["Resolve Conflicts…", "Continue Rebase", "Skip this commit", "Abort Rebase"];
  // A keypress re-renders the banner on the page's own schedule; a busy CI
  // runner read it before the refusal was painted. Wait for the words, capped.
  const bannerSays = async (re: RegExp) => {
    for (let i = 0; i < 40; i++) {
      const now = await banner();
      if (re.test(now.text)) return now;
      await page.settle(50);
    }
    return banner();
  };

  await page.eval(stopped);
  await page.settle();
  let b = await banner();
  assert.ok(b.shown, "the paused rebase's banner is up");
  assert.deepEqual(b.buttons, wayOut, "with its way out");

  // [what happens, then the banner once the flash is over]
  // 1 · a refused squash borrows it…
  await page.clickRow(N - 1);
  await page.key("s");
  b = await bannerSays(/oldest commit you keep can't be a squash/);
  assert.match(b.text, /oldest commit you keep can't be a squash/, "a refusal is said in its place");
  await page.settle(4300);
  b = await banner();
  assert.ok(b.shown, "…and when it is over the banner is back up");
  assert.deepEqual(b.buttons, wayOut, "with Continue, Skip and Abort");
  assert.match(b.text, /Rebase paused on a conflict/, "saying why the rebase paused");

  // 2 · a flash that is still running when the rebase stops (again) must not
  // hide the stop banner when its timer ends — nor rebuild it from under a
  // keyboard that went to its Continue Rebase.
  await page.key("s");
  await page.eval(stopped);
  await page.eval(`Array.prototype.find.call(document.querySelectorAll("#rb-banner button"), function (x) { return x.textContent === "Continue Rebase"; }).focus()`);
  await page.settle(4300);
  b = await banner();
  assert.ok(b.shown, "a stop that lands during a flash outlives the flash's timer");
  assert.deepEqual(b.buttons, wayOut);
  assert.equal(
    await page.eval(`document.activeElement && document.activeElement.isConnected ? document.activeElement.textContent : ""`),
    "Continue Rebase",
    "and the keyboard is still on Continue Rebase",
  );

  // 3 · Reset plan, mid-pause, resets the rows — the rebase is still paused.
  await page.eval(`document.getElementById("rb-reset").click()`);
  await page.settle();
  b = await banner();
  assert.ok(b.shown, "Reset plan keeps the paused rebase's way out");
  assert.deepEqual(b.buttons, wayOut);

  // 4 · Handing the banner back moves nobody's keyboard — not even to the
  // verb used last, where the next Enter would run it. (A NEW stop does go
  // back to that verb; this is the same stop, returned.)
  await page.eval(`Array.prototype.find.call(document.querySelectorAll("#rb-banner button"), function (x) { return x.textContent === "Continue Rebase"; }).click()`);
  await page.eval(stopped); // Continue ran, and the rebase paused again
  await page.settle();
  await page.clickRow(N - 1);
  await page.key("s");
  assert.match((await bannerSays(/can't be a squash/)).text, /can't be a squash/);
  await page.eval(`document.activeElement.blur()`);
  await page.settle(4300);
  b = await banner();
  assert.deepEqual(b.buttons, wayOut, "the banner is handed back");
  assert.equal(await page.eval(`document.activeElement === document.body`), true, "and the keyboard is left where it was");
});
