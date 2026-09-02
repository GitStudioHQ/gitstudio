// What a human reads before approving an agent's write.
//
// This is the last gate before an automated actor does something to the
// repository, and for the three destructive tools it used to read WEAKER than
// the app's own confirm dialogs for the very same operations: "Reset (hard) to
// abc123." asked you to approve, in git's vocabulary, the destruction of every
// uncommitted change you had — while discarding one file by hand spelled out
// that it could not be undone.
//
// These assertions are about CONSEQUENCE, not wording: each destructive case
// must say what is lost and that it cannot be recovered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeArgs } from "../src/main/aiBridge";

/** Only the fields `summarizeArgs` reads. */
const tool = (name: string, title = name): Parameters<typeof summarizeArgs>[0] =>
  ({ name, title, mode: "destructive" }) as unknown as Parameters<typeof summarizeArgs>[0];

test("a hard reset says the working tree is destroyed", () => {
  const s = summarizeArgs(tool("git_reset"), { mode: "hard", ref: "HEAD~3" });
  assert.match(s, /HEAD~3/, "it names the target");
  assert.match(s, /uncommitted/i, "and what is at stake");
  assert.match(s, /destroyed|lost/i, "in plain words");
  assert.match(s, /can'?t be undone|cannot be undone/i, "and that it is final");
});

test("the softer resets do NOT claim work is destroyed", () => {
  // Over-warning is its own failure: a dialog that cries wolf on a soft reset
  // is one people learn to click through on a hard one.
  for (const mode of ["soft", "mixed"]) {
    const s = summarizeArgs(tool("git_reset"), { mode, ref: "HEAD~1" });
    assert.ok(!/destroyed/i.test(s), `${mode} does not say destroyed`);
    assert.match(s, /undone/i, `${mode} says what actually happens`);
  }
});

test("a discard says the files may be deleted outright", () => {
  const s = summarizeArgs(tool("git_discard"), { paths: ["a.ts", "b.ts"] });
  assert.match(s, /a\.ts/, "it names the files");
  assert.match(s, /can'?t be undone/i, "says it is final");
  assert.match(s, /deleted|delete/i, "and warns that untracked files go from disk");
});

test("a forced branch delete says what a force costs", () => {
  const plain = summarizeArgs(tool("git_delete_branch"), { name: "feature/x" });
  const forced = summarizeArgs(tool("git_delete_branch"), { name: "feature/x", force: true });
  assert.match(plain, /feature\/x/);
  assert.ok(!/merged/i.test(plain), "an ordinary delete does not warn about unmerged work");
  assert.match(forced, /not merged|unmerged/i, "a forced one does");
});

test("the non-destructive tools stay short", () => {
  // These are approved many times in a session; padding them with consequences
  // they do not have is how the destructive ones stop being read.
  const s = summarizeArgs(tool("git_stage"), { paths: ["a.ts"] });
  assert.match(s, /a\.ts/);
  assert.ok(s.length < 80, `stage stays a single line (${s.length} chars)`);
  assert.ok(!/undone|destroy|lost/i.test(s), "and makes no dire claims");
});

test("an unknown tool still says something a human can read", () => {
  const s = summarizeArgs(tool("git_future_thing", "Do a future thing"), { a: 1 });
  assert.match(s, /Do a future thing/, "it leads with the tool's title");
  assert.ok(s.length > 0);
});
