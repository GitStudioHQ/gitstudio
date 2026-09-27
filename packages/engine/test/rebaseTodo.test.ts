import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRebaseTodo,
  serializeRebaseTodo,
  detectEol,
  hasTrailingNewline,
  summarizeRebaseTodo,
  todoSubjectFormat,
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

// ── git 2.55 writes the subject as a comment ─────────────────────────────────
//
// Both texts below are what git itself wrote into `git-rebase-todo` for the
// same four commits — the last one's subject is "# hashtag subject" and it is
// empty — before and after git 2.55 (captured from 2.49 and 2.55).

const TODO_UP_TO_2_54 = `pick 0151064 c3
pick 6cd3cec c4
fixup 7c6867f fixup! c4 # empty
pick aec1a3d # hashtag subject # empty

# Rebase 4c44dbc..aec1a3d onto 4c44dbc (4 commands)
`;

const TODO_FROM_2_55 = `pick 0151064 # c3
pick 6cd3cec # c4
fixup 7c6867f # fixup! c4 # empty
pick aec1a3d # # hashtag subject # empty

# Rebase 4c44dbc..aec1a3d onto 4c44dbc (4 commands)
`;

function subjects(text: string): string[] {
  return parseRebaseTodo(text)
    .filter((l): l is RebaseCommitEntry => l.kind === "commit")
    .map((l) => l.subject);
}

test("git 2.55's `pick <sha> # <subject>`: the subject has no '# ' in front of it", () => {
  assert.deepEqual(subjects(TODO_FROM_2_55), ["c3", "c4", "fixup! c4 # empty", "# hashtag subject # empty"]);
});

test("git up to 2.54's `pick <sha> <subject>` reads the same subjects — a subject starting '# ' as git wrote it", () => {
  // A line alone cannot say whether its "# " is 2.55's separator or the start
  // of an older git's subject; the file can, and this one is an older git's.
  assert.deepEqual(subjects(TODO_UP_TO_2_54), ["c3", "c4", "fixup! c4 # empty", "# hashtag subject # empty"]);
});

test("an empty subject: '# ' and a trimmed '#' are 2.55's separator, not a subject", () => {
  assert.deepEqual(subjects("pick c76f531 # \npick c76f532 #\n"), ["", ""]);
  // An older git writes no separator, and so nothing, for an empty subject.
  assert.deepEqual(subjects("pick c76f533\npick c76f534 c4\n"), ["", "c4"]);
  // '#' glued to a word is a subject, in either spelling.
  assert.deepEqual(subjects("pick c76f531 #hashtag\n"), ["#hashtag"]);
  assert.deepEqual(subjects("pick c76f531 # #hashtag\n"), ["#hashtag"]);
});

// The same seven commits, in the todo each git wrote for them (captured from
// git 2.49 and 2.55 with --keep-empty; the \x20 is git's trailing space, kept
// from any editor that trims it): "   spaced" (kept verbatim), an empty
// message, an EMPTY commit with an empty message, an empty commit whose
// subject is "#", a subject "#", "#tag" and "# a # b". Every subject that
// starts with '#' is the case a per-line rule gets wrong for one of the two.
const EDGES_UP_TO_2_54 = `pick 6915e63 spaced
pick a29081d
pick 2255d00 # empty
pick aa56608 # # empty
pick dfe0e27 #
pick b65720d #tag
pick 59c642d # a # b

# Rebase 18cd4b4..59c642d onto 18cd4b4 (7 commands)
`;

const EDGES_FROM_2_55 = `pick 6915e63 #    spaced
pick a29081d #\x20
pick 2255d00 #  # empty
pick aa56608 # # # empty
pick dfe0e27 # #
pick b65720d # #tag
pick 59c642d # # a # b

# Rebase 18cd4b4..59c642d onto 18cd4b4 (7 commands)
`;

test("subjects that start with '#', and the empty commit with no message, read alike from either git", () => {
  const expected = ["spaced", "", "# empty", "# # empty", "#", "#tag", "# a # b"];
  assert.deepEqual(subjects(EDGES_UP_TO_2_54), expected, "an older git's: exactly as it wrote them");
  assert.deepEqual(subjects(EDGES_FROM_2_55), expected, "2.55's: without only the separator");
  // And the round trip stays byte-for-byte in both.
  assert.equal(serializeRebaseTodo(parseRebaseTodo(EDGES_UP_TO_2_54)), EDGES_UP_TO_2_54);
  assert.equal(serializeRebaseTodo(parseRebaseTodo(EDGES_FROM_2_55)), EDGES_FROM_2_55);
});

test("an older git's empty commit with no message keeps its '# empty' beside ordinary subjects", () => {
  assert.deepEqual(subjects("pick 0151064 c3\npick 2255d00 # empty\n"), ["c3", "# empty"]);
  assert.deepEqual(subjects("pick 0151064 # c3\npick 2255d00 #  # empty\n"), ["c3", "# empty"]);
});

test("the format is the file's, read from all of its commit lines", () => {
  assert.equal(todoSubjectFormat([" # c3", " # # hashtag", " #"]), "comment");
  assert.equal(todoSubjectFormat([" # hashtag", " c3"]), "plain", "one line without the separator: an older git");
  assert.equal(todoSubjectFormat([]), "plain", "no commit lines (a noop todo)");
  assert.equal(todoSubjectFormat([" #hashtag"]), "plain", "'#' glued to a word is no separator");
});

test("a SHA-256 repository's 64-digit object names are read whole", () => {
  const sha = "f3a1".repeat(16);
  const lines = parseRebaseTodo(`pick ${sha} # c3\nreword ${sha.slice(0, 12)} # c4\n`);
  const commits = lines.filter((l): l is RebaseCommitEntry => l.kind === "commit");
  assert.deepEqual(
    commits.map((c) => [c.sha, c.subject]),
    [
      [sha, "c3"],
      [sha.slice(0, 12), "c4"],
    ],
  );
  commits[0].action = "drop";
  assert.equal(serializeRebaseTodo(lines).split("\n")[0], `drop ${sha} # c3`);
});

test("git 2.55's todo round-trips byte-for-byte, and a retyped line keeps git's '# ' separator", () => {
  const lines = parseRebaseTodo(TODO_FROM_2_55);
  assert.equal(serializeRebaseTodo(lines), TODO_FROM_2_55);
  const commits = lines.filter((l): l is RebaseCommitEntry => l.kind === "commit");
  commits[1].action = "squash";
  commits[3].action = "drop";
  const out = serializeRebaseTodo(lines).split("\n");
  assert.equal(out[1], "squash 6cd3cec # c4");
  assert.equal(out[3], "drop aec1a3d # # hashtag subject # empty");
});

test("an older git's retyped line is written as it always was", () => {
  const lines = parseRebaseTodo(TODO_UP_TO_2_54);
  const commits = lines.filter((l): l is RebaseCommitEntry => l.kind === "commit");
  commits[1].action = "squash";
  assert.equal(serializeRebaseTodo(lines).split("\n")[1], "squash 6cd3cec c4");
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
