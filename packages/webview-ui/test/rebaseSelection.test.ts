import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

/**
 * The editor for a hand-run `git rebase -i` (<gitstudio-rebase>, the
 * extension's git-rebase-todo custom editor) with several rows selected
 * (issue #32), mounted by its real webview entry and fed the host's init
 * message, in headless Chrome.
 *
 * The rules are the shared engine's (engine/rebase/planEdit, unit-tested
 * there); what these pin is that this element wires every one of them — the
 * same tables the extension's workspace and the desktop's Rebase view run —
 * in GIT'S order: oldest at the top, so a squash folds into the row above
 * it and the first row can never be one.
 *
 * Keys go to the element that has focus (the shadow root's activeElement),
 * never to document: a handler that asks e.target.closest() throws on a
 * document target, and the check would pass on a broken build.
 */
const MAIN = fileURLToPath(new URL("../src/rebase/main.ts", import.meta.url));
const CHROME = findChrome();

/** VS Code's own values for the tokens this editor reads that themes.ts has no need for. */
const EXTRA: Record<"dark" | "light", Record<string, string>> = {
  dark: { "--vscode-list-inactiveSelectionBackground": "#37373d", "--vscode-editor-background": "#1e1e1e" },
  light: { "--vscode-list-inactiveSelectionBackground": "#e4e6f1", "--vscode-editor-background": "#ffffff" },
};
const themeCss = (theme: "dark" | "light"): string =>
  `html{${Object.entries({ ...VSCODE_THEMES[theme as VsCodeTheme], ...EXTRA[theme] })
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}} #root{height:760px;width:1000px}`;

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return { postMessage: function (m) { window.__posted.push(JSON.parse(JSON.stringify(m))); }, getState: function () {}, setState: function () {} };
  };
`;

/** What the host's init says beyond the rows: see RebaseInitMessage. */
interface Init {
  /** A paused rebase's --edit-todo: git is past the first line. */
  continuing?: boolean;
  /** The todo's actions, first line first (the rest are pick). */
  actions?: string[];
}

/** Mount through main.ts, send a twelve-line todo, and name the vocabulary. */
const MOUNT = (bodyClass: string, lines = 12, init: Init = {}): string => `
  document.body.className = ${JSON.stringify(bodyClass)};
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const subjects = ["docs: the staging model", "engine: hunk splitting groundwork", "engine: split a hunk on a selection boundary",
    "typo", "changes: a row per hunk", "changes: stage the lines a selection touches", "wip", "wip",
    "staging: keep the selection across a refresh", "fixup! staging: keep the selection across a refresh",
    "fixup! staging: keep the selection across a refresh", "fixup! staging: keep the selection across a refresh"];
  while (subjects.length < ${lines}) subjects.unshift("older: commit " + subjects.length);
  const startActions = ${JSON.stringify(init.actions ?? [])};
  const initRows = subjects.map((s, i) => ({ id: i * 2, action: startActions[i] || "pick", sha: (i + 1).toString(16).padStart(4, "0").repeat(10), shortSha: (i + 1).toString(16).padStart(7, "0"), subject: s }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "rebaseInit", headerComment: null, rows: initRows${init.continuing ? ", continuing: true" : ""} } }));
  await tick();
  const el = document.querySelector("gitstudio-rebase");
  await el.updateComplete;
  await tick();
  const N = initRows.length;
  const $ = (sel) => el.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const settle = async () => { await el.updateComplete; await tick(); await el.updateComplete; };
  const rows = () => $$(".list .row");
  const plainBg = getComputedStyle(rows()[N - 1]).backgroundColor;
  const idx = (pred) => rows().map((r, i) => (pred(r) ? i : -1)).filter((i) => i >= 0).join(",");
  const selected = () => idx((r) => r.getAttribute("aria-selected") === "true");
  const painted = () => idx((r) => getComputedStyle(r).backgroundColor !== plainBg);
  const focusIdx = () => rows().indexOf(el.shadowRoot.activeElement);
  const actions = () => rows().map((r) => r.querySelector("select.action").value).join(",");
  const order = () => rows().map((r) => Number(r.dataset.key) / 2).join(",");
  const count = () => ($(".selcount") || {}).textContent || "";
  const footer = () => (($("footer .count") || {}).textContent || "").replace(/\\s+/g, " ").trim();
  const mac = /mac/i.test(navigator.platform);
  const MOD = mac ? { metaKey: true } : { ctrlKey: true };
  const key = async (k, mods) => {
    const t = el.shadowRoot.activeElement;
    if (!t) return null;
    const e = new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, composed: true, cancelable: true }, mods || {}));
    t.dispatchEvent(e);
    await settle();
    return e.defaultPrevented;
  };
  const click = async (i, mods) => {
    const at = rows()[i].querySelector(".subject");
    const down = new MouseEvent("mousedown", Object.assign({ bubbles: true, composed: true, cancelable: true }, mods || {}));
    at.dispatchEvent(down);
    at.dispatchEvent(new MouseEvent("click", Object.assign({ bubbles: true, composed: true, cancelable: true }, mods || {})));
    await settle();
    return down.defaultPrevented;
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i).join(",");
`;

const KEYBOARD = `
  expect(selected() === "0", "the first line starts selected (" + selected() + ")");
  expect(rows().filter((r) => r.tabIndex === 0).length === 1, "the list is one tab stop");
  expect(count() === "1 selected", "the toolbar counts it (" + count() + ")");
  rows()[0].focus();
  const table = [
    ["ArrowDown", {}, "1", 1],
    ["ArrowDown", { shiftKey: true }, "1,2", 2],
    ["ArrowDown", { shiftKey: true }, "1,2,3", 3],
    ["ArrowUp", { shiftKey: true }, "1,2", 2],
    ["ArrowUp", { shiftKey: true }, "1", 1],
    ["ArrowUp", { shiftKey: true }, "0,1", 0],
    ["ArrowUp", { shiftKey: true }, "0,1", 0],
    ["End", { shiftKey: true }, range(1, N - 1), N - 1],
    ["Home", {}, "0", 0],
    ["ArrowUp", {}, "0", 0],
    ["End", {}, String(N - 1), N - 1],
    ["ArrowDown", {}, String(N - 1), N - 1],
    ["Home", { shiftKey: true }, range(0, N - 1), 0],
    ["Escape", {}, "0", 0],
    ["a", MOD, range(0, N - 1), 0],
    ["ArrowDown", {}, "1", 1],
  ];
  for (const [k, mods, sel, foc] of table) {
    const before = selected();
    const claimed = await key(k, mods);
    const what = Object.keys(mods).join("+") + (Object.keys(mods).length ? "+" : "") + k + " from [" + before + "]";
    expect(selected() === sel, what + ": the selection is [" + selected() + "], not [" + sel + "]");
    expect(painted() === sel, what + ": painted [" + painted() + "], not [" + sel + "]");
    expect(focusIdx() === foc, what + ": the keyboard is on row " + focusIdx() + ", not " + foc);
    expect(claimed === true, what + ": the list took the key");
  }
  await key("ArrowDown", { shiftKey: true });
  await key("ArrowDown", { shiftKey: true });
  expect(count() === "3 selected", "the count follows (" + count() + ")");
  await key("Escape");
  expect((await key("Escape")) === false, "Escape on a single selection is left alone");
`;

const POINTER = `
  const table = [
    [1, {}, "1"],
    [3, MOD, "1,3"],
    [5, { shiftKey: true }, "3,4,5"],
    [0, Object.assign({ shiftKey: true }, MOD), "0,1,2,3,4,5"],
    [2, MOD, "0,1,3,4,5"],
    [4, {}, "4"],
    [4, MOD, ""],
    [6, {}, "6"],
  ];
  for (const [i, mods, sel] of table) {
    const noText = await click(i, mods);
    const what = "click row " + i + " " + JSON.stringify(mods);
    expect(selected() === sel, what + ": the selection is [" + selected() + "], not [" + sel + "]");
    expect(painted() === sel, what + ": painted [" + painted() + "], not [" + sel + "]");
    if (mods.shiftKey) expect(noText, what + ": selects rows, not the text between them");
  }
  expect(focusIdx() === 6, "the clicked row has the keyboard (" + focusIdx() + ")");
  rows()[2].querySelector("select.action").focus();
  await settle();
  expect(selected() === "2", "focusing a row's dropdown selects its row (" + selected() + ")");
  await click(4, { shiftKey: true });
  rows()[3].querySelector("select.action").focus();
  await settle();
  expect(selected() === "2,3,4", "a dropdown inside the selection leaves it alone (" + selected() + ")");
  await click(2);
  await click(2, MOD);
  expect(count() === "None selected", "an empty selection is said (" + count() + ")");
  expect($$("button.set").length === 6 && $$("button.set").every((b) => b.disabled), "and the toolbar is closed");
`;

const ACTIONS = `
  const words = $$("button.set").map((b) => b.textContent.trim());
  expect(words.join(",") === "Pick,Reword,Squash,Fixup,Edit,Drop", "the toolbar names the six in words (" + words + ")");
  $$("button.set").forEach((b, i) => expect(b.title.endsWith("(" + "PRSFED"[i] + ")"), b.textContent.trim() + " names its key: " + b.title));
  const letters = $$(".hint kbd.letter").map((k) => k.textContent.trim()).join("");
  expect(letters === "PRSFED", "the hint names all six keys (" + letters + ")");

  // In git's order the first row cannot fold: select the last three and drop them.
  await click(N - 3);
  await click(N - 1, { shiftKey: true });
  await key("d");
  let acts = actions().split(",");
  expect(acts.slice(N - 3).join(",") === "drop,drop,drop", "D drops every selected line (" + acts.slice(N - 3) + ")");
  expect(acts.slice(0, N - 3).every((a) => a === "pick"), "and nothing else");
  expect(footer() === (N - 3) + " of " + N + " commits kept · 3 dropped", "the footer counts the drops (" + footer() + ")");
  expect(selected() === range(N - 3, N - 1), "the selection survives (" + selected() + ")");
  expect(focusIdx() === N - 1, "and so does the keyboard (" + focusIdx() + ")");

  $$("button.set").find((b) => b.textContent.trim() === "Edit").click();
  await settle();
  acts = actions().split(",");
  expect(acts.slice(N - 3).join(",") === "edit,edit,edit", "the toolbar's Edit sets all three (" + acts.slice(N - 3) + ")");
  const bg = (w) => getComputedStyle($$("button.set").find((b) => b.textContent.trim() === w)).backgroundColor;
  expect(bg("Edit") !== bg("Pick"), "the toolbar shows Edit as what they are set to");

  // One row's dropdown sets that row only.
  const sel = rows()[N - 2].querySelector("select.action");
  sel.value = "reword";
  sel.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await settle();
  expect(actions().split(",").slice(N - 3).join(",") === "edit,reword,edit", "a row's own dropdown changes that row");

  // What must not set anything.
  await click(N - 3);
  await click(N - 1, { shiftKey: true });
  const before = actions();
  await key("d", MOD);
  expect(actions() === before, "Cmd/Ctrl+D is not D");
  await key("p", { altKey: true });
  expect(actions() === before, "nor is Alt+P");
  expect((await key("x")) === false, "a letter git has no action for is left alone");
  rows()[N - 2].querySelector("select.action").focus();
  await key("d");
  expect(actions() === before, "a key in a dropdown is the dropdown's");
  rows()[N - 1].focus();
  expect((await key("P")) === true, "a capital P counts");
  expect(actions().split(",").slice(N - 3).join(",") === "pick,pick,pick", "P picks them all again (" + actions() + ")");
`;

const SQUASH = `
  const note = () => ($(".note") || {}).textContent.trim();
  const start = () => $$("footer button").find((b) => /start rebase/i.test(b.textContent));
  // The ordinary case: a block in the middle folds, every line of it, into
  // the kept line above the block — nothing refused, nothing said.
  await click(6);
  await click(8, { shiftKey: true });
  await key("s");
  let mid = actions().split(",");
  expect(mid.slice(6, 9).join(",") === "squash,squash,squash", "every selected line folds, the first of them too (" + mid + ")");
  expect(mid.slice(0, 6).concat(mid.slice(9)).every((a) => a === "pick"), "and nothing else changes");
  expect(note() === "", "nothing was refused, so nothing is said (" + note() + ")");
  await key("p");
  expect(actions().split(",").every((a) => a === "pick"), "P puts them back");
  // Nothing kept above: the first stays, for the rest to fold into.
  await click(0);
  await key("s");
  expect(actions().split(",")[0] === "pick", "S on the first line alone changes nothing");
  expect(/The first commit you keep can't be a squash — there's nothing above it to fold into\\./.test(note()), "and says why (" + note() + ")");
  await key("a", MOD);
  await key("s");
  const acts = actions().split(",");
  expect(acts[0] === "pick", "the first stays, for the rest to fold into (" + acts[0] + ")");
  expect(acts.slice(1).every((a) => a === "squash"), "every later line folds (" + acts + ")");
  expect(new RegExp("Squash set on " + (N - 1) + " commits\\\\. The first one stays Pick").test(note()), "the footer says what happened (" + note() + ")");
  expect(start().disabled === false, "and the plan can be started");
  // A fold is not a commit kept: the plan ends in one commit, and says so,
  // as the workspace and the desktop do for the same plan.
  expect(footer() === "1 of " + N + " commits kept · " + (N - 1) + " folded", "the footer counts what the plan ends with (" + footer() + ")");
  // A fold dragged to the top is a plan git refuses: Start closes and says why.
  const dt = new DataTransfer();
  const fire = (type, target, y) => { const e = new DragEvent(type, { bubbles: true, composed: true, cancelable: true, clientY: y }); Object.defineProperty(e, "dataTransfer", { value: dt }); target.dispatchEvent(e); };
  await click(3);
  const top = rows()[0].getBoundingClientRect();
  fire("dragstart", rows()[3], 0);
  fire("dragover", rows()[0], top.top + 2);
  fire("drop", rows()[0], top.top + 2);
  await settle();
  expect(actions().split(",")[0] === "squash", "the squash is now the first line");
  expect(start().disabled === true, "Start is closed");
  expect(/nothing above it to fold into/.test(start().title), "with the reason (" + start().title + ")");
  expect(rows()[0].querySelector("select.action").getAttribute("aria-invalid") === "true", "and the row's dropdown says it is the problem");

  // What the host is sent: every line, in order, with its action.
  await click(0);
  await key("p");
  window.__posted.length = 0;
  start().click();
  await settle();
  const msg = window.__posted.find((m) => m.type === "start");
  expect(!!msg, "Start posts the plan");
  expect(msg && msg.rows.map((r) => r.action).join(",") === actions(), "exactly what the rows say");
  expect(msg && msg.rows.map((r) => r.id / 2).join(",") === order(), "in the order they are shown");
`;

const EDIT_TODO = `
  // A paused rebase's --edit-todo (edit c2 / squash c3 / pick c4, stopped at
  // c2): git has applied c2 and keeps it above the first line, so the
  // leading squash folds into it — git runs this plan, and so must the editor.
  const note = () => ($(".note") || {}).textContent.trim();
  const start = () => $$("footer button").find((b) => /start rebase/i.test(b.textContent));
  expect(actions().split(",")[0] === "squash", "the todo starts with a squash (" + actions() + ")");
  expect(start().disabled === false, "Start rebase is open: git runs this plan (" + start().title + ")");
  expect(start().title === "", "and nothing says it can't (" + start().title + ")");
  expect(rows()[0].querySelector("select.action").getAttribute("aria-invalid") === "false", "the first line is not marked as the problem");
  expect(!rows()[0].classList.contains("orphan"), "nor painted as one");
  rows()[0].focus();
  await key("p");
  expect(actions().split(",")[0] === "pick", "P picks it (" + actions() + ")");
  await key("s");
  expect(actions().split(",")[0] === "squash", "and S sets the squash back (" + actions() + ")");
  expect(note() === "", "with nothing refused (" + note() + ")");
  const sel = rows()[0].querySelector("select.action");
  sel.value = "fixup";
  sel.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await settle();
  expect(actions().split(",")[0] === "fixup", "its own dropdown can fold it too (" + actions() + ")");
  rows()[0].focus();
  await key("a", MOD);
  await key("f");
  expect(actions().split(",").every((a) => a === "fixup"), "every line can fold into what git already applied (" + actions() + ")");
  expect(start().disabled === false, "and Start stays open");
  window.__posted.length = 0;
  start().click();
  await settle();
  const msg = window.__posted.find((m) => m.type === "start");
  expect(!!msg && msg.rows.map((r) => r.action).join(",") === actions(), "Start posts the plan as shown");
`;

const MOVING = `
  const head = () => order().split(",").slice(0, 4).join(",");
  await click(1);
  await click(2, { shiftKey: true });
  expect((await key("ArrowUp", { altKey: true })) === true, "Alt+Up is the list's");
  expect(head() === "1,2,0,3", "the block moves up one, together (" + head() + ")");
  expect(selected() === "0,1", "still selected where it went (" + selected() + ")");
  expect(focusIdx() === 1, "and the keyboard went with it (" + focusIdx() + ")");
  await key("ArrowUp", { altKey: true });
  expect(head() === "1,2,0,3", "against the top it stays (" + head() + ")");
  await key("ArrowDown", { altKey: true });
  await key("ArrowDown", { altKey: true });
  expect(head() === "0,3,1,2", "and down again, together (" + head() + ")");

  await click(0);
  await click(2, MOD);
  await key("ArrowDown", { altKey: true });
  expect(head() === "3,0,2,1", "a scattered selection: each row one step (" + head() + ")");
  expect(selected() === "1,3", "still selected (" + selected() + ")");

  // A row's own move buttons carry the selection it is in.
  const up = rows()[3].querySelector("button[aria-label='Move the selected commits up']");
  expect(!!up, "a selected row's button says it moves the selection");
  up.click();
  await settle();
  expect(head() === "0,3,1,2", "and it does (" + head() + ")");

  // A drag carries the selection when it picks up a selected row.
  const dt = new DataTransfer();
  const fire = (type, target, y) => { const e = new DragEvent(type, { bubbles: true, composed: true, cancelable: true, clientY: y }); Object.defineProperty(e, "dataTransfer", { value: dt }); target.dispatchEvent(e); };
  // The lift eases in, and headless Chrome never advances an easing: measure
  // where it ends up, not how it travels.
  const still = document.createElement("style");
  still.textContent = "*{transition:none!important;animation:none!important}";
  el.shadowRoot.appendChild(still);
  const beforeDrag = order().split(",");
  await click(0);
  await click(1, { shiftKey: true });
  const onto = rows()[3].getBoundingClientRect();
  fire("dragstart", rows()[1], 0);
  await settle();
  const lifted = rows().filter((r) => parseFloat(getComputedStyle(r).opacity) < 1).length;
  expect(lifted === 2, "both rows lift (" + lifted + ": " + rows().map((r) => getComputedStyle(r).opacity + (r.classList.contains("dragging") ? "d" : "")).join(" ") + ")");
  fire("dragover", rows()[3], onto.bottom - 3);
  await settle();
  expect(getComputedStyle(rows()[3]).boxShadow !== "none", "the line is drawn");
  expect(rows()[3].classList.contains("over-after"), "below the row, where the pointer is");
  fire("drop", rows()[3], onto.bottom - 3);
  await settle();
  const want = [beforeDrag[2], beforeDrag[3], beforeDrag[0], beforeDrag[1]].concat(beforeDrag.slice(4)).join(",");
  expect(order() === want, "both land in the gap the line was drawn at (" + order() + " vs " + want + ")");
  expect(selected() === "2,3", "still selected (" + selected() + ")");
`;

const LONG = `
  // Forty lines in a 760px panel: the LIST scrolls, and the header and the
  // footer's Start rebase stay where they are.
  expect(innerHeight === 760, "the view is the panel, as VS Code mounts it (" + innerHeight + "px)");
  const list = $(".list");
  expect(list.scrollHeight > list.clientHeight + 40, "the list scrolls (" + list.scrollHeight + " in " + list.clientHeight + ")");
  const onScreen = () => {
    const f = $("footer").getBoundingClientRect();
    const h = $("header").getBoundingClientRect();
    return f.bottom <= innerHeight + 1 && h.top >= -1;
  };
  expect(onScreen(), "the header and Start rebase are on screen");
  // One line per commit: the grip shares the row with its dropdown.
  const g = rows()[0].querySelector(".grip").getBoundingClientRect();
  const d = rows()[0].querySelector("select.action").getBoundingClientRect();
  expect(Math.abs((g.top + g.bottom) / 2 - (d.top + d.bottom) / 2) < 4, "the grip sits on the row's one line (" + Math.round(g.top) + " vs " + Math.round(d.top) + ")");
  rows()[0].focus();
  await key("End");
  const last = rows()[N - 1].getBoundingClientRect();
  const box = list.getBoundingClientRect();
  expect(last.top >= box.top - 1 && last.bottom <= box.bottom + 1, "End brings the last line into the list's view");
  expect(onScreen(), "and nothing else moved off screen");
`;

test("a paused rebase's --edit-todo: a leading squash folds into the commit git already applied", { skip: CHROME ? false : "no headless Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, MAIN, MOUNT(BODY_CLASS.dark, 12, { continuing: true, actions: ["squash"] }) + EDIT_TODO, {
    width: 1000,
    height: 800,
    prelude: PRELUDE,
    css: themeCss("dark"),
  });
  assert.deepEqual(v.fails, []);
});

test("a long todo scrolls inside the list; the header and Start rebase stay on screen", { skip: CHROME ? false : "no headless Chrome on this machine" }, async () => {
  // "On screen" is a question about the VIEW, so the page runs in a frame of
  // exactly the panel's size — the way VS Code mounts a webview — whichever
  // Chrome runs it. It ran in a 900px window: the whole view in the headless
  // shell (a Mac, and the macOS runner), but the ubuntu and windows runners
  // drive their system Chrome, which lays its own toolbar out inside the
  // window — a 757px view there (749px on windows), shorter than the 760px
  // panel, so the footer was below the view on every run, whatever the
  // editor did. Run at those views in the headless shell, it failed the same
  // two ways.
  const v = await runInChrome(CHROME!, MAIN, MOUNT(BODY_CLASS.dark, 40) + LONG, {
    frame: { width: 1000, height: 760 },
    prelude: PRELUDE,
    css: themeCss("dark"),
  });
  assert.deepEqual(v.fails, []);
});

const cases: Array<[string, string]> = [
  ["the keyboard: arrows, Shift, Home/End, Cmd/Ctrl+A and Escape, cell by cell", KEYBOARD],
  ["the pointer: plain, Cmd/Ctrl, Shift and both; a row's own dropdown", POINTER],
  ["the action: git's letters and the toolbar set every selected line; nothing else does", ACTIONS],
  ["squash across a selection folds into the kept line above it, or keeps the first; a fold with nothing above it closes Start", SQUASH],
  ["moving: Alt+Up/Down, the move buttons and a drag carry the selection", MOVING],
];

for (const theme of ["dark", "light"] as const) {
  for (const [name, script] of cases) {
    // The painted-selection cells matter in both themes; the rest once is enough.
    if (theme === "light" && script !== KEYBOARD && script !== POINTER) continue;
    test(`${name} (${theme})`, { skip: CHROME ? false : "no headless Chrome on this machine" }, async () => {
      const v = await runInChrome(CHROME!, MAIN, MOUNT(BODY_CLASS[theme]) + script, {
        width: 1000,
        height: 800,
        prelude: PRELUDE,
        css: themeCss(theme),
      });
      assert.deepEqual(v.fails, []);
    });
  }
}
