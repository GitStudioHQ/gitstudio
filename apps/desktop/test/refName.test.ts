import { test } from "node:test";
import assert from "node:assert/strict";
import { refNameProblem, sanitizeRefName } from "../src/shared/refName";

// The validator and the sanitiser behind the branch prompts. Ported from the
// extension, so these cases are also the contract that keeps the two products
// refusing — and repairing — the same names the same way.

test("refNameProblem names what git would refuse", () => {
  assert.equal(refNameProblem(""), "Required.");
  assert.equal(refNameProblem("   "), "Required.");
  assert.equal(refNameProblem("my branch"), "Cannot contain spaces.");
  for (const bad of ["-x", ".x", "a..b", "a~b", "a^b", "a:b", "a?", "a*", "a[", "a.", "a/", "a@{b", "@"]) {
    assert.equal(refNameProblem(bad), "Not a valid git ref name.", `refuses ${bad}`);
  }
  assert.equal(refNameProblem("feature/x"), null);
  assert.equal(refNameProblem("fix/log-stream"), null);
});

test("a pasted ticket title becomes a name git accepts", () => {
  const out = sanitizeRefName("SPS-1234 ALA baLa 12/02/21 something");
  assert.equal(out, "SPS-1234-ALA-baLa-12-02-21-something");
  assert.equal(refNameProblem(out), null, "and the repaired name actually passes");
});

test("the hierarchy slash survives, but a date does not become one", () => {
  assert.equal(sanitizeRefName("feature/x"), "feature/x");
  assert.equal(sanitizeRefName("10/11/2345"), "10-11-2345");
});

test("per-component rubbish is stripped", () => {
  assert.equal(sanitizeRefName("..x"), "x");
  assert.equal(sanitizeRefName("feat/x.lock"), "feat/x");
  assert.equal(sanitizeRefName("--a--b--"), "a-b");
  assert.equal(sanitizeRefName("a//b"), "a/b");
  assert.equal(sanitizeRefName("@"), "");
  assert.equal(sanitizeRefName("   "), "");
});

test("case is preserved, and sanitising is idempotent", () => {
  assert.equal(sanitizeRefName("Feature/MyThing"), "Feature/MyThing");
  for (const s of [
    "SPS-1234 ALA baLa 12/02/21 something",
    "..x",
    "feat/x.lock",
    "--a--b--",
    "a~b^c:d",
    "10/11/2345",
    "feature/x",
  ]) {
    assert.equal(sanitizeRefName(sanitizeRefName(s)), sanitizeRefName(s), `idempotent for ${s}`);
  }
});

test("everything the sanitiser produces is a name git accepts", () => {
  for (const s of ["SPS-1 a b", "..x..", "a//b//c", "feat/x.lock", "12/02/21", "a~b^c:d?e*f[g"]) {
    const out = sanitizeRefName(s);
    if (out) assert.equal(refNameProblem(out), null, `sanitised "${s}" gave "${out}"`);
  }
});
