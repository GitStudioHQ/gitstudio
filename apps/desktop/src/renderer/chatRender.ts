// Shared agent-chat rendering + the single turn runner used by BOTH the full
// Assistant view (assistant.ts) and the inline AI tabs in the footer dock
// (chatPanel.ts). It owns the intricate bits — live Markdown streaming, tool
// steps, the write/destructive confirm gate, the thinking indicator and the
// cancel swap — so there is ONE implementation, not two that drift apart.
//
// Everything here renders into a caller-owned transcript element; nothing holds
// view state, so it is safe to instantiate many chats at once.

import { host } from "./bridge";
import { el, span, glyph, copyText } from "./ui";
import { renderMarkdown } from "./markdown";
import { highlightProse } from "./highlight";
import { confirmDialog, toast } from "./dialogs";
import type { AgentConfirmRequest, AgentEventWire } from "../shared/ipc";

/** Per-run rendering state for one in-flight agent turn. */
export interface TurnState {
  turn: HTMLElement;
  thinking: HTMLElement;
  /** The live streaming block for the current step (null between steps). */
  stream: HTMLElement | null;
  /** Accumulated raw text for the streaming block (rendered as Markdown live). */
  raw: string;
  /** Whether a Markdown re-render is already scheduled. */
  pending: boolean;
  /** When the live block was last re-rendered, so the stream can be throttled
   *  to a readable rate rather than a frame rate. */
  lastRenderAt: number;
  /** The label shown while waiting (e.g. "Loading the agent" on a cold start). */
  status: string;
}

/** The agent options for a turn (mapped from the caller's permission/model/think). */
export interface RunTurnConfig {
  allowWrite: boolean;
  allowDestructive: boolean;
  modelId?: string;
  thinking: "off" | "auto" | "extended";
}

/**
 * Run one agent turn end-to-end: render the user bubble, show a live "thinking"
 * indicator, stream the reply as Markdown, surface tool steps + confirmations,
 * and settle. Listeners are scoped to this turn's requestId and torn down in
 * `finally`, so nothing leaks. Pass a `signal` to cancel from the outside (e.g.
 * when a footer chat tab is closed mid-stream).
 */
export async function runAgentTurn(
  transcript: HTMLElement,
  send: HTMLElement,
  chatId: string,
  goal: string,
  cfg: RunTurnConfig,
  signal?: AbortSignal,
  /** What the user bubble shows, when it should differ from the sent goal — e.g.
   *  "Analyze #42" instead of the full issue body embedded in the prompt. */
  displayText?: string,
  /** Re-runs the same goal — offered on the error card, so a turn that failed
   *  on a flaky connection is one click from trying again. */
  retry?: () => void,
): Promise<void> {
  addBubble(transcript, "user", displayText ?? goal);
  const turn = el("div", "assistant-turn");
  // An animated "thinking" indicator: three pulsing dots + a shimmering label +
  // a live elapsed time, so a multi-second model start-up (a local CLI boots its
  // whole agent before the first token) clearly reads as active thinking.
  const thinking = el("div", "assistant-thinking");
  const dots = el("span", "ai-think-dots");
  dots.append(el("i"), el("i"), el("i"));
  const thinkLabel = span("Thinking", "ai-think-label");
  const thinkMeta = span("", "ai-think-meta");
  thinking.append(dots, thinkLabel, thinkMeta);
  turn.append(thinking);
  transcript.append(turn);
  scrollDown(transcript, true); // they just pressed Send — show them their turn

  const state: TurnState = { turn, thinking, stream: null, raw: "", pending: false, lastRenderAt: 0, status: "Thinking" };
  const t0 = Date.now();
  const ticker = window.setInterval(() => {
    const s = Math.max(1, Math.round((Date.now() - t0) / 1000));
    thinkLabel.textContent = state.stream ? "Responding" : state.status;
    thinkMeta.textContent = `${s}s`;
  }, 250);

  const requestId = crypto.randomUUID();
  const offDelta = host.on("ai:delta", (e) => {
    if (e.requestId === requestId) onDelta(state, e.delta);
  });
  const offEvent = host.on("ai:agentEvent", (e) => {
    if (e.requestId === requestId) onEvent(state, e);
  });
  // THIS turn's life, so anything waiting on it can be ended with it. The
  // caller's `signal` cancels from outside; Stop and the `finally` below fire
  // it too, so an approval dialog is never left behind by any of the three.
  const turn$ = new AbortController();
  signal?.addEventListener("abort", () => turn$.abort(), { once: true });
  const offConfirm = host.on("ai:confirmRequest", (c) => {
    if (c.requestId === requestId) void onConfirm(requestId, c, turn$.signal);
  });
  const onAbort = (): void => void host.invoke("ai:cancel", { requestId });
  signal?.addEventListener("abort", onAbort, { once: true });

  // A cancel affordance replaces the send button while running.
  const cancel = swapToCancel(send, () => {
    turn$.abort(); // close a pending approval before the run goes away
    void host.invoke("ai:cancel", { requestId });
  });

  try {
    const done = await host.invoke("ai:chatSend", {
      chatId,
      requestId,
      goal,
      allowWrite: cfg.allowWrite,
      allowDestructive: cfg.allowDestructive,
      modelId: cfg.modelId,
      thinking: cfg.thinking,
    });
    // Was the reader at the tail BEFORE the turn's last block goes in? Asked
    // after, the block it just appended is exactly what puts them "away from
    // the bottom", so a turn whose whole answer arrives at the end — no
    // streaming, which is every non-streaming provider — landed below the fold
    // and the settle at the end of `finally` politely declined to move.
    const stickAtEnd = atBottom(transcript);
    finalizeStream(state);
    thinking.remove();
    if (!done.ok && done.message) {
      turn.append(errorBlock(done.message, retry));
    } else if (done.text && !turn.querySelector(".assistant-msg")) {
      turn.append(markdownBlock(done.text));
    }
    if (stickAtEnd) scrollDown(transcript, true);
  } catch (e) {
    // SETTLE the half-written answer first. `is-streaming` draws a blinking
    // caret after the last line, and this path did not remove it — so a turn
    // that failed mid-sentence left its partial reply apparently still being
    // typed, for as long as the chat stayed open, with an error underneath it.
    // The `!done.ok` path above already goes through `finalizeStream`.
    finalizeStream(state);
    thinking.remove();
    turn.append(errorBlock(e instanceof Error ? e.message : String(e), retry));
  } finally {
    window.clearInterval(ticker);
    offDelta();
    offEvent();
    offConfirm();
    signal?.removeEventListener("abort", onAbort);
    // The turn is over however it ended — a dialog still waiting on it is
    // waiting for something that cannot answer.
    turn$.abort();
    cancel.restore();
    scrollDown(transcript);
  }
}

// ── Streaming + event rendering ──────────────────────────────────────────────

/** Append a streamed text delta and re-render the block as Markdown (live). */
export function onDelta(state: TurnState, delta: string): void {
  const wrap = state.turn.parentElement as HTMLElement;
  const stick = atBottom(wrap);
  if (!state.stream) {
    state.stream = el("div", "assistant-msg gh-body-md is-streaming");
    state.turn.insertBefore(state.stream, state.thinking);
    state.raw = "";
  }
  state.raw += delta;
  scheduleStreamRender(state);
  if (stick) scrollDown(wrap, true);
}

/**
 * Re-render the live block as Markdown, at most ten times a second.
 *
 * Every render parses and re-renders the WHOLE message so far, so the work is
 * quadratic in its length: a 10,360-character reply arriving in 20-character
 * deltas produced 600 renders, 5.3 million characters of HTML and 148,191
 * elements created and thrown away — to end at 493 elements.
 *
 * A frame-rate latch made that one render per FRAME, which on a fast stream is
 * sixty a second. Ten is still faster than anyone reads, and it cuts the
 * renders by roughly six on a quick answer and three on a long one. It lowers
 * the constant; it does not remove the quadratic, which needs the settled part
 * of the message to stop being re-parsed at all.
 *
 * Dropping the last tick is safe: both settle paths re-render the whole message
 * unconditionally — `finalizeStream` below and the "assistant" event — so the
 * final text never depends on a timer having fired. And the body is guarded on
 * `state.stream`, so a tick that lands after the turn ends does nothing.
 */
const STREAM_RENDER_MS = 100;
/** How long a due paint waits for an animation frame before painting anyway
 *  (the log pane's fallback is the same 80 ms). */
const STREAM_FRAME_FALLBACK_MS = 80;

function scheduleStreamRender(state: TurnState): void {
  if (state.pending || !state.stream) return;
  state.pending = true;
  const paint = (): void => {
    state.pending = false;
    if (!state.stream) return;
    // The reader's place is measured HERE, at the write, not in onDelta: the
    // delta scrolled before this throttled paint grew the block, so a paint
    // that added more than a line's worth left them behind the tail — and
    // every later delta then read them as "scrolled up" and stopped
    // following. Streaming quietly lost the reader partway through any long
    // answer.
    const wrap = state.turn.parentElement;
    const stick = atBottom(wrap);
    state.stream.innerHTML = renderMarkdown(state.raw);
    if (stick) scrollDown(wrap, true);
  };
  const since = Date.now() - state.lastRenderAt;
  if (since >= STREAM_RENDER_MS) {
    // Due now: keep the animation frame, so the paint still lands with the
    // browser's own rhythm rather than between two of them — or on a timer if
    // no frame comes. A window that is occluded or minimised is served NO
    // frames, and this was rAF alone: `pending` then stayed true, every later
    // delta returned at the guard above, and the answer stopped painting until
    // the window was shown again (the log pane's scheduleScrollFrame learned
    // the same). Whichever fires first paints and cancels the other; a visible
    // window's frame always comes well inside the fallback.
    let frame = 0;
    let timer = 0;
    const once = (): void => {
      if (!frame && !timer) return;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = 0;
      timer = 0;
      state.lastRenderAt = Date.now();
      paint();
    };
    frame = requestAnimationFrame(once);
    timer = window.setTimeout(once, STREAM_FRAME_FALLBACK_MS);
    return;
  }
  window.setTimeout(() => {
    state.lastRenderAt = Date.now();
    paint();
  }, STREAM_RENDER_MS - since);
}

/** Settle the live streaming block when its step completes. */
export function finalizeStream(state: TurnState): void {
  if (state.stream) {
    state.stream.classList.remove("is-streaming");
    if (state.raw.trim()) {
      const block = state.stream;
      block.innerHTML = renderMarkdown(state.raw);
      // The block is FINISHED, so highlight it — `markdownBlock` does this for
      // every other rendered answer, and a streamed one is the same content.
      // Without it a reply's code fences stayed monochrome until you left the
      // chat and came back, at which point the restore path rendered the same
      // text through `markdownBlock` and it gained colour: the same message,
      // two different appearances, for no reason the reader can see.
      //
      // NOT in `scheduleStreamRender` — that runs per animation frame on a
      // block whose fences are still arriving, so it would tokenize a fragment
      // dozens of times and paint half-finished syntax.
      highlightProse(block);
      decorateMessage(block, state.raw);
    }
    state.stream = null;
    state.raw = "";
  }
}

/** Apply one structured agent event to the active turn. */
export function onEvent(state: TurnState, e: AgentEventWire): void {
  const { turn, thinking } = state;
  const wrap = turn.parentElement as HTMLElement;
  const stick = atBottom(wrap);
  switch (e.kind) {
    case "status":
      // A pre-token status (e.g. "Loading the agent…" on a cold start).
      if (e.text && e.text.trim()) state.status = e.text.trim();
      break;
    case "assistant":
      // The step's text finished — render the final Markdown.
      if (state.stream) {
        const text = e.text && e.text.trim() ? e.text : state.raw;
        const block = state.stream;
        block.innerHTML = renderMarkdown(text);
        block.classList.remove("is-streaming");
        highlightProse(block); // settled — see finalizeStream
        decorateMessage(block, text);
        state.stream = null;
        state.raw = "";
      } else if (e.text && e.text.trim()) {
        turn.insertBefore(markdownBlock(e.text), thinking);
      }
      break;
    case "tool_call":
      finalizeStream(state); // close any open text block before the tool step
      turn.insertBefore(toolStep(e), thinking);
      break;
    case "tool_result": {
      const step = turn.querySelector<HTMLElement>(`.assistant-tool[data-call="${e.callId}"]`);
      if (step) finishToolStep(step, e);
      break;
    }
    case "tool_denied": {
      const step = turn.querySelector<HTMLElement>(`.assistant-tool[data-call="${e.callId}"]`);
      step?.classList.add("is-denied");
      break;
    }
    case "error":
      finalizeStream(state);
      turn.insertBefore(errorBlock(e.text ?? "The agent hit an error."), thinking);
      break;
    default:
      break;
  }
  if (stick) scrollDown(wrap, true);
}

/** Render the confirm dialog for a write/destructive tool and answer the agent. */
export async function onConfirm(
  requestId: string,
  c: AgentConfirmRequest,
  /** Ends with the TURN. Without it, pressing Stop finished the run in the main
   *  process and left this dialog on screen — and its Approve button then
   *  posted an approval for a run that no longer existed. */
  signal?: AbortSignal,
): Promise<void> {
  const approved = await confirmDialog({
    title: c.mode === "destructive" ? "Approve destructive action" : "Approve action",
    message: c.summary,
    confirmLabel: c.mode === "destructive" ? "Yes, do it" : "Approve",
    danger: c.mode === "destructive",
    signal,
  });
  // A turn that has been stopped has nothing to answer. Posting `false` here
  // would be harmless but pointless; posting `true` after a Stop is the bug.
  if (signal?.aborted) return;
  await host.invoke("ai:agentConfirm", { requestId, callId: c.callId, approved });
  if (!approved) toast("Action declined.", "info");
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

export function addBubble(transcript: HTMLElement, who: "user", text: string): void {
  const b = el("div", `assistant-bubble is-${who}`);
  b.textContent = text;
  transcript.append(b);
}

export function markdownBlock(md: string): HTMLElement {
  const block = el("div", "assistant-msg gh-body-md");
  block.innerHTML = renderMarkdown(md);
  highlightProse(block);
  decorateMessage(block, md);
  return block;
}

/** What each rendered answer was made from, for Copy. */
const sources = new WeakMap<HTMLElement, string>();

/** A settled answer gets its copy button — copying the Markdown it was made
 *  from, so a code fence comes out as a code fence. Called after every
 *  innerHTML write, since each one throws the previous button away. */
function decorateMessage(block: HTMLElement, src: string): void {
  if (!src.trim()) return;
  sources.set(block, src);
  block.querySelector(":scope > .assistant-copy")?.remove();
  const btn = el("button", "assistant-copy");
  btn.title = "Copy this answer (as Markdown)";
  btn.setAttribute("aria-label", "Copy this answer");
  btn.append(glyph("copy"));
  btn.addEventListener("click", () => void copyText(sources.get(block) ?? "", "Copied the answer."));
  block.append(btn);
}

function toolStep(e: AgentEventWire): HTMLElement {
  const step = el("div", "assistant-tool");
  step.dataset.call = e.callId ?? "";
  const head = el("div", "assistant-tool-head");
  head.append(glyph("tools"));
  const name = el("span", "assistant-tool-name");
  name.textContent = (e.tool ?? "tool").replace(/^git_/, "").replace(/_/g, " ");
  head.append(name);
  const argPreview = argSummary(e.args);
  if (argPreview) {
    const a = el("span", "assistant-tool-arg");
    a.textContent = argPreview;
    head.append(a);
  }
  const spin = glyph("loading");
  spin.classList.add("assistant-tool-spin");
  head.append(spin);
  step.append(head);
  return step;
}

function finishToolStep(step: HTMLElement, e: AgentEventWire): void {
  step.querySelector(".assistant-tool-spin")?.remove();

  // A DECLINED action is not an error, and its result text is not for you.
  //
  // `tool_denied` lands first and marks the step; the agent then emits a
  // tool_result carrying the sentence it feeds back to the MODEL — "The user
  // declined to run this action. Do not retry it; adapt or stop and explain."
  // That was rendered like any other failure: a red step with a warning glyph,
  // whose body instructed the person who had just made the decision not to
  // retry it.
  if (step.classList.contains("is-denied")) {
    const said = span("Declined", "assistant-tool-verdict");
    const status = glyph("circle-slash");
    status.classList.add("assistant-tool-status");
    step.querySelector(".assistant-tool-head")?.append(said, status);
    return;
  }

  step.classList.toggle("is-error", e.isError === true);
  const status = glyph(e.isError ? "error" : "check");
  status.classList.add("assistant-tool-status");
  step.querySelector(".assistant-tool-head")?.append(status);
  if (e.text && e.text.trim()) {
    const out = el("pre", "assistant-tool-out");
    const txt = e.text.length > 1200 ? e.text.slice(0, 1200) + "\n…" : e.text;
    out.textContent = txt;
    // Collapsed by default; the head toggles it.
    out.hidden = true;
    step.append(out);
    step.querySelector(".assistant-tool-head")?.addEventListener("click", () => (out.hidden = !out.hidden));
    step.classList.add("is-expandable");
  }
}

function argSummary(args?: Record<string, unknown>): string {
  if (!args) return "";
  if (typeof args.message === "string") return `“${args.message.split("\n")[0]}”`;
  if (typeof args.name === "string") return args.name;
  if (typeof args.ref === "string") return args.ref;
  if (typeof args.path === "string") return args.path;
  if (Array.isArray(args.paths)) return (args.paths as string[]).join(", ");
  if (typeof args.base === "string") return `${args.base}…${(args.head as string) ?? "HEAD"}`;
  if (typeof args.query === "string") return `“${args.query}”`;
  if (args.all === true) return "all";
  return "";
}

export function errorBlock(msg: string, retry?: () => void): HTMLElement {
  const b = el("div", "assistant-error");
  b.append(glyph("error"), span(msg, "assistant-error-text"));
  if (retry) {
    const again = el("button", "mini-btn assistant-retry");
    again.append(glyph("refresh"), span("Try again"));
    again.addEventListener("click", () => {
      b.remove();
      retry();
    });
    b.append(again);
  }
  return b;
}

export function connectPrompt(nav: (view: string) => void): HTMLElement {
  const wrap = el("div", "assistant-empty");
  wrap.append(
    glyph("sparkle"),
    elText("div", "assistant-empty-title", "Connect a model to use the Assistant"),
    elText(
      "div",
      "assistant-empty-sub",
      "Bring your own key — Claude, OpenAI, Gemini and more — or run a local model. Your subscription, your data.",
    ),
  );
  const btn = el("button", "btn btn-primary");
  btn.append(glyph("gear"), span("Open AI settings"));
  btn.addEventListener("click", () => nav("settings"));
  wrap.append(btn);
  return wrap;
}

export function elText(tag: string, cls: string, text: string): HTMLElement {
  const e = el(tag, cls);
  e.textContent = text;
  return e;
}

export function setBusy(btn: HTMLElement, busy: boolean): void {
  (btn as HTMLButtonElement).disabled = busy;
}

/** Swap the send button into a Cancel button for the duration of a run. */
export function swapToCancel(send: HTMLElement, onCancel: () => void): { restore: () => void } {
  const original = send.innerHTML;
  // The RESTING title, not a hardcoded one. Restoring "Send" unconditionally
  // dropped the keyboard hint after the first turn and — worse — handed a
  // composer that went gated mid-run a title claiming it could still send.
  const originalTitle = send.title;
  (send as HTMLButtonElement).disabled = false;
  send.classList.add("is-cancel");
  // A single filled square. `codicon-stop-circle` is two thin concentric
  // outlines — a circle inside a circular button, which mushes at this size.
  send.replaceChildren(glyph("debug-stop"));
  send.title = "Stop";
  const handler = (ev: Event): void => {
    ev.stopImmediatePropagation();
    onCancel();
  };
  send.addEventListener("click", handler, true);
  return {
    restore() {
      send.removeEventListener("click", handler, true);
      send.classList.remove("is-cancel");
      send.innerHTML = original;
      send.title = originalTitle;
      (send as HTMLButtonElement).disabled = false;
    },
  };
}

/** Is the reader at the bottom RIGHT NOW?
 *
 *  Must be asked BEFORE the new content goes in. Asking afterwards compares
 *  the old scrollTop against a scrollHeight that has already grown by exactly
 *  the block just inserted, so a reader sitting at the tail measures as one
 *  block behind it and the autoscroll that should carry them along declines to.
 *  The log pane takes its anchor before appending for the same reason. */
export function atBottom(container: HTMLElement | null): boolean {
  if (!container) return false;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 24;
}

/** Keep the newest content in view — but ONLY for a reader who is already at
 *  the bottom.
 *
 *  This was unconditional, and it is called on every streamed token. Scrolling
 *  up to re-read what the agent said thirty seconds ago lasted until the next
 *  delta arrived, which is to say a fraction of a second: the transcript
 *  snapped back to the tail, every time, for the whole length of a run. The
 *  job log had the identical defect and the same complaint about it — nothing
 *  in the app may move the viewport while the reader is reading something.
 *
 *  `force` is for the moments the reader DID ask: sending a message, opening a
 *  chat, and switching to a tab. */
export function scrollDown(container: HTMLElement | null, force = false): void {
  if (!container) return;
  if (!force && !atBottom(container)) return;
  container.scrollTop = container.scrollHeight;
}
