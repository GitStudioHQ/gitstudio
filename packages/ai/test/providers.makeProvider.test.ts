// makeProvider turns a saved Connection into a live Provider: the right wire,
// the connection's base URL and key getter, a tier→model resolver drawn from the
// connection's model mapping, and a label naming the model in use. Driven
// through a fake fetch so the request proves what was wired up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProvider, AnthropicProvider, OpenAiCompatProvider } from "../src/providers/index";
import { connectionFromPreset, type Connection } from "../src/connections";
import * as ai from "../src/index";

function capturingFetch(body: unknown) {
  const seen: Array<{ url: string; body: Record<string, any>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function conn(preset: string, over: Partial<Connection> = {}): Connection {
  return { ...connectionFromPreset(preset, "id-1"), ...over };
}

test("an anthropic connection becomes an AnthropicProvider on its base URL and key", async () => {
  const c = conn("anthropic", { label: "Work Claude", baseUrl: "https://proxy.example.com", models: { fast: "h", mid: "s", deep: "o" } });
  const { fetchImpl, seen } = capturingFetch({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
  const p = makeProvider(c, () => "sk-ant", fetchImpl);
  assert.ok(p instanceof AnthropicProvider);
  assert.equal(p.label, "Work Claude · s");
  await p.chat([{ role: "user", content: "x" }], { model: "deep" });
  assert.equal(seen[0].url, "https://proxy.example.com/v1/messages");
  assert.equal(seen[0].headers["x-api-key"], "sk-ant");
  assert.equal(seen[0].body.model, "o", "the deep tier resolves through the connection");
});

test("any other wire becomes an OpenAI-compatible provider", async () => {
  const c = conn("ollama", { label: "Local", baseUrl: "http://localhost:11434/v1", models: { fast: "", mid: "llama3.2", deep: "" } });
  const { fetchImpl, seen } = capturingFetch({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  const p = makeProvider(c, () => undefined, fetchImpl);
  assert.ok(p instanceof OpenAiCompatProvider);
  // No tier given: the resolver uses the mid tier; missing tiers fall back.
  await p.chat([{ role: "user", content: "x" }]);
  await p.chat([{ role: "user", content: "x" }], { model: "fast" });
  assert.equal(seen[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(seen[0].body.model, "llama3.2");
  assert.equal(seen[1].body.model, "llama3.2");
  assert.equal(seen[0].headers.Authorization, undefined);
});

test("the label falls back across tiers, then to a generic word", () => {
  const onlyDeep = makeProvider(conn("openai", { label: "O", models: { fast: "", mid: "", deep: "big" } }), () => "k");
  assert.equal(onlyDeep.label, "O · big");
  const onlyFast = makeProvider(conn("openai", { label: "O", models: { fast: "small", mid: "", deep: "" } }), () => "k");
  assert.equal(onlyFast.label, "O · small");
  const none = makeProvider(conn("openai", { label: "O", models: { fast: "", mid: "", deep: "" } }), () => "k");
  assert.equal(none.label, "O · model");
});

test("a connection with no model refuses to send a request", async () => {
  const { fetchImpl, seen } = capturingFetch({});
  const p = makeProvider(conn("openai", { models: { fast: "", mid: "", deep: "" } }), () => "k", fetchImpl);
  await assert.rejects(() => p.chat([{ role: "user", content: "x" }]), /No model configured/);
  assert.equal(seen.length, 0);
});

test("a CLI connection is refused: the host builds those", () => {
  assert.throws(() => makeProvider(conn("claude-code"), () => undefined), /CLI connections must be built by the host/);
});

test("the package entry point exposes the providers, tasks, tools and agent", () => {
  for (const name of [
    "makeProvider",
    "AnthropicProvider",
    "OpenAiCompatProvider",
    "runAgent",
    "selectTools",
    "toolByName",
    "generateCommitMessage",
    "reviewDiff",
    "pickConnection",
    "presetById",
    "AiError",
  ]) {
    assert.equal(typeof (ai as Record<string, unknown>)[name], "function", `${name} is exported`);
  }
  assert.ok(Array.isArray(ai.GIT_TOOLS) && ai.GIT_TOOLS.length > 0);
});
