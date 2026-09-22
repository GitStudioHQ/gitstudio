import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The blame hover's command links, and the one encoding rule they live by.
//
// A `command:` URI in a trusted MarkdownString carries its arguments as a
// url-encoded JSON payload, and VS Code treats the two shapes differently: an
// ARRAY is spread into the command's arguments, anything else is passed as a
// single argument. So `JSON.stringify(sha)` reaches a handler as the string,
// and `JSON.stringify([sha])` reaches it as the string too — but only the
// second form works once a second link is added, because a handler written as
// `(sha?: string)` receives the ARRAY itself under the first form and silently
// does nothing (#28 added "Show in Graph" beside "Copy SHA" and moved both to
// the array form for exactly this reason).
//
// Two ways this breaks without a word of warning, which is what the assertions
// below are for: the payload reverts to the bare value, or a link names a
// command that is not in `isTrusted.enabledCommands` — an unlisted command in a
// trusted hover renders as a link and does nothing when clicked.

const SRC = readFileSync(
  fileURLToPath(new URL("../src/blame/blameController.ts", import.meta.url)),
  "utf8",
);

/** The commands the hover links to, as written in the source. */
const linked = [...SRC.matchAll(/\]\(command:([\w.]+)\?\$\{(\w+)\}\)/g)].map((m) => ({
  command: m[1],
  arg: m[2],
}));

test("the hover links the two commit commands, and both carry the same payload", () => {
  assert.deepEqual(
    linked.map((l) => l.command).sort(),
    ["gitstudio.copyCommitSha", "gitstudio.revealCommitInGraph"],
    "the blame hover offers Copy SHA and Show in Graph",
  );
  assert.equal(
    new Set(linked.map((l) => l.arg)).size,
    1,
    "both links use one payload variable, so one encoding rule covers both",
  );
});

test("the payload is an ARRAY, so it spreads into the command's arguments", () => {
  const m = /const \w+ = encodeURIComponent\(JSON\.stringify\((.+?)\)\);/.exec(SRC);
  assert.ok(m, "the hover builds its command payload with encodeURIComponent(JSON.stringify(...))");
  assert.match(
    m![1],
    /^\[.*\]$/,
    `the payload must be an array literal — got ${m![1]}. A bare value reaches ` +
      "revealCommitInGraph as the argument itself, and a handler typed (sha?: string) drops it.",
  );

  // The round trip a click actually performs.
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const args = JSON.parse(decodeURIComponent(encodeURIComponent(JSON.stringify([sha]))));
  assert.ok(Array.isArray(args) && args.length === 1, "one argument is spread");
  assert.equal(typeof args[0], "string", "and it arrives as a string");
  assert.equal(args[0], sha);
});

test("every command the hover links is allowed to run from it", () => {
  const m = /isTrusted = \{\s*enabledCommands: \[([^\]]*)\]/.exec(SRC);
  assert.ok(m, "the hover sets isTrusted.enabledCommands");
  const allowed = [...m![1].matchAll(/"([\w.]+)"/g)].map((x) => x[1]);
  for (const { command } of linked) {
    assert.ok(
      allowed.includes(command),
      `${command} is linked from the hover but not in enabledCommands — the link would render and do nothing`,
    );
  }
});
