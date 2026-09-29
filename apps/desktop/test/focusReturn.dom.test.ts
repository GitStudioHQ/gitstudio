// Where the keyboard goes when a page changes (focusReturn.ts):
//
//   · leaving a list remembers the row you were on, and coming back puts focus
//     on it again — once its rows have arrived, per view and per repository tab;
//   · a page that replaced another gets focus on its heading (or a fallback);
//   · a control destroyed by a rebuild hands focus to its replacement.
//
// Rendered into helpers/miniDom.ts with node:test's fake setTimeout and Date,
// so "the rows arrive 100 ms later" and "the 2.5 s arm window runs out" are
// stated, not slept.

import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMiniDom, fire, type MiniElement } from "./helpers/miniDom";

const dom = installMiniDom();
type FR = typeof import("../src/renderer/focusReturn");
let fr!: FR;
before(async () => {
  fr = (await import("../src/renderer/focusReturn")) as FR;
  // The listeners are wired by the first navigation, as at boot.
  fr.setFocusScope("boot");
});

const doc = dom.document;
let tab = 100;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  doc.body.replaceChildren();
  // A fresh tab per test, so no remembered row leaks between them.
  fr.setFocusTab(++tab);
});
afterEach(() => mock.timers.reset());

/**
 * Let `ms` of fake time pass in small steps. One `mock.timers.tick(n)` moves the
 * clock to its end before running what is due, so a poll that re-arms itself
 * from inside would be scheduled past the window and run once; stepping runs
 * each poll at its own time, as a real clock would.
 */
function advance(ms: number): void {
  mock.timers.tick(0);
  for (let t = 0; t < ms; t += 8) mock.timers.tick(Math.min(8, ms - t));
}

/** A list view: rows with `data-num`, each holding a focusable button. */
function renderList(nums: string[]): { view: MiniElement; rows: Map<string, MiniElement> } {
  const view = doc.createElement("div");
  view.className = "view";
  const rows = new Map<string, MiniElement>();
  for (const n of nums) {
    const row = doc.createElement("div");
    row.dataset.num = n;
    row.tabIndex = 0;
    const open = doc.createElement("button");
    open.textContent = `Open #${n}`;
    row.appendChild(open);
    view.appendChild(row);
    rows.set(n, row);
  }
  doc.body.replaceChildren(view);
  return { view, rows };
}

// ── returning to the row ─────────────────────────────────────────────────────

test("back in a list, focus returns to the row you left — once its rows have arrived", () => {
  fr.setFocusScope("issues");
  const first = renderList(["30", "31", "32"]);
  // Focus lands on a control INSIDE the row; the row is what is remembered.
  first.rows.get("31")!.querySelector("button")!.focus();

  fr.setFocusScope("issue:31");
  doc.body.replaceChildren(doc.createElement("h1"));

  fr.setFocusScope("issues");
  doc.body.replaceChildren(); // the view is built; its data has not resolved
  advance(100);
  assert.equal(doc.activeElement, doc.body, "nothing to focus yet");
  const again = renderList(["30", "31", "32"]);
  advance(32);
  const row = again.rows.get("31")!;
  assert.equal(doc.activeElement, row, "the same row, in the rebuilt list");
  assert.equal(row.scrolledIntoView, 1, "and scrolled into view");
});

test("a remembered row that is still hidden waits until it is shown", () => {
  fr.setFocusScope("prs");
  renderList(["7"]).rows.get("7")!.focus();
  fr.setFocusScope("pr:7");
  fr.setFocusScope("prs");
  const { view, rows } = renderList(["7"]);
  view.hidden = true;
  advance(0);
  advance(64);
  assert.equal(doc.activeElement, doc.body);
  view.hidden = false;
  advance(32);
  assert.equal(doc.activeElement, rows.get("7"));
});

test("the restore gives up quietly when the row never comes back", () => {
  fr.setFocusScope("issues");
  renderList(["5"]).rows.get("5")!.focus();
  fr.setFocusScope("issue:5");
  fr.setFocusScope("issues");
  renderList(["6"]); // #5 was deleted
  advance(2600);
  assert.equal(doc.activeElement, doc.body);
  const late = renderList(["5"]);
  advance(100);
  assert.notEqual(doc.activeElement, late.rows.get("5"), "a row arriving after the window does not grab focus");
});

test("rows are remembered per view: returning to another list does not reach for this one's row", () => {
  fr.setFocusScope("issues");
  renderList(["12"]).rows.get("12")!.focus();
  fr.setFocusScope("prs");
  const prs = renderList(["12"]);
  advance(100);
  assert.notEqual(doc.activeElement, prs.rows.get("12"), "PR #12 is not issue #12");
});

test("each repository tab keeps its own rows; a closed tab's are forgotten", () => {
  const a = ++tab;
  const b = ++tab;
  fr.setFocusTab(a);
  fr.setFocusScope("issues");
  renderList(["31"]).rows.get("31")!.focus();

  fr.setFocusTab(b);
  fr.setFocusScope("issues");
  const inB = renderList(["31"]);
  advance(100);
  assert.notEqual(doc.activeElement, inB.rows.get("31"), "issue #31 in one repository is not #31 in another");

  fr.setFocusTab(a);
  fr.setFocusScope("issues");
  const inA = renderList(["31"]);
  advance(0);
  assert.equal(doc.activeElement, inA.rows.get("31"));

  fr.setFocusScope("issue:31");
  fr.dropFocusTab(a);
  fr.setFocusTab(a); // reopened: a fresh tab
  fr.setFocusScope("issues");
  const reopened = renderList(["31"]);
  advance(100);
  assert.notEqual(doc.activeElement, reopened.rows.get("31"));
});

test("clearFocusReturn forgets every remembered row (a repository switch)", () => {
  fr.setFocusScope("branches");
  renderList(["main"]).rows.get("main")!.focus();
  fr.setFocusScope("branch:main");
  fr.clearFocusReturn();
  fr.setFocusScope("branches");
  const list = renderList(["main"]);
  advance(100);
  assert.notEqual(doc.activeElement, list.rows.get("main"));
});

test("a re-navigation cancels a pending restore before it lands", () => {
  fr.setFocusScope("issues");
  renderList(["9"]).rows.get("9")!.focus();
  fr.setFocusScope("issue:9");
  fr.setFocusScope("issues");
  fr.setFocusScope("settings"); // left again before the rows arrived
  const list = renderList(["9"]);
  advance(100);
  assert.notEqual(doc.activeElement, list.rows.get("9"));
});

test("focus on something that is not a row records nothing", () => {
  fr.setFocusScope("issues");
  const { view } = renderList(["1"]);
  const search = doc.createElement("input");
  view.prepend(search);
  search.focus();
  fr.setFocusScope("issue:1");
  fr.setFocusScope("issues");
  renderList(["1"]);
  advance(100);
  assert.equal(doc.activeElement, doc.body);
});

// ── the element that really has focus ────────────────────────────────────────

test("deepActiveElement walks through open shadow roots to the real focus", () => {
  const host = doc.createElement("gitstudio-graph");
  host.tabIndex = 0;
  const innerHost = doc.createElement("x-row-list");
  const row = doc.createElement("div");
  doc.body.append(host, innerHost, row);
  host.focus();
  assert.equal(fr.deepActiveElement(doc as never), host, "no shadow root: the element itself");
  host.shadowRoot = { activeElement: innerHost };
  innerHost.shadowRoot = { activeElement: row };
  assert.equal(fr.deepActiveElement(doc as never), row);
  assert.equal(fr.deepActiveElement(), row, "the global document by default");
  innerHost.shadowRoot = { activeElement: null };
  assert.equal(fr.deepActiveElement(doc as never), innerHost);
});

// ── focus on a new page ──────────────────────────────────────────────────────

test("a new page's heading gets focus, made focusable without joining the Tab order", () => {
  const view = doc.createElement("div");
  const h = doc.createElement("h1");
  h.textContent = "Fix the graph #12";
  view.appendChild(h);
  doc.body.appendChild(view);
  fr.focusNewPage(view as never);
  advance(0);
  assert.equal(doc.activeElement, h);
  assert.equal(h.getAttribute("tabindex"), "-1");
});

test("a page attached and titled late still gets focus when its heading arrives", () => {
  const view = doc.createElement("div");
  fr.focusNewPage(view as never);
  advance(0);
  advance(32 * 3);
  doc.body.appendChild(view);
  advance(32 * 2);
  const title = doc.createElement("div");
  title.className = "det-title";
  title.tabIndex = 0;
  view.appendChild(title);
  advance(32);
  assert.equal(doc.activeElement, title);
  assert.equal(title.getAttribute("tabindex"), "0", "an existing tabindex is left alone");
});

test("with no heading, the fallback control gets focus — a button needs no tabindex", () => {
  const view = doc.createElement("div");
  const back = doc.createElement("button");
  view.appendChild(back);
  doc.body.appendChild(view);
  fr.focusNewPage(view as never, back as never);
  advance(0);
  assert.equal(doc.activeElement, back);
  assert.equal(back.hasAttribute("tabindex"), false);
});

test("a page never steals focus from something the user is already typing in", () => {
  const view = doc.createElement("div");
  const box = doc.createElement("textarea");
  const h = doc.createElement("h1");
  view.append(box, h);
  doc.body.appendChild(view);
  fr.focusNewPage(view as never);
  box.focus();
  advance(0);
  assert.equal(doc.activeElement, box);
});

test("a page that never attaches is given up on after about 60 tries", () => {
  const view = doc.createElement("div");
  view.appendChild(doc.createElement("h1"));
  fr.focusNewPage(view as never);
  advance(0);
  for (let i = 0; i < 70; i++) advance(32);
  doc.body.appendChild(view);
  advance(32 * 5);
  assert.equal(doc.activeElement, doc.body, "a view replaced long ago does not pull focus back");
});

// ── the rebuilt control ──────────────────────────────────────────────────────

/** Focus `lost`, then do what a rebuild does: it blurs as it is torn down. */
function tearDown(lost: MiniElement): void {
  lost.focus();
  fire(lost, "focusout");
  lost.remove();
}

function button(opts: { cls?: string; text?: string; title?: string; label?: string; num?: string; tag?: string } = {}): MiniElement {
  const b = doc.createElement(opts.tag ?? "button");
  if (opts.cls) b.className = opts.cls;
  if (opts.text) b.textContent = opts.text;
  if (opts.title) b.title = opts.title;
  if (opts.label) b.setAttribute("aria-label", opts.label);
  if (opts.num) b.dataset.num = opts.num;
  return b;
}

test("a control destroyed by a rebuild hands focus to its replacement — matched by what it acts on", () => {
  fr.setFocusScope("changes");
  const list = doc.createElement("div");
  doc.body.appendChild(list);
  const oldA = button({ text: "Stage", title: "Stage", num: "src/a.ts" });
  const oldB = button({ text: "Stage", title: "Stage", num: "src/b.ts" });
  list.append(oldA, oldB);
  tearDown(oldB);
  oldA.remove();
  // The list comes back a poll or two later.
  advance(32);
  assert.equal(doc.activeElement, doc.body);
  const newA = button({ text: "Stage", title: "Stage", num: "src/a.ts" });
  const newB = button({ text: "Stage", title: "Stage", num: "src/b.ts" });
  list.append(newA, newB);
  advance(32);
  assert.equal(doc.activeElement, newB, "the SAME file's button, not the first Stage in the list");
});

test("matching falls back to title, then aria-label, then base class + text", () => {
  const cases: Array<[MiniElement, MiniElement, MiniElement]> = [
    [button({ title: "Refresh" }), button({ title: "Other" }), button({ title: "Refresh" })],
    [button({ label: "Close tab" }), button({ label: "Close" }), button({ label: "Close tab" })],
    // Flipping Releases → Tags rebuilds the segment and moves `active`: the
    // base class and the words still say it is the same control.
    [button({ cls: "seg active", text: "Tags" }), button({ cls: "chip", text: "Tags" }), button({ cls: "seg", text: " Tags " })],
  ];
  for (const [i, [lost, decoy, twin]] of cases.entries()) {
    doc.body.replaceChildren();
    doc.body.appendChild(lost);
    tearDown(lost);
    doc.body.append(decoy, twin);
    advance(32);
    assert.equal(doc.activeElement, twin, `case ${i}`);
  }
});

test("no equivalent — different tag, or nothing to identify it by — means no rescue", () => {
  const lost = button({ text: "Open" });
  doc.body.appendChild(lost);
  tearDown(lost);
  doc.body.append(button({ tag: "a", text: "Open" }));
  advance(32 * 30);
  assert.equal(doc.activeElement, doc.body);

  const blank = button({});
  doc.body.appendChild(blank);
  tearDown(blank);
  doc.body.append(button({}));
  advance(32 * 30);
  assert.equal(doc.activeElement, doc.body, "an empty button is not 'the same' as another empty one");
});

test("a twin with no layout box is skipped — except a text field, which may be fixed-position", () => {
  const lost = button({ title: "Filter" });
  doc.body.appendChild(lost);
  tearDown(lost);
  const hiddenTwin = button({ title: "Filter" });
  hiddenTwin.hidden = true;
  doc.body.appendChild(hiddenTwin);
  advance(32);
  assert.equal(doc.activeElement, doc.body, "a button with no offsetParent is not on screen");

  // An <input> answers offsetParent === null when it is position: fixed (the
  // palette's field); the fake models "no offsetParent" with a hidden wrapper.
  const field = button({ tag: "input", title: "Search" });
  doc.body.appendChild(field);
  tearDown(field);
  const wrap = doc.createElement("div");
  wrap.hidden = true;
  const twinField = button({ tag: "input", title: "Search" });
  wrap.appendChild(twinField);
  doc.body.appendChild(wrap);
  assert.equal(twinField.offsetParent, null);
  advance(32);
  assert.equal(doc.activeElement, twinField);
});

test("no rescue when the user simply moved on, or the control still exists", () => {
  const lost = button({ title: "Stage all" });
  const elsewhere = button({ title: "Commit" });
  doc.body.append(lost, elsewhere);
  lost.focus();
  fire(lost, "focusout");
  advance(32);
  assert.equal(doc.activeElement, lost, "still in the document: the user clicked away, nothing to do");

  lost.focus();
  fire(lost, "focusout");
  lost.remove();
  elsewhere.focus();
  doc.body.append(button({ title: "Stage all" }));
  advance(32);
  assert.equal(doc.activeElement, elsewhere, "focus already went somewhere real");
});

test("the rescue stops looking after 25 polls", () => {
  const lost = button({ title: "Push" });
  doc.body.appendChild(lost);
  tearDown(lost);
  advance(32 * 26);
  const twin = button({ title: "Push" });
  doc.body.appendChild(twin);
  advance(32 * 5);
  assert.equal(doc.activeElement, doc.body);
});
