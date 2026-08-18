import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareName,
  shortNameOf,
  startPointOf,
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

test("bareName falls back to stripping the short-name prefix when fullName is absent", () => {
  assert.equal(bareName(ref("head", "heads/v1.2", undefined)), "v1.2");
  assert.equal(bareName(ref("head", "v1.2", undefined)), "v1.2");
  assert.equal(bareName(ref("remote", "remotes/origin/x", undefined)), "origin/x");
  assert.equal(bareName(ref("remote", "origin/x", undefined)), "origin/x");
  assert.equal(bareName(ref("tag", "tags/v1.2", undefined)), "v1.2");
});

// ── startPointOf ────────────────────────────────────────────────────────────

test("startPointOf returns the full name when present", () => {
  assert.equal(
    startPointOf(ref("remote", "origin/main", "refs/remotes/origin/main")),
    "refs/remotes/origin/main",
  );
});

test("startPointOf reconstructs the full name when absent", () => {
  assert.equal(startPointOf(ref("head", "main", undefined)), "refs/heads/main");
  assert.equal(
    startPointOf(ref("remote", "origin/main", undefined)),
    "refs/remotes/origin/main",
  );
  assert.equal(startPointOf(ref("tag", "v1.2", undefined)), "refs/tags/v1.2");
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
