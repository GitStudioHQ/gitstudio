import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Every surface that builds an interactive-rebase plan must select its commits
 * the way git's own sequencer does. In an interactive rebase the todo IS the
 * plan, so a wrong selection is not a display bug — it is executed.
 *
 * Three flags, each of which cost a real wedge before it was found:
 *
 *  · `--no-merges` — a rebase FLATTENS merges, and `git rebase -i` refuses
 *    `pick <merge>` outright ("error: 'pick' does not accept merge commits").
 *    git checks out the base BEFORE parsing the todo, so the repo was left
 *    detached at the base, mid-rebase, with a clean tree and no conflict to
 *    resolve. Continue re-ran the same failing todo; only Abort escaped. A
 *    feature branch with main merged into it is the ordinary shape of this.
 *
 *  · `--cherry-pick --right-only` over a THREE-dot range — drops commits whose
 *    patch is already on the base. `base..HEAD` keeps them, git's todo does
 *    not, so the plan listed a commit git would skip; running it paused with
 *    "warning: skipped previously applied commit" on a clean tree.
 *
 *  · `--topo-order` — reversed, this reproduces git's own todo. The default
 *    ordering does not, so the plan promised one replay order and git performed
 *    another. Measured on a range whose lines interleave by date.
 *
 * The desktop learned all three; the extension's own panel was still using a
 * bare `base..HEAD` months later, because nothing tied the two together. This
 * test is that tie: a census, not an engine test, because the engine
 * (`buildRebasePlan`) was correct the whole time and the callers were not.
 */
const PANEL = fileURLToPath(new URL("../src/rebase/rebaseWorkspacePanel.ts", import.meta.url));
const DESKTOP = fileURLToPath(new URL("../../desktop/src/main/rebaseBridge.ts", import.meta.url));

/** The `ctx.process.run([...])` argument list of a `git log` that feeds a plan. */
function logInvocations(src: string): string[] {
  const out: string[] = [];
  const re = /process\.run\(\[\s*"log",/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Walk to the matching close bracket so a multi-line argument list — which
    // all of these are — is captured whole.
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "[") depth++;
      else if (src[i] === "]") depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** A `git log` that builds a rebase todo names a sha and a subject. */
const BUILDS_A_TODO = /%H/;

for (const [name, file] of [
  ["the extension's rebase workspace", PANEL],
  ["the desktop's rebase bridge", DESKTOP],
] as const) {
  test(`${name} selects its commits the way git's sequencer does`, async () => {
    const src = await readFile(file, "utf8");
    const calls = logInvocations(src).filter((c) => BUILDS_A_TODO.test(c));
    assert.ok(calls.length > 0, `expected to find a plan-building git log in ${file}`);

    for (const call of calls) {
      const head = call.replace(/\s+/g, " ").slice(0, 90);
      assert.match(call, /"--no-merges"/, `${head}: must exclude merges — git rebase -i refuses to pick one`);
      assert.match(call, /"--topo-order"/, `${head}: must use git's own todo ordering`);
      assert.match(
        call,
        /"--cherry-pick",\s*"--right-only"/,
        `${head}: must drop commits already applied to the base, as git's todo does`,
      );
      // The range reaches the call as a variable in both files, so the
      // three-dot form is asserted on its definition instead.
      assert.match(call, /\brange\b/, `${head}: passes a range`);
    }
    // …and that range is three-dot when it is not `--root`. `--cherry-pick`
    // compares the two SIDES of a symmetric difference: given `base..HEAD` it
    // has nothing to compare against and silently drops nothing at all, so the
    // flag reads as present while doing exactly what its absence did.
    assert.match(
      src,
      /threeDot \? `\$\{base\}\.\.\.HEAD` : "HEAD"/,
      "the plan's range must be three-dot for --cherry-pick to mean anything",
    );
  });
}
