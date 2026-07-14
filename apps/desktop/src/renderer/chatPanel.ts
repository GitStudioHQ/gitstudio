// A self-contained agent-chat panel for the footer dock's inline AI tabs. Each
// ✨ action (Explain / Review / Analyze / Draft a comment) opens one of these as
// a named, closable tab: the action's prompt is auto-sent as the opening turn,
// the reply streams in, and the user can keep asking follow-ups — a real
// conversation, not the dead-end modal it replaces.
//
// It reuses the exact streaming / tool-step / confirm plumbing the full
// Assistant view uses (chatRender.runAgentTurn) and the persistent chat backend
// (ai:chat*), so every footer chat is a first-class, persisted conversation.

import { host } from "./bridge";
import { el, glyph } from "./ui";
import { runAgentTurn, addBubble, errorBlock, connectPrompt, setBusy, scrollDown } from "./chatRender";
import type { AiSettingsView } from "../shared/ipc";

export interface ChatPanelOptions {
  /** Auto-sent as the opening turn — the AI action that spawned this tab. May
   *  embed large context (an issue body, a PR description). */
  seedGoal: string;
  /** A short label shown as the opening user bubble in place of the full goal
   *  (e.g. the tab title "Analyze #42"). Defaults to the goal itself. */
  seedLabel?: string;
  /** Navigate the shell (for the "connect a model" CTA when AI is off). */
  nav?: (view: string) => void;
}

export class ChatPanel {
  /** The panel root — the dock mounts this as the tab's surface. */
  readonly el: HTMLElement;
  private readonly transcript: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLElement;

  private chatId?: string;
  private running = false;
  private disposed = false;
  private modelId?: string;
  private thinking: "off" | "auto" | "extended" = "auto";
  /** Aborts the in-flight turn (and tells the main process to cancel) on close. */
  private readonly abort = new AbortController();

  constructor(private readonly opts: ChatPanelOptions) {
    this.el = el("div", "chat-panel");

    this.transcript = el("div", "assistant-transcript chat-panel-transcript");

    const composer = el("div", "assistant-composer chat-panel-composer");
    const inputRow = el("div", "assistant-input-row");
    this.input = document.createElement("textarea");
    this.input.className = "assistant-input";
    this.input.rows = 1;
    this.input.placeholder = "Ask a follow-up…";
    this.send = el("button", "btn btn-primary assistant-send");
    this.send.append(glyph("send"));
    this.send.title = "Send";
    inputRow.append(this.input, this.send);
    composer.append(inputRow);

    this.el.append(this.transcript, composer);

    this.send.addEventListener("click", () => void this.runGoal(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter (and ⌘/Ctrl+Enter) insert a newline.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void this.runGoal(this.input.value);
      }
    });

    void this.start();
  }

  /** Gate on a usable model, then auto-send the seeding action. */
  private async start(): Promise<void> {
    let settings: AiSettingsView | undefined;
    try {
      settings = await host.invoke("ai:settings", undefined);
    } catch {
      settings = undefined;
    }
    if (this.disposed) return;
    if (!settings || !settings.enabled) {
      this.transcript.replaceChildren(connectPrompt(this.opts.nav ?? (() => undefined)));
      this.input.disabled = true;
      (this.send as HTMLButtonElement).disabled = true;
      return;
    }
    this.modelId = settings.agent.modelId;
    this.thinking = settings.agent.thinking;
    void this.runGoal(this.opts.seedGoal, true);
  }

  /** Send a turn. The seeding turn keeps the composer empty; follow-ups clear it. */
  private async runGoal(goal: string, fromSeed = false): Promise<void> {
    if (this.disposed || this.running || !goal.trim()) return;
    this.running = true;
    if (!fromSeed) this.input.value = "";
    setBusy(this.send, true);

    // Lazily create the persisted chat backing this tab — but NOT as the repo's
    // "current" chat, so opening a footer tab never disturbs the full Assistant.
    if (!this.chatId) {
      try {
        const chat = await host.invoke("ai:chatNew", { setCurrent: false });
        this.chatId = chat?.id;
      } catch {
        this.chatId = undefined;
      }
    }
    if (this.disposed) return;
    if (!this.chatId) {
      addBubble(this.transcript, "user", goal);
      this.transcript.append(errorBlock("Couldn't start a chat — open a repository and connect a model."));
      this.running = false;
      setBusy(this.send, false);
      return;
    }

    try {
      // Footer chats are read-only by design: explain / review / analyze / draft
      // never mutate the repo, so there is no write-confirmation friction. The
      // seeding turn shows a short label (the tab title) rather than the full
      // context-laden prompt; follow-ups show what the user typed.
      await runAgentTurn(
        this.transcript,
        this.send,
        this.chatId,
        goal,
        { allowWrite: false, allowDestructive: false, modelId: this.modelId, thinking: this.thinking },
        this.abort.signal,
        fromSeed ? this.opts.seedLabel : undefined,
      );
    } finally {
      this.running = false;
      if (!this.disposed) this.input.focus();
    }
  }

  /** Called by the dock when this tab becomes active — land focus in the input. */
  reveal(): void {
    scrollDown(this.transcript);
    if (!this.input.disabled) this.input.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort(); // cancel any in-flight turn in the main process
    this.el.remove();
  }
}
