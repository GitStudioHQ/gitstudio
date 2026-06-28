// The Assistant view — an agent that automates Git/dev workflow tasks in the
// open repository using the user's OWN connected model. It streams the agent's
// reasoning and every tool call/result live, and asks for explicit approval
// before any write or destructive action (the human-in-the-loop gate).
//
// Rendered as a SectionRender so it slots into the shell's view router with no
// renderer.ts surgery beyond a nav entry. All listeners are scoped to a single
// run and torn down when it ends, so navigating away never leaks.

import { host } from "./bridge";
import { el, span, glyph } from "./ui";
import { renderMarkdown } from "./markdown";
import { confirmDialog, toast } from "./dialogs";
import type { SectionRender } from "./views/common";
import type { AgentConfirmRequest, AgentEventWire, AiSettingsView } from "../shared/ipc";

/** Agent write permission, remembered across navigations within a session. */
let permission: "read" | "write" | "destructive" = "read";
/** Which model tier the Assistant uses — "fast" is the snappiest. */
let speed: "fast" | "mid" | "deep" = "mid";

const QUICK_ACTIONS: Array<{ icon: string; label: string; goal: string }> = [
  { icon: "git-commit", label: "Draft a commit", goal: "Draft a commit message for my staged changes and show it to me. Don't commit unless I confirm." },
  { icon: "list-unordered", label: "Summarize my changes", goal: "Summarize my current working-tree changes in a few bullet points." },
  { icon: "git-compare", label: "What does this branch add?", goal: "Compare the current branch against main and explain, concisely, what it changes." },
  { icon: "tag", label: "Draft release notes", goal: "Draft release notes from the commits since the last tag." },
];

export const renderAssistant: SectionRender = (wrap, nav) => {
  wrap.classList.add("assistant-view");

  const header = el("div", "assistant-head");
  const title = el("div", "assistant-title");
  title.append(glyph("sparkle"), span("Assistant"));
  const modelTag = el("span", "assistant-model");
  header.append(title, modelTag);

  const permBar = el("div", "assistant-perm");
  const permLabel = el("span", "assistant-perm-label");
  permLabel.textContent = "Permissions";
  const seg = el("div", "settings-seg assistant-perm-seg");
  const perms: Array<{ id: typeof permission; label: string; title: string }> = [
    { id: "read", label: "Read-only", title: "The agent can inspect but not modify the repo." },
    { id: "write", label: "Allow commits", title: "The agent may stage, commit, branch and stash — each needs your approval." },
    { id: "destructive", label: "Allow all", title: "Also allow discard / reset / delete — each needs your approval." },
  ];
  const permBtns: HTMLElement[] = [];
  for (const p of perms) {
    const b = el("button", "settings-seg-btn" + (permission === p.id ? " active" : ""));
    b.title = p.title;
    b.append(span(p.label));
    b.addEventListener("click", () => {
      permission = p.id;
      permBtns.forEach((x) => x.classList.toggle("active", x === b));
    });
    permBtns.push(b);
    seg.append(b);
  }
  permBar.append(permLabel, seg);
  header.append(permBar);

  // Speed selector: lets the user trade quality for a snappier first token
  // (maps to the connection's fast/mid/deep model — e.g. sonnet vs opus).
  const speedBar = el("div", "assistant-perm");
  const speedLabel = el("span", "assistant-perm-label");
  speedLabel.textContent = "Speed";
  const speedSeg = el("div", "settings-seg assistant-perm-seg");
  const speeds: Array<{ id: typeof speed; label: string; title: string }> = [
    { id: "fast", label: "Fast", title: "Use the connection's fast model — snappiest replies." },
    { id: "mid", label: "Balanced", title: "Use the standard model." },
    { id: "deep", label: "Deep", title: "Use the most capable model — best quality, slowest to start." },
  ];
  const speedBtns: HTMLElement[] = [];
  for (const sp of speeds) {
    const b = el("button", "settings-seg-btn" + (speed === sp.id ? " active" : ""));
    b.title = sp.title;
    b.append(span(sp.label));
    b.addEventListener("click", () => {
      speed = sp.id;
      speedBtns.forEach((x) => x.classList.toggle("active", x === b));
    });
    speedBtns.push(b);
    speedSeg.append(b);
  }
  speedBar.append(speedLabel, speedSeg);
  header.append(speedBar);

  const transcript = el("div", "assistant-transcript");
  const composer = el("div", "assistant-composer");
  const quick = el("div", "assistant-quick");
  for (const qa of QUICK_ACTIONS) {
    const chip = el("button", "assistant-chip");
    chip.append(glyph(qa.icon), span(qa.label));
    chip.addEventListener("click", () => void runGoal(qa.goal));
    quick.append(chip);
  }
  const inputRow = el("div", "assistant-input-row");
  const input = document.createElement("textarea");
  input.className = "assistant-input";
  input.rows = 2;
  input.placeholder = "Ask the agent to do something in this repo…";
  const send = el("button", "btn btn-primary assistant-send");
  send.append(glyph("send"));
  send.title = "Send";
  inputRow.append(input, send);
  composer.append(quick, inputRow);

  wrap.append(header, transcript, composer);

  let running = false;

  const empty = el("div", "assistant-empty");
  empty.append(
    glyph("sparkle"),
    elText("div", "assistant-empty-title", "Your repo's AI agent"),
    elText(
      "div",
      "assistant-empty-sub",
      "It reads real status, diffs and history before acting — and asks before it writes. Try a quick action, or describe a task.",
    ),
  );
  transcript.append(empty);

  // Gate on a usable connection.
  void (async () => {
    let settings: AiSettingsView | undefined;
    try {
      settings = await host.invoke("ai:settings", undefined);
    } catch {
      settings = undefined;
    }
    if (!settings || !settings.enabled) {
      transcript.replaceChildren(connectPrompt(nav));
      input.disabled = true;
      (send as HTMLButtonElement).disabled = true;
      permBtns.forEach((b) => ((b as HTMLButtonElement).disabled = true));
    } else {
      const def = settings.connections.find((c) => c.id === settings!.defaultId) ?? settings.connections.find((c) => c.usable);
      modelTag.textContent = def ? `via ${def.label}` : "";
    }
  })();

  async function runGoal(goal: string): Promise<void> {
    if (running || !goal.trim()) return;
    running = true;
    input.value = "";
    empty.remove();
    setBusy(send, true);

    addBubble(transcript, "user", goal);
    const turn = el("div", "assistant-turn");
    const thinking = el("div", "assistant-thinking");
    const thinkLabel = span("Thinking…");
    thinking.append(glyph("loading"), thinkLabel);
    turn.append(thinking);
    transcript.append(turn);
    scrollDown(transcript);

    const state: TurnState = { turn, thinking, stream: null };
    // A live elapsed counter so a multi-second model start-up reads as "working",
    // not "frozen" (Claude Code's first token can take a few seconds).
    const t0 = Date.now();
    const ticker = window.setInterval(() => {
      const s = Math.max(1, Math.round((Date.now() - t0) / 1000));
      thinkLabel.textContent = state.stream ? `Responding… ${s}s` : `Thinking… ${s}s`;
    }, 500);
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

    // A cancel affordance replaces the send button while running.
    const cancel = swapToCancel(send, () => void host.invoke("ai:cancel", { requestId }));

    try {
      const done = await host.invoke("ai:agentRun", {
        requestId,
        goal,
        allowWrite: permission !== "read",
        allowDestructive: permission === "destructive",
        model: speed,
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
      cancel.restore();
      running = false;
      scrollDown(transcript);
    }
  }

  send.addEventListener("click", () => void runGoal(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runGoal(input.value);
    }
  });
};

/** Per-run rendering state for the active assistant turn. */
interface TurnState {
  turn: HTMLElement;
  thinking: HTMLElement;
  /** The live, plain-text streaming block for the current step (null between steps). */
  stream: HTMLElement | null;
}

/** Append a streamed text delta, creating the live block on first token. */
function onDelta(state: TurnState, delta: string): void {
  if (!state.stream) {
    state.stream = el("div", "assistant-msg is-streaming");
    state.turn.insertBefore(state.stream, state.thinking);
  }
  state.stream.textContent = (state.stream.textContent ?? "") + delta;
  scrollDown(state.turn.parentElement as HTMLElement);
}

/** Re-render the live streaming block as Markdown once its step completes. */
function finalizeStream(state: TurnState): void {
  if (state.stream) {
    const text = state.stream.textContent ?? "";
    state.stream.classList.remove("is-streaming");
    if (text.trim()) state.stream.innerHTML = renderMarkdown(text);
    state.stream = null;
  }
}

/** Apply one structured agent event to the active turn. */
function onEvent(state: TurnState, e: AgentEventWire): void {
  const { turn, thinking } = state;
  switch (e.kind) {
    case "assistant":
      // The step's text finished. If we streamed it, render that block as
      // Markdown; otherwise (a non-streaming fallback) insert a fresh block.
      if (state.stream) {
        if (e.text && e.text.trim()) state.stream.innerHTML = renderMarkdown(e.text);
        state.stream.classList.remove("is-streaming");
        state.stream = null;
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
async function onConfirm(requestId: string, c: AgentConfirmRequest): Promise<void> {
  const approved = await confirmDialog({
    title: c.mode === "destructive" ? "Approve destructive action" : "Approve action",
    message: c.summary,
    confirmLabel: c.mode === "destructive" ? "Yes, do it" : "Approve",
    danger: c.mode === "destructive",
  });
  await host.invoke("ai:agentConfirm", { requestId, callId: c.callId, approved });
  if (!approved) toast("Action declined.", "info");
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

function addBubble(transcript: HTMLElement, who: "user", text: string): void {
  const b = el("div", `assistant-bubble is-${who}`);
  b.textContent = text;
  transcript.append(b);
}

function markdownBlock(md: string): HTMLElement {
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

function errorBlock(msg: string): HTMLElement {
  const b = el("div", "assistant-error");
  b.append(glyph("error"), span(msg));
  return b;
}

function connectPrompt(nav: (view: string) => void): HTMLElement {
  const wrap = el("div", "assistant-empty");
  wrap.append(
    glyph("sparkle"),
    elText("div", "assistant-empty-title", "Connect a model to use the Assistant"),
    elText("div", "assistant-empty-sub", "Bring your own key — Claude, OpenAI, Gemini and more — or run a local model. Your subscription, your data."),
  );
  const btn = el("button", "btn btn-primary");
  btn.append(glyph("gear"), span("Open AI settings"));
  btn.addEventListener("click", () => nav("settings"));
  wrap.append(btn);
  return wrap;
}

function elText(tag: string, cls: string, text: string): HTMLElement {
  const e = el(tag, cls);
  e.textContent = text;
  return e;
}

function setBusy(btn: HTMLElement, busy: boolean): void {
  (btn as HTMLButtonElement).disabled = busy;
}

/** Swap the send button into a Cancel button for the duration of a run. */
function swapToCancel(send: HTMLElement, onCancel: () => void): { restore: () => void } {
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

function scrollDown(container: HTMLElement | null): void {
  if (container) container.scrollTop = container.scrollHeight;
}
