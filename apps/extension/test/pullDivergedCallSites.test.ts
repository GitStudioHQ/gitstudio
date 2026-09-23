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

// The second half of the same door. The answer to "merge or rebase?" is a merge
// or a rebase, and either can STOP on conflicts — so every pull that can merge
// or rebase must also have decided what a stop looks like. `SyncOps.pull`
// answers it with a `stopped` fact (operation + conflicted files); a caller
// that treats it as an ordinary failure puts git's terminal hint ("Resolve all
// conflicts manually… git rebase --continue") in an error toast — or, for a
// merge, which says CONFLICT on stdout and nothing on stderr, a bare "pull
// failed" — which is report #12's symptom reached from the door built to close
// it. Unlike `diverged`, naming a mode is NOT an exemption: it is precisely the
// pulls that name one that stop.
//
// Evidence: the CODE just after the call (comments do not count — prose about
// a stop is not handling one) hands the result to the shared settler
// (`settlePullStop` in the extension, `pullVerdict` in the desktop renderer),
// or reads BOTH `.stopped` and `.blocked` itself, or the call carries a
// `pull-stop-reviewed:` note saying why neither applies.
//
// Both, because a stop has a second face: Pull pressed again over the merge or
// rebase that stop left paused. git refuses that before doing anything, and
// `SyncOps.pull` answers it as `blocked`. A site that read only `.stopped`
// passed this census while the refusal went out as git's "git add/rm" hint in
// a red toast and a crash report — found by driving the real app, not by this.
const STOP_HANDLED = /settlePullStop|pullVerdict/;
const READS_BOTH = (code: string): boolean => /\.stopped\b/.test(code) && /\.blocked\b/.test(code);
const STOP_EXEMPT = /pull-stop-reviewed:/;
/** A method DECLARATION (`async syncPull(opts) {`) is not a call site; the
 *  call inside its body is, and is checked on its own line. */
const DECLARATION = /^\s*(?:(?:public|private|protected)\s+)?async\s+\w+\s*\(/;

test("every pull call site has decided about a pull that stops on conflicts", async () => {
  const unhandled: string[] = [];
  let seen = 0;
  for (const rel of SCAN) {
    for (const file of await tsFiles(join(ROOT, rel))) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (COMMENT.test(line) || DECLARATION.test(line)) return;
        const call = CALL.exec(line);
        if (!call && !INVOKE.test(line)) return;
        // `--ff-only` never merges or rebases, so it cannot stop on conflicts.
        if (call && /ff-only/.test(call[1])) return;
        seen++;
        // Fourteen lines of CODE below the call: a stop is read after the
        // divergence question has been asked and answered, which sits between.
        const below: string[] = [];
        for (let k = i; k < lines.length && below.length < 14; k++) {
          if (!COMMENT.test(lines[k])) below.push(lines[k]);
        }
        if (STOP_HANDLED.test(below.join("\n")) || READS_BOTH(below.join("\n"))) return;
        if (STOP_EXEMPT.test(lines.slice(Math.max(0, i - 5), i + 2).join("\n"))) return;
        unhandled.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
      });
    }
  }
  assert.ok(seen > 5, `the scan found only ${seen} pull call sites — it broke`);
  assert.equal(
    unhandled.join("\n"),
    "",
    "pull call sites whose merge or rebase can stop on conflicts, with nothing reading " +
      "`.stopped` (or handing it to settlePullStop / pullVerdict) and no " +
      "`pull-stop-reviewed:` note:\n" +
      unhandled.join("\n"),
  );
});

// The settler every extension door hands its result to must settle BOTH ways a
// pull ends up in front of a merge or rebase under way: stopping in one, and
// being refused over one an earlier pull stopped in (`blocked`). The second is
// the next click after the first — Pull is still on screen, still counting one
// behind — and a settler that knew only `stopped` let it through to the doors'
// failure arms: git's "Pulling is not possible because you have unmerged files"
// as an error, or, from Update (pull), "merge or rebase?" asked about a merge
// already in progress. The extension test runner cannot load `vscode`, so this
// reads the settler's own body rather than calling it — and the sentence it
// shows comes from the engine's `pullPauseMessage`, which pullStopped.test.ts
// pins for both faces (and for nothing else).
test("the shared pull settler settles a pull refused over a stop, not only the stop", async () => {
  const src = await readFile(join(ROOT, "apps/extension/src/git/pullMode.ts"), "utf8");
  const start = src.indexOf("export function settlePullStop(");
  assert.ok(start >= 0, "settlePullStop is where every extension pull door settles");
  const code = src
    .slice(start, src.indexOf("\n}\n", start))
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
  assert.match(code, /stopped\?:/, "it takes a stop");
  assert.match(code, /blocked\?:/, "…and a pull git refused over one already under way");
  assert.match(
    code,
    /pullPauseMessage\(result\)/,
    "in the engine's words for both, shared with the desktop — not a stop-only sentence",
  );
});

// A pull on a DETACHED HEAD — a commit or a tag checked out — has no branch to
// pull into. git fetches and then prints advice for a terminal ("You are not
// currently on a branch. Please specify which branch you want to merge with.
// See git-pull(1) for details. git pull <remote> <branch>"), and the status
// bar's Sync and Pull showed exactly that, as an error. `SyncOps.pull` answers
// it as `detached`; every extension door hands its result to
// `settlePullDetached`, which says it plainly and offers to check out a branch.
test("every extension pull door settles a detached HEAD", async () => {
  const unsettled: string[] = [];
  let seen = 0;
  for (const file of await tsFiles(join(ROOT, "apps/extension/src"))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line) || DECLARATION.test(line) || !/\bsync\.pull\(/.test(line)) return;
      seen++;
      const below: string[] = [];
      for (let k = i; k < lines.length && below.length < 16; k++) {
        if (!COMMENT.test(lines[k])) below.push(lines[k]);
      }
      if (/settlePullDetached\(/.test(below.join("\n"))) return;
      if (/pull-detached-reviewed:/.test(lines.slice(Math.max(0, i - 5), i + 2).join("\n"))) return;
      unsettled.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.ok(seen >= 4, `the scan found only ${seen} extension pull call sites — it broke`);
  assert.equal(unsettled.join("\n"), "", "pulls that would show git's detached-HEAD advice:\n" + unsettled.join("\n"));
});

test("the detached-HEAD settler says it plainly and offers to check out a branch", async () => {
  const src = await readFile(join(ROOT, "apps/extension/src/git/pullMode.ts"), "utf8");
  const start = src.indexOf("export function settlePullDetached(");
  assert.ok(start >= 0, "settlePullDetached is where every extension pull door settles a detached HEAD");
  const code = src
    .slice(start, src.indexOf("\n}\n", start))
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
  assert.match(code, /\.detached\b/, "it reads the engine's fact");
  assert.match(code, /pullDetachedMessage\(\)/, "in the engine's words, not git's");
  assert.match(code, /showWarningMessage\([\s\S]*?,\s*CHECK_OUT_BRANCH\)/, "a warning, with the way on as its button");
  assert.match(code, /checkOut\(\)/, "…which opens the branch UI");
  assert.doesNotMatch(code, /showErrorMessage/, "nothing failed");
});

test("the status bar's Pull asks nothing before it knows there is a branch", async () => {
  // "Merge or rebase?" about a detached HEAD is a question whose every answer
  // ends in the same refusal. The Pull verb asks first, so it looks first.
  const src = await readFile(join(ROOT, "apps/extension/src/statusBar/syncStatus.ts"), "utf8");
  const start = src.indexOf('case "pull": {');
  assert.ok(start >= 0);
  const arm = src.slice(start, src.indexOf("askRebase()", start));
  assert.match(arm, /\.detached\b/, "the HEAD is checked before the question");
});
