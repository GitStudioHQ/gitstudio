import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * A failed read must not be laundered into an empty result.
 *
 * `.catch(() => [])` on a GitHub read turns a rate limit, a dropped connection
 * or a 500 into "This PR has no commits yet." — beside a rail reading 14. The
 * app states something false with complete confidence and offers no way to
 * retry, and the renderer's errorState-with-Retry branches, which were already
 * written, can never run.
 *
 * WHAT THIS TEST DOES AND DOES NOT PROVE. It is a census of the source, not a
 * behavioural test: `GitHubBridge` constructs its own `GitHubClient`, so there
 * is no seam to inject a failing one without a refactor. The harness check
 * `a-failed-read-says-so-instead-of-showing-nothing` covers the other half —
 * that the RENDERER handles a rejection, shows it, and offers Retry — by
 * failing the channel at the shim. Neither one alone covers the whole path, and
 * saying so is the point: the harness replaces the main process entirely, so no
 * harness check can ever exercise this file.
 *
 * The rule: a read whose result the UI renders as a LIST either propagates its
 * failure, or carries a note saying why an empty array is the honest answer.
 */
const BRIDGE = fileURLToPath(new URL("../src/main/githubBridge.ts", import.meta.url));

/**
 * `.catch(() => [])`, `.catch(() => {})`, and the parenthesised object form
 * `.catch(() => ({}))` — which is how an arrow returns an object literal, and
 * the form a first pass at this regex missed.
 */
const SWALLOW = /\.catch\(\s*\(\s*\)\s*=>\s*\(?\s*(\[\]|\{\s*\})\s*\)?\s*\)/;

/** An opt-out, for the cases where empty really is the truthful answer. */
const REVIEWED = /read-failure-reviewed:/;

test("no GitHub read hides its failure behind an empty list", async () => {
  const src = await readFile(BRIDGE, "utf8");
  const lines = src.split("\n");
  const bad: string[] = [];
  lines.forEach((line, i) => {
    if (!SWALLOW.test(line)) return;
    // The note may sit on the line itself or in the comment block above it.
    const near = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
    if (REVIEWED.test(near)) return;
    bad.push(`githubBridge.ts:${i + 1}  ${line.trim().slice(0, 96)}`);
  });
  assert.deepEqual(
    bad,
    [],
    "these reads turn a failure into an empty result, so the UI reports 'there are none' about " +
      "a request that never answered. Either let it reject — the error states already exist — or " +
      "add a `read-failure-reviewed:` note saying why empty is truthful here:\n" +
      bad.join("\n"),
  );
});

test("the census can see the pattern it is looking for", async () => {
  // A census that matches nothing passes forever.
  assert.equal(SWALLOW.test("return this.client.listPrCommits(o, r, n).catch(() => []);"), true);
  assert.equal(SWALLOW.test("x.catch(() => ({}))"), true);
  assert.equal(SWALLOW.test("x.catch((e) => report(e))"), false, "a handler that DOES something is fine");
  const src = await readFile(BRIDGE, "utf8");
  assert.ok(src.includes(".catch("), "the file still uses .catch somewhere — the shape is current");
});
