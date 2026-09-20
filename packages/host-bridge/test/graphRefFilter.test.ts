import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chipRefsUnderFilter,
  fullRefName,
  normalizeRefFilter,
  refEntries,
  sameRefFilter,
  type PickerRefLike,
} from "../src/graphRefFilter";

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

test("fullRefName is the inverse of a chip's short name, by kind", () => {
  assert.equal(fullRefName("main", "head"), "refs/heads/main");
  assert.equal(fullRefName("main", "currentHead"), "refs/heads/main");
  assert.equal(fullRefName("origin/main", "remoteHead"), "refs/remotes/origin/main");
  assert.equal(fullRefName("v1", "tag"), "refs/tags/v1");
});

test("sameRefFilter ignores order and tells null from a list", () => {
  assert.equal(sameRefFilter(["a", "b"], ["b", "a"]), true);
  assert.equal(sameRefFilter(["a"], ["a", "b"]), false);
  assert.equal(sameRefFilter(null, null), true);
  assert.equal(sameRefFilter(null, ["a"]), false);
});
