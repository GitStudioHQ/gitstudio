import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAiSseParser,
  extractOpenAiText,
  type OpenAiChatResponse,
} from "../src/ai/gitBrainCore";

// Hermetic tests for the OpenAI-compatible parsing helpers — no network. They
// cover the non-streaming `choices[0].message.content` extraction and the
// streaming SSE assembly (including the `data: [DONE]` sentinel), which is what
// the OpenAiProvider relies on for OpenAI / OpenRouter / Ollama / LM Studio.

// ── extractOpenAiText (non-streaming) ────────────────────────────────────────

test("extractOpenAiText returns choices[0].message.content", () => {
  const body: OpenAiChatResponse = {
    choices: [
      {
        message: { role: "assistant", content: "feat(ai): add OpenAI provider" },
        finish_reason: "stop",
      },
    ],
  };
  assert.equal(extractOpenAiText(body), "feat(ai): add OpenAI provider");
});

test("extractOpenAiText trims surrounding whitespace", () => {
  const body: OpenAiChatResponse = {
    choices: [{ message: { content: "  fix: trim me \n" } }],
  };
  assert.equal(extractOpenAiText(body), "fix: trim me");
});

test("extractOpenAiText returns null for empty / missing / blank content", () => {
  assert.equal(extractOpenAiText({}), null);
  assert.equal(extractOpenAiText({ choices: [] }), null);
  assert.equal(extractOpenAiText({ choices: [{ message: {} }] }), null);
  assert.equal(
    extractOpenAiText({ choices: [{ message: { content: "   \n " } }] }),
    null,
  );
});

// ── OpenAiSseParser (streaming) ──────────────────────────────────────────────

/** Build a single SSE event block for `/chat/completions` streaming. */
function chunk(content: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) +
    "\n\n"
  );
}

test("OpenAiSseParser assembles content deltas in order", () => {
  const parser = new OpenAiSseParser();
  const out: string[] = [];
  for (const s of parser.push(chunk("Hello"))) out.push(s);
  for (const s of parser.push(chunk(", "))) out.push(s);
  for (const s of parser.push(chunk("world"))) out.push(s);
  assert.deepEqual(out, ["Hello", ", ", "world"]);
  assert.equal(out.join(""), "Hello, world");
  assert.equal(parser.done, false);
});

test("OpenAiSseParser buffers across chunk boundaries (split mid-event)", () => {
  const parser = new OpenAiSseParser();
  const full = chunk("split across reads");
  const mid = Math.floor(full.length / 2);
  // First half holds an incomplete event → no deltas yet.
  assert.deepEqual(parser.push(full.slice(0, mid)), []);
  // Second half completes it → the delta emerges.
  assert.deepEqual(parser.push(full.slice(mid)), ["split across reads"]);
});

test("OpenAiSseParser flips done on the [DONE] sentinel and stops parsing", () => {
  const parser = new OpenAiSseParser();
  assert.deepEqual(parser.push(chunk("partial")), ["partial"]);
  assert.equal(parser.done, false);
  assert.deepEqual(parser.push("data: [DONE]\n\n"), []);
  assert.equal(parser.done, true);
});

test("OpenAiSseParser handles a realistic mixed stream with [DONE]", () => {
  const parser = new OpenAiSseParser();
  const stream =
    chunk("docs: ") +
    chunk("update ") +
    chunk("README") +
    "data: [DONE]\n\n";
  const out: string[] = [];
  for (const s of parser.push(stream)) out.push(s);
  assert.equal(out.join(""), "docs: update README");
  assert.equal(parser.done, true);
});

test("OpenAiSseParser tolerates CRLF separators and skips non-data / blank deltas", () => {
  const parser = new OpenAiSseParser();
  const stream =
    ": a comment line\r\n\r\n" +
    "data: " +
    JSON.stringify({ choices: [{ delta: {} }] }) +
    "\r\n\r\n" +
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) +
    "\r\n\r\n";
  const out: string[] = [];
  for (const s of parser.push(stream)) out.push(s);
  assert.deepEqual(out, ["ok"]);
});

test("OpenAiSseParser skips malformed JSON payloads without throwing", () => {
  const parser = new OpenAiSseParser();
  const stream = "data: {not json}\n\n" + chunk("recovered");
  const out: string[] = [];
  for (const s of parser.push(stream)) out.push(s);
  assert.deepEqual(out, ["recovered"]);
});
