import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chipRefs,
  chipRefsUnderFilter,
  CURRENT_BRANCH,
  CURRENT_UPSTREAM,
  filterPreset,
  filterWalk,
  headInWalk,
  headIsDetached,
  LOCAL_BRANCHES,
  normalizeRefFilter,
  presetRefs,
  RefListCourier,
  refEntries,
  refLabel,
  refListSignature,
  resolveRefFilter,
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

test("chipRefsUnderFilter keeps only the refs the graph was walked from — the current branch included", () => {
  // An attached HEAD is no longer walked unless it is ticked (a preset or by
  // hand), so it no longer keeps a chip unless it is: a "main" chip over a
  // graph of origin/x said main was in a filter that did not name it.
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
  assert.deepEqual([...out.keys()], ["bbb"], "a row with nothing left has no entry at all — main's included");
  assert.deepEqual(out.get("bbb"), [feat]);
  const withMain = chipRefsUnderFilter(bySha, ["refs/heads/main", "refs/tags/v1"]);
  assert.deepEqual(withMain.get("aaa"), [main], "ticked, it keeps its chip; origin/main beside it does not");
  assert.deepEqual(withMain.get("ccc"), [tag]);
  assert.equal(chipRefsUnderFilter(bySha, []).size, 0, "a walk of HEAD alone (detached) draws no branch chip");
});

// ── Presets that follow HEAD (found on the released 1.13.0) ─────────────────
// "Current branch" was stored as the branch it resolved to at the click. After
// a checkout the trigger still named the old branch, no preset was lit, and
// the graph showed the old branch. It is stored as what it means now.

const PRESET_LIST: GraphRefEntry[] = [
  { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true, upstream: "refs/remotes/origin/main" },
  { fullName: "refs/heads/local-exp", name: "local-exp", kind: "head" },
  { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
  { fullName: "refs/tags/v1", name: "v1", kind: "tag" },
];
const switchedTo = (name: string): GraphRefEntry[] =>
  PRESET_LIST.map((r) => {
    const { isCurrent: _drop, ...rest } = r;
    return r.kind === "head" && r.name === name ? { ...rest, isCurrent: true } : rest;
  });

test("a preset is stored as what it means, and resolves against the refs of each load", () => {
  assert.deepEqual(presetRefs("current"), [CURRENT_BRANCH]);
  assert.deepEqual(presetRefs("currentUpstream"), [CURRENT_BRANCH, CURRENT_UPSTREAM]);
  assert.deepEqual(presetRefs("local"), [LOCAL_BRANCHES]);
  assert.equal(presetRefs("all"), null);
  assert.deepEqual(resolveRefFilter(presetRefs("current"), PRESET_LIST), ["refs/heads/main"]);
  assert.deepEqual(resolveRefFilter(presetRefs("currentUpstream"), PRESET_LIST), ["refs/heads/main", "refs/remotes/origin/main"]);
  assert.deepEqual(resolveRefFilter(presetRefs("local"), PRESET_LIST), ["refs/heads/main", "refs/heads/local-exp"]);
  // …and after `git checkout local-exp`, the SAME stored filter means the new branch.
  const after = switchedTo("local-exp");
  assert.deepEqual(resolveRefFilter(presetRefs("current"), after), ["refs/heads/local-exp"]);
  assert.deepEqual(resolveRefFilter(presetRefs("currentUpstream"), after), ["refs/heads/local-exp"], "no upstream, nothing added");
  // A branch made after "Local only" was picked is in it.
  const grown: GraphRefEntry[] = [...PRESET_LIST, { fullName: "refs/heads/new", name: "new", kind: "head" }];
  assert.ok(resolveRefFilter(presetRefs("local"), grown)!.includes("refs/heads/new"));
  // Detached: no current branch, so "current" resolves to nothing — the walk
  // is HEAD alone (see headIsDetached), not every branch.
  assert.deepEqual(resolveRefFilter(presetRefs("current"), switchedTo("nope")), []);
  assert.equal(resolveRefFilter(null, PRESET_LIST), null);
  // Full names pass through; a mix resolves both; duplicates collapse.
  assert.deepEqual(
    resolveRefFilter([CURRENT_BRANCH, "refs/tags/v1", "refs/heads/main"], PRESET_LIST),
    ["refs/heads/main", "refs/tags/v1"],
  );
});

test("filterPreset names the preset a stored filter is, and nothing for a hand-picked one", () => {
  assert.equal(filterPreset(null), "all");
  assert.equal(filterPreset([CURRENT_BRANCH]), "current");
  assert.equal(filterPreset([CURRENT_UPSTREAM, CURRENT_BRANCH]), "currentUpstream", "order aside");
  assert.equal(filterPreset([LOCAL_BRANCHES]), "local");
  assert.equal(filterPreset(["refs/heads/main"]), undefined, "the branch current WAS is not the current branch");
  assert.equal(filterPreset([CURRENT_BRANCH, "refs/tags/v1"]), undefined);
});

test("normalizeRefFilter keeps the preset entries — they name no ref, and are resolved per load", () => {
  assert.deepEqual(normalizeRefFilter([CURRENT_BRANCH, CURRENT_UPSTREAM], REFS), [CURRENT_BRANCH, CURRENT_UPSTREAM]);
  assert.deepEqual(normalizeRefFilter([LOCAL_BRANCHES, "refs/heads/deleted"], REFS), [LOCAL_BRANCHES]);
  assert.equal(normalizeRefFilter(["@nonsense"], REFS), null, "an unknown symbol is garbage like any other");
});

test("filterWalk: what one load walks — resolved refs, HEAD only when detached, and the preset", () => {
  const attached = filterWalk([CURRENT_BRANCH], PRESET_LIST, REFS);
  assert.deepEqual(attached, { refs: ["refs/heads/main"], head: false, preset: "current" });
  const handPicked = filterWalk(["refs/tags/v1"], PRESET_LIST, REFS);
  assert.deepEqual(handPicked, { refs: ["refs/tags/v1"], head: false }, "no preset key at all for a hand-picked one");
  assert.equal(filterWalk(null, PRESET_LIST, REFS).refs, null, "every branch (HEAD is walked by the unfiltered walk itself)");
  assert.equal("preset" in filterWalk(null, PRESET_LIST, REFS), false, "and All is no preset to light");
  const detachedRefs = REFS.map((r) => ({ ...r, isCurrent: false }));
  assert.deepEqual(filterWalk([CURRENT_BRANCH], switchedTo("nope"), detachedRefs), { refs: [], head: true, preset: "current" });
  // A failed listing resolves no symbol and keeps HEAD walked.
  assert.deepEqual(filterWalk([CURRENT_BRANCH, "refs/heads/x"], [], []), { refs: ["refs/heads/x"], head: true });
});

test("headInWalk: the WIP row hangs only off a HEAD the walk has", () => {
  const none = new Set<string>();
  assert.equal(headInWalk({ refs: null, head: true }, PRESET_LIST, none, "h"), true, "no filter");
  assert.equal(headInWalk({ refs: ["refs/tags/v1"], head: true }, PRESET_LIST, none, "h"), true, "detached: HEAD is walked");
  assert.equal(headInWalk({ refs: ["refs/heads/main"], head: false }, PRESET_LIST, none, "h"), true, "the current branch is ticked");
  assert.equal(headInWalk({ refs: ["refs/tags/v1"], head: false }, PRESET_LIST, new Set(["h"]), "h"), true, "another ref reaches it, on a loaded row");
  assert.equal(headInWalk({ refs: ["refs/tags/v1"], head: false }, PRESET_LIST, none, "h"), false, "nothing walks it");
  assert.equal(headInWalk({ refs: ["refs/tags/v1"], head: false }, PRESET_LIST, new Set([""]), ""), false, "no HEAD sha is no HEAD");
});

test("headIsDetached: no current branch in the listing (or no listing) keeps HEAD in the walk", () => {
  assert.equal(headIsDetached(REFS), false);
  assert.equal(headIsDetached(REFS.map((r) => ({ ...r, isCurrent: false }))), true);
  assert.equal(headIsDetached([]), true, "a failed listing: keeping HEAD is the safe mistake");
});

test("chipRefsUnderFilter with no filter is the same map, untouched", () => {
  const bySha = new Map([["aaa", [ref("tag", "v1")]]]);
  assert.equal(chipRefsUnderFilter(bySha, null), bySha);
});

test("chipRefs resolves a chip by its FULL name, so a branch beside a tag of its name still names its ref", () => {
  // A branch and a tag both called "release": git shortens them to
  // "heads/release" and "tags/release" — but the chip carries its full name
  // (WireRef.fullName), and so do the twins folded into it.
  const list = refEntries([
    ref("head", "heads/release", { fullName: "refs/heads/release" }),
    ref("tag", "tags/release", { fullName: "refs/tags/release" }),
    ref("remote", "origin/release", { fullName: "refs/remotes/origin/release" }),
    ref("head", "main", { isCurrent: true }),
    ref("remote", "origin/main"),
  ]);
  assert.deepEqual(chipRefs(list, "refs/heads/release"), ["refs/heads/release"]);
  assert.deepEqual(chipRefs(list, "refs/tags/release"), ["refs/tags/release"]);
  // The twin of a branch listed as "heads/release" is origin/release — by
  // full name it rides along; by short name it was sought as
  // "origin/heads/release" and never found.
  assert.deepEqual(chipRefs(list, "refs/heads/release", ["refs/remotes/origin/release"]), [
    "refs/heads/release",
    "refs/remotes/origin/release",
  ]);
  assert.deepEqual(chipRefs(list, "refs/heads/main", ["refs/remotes/origin/main"]), ["refs/heads/main", "refs/remotes/origin/main"]);
});

test("chipRefs resolves only what the list has: an unknown chip is nothing, an unknown twin is left out", () => {
  assert.deepEqual(chipRefs([], "refs/heads/release"), []);
  assert.deepEqual(chipRefs([], "refs/heads/feature/y", ["refs/remotes/origin/feature/y"]), [], "twins are not reached for an unknown chip either");
  const list = refEntries([ref("head", "main", { isCurrent: true })]);
  // A short name is not a full name, whatever it looks like.
  assert.deepEqual(chipRefs(list, "main"), [], "the short name resolves to nothing");
  assert.deepEqual(chipRefs(list, ""), []);
  // A twin the list does not have is left out, never guessed; the chip's own
  // ref stays first, because a checkout takes refs[0].
  assert.deepEqual(chipRefs(list, "refs/heads/main", ["refs/remotes/origin/main", "refs/remotes/upstream/main"]), ["refs/heads/main"]);
});

test("refLabel names a ref by its full name shorn — never git's disambiguated short form", () => {
  assert.equal(refLabel("refs/heads/release"), "release");
  assert.equal(refLabel("refs/tags/release"), "release");
  assert.equal(refLabel("refs/remotes/origin/release"), "origin/release");
  assert.equal(refLabel("refs/heads/heads/x"), "heads/x", "a branch really called heads/x keeps its name");
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
