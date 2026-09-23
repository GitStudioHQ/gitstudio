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
import { refCheckoutRequest } from "../src/renderer/refMenuItems";
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
    // …and they build it with the one builder, which is where the ref
    // checkout's action, kind and full name are decided.
    assert.ok(
      /host\.invoke\("commit:action", refCheckoutRequest\(fullName\)\)/.test(text),
      `${f} no longer sends its ref checkout through refCheckoutRequest — did the call site move?`,
    );
    assert.equal(/action:\s*"checkout-ref"/.test(text), false, `${f} builds a checkout-ref by hand again`);
  }
});

test("refCheckoutRequest takes the kind from the namespace, and always carries the full name", () => {
  // The kind is what makes a remote a real local tracking branch, and the
  // full name is what keeps "heads/release" a branch: both come from the one
  // string every door has, so no door can drop either.
  assert.deepEqual(refCheckoutRequest("refs/heads/heads/release"), {
    action: "checkout-ref",
    sha: "refs/heads/heads/release",
    name: "heads/release",
    refKind: "head",
    fullName: "refs/heads/heads/release",
  });
  assert.equal(refCheckoutRequest("refs/remotes/origin/fix/login").refKind, "remote");
  assert.equal(refCheckoutRequest("refs/remotes/origin/fix/login").name, "origin/fix/login");
  assert.equal(refCheckoutRequest("refs/tags/v1.2.0").refKind, "tag");
  assert.equal(refCheckoutRequest("refs/heads/release").name, "release", "the words, for the toast: never fed back to git");
});

test("every checkout door in the renderer hands checkoutRef a FULL name", () => {
  // The Branches list's row button and ⋯ menu, its remote rows, the branch
  // switcher's locals and remotes, and the peek host: all sent
  // `%(refname:short)`, which is "heads/release" beside a tag of that name —
  // and `git checkout heads/release` detaches. The main process refuses a
  // checkout-ref without a full name now; this is the census that no door
  // reaches for the short one.
  const text = src("renderer/renderer.ts");
  const calls = [...text.matchAll(/this\.checkoutRef\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 6, `the doors are all found (${calls.length}): ${calls.join(" | ")}`);
  for (const args of calls) {
    assert.match(args, /^(\w+\.fullName|fullName)\b/, `checkoutRef(${args}) must be given a full name`);
  }
  assert.match(text, /private async checkoutRef\(fullName: string, btn\?: HTMLElement\)/);
  // The ref page checks out the ref it looked up by name AND kind.
  const detail = src("renderer/views/refDetail.ts");
  const doors = [...detail.matchAll(/void checkout\(([^,]+),/g)].map((m) => m[1]);
  assert.ok(doors.length === 2, `the ref page's two doors are found (${doors.join(" | ")})`);
  for (const d of doors) assert.equal(d, "ref.fullName", `the ref page checks out ${d}`);
});

test("the chip menu's checkout goes through the context menu's door, and is refused where its rows are", () => {
  // Right-clicking a chip used to open this menu (issue #30 gave the chip a
  // menu of its own), so the chip's "Checkout <ref>" builds the same row and
  // sends the same request — ref and kind included.
  let got: CommitActionRequest | undefined;
  const menu = new CommitContextMenu((req) => {
    got = req;
  });
  menu.checkoutRef("abc1234", { name: "feature/login", kind: "head" });
  assert.deepEqual(got, { action: "checkout-ref", sha: "abc1234", name: "feature/login", refKind: "head" });
  menu.checkoutRef("abc1234", { name: "origin/fix/login", kind: "remote" });
  assert.equal(got?.refKind, "remote");
  // What the builder declines, this declines: the branch you are on, and a
  // remote's HEAD pointer.
  got = undefined;
  menu.checkoutRef("abc1234", { name: "main", kind: "head", current: true });
  menu.checkoutRef("abc1234", { name: "origin/HEAD", kind: "remote" });
  assert.equal(got, undefined);
});

test("the chip menu's checkout carries the ref's FULL name when the chip resolved one", () => {
  // The graph's chips and its ref list carry full names; the request must
  // too, because `name` is "heads/release" beside a tag of that name and the
  // main process would otherwise run the detaching `git checkout heads/release`.
  let got: CommitActionRequest | undefined;
  const menu = new CommitContextMenu((req) => {
    got = req;
  });
  menu.checkoutRef("abc1234", { name: "heads/release", kind: "head", fullName: "refs/heads/release" });
  assert.deepEqual(got, {
    action: "checkout-ref",
    sha: "abc1234",
    name: "heads/release",
    refKind: "head",
    fullName: "refs/heads/release",
  });
  // …and the rows the commit menu builds from the renderer's refs carry it
  // the same way, through the same dispatch.
  const req = menuRequestFor({ name: "tags/release", kind: "tag", fullName: "refs/tags/release" } as never);
  assert.equal(req.fullName, "refs/tags/release");
  // A row without one sends none — not an undefined-valued key.
  menu.checkoutRef("abc1234", { name: "feature/login", kind: "head" });
  assert.equal(got && "fullName" in got, false);
});

test("a remote branch row asks for the remote treatment", () => {
  // By the REMOTE ref's full name, whether or not you already have the local
  // branch: planRemoteCheckout switches to yours when it exists and creates
  // it tracking the remote when not. It used to pass the local's SHORT name
  // for "yours", which beside a tag of that name detached.
  const text = src("renderer/renderer.ts");
  assert.match(text, /primary\.addEventListener\("click", \(\) => void this\.checkoutRef\(r\.fullName, primary\)\);/);
  assert.equal(refCheckoutRequest("refs/remotes/origin/x").refKind, "remote");
  // And the branch switcher's remote section, which promises "as a local
  // branch" in its own tooltip — and names the ref by its full name shorn,
  // never git's "remotes/origin/x" beside a local branch called "origin/x".
  assert.match(
    text,
    /title: `Check out \$\{refDisplay\(b\.fullName\)\} as a local branch`,\s*onClick: \(\) => void this\.checkoutRef\(b\.fullName\),/,
  );
});
