import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chipRefs,
  chipRefsUnderFilter,
  normalizeRefFilter,
  RefListCourier,
  refEntries,
  refListSignature,
  sameRefFilter,
  type PickerRefLike,
} from "../src/graphRefFilter";
import type { GraphRefEntry } from "../src/graphProtocol";

// The branch filter's host-side rules (issue #30), shared by both hosts so the
// extension and the desktop cannot disagree on what a stored selection means.

const ref = (
  type: PickerRefLike["type"],
  name: string,
  over: Partial<PickerRefLike> = {},
): PickerRefLike => ({
  type,
  name,
  fullName:
    type === "head" ? `refs/heads/${name}` : type === "remote" ? `refs/remotes/${name}` : `refs/tags/${name}`,
  isCurrent: false,
  ...over,
});

const REFS: PickerRefLike[] = [
  ref("head", "main", { isCurrent: true, upstream: "origin/main" }),
  ref("head", "feature/x", { upstream: "origin/gone" }),
  ref("remote", "origin/main"),
  ref("remote", "origin", { fullName: "refs/remotes/origin/HEAD", symref: "origin/main" }),
  ref("tag", "v1"),
  { type: "stash", name: "stash@{0}", fullName: "refs/stash", isCurrent: false },
];

test("refEntries lists branches and tags, never the stash or a remote's HEAD pointer", () => {
  const entries = refEntries(REFS);
  assert.deepEqual(
    entries.map((e) => e.fullName),
    ["refs/heads/main", "refs/heads/feature/x", "refs/remotes/origin/main", "refs/tags/v1"],
  );
  assert.deepEqual(entries.map((e) => e.kind), ["head", "head", "remoteHead", "tag"]);
});

test("refEntries marks the current branch and resolves its upstream to a ref that exists", () => {
  const entries = refEntries(REFS);
  const main = entries.find((e) => e.name === "main")!;
  assert.equal(main.isCurrent, true);
  assert.equal(main.upstream, "refs/remotes/origin/main");
  // A `[gone]` upstream names nothing the picker can tick — it is left off,
  // so the preset never stores a ref that does not exist.
  const feat = entries.find((e) => e.name === "feature/x")!;
  assert.equal(feat.upstream, undefined);
  assert.equal(feat.isCurrent, undefined);
});

test("normalizeRefFilter drops refs that no longer exist, silently", () => {
  assert.deepEqual(
    normalizeRefFilter(["refs/heads/main", "refs/heads/deleted", "refs/tags/v1"], REFS),
    ["refs/heads/main", "refs/tags/v1"],
  );
});

test("normalizeRefFilter: an empty (or emptied) selection is All, never a graph of nothing", () => {
  assert.equal(normalizeRefFilter([], REFS), null);
  assert.equal(normalizeRefFilter(["refs/heads/deleted"], REFS), null);
  assert.equal(normalizeRefFilter(null, REFS), null);
  assert.equal(normalizeRefFilter(undefined, REFS), null);
});

test("normalizeRefFilter survives garbage storage and duplicates", () => {
  assert.deepEqual(
    normalizeRefFilter(["refs/heads/main", 7, null, "refs/heads/main", { x: 1 }], REFS),
    ["refs/heads/main"],
  );
  assert.equal(normalizeRefFilter("refs/heads/main", REFS), null);
});

test("chipRefsUnderFilter keeps only ticked refs — and the current branch, always", () => {
  const main = ref("head", "main", { isCurrent: true });
  const feat = ref("head", "feature/x");
  const remote = ref("remote", "origin/main");
  const tag = ref("tag", "v1");
  const bySha = new Map([
    ["aaa", [main, remote]],
    ["bbb", [feat]],
    ["ccc", [tag]],
  ]);
  const out = chipRefsUnderFilter(bySha, ["refs/heads/feature/x"]);
  assert.deepEqual([...out.keys()], ["aaa", "bbb"], "a row with nothing left has no entry at all");
  assert.deepEqual(out.get("aaa"), [main], "the current branch keeps its chip; origin/main does not");
  assert.deepEqual(out.get("bbb"), [feat]);
});

test("chipRefsUnderFilter with no filter is the same map, untouched", () => {
  const bySha = new Map([["aaa", [ref("tag", "v1")]]]);
  assert.equal(chipRefsUnderFilter(bySha, null), bySha);
});

test("chipRefs resolves a chip through the list by name and kind, so an ambiguous short name still names its ref", () => {
  // A branch and a tag both called "release": git shortens them to
  // "heads/release" and "tags/release", and that is the name on the chip.
  const list = refEntries([
    ref("head", "heads/release", { fullName: "refs/heads/release" }),
    ref("tag", "tags/release", { fullName: "refs/tags/release" }),
    ref("head", "main", { isCurrent: true }),
    ref("remote", "origin/main"),
  ]);
  assert.deepEqual(chipRefs(list, "heads/release", "head"), ["refs/heads/release"]);
  assert.deepEqual(chipRefs(list, "tags/release", "tag"), ["refs/tags/release"]);
  // Kind matters: the same name can be listed under two kinds.
  const both = refEntries([ref("head", "x"), ref("tag", "x")]);
  assert.deepEqual(chipRefs(both, "x", "tag"), ["refs/tags/x"]);
  assert.deepEqual(chipRefs(both, "x", "currentHead"), ["refs/heads/x"]);
  // The folded remote twins ride along, resolved the same way.
  assert.deepEqual(chipRefs(list, "main", "currentHead", ["origin"]), ["refs/heads/main", "refs/remotes/origin/main"]);
});

test("chipRefs never REBUILDS a full name from a chip: a chip the list does not have resolves to nothing", () => {
  // "heads/release" rebuilt is refs/heads/heads/release — a ref that does not
  // exist, which the host prunes, and the "only this" shortcut then showed
  // every branch. Nothing guessed is better than that.
  assert.deepEqual(chipRefs([], "heads/release", "head"), []);
  assert.deepEqual(chipRefs([], "feature/y", "head", ["origin"]), [], "twins are not reached for an unknown chip either");
  const list = refEntries([ref("head", "main", { isCurrent: true })]);
  assert.deepEqual(chipRefs(list, "main", "tag"), [], "the right name under the wrong kind is not a match");
  // A twin the list does not have is left out, never guessed; the chip's own
  // ref stays first, because a checkout takes refs[0].
  assert.deepEqual(chipRefs(list, "main", "currentHead", ["origin", "upstream"]), ["refs/heads/main"]);
});

test("sameRefFilter ignores order and tells null from a list", () => {
  assert.equal(sameRefFilter(["a", "b"], ["b", "a"]), true);
  assert.equal(sameRefFilter(["a"], ["a", "b"]), false);
  assert.equal(sameRefFilter(null, null), true);
  assert.equal(sameRefFilter(null, ["a"]), false);
});

// ── The ref list is sent only when it changed (issue #30) ───────────────────

const LIST = refEntries(REFS);

test("refListSignature is stable for the same list and moves with every field the picker reads", () => {
  const sig = refListSignature(LIST);
  assert.equal(refListSignature(refEntries(REFS)), sig, "a fresh listing of the same refs signs the same");
  assert.equal(refListSignature(LIST.map((e) => ({ ...e }))), sig, "copies sign the same");
  const moved = (mutate: (l: GraphRefEntry[]) => void): string => {
    const copy = LIST.map((e) => ({ ...e }));
    mutate(copy);
    return refListSignature(copy);
  };
  assert.notEqual(moved((l) => l.push({ fullName: "refs/heads/new", name: "new", kind: "head" })), sig, "a new branch");
  assert.notEqual(moved((l) => l.pop()), sig, "a deleted tag");
  assert.notEqual(moved((l) => (l[1].fullName = "refs/heads/feature/y")), sig, "a renamed ref");
  assert.notEqual(moved((l) => (l[1].name = "heads/feature/x")), sig, "a short name that changed (a tag now shares it)");
  assert.notEqual(moved((l) => (l[3].kind = "head")), sig, "a kind");
  assert.notEqual(
    moved((l) => {
      delete l[0].isCurrent;
      l[1].isCurrent = true;
    }),
    sig,
    "HEAD moved to another branch",
  );
  assert.notEqual(moved((l) => (l[0].upstream = undefined)), sig, "an upstream that went away");
  assert.notEqual(moved((l) => l.reverse()), sig, "the order");
  // Field boundaries are part of it: "ab"+"c" is not "a"+"bc".
  assert.notEqual(
    refListSignature([{ fullName: "refs/heads/ab", name: "c", kind: "head" }]),
    refListSignature([{ fullName: "refs/heads/a", name: "bc", kind: "head" }]),
  );
  assert.equal(refListSignature([]), refListSignature([]));
  assert.notEqual(refListSignature([]), sig);
});

test("refListSignature is small whatever the list's size — it crosses IPC on every desktop page request", () => {
  const big: GraphRefEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
    fullName: `refs/tags/release-candidate-${i}`,
    name: `release-candidate-${i}`,
    kind: "tag" as const,
  }));
  assert.ok(refListSignature(big).length < 32);
  assert.ok(JSON.stringify(big).length > 500_000, "…while the list it stands for is most of a megabyte");
});

test("RefListCourier sends the list once, then only when it changes — and again after forget()", () => {
  const courier = new RefListCourier();
  const first = LIST.map((e) => ({ ...e }));
  assert.equal(courier.take(first), first, "a webview that has nothing gets the list");
  assert.equal(courier.take(LIST.map((e) => ({ ...e }))), undefined, "an identical list (a refresh) is left out");
  assert.equal(courier.take(LIST.map((e) => ({ ...e }))), undefined, "…every time");
  const grown: GraphRefEntry[] = [...LIST, { fullName: "refs/heads/new", name: "new", kind: "head" }];
  assert.equal(courier.take(grown), grown, "a changed list is sent");
  assert.equal(courier.take(grown), undefined);
  courier.forget();
  assert.equal(courier.take(grown), grown, "a reloaded webview holds nothing, so it gets the list again");
  // An empty list is a list: going from refs to none must reach the webview.
  assert.deepEqual(courier.take([]), []);
  assert.equal(courier.take([]), undefined);
});
