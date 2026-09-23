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
 * The legacy per-operation channels are still registered in the main process,
 * but they are the ones P2's review found wanting: rebase:continue never asks
 * before dropping an emptied commit and finishes a --rebase-merges merge step
 * without recording the merge; am:abort decides "not rewinding" from git's
 * English; cherryPick:abort / revert:abort never check whether git rewound at
 * all. The rebase view still called three of them.
 */
const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));

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
