import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every pull surface must have decided what happens when the branch has
// diverged from its upstream.
//
// This is the guard that would have caught report #12, and it is deliberately
// the same shape as pushForceCallSites: the ENGINE is not where these bugs
// live. `SyncOps.pull` hands back a `diverged` fact for exactly this state —
// but a caller that ignores it puts the user back in front of git's advice for
// a terminal ("You have divergent branches…", then three `git config` lines),
// which is what a 1.4.0 user got when they pressed Pull.
//
// A test of the engine cannot see that. A census of the call sites can, and it
// is the census — not a sweep — that catches the SIBLING door: when this was
// written the desktop's top bar and the extension's branch menu had been
// taught to ask, and the extension's status-bar Sync had not.
//
// The rule, for a `sync.pull(` / `syncPull(` call or a `sync:pull` invoke:
//   · it names the reconciliation in its own arguments (`mode` / `rebase`) —
//     the question was already answered before the call; or
//   · the lines just after it read `.diverged` (or hand the answer to
//     `pullWithChoice`, which does) — the question gets asked; or
//   · it carries an explicit `pull-diverged-reviewed:` note saying why neither
//     applies, e.g. a pure forwarder whose caller decides.
//
// Evidence must be on the call's OWN arguments or in the lines below it, never
// merely "somewhere nearby": a plain `sync.pull()` sitting four lines above a
// `case "pullRebase":` would otherwise pass on the word `rebase` belonging to
// a different branch of the switch. That near-miss is real — it is the shape
// this file had before it was tightened.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN = ["apps/extension/src", "apps/desktop/src", "packages/git-service/src"];

/** A direct engine/bridge call: captures its argument text. */
const CALL = /(?:sync\.pull|syncPull)\s*\(([^)]*)/;
/** The desktop's IPC door onto the same operation. */
const INVOKE = /invoke\(\s*"sync:pull"/;
/** The reconciliation named in the call's own arguments. */
const NAMED = /mode|rebase/i;
/** The question being asked about the answer that came back. */
const ASKED = /\.diverged|pullWithChoice/;
const EXEMPT = /pull-diverged-reviewed:/;
/** A comment line. Prose ABOUT a call is not a call site. */
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every pull call site has decided about a diverged branch", async () => {
  const unreviewed: string[] = [];
  let seen = 0;

  for (const rel of SCAN) {
    for (const file of await tsFiles(join(ROOT, rel))) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;
        const call = CALL.exec(line);
        const invoke = INVOKE.test(line);
        if (!call && !invoke) return;
        seen++;
        // The arguments the call actually passes — not the neighbourhood.
        if (call && NAMED.test(call[1])) return;
        // The answer being handled, on this line or in the ones just below it,
        // which is where a caller reads what came back.
        if (ASKED.test(lines.slice(Math.max(0, i - 1), i + 9).join("\n"))) return;
        // …or the decision written down, above the call where it is read first.
        if (EXEMPT.test(lines.slice(Math.max(0, i - 5), i + 2).join("\n"))) return;
        unreviewed.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
      });
    }
  }

  assert.ok(seen > 5, `the scan found only ${seen} pull call sites — it broke`);
  assert.equal(
    unreviewed.join("\n"),
    "",
    "pull call sites that neither name a reconciliation, nor handle the " +
      "`diverged` answer, nor carry a `pull-diverged-reviewed:` note:\n" +
      unreviewed.join("\n"),
  );
});
