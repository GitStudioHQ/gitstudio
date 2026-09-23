import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every extension door that applies commits goes through the one door that
// knows what a refusal over uncommitted work is.
//
// Crash report #18: the graph's Revert, over an edit to a file the revert
// touches, showed git's "Your local changes to the following files would be
// overwritten by merge … fatal: revert failed" in red and FILED it as a crash.
// The same refusal waits behind the graph's Cherry-Pick and Checkout, the
// Branches view's Checkout, Merge, Rebase, Create and Switch and tag checkout,
// the Changes view's Checkout Revision, the Stashes view's Apply and Pop, and a
// pull request's checkout — which matched git's ENGLISH ("local changes|
// overwritten") to say so, and so said nothing to anyone whose git speaks
// another language.
//
// The engine recognises the refusal from git's state (changesInTheWay.ts,
// pinned against real git in git-service); `applyOrAsk` (git/inTheWay.ts) says
// which changes are in the way and offers Stash & Retry or Cancel. This census
// keeps a door from running one of those commands around it — the shape of
// the report itself.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "apps/extension/src");
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * A commit-applying command run directly. Not: a paused operation's own
 * --continue / --abort / --skip / --quit (nothing to apply over), `checkout --`
 * (restoring paths is a discard, not a switch), or a new branch at HEAD
 * (`checkoutNew(name)` with no start point changes no file).
 */
const RAW: RegExp[] = [
  /\bbranches\.(?:checkout|merge|rebaseOnto)\(/,
  /\bstashes\.(?:apply|pop)\(/,
  /\bbranches\.checkoutNew\([^,)]+,/,
  /\brun\(\s*\[\s*"(?:cherry-pick|revert|merge|rebase|checkout|switch)"(?!\s*,\s*"(?:--continue|--abort|--skip|--quit|--)")/,
  /\brun\(\s*\[\s*"stash"\s*,\s*"(?:apply|pop)"/,
];

test("no extension door runs a commit-applying command around the in-the-way door", async () => {
  const raw: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (file.endsWith(join("git", "inTheWay.ts"))) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      if (RAW.some((re) => re.test(line))) raw.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.equal(
    raw.join("\n"),
    "",
    "commit-applying commands run directly — a refusal over the user's uncommitted work " +
      "would reach them as git's text (and, from the graph, a crash report):\n" + raw.join("\n"),
  );
});

test("every door that applies commits asks through applyOrAsk", async () => {
  const doors: Record<string, RegExp[]> = {
    "graph/commitActions.ts": [/kind:\s*"cherry-pick"/, /kind:\s*"revert"/, /checkoutOp\(/],
    "views/branchActions.ts": [/kind:\s*"merge"/, /kind:\s*"rebase"/, /checkoutOp\(\["checkout", ref\.name\]\)/, /checkoutOp\(plan\.args\)/, /checkoutOp\(\["checkout", "-b"/, /checkoutOp\(\["checkout", "--detach"/],
    "views/stashesView.ts": [/kind:\s*"stash",\s*stash:\s*ref\s*\}/, /kind:\s*"stash",\s*stash:\s*ref,\s*pop:\s*true/],
    "changes/commitView.ts": [/checkoutOp\(\["checkout", "--detach", r\]\)/],
    "pr/checkoutPr.ts": [/checkoutOp\(\["checkout", local\]\)/],
  };
  for (const [rel, needs] of Object.entries(doors)) {
    const src = await readFile(join(SRC, rel), "utf8");
    assert.match(src, /\bapplyOrAsk\(/, `${rel} goes through applyOrAsk`);
    for (const re of needs) assert.match(src, re, `${rel}: ${re}`);
  }
});

test("the graph's Revert and Cherry-Pick ask before anything can be reported", async () => {
  // showGitError is where the extension files a crash report. A refusal over
  // uncommitted work must be settled by the door before it is reachable.
  const src = await readFile(join(SRC, "graph/commitActions.ts"), "utf8");
  for (const fn of ["async function cherryPick(", "async function revert("]) {
    const start = src.indexOf(fn);
    assert.ok(start >= 0, fn);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const asked = body.indexOf("applyOrAsk(");
    const reported = body.indexOf("showGitError(");
    assert.ok(asked >= 0, `${fn} runs through applyOrAsk`);
    assert.ok(reported > asked, `${fn} reports only what applyOrAsk did not settle`);
    assert.match(body, /if \(applied\.cancelled \|\| applied\.settled\)/, `${fn} stops on a cancel or a settled refusal`);
  }
});

test("the in-the-way door files nothing and says it in the engine's words", async () => {
  const src = await readFile(join(SRC, "git/inTheWay.ts"), "utf8");
  const code = src.split("\n").filter((l) => !COMMENT.test(l)).join("\n");
  assert.doesNotMatch(code, /ErrorReporter|captureGitError|showErrorMessage/, "a refusal is not a failure");
  assert.match(code, /changesInTheWayMessage\(/, "which changes, in the engine's sentence");
  assert.match(code, /label:\s*"Stash & Retry"/);
  assert.match(code, /label:\s*"Cancel"/);
  assert.match(code, /stashAndRetry\(/);
  assert.match(code, /stashRetryNote\(/, "and what became of the stashed changes");
});
