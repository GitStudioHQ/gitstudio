import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphRefEntry } from "@gitstudio/host-bridge/graphProtocol";
import {
  REF_PRESETS,
  activePreset,
  addRefs,
  chipCheckout,
  groupRefs,
  presetFilter,
  presetUnavailable,
  refFilterLabel,
  removeRefs,
  toggleRef,
} from "../src/graph/refFilter";

// One picker model for both commit lists (issue #30): what a preset ticks,
// what the trigger says, what a tick does.

const REFS: GraphRefEntry[] = [
  { fullName: "refs/heads/feature/x", name: "feature/x", kind: "head" },
  { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true, upstream: "refs/remotes/origin/main" },
  { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
  { fullName: "refs/remotes/origin/feature/x", name: "origin/feature/x", kind: "remoteHead" },
  { fullName: "refs/tags/v1", name: "v1", kind: "tag" },
];

test("the presets are the four the reporter asked for, in that order", () => {
  assert.deepEqual(
    REF_PRESETS.map((p) => p.label),
    ["Current branch", "Current + upstream", "Local only", "All"],
  );
});

test("presets tick fully-qualified refs; All is null", () => {
  assert.deepEqual(presetFilter("current", REFS), ["refs/heads/main"]);
  assert.deepEqual(presetFilter("currentUpstream", REFS), ["refs/heads/main", "refs/remotes/origin/main"]);
  assert.deepEqual(presetFilter("local", REFS), ["refs/heads/feature/x", "refs/heads/main"]);
  assert.equal(presetFilter("all", REFS), null);
});

test("a preset the repository has nothing for is unavailable, and says why", () => {
  const detached = REFS.map((r) => ({ ...r, isCurrent: undefined }));
  assert.equal(presetFilter("current", detached), undefined);
  assert.match(presetUnavailable("current", detached), /detached/);
  const noUpstream = REFS.map((r) => ({ ...r, upstream: undefined }));
  assert.equal(presetFilter("currentUpstream", noUpstream), undefined);
  assert.equal(presetUnavailable("currentUpstream", noUpstream), "main has no upstream");
  assert.equal(presetFilter("local", REFS.filter((r) => r.kind !== "head")), undefined);
  assert.equal(presetUnavailable("current", REFS), "", "an available preset has no excuse");
});

test("activePreset recognises a selection whatever its order, and only exact ones", () => {
  assert.equal(activePreset(null, REFS), "all");
  assert.equal(activePreset(["refs/remotes/origin/main", "refs/heads/main"], REFS), "currentUpstream");
  assert.equal(activePreset(["refs/heads/main"], REFS), "current");
  assert.equal(activePreset(["refs/heads/main", "refs/tags/v1"], REFS), undefined);
});

test("the trigger label: All, one or two names, then a count", () => {
  assert.equal(refFilterLabel(null, REFS), "All branches");
  assert.equal(refFilterLabel(["refs/heads/main"], REFS), "main");
  assert.equal(refFilterLabel(["refs/heads/main", "refs/heads/feature/x"], REFS), "main, feature/x");
  assert.equal(
    refFilterLabel(["refs/heads/main", "refs/heads/feature/x", "refs/remotes/origin/main"], REFS),
    "3 branches",
  );
  // A tag is not a branch; the label must not say it is.
  assert.equal(
    refFilterLabel(["refs/heads/main", "refs/heads/feature/x", "refs/tags/v1"], REFS),
    "3 refs",
  );
  // A remembered ref the list no longer carries still reads as a name.
  assert.equal(refFilterLabel(["refs/heads/gone"], REFS), "gone");
});

test("ticking from All narrows to that ref alone; the last untick is All again", () => {
  const one = toggleRef(null, "refs/heads/main");
  assert.deepEqual(one, ["refs/heads/main"]);
  const two = toggleRef(one, "refs/tags/v1");
  assert.deepEqual(two, ["refs/heads/main", "refs/tags/v1"]);
  assert.deepEqual(toggleRef(two, "refs/heads/main"), ["refs/tags/v1"]);
  assert.equal(toggleRef(["refs/tags/v1"], "refs/tags/v1"), null, "a filter of nothing never exists");
});

test("addRefs and removeRefs move a chip and its folded remotes together", () => {
  const both = ["refs/heads/main", "refs/remotes/origin/main"];
  assert.deepEqual(addRefs(null, both), both);
  assert.deepEqual(addRefs(["refs/tags/v1", "refs/heads/main"], both), ["refs/tags/v1", "refs/heads/main", "refs/remotes/origin/main"]);
  assert.deepEqual(removeRefs([...both, "refs/tags/v1"], both), ["refs/tags/v1"]);
  assert.equal(removeRefs(both, both), null);
  assert.equal(removeRefs(null, both), null);
});

test("groupRefs: Local / Remote / Tags, the current branch pinned first, empty groups dropped", () => {
  const groups = groupRefs(REFS, "");
  assert.deepEqual(groups.map((g) => g.label), ["Local", "Remote", "Tags"]);
  assert.deepEqual(groups[0].refs.map((r) => r.name), ["main", "feature/x"]);
  assert.deepEqual(groups[1].refs.map((r) => r.name), ["origin/main", "origin/feature/x"]);
  assert.deepEqual(groups[2].refs.map((r) => r.name), ["v1"]);
  const narrowed = groupRefs(REFS, "FEAT");
  assert.deepEqual(narrowed.map((g) => g.label), ["Local", "Remote"]);
  assert.deepEqual(narrowed[0].refs.map((r) => r.name), ["feature/x"]);
  assert.deepEqual(groupRefs(REFS, "nothing"), []);
});

test("groupRefs caps a group and says how many it left out", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ fullName: `refs/tags/t${i}`, name: `t${i}`, kind: "tag" as const }));
  const [tags] = groupRefs(many, "", 5);
  assert.equal(tags.refs.length, 5);
  assert.equal(tags.hidden, 2);
});

test("chipCheckout: what a chip's menu offers to check out, and what it declines", () => {
  // Right-clicking a chip used to open the row's commit menu, whose first
  // items check out the refs on that row. The chip's filter menu took that
  // click, so it offers the checkout too — under the same rules.
  assert.deepEqual(chipCheckout({ name: "feature/x", kind: "head", sha: "abc" }), { label: "Checkout feature/x", icon: "git-branch" });
  assert.deepEqual(chipCheckout({ name: "origin/feature/x", kind: "remoteHead", sha: "abc" }), { label: "Checkout origin/feature/x", icon: "cloud" });
  // A tag asks first (it detaches), so its label says so.
  assert.deepEqual(chipCheckout({ name: "v1", kind: "tag", sha: "abc" }), { label: "Checkout v1…", icon: "tag" });
  // Nothing to switch to: the branch you are on, and a remote's HEAD pointer.
  assert.equal(chipCheckout({ name: "main", kind: "currentHead", sha: "abc" }), undefined);
  assert.equal(chipCheckout({ name: "origin/HEAD", kind: "remoteHead", sha: "abc" }), undefined);
  // …and a chip whose row is unknown has nothing to run the checkout on.
  assert.equal(chipCheckout({ name: "feature/x", kind: "head", sha: "" }), undefined);
});
