// The OpenAI-compatible provider (OpenAI, Azure, OpenRouter, Ollama, LM Studio…)
// over a fake `fetch`: the endpoint it builds from the base URL, the auth header,
// the request body built from GitStudio's messages, the three response paths,
// and every failure the caller has to word for the user. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatProvider, type OpenAiCompatOptions } from "../src/providers/openaiCompat";
import { AiError, type ChatMessage } from "../src/types";

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Record<string, string>;
}

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
    return responders[Math.min(i++, responders.length - 1)]();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Pull-based SSE body: one chunk per read, then close or error. */
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
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function provider(fetchImpl?: typeof fetch, over: Partial<OpenAiCompatOptions> = {}): OpenAiCompatProvider {
  return new OpenAiCompatProvider({
    baseUrl: "https://api.example.com/v1",
    resolveModel: (tier) => (tier === "fast" ? "m-fast" : "m-mid"),
    getKey: () => " sk-1 ",
    label: "Example",
    fetchImpl,
    ...over,
  });
}

const user: ChatMessage[] = [{ role: "user", content: "hi" }];
const ok = json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

// ── endpoint + headers ───────────────────────────────────────────────────────

test("openai-compat identifies itself and reports its label", () => {
  const p = provider();
  assert.equal(p.id, "openai-compat");
  assert.equal(p.supportsTools, true);
  assert.equal(p.label, "Example");
});

test("openai-compat appends /chat/completions, trimming trailing slashes", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl, { baseUrl: "http://localhost:1234/v1///" }).chat(user);
  assert.equal(seen[0].url, "http://localhost:1234/v1/chat/completions");
  assert.equal(seen[0].init.method, "POST");
});

test("openai-compat keeps an Azure api-version query after the path", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl, {
    baseUrl: "https://res.openai.azure.com/openai/deployments/gpt?api-version=2024-06-01",
  }).chat(user);
  assert.equal(seen[0].url, "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-06-01");
});

// The trailing-slash trim used to run on the whole URL, query included, so an
// Azure base URL whose path ends in "/" before the query
// ("…/deployments/gpt/?api-version=…") produced "…/gpt//chat/completions".
test("openai-compat trims a slash that sits before an Azure query string", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl, {
    baseUrl: "https://res.openai.azure.com/openai/deployments/gpt/?api-version=2024-06-01",
  }).chat(user);
  assert.equal(seen[0].url, "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-06-01");
});

test("openai-compat sends a trimmed Bearer key and JSON content type", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl).chat(user);
  assert.deepEqual(seen[0].headers, { "Content-Type": "application/json", Authorization: "Bearer sk-1" });
});

test("openai-compat treats a blank or async-missing key as keyless", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl, { getKey: () => "   " }).chat(user);
  await provider(fetchImpl, { getKey: async () => undefined }).chat(user);
  await provider(fetchImpl, { getKey: async () => "async-key" }).chat(user);
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[1].headers.Authorization, undefined);
  assert.equal(seen[2].headers.Authorization, "Bearer async-key");
});

test("openai-compat refuses to run without a model on every path", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  const p = provider(fetchImpl, { resolveModel: () => undefined });
  await assert.rejects(() => p.chat(user), /No model configured/);
  await assert.rejects(() => p.streamText(user, () => {}), /No model configured/);
  await assert.rejects(() => p.streamChat(user, () => {}), /No model configured/);
  assert.equal(seen.length, 0);
});

// ── request body ─────────────────────────────────────────────────────────────

test("openai-compat maps messages, tool calls and tool results onto the wire", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  await provider(fetchImpl).chat([
    { role: "system", content: "be terse" },
    { role: "user", content: "status?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "git_status", arguments: { all: true } }] },
    { role: "tool", toolCallId: "c1", name: "git_status", content: "clean" },
    { role: "assistant", content: "thinking", toolCalls: [{ id: "c2", name: "git_log", arguments: undefined as never }] },
    { role: "assistant", content: "It's clean.", toolCalls: [] },
  ]);
  assert.deepEqual(seen[0].body.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "status?" },
    {
      role: "assistant",
      content: null, // an empty text alongside tool calls is sent as null
      tool_calls: [{ id: "c1", type: "function", function: { name: "git_status", arguments: '{"all":true}' } }],
    },
    { role: "tool", content: "clean", tool_call_id: "c1", name: "git_status" },
    {
      role: "assistant",
      content: "thinking",
      tool_calls: [{ id: "c2", type: "function", function: { name: "git_log", arguments: "{}" } }],
    },
    { role: "assistant", content: "It's clean." },
  ]);
});

test("openai-compat sizes max_tokens by tier, honours overrides and temperature", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  const p = provider(fetchImpl);
  await p.chat(user, { model: "fast" });
  await p.chat(user, { model: "deep" });
  await p.chat(user, { maxTokens: 9, temperature: 0.2, modelId: "exact-model" });
  assert.equal(seen[0].body.model, "m-fast");
  assert.equal(seen[0].body.max_tokens, 512);
  assert.equal("temperature" in seen[0].body, false);
  assert.equal("stream" in seen[0].body, false);
  assert.equal(seen[1].body.model, "m-mid");
  assert.equal(seen[1].body.max_tokens, 1024);
  assert.equal(seen[2].body.model, "exact-model");
  assert.equal(seen[2].body.max_tokens, 9);
  assert.equal(seen[2].body.temperature, 0.2);
});

test("openai-compat sends tools as functions and maps tool_choice", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  const p = provider(fetchImpl);
  const tools = [{ name: "git_diff", description: "diff", parameters: { type: "object" as const } }];
  await p.chat(user, { tools });
  await p.chat(user, { tools, toolChoice: "auto" });
  await p.chat(user, { tools, toolChoice: "required" });
  await p.chat(user, { tools, toolChoice: "none" });
  await p.chat(user, { tools: [], toolChoice: "required" });
  assert.deepEqual(seen[0].body.tools, [
    { type: "function", function: { name: "git_diff", description: "diff", parameters: { type: "object" } } },
  ]);
  assert.equal("tool_choice" in seen[0].body, false);
  assert.equal("tool_choice" in seen[1].body, false);
  assert.equal(seen[2].body.tool_choice, "required");
  assert.equal(seen[3].body.tool_choice, "none");
  assert.equal("tools" in seen[4].body, false);
  assert.equal("tool_choice" in seen[4].body, false);
});

test("openai-compat forwards the abort signal", async () => {
  const { fetchImpl, seen } = scriptedFetch([ok]);
  const ac = new AbortController();
  await provider(fetchImpl).chat(user, { signal: ac.signal });
  assert.equal(seen[0].init.signal, ac.signal);
});

// ── chat response ────────────────────────────────────────────────────────────

test("openai-compat chat tolerates an empty envelope", async () => {
  const { fetchImpl } = scriptedFetch([json({})]);
  assert.deepEqual(await provider(fetchImpl).chat(user), { text: "", toolCalls: [], stopReason: "stop", usage: undefined });
});

test("openai-compat chat treats null content as no text and recovers bad tool arguments", async () => {
  const { fetchImpl } = scriptedFetch([
    json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "a", function: { name: "git_show", arguments: "{bad json" } },
              { id: "b", function: { name: "git_log", arguments: "   " } },
              { id: "c", function: { name: "git_diff", arguments: "7" } },
              { id: "d" },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3 },
    }),
  ]);
  const r = await provider(fetchImpl).chat(user);
  assert.equal(r.text, "");
  assert.deepEqual(r.toolCalls, [
    { id: "a", name: "git_show", arguments: {} },
    { id: "b", name: "git_log", arguments: {} },
    { id: "c", name: "git_diff", arguments: {} },
    { id: "d", name: "", arguments: {} },
  ]);
  // Tool calls win over a finish_reason that says otherwise.
  assert.equal(r.stopReason, "tool_calls");
  assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: undefined });
});

test("openai-compat maps finish reasons onto GitStudio's", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "refusal"],
    ["tool_calls", "tool_calls"],
    ["function_call", "unknown"],
    [undefined, "stop"],
  ];
  for (const [wire, mapped] of cases) {
    const { fetchImpl } = scriptedFetch([json({ choices: [{ message: { content: "x" }, finish_reason: wire }] })]);
    assert.equal((await provider(fetchImpl).chat(user)).stopReason, mapped, `${wire} -> ${mapped}`);
  }
});

// ── errors ───────────────────────────────────────────────────────────────────

test("openai-compat words HTTP failures with the host and flags retryable ones", async () => {
  const cases: Array<[number, RegExp, boolean]> = [
    [401, /^api\.example\.com rejected the API key \(HTTP 401\)/, false],
    [403, /rejected the API key \(HTTP 403\)/, false],
    [404, /returned 404 — check the base URL and model id/, false],
    [429, /rate limit hit/, true],
    [502, /request failed \(HTTP 502\)/, true],
    [422, /request failed \(HTTP 422\)/, false],
  ];
  for (const [status, msg, retryable] of cases) {
    for (const call of ["chat", "streamText", "streamChat"] as const) {
      const { fetchImpl } = scriptedFetch([() => new Response("x", { status })]);
      const p = provider(fetchImpl);
      const run =
        call === "chat" ? () => p.chat(user) : call === "streamText" ? () => p.streamText(user, () => {}) : () => p.streamChat(user, () => {});
      await assert.rejects(run, (e: unknown) => {
        assert.ok(e instanceof AiError);
        assert.match(e.message, msg);
        assert.equal(e.status, status);
        assert.equal(e.retryable, retryable, `${call} ${status}`);
        return true;
      });
    }
  }
});

test("openai-compat names the unreachable host, or the raw base URL when it isn't a URL", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const p = provider(fetchImpl, { baseUrl: "http://localhost:11434/v1" });
  for (const run of [() => p.chat(user), () => p.streamText(user, () => {}), () => p.streamChat(user, () => {})]) {
    await assert.rejects(run, (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.message, "Couldn't reach localhost:11434 — is the endpoint reachable?");
      assert.equal(e.retryable, true);
      return true;
    });
  }
  const bad = provider(fetchImpl, { baseUrl: "not a url" });
  await assert.rejects(() => bad.chat(user), /Couldn't reach not a url —/);
});

test("openai-compat treats a cancelled request as cancellation", async () => {
  const fetchImpl = (async () => {
    throw abortError();
  }) as unknown as typeof fetch;
  const p = provider(fetchImpl);
  await assert.rejects(() => p.chat(user), (e: unknown) => e instanceof AiError && e.message === "Request cancelled.");
  assert.equal(await p.streamText(user, () => {}), null);
  assert.deepEqual(await p.streamChat(user, () => {}), { text: "", toolCalls: [], stopReason: "stop" });
});

// ── streamText ───────────────────────────────────────────────────────────────

test("openai-compat streamText requests a stream, reassembles split events, stops at [DONE]", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    sse([
      ": keep-alive\n\n",
      delta(" Hi"),
      'data: {"choices":[{"delta":{"con',
      'tent":" there "}}]}\r\n\r\n',
      "data: [DONE]\n\n",
      delta("IGNORED"),
    ]),
  ]);
  const out: string[] = [];
  const text = await provider(fetchImpl).streamText(user, (d) => out.push(d));
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual(out, [" Hi", " there "]);
  assert.equal(text, "Hi there");
});

test("openai-compat streamText returns null when nothing but whitespace streamed", async () => {
  const { fetchImpl } = scriptedFetch([sse([delta("  "), "data: [DONE]\n\n"])]);
  assert.equal(await provider(fetchImpl).streamText(user, () => {}), null);
});

test("openai-compat streamText ends cleanly when the server closes without [DONE]", async () => {
  const { fetchImpl } = scriptedFetch([sse([delta("tail")])]);
  assert.equal(await provider(fetchImpl).streamText(user, () => {}), "tail");
});

test("openai-compat streamText falls back to one chat turn when there is no body", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    () => new Response(null, { status: 200 }),
    json({ choices: [{ message: { content: "all at once" }, finish_reason: "stop" }] }),
  ]);
  const out: string[] = [];
  assert.equal(await provider(fetchImpl).streamText(user, (d) => out.push(d)), "all at once");
  assert.deepEqual(out, ["all at once"]);
  assert.equal(seen.length, 2);
  assert.equal("stream" in seen[1].body, false);

  const empty = scriptedFetch([() => new Response(null, { status: 200 }), json({ choices: [] })]);
  const none: string[] = [];
  assert.equal(await provider(empty.fetchImpl).streamText(user, (d) => none.push(d)), null);
  assert.deepEqual(none, []);
});

test("openai-compat streamText: a broken stream errors, a cancelled one keeps its text", async () => {
  const broken = scriptedFetch([sse([delta("x")], new Error("reset"))]);
  await assert.rejects(
    () => provider(broken.fetchImpl).streamText(user, () => {}),
    (e: unknown) => e instanceof AiError && e.message === "Stream from api.example.com failed." && e.retryable,
  );
  const cancelled = scriptedFetch([sse([delta("partial ")], abortError())]);
  assert.equal(await provider(cancelled.fetchImpl).streamText(user, () => {}), "partial");
});

// ── streamChat ───────────────────────────────────────────────────────────────

test("openai-compat streamChat assembles parallel tool calls by index", async () => {
  const { fetchImpl } = scriptedFetch([
    sse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"git_status","arguments":""}},{"index":1,"id":"c1","function":{"name":"git_log"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"limit\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":":2}"}}]}}]}\n\n',
      // A partial that never received a function name is dropped.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":5,"function":{"arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.deepEqual(r.toolCalls, [
    { id: "c0", name: "git_status", arguments: {} },
    { id: "c1", name: "git_log", arguments: { limit: 2 } },
  ]);
  // No finish_reason, but tool calls were made.
  assert.equal(r.stopReason, "tool_calls");
});

test("openai-compat streamChat skips junk lines and reports the finish reason", async () => {
  const { fetchImpl } = scriptedFetch([
    sse([
      "event: something\n",
      "data: {oops\n",
      'data: {"choices":[]}\n',
      'data:{"choices":[{"delta":{"content":""}}]}\n',
      'data: {"choices":[{"delta":{"content":"abc"}}]}\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
    ]),
  ]);
  const out: string[] = [];
  const r = await provider(fetchImpl).streamChat(user, (d) => out.push(d));
  assert.deepEqual(out, ["abc"], "empty content deltas are not emitted");
  assert.equal(r.text, "abc");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.stopReason, "length");
});

test("openai-compat streamChat falls back to chat when there is no body", async () => {
  const { fetchImpl, seen } = scriptedFetch([
    () => new Response(null, { status: 200 }),
    json({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }] }),
  ]);
  const r = await provider(fetchImpl).streamChat(user, () => {});
  assert.equal(seen.length, 2);
  assert.equal(r.text, "plain");
  assert.equal(r.stopReason, "stop");
});

test("openai-compat streamChat: a broken stream errors, a cancelled one keeps its text", async () => {
  const broken = scriptedFetch([sse([delta("x")], new Error("reset"))]);
  await assert.rejects(() => provider(broken.fetchImpl).streamChat(user, () => {}), /Stream from api\.example\.com failed/);
  const cancelled = scriptedFetch([sse([delta("half")], abortError())]);
  const r = await provider(cancelled.fetchImpl).streamChat(user, () => {});
  assert.equal(r.text, "half");
  assert.equal(r.stopReason, "stop");
});
