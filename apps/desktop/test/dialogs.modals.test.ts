// The in-app dialogs (dialogs.ts) that replace alert/confirm/prompt: what each
// shows, what each resolves for every way it can be answered (button, Enter,
// Escape, backdrop, a route change, an abort), where the keyboard goes while it
// is open and after it closes, and the toasts that report outcomes.
//
// Rendered into helpers/miniDom.ts and driven the way a person would — clicks
// on the buttons, keys on the focused element.

import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMiniDom, fire, press, settle, text, type MiniElement } from "./helpers/miniDom";

const dom = installMiniDom();
type D = typeof import("../src/renderer/dialogs");
let d!: D;
let overlays!: typeof import("../src/renderer/overlays");
before(async () => {
  d = (await import("../src/renderer/dialogs")) as D;
  overlays = await import("../src/renderer/overlays");
});

const doc = dom.document;
let shell!: MiniElement;
let opener!: MiniElement;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  doc.body.replaceChildren();
  doc.body.classList.remove("cmdk-open");
  shell = doc.createElement("div");
  shell.id = "app-shell";
  opener = doc.createElement("button");
  opener.textContent = "Delete branch";
  shell.appendChild(opener);
  doc.body.appendChild(shell);
  opener.focus();
});
afterEach(() => {
  // Nothing may leak into the next test: close whatever is still up.
  for (const o of doc.querySelectorAll(".modal-overlay")) {
    const cancel = o.querySelector(".mini-btn");
    cancel?.click();
  }
  overlays.dismissLayers();
  mock.timers.reset();
});

const overlay = (): MiniElement | null => doc.querySelectorAll(".modal-overlay").at(-1) ?? null;
const okBtn = (): MiniElement => overlay()!.querySelector(".modal-ok")!;
const cancelBtn = (): MiniElement => overlay()!.querySelector(".modal-actions .mini-btn")!;
const input = (): MiniElement => overlay()!.querySelector(".modal-input")!;
/** Let the modal's deferred focus run. */
const mounted = (): void => mock.timers.tick(0);

// ── toasts ───────────────────────────────────────────────────────────────────

test("a toast goes into one polite live region, with its kind's icon, and slides in on the next frame", () => {
  d.toast("Pushed main to origin", "success");
  d.toast("Something failed", "error");
  d.toast("FYI");
  const stacks = doc.querySelectorAll("#toast-stack");
  assert.equal(stacks.length, 1, "one stack, reused");
  const stack = stacks[0];
  assert.equal(stack.getAttribute("role"), "status");
  assert.equal(stack.getAttribute("aria-live"), "polite");
  const [ok, err, info] = stack.querySelectorAll(".toast");
  assert.ok(ok.classList.contains("toast-success") && ok.querySelector(".codicon-pass-filled"));
  assert.ok(err.classList.contains("toast-error") && err.querySelector(".codicon-error"));
  assert.ok(info.classList.contains("toast-info") && info.querySelector(".codicon-info"));
  assert.equal(text(ok.querySelector(".toast-msg")), "Pushed main to origin");
  assert.equal(ok.querySelector(".toast-close")!.getAttribute("aria-label"), "Dismiss");
  assert.equal(ok.classList.contains("in"), false);
  mock.timers.tick(0);
  assert.ok(ok.classList.contains("in"));
});

test("toasts time out by kind: 4s info, 7s error, 10s when there is something to undo", () => {
  d.toast("info");
  d.toast("error", "error");
  d.toast("undoable", "success", undefined, { label: "Undo", onClick: () => {} });
  d.toast("custom", "info", 1000);
  const alive = (): string[] => doc.querySelectorAll(".toast:not(.out)").map((t) => text(t.querySelector(".toast-msg")));
  mock.timers.tick(999);
  assert.deepEqual(alive(), ["info", "error", "undoable", "custom"]);
  mock.timers.tick(1);
  assert.deepEqual(alive(), ["info", "error", "undoable"]);
  mock.timers.tick(3000);
  assert.deepEqual(alive(), ["error", "undoable"]);
  mock.timers.tick(3000);
  assert.deepEqual(alive(), ["undoable"]);
  mock.timers.tick(3000);
  assert.deepEqual(alive(), []);
  mock.timers.tick(280);
  assert.equal(doc.querySelectorAll(".toast").length, 0, "gone from the DOM once the exit has played");
});

test("a toast's action dismisses it FIRST, then runs; actions keep the order offered", () => {
  const seen: string[] = [];
  d.toast("Commit hidden by the filter", "info", undefined, [
    { label: "Add feat/x to the filter", onClick: () => seen.push(`add:${doc.querySelector(".toast")!.classList.contains("out")}`) },
    { label: "Show all branches", onClick: () => seen.push("all") },
  ]);
  const t = doc.querySelector(".toast")!;
  const acts = t.querySelectorAll(".toast-action");
  assert.deepEqual(acts.map((a) => a.textContent), ["Add feat/x to the filter", "Show all branches"]);
  assert.equal(t.children.at(-1), t.querySelector(".toast-close"), "Dismiss stays last");
  acts[0].click();
  assert.deepEqual(seen, ["add:true"], "the toast was already leaving when the handler re-rendered");
  fire(t, "transitionend");
  assert.equal(t.isConnected, false);
  acts[1].click();
  assert.deepEqual(seen, ["add:true", "all"]);
});

test("Dismiss takes a toast down; clearToasts takes every one down", () => {
  d.toast("one");
  d.toast("two");
  const [one] = doc.querySelectorAll(".toast");
  one.querySelector(".toast-close")!.click();
  assert.ok(one.classList.contains("out"));
  mock.timers.tick(280);
  assert.equal(one.isConnected, false);
  one.querySelector(".toast-close")!.click(); // a second dismiss of a removed toast is a no-op
  d.clearToasts();
  assert.equal(doc.querySelectorAll(".toast").length, 0);
  assert.ok(doc.getElementById("toast-stack"), "the live region itself stays");
  d.clearToasts();
});

// ── the modal scaffold ───────────────────────────────────────────────────────

function openBare(spec: Partial<import("../src/renderer/dialogs").ModalSpec> = {}) {
  const log: string[] = [];
  let close!: () => void;
  const card = doc.createElement("div");
  card.className = "modal-card";
  const a = doc.createElement("button");
  a.textContent = "A";
  const hidden = doc.createElement("button");
  hidden.hidden = true;
  const b = doc.createElement("input");
  const dis = doc.createElement("button");
  dis.disabled = true;
  card.append(a, hidden, b, dis);
  d.openModal((c) => {
    close = c;
    return { card: card as never, focusEl: a as never, label: "Bare", onClose: () => log.push("closed"), ...spec };
  });
  mounted();
  return { log, close: () => close(), card, a, b };
}

test("a modal is a labelled dialog that holds the page behind it and focuses its field", () => {
  d.toast("still readable");
  const { a } = openBare();
  const o = overlay()!;
  assert.equal(o.getAttribute("role"), "dialog");
  assert.equal(o.getAttribute("aria-modal"), "true");
  assert.equal(o.getAttribute("aria-label"), "Bare");
  assert.equal(shell.hasAttribute("inert"), true, "the app behind cannot be tabbed into");
  assert.equal(doc.getElementById("toast-stack")!.hasAttribute("inert"), false, "toasts stay live");
  assert.equal(doc.activeElement, a);
  assert.equal(overlays.isModalOpen(), true);
});

test("closing gives the keyboard back to what had it, after releasing the page", () => {
  const { close, log } = openBare();
  close();
  close();
  assert.deepEqual(log, ["closed"], "onClose runs once however many times close is called");
  assert.equal(overlay(), null);
  assert.equal(shell.hasAttribute("inert"), false);
  assert.equal(doc.activeElement, opener);
  assert.equal(overlays.isModalOpen(), false);
});

test("Escape and the backdrop dismiss; canDismiss can veto both, but not the modal's own close", () => {
  let allow = false;
  const { log, card, close } = openBare({ canDismiss: () => allow });
  press("Escape");
  fire(overlay()!, "mousedown");
  assert.ok(overlay(), "a clone mid-flight keeps its dialog");
  allow = true;
  fire(card, "mousedown");
  assert.ok(overlay(), "a press INSIDE the card is not the backdrop");
  fire(overlay()!, "mousedown");
  assert.equal(overlay(), null);
  assert.deepEqual(log, ["closed"]);

  allow = false;
  const second = openBare({ canDismiss: () => allow });
  second.close();
  assert.equal(overlay(), null, "the explicit close always works");
  void close;
});

test("Escape dismisses only the topmost modal", () => {
  const first = openBare();
  const second = openBare();
  press("Escape");
  assert.deepEqual(second.log, ["closed"]);
  assert.deepEqual(first.log, [], "the dialog underneath survives");
  assert.ok(overlay());
  assert.equal(doc.activeElement, first.a, "the keyboard returns into the first dialog");
  press("Escape");
  assert.deepEqual(first.log, ["closed"]);
});

test("Escape belongs to the command palette or a menu when one is open over the dialog", () => {
  const { log } = openBare();
  doc.body.classList.add("cmdk-open");
  press("Escape");
  assert.deepEqual(log, []);
  doc.body.classList.remove("cmdk-open");
  const menu = overlays.registerLayer(() => {}, "menu");
  press("Escape");
  assert.deepEqual(log, [], "a menu opened from inside the dialog closes first");
  menu.release();
  press("Escape");
  assert.deepEqual(log, ["closed"]);
});

test("Tab wraps inside the card, skipping disabled and hidden controls", () => {
  const { a, b } = openBare();
  b.focus();
  const e = press("Tab");
  assert.equal(e.defaultPrevented, true);
  assert.equal(doc.activeElement, a, "from the last reachable control back to the first");
  const back = press("Tab", { shiftKey: true });
  assert.equal(back.defaultPrevented, true);
  assert.equal(doc.activeElement, b);
  a.focus();
  assert.equal(press("Tab").defaultPrevented, false, "in the middle, Tab moves on its own");
  assert.equal(press("x").defaultPrevented, false);
});

test("a card with nothing focusable leaves Tab alone", () => {
  const card = doc.createElement("div");
  const title = doc.createElement("div");
  card.appendChild(title);
  d.openModal(() => ({ card: card as never, focusEl: title as never, onClose: () => {} }));
  mounted();
  assert.equal(press("Tab").defaultPrevented, false);
  assert.equal(overlay()!.hasAttribute("aria-label"), false, "no label given, none invented");
});

test("a route change closes a modal — unless it holds unsaved work, and then it stays registered", () => {
  let dirty = true;
  const { log } = openBare({ hasUnsavedWork: () => dirty });
  overlays.dismissLayers();
  assert.ok(overlay(), "the half-written form survives a background refresh");
  assert.equal(overlays.openLayerCount(), 1, "…and the registry still knows it is open");
  dirty = false;
  overlays.dismissLayers();
  assert.equal(overlay(), null);
  assert.deepEqual(log, ["closed"]);
});

// ── confirmDialog ────────────────────────────────────────────────────────────

test("confirm: title, message, the action's own word, and Confirm resolves true", async () => {
  const p = d.confirmDialog({ title: "Revert", message: "Create a revert commit?", confirmLabel: "Revert" });
  mounted();
  const o = overlay()!;
  assert.equal(text(o.querySelector(".modal-title")), "Revert");
  assert.equal(text(o.querySelector(".modal-message")), "Create a revert commit?");
  assert.equal(text(okBtn()), "Revert");
  assert.ok(okBtn().classList.contains("btn-primary"));
  assert.equal(doc.activeElement, okBtn(), "a safe confirm starts on its button");
  okBtn().click();
  assert.equal(await p, true);
  assert.equal(doc.activeElement, opener);
});

test("a danger confirm starts on Cancel, so a reflexive Return does not destroy anything", async () => {
  const p = d.confirmDialog({ title: "Reset", message: "Discard all changes?", danger: true });
  mounted();
  assert.equal(text(okBtn()), "Confirm");
  assert.ok(okBtn().classList.contains("btn-danger"));
  assert.equal(doc.activeElement, cancelBtn());
  cancelBtn().click();
  assert.equal(await p, false);
});

test("confirm: Escape and a route change answer false", async () => {
  const p1 = d.confirmDialog({ title: "t", message: "m" });
  mounted();
  press("Escape");
  assert.equal(await p1, false);
  const p2 = d.confirmDialog({ title: "t", message: "m" });
  mounted();
  overlays.dismissLayers();
  assert.equal(await p2, false);
});

test("confirm with requireTyped: Confirm stays off until the exact name is typed", async () => {
  const p = d.confirmDialog({ title: "Delete repository", message: "This deletes files.", danger: true, requireTyped: "gitstudio" });
  mounted();
  const field = overlay()!.querySelector(".confirm-typed-input")!;
  assert.equal(text(overlay()!.querySelector(".confirm-typed-hint")), "Type gitstudio to confirm.");
  assert.notEqual(field.placeholder, "gitstudio", "the answer is not printed inside the box");
  assert.equal(field.getAttribute("aria-label"), "Type gitstudio to confirm");
  assert.equal(doc.activeElement, field, "the dialog starts in the field you must fill in");
  assert.equal(okBtn().hasAttribute("disabled"), true);
  okBtn().click();
  press("Enter");
  field.value = "gitstudi";
  fire(field, "input");
  press("Enter");
  assert.ok(overlay(), "neither a click nor Enter gets through before the name matches");
  field.value = "  gitstudio ";
  fire(field, "input");
  assert.equal(okBtn().hasAttribute("disabled"), false);
  const enter = press("Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(await p, true);
});

test("confirm: an abort from outside closes it and answers false, once", async () => {
  const ctl = new AbortController();
  const p = d.confirmDialog({ title: "Run tool?", message: "shell", signal: ctl.signal });
  mounted();
  ctl.abort();
  assert.equal(await p, false);
  assert.equal(overlay(), null, "no Approve button left pointing at a finished run");

  const ctl2 = new AbortController();
  const p2 = d.confirmDialog({ title: "Run tool?", message: "shell", signal: ctl2.signal });
  mounted();
  okBtn().click();
  ctl2.abort();
  assert.equal(await p2, true, "an abort after the answer changes nothing");
});

test("confirm with holdWhile stays up through a background re-route until the user answers", async () => {
  let sameRepo = true;
  const p = d.confirmDialog({ title: "Abort the rebase?", message: "m", holdWhile: () => sameRepo });
  mounted();
  overlays.dismissLayers();
  assert.ok(overlay());
  sameRepo = false;
  overlays.dismissLayers();
  assert.equal(await p, false);
});

// ── promptInline ─────────────────────────────────────────────────────────────

test("prompt: what it shows, and Create resolves the trimmed text", async () => {
  const p = d.promptInline("Create branch", "feature/my-branch", "  seed ");
  mounted();
  const o = overlay()!;
  assert.equal(o.getAttribute("aria-label"), "Create branch");
  assert.equal(text(o.querySelector(".modal-title")), "Create branch");
  assert.equal(input().placeholder, "feature/my-branch");
  assert.equal(input().value, "  seed ");
  assert.equal(text(okBtn()), "Create");
  assert.equal(doc.activeElement, input());
  assert.equal(o.querySelector(".prompt-error"), null, "no validation asked for, none shown");
  input().value = "  feat/login  ";
  okBtn().click();
  assert.equal(await p, "feat/login");
});

test("prompt: Enter submits, an empty answer is a cancel, Escape and Cancel resolve null", async () => {
  const p1 = d.promptInline("Tag", "v1.0.0", "", "Tag");
  mounted();
  input().value = "v2.0.0";
  assert.equal(press("Enter").defaultPrevented, true);
  assert.equal(await p1, "v2.0.0");

  const p2 = d.promptInline("Tag", "v1.0.0");
  mounted();
  input().value = "   ";
  press("Enter");
  assert.equal(await p2, null);

  const p3 = d.promptInline("Tag", "v1.0.0");
  mounted();
  press("Escape");
  assert.equal(await p3, null);

  const p4 = d.promptInline("Tag", "v1.0.0");
  mounted();
  press("a");
  cancelBtn().click();
  assert.equal(await p4, null);
});

test("prompt with allowEmpty tells 'cleared' from 'cancelled'", async () => {
  const p = d.promptInline("Description", "none", "old", "Save", true);
  mounted();
  input().value = "  ";
  okBtn().click();
  assert.equal(await p, "", "cleared is an empty string");
  const p2 = d.promptInline("Description", "none", "old", "Save", true);
  mounted();
  cancelBtn().click();
  assert.equal(await p2, null, "cancelled is null");
});

test("prompt with a hint describes the field with it", async () => {
  const p = d.promptInline("Rename", "name", "", "Rename", false, { hint: "Only the local branch is renamed." });
  mounted();
  const hint = overlay()!.querySelector("#gs-prompt-hint")!;
  assert.equal(hint.textContent, "Only the local branch is renamed.");
  assert.equal(input().getAttribute("aria-describedby"), "gs-prompt-hint");
  cancelBtn().click();
  await p;
});

test("prompt with refName validation: says why, disables Create, offers a repaired name", async () => {
  const p = d.promptInline("Create branch", "name", "", "Create", false, { validate: "refName", hint: "h" });
  mounted();
  const err = overlay()!.querySelector(".prompt-error")!;
  const sug = overlay()!.querySelector(".prompt-suggest")!;
  assert.equal(input().getAttribute("aria-describedby"), "gs-prompt-hint gs-prompt-error");
  assert.equal(input().spellcheck, false);
  assert.equal(err.hidden, true, "an empty field is not scolded");
  assert.equal(okBtn().hasAttribute("disabled"), true, "…but cannot be submitted either");

  input().value = "my feature";
  fire(input(), "input");
  assert.equal(err.hidden, false);
  assert.equal(err.getAttribute("role"), "alert");
  assert.equal(err.textContent, "Cannot contain spaces.");
  assert.equal(input().getAttribute("aria-invalid"), "true");
  assert.ok(input().classList.contains("is-invalid"));
  assert.equal(okBtn().hasAttribute("disabled"), true);
  assert.equal(sug.hidden, false);
  assert.equal(sug.querySelector("code")!.textContent, "my-feature");
  press("Enter");
  assert.ok(overlay(), "Enter with a refused name does nothing");

  sug.querySelector(".prompt-suggest-use")!.click();
  assert.equal(input().value, "my-feature");
  assert.equal(doc.activeElement, input());
  assert.equal(input().selectionStart, "my-feature".length, "the caret goes to the end");
  assert.equal(err.hidden, true);
  assert.equal(sug.hidden, true);
  assert.equal(okBtn().hasAttribute("disabled"), false);
  okBtn().click();
  assert.equal(await p, "my-feature");
});

test("prompt: the caller's extra rule blocks too, and suggest:false offers no repair", async () => {
  const p = d.promptInline("Create branch", "name", "", "Create", false, {
    validate: "refName",
    suggest: false,
    extra: (v) => (v === "main" ? "A branch named main already exists." : null),
  });
  mounted();
  input().value = "main";
  fire(input(), "input");
  assert.equal(overlay()!.querySelector(".prompt-error")!.textContent, "A branch named main already exists.");
  assert.equal(okBtn().hasAttribute("disabled"), true);
  input().value = "a b";
  fire(input(), "input");
  assert.equal(overlay()!.querySelector(".prompt-suggest")!.hidden, true);
  input().value = "main2";
  fire(input(), "input");
  assert.equal(okBtn().hasAttribute("disabled"), false);
  okBtn().click();
  assert.equal(await p, "main2");
});

test("prompt with a checkbox: the button says what a ticked box will do, and the tick is read back", async () => {
  const check = { label: "Check out the new branch", checked: false, okLabelChecked: "Create & checkout" };
  const p = d.promptInline("Create branch", "name", "", "Create", false, { check });
  mounted();
  const box = overlay()!.querySelector(".modal-check input")!;
  assert.equal(text(overlay()!.querySelector(".modal-check")), "Check out the new branch");
  assert.equal(box.type, "checkbox");
  assert.equal(text(okBtn()), "Create");
  box.checked = true;
  fire(box, "change");
  assert.equal(text(okBtn()), "Create & checkout");
  input().value = "feat/x";
  okBtn().click();
  assert.equal(await p, "feat/x");
  assert.equal(check.checked, true, "the caller reads the box's state back");
});

test("a half-typed prompt survives a background re-route", async () => {
  const p = d.promptInline("Create branch", "name", "seed");
  mounted();
  overlays.dismissLayers();
  assert.equal(overlay(), null, "untouched, it closes like any layer");
  assert.equal(await p, null);

  const p2 = d.promptInline("Create branch", "name", "seed");
  mounted();
  input().value = "seed-and-more";
  overlays.dismissLayers();
  assert.ok(overlay(), "typed into, it stays");
  cancelBtn().click();
  assert.equal(await p2, null);
});

// ── promptMessage ────────────────────────────────────────────────────────────

test("message editor: pre-filled, caret at the start, ⌘/Ctrl+Enter confirms, Enter is a new line", async () => {
  const p = d.promptMessage({ title: "Squash 3 commits", hint: "They become one.", value: "first\n\nsecond", okLabel: "Squash" });
  mounted();
  const area = overlay()!.querySelector("textarea")!;
  assert.equal(area.value, "first\n\nsecond");
  assert.equal(area.getAttribute("aria-label"), "Commit message");
  assert.equal(area.getAttribute("aria-describedby"), "gs-msg-hint");
  assert.equal(text(overlay()!.querySelector("#gs-msg-hint")), "They become one.");
  assert.equal(doc.activeElement, area);
  assert.equal(area.selectionStart, 0, "the first keystroke edits, it does not replace");
  assert.equal(area.selectionEnd, 0);
  assert.equal(text(okBtn()), "Squash");
  assert.equal(press("Enter").defaultPrevented, false);
  assert.ok(overlay());
  area.value = "  squashed  ";
  press("Enter", { metaKey: true });
  assert.equal(await p, "squashed");

  const p2 = d.promptMessage({ title: "t", hint: "h", value: "x", okLabel: "OK", label: "Tag message" });
  mounted();
  assert.equal(overlay()!.querySelector("textarea")!.getAttribute("aria-label"), "Tag message");
  press("Enter", { ctrlKey: true });
  assert.equal(await p2, "x");
});

test("message editor: an empty message cannot be confirmed; Cancel resolves null", async () => {
  const p = d.promptMessage({ title: "t", hint: "h", value: "msg", okLabel: "OK" });
  mounted();
  const area = overlay()!.querySelector("textarea")!;
  area.value = "   ";
  fire(area, "input");
  assert.equal(okBtn().hasAttribute("disabled"), true);
  press("Enter", { metaKey: true });
  okBtn().click();
  assert.ok(overlay());
  area.value = "back";
  fire(area, "input");
  assert.equal(okBtn().hasAttribute("disabled"), false);
  cancelBtn().click();
  assert.equal(await p, null);
});

test("message editor: an edited message, or holdWhile, keeps it through a re-route", async () => {
  let hold = true;
  const p = d.promptMessage({ title: "t", hint: "h", value: "msg", okLabel: "OK", holdWhile: () => hold });
  mounted();
  overlays.dismissLayers();
  assert.ok(overlay());
  hold = false;
  overlay()!.querySelector("textarea")!.value = "edited";
  overlays.dismissLayers();
  assert.ok(overlay(), "edited text is work in progress");
  overlay()!.querySelector("textarea")!.value = "msg";
  overlays.dismissLayers();
  assert.equal(await p, null);
});

// ── promptChoice ─────────────────────────────────────────────────────────────

const choices = [
  { id: "merge", label: "Merge", sub: "Merge origin/main into main", icon: "git-merge" },
  { id: "rebase", label: "Rebase", sub: "Replay your 2 commits on top of origin/main" },
  { id: "ff", label: "Fast-forward only", sub: "Refuse if it cannot" },
];

test("choice: each option shows its label and its full consequence; a pick is the answer", async () => {
  const p = d.promptChoice({ title: "Branches have diverged", hint: "Pick one.", choices, cancelId: "cancel" });
  mounted();
  const o = overlay()!;
  assert.equal(text(o.querySelector(".modal-message")), "Pick one.");
  const rows = o.querySelectorAll(".modal-choice");
  assert.deepEqual(rows.map((r) => text(r.querySelector(".modal-choice-label"))), ["Merge", "Rebase", "Fast-forward only"]);
  assert.equal(text(rows[1].querySelector(".modal-choice-sub")), "Replay your 2 commits on top of origin/main");
  assert.ok(rows[0].querySelector(".codicon-git-merge"));
  assert.equal(rows[1].querySelector(".glyph"), null);
  assert.equal(rows[0].type, "button");
  assert.equal(doc.activeElement, rows[0]);
  rows[1].click();
  assert.equal(await p, "rebase");
});

test("choice: arrows wrap, Home/End jump, Enter picks via the focused button", async () => {
  const p = d.promptChoice({ title: "t", choices, cancelId: "cancel" });
  mounted();
  const rows = overlay()!.querySelectorAll(".modal-choice");
  assert.equal(overlay()!.querySelector(".modal-message"), null, "no hint, no empty line");
  press("ArrowUp");
  assert.equal(doc.activeElement, rows[2]);
  press("ArrowDown");
  assert.equal(doc.activeElement, rows[0]);
  press("End");
  assert.equal(doc.activeElement, rows[2]);
  press("Home");
  assert.equal(doc.activeElement, rows[0]);
  assert.equal(press("x").defaultPrevented, false);
  cancelBtn().focus();
  assert.equal(press("ArrowDown").defaultPrevented, false, "keys off the rows are not the list's");
  (doc.activeElement as MiniElement).click();
  assert.equal(await p, "cancel");
});

test("choice: Escape, the backdrop and a re-route all resolve the cancel id — unless held", async () => {
  const p1 = d.promptChoice({ title: "t", choices, cancelId: "keep" });
  mounted();
  press("Escape");
  assert.equal(await p1, "keep");

  const p2 = d.promptChoice({ title: "t", choices, cancelId: "keep" });
  mounted();
  fire(overlay()!, "mousedown");
  assert.equal(await p2, "keep");

  let hold = true;
  const p3 = d.promptChoice({ title: "Rename on origin too?", choices, cancelId: "no", holdWhile: () => hold });
  mounted();
  overlays.dismissLayers();
  assert.ok(overlay(), "the watcher's refresh does not answer for the user");
  hold = false;
  overlays.dismissLayers();
  assert.equal(await p3, "no");
});

// ── formWithRetry ────────────────────────────────────────────────────────────

test("formWithRetry: a failed submit re-opens the form with what was typed and why", async () => {
  const opens: Array<[unknown, unknown]> = [];
  const answers = ["draft 1", "draft 2"];
  const out = await d.formWithRetry<string>(
    async (seed, error) => {
      opens.push([seed, error]);
      return answers.shift() ?? null;
    },
    async (v) => (v === "draft 1" ? "Validation failed: title too long" : undefined),
  );
  assert.equal(out, "draft 2");
  assert.deepEqual(opens, [
    [undefined, undefined],
    ["draft 1", "Validation failed: title too long"],
  ]);
});

test("formWithRetry: cancelling abandons it, and a submit that always fails stops after 20 tries", async () => {
  let submits = 0;
  assert.equal(
    await d.formWithRetry<string>(
      async () => null,
      async () => {
        submits++;
        return undefined;
      },
    ),
    undefined,
  );
  assert.equal(submits, 0, "a cancel sends nothing");

  let opened = 0;
  const out = await d.formWithRetry<string>(
    async () => {
      opened++;
      return "x";
    },
    async () => "offline",
  );
  assert.equal(out, undefined);
  assert.equal(opened, 20);
  await settle();
});
