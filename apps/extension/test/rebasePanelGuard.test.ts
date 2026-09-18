import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #27: "Unable to fixup/squash last commit (HEAD) to previous …
// It says 'The top commit has nothing above it to fold into.' which does not
// make sense."
//
// The rebase list displays newest-first (issue #18's flip); git's todo runs
// oldest-first. The panel's setAction guard still checked the FIRST display
// row — which is HEAD — so the one rebase everybody does ("fold my latest
// commit into the previous one") was refused, while a squash on the OLDEST
// commit, which git cannot execute, sailed through to the confirm.
//
// The panel is a webview script inside a template literal, invisible to tsc —
// so this test EXECUTES the real functions: it extracts setAction and
// foldTargetSubject from the shipped source and drives them with a stubbed
// DOM surface. A textual assertion would pass on a broken build; this cannot.

const src = readFileSync(join(__dirname, "../src/rebase/rebaseWorkspacePanel.ts"), "utf8");

function extract(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists in the panel source`);
  // Walk braces to the function's end — the script nests them but never
  // unbalanced inside these two functions.
  let depth = 0;
  let i = src.indexOf("{", start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1) + "\n" + void bodyStart;
}

interface Row {
  action: string;
  subject: string;
}

/** Run the real setAction against a rows array; report what it did. */
function drive(rows: Row[], i: number, action: string): { banner: string | null; rows: Row[] } {
  let banner: string | null = null;
  const fn = new Function(
    "rows",
    "flashBanner",
    "renderList",
    `${extract("foldTargetSubject")}\n${extract("setAction")}\nreturn setAction;`,
  )(
    rows,
    (msg: string) => (banner = msg),
    () => {},
  ) as (i: number, action: string) => void;
  fn(i, action);
  return { banner, rows };
}

const two = (): Row[] => [
  { action: "pick", subject: "Fix mod permissions" }, // HEAD — display top
  { action: "pick", subject: "Add mod loader" }, // the previous commit
];

test("fixup on HEAD (the top display row) is ALLOWED — the reported bug", () => {
  const { banner, rows } = drive(two(), 0, "fixup");
  assert.equal(banner, null, "no refusal banner");
  assert.equal(rows[0].action, "fixup", "the action was applied");
});

test("squash on HEAD is allowed too", () => {
  const { banner, rows } = drive(two(), 0, "squash");
  assert.equal(banner, null);
  assert.equal(rows[1].action, "pick", "and it folds toward the row below");
});

test("squash on the OLDEST commit is refused — git cannot execute it", () => {
  const { banner, rows } = drive(two(), 1, "squash");
  assert.match(banner ?? "", /oldest commit has nothing below/i);
  assert.equal(rows[1].action, "pick", "the action was not applied");
});

test("the guard sees through drop/fold chains below", () => {
  const rows: Row[] = [
    { action: "pick", subject: "newest" },
    { action: "drop", subject: "dropped" },
    { action: "pick", subject: "oldest" },
  ];
  // Folding the newest is fine — the target is "oldest", past the drop.
  assert.equal(drive(rows, 0, "fixup").banner, null);
  // Folding the oldest is not — there is nothing below it at all.
  assert.match(drive(rows, 2, "fixup").banner ?? "", /oldest/i);
});

test("the webview script still parses as one template literal", () => {
  // The whole panel script ships inside String.raw\` … \`; one stray backtick
  // in a comment ends the literal early and tsc reports gibberish far away —
  // it happened while fixing this very bug. The literal must contain exactly
  // zero interior backticks between its delimiters.
  const open = src.indexOf("const REBASE_JS = String.raw`");
  assert.ok(open > 0, "the script literal exists");
  const bodyStart = src.indexOf("`", open) + 1;
  const close = src.indexOf("`", bodyStart);
  assert.ok(close > bodyStart, "the literal closes");
  const after = src.slice(close, close + 3);
  assert.equal(after.startsWith("`;"), true, "and it closes at the intended end, not inside a comment");
});
