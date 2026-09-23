import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  announcePause,
  operationInProgressMessage,
  RESOLVE_CONFLICTS_ACTION,
  SHOW_CONFLICTS_COMMAND,
  stoppedByThisCommand,
} from "../src/git/pausedForUser";

// Whether an operation is in progress, and whether a command just left git
// stopped, are asked of the files git writes (OperationProvider.detect) —
// never of `git status` / stderr prose, which a non-English git words
// differently (PLAN matrix row 14). And a "paused" notice always offers the
// way through (row 13).

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*$/gm, "");
}

async function census(pattern: RegExp, exempt: string[] = []): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await tsFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (exempt.includes(rel)) continue;
    stripComments(await readFile(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
  }
  return hits;
}

test("no operation state is read from git's English prose", async () => {
  // `git status` says "rebase in progress" only in English; stderr says
  // "conflict" only in English. Both shipped as the only check in three places.
  const hits = [
    ...(await census(/\/[^/\n]*in progress[^/\n]*\/i?\.test\(/)),
    ...(await census(/\/conflict\/i\.test\(/)),
  ];
  assert.deepEqual(hits, [], hits.join("\n"));
});

test("git's operation files are never watched at a literal <root>/.git", async () => {
  // In a linked worktree <root>/.git is a FILE; the watchers resolve
  // `rev-parse --git-path` instead (merge-vscode gitWatch.ts).
  const hits = await census(/joinPath\([^)]*["'`]\.git["'`]\)/);
  assert.deepEqual(hits, [], hits.join("\n"));
});

/** What a "git stopped for you" message says, in any of the doors' wordings. */
const PAUSED = /hit conflicts|hit a conflict|needs a decision|needs you/;

/** Every show*Message( … ) call's full argument text (multi-line, ternaries and all). */
function messageCalls(code: string): string[] {
  const calls: string[] = [];
  for (const m of code.matchAll(/show(?:Warning|Error|Information)Message\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    calls.push(code.slice(start, i - 1));
  }
  return calls;
}

test("every 'paused' toast goes through notifyPaused, so each one offers Resolve Conflicts…", async () => {
  // Seven doors can leave git stopped: cherry-pick and revert (graph), merge
  // and rebase (branch list), pull (status bar), undo-by-revert, reorder
  // (graph), stash apply / pop.
  const hits: string[] = [];
  for (const file of await tsFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (rel === "git/pauseNotice.ts" || rel === "git/pausedForUser.ts") continue;
    for (const args of messageCalls(stripComments(await readFile(file, "utf8")))) {
      if (PAUSED.test(args)) {
        hits.push(`${rel} — ${args.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

test("a paused notice offers Resolve Conflicts…, which opens the dashboard; dismissing does nothing", async () => {
  const calls: string[] = [];
  await announcePause(
    {
      showWarningMessage: async (message, ...actions) => {
        calls.push(`toast:${message}|${actions.join(",")}`);
        return RESOLVE_CONFLICTS_ACTION;
      },
      executeCommand: async (command) => {
        calls.push(`run:${command}`);
      },
    },
    "Pull hit conflicts.",
  );
  assert.deepEqual(calls, ["toast:Pull hit conflicts.|Resolve Conflicts…", `run:${SHOW_CONFLICTS_COMMAND}`]);

  const dismissed: string[] = [];
  await announcePause(
    {
      showWarningMessage: async () => undefined,
      executeCommand: async (command) => {
        dismissed.push(command);
      },
    },
    "x",
  );
  assert.deepEqual(dismissed, []);
});

test("starting a rebase is refused while ANY operation is stopped, in plain words", () => {
  assert.equal(operationInProgressMessage({ kind: "none", unmerged: 0 }), undefined);
  assert.equal(
    operationInProgressMessage({ kind: "rebase", unmerged: 1 }),
    "A rebase is already in progress — continue or abort it first.",
  );
  assert.equal(
    operationInProgressMessage({ kind: "merge", unmerged: 0 }),
    "A merge is already in progress — continue or abort it first.",
  );
  assert.equal(
    operationInProgressMessage({ kind: "am", unmerged: 0 }),
    "Applying patches (git am) is already in progress — continue or abort it first.",
  );
  assert.equal(
    operationInProgressMessage({ kind: "none", unmerged: 2 }),
    "There are unresolved conflicts — resolve them or cancel first.",
  );
});

test("a pull 'hit conflicts' only when IT left git stopped — not when git refused over an existing stop", () => {
  const none = { kind: "none", unmerged: 0 };
  assert.equal(stoppedByThisCommand(none, { kind: "merge", unmerged: 1 }), true);
  assert.equal(stoppedByThisCommand(none, { kind: "rebase", unmerged: 2 }), true);
  assert.equal(
    stoppedByThisCommand({ kind: "merge", unmerged: 1 }, { kind: "merge", unmerged: 1 }),
    false,
    "already merging: the pull was refused, it did not conflict",
  );
  assert.equal(stoppedByThisCommand(none, none), false, "a plain failure (network, auth)");
  assert.equal(stoppedByThisCommand(none, { kind: "none", unmerged: 1 }), true);
});
