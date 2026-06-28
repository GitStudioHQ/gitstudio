import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, presetById } from "../src/catalog";
import {
  connectionFromPreset,
  isConnectionUsable,
  resolveModelId,
  pickConnection,
  type AiSettings,
  type Connection,
} from "../src/connections";

test("every preset has a wire, base config, and three model tiers", () => {
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id && p.label, `${p.id} has id+label`);
    assert.ok(p.wire === "anthropic" || p.wire === "openai-compat", `${p.id} wire`);
    assert.ok("fast" in p.models && "mid" in p.models && "deep" in p.models, `${p.id} tiers`);
    // Local presets never require a key; remote presets do (custom is the exception).
    if (p.local) assert.equal(p.needsKey, false, `${p.id} local => no key`);
  }
});

test("presetById falls back to custom for unknown ids", () => {
  assert.equal(presetById("nope").id, "custom");
  assert.equal(presetById("anthropic").id, "anthropic");
});

test("connectionFromPreset copies preset defaults and the supplied id", () => {
  const c = connectionFromPreset("anthropic", "abc");
  assert.equal(c.id, "abc");
  assert.equal(c.wire, "anthropic");
  assert.equal(c.needsKey, true);
  assert.equal(c.models.deep, "claude-opus-4-8");
  // Mutating the copy must not touch the catalog.
  c.models.deep = "x";
  assert.equal(presetById("anthropic").models.deep, "claude-opus-4-8");
});

test("isConnectionUsable requires base URL, a model, and (for remote) a key", () => {
  const remote = connectionFromPreset("openai", "1");
  assert.equal(isConnectionUsable(remote, false), false, "remote needs a key");
  assert.equal(isConnectionUsable(remote, true), true, "remote with key ok");

  const local = connectionFromPreset("ollama", "2");
  assert.equal(isConnectionUsable(local, false), true, "local needs no key");

  const noModel: Connection = { ...remote, models: { fast: "", mid: "", deep: "" } };
  assert.equal(isConnectionUsable(noModel, true), false, "no model => unusable");

  const noUrl: Connection = { ...remote, baseUrl: "  " };
  assert.equal(isConnectionUsable(noUrl, true), false, "no base url => unusable");
});

test("resolveModelId falls back across tiers", () => {
  const c = connectionFromPreset("custom", "3");
  c.models = { fast: "", mid: "m", deep: "" };
  assert.equal(resolveModelId(c, "fast"), "m", "fast falls forward to mid");
  assert.equal(resolveModelId(c, "deep"), "m", "deep falls back to mid");
  assert.equal(resolveModelId(c, "mid"), "m");
  c.models = { fast: "", mid: "", deep: "" };
  assert.equal(resolveModelId(c, "mid"), undefined, "no models => undefined");
});

test("pickConnection honors task override, then default, then first", () => {
  const a = connectionFromPreset("anthropic", "a");
  const b = connectionFromPreset("ollama", "b");
  const settings: AiSettings = {
    connections: [a, b],
    defaultId: "b",
    taskDefaults: { commit: "a" },
  };
  assert.equal(pickConnection(settings, "commit")?.id, "a", "task override wins");
  assert.equal(pickConnection(settings, "explain")?.id, "b", "falls to default");
  assert.equal(pickConnection({ connections: [a, b] })?.id, "a", "falls to first");
  assert.equal(pickConnection({ connections: [] }), undefined, "none => undefined");
});
