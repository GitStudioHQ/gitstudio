// The one-shot AI tasks behind the ✨ buttons: which tier and budget each asks
// for, what the prompt carries (the diff, the commits, the repo's own commit
// conventions), when it streams, and what an empty answer comes back as.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assist,
  explainDiff,
  generateChangelog,
  generateCommitMessage,
  generatePrDescription,
  reviewDiff,
  suggestBranchNames,
  summarizeChanges,
} from "../src/tasks";
import type { ChatMessage, ChatOptions, Provider } from "../src/types";

interface Call {
  via: "chat" | "streamText";
  messages: ChatMessage[];
  opts: ChatOptions;
}

/** A provider that records each request and answers with a fixed text. */
function recordingProvider(answer: string): { provider: Provider; calls: Call[] } {
  const calls: Call[] = [];
  const provider: Provider = {
    id: "rec",
    label: "rec",
    supportsTools: false,
    async chat(messages, opts = {}) {
      calls.push({ via: "chat", messages, opts });
      return { text: answer, toolCalls: [], stopReason: "stop" };
    },
    async streamText(messages, onDelta, opts = {}) {
      calls.push({ via: "streamText", messages, opts });
      for (const piece of answer.match(/.{1,4}/gs) ?? []) onDelta(piece);
      return answer.trim() || null;
    },
  };
  return { provider, calls };
}

const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new";

test("a commit message uses the fast tier, a cacheable style system and the diff", async () => {
  const { provider, calls } = recordingProvider("  feat(x): swap old for new  \n");
  const msg = await generateCommitMessage(provider, DIFF, { recentSubjects: ["fix: a", "  ", "feat: b"], style: "concise" });
  assert.equal(msg, "feat(x): swap old for new", "the answer is trimmed");
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.via, "chat");
  assert.equal(c.opts.model, "fast");
  assert.equal(c.opts.maxTokens, 512);
  assert.equal(c.opts.systemCacheable, true);
  assert.equal(c.messages[0].role, "system");
  assert.match(c.messages[0].content, /single concise subject line/);
  assert.match(c.messages[0].content, /- fix: a\n- feat: b/, "the repo's recent subjects set the tone");
  assert.equal(c.messages[1].role, "user");
  assert.ok(c.messages[1].content.includes(DIFF), "the staged diff is in the prompt");
});

test("a commit message defaults to Conventional Commits with no examples", async () => {
  const { provider, calls } = recordingProvider("x");
  await generateCommitMessage(provider, DIFF);
  assert.match(calls[0].messages[0].content, /Conventional Commit/);
  assert.doesNotMatch(calls[0].messages[0].content, /Recent commit subjects/);
});

test("a huge diff is truncated before it reaches the model", async () => {
  const { provider, calls } = recordingProvider("x");
  const huge = Array.from({ length: 20000 }, (_, i) => `+line ${i}`).join("\n");
  await generateCommitMessage(provider, huge);
  const prompt = calls[0].messages[1].content;
  assert.ok(prompt.length < huge.length / 2, "the prompt is far smaller than the diff");
  assert.match(prompt, /diff truncated: \d+ more lines omitted/);
});

test("an empty or blank answer comes back as null", async () => {
  assert.equal(await generateCommitMessage(recordingProvider("   ").provider, DIFF), null);
  assert.equal(await explainDiff(recordingProvider("").provider, DIFF), null);
});

test("with a delta sink the task streams and returns the provider's streamed text", async () => {
  const { provider, calls } = recordingProvider("## Summary\nIt swaps a word.");
  const ac = new AbortController();
  const deltas: string[] = [];
  const out = await explainDiff(provider, DIFF, { onDelta: (d) => deltas.push(d), signal: ac.signal });
  assert.equal(out, "## Summary\nIt swaps a word.");
  assert.equal(deltas.join(""), "## Summary\nIt swaps a word.");
  assert.equal(calls[0].via, "streamText");
  assert.equal(calls[0].opts.signal, ac.signal, "cancellation reaches the provider");
  assert.equal(calls[0].opts.model, "mid");
  assert.equal(calls[0].opts.maxTokens, 1024);
});

test("explain and summarize send the diff in their own prompts on the mid tier", async () => {
  const explain = recordingProvider("e");
  const summary = recordingProvider("s");
  assert.equal(await explainDiff(explain.provider, DIFF), "e");
  assert.equal(await summarizeChanges(summary.provider, DIFF), "s");
  assert.match(explain.calls[0].messages[0].content, /^Explain the following diff/);
  assert.match(summary.calls[0].messages[0].content, /^Summarize the following changes/);
  for (const c of [explain.calls[0], summary.calls[0]]) {
    assert.equal(c.messages.length, 1);
    assert.ok(c.messages[0].content.includes(DIFF));
    assert.equal(c.opts.model, "mid");
    assert.equal(c.opts.systemCacheable, undefined);
  }
});

test("a PR description lists the branch's commits alongside the diff", async () => {
  const { provider, calls } = recordingProvider("Title\n\nBody");
  await generatePrDescription(provider, ["feat: a", "fix: b"], DIFF);
  const p = calls[0].messages[0].content;
  assert.match(p, /Commits on this branch:\n- feat: a\n- fix: b/);
  assert.ok(p.includes(DIFF));
  assert.equal(calls[0].opts.maxTokens, 1200);
});

test("a review asks the deep tier for bugs, with the diff fenced", async () => {
  const { provider, calls } = recordingProvider("Looks safe.");
  assert.equal(await reviewDiff(provider, DIFF), "Looks safe.");
  const p = calls[0].messages[0].content;
  assert.match(p, /senior engineer reviewing/);
  assert.ok(p.includes("```diff\n" + DIFF + "\n```"));
  assert.equal(calls[0].opts.model, "deep");
  assert.equal(calls[0].opts.maxTokens, 1500);
});

test("release notes name the version when given and list every commit", async () => {
  const withVersion = recordingProvider("notes");
  await generateChangelog(withVersion.provider, ["feat: x", "fix: y"], { version: "v2.0.0" });
  const p = withVersion.calls[0].messages[0].content;
  assert.match(p, /^Write user-facing release notes for v2\.0\.0 from these commit subjects\./);
  assert.match(p, /Commits:\n- feat: x\n- fix: y$/);

  const noVersion = recordingProvider("notes");
  await generateChangelog(noVersion.provider, ["chore: z"]);
  assert.match(noVersion.calls[0].messages[0].content, /^Write user-facing release notes from these/);
});

test("release notes stream when given a sink", async () => {
  const { provider, calls } = recordingProvider("- New thing");
  const deltas: string[] = [];
  assert.equal(await generateChangelog(provider, ["feat: new"], { ctx: { onDelta: (d) => deltas.push(d) } }), "- New thing");
  assert.equal(calls[0].via, "streamText");
  assert.equal(deltas.join(""), "- New thing");
});

test("branch-name suggestions use the fast tier with a tight budget and carry the task", async () => {
  const { provider, calls } = recordingProvider("feat/login\nfix/login-crash\n");
  assert.equal(await suggestBranchNames(provider, "fix the login crash"), "feat/login\nfix/login-crash");
  assert.match(calls[0].messages[0].content, /kebab-case/);
  assert.match(calls[0].messages[0].content, /Task: fix the login crash$/);
  assert.equal(calls[0].opts.model, "fast");
  assert.equal(calls[0].opts.maxTokens, 120);
});

test("assist hands the caller's prompt through unchanged", async () => {
  const { provider, calls } = recordingProvider("Answer");
  assert.equal(await assist(provider, "Analyze this issue: #12"), "Answer");
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "Analyze this issue: #12" }]);
  assert.equal(calls[0].opts.maxTokens, 1400);
});

test("a provider error propagates to the caller", async () => {
  const provider: Provider = {
    id: "boom",
    label: "boom",
    supportsTools: false,
    async chat() {
      throw new Error("rate limited");
    },
    async streamText() {
      throw new Error("rate limited");
    },
  };
  await assert.rejects(() => reviewDiff(provider, DIFF), /rate limited/);
  await assert.rejects(() => assist(provider, "x", { onDelta: () => {} }), /rate limited/);
});
