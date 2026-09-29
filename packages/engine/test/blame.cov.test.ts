// Incremental blame (src/blame/parse.ts) — stray metadata before any header,
// a mail git didn't wrap, and a `previous` with no path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIncrementalBlame } from "../src/blame/parse";

const SHA = "a".repeat(40);

test("metadata before any header is ignored, not pinned on the next commit", () => {
  const out = parseIncrementalBlame(["author Stray", "summary stray", `${SHA} 1 1 1`, "author Real", "filename f.txt", ""].join("\n"));
  const c = out.commits.get(SHA)!;
  assert.equal(c.author, "Real");
  assert.equal(c.summary, "", "the stray summary went nowhere");
  assert.deepEqual(out.lines, [{ finalLine: 1, origLine: 1, sha: SHA }]);
});

test("a mail without angle brackets is kept as is; a previous without a path is no previous", () => {
  const out = parseIncrementalBlame(
    [`${SHA} 3 5 2`, "author-mail bob@example.com", "committer-mail <c@example.com", "previous deadbeef", "committer-tz +0200", "boundary", "filename a b.txt"].join("\n"),
  );
  const c = out.commits.get(SHA)!;
  assert.equal(c.authorMail, "bob@example.com");
  assert.equal(c.committerMail, "<c@example.com", "only a whole pair of brackets is git's wrapping");
  assert.equal(c.previous, undefined);
  assert.equal(c.isBoundary, true);
  assert.equal(c.filename, "a b.txt");
  assert.deepEqual(out.lines.map((l) => [l.finalLine, l.origLine]), [[5, 3], [6, 4]]);
});
