import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AnthropicSseParser,
  extractAnthropicText,
  truncateDiff,
  buildCommitStyleSystem,
  buildCommitPrompt,
} from "@gitstudio/engine/ai/gitBrainCore";

// Hermetic tests for the pure GitBrain core: the Anthropic SSE parser fed a
// hand-written byte sequence (no network), the diff truncator's token-ish
// budget, the non-streaming response extractor, and the prompt builders. None
// of this imports vscode / node-fetch — it runs under plain tsx.

// ── SSE parsing ──────────────────────────────────────────────────────────────

/** Wrap a JSON object as one SSE event block (event line + data line + blank). */
function sse(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

const TEXT_DELTA = (text: string) =>
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });

test("SSE parser assembles text deltas across a full stream", () => {
  const parser = new AnthropicSseParser();
  const stream =
    sse("message_start", { type: "message_start" }) +
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    TEXT_DELTA("Hello") +
    TEXT_DELTA(", ") +
    TEXT_DELTA("world") +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }) +
    sse("message_stop", { type: "message_stop" });

  const out = parser.push(stream);
  assert.equal(out.join(""), "Hello, world");
  assert.equal(parser.done, true);
});

test("SSE parser handles chunk boundaries mid-event", () => {
  const parser = new AnthropicSseParser();
  const full = TEXT_DELTA("abc") + TEXT_DELTA("def");
  // Split the byte stream at an awkward spot (inside the first event's JSON).
  const cut = 20;
  const first = parser.push(full.slice(0, cut));
  const second = parser.push(full.slice(cut));
  assert.equal([...first, ...second].join(""), "abcdef");
});

test("SSE parser ignores thinking/ping deltas and non-text blocks", () => {
  const parser = new AnthropicSseParser();
  const stream =
    sse("ping", { type: "ping" }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hmm" },
    }) +
    TEXT_DELTA("real") +
    sse("message_stop", { type: "message_stop" });
  assert.equal(parser.push(stream).join(""), "real");
});

test("SSE parser tolerates CRLF separators and [DONE]", () => {
  const parser = new AnthropicSseParser();
  const block =
    'event: content_block_delta\r\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\r\n\r\n';
  const out = parser.push(block + "data: [DONE]\n\n");
  assert.equal(out.join(""), "x");
  assert.equal(parser.done, true);
});

test("SSE parser stops at message_stop and flips done", () => {
  const parser = new AnthropicSseParser();
  parser.push(TEXT_DELTA("one"));
  assert.equal(parser.done, false);
  parser.push(sse("message_stop", { type: "message_stop" }));
  assert.equal(parser.done, true);
});

// ── Non-streaming response extraction ────────────────────────────────────────

test("extractAnthropicText joins all text blocks", () => {
  const text = extractAnthropicText({
    content: [
      { type: "text", text: "feat: add " },
      { type: "tool_use" },
      { type: "text", text: "thing" },
    ],
    stop_reason: "end_turn",
  });
  assert.equal(text, "feat: add thing");
});

test("extractAnthropicText returns null on refusal", () => {
  assert.equal(
    extractAnthropicText({ content: [], stop_reason: "refusal" }),
    null,
  );
});

test("extractAnthropicText returns null when there is no text", () => {
  assert.equal(
    extractAnthropicText({ content: [{ type: "tool_use" }], stop_reason: "end_turn" }),
    null,
  );
  assert.equal(extractAnthropicText({}), null);
});

// ── Diff truncation (token-ish budget) ───────────────────────────────────────

test("truncateDiff leaves a small diff untouched", () => {
  const small = "diff --git a/x b/x\n+hello\n";
  assert.equal(truncateDiff(small, 6000), small);
});

test("truncateDiff cuts a huge diff to the budget and marks it", () => {
  // ~4 chars/token → a 20-token budget is ~80 chars. Build a diff far larger.
  const line = "+this is a diff line of some length here\n"; // 41 chars
  const huge = Array.from({ length: 1000 }, () => line).join("");
  assert.ok(huge.length > 40000);

  const out = truncateDiff(huge, 20); // ~80 char budget
  assert.ok(out.length < huge.length, "output should be shorter");
  assert.ok(out.length < 400, "output should be near the budget, not the whole diff");
  assert.match(out, /diff truncated: \d+ more lines? omitted/);
  // It must cut on a line boundary — no partial line before the marker.
  const beforeMarker = out.slice(0, out.indexOf("[… diff truncated"));
  for (const l of beforeMarker.split("\n").filter((s) => s.length > 0)) {
    assert.ok(line.includes(l) || l === line.trimEnd(), `clean line boundary: ${l}`);
  }
});

test("truncateDiff with a zero budget yields only the marker", () => {
  const out = truncateDiff("+a\n+b\n+c\n", 0);
  assert.match(out, /diff truncated/);
  assert.ok(!out.startsWith("+a"));
});

// ── Prompt builders ──────────────────────────────────────────────────────────

test("buildCommitStyleSystem is deterministic and embeds examples", () => {
  const subjects = ["feat: a", "fix: b", "  ", "chore: c"];
  const a = buildCommitStyleSystem(subjects, "conventional");
  const b = buildCommitStyleSystem(subjects, "conventional");
  assert.equal(a, b, "same inputs → byte-identical prefix (cache-safe)");
  assert.match(a, /Conventional Commit/);
  assert.match(a, /- feat: a/);
  assert.match(a, /- fix: b/);
  // Blank subjects are filtered out.
  assert.ok(!a.includes("-  \n"));
});

test("buildCommitStyleSystem caps examples at 10", () => {
  const subjects = Array.from({ length: 25 }, (_, i) => `feat: item ${i}`);
  const sys = buildCommitStyleSystem(subjects, "concise");
  const bulletCount = (sys.match(/- feat: item/g) ?? []).length;
  assert.equal(bulletCount, 10);
});

test("buildCommitPrompt carries the diff and forbids prose wrapping", () => {
  const prompt = buildCommitPrompt("+added a line");
  assert.match(prompt, /Output ONLY the commit message/);
  assert.match(prompt, /\+added a line/);
});
