import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRebaseTodo,
  serializeRebaseTodo,
  detectEol,
  hasTrailingNewline,
  summarizeRebaseTodo,
  type RebaseCommitEntry,
} from "../src/rebase/todo";

// A realistic `git rebase -i HEAD~3` todo: three picks + the standard comment
// block git appends. Indentation/spacing is exactly git's.
const REAL_TODO = `pick a1b2c3d Add the parser
pick b2c3d4e Wire up the editor
pick c3d4e5f Fix the round-trip bug

# Rebase 9f8e7d6..c3d4e5f onto 9f8e7d6 (3 commands)
#
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup [-C | -c] <commit> = like "squash" but keep only the previous
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
#
# If you remove a line here THAT COMMIT WILL BE LOST.
`;

// A rebase-merges / exec style todo: directives we don't model must passthrough.
const MERGES_TODO = `label onto

reset onto
pick a1b2c3d First on a branch
exec make test
break
merge -C d4e5f6a topic # Merge topic
update-ref refs/heads/feature
`;

test("real rebase -i todo round-trips byte-for-byte", () => {
  const lines = parseRebaseTodo(REAL_TODO);
  // 3 commits + 1 blank + the comment block.
  const commits = lines.filter((l) => l.kind === "commit");
  assert.equal(commits.length, 3);
  assert.equal((commits[0] as RebaseCommitEntry).action, "pick");
  assert.equal((commits[0] as RebaseCommitEntry).sha, "a1b2c3d");
  assert.equal((commits[0] as RebaseCommitEntry).subject, "Add the parser");
  assert.equal(serializeRebaseTodo(lines), REAL_TODO);
});

test("rebase-merges / exec / break / label / reset / merge / update-ref round-trip byte-for-byte", () => {
  const lines = parseRebaseTodo(MERGES_TODO);
  // Only the single `pick` is a commit; everything else is passthrough.
  const commits = lines.filter((l) => l.kind === "commit");
  assert.equal(commits.length, 1);
  assert.equal((commits[0] as RebaseCommitEntry).sha, "a1b2c3d");
  // exec/break/label/reset/merge/update-ref stay passthrough (not commits).
  const passthrough = lines.filter((l) => l.kind === "passthrough");
  assert.ok(passthrough.some((l) => l.raw.startsWith("exec ")));
  assert.ok(passthrough.some((l) => l.raw === "break"));
  assert.ok(passthrough.some((l) => l.raw.startsWith("label ")));
  assert.ok(passthrough.some((l) => l.raw.startsWith("reset ")));
  assert.ok(passthrough.some((l) => l.raw.startsWith("merge ")));
  assert.ok(passthrough.some((l) => l.raw.startsWith("update-ref ")));
  assert.equal(serializeRebaseTodo(lines), MERGES_TODO);
});

test("retype to squash, reorder, and drop serialize correctly with comments intact", () => {
  const lines = parseRebaseTodo(REAL_TODO);
  const commits = lines.filter(
    (l) => l.kind === "commit",
  ) as RebaseCommitEntry[];

  // Retype the 2nd entry to squash.
  commits[1].action = "squash";
  // Drop the 3rd entry.
  commits[2].action = "drop";

  // Reorder: swap entry 0 and entry 1 within the line array. Rebuild the line
  // list preserving passthroughs in place but in the new commit order — easier:
  // operate on a reordered copy where commit slots are filled in a new order.
  const reordered = reorderCommits(lines, [1, 0, 2]);
  const out = serializeRebaseTodo(reordered);

  const expected = `squash b2c3d4e Wire up the editor
pick a1b2c3d Add the parser
drop c3d4e5f Fix the round-trip bug

# Rebase 9f8e7d6..c3d4e5f onto 9f8e7d6 (3 commands)
#
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup [-C | -c] <commit> = like "squash" but keep only the previous
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
#
# If you remove a line here THAT COMMIT WILL BE LOST.
`;
  assert.equal(out, expected);
  // The comment block survived unchanged.
  assert.ok(out.includes("# Rebase 9f8e7d6..c3d4e5f onto 9f8e7d6 (3 commands)"));
});

test("an unchanged-but-reordered commit re-emits its original raw verbatim", () => {
  // Short-form verb with unusual spacing — must survive a reorder untouched.
  const todo = "p   a1b2c3d   subject with   spaces\npick b2c3d4e second\n";
  const lines = parseRebaseTodo(todo);
  const reordered = reorderCommits(lines, [1, 0]);
  const out = serializeRebaseTodo(reordered);
  assert.equal(out, "pick b2c3d4e second\np   a1b2c3d   subject with   spaces\n");
});

test("short-form verbs parse to their actions", () => {
  const todo = "p aaaa one\nr bbbb two\ne cccc three\ns dddd four\nf eeee five\nd ffff six\n";
  const lines = parseRebaseTodo(todo) as RebaseCommitEntry[];
  assert.equal(lines[0].action, "pick");
  assert.equal(lines[1].action, "reword");
  assert.equal(lines[2].action, "edit");
  assert.equal(lines[3].action, "squash");
  assert.equal(lines[4].action, "fixup");
  assert.equal(lines[5].action, "drop");
  // Short forms round-trip verbatim when not retyped.
  assert.equal(serializeRebaseTodo(lines), todo);
});

test("retyping a short-form entry regenerates with the long action verb", () => {
  const lines = parseRebaseTodo("p aaaa one\n") as RebaseCommitEntry[];
  lines[0].action = "reword";
  assert.equal(serializeRebaseTodo(lines), "reword aaaa one\n");
});

test("CRLF line endings are detected and preserved", () => {
  const crlf = "pick a1b2c3d one\r\npick b2c3d4e two\r\n";
  assert.equal(detectEol(crlf), "\r\n");
  assert.ok(hasTrailingNewline(crlf));
  const lines = parseRebaseTodo(crlf);
  // Commit raws have no embedded \r, and serialize re-adds CRLF.
  assert.equal(serializeRebaseTodo(lines, { eol: "\r\n" }), crlf);
});

test("a file with no trailing newline round-trips without one", () => {
  const noNl = "pick a1b2c3d one\npick b2c3d4e two";
  assert.ok(!hasTrailingNewline(noNl));
  const lines = parseRebaseTodo(noNl);
  assert.equal(
    serializeRebaseTodo(lines, { trailingNewline: false }),
    noNl,
  );
});

test("noop and unmodeled tokens stay passthrough", () => {
  const lines = parseRebaseTodo("noop\nupdate-ref refs/heads/x\n");
  assert.ok(lines.every((l) => l.kind === "passthrough"));
});

test("summarize extracts the Rebase header and commit count", () => {
  const summary = summarizeRebaseTodo(parseRebaseTodo(REAL_TODO));
  assert.equal(summary.commitCount, 3);
  assert.ok(summary.headerComment?.startsWith("Rebase 9f8e7d6..c3d4e5f"));
});

test("empty input round-trips to empty", () => {
  assert.deepEqual(parseRebaseTodo(""), []);
  assert.equal(serializeRebaseTodo([]), "");
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Reorder the commit entries among `lines` according to `order` (a permutation
 * of the commit indices), leaving passthrough lines pinned to their positions.
 * Commit slots (the line positions that held commits) are refilled in the new
 * order; this mirrors how the UI sends back a reordered commit list.
 */
function reorderCommits(
  lines: ReturnType<typeof parseRebaseTodo>,
  order: number[],
): ReturnType<typeof parseRebaseTodo> {
  const commitSlots: number[] = [];
  const commits: RebaseCommitEntry[] = [];
  lines.forEach((line, i) => {
    if (line.kind === "commit") {
      commitSlots.push(i);
      commits.push(line);
    }
  });
  const result = lines.slice();
  order.forEach((srcIdx, slot) => {
    result[commitSlots[slot]] = commits[srcIdx];
  });
  return result;
}
