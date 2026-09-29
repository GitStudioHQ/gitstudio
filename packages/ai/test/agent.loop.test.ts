// The agent loop's edges: which provider path each turn takes, what the model
// is sent (system prompt, history, tool specs, options), how a turn ends —
// done, step cap, error, cancellation — and how a bad tool call is reported
// back to the model instead of crashing the run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type AgentEvent } from "../src/agent";
import { toolByName, type GitTool, type GitToolHost } from "../src/gitTools";
import { AiError, type ChatMessage, type ChatOptions, type ChatResult, type Provider } from "../src/types";

interface Turn {
  via: "chat" | "streamChat" | "streamText";
  messages: ChatMessage[];
  opts: ChatOptions;
}

/** Snapshot messages at call time (the loop keeps appending to the same array). */
const snap = (m: ChatMessage[]) => JSON.parse(JSON.stringify(m)) as ChatMessage[];

function provider(
  script: Array<ChatResult | Error>,
  shape: { streamChat?: boolean; supportsTools?: boolean } = {},
): { provider: Provider; turns: Turn[] } {
  const turns: Turn[] = [];
  let i = 0;
  const next = () => {
    const r = script[Math.min(i++, script.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const p: Provider = {
    id: "p",
    label: "p",
    supportsTools: shape.supportsTools ?? true,
    async chat(messages, opts = {}) {
      turns.push({ via: "chat", messages: snap(messages), opts });
      return next();
    },
    async streamText(messages, onDelta, opts = {}) {
      turns.push({ via: "streamText", messages: snap(messages), opts });
      const r = next();
      if (r.text) onDelta(r.text);
      return r.text || null;
    },
  };
  if (shape.streamChat) {
    p.streamChat = async (messages, onDelta, opts = {}) => {
      turns.push({ via: "streamChat", messages: snap(messages), opts });
      const r = next();
      for (const piece of r.text.split(/(?<= )/)) if (piece) onDelta(piece);
      return r;
    };
  }
  return { provider: p, turns };
}

function host(overrides: Partial<GitToolHost> = {}): GitToolHost {
  return {
    repoRoot: () => "/repo",
    status: async () => [{ path: "a.ts", status: "M", staged: false }],
    log: async () => [],
    ...overrides,
  } as GitToolHost;
}

const status = toolByName("git_status")!;
const log = toolByName("git_log")!;
const commit = toolByName("git_commit")!;

const done = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: "stop" });
const calls = (...c: Array<[string, string, Record<string, unknown>?]>): ChatResult => ({
  text: "",
  toolCalls: c.map(([id, name, args]) => ({ id, name, arguments: args ?? {} })),
  stopReason: "tool_calls",
});

test("the first turn carries the agent prompt, the caller's guidance, history and the goal", async () => {
  const { provider: p, turns } = provider([done("Hi!")]);
  const history: ChatMessage[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];
  const r = await runAgent("hello", { provider: p, host: host(), tools: [status, log], system: "Repo uses gitmoji.", history });
  assert.equal(r.text, "Hi!");
  const sent = turns[0].messages;
  assert.equal(sent[0].role, "system");
  assert.match(sent[0].content, /^You are the GitStudio Assistant/);
  assert.match(sent[0].content, /\n\nRepo uses gitmoji\.$/);
  assert.deepEqual(sent.slice(1), [...history, { role: "user", content: "hello" }]);
});

test("each turn asks for the deep tier with the permitted tools and caching", async () => {
  const { provider: p, turns } = provider([done("ok")]);
  const ac = new AbortController();
  await runAgent("x", { provider: p, host: host(), tools: [status], signal: ac.signal, thinking: "extended" });
  const o = turns[0].opts;
  assert.equal(o.model, "deep");
  assert.equal(o.modelId, undefined);
  assert.equal(o.maxTokens, 2048);
  assert.equal(o.systemCacheable, true);
  assert.equal(o.thinking, "extended");
  assert.equal(o.signal, ac.signal);
  assert.deepEqual(o.tools, [{ name: status.name, description: status.description, parameters: status.parameters }]);
});

test("an explicit tier and model id are passed through", async () => {
  const { provider: p, turns } = provider([done("ok")]);
  await runAgent("x", { provider: p, host: host(), tools: [], model: "fast", modelId: "exact-1" });
  assert.equal(turns[0].opts.model, "fast");
  assert.equal(turns[0].opts.modelId, "exact-1");
});

test("a streaming provider streams text deltas and still runs tools", async () => {
  const { provider: p, turns } = provider(
    [
      { text: "Let me look. ", toolCalls: [{ id: "c1", name: "git_status", arguments: {} }], stopReason: "tool_calls" },
      done("One file is modified."),
    ],
    { streamChat: true },
  );
  const deltas: string[] = [];
  const events: AgentEvent[] = [];
  const r = await runAgent("status?", {
    provider: p,
    host: host(),
    tools: [status],
    onTextDelta: (d) => deltas.push(d),
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(turns.map((t) => t.via), ["streamChat", "streamChat"]);
  assert.equal(deltas.join(""), "Let me look. One file is modified.");
  assert.equal(r.text, "One file is modified.");
  assert.equal(r.stopped, "done");
  assert.deepEqual(r.toolCalls, [{ name: "git_status", args: {}, isError: false }]);
  // The second turn saw the assistant's tool request and the tool's answer.
  const second = turns[1].messages;
  assert.deepEqual(second.at(-2), {
    role: "assistant",
    content: "Let me look. ",
    toolCalls: [{ id: "c1", name: "git_status", arguments: {} }],
  });
  assert.equal(second.at(-1)?.role, "tool");
  assert.equal(second.at(-1)?.toolCallId, "c1");
  assert.equal(second.at(-1)?.name, "git_status");
  assert.match(second.at(-1)?.content ?? "", /^1 changed file\(s\), 0 staged — \/repo/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["assistant", "tool_call", "tool_result", "assistant", "done"],
  );
});

test("a text-only provider is streamed and never offered a tool turn", async () => {
  const { provider: p, turns } = provider([done("I can only chat.")], { supportsTools: false });
  const deltas: string[] = [];
  const r = await runAgent("hi", { provider: p, host: host(), tools: [status], onTextDelta: (d) => deltas.push(d) });
  assert.equal(turns[0].via, "streamText");
  assert.deepEqual(deltas, ["I can only chat."]);
  assert.deepEqual(r, { text: "I can only chat.", steps: 1, toolCalls: [], stopped: "done" });
});

test("a text-only provider that returns nothing ends with empty text", async () => {
  const { provider: p } = provider([{ text: "", toolCalls: [], stopReason: "stop" }], { supportsTools: false });
  const events: AgentEvent[] = [];
  const r = await runAgent("hi", { provider: p, host: host(), tools: [], onEvent: (e) => events.push(e) });
  assert.equal(r.text, "");
  assert.equal(r.stopped, "done");
  assert.deepEqual(events, [{ type: "done", text: "", steps: 1 }], "no empty assistant event");
});

test("an already-aborted signal stops before the first model call", async () => {
  const { provider: p, turns } = provider([done("never")]);
  const ac = new AbortController();
  ac.abort();
  const events: AgentEvent[] = [];
  const r = await runAgent("x", { provider: p, host: host(), tools: [], signal: ac.signal, onEvent: (e) => events.push(e) });
  assert.deepEqual(r, { text: "", steps: 0, toolCalls: [], stopped: "cancelled" });
  assert.equal(turns.length, 0);
  assert.deepEqual(events, [{ type: "error", text: "Cancelled." }]);
});

test("cancelling between turns keeps the text and tool calls so far", async () => {
  const ac = new AbortController();
  const { provider: p } = provider([
    { text: "Checking.", toolCalls: [{ id: "c1", name: "git_status", arguments: {} }], stopReason: "tool_calls" },
    done("never reached"),
  ]);
  const h = host({
    status: async () => {
      ac.abort(); // the user hits Stop while the tool runs
      return [];
    },
  });
  const r = await runAgent("x", { provider: p, host: h, tools: [status], signal: ac.signal });
  assert.equal(r.stopped, "cancelled");
  assert.equal(r.steps, 1);
  assert.equal(r.text, "Checking.");
  assert.deepEqual(r.toolCalls, [{ name: "git_status", args: {}, isError: false }]);
});

test("a provider AiError ends the run with its message", async () => {
  const { provider: p } = provider([new AiError("Anthropic rate limit hit — try again in a moment.", 429, true)]);
  const events: AgentEvent[] = [];
  const r = await runAgent("x", { provider: p, host: host(), tools: [], onEvent: (e) => events.push(e) });
  assert.deepEqual(r, { text: "", steps: 0, toolCalls: [], stopped: "error" });
  assert.deepEqual(events, [{ type: "error", text: "Anthropic rate limit hit — try again in a moment." }]);
});

test("any other provider failure is reported generically, never as a raw stack", async () => {
  const { provider: p } = provider([
    { text: "step one", toolCalls: [{ id: "c1", name: "git_status", arguments: {} }], stopReason: "tool_calls" },
    new TypeError("Cannot read properties of undefined"),
  ]);
  const events: AgentEvent[] = [];
  const r = await runAgent("x", { provider: p, host: host(), tools: [status], onEvent: (e) => events.push(e) });
  assert.equal(r.stopped, "error");
  assert.equal(r.steps, 1);
  assert.equal(r.text, "step one", "text from earlier turns is kept");
  assert.deepEqual(events.at(-1), { type: "error", text: "The model request failed." });
});

test("the step cap stops a model that never finishes", async () => {
  const { provider: p, turns } = provider([calls(["c", "git_status"])]);
  const events: AgentEvent[] = [];
  const r = await runAgent("loop", { provider: p, host: host(), tools: [status], maxSteps: 3, onEvent: (e) => events.push(e) });
  assert.equal(turns.length, 3);
  assert.equal(r.stopped, "max_steps");
  assert.equal(r.steps, 3);
  assert.equal(r.text, "Reached the step limit before finishing.");
  assert.equal(r.toolCalls.length, 3);
  assert.deepEqual(events.at(-1), { type: "done", text: "Reached the step limit.", steps: 3 });
});

test("the step cap keeps the model's last words when it had some", async () => {
  const { provider: p } = provider([{ ...calls(["c", "git_status"]), text: "still going" }]);
  const r = await runAgent("loop", { provider: p, host: host(), tools: [status], maxSteps: 2 });
  assert.equal(r.stopped, "max_steps");
  assert.equal(r.text, "still going");
});

test("a tool the run did not permit is reported to the model as unknown", async () => {
  const { provider: p, turns } = provider([calls(["c1", "git_reset", { mode: "hard", ref: "HEAD~5" }]), done("ok")]);
  const reset = async () => {
    throw new Error("must not run");
  };
  const events: AgentEvent[] = [];
  const r = await runAgent("x", {
    provider: p,
    host: host({ reset }),
    tools: [status], // git_reset not permitted
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(r.toolCalls, [{ name: "git_reset", args: { mode: "hard", ref: "HEAD~5" }, isError: true }]);
  assert.equal(turns[1].messages.at(-1)?.content, "Unknown tool: git_reset.");
  assert.ok(!events.some((e) => e.type === "tool_call"), "an unknown tool is not announced as a call");
  assert.ok(events.some((e) => e.type === "tool_result" && e.isError && e.text === "Unknown tool: git_reset."));
});

test("a confirm gate that throws counts as a denial", async () => {
  let committed = false;
  const { provider: p, turns } = provider([calls(["c1", "git_commit", { message: "x" }]), done("ok")]);
  const events: AgentEvent[] = [];
  await runAgent("x", {
    provider: p,
    host: host({
      commit: async () => {
        committed = true;
        return { ok: true };
      },
    }),
    tools: [commit],
    confirm: () => {
      throw new Error("dialog closed");
    },
    onEvent: (e) => events.push(e),
  });
  assert.equal(committed, false);
  assert.ok(events.some((e) => e.type === "tool_denied"));
  assert.match(turns[1].messages.at(-1)?.content ?? "", /^The user declined to run this action\. Do not retry it/);
});

test("the confirm gate sees the tool and its arguments, and read tools skip it", async () => {
  const asked: Array<[string, Record<string, unknown>]> = [];
  const { provider: p } = provider([calls(["c1", "git_status"], ["c2", "git_commit", { message: "feat: z" }]), done("ok")]);
  await runAgent("x", {
    provider: p,
    host: host({ commit: async () => ({ ok: true }) }),
    tools: [status, commit],
    confirm: async (tool: GitTool, args) => {
      asked.push([tool.name, args]);
      return true;
    },
  });
  assert.deepEqual(asked, [["git_commit", { message: "feat: z" }]]);
});

test("without a confirm gate a write tool runs directly", async () => {
  let msg = "";
  const { provider: p } = provider([calls(["c1", "git_commit", { message: "feat: direct" }]), done("ok")]);
  const r = await runAgent("x", {
    provider: p,
    host: host({
      commit: async (m: string) => {
        msg = m;
        return { ok: true };
      },
    }),
    tools: [commit],
  });
  assert.equal(msg, "feat: direct");
  assert.deepEqual(r.toolCalls, [{ name: "git_commit", args: { message: "feat: direct" }, isError: false }]);
});

test("a tool that throws is reported back to the model and the run continues", async () => {
  const { provider: p, turns } = provider([calls(["c1", "git_status"]), done("Status failed; the repo may be locked.")]);
  const r = await runAgent("x", {
    provider: p,
    host: host({
      status: async () => {
        throw new Error("index.lock exists");
      },
    }),
    tools: [status],
  });
  assert.equal(r.stopped, "done");
  assert.deepEqual(r.toolCalls, [{ name: "git_status", args: {}, isError: true }]);
  assert.equal(turns[1].messages.at(-1)?.content, "Tool git_status failed: index.lock exists");
});

test("a non-Error throw from a tool is still stringified for the model", async () => {
  const { provider: p, turns } = provider([calls(["c1", "git_status"]), done("ok")]);
  await runAgent("x", {
    provider: p,
    host: host({
      status: async () => {
        throw "plain string";
      },
    }),
    tools: [status],
  });
  assert.equal(turns[1].messages.at(-1)?.content, "Tool git_status failed: plain string");
});

test("a tool's own error result is marked as an error in the transcript", async () => {
  const { provider: p } = provider([calls(["c1", "git_log", {}], ["c2", "git_commit", { message: "" }]), done("ok")]);
  const events: AgentEvent[] = [];
  const r = await runAgent("x", { provider: p, host: host(), tools: [log, commit], onEvent: (e) => events.push(e) });
  assert.deepEqual(r.toolCalls, [
    { name: "git_log", args: {}, isError: false },
    { name: "git_commit", args: { message: "" }, isError: true },
  ]);
  const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
  assert.deepEqual(
    results.map((e) => [e.name, e.text, e.isError]),
    [
      ["git_log", "No commits found.", false],
      ["git_commit", "A commit message is required.", true],
    ],
  );
});
