// The rebase todo (src/rebase/todo.ts) — the corners test/rebaseTodo.test.ts
// leaves: a directive whose argument looks like an object name, entries built
// by hand (no line of their own), the file's line ending, and the summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectEol,
  hasTrailingNewline,
  parseRebaseTodo,
  serializeRebaseTodo,
  summarizeRebaseTodo,
  type RebaseLine,
} from "../src/rebase/todo";

test("a directive whose argument looks like a sha is passed through, not read as a commit", () => {
  const text = "exec deadbeef\nlabel cafe1234\npick 0151064 c3\n";
  const lines = parseRebaseTodo(text);
  assert.deepEqual(lines.map((l) => l.kind), ["passthrough", "passthrough", "commit"]);
  assert.equal(serializeRebaseTodo(lines), text);
});

test("an entry with no line of its own is written as action, sha and subject — or just the two", () => {
  const made: RebaseLine[] = [
    { kind: "commit", action: "squash", sha: "abc1234", subject: "fold me", raw: "" },
    { kind: "commit", action: "fixup", sha: "def5678", subject: "", raw: "not a todo line" },
    // A raw line for another commit: the entry's own sha wins.
    { kind: "commit", action: "pick", sha: "1111111", subject: "mine", raw: "pick 2222222 theirs" },
  ];
  assert.equal(serializeRebaseTodo(made), "squash abc1234 fold me\nfixup def5678\npick 1111111 mine\n");
});

test("serialize: CRLF when asked, no terminator when asked, and nothing at all for no lines", () => {
  const lines = parseRebaseTodo("pick 0151064 a\r\npick 0151065 b\r\n");
  assert.equal(serializeRebaseTodo(lines, { eol: "\r\n" }), "pick 0151064 a\r\npick 0151065 b\r\n");
  assert.equal(serializeRebaseTodo(lines, { trailingNewline: false }), "pick 0151064 a\npick 0151065 b");
  assert.equal(serializeRebaseTodo([]), "", "an empty todo gets no terminator");
  assert.deepEqual(parseRebaseTodo(""), []);
});

test("the file's own line ending and terminator are detected", () => {
  assert.equal(detectEol("pick a\r\npick b\r\n"), "\r\n");
  assert.equal(detectEol("pick a\npick b"), "\n");
  assert.equal(hasTrailingNewline("x\r\n"), true);
  assert.equal(hasTrailingNewline("x\n"), true);
  assert.equal(hasTrailingNewline("x"), false);
});

test("the summary: git's Rebase comment and the number of commit rows", () => {
  const todo = "pick 0151064 a\n#   comment first\n# Rebase 1a2b3c4..5d6e7f8 onto 1a2b3c4 (2 commands)\n# Rebase again\ns 0151065 b\n";
  assert.deepEqual(summarizeRebaseTodo(parseRebaseTodo(todo)), { headerComment: "Rebase 1a2b3c4..5d6e7f8 onto 1a2b3c4 (2 commands)", commitCount: 2 });
  assert.deepEqual(summarizeRebaseTodo(parseRebaseTodo("noop\n")), { headerComment: null, commitCount: 0 });
});
