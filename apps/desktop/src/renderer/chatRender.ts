// Shared agent-chat rendering + the single turn runner used by BOTH the full
// Assistant view (assistant.ts) and the inline AI tabs in the footer dock
// (chatPanel.ts). It owns the intricate bits — live Markdown streaming, tool
// steps, the write/destructive confirm gate, the thinking indicator and the
// cancel swap — so there is ONE implementation, not two that drift apart.
//
// Everything here renders into a caller-owned transcript element; nothing holds
// view state, so it is safe to instantiate many chats at once.

import { host } from "./bridge";
import { el, span, glyph } from "./ui";
import { renderMarkdown } from "./markdown";
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
  /** Whether a Markdown re-render is already scheduled this frame. */
  pending: boolean;
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
  scrollDown(transcript);

  const state: TurnState = { turn, thinking, stream: null, raw: "", pending: false, status: "Thinking" };
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
  const offConfirm = host.on("ai:confirmRequest", (c) => {
    if (c.requestId === requestId) void onConfirm(requestId, c);
  });
  const onAbort = (): void => void host.invoke("ai:cancel", { requestId });
  signal?.addEventListener("abort", onAbort, { once: true });

  // A cancel affordance replaces the send button while running.
  const cancel = swapToCancel(send, () => void host.invoke("ai:cancel", { requestId }));

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
    finalizeStream(state);
    thinking.remove();
    if (!done.ok && done.message) {
      turn.append(errorBlock(done.message));
    } else if (done.text && !turn.querySelector(".assistant-msg")) {
      turn.append(markdownBlock(done.text));
    }
  } catch (e) {
    thinking.remove();
    turn.append(errorBlock(e instanceof Error ? e.message : String(e)));
  } finally {
    window.clearInterval(ticker);
    offDelta();
    offEvent();
    offConfirm();
    signal?.removeEventListener("abort", onAbort);
    cancel.restore();
    scrollDown(transcript);
  }
}

// ── Streaming + event rendering ──────────────────────────────────────────────

/** Append a streamed text delta and re-render the block as Markdown (live). */
export function onDelta(state: TurnState, delta: string): void {
  if (!state.stream) {
    state.stream = el("div", "assistant-msg is-streaming");
    state.turn.insertBefore(state.stream, state.thinking);
    state.raw = "";
  }
  state.raw += delta;
  scheduleStreamRender(state);
  scrollDown(state.turn.parentElement as HTMLElement);
}

/** Re-render the live block as Markdown, at most once per animation frame. */
function scheduleStreamRender(state: TurnState): void {
  if (state.pending || !state.stream) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    if (state.stream) state.stream.innerHTML = renderMarkdown(state.raw);
  });
}

/** Settle the live streaming block when its step completes. */
export function finalizeStream(state: TurnState): void {
  if (state.stream) {
    state.stream.classList.remove("is-streaming");
    if (state.raw.trim()) state.stream.innerHTML = renderMarkdown(state.raw);
    state.stream = null;
    state.raw = "";
  }
}

/** Apply one structured agent event to the active turn. */
export function onEvent(state: TurnState, e: AgentEventWire): void {
  const { turn, thinking } = state;
  switch (e.kind) {
    case "status":
      // A pre-token status (e.g. "Loading the agent…" on a cold start).
      if (e.text && e.text.trim()) state.status = e.text.trim();
      break;
    case "assistant":
      // The step's text finished — render the final Markdown.
      if (state.stream) {
        const text = e.text && e.text.trim() ? e.text : state.raw;
        state.stream.innerHTML = renderMarkdown(text);
        state.stream.classList.remove("is-streaming");
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
  scrollDown(turn.parentElement as HTMLElement);
}

/** Render the confirm dialog for a write/destructive tool and answer the agent. */
export async function onConfirm(requestId: string, c: AgentConfirmRequest): Promise<void> {
  const approved = await confirmDialog({
    title: c.mode === "destructive" ? "Approve destructive action" : "Approve action",
    message: c.summary,
    confirmLabel: c.mode === "destructive" ? "Yes, do it" : "Approve",
    danger: c.mode === "destructive",
  });
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
  const block = el("div", "assistant-msg");
  block.innerHTML = renderMarkdown(md);
  return block;
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

export function errorBlock(msg: string): HTMLElement {
  const b = el("div", "assistant-error");
  b.append(glyph("error"), span(msg));
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
  (send as HTMLButtonElement).disabled = false;
  send.classList.add("is-cancel");
  send.replaceChildren(glyph("stop-circle"));
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
      send.title = "Send";
      (send as HTMLButtonElement).disabled = false;
    },
  };
}

export function scrollDown(container: HTMLElement | null): void {
  if (container) container.scrollTop = container.scrollHeight;
}
