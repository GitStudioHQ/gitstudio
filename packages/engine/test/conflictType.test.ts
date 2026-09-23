import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictTypeFor } from "../src/conflict/conflictType";

// One conflict-type mapping for every host (the verifier found the desktop and
// the extensions naming the same file three ways). scripts/merge-e2e's
// editorHosts.test.ts holds both hosts to it over the whole matrix.

test("each shape is named in role terms, in git status's words", () => {
  assert.equal(conflictTypeFor({ shape: "text", hasBase: true }), "content");
  assert.equal(conflictTypeFor({ shape: "text", hasBase: false }), "add-add");
  assert.equal(conflictTypeFor({ shape: "added-both", hasBase: false }), "add-add");
  assert.equal(conflictTypeFor({ shape: "modify-delete", missingRole: "yours", hasBase: true }), "deleted-by-us");
  assert.equal(conflictTypeFor({ shape: "modify-delete", missingRole: "theirs", hasBase: true }), "deleted-by-them");
  assert.equal(conflictTypeFor({ shape: "added-one-side", missingRole: "yours", hasBase: false }), "added-by-them");
  assert.equal(conflictTypeFor({ shape: "added-one-side", missingRole: "theirs", hasBase: false }), "added-by-us");
  assert.equal(conflictTypeFor({ shape: "both-deleted", hasBase: true }), "deleted-by-both");
  assert.equal(conflictTypeFor({ shape: "submodule", hasBase: true }), "content");
  assert.equal(conflictTypeFor({ shape: "binary", hasBase: true }), "content");
});

test("no readable versions leaves a shape git's stages decided as it is; only a plain text file is unknown", () => {
  // The extensions read no text for a double delete or a gitlink (source
  // "none"); the desktop says "git-stages" for the same file.
  assert.equal(conflictTypeFor({ shape: "both-deleted", hasBase: true, source: "none" }), "deleted-by-both");
  assert.equal(conflictTypeFor({ shape: "submodule", hasBase: true, source: "none" }), "content");
  assert.equal(conflictTypeFor({ shape: "text", hasBase: false, source: "none" }), "unknown");
  assert.equal(conflictTypeFor({ hasBase: false, source: "none" }), "unknown");
});
