// gitstudio.ai.provider's schema allows every value GitStudio writes to it.
//
// Connecting Claude Code, Codex or Gemini CLI in the AI panel writes
// provider = "cli" (GitBrain.setCliAgent), and the schema's enum did not have
// it: the Settings editor then flagged the user's own setting as "not an
// accepted value". The README table repeated the short list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, { enum?: string[]; enumDescriptions?: string[] }> } };
};
const provider = pkg.contributes.configuration.properties["gitstudio.ai.provider"];

/** The ProviderChoice union, read from the source that writes the setting. */
function choices(): string[] {
  const src = readFileSync(join(ROOT, "src", "ai", "gitBrain.ts"), "utf8");
  const union = /export type ProviderChoice =([^;]+);/.exec(src);
  assert.ok(union, "gitBrain.ts declares ProviderChoice");
  return [...union[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

test("every provider choice GitStudio can write is in the setting's enum, each described", () => {
  const all = choices();
  assert.ok(all.includes("cli"), "the local-agent choice exists");
  assert.deepEqual([...(provider.enum ?? [])].sort(), [...all].sort());
  assert.equal(provider.enumDescriptions?.length, provider.enum?.length);
});

test("the README's settings table lists the same values", () => {
  const row = readFileSync(join(ROOT, "README.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("| `gitstudio.ai.provider`"));
  assert.ok(row);
  for (const c of choices()) assert.ok(row.includes(`\`${c}\``), `${c} in ${row}`);
});
