import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Issue #103: the right-click menus GitStudio draws in its webviews
 *
 *   1. stayed pinned — a click in another editor, the Explorer or the
 *      terminal never reaches a webview, and only a click INSIDE closed
 *      them; and
 *   2. always opened down from the pointer, so near the foot of a short view
 *      (the Commit Graph panel is often ~250px tall, the Commits and
 *      Worktrees views less) the last items were cut off, with no way to
 *      scroll to them.
 *
 * Each case runs in a FRAME of the view's own size, the way VS Code mounts a
 * webview: its window is the view, and focus moving to the page around it is
 * exactly what a click in the editor does to a real webview — a real `blur`
 * on its window, document.hasFocus() false. Nothing here fakes either.
 */
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const GRAPH = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url));
const WORKTREES = fileURLToPath(new URL("../src/worktrees/main.ts", import.meta.url));
const FIT = fileURLToPath(new URL("./fixtures/menuFitEntry.ts", import.meta.url));

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
`;

/** Shared page helpers: waiting, moving focus out of the frame, geometry. */
const HELPERS = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = async (m) => { window.postMessage(m, "*"); await wait(60); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  // A click in the editor beside the webview: focus goes to the page around
  // this frame. The frame's window gets a real blur.
  const leaveFocus = async () => {
    const pd = window.parent.document;
    let away = pd.getElementById("away");
    if (!away) { away = pd.createElement("input"); away.id = "away"; pd.body.appendChild(away); }
    away.focus();
    await wait(80);
  };
  // Where it settles: the entrance animation (a 3px lift) finished first.
  const box = (el) => { el.getAnimations().forEach((a) => a.finish()); const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; };
  const inView = (b) => b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
  const sha = (i) => (i + 1).toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const rows = Array.from({ length: 40 }, (_, i) => row(i));
  /** n menu items, a separator after every fifth — the host's shape. */
  const items = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i && i % 5 === 0) out.push({ id: "", label: "", sep: true });
      out.push({ id: "act" + i, label: "Action number " + i, icon: "git-commit" });
    }
    return out;
  };
`;

// ── The Commit Graph panel ──────────────────────────────────────────────────

/** The bottom-panel graph as VS Code shows it: wide, 260px tall, side layout. */
const GRAPH_FRAME = { width: 900, height: 260 };

const GRAPH_MOUNT =
  HELPERS +
  `
  await host({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: null, refList: [] });
  const graph = document.querySelector("gitstudio-graph");
  await graph.updateComplete;
  const sr = graph.shadowRoot;
  const menu = () => sr.querySelector(".gh-commit-menu");
  // The lowest row the view shows whole: right-clicked near the view's foot.
  const lowRow = () => [...sr.querySelectorAll(".row[data-sha]")].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom <= innerHeight - 2; }).pop();
  /** A right-click on a row, and the host's answer with n items — the real round trip. */
  const rightClick = async (r, n, dx = 300) => {
    const b = r.getBoundingClientRect();
    const at = { x: Math.round(b.left + dx), y: Math.round(b.top + b.height / 2) };
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
    await wait(40);
    const ask = posted("contextMenu").pop();
    expect(!!ask && ask.x === at.x && ask.y === at.y, "the right-click asked the host for the menu at the pointer: " + JSON.stringify(ask));
    await host({ type: "commitMenu", sha: ask.sha, x: ask.x, y: ask.y, title: "commit menu", items: items(n) });
    await graph.updateComplete;
    return at;
  };
  // The page has the keyboard, as a webview has once it is clicked.
  sr.querySelector(".scroller").focus();
  expect(document.hasFocus(), "the frame has focus to begin with");
`;

const graphRun = (script: string) =>
  runInChrome(CHROME!, GRAPH, GRAPH_MOUNT + script, {
    frame: GRAPH_FRAME,
    prelude: PRELUDE,
    rootAttrs: 'data-layout="side"',
    css: "#root{height:100vh;width:100vw}",
  });

test("graph: a right-click near the panel's foot opens the menu UPWARD from the pointer, whole", { skip }, async () => {
  const v = await graphRun(`
    const at = await rightClick(lowRow(), 4);
    const m = menu();
    expect(!!m, "the menu opened");
    const b = box(m);
    notes.menu = b; notes.at = at; notes.view = innerHeight;
    expect(at.y + b.h > innerHeight, "the case: no room below the pointer (" + at.y + " + " + b.h + " > " + innerHeight + ")");
    expect(inView(b), "the menu is wholly inside the panel: " + JSON.stringify(b));
    expect(Math.abs(b.bottom - at.y) <= 1, "it opened upward — its foot at the pointer (" + b.bottom + " vs " + at.y + ")");
    expect(Math.abs(b.left - at.x) <= 1, "…and rightward from it, there being room (" + b.left + " vs " + at.x + ")");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("graph: a menu taller than the panel is capped inside it and scrolls; the keyboard brings its last item into view", { skip }, async () => {
  const v = await graphRun(`
    const r = lowRow();
    await rightClick(r, 16);
    const m = menu();
    const b = box(m);
    notes.menu = b;
    expect(inView(b), "the menu is wholly inside the 260px panel: " + JSON.stringify(b));
    expect(m.scrollHeight > m.clientHeight, "…and scrolls to the rest (" + m.scrollHeight + " > " + m.clientHeight + ")");
    expect(m.scrollWidth <= m.clientWidth, "…up and down only: nothing to scroll sideways (" + m.scrollWidth + " > " + m.clientWidth + ")");
    const all = [...m.querySelectorAll('[role="menuitem"]')];
    expect(all.length === 16, "every item is in it: " + all.length);
    // Near the right edge: it opens leftward from the pointer instead.
    sr.querySelector(".scroller").focus();
    const r2 = lowRow();
    const at2 = { x: innerWidth - 20, y: 40 };
    await host({ type: "commitMenu", sha: r2.dataset.sha, x: at2.x, y: at2.y, title: "commit menu", items: items(3) });
    await graph.updateComplete;
    const nb = box(menu());
    notes.right = nb;
    expect(inView(nb), "at the right edge the menu stays inside: " + JSON.stringify(nb));
    expect(Math.abs(nb.right - at2.x) <= 1, "…opened leftward, its right edge at the pointer (" + nb.right + " vs " + at2.x + ")");
    // The menu key's door (the host answers x = y = -1): it opens with its
    // first item focused; Up wraps to the LAST, which scrolls into view.
    await host({ type: "commitMenu", sha: r2.dataset.sha, x: -1, y: -1, title: "commit menu", items: items(16) });
    await graph.updateComplete;
    const km = menu();
    expect(inView(box(km)), "the keyboard's menu is inside the panel too: " + JSON.stringify(box(km)));
    const first = sr.activeElement;
    expect(!!first && first.getAttribute("role") === "menuitem", "its first item has the keyboard");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, composed: true, cancelable: true }));
    await wait(40);
    const last = sr.activeElement;
    const items16 = [...km.querySelectorAll('[role="menuitem"]')];
    expect(last === items16[items16.length - 1], "Up from the first item went to the last");
    const lb = box(last), mb = box(km);
    notes.last = lb; notes.kmenu = mb;
    expect(lb.top >= mb.top - 1 && lb.bottom <= mb.bottom + 1 && inView(lb), "the last item scrolled into view: " + JSON.stringify({ lb, mb }));
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("graph: focus leaving the webview (a click in the editor) closes the menu; a focus move inside it does not", { skip }, async () => {
  const v = await graphRun(`
    await rightClick(lowRow(), 6);
    expect(!!menu(), "the menu opened");
    // Inside the page: the keyboard goes to an item, then back to the list,
    // and the window hears a blur that is not focus leaving.
    menu().querySelector('[role="menuitem"]').focus();
    await wait(30);
    sr.querySelector(".scroller").focus();
    window.dispatchEvent(new FocusEvent("blur"));
    await wait(60);
    expect(document.hasFocus() && !!menu(), "a focus move within the page keeps the menu open");
    // A click in the editor: focus leaves the frame.
    await leaveFocus();
    expect(!document.hasFocus(), "focus left the frame");
    await graph.updateComplete;
    expect(!menu(), "the menu closed when focus left the webview");
    // Escape and a click elsewhere inside still close it, as before.
    sr.querySelector(".scroller").focus();
    await rightClick(lowRow(), 6);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await graph.updateComplete;
    expect(!menu(), "Escape closes it");
    await rightClick(lowRow(), 6);
    sr.querySelector(".colhead").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await graph.updateComplete;
    expect(!menu(), "a click elsewhere in the page closes it");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

// ── The Commits view (the sidebar rail) ─────────────────────────────────────

const RAIL_MOUNT =
  HELPERS +
  `
  const rail = document.createElement("gitstudio-commit-rail");
  rail.onAction = () => {};
  document.getElementById("root").replaceChildren(rail);
  rail.head = sha(0); rail.rows = rows; rail.totalColumns = 1; rail.hasMore = false; rail.status = "ready";
  await rail.updateComplete;
  await wait(60);
  const sr = rail.shadowRoot;
  const menu = () => sr.querySelector(".pop.commitmenu");
  const lowRow = () => [...sr.querySelectorAll(".row[data-sha]")].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom <= innerHeight - 2; }).pop();
  const open = async (r, n) => {
    const b = r.getBoundingClientRect();
    const at = { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) };
    rail.showCommitMenu(r.dataset.sha, at.x, at.y, "commit menu", items(n));
    await rail.updateComplete;
    return at;
  };
  sr.querySelector(".scroller").focus();
  expect(document.hasFocus(), "the frame has focus to begin with");
`;

const railRun = (script: string, frame: { width: number; height: number }) =>
  runInChrome(CHROME!, RAIL, RAIL_MOUNT + script, { frame, css: "#root{height:100vh;width:100vw}" });

test("rail: near the foot of the Commits view the menu opens upward; nearly as tall as the view, it still ends inside it", { skip }, async () => {
  const short = await railRun(`
    const at = await open(lowRow(), 4);
    const b = box(menu());
    notes.menu = b; notes.at = at;
    expect(at.y + b.h > innerHeight, "the case: no room below (" + at.y + " + " + b.h + " > " + innerHeight + ")");
    expect(inView(b), "inside the view: " + JSON.stringify(b));
    expect(Math.abs(b.bottom - at.y) <= 1, "opened upward, its foot at the pointer (" + b.bottom + " vs " + at.y + ")");
  `, { width: 300, height: 180 });
  // A menu of 14 is ~340px: the old guess capped its height at 320 and slid
  // it up by too little, so its foot ran ~20px past a 400px view.
  const tall = await railRun(`
    const at = await open(lowRow(), 14);
    const m = menu();
    const b = box(m);
    notes.menu = b; notes.at = at; notes.sh = m.scrollHeight;
    expect(inView(b), "inside the view: " + JSON.stringify(b));
  `, { width: 300, height: 400 });
  const tiny = await railRun(`
    await open(lowRow(), 14);
    const m = menu();
    const b = box(m);
    notes.menu = b;
    expect(inView(b), "taller than the view: capped inside it: " + JSON.stringify(b));
    expect(m.scrollHeight > m.clientHeight, "…and it scrolls");
    expect(m.scrollWidth <= m.clientWidth, "…up and down only (" + m.scrollWidth + " > " + m.clientWidth + ")");
  `, { width: 300, height: 160 });
  assert.deepEqual(
    { short: short.fails, tall: tall.fails, tiny: tiny.fails },
    { short: [], tall: [], tiny: [] },
    JSON.stringify({ short: short.notes, tall: tall.notes, tiny: tiny.notes }),
  );
});

test("rail: focus leaving the webview closes the menu; a focus move inside does not", { skip }, async () => {
  const v = await railRun(`
    await open(lowRow(), 5);
    expect(!!menu(), "the menu opened");
    menu().querySelector(".mi").focus();
    sr.querySelector(".scroller").focus();
    window.dispatchEvent(new FocusEvent("blur"));
    await wait(60);
    expect(!!menu(), "a focus move within the page keeps it open");
    await leaveFocus();
    await rail.updateComplete;
    expect(!document.hasFocus() && !menu(), "focus left the webview: the menu closed");
  `, { width: 300, height: 180 });
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

// ── The Worktrees view ──────────────────────────────────────────────────────

const WT_MOUNT =
  HELPERS +
  `
  const wt = (i, extra) => ({
    path: "/repo/wt" + i, name: "wt" + i, relPath: "wt" + i, shownPath: "~/repo/wt" + i,
    kind: i === 0 ? "main" : "linked", branch: "feature/" + i, head: sha(i), current: i === 0,
    locked: false, missing: false, unlinked: false, upstreamGone: false, ahead: 0, behind: 0,
    hasRemotes: true, upstream: "origin/feature/" + i, defaultBranch: "origin/main", onDefaultBranch: false, ...extra,
  });
  await host({ type: "rows", state: "ok", rows: [wt(0), wt(1), wt(2)] });
  const menu = () => document.querySelector(".wt-menu");
  const lines = () => [...document.querySelectorAll(".wt-row")];
  const open = async () => {
    const r = lines().pop();
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + b.height / 2, button: 2 }));
    await wait(60);
    return r;
  };
`;

const wtRun = (script: string) =>
  runInChrome(CHROME!, WORKTREES, WT_MOUNT + script, { frame: { width: 300, height: 120 }, prelude: PRELUDE, css: "#root{height:100vh}" });

test("worktrees: in a view a few rows tall the menu stays inside it and scrolls; End brings the last item into view", { skip }, async () => {
  const v = await wtRun(`
    expect(lines().length === 3, "three worktrees: " + lines().length);
    await open();
    const m = menu();
    expect(!!m, "the menu opened");
    const b = box(m);
    notes.menu = b; notes.sh = m.scrollHeight;
    expect(inView(b), "the menu is inside the 120px view: " + JSON.stringify(b));
    expect(m.scrollHeight > m.clientHeight, "…and scrolls to the rest");
    expect(m.scrollWidth <= m.clientWidth, "…up and down only (" + m.scrollWidth + " > " + m.clientWidth + ")");
    const first = document.activeElement;
    expect(first && first.classList.contains("wt-menu-item"), "its first item has the keyboard");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await wait(40);
    const all = [...m.querySelectorAll(".wt-menu-item")];
    const last = document.activeElement;
    expect(last === all[all.length - 1], "End went to the last item");
    const lb = box(last), mb = box(m);
    expect(lb.top >= mb.top - 1 && lb.bottom <= mb.bottom + 1 && inView(lb), "…which scrolled into view: " + JSON.stringify({ lb, mb }));
    const seps = [...m.querySelectorAll(".wt-menu-sep")].map((s) => s.getBoundingClientRect().height);
    expect(seps.length > 0 && seps.every((h) => h >= 1), "a capped menu keeps its separators: " + JSON.stringify(seps));
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("worktrees: focus leaving the webview closes the menu; a focus move inside does not", { skip }, async () => {
  const v = await wtRun(`
    await open();
    expect(!!menu() && document.hasFocus(), "the menu opened, its first item focused");
    const rowsOfMenu = [...menu().querySelectorAll(".wt-menu-item")];
    rowsOfMenu[1].focus();
    window.dispatchEvent(new FocusEvent("blur"));
    await wait(60);
    expect(!!menu(), "a focus move within the page keeps it open");
    await leaveFocus();
    expect(!document.hasFocus() && !menu(), "focus left the webview: the menu closed");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

// ── The rule itself (menuFit.ts) ─────────────────────────────────────────────

test("fitMenu: below, else flipped above, else as low as fits; right, else left; capped and scrolling; measured, not transformed", { skip }, async () => {
  const v = await runInChrome(
    CHROME!,
    FIT,
    HELPERS +
      `
    const { fitMenu, atPoint } = window.__menuFit;
    const mk = (w, h, css = "") => {
      const m = document.createElement("div");
      m.style.cssText = "position:fixed;box-sizing:border-box;width:" + w + "px;" + css;
      const inner = document.createElement("div"); inner.style.height = h + "px"; m.appendChild(inner);
      document.body.appendChild(m);
      return m;
    };
    const at = (m) => ({ left: parseFloat(m.style.left), top: parseFloat(m.style.top), h: m.offsetHeight });
    // 300 × 200 view.
    let m = mk(100, 50); fitMenu(m, atPoint(20, 20));
    expect(JSON.stringify(at(m)) === JSON.stringify({ left: 20, top: 20, h: 50 }), "room below and right: down-right from the point " + JSON.stringify(at(m)));
    m = mk(100, 50); fitMenu(m, atPoint(20, 180));
    expect(at(m).top === 130, "no room below: flipped, its foot on the point " + JSON.stringify(at(m)));
    m = mk(100, 150); fitMenu(m, atPoint(20, 100));
    expect(at(m).top === 44, "room on neither side: as low as it ends inside (200 − 6 − 150) " + JSON.stringify(at(m)));
    m = mk(100, 50); fitMenu(m, atPoint(250, 20));
    expect(at(m).left === 150, "no room right: leftward from the point " + JSON.stringify(at(m)));
    m = mk(100, 50); fitMenu(m, { left: 120, right: 200, top: 40, bottom: 60 }, { align: "end", gap: 2 });
    expect(at(m).left === 100 && at(m).top === 62, "align end: right edges together, under the anchor " + JSON.stringify(at(m)));
    m = mk(100, 50); fitMenu(m, { left: 120, right: 200, top: 160, bottom: 180 }, { gap: 2 });
    expect(at(m).top === 108, "an anchor row: flipped ABOVE the row, not over it " + JSON.stringify(at(m)));
    m = mk(100, 500); fitMenu(m, atPoint(20, 100));
    expect(at(m).h === 188 && at(m).top === 6 && m.scrollHeight > m.clientHeight, "taller than the view: capped at it, scrolling " + JSON.stringify(at(m)));
    m = mk(100, 500, "max-height:120px;overflow:hidden"); fitMenu(m, atPoint(20, 100));
    expect(at(m).h === 120 && getComputedStyle(m).overflowY === "auto", "its own smaller cap stands, and a clipping shell scrolls " + JSON.stringify(at(m)));
    m = mk(100, 80, "transform:scale(0.5)"); fitMenu(m, atPoint(20, 150));
    expect(at(m).top === 70, "an entrance transform does not shrink the measure " + JSON.stringify(at(m)));
    m = mk(100, 50); fitMenu(m, atPoint(20, 130), { bottomReserve: 60 });
    expect(at(m).top === 80, "a covered foot (the desktop's dock) is not room " + JSON.stringify(at(m)));
    const placed = (m) => [m.style.left, m.style.top, m.style.maxHeight, m.style.overflowY].join(" ");
    m = mk(100, 50); fitMenu(m, atPoint(20, 180)); const once = placed(m); fitMenu(m, atPoint(20, 180));
    expect(placed(m) === once, "idempotent: " + once + " / " + placed(m));
    m = mk(100, 500, "box-sizing:content-box;padding:10px;border:2px solid"); fitMenu(m, atPoint(20, 100));
    expect(m.offsetHeight === 188 && at(m).top === 6, "a content-box shell's padding and border count against the view " + JSON.stringify(at(m)));
    m = mk(100, 500); fitMenu(m, atPoint(20, 100)); fitMenu(m, atPoint(20, 100), { pad: 20 });
    expect(m.offsetHeight === 160, "a later fit is not held to the last one's cap " + JSON.stringify(at(m)));
  `,
    { frame: { width: 300, height: 200 }, prelude: "", css: "" },
  );
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("closeOnFocusLeave: closes when focus leaves the page or the page is hidden — not for a blur inside it, and not once stopped", { skip }, async () => {
  const v = await runInChrome(
    CHROME!,
    FIT,
    HELPERS +
      `
    const { closeOnFocusLeave } = window.__menuFit;
    const b = document.createElement("button"); b.textContent = "in the page"; document.body.appendChild(b);
    const c2 = document.createElement("button"); c2.textContent = "also in it"; document.body.appendChild(c2);
    b.focus();
    expect(document.hasFocus(), "the frame has focus");
    let closed = 0;
    const stop = closeOnFocusLeave(() => closed++);
    c2.focus();
    b.blur();
    window.dispatchEvent(new FocusEvent("blur"));
    await wait(40);
    expect(closed === 0, "focus moving inside the page closes nothing (" + closed + ")");
    await leaveFocus();
    expect(closed === 1, "focus leaving the page closes, once (" + closed + ")");
    b.focus();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(closed === 2, "the page hidden (its panel put away) closes (" + closed + ")");
    delete document.visibilityState;
    stop();
    await leaveFocus();
    expect(closed === 2, "stopped: nothing more (" + closed + ")");
  `,
    { frame: { width: 300, height: 200 }, prelude: "", css: "" },
  );
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});
