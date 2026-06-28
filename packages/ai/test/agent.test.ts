import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type AgentEvent } from "../src/agent";
import { selectTools, type GitToolHost } from "../src/gitTools";
import type { ChatMessage, ChatResult, Provider } from "../src/types";

/** A provider that replays a fixed script of chat results, ignoring input. */
function scriptedProvider(script: ChatResult[]): Provider {
  let i = 0;
  return {
    id: "stub",
    supportsTools: true,
    label: "stub",
    async chat(): Promise<ChatResult> {
      return script[Math.min(i++, script.length - 1)];
    },
    async streamText(_m: ChatMessage[], onDelta) {
      const r = script[Math.min(i++, script.length - 1)];
      if (r.text) onDelta(r.text);
      return r.text || null;
    },
  };
}

/** A host that records calls; only the methods exercised here do real work. */
function recordingHost(): { host: GitToolHost; calls: string[] } {
  const calls: string[] = [];
  const host = new Proxy(
    {
      repoRoot: () => "/repo",
      async status() {
        calls.push("status");
        return [{ path: "a.ts", status: "M", staged: false }];
      },
      async commit(message: string) {
        calls.push(`commit:${message}`);
        return { ok: true };
      },
    } as Partial<GitToolHost>,
    {
      get(target, prop) {
        const v = (target as Record<string, unknown>)[prop as string];
        if (v) return v;
        // Any unimplemented method just records + returns a benign value.
        return async () => {
          calls.push(String(prop));
          return { ok: true };
        };
      },
    },
  ) as GitToolHost;
  return { host, calls };
}

test("agent runs a read tool then finishes, emitting ordered events", async () => {
  const provider = scriptedProvider([
    { text: "checking", toolCalls: [{ id: "c1", name: "git_status", arguments: {} }], stopReason: "tool_calls" },
    { text: "Working tree has 1 modified file.", toolCalls: [], stopReason: "stop" },
  ]);
  const { host, calls } = recordingHost();
  const events: AgentEvent[] = [];
  const r = await runAgent("what changed?", {
    provider,
    host,
    tools: selectTools({ write: false }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.stopped, "done");
  assert.equal(r.steps, 2);
  assert.deepEqual(calls, ["status"]);
  assert.equal(r.text, "Working tree has 1 modified file.");
  assert.ok(events.some((e) => e.type === "tool_call" && e.name === "git_status"));
  assert.ok(events.some((e) => e.type === "tool_result" && e.name === "git_status" && !e.isError));
  assert.ok(events.some((e) => e.type === "done"));
});

test("agent gates a write tool through confirm; denial blocks execution", async () => {
  const provider = scriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "git_commit", arguments: { message: "feat: x" } }],
      stopReason: "tool_calls",
    },
    { text: "I didn't commit because you declined.", toolCalls: [], stopReason: "stop" },
  ]);
  const { host, calls } = recordingHost();
  const events: AgentEvent[] = [];
  const r = await runAgent("commit it", {
    provider,
    host,
    tools: selectTools({ write: true }),
    confirm: () => false, // user declines
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.stopped, "done");
  assert.ok(!calls.some((c) => c.startsWith("commit:")), "commit must not run when declined");
  assert.ok(events.some((e) => e.type === "tool_denied" && e.name === "git_commit"));
});

test("agent executes a write tool when confirm approves", async () => {
  const provider = scriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "git_commit", arguments: { message: "feat: y" } }],
      stopReason: "tool_calls",
    },
    { text: "Committed.", toolCalls: [], stopReason: "stop" },
  ]);
  const { host, calls } = recordingHost();
  const r = await runAgent("commit it", {
    provider,
    host,
    tools: selectTools({ write: true }),
    confirm: () => true,
  });
  assert.equal(r.stopped, "done");
  assert.ok(calls.includes("commit:feat: y"), "commit ran with the model's message");
});

test("selectTools gates write/destructive exposure", () => {
  const read = selectTools({ write: false });
  assert.ok(read.every((t) => t.mode === "read"));
  const write = selectTools({ write: true });
  assert.ok(write.some((t) => t.mode === "write"));
  assert.ok(!write.some((t) => t.mode === "destructive"), "destructive needs its own opt-in");
  const all = selectTools({ write: true, destructive: true });
  assert.ok(all.some((t) => t.mode === "destructive"));
});
