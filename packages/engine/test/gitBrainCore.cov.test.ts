import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicSseParser,
  OpenAiSseParser,
  buildCommitPrompt,
  buildCommitStyleSystem,
  buildExplainPrompt,
  buildPrDescriptionPrompt,
  buildSummarizePrompt,
  extractAnthropicText,
  extractOpenAiText,
  truncateDiff,
} from "../src/ai/gitBrainCore";

// Hermetic tests for the rest of the GitBrain core: the diff truncator, the
// prompt builders, and the Anthropic stream/non-stream parsers. No network.

// ── truncateDiff ─────────────────────────────────────────────────────────────

test("truncateDiff returns a diff that already fits unchanged", () => {
  const diff = "diff --git a/x b/x\n+one\n+two";
  assert.equal(truncateDiff(diff, 100), diff);
  // Exactly at the budget (4 chars per token) still fits.
  assert.equal(truncateDiff("abcd", 1), "abcd");
});

test("truncateDiff cuts on a line boundary and counts the dropped lines", () => {
  // Budget 3 tokens = 12 chars. "aaaa\n" (5) + "bbbb\n" (5) = 10 fit; "cccc" does not.
  const out = truncateDiff("aaaa\nbbbb\ncccc\ndddd", 3);
  const [kept, marker] = out.split("\n\n");
  assert.equal(kept, "aaaa\nbbbb");
  assert.match(marker!, /diff truncated: 2 more lines omitted/);
  // Never ships half a line.
  assert.ok(!out.includes("cc"));
});

test("truncateDiff uses the singular for a single dropped line", () => {
  const out = truncateDiff("aaaa\nbbbb", 1.5); // 6 chars: only "aaaa\n" fits
  assert.ok(out.startsWith("aaaa\n\n[…"));
  assert.match(out, /1 more line omitted/);
  assert.doesNotMatch(out, /1 more lines/);
});

test("truncateDiff with a non-positive budget yields only the marker", () => {
  const out = truncateDiff("x\ny", 0);
  assert.equal(out, "\n\n[… diff truncated: 2 more lines omitted to stay within the model budget …]");
  assert.equal(truncateDiff("x", -5).startsWith("\n\n[… diff truncated: 1 more line "), true);
});

test("truncateDiff defaults to a 6000-token budget", () => {
  const small = "+x\n".repeat(100);
  assert.equal(truncateDiff(small), small);
  const big = "+".repeat(30) + "\n";
  const huge = big.repeat(1000); // 31k chars > 24k
  const out = truncateDiff(huge);
  assert.ok(out.length < huge.length);
  assert.match(out, /more lines omitted/);
});

// ── prompt builders ─────────────────────────────────────────────────────────

test("buildCommitStyleSystem includes the style guide and up to 10 trimmed examples", () => {
  const subjects = ["  feat: one  ", "", "   ", ...Array.from({ length: 12 }, (_, i) => `fix: ${i}`)];
  const sys = buildCommitStyleSystem(subjects, "conventional");
  assert.ok(sys.startsWith("You are GitBrain"));
  assert.match(sys, /Conventional Commit/);
  assert.match(sys, /Recent commit subjects from this repository/);
  assert.match(sys, /^- feat: one$/m);
  // Blank subjects dropped; only the first 10 non-blank kept.
  const bullets = sys.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 10);
  assert.ok(bullets.includes("- fix: 8"));
  assert.ok(!bullets.includes("- fix: 9"));
});

test("buildCommitStyleSystem omits the example block when there are no subjects", () => {
  const sys = buildCommitStyleSystem([], "concise");
  assert.match(sys, /single concise subject line/);
  assert.doesNotMatch(sys, /Recent commit subjects/);
  // Exactly two paragraphs: identity + style guide.
  assert.equal(sys.split("\n\n").length, 2);
});

test("buildCommitStyleSystem is deterministic and style-specific", () => {
  const a = buildCommitStyleSystem(["x"], "descriptive");
  assert.equal(a, buildCommitStyleSystem(["x"], "descriptive"));
  assert.match(a, /then a blank line, then a short body/);
  assert.notEqual(a, buildCommitStyleSystem(["x"], "concise"));
});

test("the diff prompts fence the diff after their instructions", () => {
  const diff = "+added line";
  const commit = buildCommitPrompt(diff);
  assert.match(commit, /Output ONLY the commit message text/);
  assert.ok(commit.endsWith("Staged diff:\n```diff\n+added line\n```"));

  const explain = buildExplainPrompt(diff);
  assert.match(explain, /^Explain the following diff for a reviewer/);
  assert.ok(explain.endsWith("```diff\n+added line\n```"));

  const summary = buildSummarizePrompt(diff);
  assert.match(summary, /^Summarize the following changes/);
  assert.ok(summary.endsWith("```diff\n+added line\n```"));
});

test("buildPrDescriptionPrompt lists the branch commits, or says there are none", () => {
  const withCommits = buildPrDescriptionPrompt(["feat: a", "fix: b"], "+d");
  assert.match(withCommits, /Commits on this branch:\n- feat: a\n- fix: b/);
  assert.ok(withCommits.endsWith("Combined diff:\n```diff\n+d\n```"));

  const none = buildPrDescriptionPrompt([], "+d");
  assert.match(none, /No distinct commits provided\./);
  assert.doesNotMatch(none, /Commits on this branch/);
});

// ── extractAnthropicText ─────────────────────────────────────────────────────

test("extractAnthropicText joins every text block and trims", () => {
  assert.equal(
    extractAnthropicText({
      content: [
        { type: "text", text: "  feat: " },
        { type: "tool_use" },
        { type: "text", text: "add thing \n" },
        { type: "text" },
      ],
      stop_reason: "end_turn",
    }),
    "feat: add thing",
  );
});

test("extractAnthropicText returns null for a refusal, missing content, or blank text", () => {
  assert.equal(
    extractAnthropicText({ stop_reason: "refusal", content: [{ type: "text", text: "no" }] }),
    null,
  );
  assert.equal(extractAnthropicText({}), null);
  assert.equal(extractAnthropicText({ content: [{ type: "text", text: "  \n" }] }), null);
  assert.equal(extractAnthropicText({ content: [{ type: "image" }] }), null);
});

// ── AnthropicSseParser ───────────────────────────────────────────────────────

function anthropicEvent(event: string, data: unknown, eol = "\n"): string {
  return `event: ${event}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
}

function textDelta(text: string, eol = "\n"): string {
  return anthropicEvent(
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    eol,
  );
}

test("AnthropicSseParser assembles text deltas and flips done on message_stop", () => {
  const p = new AnthropicSseParser();
  const stream =
    anthropicEvent("message_start", { type: "message_start", message: {} }) +
    anthropicEvent("content_block_start", { type: "content_block_start" }) +
    textDelta("fix: ") +
    // A non-text delta (e.g. tool input JSON) contributes nothing.
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{" },
    }) +
    textDelta("handle nulls") +
    anthropicEvent("ping", { type: "ping" });
  assert.deepEqual(p.push(stream), ["fix: ", "handle nulls"]);
  assert.equal(p.done, false);
  assert.deepEqual(p.push(anthropicEvent("message_stop", { type: "message_stop" })), []);
  assert.equal(p.done, true);
});

test("AnthropicSseParser buffers a block split across reads", () => {
  const p = new AnthropicSseParser();
  const full = textDelta("across reads");
  assert.deepEqual(p.push(full.slice(0, 10)), []);
  assert.deepEqual(p.push(full.slice(10, full.length - 1)), []);
  assert.deepEqual(p.push(full.slice(full.length - 1)), ["across reads"]);
});

test("AnthropicSseParser tolerates CRLF separators, mixed with LF", () => {
  const p = new AnthropicSseParser();
  const out = p.push(textDelta("one", "\r\n") + textDelta("two") + textDelta("three", "\r\n"));
  assert.deepEqual(out, ["one", "two", "three"]);
});

test("AnthropicSseParser skips blocks without data, malformed JSON and non-string text", () => {
  const p = new AnthropicSseParser();
  const stream =
    "event: ping\n\n" +
    ": keep-alive comment\n\n" +
    "data: {broken\n\n" +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "text_delta", text: 42 },
    }) +
    anthropicEvent("content_block_delta", { type: "content_block_delta" }) +
    textDelta("kept");
  assert.deepEqual(p.push(stream), ["kept"]);
  assert.equal(p.done, false);
});

test("AnthropicSseParser treats a [DONE] payload as the end of the stream", () => {
  const p = new AnthropicSseParser();
  assert.deepEqual(p.push("data:[DONE]\n\n"), []);
  assert.equal(p.done, true);
});

test("AnthropicSseParser joins multi-line data payloads before parsing", () => {
  const p = new AnthropicSseParser();
  const block =
    'data: {"type":"content_block_delta",\n' +
    'data: "delta":{"type":"text_delta","text":"multi"}}\n\n';
  assert.deepEqual(p.push(block), ["multi"]);
});

// ── OpenAI parser edges not covered by gitBrainCore.test.ts ──────────────────

test("OpenAiSseParser picks the earlier separator when LF and CRLF blocks mix", () => {
  const p = new OpenAiSseParser();
  const lf = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n';
  const crlf = 'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n';
  assert.deepEqual(p.push(crlf + lf + crlf), ["b", "a", "b"]);
});

test("OpenAiSseParser ignores empty-string deltas and missing choices", () => {
  const p = new OpenAiSseParser();
  const out = p.push(
    'data: {"choices":[{"delta":{"content":""}}]}\n\n' +
      'data: {}\n\n' +
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
  );
  assert.deepEqual(out, ["x"]);
});

test("extractOpenAiText returns null for a non-string content", () => {
  assert.equal(
    extractOpenAiText({ choices: [{ message: { content: 5 as unknown as string } }] }),
    null,
  );
});
