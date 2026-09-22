// A structural guard over gitBridge.ts, in the same spirit as the stylesheet
// tests: it reads the source and asserts a property no behavioural test can.
//
// Every mutation on this bridge takes strings straight from the renderer and
// hands them to git. Git reads any argument beginning with "-" as an OPTION, so
// a ref named `--upload-pack=…` is not a ref at all. `safeArg` exists for this
// and is applied in two dozen places — but "applied in two dozen places" is not
// a property, it is a habit, and habits are what a new handler skips.
//
// So: every method here that returns a CommitActionResult must either guard its
// arguments, or appear below with a reason it does not need to. Adding a
// handler without doing one or the other fails this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "src", "main", "gitBridge.ts"), "utf8");

/**
 * Methods that pass no renderer string to git in a position git could read as
 * an option. Each entry names WHY, so a future reader can re-check the claim
 * instead of trusting the list.
 */
const REVIEWED: Record<string, string> = {
  // Paths, always passed after a `--` separator by the git-service providers
  // (`git add -- <rel>`, `git reset -q HEAD -- <rel>`), where a leading dash is
  // a pathspec rather than a flag.
  stage: "path goes after `--`",
  unstage: "path goes after `--`",
  discard: "path goes after `--`",
  hunksStage: "path goes after `--`",
  stageLines: "path goes after `--`",
  // Free text passed as the VALUE of a flag (`-m <message>`), never as its own
  // positional.
  commit: "message is the value of -m",
  stashSave: "message is the value of -m",
  // No renderer-supplied string at all.
  stageAll: "no arguments",
  unstageAll: "no arguments",
  syncFetch: "boolean options only",
  syncPush: "boolean options only",
  mergeAbort: "no arguments",
  mergeContinue: "no arguments",
  amAbort: "no arguments",
  amSkip: "no arguments",
  amContinue: "no arguments",
  cherryPickAbort: "no arguments",
  cherryPickSkip: "no arguments",
  revertSkip: "no arguments",
  cherryPickContinue: "no arguments",
  revertAbort: "no arguments",
  revertContinue: "no arguments",
  rebaseAbort: "no arguments",
  rebaseContinue: "no arguments",
  rebaseSkip: "no arguments",
};

/**
 * Every `name(args): Promise<CommitActionResult>` method and its body.
 *
 * Parsed by counting parentheses and braces rather than with one regex: several
 * signatures here span multiple lines, and a lazy `[\s\S]*?` between the name
 * and the return type happily runs THROUGH the next method to find one.
 */
function mutations(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const head = /^ {2}(?:async )?(\w+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = head.exec(SRC))) {
    // Walk to the closing paren of the parameter list.
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < SRC.length && depth > 0) {
      if (SRC[i] === "(") depth++;
      else if (SRC[i] === ")") depth--;
      i++;
    }
    const after = SRC.slice(i, i + 60);
    // PullActionResult EXTENDS CommitActionResult — it is the same mutation
    // with one extra field. Matching the base name only silently dropped
    // `syncPull` out of this census the day it learned to answer a diverged
    // branch, i.e. the day it started taking a renderer-supplied string.
    if (!/^\s*:\s*Promise<(?:Commit|Pull)ActionResult>/.test(after)) continue;
    const brace = SRC.indexOf("{", i);
    if (brace < 0) continue;
    let j = brace + 1;
    depth = 1;
    while (j < SRC.length && depth > 0) {
      if (SRC[j] === "{") depth++;
      else if (SRC[j] === "}") depth--;
      j++;
    }
    out.push({ name: m[1], body: SRC.slice(brace + 1, j) });
  }
  return out;
}

/** The shapes of guard used in this file. */
function guards(body: string): boolean {
  // safePath is the pathspec form: it allows a leading dash (legal after `--`)
  // and refuses the two things that actually break a path — empty, and a NUL.
  // safePullMode is the allowlist form: the value is not sanitised, it is
  // checked against the only three things it is allowed to be.
  return (
    body.includes("safeArg(") ||
    body.includes("safePath(") ||
    body.includes("safePullMode(") ||
    body.includes('startsWith("-")')
  );
}

test("the bridge exposes the mutations we think it does", () => {
  const found = mutations();
  assert.ok(
    found.length >= 30,
    `expected to parse the bridge's mutations, found ${found.length} — has the method signature style changed?`,
  );
  assert.ok(found.some((f) => f.name === "branchCreate" || f.name === "createBranch"),
    `expected a branch-creating mutation among: ${found.map((f) => f.name).join(", ")}`);
});

test("every git mutation either guards its arguments or is listed as not needing to", () => {
  const unaccounted = mutations()
    .filter((m) => !guards(m.body))
    .filter((m) => !(m.name in REVIEWED))
    .map((m) => m.name);
  assert.deepEqual(
    unaccounted,
    [],
    `these mutations pass renderer input to git without a safeArg/leading-dash guard, ` +
      `and are not in the reviewed list. Either guard them, or add them to REVIEWED ` +
      `with the reason they are safe: ${unaccounted.join(", ")}`,
  );
});

test("the reviewed list has not gone stale", () => {
  // An entry that has since GROWN a guard, or that no longer exists, is a
  // comment claiming something untrue.
  const byName = new Map(mutations().map((m) => [m.name, m]));
  for (const name of Object.keys(REVIEWED)) {
    const m = byName.get(name);
    assert.ok(m, `REVIEWED lists "${name}", which is no longer a mutation on the bridge`);
    assert.equal(
      guards(m!.body),
      false,
      `"${name}" now guards its arguments — remove it from REVIEWED`,
    );
  }
});

test("safeArg rejects exactly what git would read as an option", () => {
  // Re-stating the contract the guards above rely on, so a change to safeArg
  // that widened it would surface here rather than silently in production.
  const src = SRC.slice(SRC.indexOf("export function safeArg"));
  assert.match(src, /!v\.startsWith\("-"\)/, "safeArg must still reject a leading dash");
  assert.match(src, /v\.length > 0/, "and the empty string");
});
