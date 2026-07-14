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
import { runAgentTurn, addBubble, markdownBlock, errorBlock, connectPrompt, elText, setBusy, scrollDown } from "./chatRender";
import type { SectionRender } from "./views/common";
import type { AiModelOption, AiSettingsView, ChatView } from "../shared/ipc";

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

    try {
      await runAgentTurn(transcript, send, currentChatId, goal, {
        allowWrite: permission !== "read",
        allowDestructive: permission === "destructive",
        modelId: selectedModelId,
        thinking: thinkLevel,
      });
    } finally {
      running = false;
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
