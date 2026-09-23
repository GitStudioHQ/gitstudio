import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every destructive control the renderer offers must be hard to fire twice.
 *
 * `serialize()` in the main process QUEUES a second call rather than dropping
 * it — its own comment names "a double-clicked Stage" as the thing it exists
 * for — so a button that stays enabled through its round trip really does run
 * the command twice. Measured on the banner's new "Skip this patch": two clicks
 * discarded two patches from a series the app cannot replay, with the only
 * feedback an INFO toast that looked identical between them.
 *
 * A census, not an engine test, for the same reason the arg-guard census
 * exists: the mechanisms are all present and correct, and the defect is a call
 * site that does not use one.
 *
 * Two shapes count as a guard, and they defend different things:
 *
 *   · A CONFIRM DIALOG — `confirmDialog`, or `promptChoice` where the question
 *     is "which of these", not "are you sure". A second click lands on the
 *     dialog's scrim, not on the button, so the race cannot happen at all.
 *   · DISABLING IN FLIGHT — `disabled = true`, an `is-busy` class, or
 *     `runBusy`. Necessary where there is no dialog to absorb the second press.
 *
 * A call site with neither must be listed in REVIEWED with the reason it is
 * safe. "It's only one click" is not a reason.
 */
const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));

/**
 * Channels whose second run destroys something the user cannot get back, or
 * silently repeats an action against a DIFFERENT object (a positional stash
 * index, the next patch in a series).
 */
const DESTRUCTIVE =
  /"(stash:drop|branch:delete|branch:deleteRemote|gist:delete|release:delete|release:deleteAsset|actions:deleteSecret|actions:deleteVariable|ai:removeConnection|rebase:abort|merge:abort|cherryPick:abort|revert:abort|am:abort|rebase:skip|cherryPick:skip|revert:skip|am:skip|git:discard|discard:all|reset:hard|commit:reset|repos:trash|branch:rebase|op:abort|op:skip|op:continue|conflict:takeRole|conflict:delete|conflict:resolve)"/;

/**
 * Anything in the enclosing lines that makes a second press harmless.
 *
 * `exclusive(` / `this.run(` are the merge-parity verbs' guard (mergeParity.ts):
 * ONE renderer-wide lock shared by the conflicts dashboard, the merge editor
 * and the rebase view, which DROPS a second verb while one is running, and
 * keeps the dashboard locked until the state the verb led to is read back.
 */
const GUARD =
  /confirmDialog|confirmDanger|requireTyped|promptChoice|askForCommitAction|disabled = true|is-busy|runBusy|refreshInPlace|exclusive\(|this\.run\(/;

/** Call sites reviewed and found safe without either guard. */
const REVIEWED: Record<string, string> = {
  // The Assistant's own tool-call path is driven by the model, not by a button
  // a person can double-click.
  "assistant.ts": "not user-triggered — the model calls these, one at a time",
};

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** How many lines above an invoke a guard may sit and still be guarding it. */
const WINDOW = 18;

test("every destructive control is confirm-gated or disabled in flight", async () => {
  const unguarded: string[] = [];
  for (const file of await tsFiles(ROOT)) {
    const rel = relative(ROOT, file);
    if (REVIEWED[rel]) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!DESTRUCTIVE.test(line) || !/invoke\(/.test(line)) return;
      // The guard usually sits above the call — inside the `.then()` of a
      // confirm, or on the button that triggered it.
      const near = lines.slice(Math.max(0, i - WINDOW), i + 3).join("\n");
      if (GUARD.test(near)) return;
      unguarded.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    unguarded,
    [],
    "these destructive controls can be fired twice — `serialize()` queues the second call rather than " +
      "dropping it, so the command really does run again. Add a confirm dialog or disable the control " +
      "for the round trip, or add the file to REVIEWED with the reason it is safe:\n" +
      unguarded.join("\n"),
  );
});

test("the census actually sees the controls it claims to check", async () => {
  // A census that matches nothing passes forever. This is the arg-guard
  // suite's own guard against itself, for the same reason.
  let seen = 0;
  for (const file of await tsFiles(ROOT)) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (DESTRUCTIVE.test(line) && /invoke\(/.test(line)) seen++;
    }
  }
  assert.ok(
    seen >= 8,
    `expected to find the destructive call sites, found ${seen} — has the invoke style changed?`,
  );
});

test("the reviewed list has not gone stale", async () => {
  const files = (await tsFiles(ROOT)).map((f) => relative(ROOT, f));
  for (const name of Object.keys(REVIEWED)) {
    assert.ok(files.includes(name), `${name} is in REVIEWED but no longer exists`);
  }
});
