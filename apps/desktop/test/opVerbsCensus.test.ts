import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every Continue / Skip / Abort the renderer offers goes through the SHARED
 * operation core (op:continue / op:skip / op:abort, OperationProvider in
 * git-service) — the verbs the dashboard and the merge editor use.
 *
 * The legacy per-operation channels (all but rebase:abort, now removed — see
 * the last test) are still registered in the main process, but they are the
 * ones P2's review found wanting: rebase:continue never asks
 * before dropping an emptied commit and finishes a --rebase-merges merge step
 * without recording the merge; am:abort decides "not rewinding" from git's
 * English; cherryPick:abort / revert:abort never check whether git rewound at
 * all. The rebase view still called three of them.
 */
const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const LEGACY =
  /invoke\(\s*"(rebase:continue|rebase:abort|rebase:skip|merge:continue|merge:abort|cherryPick:continue|cherryPick:abort|cherryPick:skip|revert:continue|revert:abort|revert:skip|am:continue|am:abort|am:skip)"/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("no renderer surface drives an operation through the legacy verbs", async () => {
  const hits: string[] = [];
  for (const file of await tsFiles(ROOT)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (LEGACY.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `use op:continue / op:skip / op:abort:\n${hits.join("\n")}`);
});

test("the rebase view's in-progress card uses the shared verbs, the shared lock and the willDrop question", async () => {
  const src = await readFile(join(ROOT, "views/rebase.ts"), "utf8");
  for (const channel of ["op:continue", "op:skip", "op:abort"]) {
    assert.ok(src.includes(`"${channel}"`), `${channel} is used`);
  }
  assert.match(src, /exclusive\(/, "one verb at a time, with the dashboard and the merge editor");
  assert.match(src, /willDrop[\s\S]{0,400}confirmDrop/, "an emptied commit is confirmed before confirmDrop is sent");
  assert.match(src, /holdWhile: whileSameRepo\(\)/, "and its questions outlive the watcher's refresh");
});

/**
 * The legacy rebase:abort channel is gone, not just unused. It ran
 * `rebase --abort` straight through the runner, outside the operation core:
 * never `am --abort` for a `git am` (which keeps its state in rebase-apply/
 * too, and which `rebase --abort` refuses with exit 128), and outside the
 * renderer's one verb lock. No renderer surface called it any more, and a
 * channel nothing uses is one a future caller picks up by accident. Abort is
 * op:abort (OperationProvider.abort), which picks the operation's own verb.
 */
test("the legacy rebase:abort channel is gone: every abort goes through the operation core", async () => {
  const ipc = await readFile(join(SRC, "shared/ipc.ts"), "utf8");
  const main = await readFile(join(SRC, "main/main.ts"), "utf8");
  const bridge = await readFile(join(SRC, "main/gitBridge.ts"), "utf8");
  assert.doesNotMatch(ipc, /"rebase:abort"/, "no rebase:abort channel in the IPC map");
  assert.doesNotMatch(main, /handle\(\s*"rebase:abort"/, "no handler registered for it");
  assert.doesNotMatch(bridge, /^\s+rebaseAbort\(/m, "and no bridge method that runs rebase --abort around the core");
  assert.match(main, /handle\(\s*"op:abort"/, "the operation core's abort is what is left");
});
