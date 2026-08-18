import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCloneUrl } from "../src/main/cloneUrl";
import { safeArg, containedPath } from "../src/main/gitBridge";

test("validateCloneUrl accepts normal repo URLs", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "http://example.com/x/y",
    "git://example.com/x/y.git",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "github.com:owner/repo.git",
    "file:///home/me/repo",
    "/home/me/repo",
  ]) {
    assert.equal(validateCloneUrl(url), null, `expected ${url} to be accepted`);
  }
});

test("validateCloneUrl rejects the ext:: remote-helper RCE vector", () => {
  assert.ok(validateCloneUrl('ext::sh -c "touch /tmp/pwned"'));
  assert.ok(validateCloneUrl("fd::17/foo"));
  assert.ok(validateCloneUrl("ext::git-upload-pack"));
});

test("validateCloneUrl rejects option-injection (leading dash) URLs", () => {
  assert.ok(validateCloneUrl("--upload-pack=touch /tmp/x"));
  assert.ok(validateCloneUrl("-o foo"));
});

test("validateCloneUrl rejects unsupported schemes and empties", () => {
  assert.ok(validateCloneUrl("javascript://alert(1)"));
  assert.ok(validateCloneUrl("data://x"));
  assert.ok(validateCloneUrl(""));
  assert.ok(validateCloneUrl("   "));
});

test("safeArg rejects values git would parse as an option", () => {
  assert.equal(safeArg("--exec=evil"), false);
  assert.equal(safeArg("-D"), false);
  assert.equal(safeArg(""), false);
  assert.equal(safeArg(undefined), false);
  assert.equal(safeArg(null), false);
});

test("safeArg accepts real refs, branches, and SHAs", () => {
  assert.equal(safeArg("main"), true);
  assert.equal(safeArg("feature/login"), true);
  assert.equal(safeArg("v1.2.3"), true);
  assert.equal(safeArg("a1b2c3d4"), true);
  assert.equal(safeArg("stash@{0}"), true);
});

// `stageLines` writes reconstructed content straight into the index from a
// renderer-supplied path. Every sibling mutating handler (hunksStage, hunksList,
// conflictResolve) proved containment first; this one did not, so a hostile or
// buggy renderer payload could name a path outside the repository.

test("containedPath accepts paths inside the repo", () => {
  const root = "/tmp/repo";
  for (const rel of ["a.txt", "src/b.ts", "./c.md", "deep/nested/d"]) {
    assert.ok(containedPath(root, rel), `expected ${rel} to be accepted`);
  }
});

test("containedPath rejects traversal out of the repo", () => {
  const root = "/tmp/repo";
  for (const rel of ["../outside.txt", "../../.zshenv", "src/../../escape", "/etc/passwd"]) {
    assert.equal(containedPath(root, rel), undefined, `expected ${rel} to be rejected`);
  }
});

test("containedPath does not treat a sibling with a shared prefix as inside", () => {
  // /tmp/repo-evil starts with /tmp/repo as a STRING but is a different
  // directory — the separator check is what makes this a path test, not a
  // prefix test.
  assert.equal(containedPath("/tmp/repo", "../repo-evil/x"), undefined);
});

test("containedPath accepts the root itself", () => {
  assert.ok(containedPath("/tmp/repo", "."));
});
