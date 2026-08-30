import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissLayers, openLayerCount, registerLayer, holdBackground } from "../src/renderer/overlays";

// Menus, modals, peeks and popovers all mount on document.body, so a view swap
// can't take them with it. The registry is what lets one call at the route
// change close whatever happens to be open — so its contract matters.

test("registered layers are disposed on dismiss", () => {
  const closed: string[] = [];
  registerLayer(() => closed.push("a"));
  registerLayer(() => closed.push("b"));
  assert.equal(openLayerCount(), 2);
  dismissLayers();
  assert.deepEqual(closed.sort(), ["a", "b"]);
  assert.equal(openLayerCount(), 0);
});

test("newest closes first — a modal opened from a menu goes before the menu", () => {
  const order: string[] = [];
  registerLayer(() => order.push("menu"));
  registerLayer(() => order.push("modal"));
  dismissLayers();
  assert.deepEqual(order, ["modal", "menu"]);
});

test("a layer that closes itself releases and is not disposed twice", () => {
  let disposals = 0;
  const h = registerLayer(() => disposals++);
  h.release();
  assert.equal(openLayerCount(), 0);
  dismissLayers();
  assert.equal(disposals, 0, "released layers must not be disposed");
});

test("dismissing while empty is a no-op", () => {
  dismissLayers();
  assert.equal(openLayerCount(), 0);
});

test("a dispose that releases itself does not skip its neighbours", () => {
  // Real openers call release() from inside their own close path, which mutates
  // the registry mid-iteration — walking the live array would skip entries.
  const closed: string[] = [];
  const handles: Array<{ release: () => void }> = [];
  for (const name of ["a", "b", "c"]) {
    const h = registerLayer(() => {
      closed.push(name);
      h.release();
    });
    handles.push(h);
  }
  dismissLayers();
  assert.deepEqual(closed.sort(), ["a", "b", "c"]);
  assert.equal(openLayerCount(), 0);
});

test("one throwing layer does not strand the others open", () => {
  const closed: string[] = [];
  registerLayer(() => closed.push("first"));
  registerLayer(() => {
    throw new Error("boom");
  });
  registerLayer(() => closed.push("last"));
  dismissLayers();
  assert.deepEqual(closed.sort(), ["first", "last"]);
  assert.equal(openLayerCount(), 0);
});

/**
 * `inert` on the app shell has to be REFCOUNTED, because two open surfaces
 * holding it at once is the ordinary case: a peek or a drawer opens a dialog.
 *
 * `holdBackground` used to skip anything already `inert`, so the inner surface
 * recorded nothing — right only when the inner one closes first. It does not
 * always: a route change disposes layers newest-first, the dialog vetoes (that
 * is what `hasUnsavedWork` is for), the drawer beneath it does not, and the
 * drawer's release stripped `inert` off the shell the surviving dialog still
 * needed. What was left was a dialog claiming `aria-modal="true"` over a fully
 * tab-reachable app — and activating anything back there routed the whole
 * window behind a dialog the user could still see.
 */
interface FakeEl {
  id: string;
  attrs: Set<string>;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
  hasAttribute(n: string): boolean;
  contains(o: unknown): boolean;
  matches(sel: string): boolean;
}

function fakeEl(id: string): FakeEl {
  const attrs = new Set<string>();
  return {
    id,
    attrs,
    setAttribute: (n) => void attrs.add(n),
    removeAttribute: (n) => void attrs.delete(n),
    hasAttribute: (n) => attrs.has(n),
    contains: (o) => o === undefined,
    matches: () => false,
  };
}

function withFakeBody<T>(children: FakeEl[], fn: () => T): T {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  g.document = { body: { children } };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.document;
    else g.document = prev;
  }
}

test("two surfaces holding the app back: the first to close does not un-hold it", () => {
  const shell = fakeEl("app-shell");
  const drawerScrim = fakeEl("drawer");
  const dialogCard = fakeEl("dialog");

  const releaseDrawer = withFakeBody([shell, drawerScrim, dialogCard], () =>
    holdBackground(drawerScrim as unknown as HTMLElement),
  );
  assert.equal(shell.hasAttribute("inert"), true, "the drawer holds the shell back");

  const releaseDialog = withFakeBody([shell, drawerScrim, dialogCard], () =>
    holdBackground(dialogCard as unknown as HTMLElement),
  );
  assert.equal(shell.hasAttribute("inert"), true, "and so does the dialog opened from it");

  // The route change disposes newest-first: the dialog vetoes and survives, the
  // drawer beneath it does not.
  releaseDrawer();
  assert.equal(
    shell.hasAttribute("inert"),
    true,
    "the shell stays held — a dialog is still open over it",
  );

  releaseDialog();
  assert.equal(shell.hasAttribute("inert"), false, "and is released when the last surface goes");
});

test("a live region is never held back, however many surfaces are open", () => {
  const shell = fakeEl("app-shell");
  const toasts = fakeEl("toast-stack");
  const card = fakeEl("dialog");

  const r1 = withFakeBody([shell, toasts, card], () => holdBackground(card as unknown as HTMLElement));
  assert.equal(toasts.hasAttribute("inert"), false, "toasts stay announceable and clickable");
  assert.equal(shell.hasAttribute("inert"), true);
  r1();
  assert.equal(shell.hasAttribute("inert"), false);
});

test("releasing twice does not un-hold a surface that is still open", () => {
  const shell = fakeEl("app-shell");
  const a = fakeEl("a");
  const b = fakeEl("b");
  const relA = withFakeBody([shell, a, b], () => holdBackground(a as unknown as HTMLElement));
  const relB = withFakeBody([shell, a, b], () => holdBackground(b as unknown as HTMLElement));
  relA();
  relA(); // idempotent — a double release must not decrement twice
  assert.equal(shell.hasAttribute("inert"), true, "b is still holding it");
  relB();
  assert.equal(shell.hasAttribute("inert"), false);
});

/**
 * A layer that DECLINES to close stays in the registry.
 *
 * Not every dispose closes: a dialog with unsaved work vetoes a route change,
 * which is what `hasUnsavedWork` is for. `dismissLayers` cleared the array
 * regardless, so that dialog was on screen and absent from the registry — and
 * every predicate built on the registry then lied about it. `isTop()` false for
 * the layer that IS the top one, so its Escape was dead; `openLayerCount()`
 * zero with it open, so the page's own ← navigated out from under it.
 */
test("a layer that refuses to close is still in the registry afterwards", () => {
  let aOpen = true;
  let bOpen = true;
  const a = registerLayer(() => { aOpen = false; a.release(); }, "surface", () => aOpen);
  const b = registerLayer(() => { /* vetoes */ }, "modal", () => bOpen);

  assert.equal(openLayerCount(), 2);
  assert.equal(b.isTop(), true, "the modal is on top before the sweep");

  dismissLayers();

  assert.equal(aOpen, false, "the layer that could close, did");
  assert.equal(openLayerCount(), 1, "and the one that refused is still counted");
  assert.equal(b.isTop(), true, "so it still owns Escape");

  bOpen = false;
  b.release();
  assert.equal(openLayerCount(), 0);
});

test("survivors keep their original order, ahead of anything opened during the sweep", () => {
  let firstOpen = true;
  let secondOpen = true;
  const first = registerLayer(() => { /* vetoes */ }, "surface", () => firstOpen);
  const second = registerLayer(() => { /* vetoes */ }, "modal", () => secondOpen);

  dismissLayers();

  assert.equal(openLayerCount(), 2, "both refused, both kept");
  assert.equal(second.isTop(), true, "and the NEWER one is still the top layer");
  assert.equal(first.isTop(), false);

  firstOpen = false;
  secondOpen = false;
  first.release();
  second.release();
});
