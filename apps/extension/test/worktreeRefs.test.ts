import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareName,
  shortNameOf,
  startPointOf,
  worktreeRefFor,
} from "../src/views/worktreeRefs";
import type { GitRef } from "@gitstudio/git-service/index";

// `fullName` is typed required but the branch-menu webview omits it (it sends
// name + type only), so the no-fullName paths are real and tested here too.
function ref(
  type: GitRef["type"],
  name: string,
  fullName: string | undefined,
): GitRef {
  return { type, name, fullName: fullName ?? "", sha: "abc1234", isCurrent: false };
}

// ── bareName ────────────────────────────────────────────────────────────────

test("bareName strips one type prefix from a full name", () => {
  assert.equal(bareName(ref("head", "v1.2", "refs/heads/v1.2")), "v1.2");
  assert.equal(
    bareName(ref("remote", "origin/main", "refs/remotes/origin/main")),
    "origin/main",
  );
  assert.equal(bareName(ref("tag", "v1.2", "refs/tags/v1.2")), "v1.2");
});

test("bareName does NOT strip a genuine 'heads/' branch name", () => {
  // A genuine branch named "heads/x" and git's collision-disambiguated
  // "heads/v1.2" are string-identical at the name level — only the fullName
  // tells them apart, and it never false-strips.
  assert.equal(bareName(ref("head", "heads/x", "refs/heads/heads/x")), "heads/x");
  assert.equal(
    bareName(ref("head", "heads/v1.2", "refs/heads/v1.2")),
    "v1.2",
  );
  assert.equal(bareName(ref("tag", "tags/v1.2", "refs/tags/tags/v1.2")), "tags/v1.2");
});

test("bareName guesses nothing from a short name: with no fullName there is no bare name", () => {
  // It used to strip one "heads/" off the short name — which is also how a
  // branch genuinely called heads/v1.2 starts, so the guess was wrong for one
  // of them. The flow resolves the listed ref first (worktreeRefFor).
  assert.equal(bareName(ref("head", "heads/v1.2", undefined)), "");
  assert.equal(bareName(ref("remote", "remotes/origin/x", undefined)), "");
  assert.equal(bareName(ref("tag", "tags/v1.2", undefined)), "");
});

// ── startPointOf ────────────────────────────────────────────────────────────

test("startPointOf returns the full name when present", () => {
  assert.equal(
    startPointOf(ref("remote", "origin/main", "refs/remotes/origin/main")),
    "refs/remotes/origin/main",
  );
});

test("startPointOf never rebuilds a full name from a short one", () => {
  // "refs/heads/" + "heads/v1.2" names a ref that does not exist.
  assert.equal(startPointOf(ref("head", "heads/v1.2", undefined)), undefined);
  assert.equal(startPointOf(ref("remote", "origin/main", undefined)), undefined);
  assert.equal(startPointOf(ref("tag", "v1.2", undefined)), undefined);
});

// ── worktreeRefFor — the flow's one way to a full name ─────────────────────

const LISTED: GitRef[] = [
  ref("head", "heads/v1.2", "refs/heads/v1.2"),
  ref("tag", "tags/v1.2", "refs/tags/v1.2"),
  ref("head", "heads/x", "refs/heads/heads/x"),
];
const listing = (refs: GitRef[] | Error) => ({
  refs: { listRefs: async () => (refs instanceof Error ? Promise.reject(refs) : refs) },
});

test("worktreeRefFor finds the branch menu's name + type in the ref list", async () => {
  const hit = await worktreeRefFor(listing(LISTED), ref("head", "heads/v1.2", undefined));
  assert.equal(hit?.fullName, "refs/heads/v1.2");
  assert.equal(bareName(hit!), "v1.2");
  const tag = await worktreeRefFor(listing(LISTED), ref("tag", "tags/v1.2", undefined));
  assert.equal(startPointOf(tag!), "refs/tags/v1.2", "the TAG, not the branch of the same name");
});

test("worktreeRefFor STOPS when the listing fails or has no such ref — it never falls back to the short name", async () => {
  // The fallback kept the webview's ref and let bareName/startPointOf strip
  // "heads/" and rebuild refs/heads/<rest> — an invented full name.
  assert.equal(await worktreeRefFor(listing(new Error("fatal: bad packed-refs")), ref("head", "heads/v1.2", undefined)), undefined);
  assert.equal(await worktreeRefFor(listing(LISTED), ref("head", "heads/ghost", undefined)), undefined);
  assert.equal(await worktreeRefFor(listing(LISTED), ref("tag", "heads/v1.2", undefined)), undefined, "the right name under the wrong type is no match");
});

test("a node that already carries its full name is not looked up again", async () => {
  let asked = 0;
  const counting = { refs: { listRefs: async () => (asked++, LISTED) } };
  const hit = await worktreeRefFor(counting, ref("head", "heads/x", "refs/heads/heads/x"));
  assert.equal(asked, 0);
  assert.equal(bareName(hit!), "heads/x", "a branch really called heads/x keeps its name");
});

test("startPointOf returns undefined for an unknown type", () => {
  assert.equal(startPointOf(ref("stash", "stash@{0}", undefined)), undefined);
});

// ── shortNameOf ─────────────────────────────────────────────────────────────

test("shortNameOf yields the name git's simple autoSetupMerge compares against", () => {
  assert.equal(shortNameOf("refs/heads/main"), "main");
  // origin/feature → feature: `-b feature … origin/feature` tracks, anything
  // else must not.
  assert.equal(shortNameOf("refs/remotes/origin/feature"), "feature");
  assert.equal(shortNameOf("refs/tags/v1.2"), "v1.2");
});

test("shortNameOf keeps nested remote paths beyond the remote name", () => {
  assert.equal(shortNameOf("refs/remotes/origin/deep/x"), "deep/x");
});

test("shortNameOf returns undefined for an unknown ref", () => {
  assert.equal(shortNameOf("refs/notes/foo"), undefined);
});
