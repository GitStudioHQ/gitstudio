import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIncrementalBlame,
  UNCOMMITTED_SHA,
} from "../src/blame/parse";

// ---------------------------------------------------------------------------
// A *captured real* `git blame --incremental` sample (exact bytes), generated
// from a throwaway two-commit repo:
//
//   c1 (Alice, 2021-01-01): "line one / line two / line three"
//   c2 (Bob,   2022-06-15): edits line two, appends two lines
//
// SHAs are deterministic given the pinned author/committer dates. This sample
// exercises every quirk the parser must handle:
//   - Bob's commit appears in TWO groups; the second (lines 4-5) is metadata-
//     less (just header + previous + filename) — metadata must be reused.
//   - The second Bob group is a MULTI-LINE group (num-lines = 2).
//   - Alice's commit carries a `boundary` marker.
//   - Both commits carry `previous` (Bob) / boundary (Alice).
//   - Groups are emitted out of final-line order (line 2, then 4-5, then 1, 3).
// ---------------------------------------------------------------------------
const BOB = "d65de20a009aaa007beb385f3666e5fcee11369d";
const ALICE = "51d36d0d844a7b96ed8fb461073e867d38b61b58";

const REAL_INCREMENTAL = `${BOB} 2 2 1
author Bob
author-mail <bob@example.com>
author-time 1655296200
author-tz +0000
committer Bob
committer-mail <bob@example.com>
committer-time 1655296200
committer-tz +0000
summary edit line two and append lines
previous 51d36d0d844a7b96ed8fb461073e867d38b61b58 f.txt
filename f.txt
${BOB} 4 4 2
previous 51d36d0d844a7b96ed8fb461073e867d38b61b58 f.txt
filename f.txt
${ALICE} 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1609459200
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1609459200
committer-tz +0000
summary initial three lines
boundary
filename f.txt
${ALICE} 3 3 1
filename f.txt
`;

test("real sample: every line maps to the right commit", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);

  // 5 source lines, one entry each, sorted by final line.
  assert.equal(result.lines.length, 5);
  assert.deepEqual(
    result.lines.map((l) => l.finalLine),
    [1, 2, 3, 4, 5],
  );

  const shaByLine = new Map(result.lines.map((l) => [l.finalLine, l.sha]));
  assert.equal(shaByLine.get(1), ALICE, "line 1 is Alice's original");
  assert.equal(shaByLine.get(2), BOB, "line 2 was edited by Bob");
  assert.equal(shaByLine.get(3), ALICE, "line 3 is Alice's original");
  assert.equal(shaByLine.get(4), BOB, "line 4 appended by Bob");
  assert.equal(shaByLine.get(5), BOB, "line 5 appended by Bob");
});

test("real sample: orig-line is carried through multi-line expansion", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);
  const byFinal = new Map(result.lines.map((l) => [l.finalLine, l]));

  // The 4-4-2 group expands to final 4→orig 4 and final 5→orig 5.
  assert.equal(byFinal.get(4)!.origLine, 4);
  assert.equal(byFinal.get(5)!.origLine, 5);
  // Edited line 2 keeps orig === final here.
  assert.equal(byFinal.get(2)!.origLine, 2);
});

test("real sample: commit metadata is filled even for metadata-less groups", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);

  // Bob's commit metadata came ONLY from his first group, yet lines 4-5 (his
  // second, metadata-less group) resolve to the same fully-populated commit.
  const bob = result.commits.get(BOB);
  assert.ok(bob, "Bob's commit is present");
  assert.equal(bob.author, "Bob");
  assert.equal(bob.authorMail, "bob@example.com", "angle brackets stripped");
  assert.equal(bob.authorTime, 1655296200);
  assert.equal(bob.authorTz, "+0000");
  assert.equal(bob.committer, "Bob");
  assert.equal(bob.committerMail, "bob@example.com");
  assert.equal(bob.summary, "edit line two and append lines");
  assert.equal(bob.isBoundary, false);

  // Lines 4 and 5 (the lean group) point at this same populated commit.
  for (const line of result.lines.filter((l) => l.finalLine >= 4)) {
    assert.equal(result.commits.get(line.sha)!.author, "Bob");
  }
});

test("real sample: previous is parsed", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);
  const bob = result.commits.get(BOB)!;
  assert.deepEqual(bob.previous, {
    sha: "51d36d0d844a7b96ed8fb461073e867d38b61b58",
    filename: "f.txt",
  });
});

test("real sample: boundary commit is flagged", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);
  const alice = result.commits.get(ALICE)!;
  assert.equal(alice.isBoundary, true);
  assert.equal(alice.author, "Alice");
  assert.equal(alice.authorMail, "alice@example.com");
  assert.equal(alice.summary, "initial three lines");
  // Boundary commits carry no `previous`.
  assert.equal(alice.previous, undefined);
});

test("real sample: exactly two distinct commits", () => {
  const result = parseIncrementalBlame(REAL_INCREMENTAL);
  assert.equal(result.commits.size, 2);
  assert.ok(result.commits.has(BOB));
  assert.ok(result.commits.has(ALICE));
});

test("robust to \\r\\n line endings and a missing trailing newline", () => {
  const crlf = REAL_INCREMENTAL.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
  const result = parseIncrementalBlame(crlf);
  assert.equal(result.lines.length, 5);
  assert.equal(result.commits.size, 2);
  assert.equal(result.commits.get(BOB)!.author, "Bob");
});

// ---------------------------------------------------------------------------
// A tiny hand-written synthetic fixture for clarity: one commit, a single
// 3-line group, demonstrating the bare-minimum shape.
// ---------------------------------------------------------------------------
test("synthetic: a single 3-line group expands correctly", () => {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const synthetic = [
    `${sha} 10 1 3`,
    "author Carol",
    "author-mail <carol@example.com>",
    "author-time 1700000000",
    "author-tz +0200",
    "committer Carol",
    "committer-mail <carol@example.com>",
    "committer-time 1700000000",
    "committer-tz +0200",
    "summary a synthetic change",
    "filename hello.ts",
    "",
  ].join("\n");

  const result = parseIncrementalBlame(synthetic);
  assert.equal(result.lines.length, 3);
  // final 1,2,3 map to orig 10,11,12 (origLine offset preserved).
  assert.deepEqual(result.lines, [
    { finalLine: 1, origLine: 10, sha },
    { finalLine: 2, origLine: 11, sha },
    { finalLine: 3, origLine: 12, sha },
  ]);

  const carol = result.commits.get(sha)!;
  assert.equal(carol.author, "Carol");
  assert.equal(carol.authorTz, "+0200");
  assert.equal(carol.isBoundary, false);
  assert.equal(carol.previous, undefined);
});

test("synthetic: the uncommitted zero-sha is preserved verbatim", () => {
  const dirty = [
    `${UNCOMMITTED_SHA} 1 1 1`,
    "author Not Committed Yet",
    "author-mail <not.committed.yet>",
    "author-time 1700000000",
    "author-tz +0000",
    "committer Not Committed Yet",
    "committer-mail <not.committed.yet>",
    "committer-time 1700000000",
    "committer-tz +0000",
    "summary Version of hello.ts from hello.ts",
    "filename hello.ts",
  ].join("\n");

  const result = parseIncrementalBlame(dirty);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].sha, UNCOMMITTED_SHA);
  assert.equal(result.commits.get(UNCOMMITTED_SHA)!.author, "Not Committed Yet");
});
