import { test } from "node:test";
import assert from "node:assert/strict";
import { knownModels } from "../src/catalog";

test("knownModels offers a preset's suggested model ids, and nothing for an unknown preset", () => {
  assert.ok(knownModels("openai").includes("gpt-4o"));
  assert.deepEqual(knownModels("lmstudio"), ["local-model"]);
  assert.deepEqual(knownModels("no-such-preset"), []);
});
