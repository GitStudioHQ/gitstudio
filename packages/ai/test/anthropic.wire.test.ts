// The Anthropic provider over a fake `fetch`: the exact request it sends
// (endpoint, headers, the body built from GitStudio's flat message list), how
// it reads the non-streaming, streaming-text and streaming-chat responses, and
// what the caller sees when the key, the network, the server or the stream
// fails. No network — every response is built here from strings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, type AnthropicOptions } from "../src/providers/anthropic";
import { AiError, type ChatMessage } from "../src/types";

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Record<string, string>;
}

/** A fetch that answers each call with the next responder, recording every request. */
function scriptedFetch(responders: Array<() => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      init,
      body: JSON.parse(String(init.body ?? "{}")),
      headers: init.headers as Record<string, string>,
    });
    const r = responders[Math.min(i++, responders.length - 1)];
    return r();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * An SSE body from raw string chunks, optionally ending in a stream error. Pull-
 * based, one chunk per read, so the chunks before an error are really delivered
 * (erroring in `start` would discard everything still queued).
 */
function sse(chunks: string[], fail?: Error): () => Response {
  return () => {
    const enc = new TextEncoder();
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
          else if (fail) controller.error(fail);
          else controller.close();
        },
      }),
      { status: 200 },
    );
  };
}

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

function provider(fetchImpl?: typeof fetch, over: Partial<AnthropicOptions> = {}): AnthropicProvider {
  return new AnthropicProvider({
    baseUrl: "https://api.anthropic.com/",
    resolveModel: (tier) => (tier === "fast" ? "claude-fast" : "claude-mid"),
    getKey: () => "  sk-ant-123  ",
    label: "My Claude",
    fetchImpl,
    ...over,
  });
}

const user: ChatMessage[] = [{ role: "user", content: "hi" }];

const textEvent = (i: number, text: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":${i},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`;
const stopEvent = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

// ── request shape ────────────────────────────────────────────────────────────

test("anthropic identifies itself and reports its configured label", () => {
  const p = provider();
  assert.equal(p.id, "anthropic");
  assert.equal(p.supportsTools, true);
  assert.equal(p.label, "My Claude");
});

test("anthropic posts to /v1/messages with a trimmed key, the pinned API version and JSON content", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })]);
  await provider(fetchImpl).chat(user);
  assert.equal(seen.length, 1);
  // The trailing slash on the base URL does not produce a double slash.
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(seen[0].headers, {
    "x-api-key": "sk-ant-123",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });
});

test("anthropic accepts an async key getter", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  await provider(fetchImpl, { getKey: async () => "async-key" }).chat(user);
  assert.equal(seen[0].headers["x-api-key"], "async-key");
});

test("anthropic refuses a blank key before touching the network", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({})]);
  await assert.rejects(
    () => provider(fetchImpl, { getKey: () => "   " }).chat(user),
    (e: unknown) => e instanceof AiError && e.status === 401 && /No Anthropic API key/.test(e.message),
  );
  // The same refusal comes out of both streaming paths, unwrapped.
  await assert.rejects(() => provider(fetchImpl, { getKey: () => "" }).streamText(user, () => {}), /No Anthropic API key/);
  await assert.rejects(() => provider(fetchImpl, { getKey: () => undefined }).streamChat(user, () => {}), /No Anthropic API key/);
  assert.equal(seen.length, 0, "no request is sent without a key");
});

test("anthropic refuses to run without a model on every path", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({})]);
  const p = provider(fetchImpl, { resolveModel: () => undefined });
  await assert.rejects(() => p.chat(user), /No model configured/);
  await assert.rejects(() => p.streamText(user, () => {}), /No model configured/);
  await assert.rejects(() => p.streamChat(user, () => {}), /No model configured/);
  assert.equal(seen.length, 0);
});

test("anthropic maps the whole conversation onto Anthropic's content-block turns", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  await provider(fetchImpl).chat([
    { role: "system", content: "rule one" },
    { role: "system", content: "   " }, // blank system text is dropped
    { role: "system", content: "rule two" },
    { role: "user", content: "what changed?" },
    {
      role: "assistant",
      content: "looking",
      toolCalls: [{ id: "tu_1", name: "git_status", arguments: { all: true } }],
    },
    { role: "tool", toolCallId: "tu_1", name: "git_status", content: "1 file" },
    // An assistant turn that is only a tool call carries no empty text block.
    { role: "assistant", content: "  ", toolCalls: [{ id: "tu_2", name: "git_log", arguments: undefined as never }] },
    { role: "tool", toolCallId: "tu_2", name: "git_log", content: "abc  feat" },
    // An assistant turn with neither text nor tools becomes an empty string.
    { role: "assistant", content: "" },
  ]);
  const body = seen[0].body;
  // Both non-blank system parts are joined; not cacheable unless asked.
  assert.deepEqual(body.system, [{ type: "text", text: "rule one\n\nrule two" }]);
  assert.deepEqual(body.messages, [
    { role: "user", content: "what changed?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "tu_1", name: "git_status", input: { all: true } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "1 file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "git_log", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "abc  feat" }] },
    { role: "assistant", content: "" },
  ]);
});

test("anthropic omits `system` entirely when there is no system text", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  await provider(fetchImpl).chat([{ role: "system", content: "" }, ...user], { systemCacheable: true });
  assert.equal("system" in seen[0].body, false);
});

test("anthropic sizes max_tokens by tier unless the caller sets it, and passes temperature through", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  const p = provider(fetchImpl);
  await p.chat(user, { model: "fast" });
  await p.chat(user, { model: "deep" });
  await p.chat(user, { maxTokens: 77, temperature: 0 });
  assert.equal(seen[0].body.model, "claude-fast");
  assert.equal(seen[0].body.max_tokens, 512);
  assert.equal("temperature" in seen[0].body, false);
  assert.equal(seen[1].body.model, "claude-mid");
  assert.equal(seen[1].body.max_tokens, 1024);
  assert.equal(seen[2].body.max_tokens, 77);
  assert.equal(seen[2].body.temperature, 0, "a zero temperature is still sent");
  assert.equal("stream" in seen[0].body, false, "a plain chat is not a stream");
});

test("anthropic prefers an explicit model id over the tier", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  await provider(fetchImpl).chat(user, { model: "fast", modelId: "claude-exact" });
  assert.equal(seen[0].body.model, "claude-exact");
});

test("anthropic sends tools as input_schema and maps tool_choice", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  const p = provider(fetchImpl);
  const tools = [{ name: "git_log", description: "history", parameters: { type: "object" as const } }];
  await p.chat(user, { tools });
  await p.chat(user, { tools, toolChoice: "required" });
  await p.chat(user, { tools, toolChoice: "none" });
  await p.chat(user, { tools, toolChoice: "auto" });
  await p.chat(user, { tools: [], toolChoice: "required" });
  assert.deepEqual(seen[0].body.tools, [{ name: "git_log", description: "history", input_schema: { type: "object" } }]);
  assert.equal("tool_choice" in seen[0].body, false);
  assert.deepEqual(seen[1].body.tool_choice, { type: "any" });
  assert.deepEqual(seen[2].body.tool_choice, { type: "none" });
  assert.equal("tool_choice" in seen[3].body, false, "auto is Anthropic's default, so it is not sent");
  // No tools: neither `tools` nor a dangling tool_choice.
  assert.equal("tools" in seen[4].body, false);
  assert.equal("tool_choice" in seen[4].body, false);
});

test("anthropic forwards the caller's abort signal to fetch", async () => {
  const { fetchImpl, seen } = scriptedFetch([json({ content: [], stop_reason: "end_turn" })]);
  const ac = new AbortController();
  await provider(fetchImpl).chat(user, { signal: ac.signal });
  assert.equal(seen[0].init.signal, ac.signal);
});

// ── chat response ────────────────────────────────────────────────────────────

test("anthropic chat joins text blocks, reads usage including cache tokens", async () => {
  const { fetchImpl } = scriptedFetch([
    json({
      content: [
        { type: "text", text: "Hello, " },
        { type: "text" }, // a text block with no text is skipped
        { type: "text", text: "world" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 },
    }),
  ]);
  const r = await provider(fetchImpl).chat(user);
  assert.equal(r.text, "Hello, world");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.stopReason, "stop");
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 9 });
});

test("anthropic chat tolerates a response with no content, usage or stop reason", async () => {
  const { fetchImpl } = scriptedFetch([json({})]);
  const r = await provider(fetchImpl).chat(user);
  assert.deepEqual(r, { text: "", toolCalls: [], stopReason: "stop", usage: undefined });
});

test("anthropic chat fills defaults for a tool_use block missing id, name or input", async () => {
  const { fetchImpl } = scriptedFetch([json({ content: [{ type: "tool_use" }], stop_reason: "tool_use" })]);
  const r = await provider(fetchImpl).chat(user);
  assert.deepEqual(r.toolCalls, [{ id: "", name: "", arguments: {} }]);
  assert.equal(r.stopReason, "tool_calls");
});

test("anthropic maps every stop reason onto GitStudio's", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["end_turn", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["refusal", "refusal"],
    ["pause_turn", "unknown"],
    [undefined, "stop"],
  ];
  for (const [wire, mapped] of cases) {
    const { fetchImpl } = scriptedFetch([json({ content: [], stop_reason: wire })]);
    const r = await provider(fetchImpl).chat(user);
    assert.equal(r.stopReason, mapped, `${wire} -> ${mapped}`);
  }
});

// ── HTTP + transport errors ──────────────────────────────────────────────────

test("anthropic turns HTTP failures into friendly, correctly-flagged errors", async () => {
  const cases: Array<[number, RegExp, boolean]> = [
    [401, /rejected the API key/, false],
    [429, /rate limit/, true],
    [529, /overloaded/, true],
    [500, /request failed \(HTTP 500\)/, true],
    [400, /request failed \(HTTP 400\)/, false],
  ];
  for (const [status, msg, retryable] of cases) {
    for (const call of ["chat", "streamText", "streamChat"] as const) {
      const { fetchImpl } = scriptedFetch([() => new Response("err", { status })]);
      const p = provider(fetchImpl);
      const run =
        call === "chat" ? () => p.chat(user) : call === "streamText" ? () => p.streamText(user, () => {}) : () => p.streamChat(user, () => {});
      await assert.rejects(run, (e: unknown) => {
        assert.ok(e instanceof AiError, `${call} ${status} is an AiError`);
        assert.match(e.message, msg);
        assert.equal(e.status, status);
        assert.equal(e.retryable, retryable, `${call} ${status} retryable`);
        return true;
      });
    }
  }
});

test("anthropic reports a network failure as retryable", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const p = provider(fetchImpl);
  for (const run of [() => p.chat(user), () => p.streamText(user, () => {}), () => p.streamChat(user, () => {})]) {
    await assert.rejects(run, (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.match(e.message, /Couldn't reach Anthropic/);
      assert.equal(e.retryable, true);
      return true;
    });
  }
});

test("anthropic treats a cancelled request as cancellation, not failure", async () => {
  const fetchImpl = (async () => {
    throw abortError();
  }) as unknown as typeof fetch;
  const p = provider(fetchImpl);
  // chat has nothing to return, so it says so plainly…
  await assert.rejects(() => p.chat(user), (e: unknown) => e instanceof AiError && e.message === "Request cancelled." && !e.retryable);
  // …while the streaming paths quietly resolve empty.
  assert.equal(await p.streamText(user, () => {}), null);
  assert.deepEqual(await p.streamChat(user, () => {}), { text: "", toolCalls: [], stopReason: "stop" });
});

// ── streamText ───────────────────────────────────────────────────────────────

test("anthropic streamText requests a stream and emits each text delta in order", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    sse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      textEvent(0, "  Hel"),
      // An event split across two network chunks is reassembled.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,',
      '"delta":{"type":"text_delta","text":"lo  "}}\n\n',
      stopEvent,
    ]),
  ]);
  const deltas: string[] = [];
  const text = await provider(fetchImpl).streamText(user, (d) => deltas.push(d));
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual(deltas, ["  Hel", "lo  "]);
  assert.equal(text, "Hello", "the assembled text is trimmed");
});

test("anthropic streamText stops reading at message_stop", async () => {
  const { fetchImpl } = scriptedFetch([sse([textEvent(0, "done"), stopEvent, textEvent(0, " IGNORED")])]);
  const deltas: string[] = [];
  const text = await provider(fetchImpl).streamText(user, (d) => deltas.push(d));
  assert.equal(text, "done");
  assert.deepEqual(deltas, ["done"]);
});

test("anthropic streamText keeps what arrived when the server closes without message_stop", async () => {
  const { fetchImpl } = scriptedFetch([sse([textEvent(0, "cut "), textEvent(0, "short")])]);
  assert.equal(await provider(fetchImpl).streamText(user, () => {}), "cut short");
});

test("anthropic streamText returns null for a whitespace-only stream", async () => {
  const { fetchImpl } = scriptedFetch([sse([textEvent(0, "   "), stopEvent])]);
  assert.equal(await provider(fetchImpl).streamText(user, () => {}), null);
});

test("anthropic streamText falls back to one chat turn when the response has no body", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    () => new Response(null, { status: 200 }),
    json({ content: [{ type: "text", text: "whole answer" }], stop_reason: "end_turn" }),
  ]);
  const deltas: string[] = [];
  const text = await provider(fetchImpl).streamText(user, (d) => deltas.push(d));
  assert.equal(text, "whole answer");
  assert.deepEqual(deltas, ["whole answer"], "the fallback text is delivered as one delta");
  assert.equal(seen.length, 2);
  assert.equal(seen[1].body.stream, undefined, "the fallback is a non-streaming request");
});

test("anthropic streamText's no-body fallback yields null for an empty answer", async () => {
  const { fetchImpl } = scriptedFetch([() => new Response(null, { status: 200 }), json({ content: [] })]);
  const deltas: string[] = [];
  assert.equal(await provider(fetchImpl).streamText(user, (d) => deltas.push(d)), null);
  assert.deepEqual(deltas, []);
});

test("anthropic streamText surfaces a broken stream as a retryable error", async () => {
  const { fetchImpl } = scriptedFetch([sse([textEvent(0, "partial")], new Error("socket hang up"))]);
  await assert.rejects(
    () => provider(fetchImpl).streamText(user, () => {}),
    (e: unknown) => e instanceof AiError && /Stream from Anthropic failed/.test(e.message) && e.retryable,
  );
});

test("anthropic streamText keeps the text received before a cancellation", async () => {
  const { fetchImpl } = scriptedFetch([sse([textEvent(0, "partial answer")], abortError())]);
  assert.equal(await provider(fetchImpl).streamText(user, () => {}), "partial answer");
});

// ── streamChat ───────────────────────────────────────────────────────────────

test("anthropic streamChat assembles several tool_use blocks by index, even interleaved", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    sse([
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_a","name":"git_status"}}\r\n\r\n',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_b","name":"git_log"}}\n\n',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"lim"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}\n\n',
      // A split line across chunks.
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_',
      'delta","partial_json":"it\\":3}"}}\n\n',
      stopEvent,
    ]),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.equal(seen[0].body.stream, true);
  assert.equal(r.text, "");
  assert.deepEqual(r.toolCalls, [
    { id: "tu_a", name: "git_status", arguments: {} },
    { id: "tu_b", name: "git_log", arguments: { limit: 3 } },
  ]);
  // No message_delta stop reason arrived, so the presence of tool calls decides.
  assert.equal(r.stopReason, "tool_calls");
});

test("anthropic streamChat ignores malformed events, non-data lines and deltas for unknown blocks", async () => {
  const { fetchImpl } = scriptedFetch([
    sse([
      ": keep-alive comment\n",
      "event: ping\n",
      "data: {not json\n\n",
      'data: {"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":42}}\n\n',
      'data: {"type":"content_block_delta"}\n\n',
      'data: {"type":"message_delta","delta":{}}\n\n',
    ]),
  ]);
  const deltas: string[] = [];
  const r = await provider(fetchImpl).streamChat(user, (d) => deltas.push(d));
  assert.deepEqual(deltas, ["ok"]);
  assert.equal(r.text, "ok");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.stopReason, "stop", "no tools and no stop reason means a normal end");
});

test("anthropic streamChat reports the stream's own stop reason", async () => {
  const { fetchImpl } = scriptedFetch([
    sse([textEvent(0, "cut off"), 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n']),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.equal(r.stopReason, "length");
});

test("anthropic streamChat drops nameless tool blocks and recovers bad tool JSON as empty args", async () => {
  const { fetchImpl } = scriptedFetch([
    sse([
      'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"git_diff"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{broken"}}\n\n',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t2","name":"git_show"}}\n\n',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"5"}}\n\n',
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"t3","name":"git_log"}}\n\n',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"null"}}\n\n',
    ]),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.deepEqual(
    r.toolCalls.map((c) => [c.name, c.arguments]),
    [
      ["git_diff", {}],
      // Valid JSON that is not an object is not usable as arguments either.
      ["git_show", {}],
      ["git_log", {}],
    ],
  );
});

test("anthropic streamChat falls back to a plain chat when the response has no body", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    () => new Response(null, { status: 200 }),
    json({ content: [{ type: "tool_use", id: "x", name: "git_status", input: {} }], stop_reason: "tool_use" }),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.equal(seen.length, 2);
  assert.deepEqual(r.toolCalls, [{ id: "x", name: "git_status", arguments: {} }]);
  assert.equal(r.stopReason, "tool_calls");
});

test("anthropic streamChat surfaces a broken stream, but keeps partial text on cancellation", async () => {
  const broken = scriptedFetch([sse([textEvent(0, "x")], new Error("reset"))]);
  await assert.rejects(() => provider(broken.fetchImpl).streamChat(user, () => {}), /Stream from Anthropic failed/);

  const cancelled = scriptedFetch([sse(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"so far"}}\n'], abortError())]);
  const r = await provider(cancelled.fetchImpl).streamChat(user, () => {});
  assert.equal(r.text, "so far");
  assert.equal(r.stopReason, "stop");
});
