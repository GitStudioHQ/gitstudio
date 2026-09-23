import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every extension door that applies commits — and every pull — goes through
// the shared door.
//
// Crash report #18 was the graph's Revert over an edit to a file the revert
// touches: git refused ("Your local changes to the following files would be
// overwritten by merge … fatal: revert failed"), and the door showed that in
// red and filed it as a crash. The refusal is the user's state, and every door
// that applies commits meets it: Cherry-Pick, Revert and Checkout in the
// graph, Checkout / Merge / Rebase / Create and Switch in the Branches view,
// a tag and a remote branch checked out, a pull request checked out (which
// matched git's ENGLISH, "local changes|overwritten", and so said nothing on a
// localised git), the Changes view's Checkout Revision, a stash applied or
// popped — and a pull. git/inTheWay.ts's applyOrAsk / pullOrAsk recognise it
// from git's state and ask Stash & Retry or Cancel; a door that runs its git
// command directly is the next report #18. The engine half is pinned against
// real git in packages/git-service/test/changesInTheWay.test.ts and
// pullStashRetry.test.ts, and the doors themselves are driven through real git
// in inTheWayStateTable.test.ts; this is the census that catches the SIBLING
// door, as pushForceCallSites is for the force push.
//
// (One census. Two copies of it were written side by side, the same afternoon,
// and checked the same doors by different rules; they are merged here.)
//
// The rule, per code line in apps/extension/src:
//   · no direct `branches.checkout(` / `branches.merge(` / `branches.rebaseOnto(`
//     / `branches.checkoutNew(` / `stashes.apply(` / `stashes.pop(` /
//     `sync.pull(`, and no `process.run(plan.args` — those run git past the
//     door;
//   · an argv that starts a cherry-pick, revert, merge, rebase, checkout or
//     switch (not its --abort / --continue / --skip / --quit, and not
//     `checkout --`, which restores files), or a stash apply / pop, is handed
//     to `applyOrAsk(` or `runCheckout(` in the lines around it;
//   · or the line carries an `in-the-way-reviewed:` note saying why it cannot
//     be refused (a new branch at HEAD changes no file).

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "apps/extension/src");
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const DIRECT =
  /\b(?:branches\.(?:checkout|checkoutNew|merge|rebaseOnto)|stashes\.(?:apply|pop)|sync\.pull)\(|process\.run\(\s*plan\.args/;
const ARGV = /\[\s*"(cherry-pick|revert|merge|rebase|checkout|switch)"(?:\s*,\s*"([^"]*)")?/;
const STASH_ARGV = /\[\s*"stash"\s*,\s*"(?:apply|pop)"/;
const NOT_APPLYING = /^--(?:abort|continue|skip|quit)?$/;
const ARGV_CONTEXT = /\b(?:run|runGit|args|checkoutOp|runCheckout|applyOrAsk)\b/;
const ROUTED = /\b(?:applyOrAsk|runCheckout|checkoutOp)\(/;
const REVIEWED = /in-the-way-reviewed:/;
/** The door itself runs git on the callers' behalf. */
const THE_DOOR = join("git", "inTheWay.ts");

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The census over every code line; returns what it found and what bypasses the door. */
async function census(): Promise<{ doors: number; bypass: string[] }> {
  const bypass: string[] = [];
  let doors = 0;
  for (const file of await tsFiles(SRC)) {
    if (file.endsWith(THE_DOOR)) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const reviewed = REVIEWED.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"));
      if (DIRECT.test(line)) {
        doors++;
        if (!reviewed) bypass.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
        return;
      }
      const argv = ARGV.exec(line);
      const stash = STASH_ARGV.test(line);
      if (!stash && (!argv || NOT_APPLYING.test(argv[2] ?? "x"))) return;
      // An argv handed to git — a `run(`, an `args`, a door — not a list of
      // words that happens to start with one (`["merge", "squash", "rebase"]`).
      if (!ARGV_CONTEXT.test(line)) return;
      doors++;
      const around = lines.slice(Math.max(0, i - 8), i + 14).join("\n");
      if (ROUTED.test(around) || reviewed) return;
      bypass.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  return { doors, bypass };
}

test("every extension door that applies commits, and every pull, asks about uncommitted work in its way", async () => {
  const { doors, bypass } = await census();
  assert.ok(doors >= 10, `the scan found only ${doors} commit-applying doors — it broke`);
  assert.equal(
    bypass.join("\n"),
    "",
    "commands that apply commits without the shared door — a refusal over the " +
      "user's uncommitted work would be shown as git's text and filed as a crash:\n" +
      bypass.join("\n"),
  );
});

test("every door that applies commits hands the door its own op", async () => {
  const doors: Record<string, RegExp[]> = {
    "graph/commitActions.ts": [/kind:\s*"cherry-pick"/, /kind:\s*"revert"/, /checkoutOp\(/],
    "views/branchActions.ts": [
      /kind:\s*"merge"/,
      /kind:\s*"rebase"/,
      /checkoutOp\(\["checkout", ref\.name\]\)/,
      /checkoutOp\(plan\.args\)/,
      /checkoutOp\(\["checkout", "-b"/,
      /checkoutOp\(\["checkout", "--detach"/,
    ],
    "views/stashesView.ts": [/kind:\s*"stash",\s*stash:\s*ref\s*\}/, /kind:\s*"stash",\s*stash:\s*ref,\s*pop:\s*true/],
    "changes/commitView.ts": [/checkoutOp\(\["checkout", "--detach", r\]\)/, /pullOrAsk\(entry\.ctx/],
    "pr/checkoutPr.ts": [/checkoutOp\(\["checkout", local\]\)/],
    "statusBar/syncStatus.ts": [/pullOrAsk\(active\.ctx\)/, /pullOrAsk\(active\.ctx, mode\)/],
  };
  for (const [rel, needs] of Object.entries(doors)) {
    const src = await readFile(join(SRC, rel), "utf8");
    assert.match(src, /\b(?:applyOrAsk|pullOrAsk)\(/, `${rel} goes through the door`);
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

test("the door asks Stash & Retry or Cancel, in the engine's words, and files nothing", async () => {
  const src = await readFile(join(SRC, "git/inTheWay.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
  assert.match(code, /runApplying\(/, "recognised by the engine, from git's state");
  assert.match(code, /changesInTheWayMessage\(/, "said in the engine's words — which files, in the way of what");
  assert.match(code, /label:\s*"Stash & Retry"/);
  assert.match(code, /label:\s*"Cancel"/);
  assert.match(code, /stashAndRetry\(/, "and Stash & Retry does it");
  assert.match(code, /stashAndRetryPull\(/, "…for a pull too");
  assert.match(code, /stashRetryNote\(/, "saying where the changes are when they are not back");
  assert.doesNotMatch(code, /ErrorReporter|captureGitError/, "a refusal over the user's work is never a crash report");
  assert.doesNotMatch(code, /showErrorMessage/, "nor an error");
});
