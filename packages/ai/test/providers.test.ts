import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatProvider } from "../src/providers/openaiCompat";
import { AnthropicProvider } from "../src/providers/anthropic";
import type { ChatMessage } from "../src/types";

/** Build a stub `fetch` that returns one JSON body and records the request. */
function jsonFetch(body: unknown, capture?: (req: { url: string; init: RequestInit }) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Build a stub `fetch` returning an SSE stream from the given raw chunks. */
function sseFetch(chunks: string[]): typeof fetch {
  return (async () => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

test("openai-compat chat parses content + tool_calls and maps stop reason", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const provider = new OpenAiCompatProvider({
    baseUrl: "https://api.example.com/v1",
    resolveModel: () => "gpt-test",
    getKey: () => "sk-test",
    label: "X",
    fetchImpl: jsonFetch(
      {
        choices: [
          {
            message: {
              content: "working on it",
              tool_calls: [
                { id: "call_1", function: { name: "git_status", arguments: '{"all":true}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      (r) => (seen = r),
    ),
  });
  const r = await provider.chat(msgs, { tools: [{ name: "git_status", description: "d", parameters: { type: "object" } }] });
  assert.equal(r.text, "working on it");
  assert.equal(r.stopReason, "tool_calls");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "git_status");
  assert.deepEqual(r.toolCalls[0].arguments, { all: true });
  assert.equal(r.usage?.inputTokens, 10);
  // Endpoint + auth header are built correctly.
  assert.equal(seen?.url, "https://api.example.com/v1/chat/completions");
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, "Bearer sk-test");
});

test("openai-compat omits Authorization for a keyless local server", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const provider = new OpenAiCompatProvider({
    baseUrl: "http://localhost:11434/v1",
    resolveModel: () => "llama3.2",
    getKey: () => undefined,
    label: "local",
    fetchImpl: jsonFetch({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }, (r) => (seen = r)),
  });
  const r = await provider.chat(msgs);
  assert.equal(r.text, "ok");
  assert.equal(r.stopReason, "stop");
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, undefined);
});

test("openai-compat streamText assembles SSE content deltas", async () => {
  const provider = new OpenAiCompatProvider({
    baseUrl: "https://api.example.com/v1",
    resolveModel: () => "gpt-test",
    getKey: () => "k",
    label: "X",
    fetchImpl: sseFetch([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  const out: string[] = [];
  const text = await provider.streamText(msgs, (d) => out.push(d));
  assert.equal(text, "Hello");
  assert.deepEqual(out, ["Hel", "lo"]);
});

test("openai-compat surfaces a friendly error on 401", async () => {
  const provider = new OpenAiCompatProvider({
    baseUrl: "https://api.example.com/v1",
    resolveModel: () => "gpt-test",
    getKey: () => "bad",
    label: "X",
    fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provider.chat(msgs), /rejected the API key/);
});

test("anthropic chat parses text + tool_use blocks and lifts system text", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.com",
    resolveModel: () => "claude-test",
    getKey: () => "sk-ant",
    label: "claude",
    fetchImpl: jsonFetch(
      {
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "tu_1", name: "git_log", input: { limit: 5 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 7, output_tokens: 2 },
      },
      (r) => (seen = r),
    ),
  });
  const r = await provider.chat(
    [
      { role: "system", content: "be terse" },
      { role: "user", content: "history?" },
    ],
    { tools: [{ name: "git_log", description: "d", parameters: { type: "object" } }], systemCacheable: true },
  );
  assert.equal(r.text, "let me check");
  assert.equal(r.stopReason, "tool_calls");
  assert.equal(r.toolCalls[0].name, "git_log");
  assert.deepEqual(r.toolCalls[0].arguments, { limit: 5 });
  // System text was lifted into the top-level `system` field as a cacheable block.
  const body = JSON.parse((seen?.init.body as string) ?? "{}");
  assert.equal(body.system[0].text, "be terse");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(seen?.url, "https://api.anthropic.com/v1/messages");
  assert.equal((seen?.init.headers as Record<string, string>)["x-api-key"], "sk-ant");
});

test("anthropic throws a clear error when no key is set", async () => {
  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.com",
    resolveModel: () => "claude-test",
    getKey: () => undefined,
    label: "claude",
  });
  await assert.rejects(() => provider.chat(msgs), /No Anthropic API key/);
});

test("openai-compat streamChat streams text + assembles tool_calls from SSE", async () => {
  const provider = new OpenAiCompatProvider({
    baseUrl: "https://api.example.com/v1",
    resolveModel: () => "gpt-test",
    getKey: () => "k",
    label: "X",
    fetchImpl: sseFetch([
      'data: {"choices":[{"delta":{"content":"Let me "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"check."}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"git_status","arguments":"{\\"al"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"l\\":true}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  const out: string[] = [];
  const r = await provider.streamChat(msgs, (d) => out.push(d));
  assert.equal(out.join(""), "Let me check.");
  assert.equal(r.text, "Let me check.");
  assert.equal(r.stopReason, "tool_calls");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "git_status");
  assert.deepEqual(r.toolCalls[0].arguments, { all: true });
});

test("anthropic streamChat streams text + assembles tool_use from SSE", async () => {
  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.com",
    resolveModel: () => "claude-test",
    getKey: () => "sk-ant",
    label: "claude",
    fetchImpl: sseFetch([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"git_log"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"limit\\":5}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),
  });
  const out: string[] = [];
  const r = await provider.streamChat(msgs, (d) => out.push(d));
  assert.equal(out.join(""), "Checking");
  assert.equal(r.text, "Checking");
  assert.equal(r.stopReason, "tool_calls");
  assert.equal(r.toolCalls[0].name, "git_log");
  assert.deepEqual(r.toolCalls[0].arguments, { limit: 5 });
});
