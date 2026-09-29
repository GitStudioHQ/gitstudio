// The graph's right-click menu (contextMenu.ts), rendered and driven: the rows
// it offers for one commit and for several, where it lands on screen, the
// keyboard, what each click sends to the host — including the question it has
// to ask first — and where focus goes when it closes.
//
// Built in helpers/miniDom.ts; the dialogs it opens are the real ones.

import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMiniDom, fire, press, settle, text, type MiniElement } from "./helpers/miniDom";
import type { CommitActionRequest } from "../src/shared/ipc";

const dom = installMiniDom();
type CM = typeof import("../src/renderer/contextMenu");
let cm!: CM;
let overlays!: typeof import("../src/renderer/overlays");
before(async () => {
  cm = (await import("../src/renderer/contextMenu")) as CM;
  overlays = await import("../src/renderer/overlays");
});

const doc = dom.document;
const SHA = "0123456789abcdef0123456789abcdef01234567";
let graphRow!: MiniElement;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  doc.body.replaceChildren();
  dom.window.innerWidth = 1200;
  dom.window.innerHeight = 800;
  doc.sizer = (el) => (el.classList.contains("ctx-menu") ? { width: 220, height: 300 } : undefined);
  graphRow = doc.createElement("div");
  graphRow.tabIndex = 0;
  graphRow.dataset.num = SHA;
  doc.body.appendChild(graphRow);
  graphRow.focus();
});
afterEach(() => {
  for (const o of doc.querySelectorAll(".modal-overlay")) o.querySelector(".mini-btn")?.click();
  overlays.dismissLayers();
  mock.timers.reset();
});

function harness() {
  const sent: CommitActionRequest[] = [];
  const dropped: string[] = [];
  const many: Array<[string, string[]]> = [];
  const menu = new cm.CommitContextMenu(
    (r) => sent.push(r),
    (sha) => dropped.push(sha),
    (action, shas) => many.push([action, shas]),
  );
  return { menu, sent, dropped, many };
}
const menuEl = (): MiniElement | null => doc.querySelector(".ctx-menu");
const rows = (): MiniElement[] => menuEl()?.querySelectorAll(".ctx-menu-item") ?? [];
const row = (label: string): MiniElement => {
  const r = rows().find((x) => x.textContent === label);
  assert.ok(r, `no row "${label}" in ${rows().map((x) => x.textContent).join(", ")}`);
  return r;
};
const px = (v: unknown): number => Number(String(v).replace("px", ""));
const dialog = (): MiniElement | null => doc.querySelector(".modal-overlay");

// ── what one commit's menu offers ────────────────────────────────────────────

test("one commit: a short-sha heading, Checkout rows for its refs, then the commit actions", () => {
  const { menu } = harness();
  menu.open(SHA, 100, 100, [
    { name: "main", kind: "head", current: true },
    { name: "feat/x", kind: "head", fullName: "refs/heads/feat/x" },
    { name: "v1.0", kind: "tag" },
  ]);
  mock.timers.tick(0);
  const m = menuEl()!;
  assert.equal(m.getAttribute("role"), "menu");
  assert.equal(text(m.querySelector(".ctx-menu-header")), "0123456", "seven characters, like every short sha");
  assert.deepEqual(
    rows().map((r) => r.textContent),
    [
      "Checkout feat/x",
      "Checkout v1.0…",
      "Checkout",
      "Create branch here…",
      "Create tag here…",
      "Cherry-pick",
      "Revert",
      "Reset (soft)",
      "Reset (mixed)",
      "Reset (hard)",
      "Copy SHA",
    ],
    "the branch you are on is not offered as a checkout",
  );
  for (const r of rows()) {
    assert.equal(r.getAttribute("role"), "menuitem");
    assert.equal(r.tabIndex, -1);
  }
  assert.equal(row("Checkout feat/x").dataset.action, "checkout-ref");
  assert.ok(row("Reset (hard)").classList.contains("ctx-danger"));
  assert.equal(row("Revert").classList.contains("ctx-danger"), false);
  assert.equal(doc.activeElement, rows()[0], "the first row has the keyboard");
});

test("Drop commit… is offered beside Revert only when main said it can work", () => {
  const { menu } = harness();
  menu.open(SHA, 10, 10, [], { drop: true });
  const labels = rows().map((r) => r.textContent);
  assert.equal(labels[labels.indexOf("Revert") + 1], "Drop commit…");
  assert.ok(row("Drop commit…").classList.contains("ctx-danger"));
  menu.open(SHA, 10, 10);
  assert.equal(
    rows().some((r) => r.textContent === "Drop commit…"),
    false,
  );
  assert.equal(doc.querySelectorAll(".ctx-menu").length, 1, "re-opening replaces, never stacks");
});

test("the menu stays on screen with an 8px margin", () => {
  const { menu } = harness();
  menu.open(SHA, 300, 200);
  assert.deepEqual([px(menuEl()!.style.left), px(menuEl()!.style.top)], [300, 200]);
  menu.open(SHA, 1150, 780);
  assert.deepEqual([px(menuEl()!.style.left), px(menuEl()!.style.top)], [1200 - 220 - 8, 800 - 300 - 8]);
  dom.window.innerWidth = 100;
  dom.window.innerHeight = 100;
  menu.open(SHA, 50, 50);
  assert.deepEqual([px(menuEl()!.style.left), px(menuEl()!.style.top)], [8, 8]);
});

// ── the keyboard ─────────────────────────────────────────────────────────────

test("arrows wrap, Home/End jump, Enter runs the focused row", () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10);
  mock.timers.tick(0);
  const all = rows();
  press("ArrowUp");
  assert.equal(doc.activeElement, all.at(-1));
  press("ArrowDown");
  assert.equal(doc.activeElement, all[0]);
  press("End");
  assert.equal(doc.activeElement.textContent, "Copy SHA");
  press("Home");
  assert.equal(doc.activeElement.textContent, "Checkout");
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown");
  assert.equal(doc.activeElement.textContent, "Cherry-pick");
  press("Enter");
  assert.deepEqual(sent, [{ action: "cherry-pick", sha: SHA, name: undefined }]);
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, graphRow, "focus is back on the graph row");
});

test("Space runs the focused row; Enter with nothing focused in the menu does nothing", () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10);
  // Before the deferred focus: the keyboard is still on the graph row.
  press("Enter");
  assert.deepEqual(sent, []);
  press("ArrowDown");
  assert.equal(doc.activeElement.textContent, "Checkout", "Down from outside lands on the first row");
  press("End");
  press(" ");
  assert.deepEqual(sent, [{ action: "copy-sha", sha: SHA, name: undefined }]);
});

test("ArrowUp from outside the rows lands on the last one", () => {
  const { menu } = harness();
  menu.open(SHA, 10, 10);
  press("ArrowUp");
  assert.equal(doc.activeElement.textContent, "Copy SHA");
});

test("Escape closes and returns focus into the graph's shadow root; the page never hears it", () => {
  // The graph's rows live inside <gitstudio-graph>'s shadow root: the document
  // sees only the host as focused.
  const host = doc.createElement("gitstudio-graph");
  const inner = doc.createElement("div");
  inner.tabIndex = 0;
  doc.body.append(host, inner);
  host.tabIndex = 0;
  host.focus();
  host.shadowRoot = { activeElement: inner };
  let pageEscapes = 0;
  const onPage = (e: { key: string }): void => void (e.key === "Escape" && pageEscapes++);
  doc.addEventListener("keydown", onPage as never);
  const { menu } = harness();
  menu.open(SHA, 10, 10);
  mock.timers.tick(0);
  const e = press("Escape");
  doc.removeEventListener("keydown", onPage as never);
  assert.equal(e.defaultPrevented, true);
  assert.equal(pageEscapes, 0);
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, inner, "not the host, which has nowhere to put the arrows");
});

test("Tab closes without dragging focus back; a click anywhere closes too", () => {
  const { menu } = harness();
  menu.open(SHA, 10, 10);
  mock.timers.tick(0);
  press("Tab");
  assert.equal(menuEl(), null);
  assert.notEqual(doc.activeElement, graphRow);

  menu.open(SHA, 10, 10);
  mock.timers.tick(0);
  const baseKeys = doc.listenerCount("keydown");
  fire(doc.body, "click");
  assert.equal(menuEl(), null);
  assert.equal(doc.listenerCount("keydown"), baseKeys - 1, "its key listener went with it");
  assert.equal(doc.listenerCount("click"), 0);
  graphRow.focus();
  const after = press("ArrowDown");
  assert.equal(after.defaultPrevented, false, "a closed menu answers no keys");
  assert.equal(doc.activeElement, graphRow);
});

test("a route change closes the menu without moving focus", () => {
  const { menu } = harness();
  menu.open(SHA, 10, 10);
  mock.timers.tick(0);
  assert.equal(overlays.isMenuOpen(), true);
  overlays.dismissLayers();
  assert.equal(menuEl(), null);
  assert.equal(overlays.isMenuOpen(), false);
  assert.notEqual(doc.activeElement, graphRow);
});

// ── what a click sends ───────────────────────────────────────────────────────

test("an item with no question dispatches at once, and the click does not reach the page", () => {
  const { menu, sent } = harness();
  let pageClicks = 0;
  const onPage = (): void => void pageClicks++;
  doc.body.addEventListener("click", onPage as never);
  menu.open(SHA, 10, 10);
  row("Copy SHA").click();
  doc.body.removeEventListener("click", onPage as never);
  assert.deepEqual(sent, [{ action: "copy-sha", sha: SHA, name: undefined }]);
  assert.equal(pageClicks, 0);
});

test("a branch checkout from the menu carries the ref, its kind and its full name", () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10, [{ name: "feat/x", kind: "head", fullName: "refs/heads/feat/x" }]);
  row("Checkout feat/x").click();
  assert.deepEqual(sent, [{ action: "checkout-ref", sha: SHA, name: "feat/x", refKind: "head", fullName: "refs/heads/feat/x" }]);
});

test("a tag checkout asks first: it will detach HEAD", async () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10, [{ name: "v1.0", kind: "tag" }]);
  row("Checkout v1.0…").click();
  mock.timers.tick(0);
  assert.match(text(dialog()!.querySelector(".modal-message")), /detached HEAD/);
  assert.equal(text(dialog()!.querySelector(".modal-ok")), "Checkout v1.0");
  dialog()!.querySelector(".modal-ok")!.click();
  await settle();
  assert.deepEqual(sent, [{ action: "checkout-ref", sha: SHA, name: "v1.0", refKind: "tag" }]);
});

test("Revert is confirm-gated: Cancel sends nothing, the confirm sends the revert", async () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10);
  row("Revert").click();
  mock.timers.tick(0);
  assert.equal(text(dialog()!.querySelector(".modal-title")), "Revert");
  assert.equal(text(dialog()!.querySelector(".modal-message")), "Create a revert commit for this commit?");
  dialog()!.querySelector(".mini-btn")!.click();
  await settle();
  assert.deepEqual(sent, []);
  assert.equal(doc.activeElement, graphRow, "the dialog hands the keyboard back to the graph");

  menu.open(SHA, 10, 10);
  row("Revert").click();
  mock.timers.tick(0);
  dialog()!.querySelector(".modal-ok")!.click();
  await settle();
  assert.deepEqual(sent, [{ action: "revert", sha: SHA, name: undefined }]);
});

test("Reset (hard) is a danger confirm whose button says Reset and which starts on Cancel", async () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10);
  row("Reset (hard)").click();
  mock.timers.tick(0);
  const ok = dialog()!.querySelector(".modal-ok")!;
  assert.equal(text(ok), "Reset");
  assert.ok(ok.classList.contains("btn-danger"));
  assert.equal(doc.activeElement, dialog()!.querySelector(".mini-btn"));
  ok.click();
  await settle();
  assert.deepEqual(sent, [{ action: "reset-hard", sha: SHA, name: undefined }]);
});

test("Create branch here… asks for the name and sends it trimmed; an empty name sends nothing", async () => {
  const { menu, sent } = harness();
  menu.open(SHA, 10, 10);
  row("Create branch here…").click();
  mock.timers.tick(0);
  const field = dialog()!.querySelector(".modal-input")!;
  assert.equal(text(dialog()!.querySelector(".modal-title")), "Create branch here");
  assert.equal(field.placeholder, "feature/my-branch");
  field.value = "  feat/login ";
  press("Enter");
  await settle();
  assert.deepEqual(sent, [{ action: "branch", sha: SHA, name: "feat/login" }]);

  menu.open(SHA, 10, 10);
  row("Create tag here…").click();
  mock.timers.tick(0);
  press("Enter");
  await settle();
  assert.equal(sent.length, 1, "no nameless tag request");
});

test("Drop commit… runs its own flow, not a commit:action", () => {
  const { menu, sent, dropped } = harness();
  menu.open(SHA, 10, 10, [], { drop: true });
  row("Drop commit…").click();
  assert.deepEqual(dropped, [SHA]);
  assert.deepEqual(sent, []);
});

test("a menu built without a drop handler ignores Drop rather than throwing", () => {
  const sent: CommitActionRequest[] = [];
  const menu = new cm.CommitContextMenu((r) => sent.push(r));
  menu.open(SHA, 10, 10, [], { drop: true });
  row("Drop commit…").click();
  assert.deepEqual(sent, []);
  menu.openMany([SHA, SHA], 10, 10, { apply: true, drop: false, squash: false });
  row("Copy SHAs").click();
  assert.equal(menuEl(), null);
});

// ── several commits ──────────────────────────────────────────────────────────

test("several commits: headed in words, only what applies, and a pick hands over every sha", () => {
  const { menu, many } = harness();
  const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  menu.openMany(shas, 40, 40, { apply: true, drop: true, squash: false });
  mock.timers.tick(0);
  const m = menuEl()!;
  assert.equal(m.getAttribute("aria-label"), "Actions for 3 commits");
  const head = m.querySelector(".ctx-menu-header")!;
  assert.equal(head.textContent, "3 commits selected");
  assert.ok(head.classList.contains("is-words"));
  assert.deepEqual(rows().map((r) => r.textContent), ["Cherry-pick 3 commits", "Revert 3 commits", "Drop 3 commits…", "Copy SHAs"]);
  assert.ok(row("Drop 3 commits…").classList.contains("ctx-danger"));
  assert.equal(row("Revert 3 commits").dataset.action, "revert-many");
  assert.equal(doc.activeElement, rows()[0]);
  row("Drop 3 commits…").click();
  assert.deepEqual(many, [["drop-many", shas]]);
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, graphRow, "closed BEFORE the flow's dialog captures focus");
});

// ── from outside the menu ────────────────────────────────────────────────────

test("checkoutRef from a chip asks the same question as the menu, and declines what the menu declines", async () => {
  const { menu, sent } = harness();
  menu.checkoutRef(SHA, { name: "origin/fix", kind: "remote", fullName: "refs/remotes/origin/fix" });
  assert.deepEqual(sent, [
    { action: "checkout-ref", sha: SHA, name: "origin/fix", refKind: "remote", fullName: "refs/remotes/origin/fix" },
  ]);
  menu.checkoutRef(SHA, { name: "main", kind: "head", current: true });
  assert.equal(sent.length, 1, "the branch you are on is not checked out again");
  menu.checkoutRef(SHA, { name: "v2", kind: "tag" });
  mock.timers.tick(0);
  assert.ok(dialog(), "a tag asks first here too");
  dialog()!.querySelector(".mini-btn")!.click();
  await settle();
  assert.equal(sent.length, 1);
});

test("askForCommitAction and commitActionItem: the one table the toolbar shares", async () => {
  assert.equal(cm.commitActionItem("revert")?.confirm, "Create a revert commit for this commit?");
  assert.equal(cm.commitActionItem("nope"), undefined);
  assert.deepEqual(await cm.askForCommitAction(cm.commitActionItem("cherry-pick")!), { ok: true, name: undefined });

  const tag = cm.askForCommitAction(cm.commitActionItem("tag")!);
  mock.timers.tick(0);
  assert.equal(text(dialog()!.querySelector(".modal-title")), "Create tag here");
  assert.equal(dialog()!.querySelector(".modal-input")!.placeholder, "v1.0.0");
  dialog()!.querySelector(".modal-input")!.value = "v3.1.0";
  dialog()!.querySelector(".modal-ok")!.click();
  assert.deepEqual(await tag, { ok: true, name: "v3.1.0" });

  const soft = cm.askForCommitAction(cm.commitActionItem("reset-soft")!);
  mock.timers.tick(0);
  assert.equal(text(dialog()!.querySelector(".modal-ok")), "Reset (soft)", "a non-danger confirm uses the item's own words");
  press("Escape");
  assert.deepEqual(await soft, { ok: false });
});
