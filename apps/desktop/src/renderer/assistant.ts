// The Assistant view — an agent that automates Git/dev workflow tasks in the
// open repository using the user's OWN connected model. It streams the agent's
// reasoning and every tool call/result live, and asks for explicit approval
// before any write or destructive action (the human-in-the-loop gate).
//
// Rendered as a SectionRender so it slots into the shell's view router with no
// renderer.ts surgery beyond a nav entry. All listeners are scoped to a single
// run and torn down when it ends, so navigating away never leaks.

import { host } from "./bridge";
import { el, span, glyph, openMenu, relTimeISO } from "./ui";
import type { MenuItem } from "./ui";
import { renderMarkdown } from "./markdown";
import { confirmDialog, toast } from "./dialogs";
import type { SectionRender } from "./views/common";
import type { AgentConfirmRequest, AgentEventWire, AiModelOption, AiSettingsView, ChatView } from "../shared/ipc";

/** Agent write permission, remembered across navigations within a session. */
let permission: "read" | "write" | "destructive" = "read";
/** The explicit model id the user picked (from the provider's models). */
let selectedModelId: string | undefined;
/** Reasoning depth for the Assistant — seeded from the saved agent config. */
let thinkLevel: "off" | "auto" | "extended" = "auto";

const THINK_OPTS: Array<{ id: "off" | "auto" | "extended"; label: string }> = [
  { id: "off", label: "No thinking" },
  { id: "auto", label: "Auto thinking" },
  { id: "extended", label: "Extended thinking" },
];
const ACCESS_OPTS: Array<{ id: "read" | "write" | "destructive"; label: string }> = [
  { id: "read", label: "Read-only" },
  { id: "write", label: "Allow commits" },
  { id: "destructive", label: "Allow everything" },
];
const thinkText = (id: string): string => THINK_OPTS.find((o) => o.id === id)?.label ?? "Thinking";
const accessText = (id: string): string => ACCESS_OPTS.find((o) => o.id === id)?.label ?? "Access";
/** Trim a long model id for the chip ("anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"). */
const shortModel = (id: string): string => id.split("/").pop() ?? id;

const QUICK_ACTIONS: Array<{ icon: string; label: string; goal: string }> = [
  { icon: "git-commit", label: "Draft a commit", goal: "Draft a commit message for my staged changes and show it to me. Don't commit unless I confirm." },
  { icon: "list-unordered", label: "Summarize my changes", goal: "Summarize my current working-tree changes in a few bullet points." },
  { icon: "git-compare", label: "What does this branch add?", goal: "Compare the current branch against main and explain, concisely, what it changes." },
  { icon: "tag", label: "Draft release notes", goal: "Draft release notes from the commits since the last tag." },
];

export const renderAssistant: SectionRender = (wrap, nav) => {
  wrap.classList.add("assistant-view");

  let currentChatId: string | undefined;

  const header = el("div", "assistant-head");
  const title = el("div", "assistant-title");
  title.append(glyph("sparkle"), span("Assistant"));
  const connTag = el("span", "assistant-model");
  // New-chat + chat-history controls — sessions persist across refresh/restart.
  const newBtn = el("button", "assistant-iconbtn");
  newBtn.title = "New chat";
  newBtn.append(glyph("add"));
  newBtn.addEventListener("click", () => void newChat());
  const histBtn = el("button", "assistant-iconbtn");
  histBtn.title = "Chat history";
  histBtn.append(glyph("history"));
  histBtn.addEventListener("click", () => void openHistory());
  header.append(title, connTag, newBtn, histBtn);

  // Three compact dropdown "chips" — the agent's options shown directly here and
  // propagated from the connected provider (no Settings setup needed). Each pick
  // is remembered (persisted to the agent config).
  const controls = el("div", "assistant-controls");

  /** Build a chip whose menu items are produced fresh each open. */
  const makeChip = (icon: string, initial: string, items: () => MenuItem[]): { el: HTMLElement; set: (t: string) => void } => {
    const b = el("button", "assistant-chip-ctl");
    const ic = glyph(icon);
    const lab = span(initial, "assistant-chip-label");
    const car = glyph("chevron-down");
    car.classList.add("assistant-chip-caret");
    b.append(ic, lab, car);
    b.addEventListener("click", () => openMenu(b, items()));
    return { el: b, set: (t: string) => (lab.textContent = t) };
  };

  let modelOptions: AiModelOption[] = [];
  const modelChip = makeChip("sparkle", "Model", () => {
    if (modelOptions.length === 0) return [{ label: "No models available", disabled: true }];
    return modelOptions.map((m) => ({
      label: m.label ?? shortModel(m.id),
      current: m.id === selectedModelId,
      onClick: () => {
        selectedModelId = m.id;
        modelChip.set(shortModel(m.id));
        void host.invoke("ai:setAgentConfig", { modelId: m.id });
      },
    }));
  });
  const thinkChip = makeChip("lightbulb", thinkText(thinkLevel), () =>
    THINK_OPTS.map((o) => ({
      label: o.label,
      current: o.id === thinkLevel,
      onClick: () => {
        thinkLevel = o.id;
        thinkChip.set(o.label);
        void host.invoke("ai:setAgentConfig", { thinking: o.id });
      },
    })),
  );
  const accessChip = makeChip("shield", accessText(permission), () =>
    ACCESS_OPTS.map((o) => ({
      label: o.label,
      current: o.id === permission,
      onClick: () => {
        permission = o.id;
        accessChip.set(o.label);
        void host.invoke("ai:setAgentConfig", { permission: o.id });
      },
    })),
  );
  controls.append(modelChip.el, thinkChip.el, accessChip.el);
  header.append(controls);

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
      controls.classList.add("is-disabled");
    } else {
      const def = settings.connections.find((c) => c.id === settings!.defaultId) ?? settings.connections.find((c) => c.usable);
      connTag.textContent = def ? `· ${def.label}` : "";
      // Seed the controls from the saved agent config.
      permission = settings.agent.permission;
      thinkLevel = settings.agent.thinking;
      selectedModelId = settings.agent.modelId;
      thinkChip.set(thinkText(thinkLevel));
      accessChip.set(accessText(permission));
      // Propagate the provider's models into the picker.
      try {
        modelOptions = await host.invoke("ai:models", undefined);
      } catch {
        modelOptions = [];
      }
      if (!selectedModelId && modelOptions[0]) {
        selectedModelId = modelOptions[0].id;
      }
      modelChip.set(selectedModelId ? shortModel(selectedModelId) : "Model");
      // Restore the chat the user last had open in this repo (survives refresh).
      try {
        const cur = await host.invoke("ai:chatCurrent", undefined);
        if (cur) {
          currentChatId = cur.id;
          if (cur.turns.length > 0) restoreChat(cur);
        }
      } catch {
        /* no prior chat */
      }
    }
  })();

  function restoreChat(chat: ChatView): void {
    empty.remove();
    transcript.replaceChildren();
    for (const t of chat.turns) {
      if (t.role === "user") addBubble(transcript, "user", t.text);
      else transcript.append(markdownBlock(t.text));
    }
    scrollDown(transcript);
  }

  async function newChat(): Promise<void> {
    try {
      const chat = await host.invoke("ai:chatNew", undefined);
      currentChatId = chat?.id;
    } catch {
      currentChatId = undefined;
    }
    transcript.replaceChildren(empty);
  }

  async function openHistory(): Promise<void> {
    let chats: { id: string; title: string; updatedAt: number }[] = [];
    try {
      chats = await host.invoke("ai:chatList", undefined);
    } catch {
      chats = [];
    }
    const items: MenuItem[] = [{ label: "New chat", icon: "add", onClick: () => void newChat() }];
    if (chats.length) items.push({ separator: true });
    for (const c of chats) {
      items.push({
        label: c.title || "Untitled chat",
        sub: relTimeISO(new Date(c.updatedAt).toISOString()),
        current: c.id === currentChatId,
        onClick: () => void switchChat(c.id),
      });
    }
    openMenu(histBtn, items);
  }

  async function switchChat(id: string): Promise<void> {
    try {
      const chat = await host.invoke("ai:chatGet", { id });
      if (!chat) return;
      await host.invoke("ai:chatSetCurrent", { id });
      currentChatId = id;
      if (chat.turns.length > 0) restoreChat(chat);
      else transcript.replaceChildren(empty);
    } catch {
      /* ignore */
    }
  }

  async function runGoal(goal: string): Promise<void> {
    if (running || !goal.trim()) return;
    running = true;
    input.value = "";
    empty.remove();
    setBusy(send, true);

    // Ensure this conversation has a persisted chat (created lazily on first send).
    if (!currentChatId) {
      try {
        const chat = await host.invoke("ai:chatNew", undefined);
        currentChatId = chat?.id;
      } catch {
        currentChatId = undefined;
      }
    }
    if (!currentChatId) {
      addBubble(transcript, "user", goal);
      transcript.append(errorBlock("Couldn't start a chat — open a repository and connect a model."));
      running = false;
      setBusy(send, false);
      return;
    }

    addBubble(transcript, "user", goal);
    const turn = el("div", "assistant-turn");
    // An animated "thinking" indicator: three pulsing dots + a shimmering label +
    // a live elapsed time, so a multi-second model start-up (a local CLI boots
    // its whole agent before the first token) clearly reads as active thinking.
    const thinking = el("div", "assistant-thinking");
    const dots = el("span", "ai-think-dots");
    dots.append(el("i"), el("i"), el("i"));
    const thinkLabel = span("Thinking", "ai-think-label");
    const thinkMeta = span("", "ai-think-meta");
    thinking.append(dots, thinkLabel, thinkMeta);
    turn.append(thinking);
    transcript.append(turn);
    scrollDown(transcript);

    const state: TurnState = { turn, thinking, stream: null };
    const t0 = Date.now();
    const ticker = window.setInterval(() => {
      const s = Math.max(1, Math.round((Date.now() - t0) / 1000));
      thinkLabel.textContent = state.stream ? "Responding" : "Thinking";
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

    // A cancel affordance replaces the send button while running.
    const cancel = swapToCancel(send, () => void host.invoke("ai:cancel", { requestId }));

    try {
      const done = await host.invoke("ai:chatSend", {
        chatId: currentChatId,
        requestId,
        goal,
        allowWrite: permission !== "read",
        allowDestructive: permission === "destructive",
        modelId: selectedModelId,
        thinking: thinkLevel,
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
