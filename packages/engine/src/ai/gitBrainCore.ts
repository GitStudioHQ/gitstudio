// Pure, host-agnostic helpers for the GitBrain AI layer (M10): an Anthropic SSE
// stream parser, a token-ish diff truncator, and the prompt/system-prefix
// builders. No vscode / node / fs imports — this stays unit-testable and lets
// the same logic power the future desktop app. The provider classes that touch
// `fetch`, SecretStorage, and `vscode.lm` live in apps/extension/src/ai.

/** Commit-message styling the user can pick (gitstudio.ai.commitStyle). */
export type CommitStyle = "conventional" | "concise" | "descriptive";

/**
 * A rough chars-per-token ratio. The real tokenizer lives server-side; we only
 * need a conservative budget so a giant staged diff can't blow the context
 * window (or the bill). ~4 chars/token is the usual English/code approximation.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Truncate a diff to roughly `maxTokens` tokens before sending it to the model.
 *
 * Pure and deterministic: cuts on a line boundary at or under the char budget
 * (never mid-line, so we don't ship half a hunk), and appends a visible marker
 * noting how many lines were dropped. Returns the diff unchanged when it already
 * fits. A non-positive budget yields just the marker (nothing of the diff).
 */
export function truncateDiff(diff: string, maxTokens = 6000): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (diff.length <= maxChars) {
    return diff;
  }

  const lines = diff.split("\n");
  const kept: string[] = [];
  let used = 0;
  let keptCount = 0;
  for (const line of lines) {
    // +1 for the newline we'll rejoin with.
    const cost = line.length + 1;
    if (used + cost > maxChars) {
      break;
    }
    kept.push(line);
    used += cost;
    keptCount++;
  }

  const dropped = lines.length - keptCount;
  const marker =
    `\n\n[… diff truncated: ${dropped} more line${dropped === 1 ? "" : "s"} ` +
    `omitted to stay within the model budget …]`;
  return kept.join("\n") + marker;
}

/**
 * Build the stable, cacheable system prefix from the repo's recent commit
 * subjects. Putting the unchanging style context here (and the volatile diff in
 * the user message) is what makes Anthropic prompt caching pay off across calls.
 *
 * Stays deterministic — no timestamps, no per-request IDs — so the cached prefix
 * is byte-identical between requests until the recent-commit list actually moves.
 */
export function buildCommitStyleSystem(
  recentSubjects: readonly string[],
  style: CommitStyle,
): string {
  const styleGuide = COMMIT_STYLE_GUIDE[style];
  const examples = recentSubjects
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 10);

  const exampleBlock =
    examples.length > 0
      ? "Recent commit subjects from this repository, for tone and convention:\n" +
        examples.map((s) => `- ${s}`).join("\n")
      : "";

  return [
    "You are GitBrain, an assistant embedded in the GitStudio Git client. You write commit messages.",
    styleGuide,
    exampleBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

const COMMIT_STYLE_GUIDE: Record<CommitStyle, string> = {
  conventional:
    "Write a Conventional Commit. The subject is `type(scope): summary` " +
    "(types: feat, fix, docs, style, refactor, perf, test, build, ci, chore; " +
    "scope optional). Keep the subject under ~72 characters, imperative mood, " +
    "no trailing period. Add a short body only when it adds real context.",
  concise:
    "Write a single concise subject line: imperative mood, under ~60 " +
    "characters, no trailing period, no body.",
  descriptive:
    "Write a clear imperative subject line (under ~72 characters, no trailing " +
    "period), then a blank line, then a short body explaining what changed and " +
    "why.",
};

/**
 * Build the user-message prompt for drafting a commit message. The (already
 * truncated) staged diff goes here — after the cacheable system prefix — so the
 * volatile part never invalidates the cache.
 */
export function buildCommitPrompt(truncatedDiff: string): string {
  return (
    "Write a commit message for the following staged changes. " +
    "Output ONLY the commit message text — no surrounding prose, no code fences, " +
    "no leading 'Commit message:' label.\n\n" +
    "Staged diff:\n```diff\n" +
    truncatedDiff +
    "\n```"
  );
}

/** Prompt for the explain-diff feature (rendered as Markdown). */
export function buildExplainPrompt(truncatedDiff: string): string {
  return (
    "Explain the following diff for a reviewer. Summarize what changed and why " +
    "it likely matters, call out anything risky, and keep it tight. Use Markdown.\n\n" +
    "```diff\n" +
    truncatedDiff +
    "\n```"
  );
}

/** Prompt for the summarize-changes feature (rendered as Markdown). */
export function buildSummarizePrompt(truncatedDiff: string): string {
  return (
    "Summarize the following changes in a few bullet points a teammate could " +
    "skim. Group related edits; don't restate every line. Use Markdown.\n\n" +
    "```diff\n" +
    truncatedDiff +
    "\n```"
  );
}

/**
 * Prompt for a PR description (used later by M11). `commits` is the list of
 * subject lines on the branch; `truncatedDiff` is the combined diff vs. base.
 */
export function buildPrDescriptionPrompt(
  commits: readonly string[],
  truncatedDiff: string,
): string {
  const commitList =
    commits.length > 0
      ? "Commits on this branch:\n" + commits.map((c) => `- ${c}`).join("\n")
      : "No distinct commits provided.";
  return (
    "Write a pull-request description in Markdown with a short summary and a " +
    "bulleted list of notable changes. Be concrete; don't pad.\n\n" +
    commitList +
    "\n\nCombined diff:\n```diff\n" +
    truncatedDiff +
    "\n```"
  );
}

// ── Anthropic SSE parsing ────────────────────────────────────────────────────

/**
 * A tiny, push-driven state machine for Anthropic's `/v1/messages` SSE stream.
 *
 * Feed it raw decoded byte-chunks via `push(chunk)`; it buffers across chunk
 * boundaries, parses complete `event:`/`data:` blocks (separated by a blank
 * line), and returns the assembled text deltas from `content_block_delta`
 * events whose `delta.type === "text_delta"`. `message_stop` flips `done`.
 *
 * Kept dependency-free and synchronous so it unit-tests with a hand-written byte
 * sequence and no network. The provider drives it; this class never touches I/O.
 */
export class AnthropicSseParser {
  private buffer = "";
  private _done = false;

  /** True once a `message_stop` event has been seen. */
  get done(): boolean {
    return this._done;
  }

  /**
   * Feed one decoded chunk; returns any newly-assembled text-delta strings (in
   * order). Concatenate them to build the streamed message text.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];

    // SSE events are separated by a blank line ("\n\n"). Process each complete
    // block; leave a trailing partial in the buffer for the next chunk.
    let sep = this.indexOfBlankLine();
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      this.handleBlock(block, out);
      sep = this.indexOfBlankLine();
    }
    return out;
  }

  /** Find the next blank-line separator, tolerating both \n\n and \r\n\r\n. */
  private indexOfBlankLine(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) {
      return -1;
    }
    if (crlf === -1 || (lf !== -1 && lf < crlf)) {
      return { index: lf, length: 2 };
    }
    return { index: crlf, length: 4 };
  }

  private handleBlock(block: string, out: string[]): void {
    // A block can carry an `event:` line and one or more `data:` lines. We only
    // need the data payload; the event name is advisory (the JSON has `type`).
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        // Per SSE, a single leading space after the colon is stripped.
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      this._done = true;
      return;
    }

    let json: AnthropicStreamEvent;
    try {
      json = JSON.parse(payload) as AnthropicStreamEvent;
    } catch {
      // A malformed/partial data payload — skip it rather than throw into a
      // stream consumer. (A truly split JSON would have buffered above.)
      return;
    }

    if (json.type === "message_stop") {
      this._done = true;
      return;
    }
    if (
      json.type === "content_block_delta" &&
      json.delta?.type === "text_delta" &&
      typeof json.delta.text === "string"
    ) {
      out.push(json.delta.text);
    }
  }
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
}

/**
 * Extract the concatenated text from a non-streaming Anthropic `/v1/messages`
 * response body. Joins the text of every `type === "text"` content block and
 * guards `stop_reason === "refusal"` (which may carry empty content).
 *
 * Returns `null` on a refusal or when there's no text to surface, so callers can
 * treat "no usable output" uniformly. Pure: takes the already-parsed JSON.
 */
export function extractAnthropicText(
  body: AnthropicMessageResponse,
): string | null {
  if (body.stop_reason === "refusal") {
    return null;
  }
  if (!Array.isArray(body.content)) {
    return null;
  }
  const text = body.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ── OpenAI-compatible parsing ────────────────────────────────────────────────
//
// One shape covers OpenAI, Codex, OpenRouter, Ollama, LM Studio, and any
// `/chat/completions` server — they all return the same `choices[].message`
// (non-streaming) and `choices[].delta` (streaming SSE) envelopes. These helpers
// stay pure so the provider that touches `fetch` can be unit-tested without a
// network: feed sample bytes/JSON and assert the assembled text.

/**
 * Extract the assistant text from a non-streaming OpenAI-compatible
 * `/chat/completions` response body: `choices[0].message.content`.
 *
 * Returns `null` when there's no usable text (empty/missing choices, a
 * non-string content, or a content that trims to nothing) so callers can treat
 * "no output" uniformly. Pure: takes the already-parsed JSON.
 */
export function extractOpenAiText(
  body: OpenAiChatResponse,
): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const content = choices[0]?.message?.content;
  if (typeof content !== "string") {
    return null;
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
}

/**
 * A tiny, push-driven state machine for the OpenAI-compatible `/chat/completions`
 * SSE stream (`stream: true`).
 *
 * Feed it raw decoded byte-chunks via `push(chunk)`; it buffers across chunk
 * boundaries, parses complete `data:` blocks (separated by a blank line), and
 * returns the assembled `choices[0].delta.content` strings in order. The literal
 * `data: [DONE]` sentinel flips `done` (and is never parsed as JSON).
 *
 * Kept dependency-free and synchronous so it unit-tests with a hand-written byte
 * sequence and no network. The provider drives it; this class never touches I/O.
 */
export class OpenAiSseParser {
  private buffer = "";
  private _done = false;

  /** True once a `data: [DONE]` sentinel has been seen. */
  get done(): boolean {
    return this._done;
  }

  /**
   * Feed one decoded chunk; returns any newly-assembled content-delta strings
   * (in order). Concatenate them to build the streamed message text.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];

    let sep = this.indexOfBlankLine();
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      this.handleBlock(block, out);
      sep = this.indexOfBlankLine();
    }
    return out;
  }

  /** Find the next blank-line separator, tolerating both \n\n and \r\n\r\n. */
  private indexOfBlankLine(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) {
      return -1;
    }
    if (crlf === -1 || (lf !== -1 && lf < crlf)) {
      return { index: lf, length: 2 };
    }
    return { index: crlf, length: 4 };
  }

  private handleBlock(block: string, out: string[]): void {
    // A block may carry comment lines (`:`) and one or more `data:` lines.
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        // Per SSE, a single leading space after the colon is stripped.
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      this._done = true;
      return;
    }

    let json: OpenAiStreamChunk;
    try {
      json = JSON.parse(payload) as OpenAiStreamChunk;
    } catch {
      // A malformed/partial data payload — skip it rather than throw into a
      // stream consumer. (A truly split JSON would have buffered above.)
      return;
    }

    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      out.push(delta);
    }
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
}
