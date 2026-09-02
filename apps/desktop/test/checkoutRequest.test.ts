// What a "check out this branch" click actually sends.
//
// The app has one action that DETACHES (`checkout`, of a commit) and one that
// ATTACHES (`checkout-ref`, of a branch, with the kind deciding how). Issues
// #12/#19 were about offering the first where the second was meant. The item
// builders were fixed and tested — `refMenuItems.test.ts` — but the request
// each click builds was not, and two of the three builders were wrong:
//
//   - the graph's context menu stored the ref on the menu item and never read
//     it back, so `name` arrived undefined and the main process refused every
//     branch checkout as an unsafe ref;
//   - the Branches list and the ref page sent `action: "checkout"` with a ref
//     NAME in `sha`, so `git checkout origin/foo` detached HEAD onto the
//     remote-tracking ref — no branch, no upstream, the next commit landing
//     where nothing points at it — under a toast reading "Checked out foo."
//
// tsc could not catch either: `sha` is a string, and both call sites cast the
// payload (`as never` / `as Parameters<…>`) to satisfy the union.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CommitContextMenu } from "../src/renderer/contextMenu";
import type { CommitActionRequest } from "../src/shared/ipc";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(join(here, "..", "src", p), "utf8");

// ── the graph's context menu ────────────────────────────────────────────────
// It is a DOM class, but `dispatch` is reachable through a click on the row it
// renders, and jsdom is not needed for what this asserts: the request shape.

function menuRequestFor(ref: { name: string; kind: "head" | "remote" | "tag" }): CommitActionRequest {
  let got: CommitActionRequest | undefined;
  const menu = new CommitContextMenu((req) => {
    got = req;
  });
  // `dispatch` is private to the class, not to the module; reaching it directly
  // keeps this test free of a DOM. The alternative — rendering the menu and
  // clicking — tests jsdom, not the payload.
  const dispatch = (menu as unknown as {
    dispatch(item: unknown, sha: string): Promise<void>;
  }).dispatch.bind(menu);
  void dispatch({ label: `Checkout ${ref.name}`, action: "checkout-ref", ref, refItem: true }, "abc1234");
  assert.ok(got, "the menu resolved nothing at all");
  return got;
}

test("the graph's branch checkout carries the ref, not just the commit", () => {
  const req = menuRequestFor({ name: "feature/login", kind: "head" });
  assert.equal(req.action, "checkout-ref");
  // The main process reads `name`, and refuses the request outright without it.
  assert.equal(req.name, "feature/login");
  assert.equal(req.refKind, "head");
});

test("the graph's remote checkout says it is remote", () => {
  // This is the whole point of the kind: `planRemoteCheckout` creates a local
  // tracking branch, and only runs when the request admits the ref is remote.
  const req = menuRequestFor({ name: "origin/fix/login", kind: "remote" });
  assert.equal(req.refKind, "remote");
  assert.equal(req.name, "origin/fix/login");
});

test("the graph's tag checkout still detaches, deliberately", () => {
  const req = menuRequestFor({ name: "v1.2.0", kind: "tag" });
  assert.equal(req.refKind, "tag");
});

test("a commit action with no ref is unchanged", () => {
  // The other nine items on that menu are about the COMMIT, and adding a name
  // to them would make `branch`/`tag` prompt for one and then ignore it.
  let got: CommitActionRequest | undefined;
  const menu = new CommitContextMenu((req) => {
    got = req;
  });
  const dispatch = (menu as unknown as {
    dispatch(item: unknown, sha: string): Promise<void>;
  }).dispatch.bind(menu);
  void dispatch({ label: "Revert", action: "revert" }, "abc1234");
  assert.equal(got?.action, "revert");
  assert.equal(got?.name, undefined);
  assert.equal(got?.refKind, undefined);
});

// ── the two renderer call sites ─────────────────────────────────────────────
// `App.checkoutRef` and the ref page's `checkout` build their requests inline,
// inside classes that import the whole renderer and cannot be loaded here. What
// can be asserted is the thing that was actually wrong: neither may reach for
// the detaching action, and both must pass the kind through.

test("no checkout in the renderer uses the detaching action on a ref name", () => {
  for (const f of ["renderer/renderer.ts", "renderer/views/refDetail.ts"]) {
    const text = src(f);
    // `action: "checkout"` — the detaching one — must not appear at all in
    // these two files; every checkout they offer is of a named ref.
    assert.equal(
      /action:\s*"checkout"/.test(text),
      false,
      `${f} still sends the detaching checkout action for a named ref`,
    );
    assert.ok(
      /action:\s*"checkout-ref"/.test(text),
      `${f} no longer sends a ref checkout at all — did the call site move?`,
    );
  }
});

test("the ref checkouts pass a kind through", () => {
  for (const f of ["renderer/renderer.ts", "renderer/views/refDetail.ts"]) {
    assert.ok(
      /refKind/.test(src(f)),
      `${f} sends checkout-ref without a kind, so every remote branch detaches`,
    );
  }
});

test("a remote branch row asks for the remote treatment", () => {
  // The Branches list decides the kind from whether you already have the local
  // branch: yours attaches by name, theirs has to be created.
  const text = src("renderer/renderer.ts");
  assert.match(
    text,
    /checkoutRef\(mine \? short : r\.name, primary, mine \? "head" : "remote"\)/,
    "the remote row no longer distinguishes a local branch from a remote one",
  );
  // And the branch switcher's remote section, which promises "as a local
  // branch" in its own tooltip.
  assert.match(text, /checkoutRef\(b\.name, undefined, "remote"\)/);
});
