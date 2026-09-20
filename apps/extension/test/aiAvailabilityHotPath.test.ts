import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The Changes view asks "is AI available?" on every state push, and a state
// push is the onDidChange firehose — many a second during a rebase or fetch.
// GitBrain.isEnabled() is a real probe: a vscode.lm model query, a key-file
// stat, or a `which` spawn depending on the provider. It ran per push for a
// value that only moves when a setting, a key or the model list changes, and
// every one of those already calls refreshEnabled().
//
// GitBrain and the wiring both import `vscode`, so this cannot be driven under
// plain tsx. What CAN be pinned is the mechanism: the view reads the cached
// answer, and the one availability change no setting or key announces — chat
// models arriving after activation — re-probes it, so the cache is not stale.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

test("the Changes view reads the cached AI availability, not the probe", async () => {
  const text = await readFile(`${SRC}/extension.ts`, "utf8");
  const start = text.indexOf("new CommitViewProvider(");
  assert.ok(start > 0, "CommitViewProvider is constructed in extension.ts");
  // The generator hooks are the last argument; `draft:` closes the block.
  const end = text.indexOf("draft:", start);
  assert.ok(end > start, "the generator is wired inline");
  const block = text.slice(start, end);
  assert.match(block, /isEnabled:\s*\(\)\s*=>\s*brain\.isEnabledCached\(\)/);
  assert.doesNotMatch(block, /brain\.isEnabled\(\)/);
});

test("chat models arriving late re-probe, so the cached answer cannot go stale", async () => {
  const text = await readFile(`${SRC}/ai/gitBrain.ts`, "utf8");
  assert.match(text, /onDidChangeChatModels\(\(\)\s*=>\s*void this\.refreshEnabled\(\)\)/);
});
