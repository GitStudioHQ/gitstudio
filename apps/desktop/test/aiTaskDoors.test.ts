// Every one-shot AI task the main process answers has a door that sends it —
// or is listed below, by name, as kept without one.
//
// `ai:task` is answered by AiBridge.runTask, one `case` per AiTaskName. Nothing
// ties that list to what the renderer can actually ask for, so a task can
// outlive its last door and go on accreting logic nobody can exercise. That is
// what happened to `explainConflict`: ~60 lines of refusal classification
// (`conflictToExplain` — which failure is ours, which is the user's) for a
// request no control in the app could make. The desktop never offered ✨
// Explain on a conflicted file, and neither does the extension — its merge
// editor and Changes view have no Explain — so there was no door to give it,
// and it was deleted rather than kept as a rationale only its own test read.
//
// The renderer asks for a task in exactly one way, `streamTask` / `streamInto`
// in aiAssist.ts, with the task name as a literal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Tasks that still have a `case` but no door. Each of these once had a ✨
 * button; the ✨ actions now open a conversational tab instead (see
 * aiAssist.ts), and nothing sends these any more. Listed so the census can
 * hold the line for the NEXT one — whether to delete them is the owner's call.
 */
const KEPT_WITHOUT_A_DOOR: Record<string, string> = {
  explainDiff: "the ✨ Explain actions moved to chat tabs; pending a decision to delete",
  summarizeChanges: "the ✨ actions moved to chat tabs; pending a decision to delete",
  prDescription: "the ✨ actions moved to chat tabs; pending a decision to delete",
  reviewDiff: "the ✨ Review actions moved to chat tabs; pending a decision to delete",
  changelog: "the ✨ actions moved to chat tabs; pending a decision to delete",
  branchName: "the ✨ actions moved to chat tabs; pending a decision to delete",
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

async function taskNames(): Promise<string[]> {
  const ipc = await readFile(join(SRC, "shared/ipc.ts"), "utf8");
  const m = /export type AiTaskName =([^;]+);/.exec(ipc);
  assert.ok(m, "AiTaskName is still declared as a union of literals");
  return [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
}

async function sentByARenderer(): Promise<Set<string>> {
  const sent = new Set<string>();
  for (const file of await tsFiles(join(SRC, "renderer"))) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/\bstream(?:Into|Task)\(\s*"([A-Za-z]+)"/g)) sent.add(m[1]);
  }
  return sent;
}

test("every AI task the bridge answers has a door, or is named as kept without one", async () => {
  const names = await taskNames();
  const sent = await sentByARenderer();
  assert.ok(sent.size >= 2, `the scan found only ${sent.size} doors — it broke`);
  const doorless = names.filter((n) => !sent.has(n) && !(n in KEPT_WITHOUT_A_DOOR));
  assert.deepEqual(doorless, [], "tasks no control can ask for — give them a door or delete them");
});

test("the kept-without-a-door list has not gone stale", async () => {
  const names = new Set(await taskNames());
  const sent = await sentByARenderer();
  for (const n of Object.keys(KEPT_WITHOUT_A_DOOR)) {
    assert.ok(names.has(n), `${n} is no longer a task — drop it from the list`);
    assert.ok(!sent.has(n), `${n} has a door now — drop it from the list`);
  }
});

test("the bridge answers exactly the declared tasks", async () => {
  const bridge = await readFile(join(SRC, "main/aiBridge.ts"), "utf8");
  const start = bridge.indexOf("async runTask(");
  assert.ok(start >= 0);
  const body = bridge.slice(start, bridge.indexOf("\n  }\n", start));
  const cases = [...body.matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(cases, (await taskNames()).sort());
});
