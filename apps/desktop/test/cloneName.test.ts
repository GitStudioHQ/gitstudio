import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNameFromUrl, validateTargetName } from "../src/shared/cloneName";

// The shared clone-target-name helpers: the derived-from-URL default and the
// live validation both the clone dialog and the destination sheet run.

test("derives the repo name from HTTPS URLs", () => {
  assert.equal(deriveNameFromUrl("https://github.com/acme/widgets.git"), "widgets");
  assert.equal(deriveNameFromUrl("https://github.com/acme/widgets"), "widgets");
  assert.equal(deriveNameFromUrl("https://github.com/acme/widgets/"), "widgets");
});

test("derives the repo name from SSH URLs", () => {
  assert.equal(deriveNameFromUrl("git@github.com:acme/widgets.git"), "widgets");
});

test("empty / unusable URLs derive nothing", () => {
  assert.equal(deriveNameFromUrl(""), undefined);
  assert.equal(deriveNameFromUrl("   "), undefined);
});

test("an empty override is fine — it means 'use the derived name'", () => {
  assert.equal(validateTargetName(""), null);
  assert.equal(validateTargetName("   "), null);
});

test("a normal name passes", () => {
  assert.equal(validateTargetName("my-repo"), null);
  assert.equal(validateTargetName("Repo_2.x"), null);
});

test("dash-leading, separators, and dot names are refused with reasons", () => {
  assert.match(validateTargetName("-rf")!, /dash/);
  assert.match(validateTargetName("a/b")!, /separator/);
  assert.match(validateTargetName("a\\b")!, /separator/);
  assert.match(validateTargetName(".")!, /usable/);
  assert.match(validateTargetName("..")!, /usable/);
});
