import { test } from "node:test";
import assert from "node:assert/strict";
import { HAS_ISSUE_REF, parseIssueRef, splitIssueRefs } from "../src/shared/issueRefs";

// What a reference in prose is allowed to be. The linkifier turns each match
// into a door, so a false positive is a link to nothing and a miss is a
// cross-project reference that reads as grey text while the bare number beside
// it is clickable.

const refs = (s: string): string[] =>
  splitIssueRefs(s)
    .filter((p) => p.ref)
    .map((p) => p.text);

test("a bare number is a reference to this repository", () => {
  assert.deepEqual(parseIssueRef("#12"), { number: 12 });
  assert.deepEqual(refs("fixed by #12"), ["#12"]);
});

test("a qualified number names its repository", () => {
  assert.deepEqual(parseIssueRef("libgit2/libgit2#106"), {
    repo: "libgit2/libgit2",
    number: 106,
  });
  assert.deepEqual(refs("see libgit2/libgit2#106 for the same thing"), [
    "libgit2/libgit2#106",
  ]);
});

test("a repository name may carry dots, dashes and underscores", () => {
  assert.deepEqual(parseIssueRef("Some-Org/my_repo.js#7"), {
    repo: "Some-Org/my_repo.js",
    number: 7,
  });
});

test("a reference at the very start of the text still counts", () => {
  assert.deepEqual(refs("#31 is the one"), ["#31"]);
  assert.deepEqual(refs("acme/widgets#31 is the one"), ["acme/widgets#31"]);
});

test("a hash glued to a word is not a reference", () => {
  // `abc#12` is an anchor, a CSS id, part of a URL — never an issue.
  assert.deepEqual(refs("see anchor#12 there"), []);
  assert.equal(parseIssueRef("anchor#12"), undefined);
});

test("a URL fragment is not a reference", () => {
  assert.deepEqual(refs("https://example.com/page#12"), []);
});

test("a hex colour with a letter in it is not a reference", () => {
  // `#08a` has no word boundary after the digits, so it cannot be mistaken for
  // one. `#333` genuinely is ambiguous — GitHub reads it as issue 333 too, and
  // preferring the colour would break every real three-digit reference — so it
  // stays a reference, deliberately.
  assert.deepEqual(refs("the tint is #08a"), []);
  assert.deepEqual(refs("the tint is #1a2b3c"), []);
  assert.deepEqual(refs("the tint is #333"), ["#333"]);
});

test("zero is not an issue number", () => {
  assert.equal(parseIssueRef("#0"), undefined);
});

test("the plain text between references is preserved exactly", () => {
  assert.deepEqual(splitIssueRefs("closes #4 and acme/w#5."), [
    { text: "closes " },
    { text: "#4", ref: { number: 4 } },
    { text: " and " },
    { text: "acme/w#5", ref: { repo: "acme/w", number: 5 } },
    { text: "." },
  ]);
});

test("text with no reference splits to itself", () => {
  assert.deepEqual(splitIssueRefs("nothing to see"), [{ text: "nothing to see" }]);
});

test("the cheap pre-test agrees with the split", () => {
  for (const s of [
    "fixed by #12",
    "see libgit2/libgit2#106",
    "#31 is the one",
    "the tint is #333",
    "nothing to see",
    "anchor#12",
  ]) {
    assert.equal(
      HAS_ISSUE_REF.test(s),
      refs(s).length > 0 || /(^|\s)(?:[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)?#\d/.test(s),
      `pre-test must never reject text the split would match: ${s}`,
    );
  }
  // The one direction that matters: never reject what the split accepts.
  for (const s of ["fixed by #12", "see libgit2/libgit2#106", "#31 is the one"]) {
    assert.ok(HAS_ISSUE_REF.test(s), s);
  }
});
