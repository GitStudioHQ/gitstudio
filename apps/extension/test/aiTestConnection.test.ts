// "Test connection" must not call a working connection broken. A reasoning
// model (Gemini, gpt-oss, the o-series) spends a tiny cap on hidden thinking
// and answers 200 with no text and a `length` stop — the endpoint, key and
// model all fine. The providers record that stop; the test reads it.
//
// AiFeatures imports `vscode`, so testConnection itself cannot run under plain
// tsx: the providers are driven over a fake fetch, and its use of them pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAiProvider } from "../src/ai/openAiProvider";
import { AnthropicProvider } from "../src/ai/anthropicProvider";

const answer = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("the OpenAI-compatible provider records why its last answer stopped", async () => {
  const p = new OpenAiProvider({
    getKey: async () => "k",
    config: () => ({ baseUrl: "https://api.example.com/v1", models: { fast: "m", mid: "", deep: "" } }),
    fetchImpl: answer({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
  });
  assert.equal(await p.complete({ prompt: "hi" }), null);
  assert.equal(p.lastStop, "length");
});

test("the Anthropic provider records why its last answer stopped", async () => {
  const p = new AnthropicProvider({
    getKey: async () => "k",
    hasKey: () => true,
    fetchImpl: answer({ content: [], stop_reason: "max_tokens" }),
  });
  assert.equal(await p.complete({ prompt: "hi" }), null);
  assert.equal(p.lastStop, "max_tokens");
});

test("a failed request leaves no stale stop reason behind", async () => {
  let reply: Response = new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
  const p = new OpenAiProvider({
    getKey: async () => undefined,
    config: () => ({ baseUrl: "https://api.example.com/v1", models: { fast: "m", mid: "", deep: "" } }),
    fetchImpl: (async () => reply) as unknown as typeof fetch,
  });
  await p.complete({ prompt: "hi" });
  reply = new Response("{}", { status: 404 });
  await p.complete({ prompt: "hi" });
  assert.equal(p.lastStop, undefined);
});

test("testConnection gives a reasoning model room, and counts a capped answer as connected", async () => {
  const src = await readFile(fileURLToPath(new URL("../src/ai/aiFeatures.ts", import.meta.url)), "utf8");
  const start = src.indexOf("async testConnection(");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  const cap = Number(/maxTokens:\s*(\d+)/.exec(body)?.[1]);
  assert.ok(cap >= 128, `the probe's cap (${cap}) leaves a thinking model room to answer`);
  assert.match(body, /provider\.lastStop === "length"/);
  assert.match(body, /provider\.lastStop === "max_tokens"/);
});
