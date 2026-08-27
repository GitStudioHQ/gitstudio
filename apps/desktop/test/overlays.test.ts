import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissLayers, openLayerCount, registerLayer } from "../src/renderer/overlays";

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
