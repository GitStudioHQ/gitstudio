// The AI actions are offered only while AI can run.
//
// VS Code's own commit box (scm/inputBox) carried GitStudio's ✨ "Generate
// Commit Message" whenever the repository was git — with AI off too, beside
// Copilot's identical sparkle, and clicking it only said AI was unavailable.
// Every menu entry of an action that runs a model is gated on
// gitstudio.ai.enabled, as the palette's already were.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { menus: Record<string, { command?: string; when?: string }[]> };
};

const RUNS_A_MODEL = [
  "gitstudio.ai.generateCommitMessage",
  "gitstudio.ai.explainDiff",
  "gitstudio.ai.summarizeChanges",
  "gitstudio.ai.reviewChanges",
];

test("every menu entry of an AI action is gated on gitstudio.ai.enabled", () => {
  const ungated: string[] = [];
  let seen = 0;
  for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
    for (const e of entries) {
      if (!e.command || !RUNS_A_MODEL.includes(e.command)) continue;
      seen++;
      if (!/\bgitstudio\.ai\.enabled\b/.test(e.when ?? "")) ungated.push(`${menu}: ${e.command} (${e.when ?? "always"})`);
    }
  }
  assert.ok(seen >= 5, `the census found the entries (${seen})`);
  assert.deepEqual(ungated, []);
});
