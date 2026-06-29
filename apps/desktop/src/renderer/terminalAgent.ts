// Terminal agent mode — an in-terminal panel onto GitStudio's existing AI agent.
//
// This deliberately touches ZERO shared AI code: it drives the same IPC the
// sidebar Assistant uses (ai:agentRun / ai:delta / ai:agentEvent /
// ai:confirmRequest / ai:agentConfirm / ai:settings) and reuses the existing
// .assistant-* styles. "Agent-agnostic": it runs whatever model/provider is
// configured as the default. Shell commands the agent proposes get an "Insert
// in terminal" button (writes to the prompt for the user to run) — we never
// auto-run anything in the user's shell.

import { host } from "./bridge";
import { el, glyph, span } from "./ui";
import { renderMarkdown } from "./markdown";
import { confirmDialog } from "./dialogs";
import type { AgentEventWire } from "../shared/ipc";

type Permission = "read" | "write" | "destructive";

export interface TerminalAgentOptions {
  /** Whether the shell is at a prompt (gates "Insert in terminal"). */
  atPrompt: () => boolean;
  /** Put `cmd` on the prompt line for the user to run (never auto-runs). */
  insertCommand: (cmd: string) => void;
  /** Called after the panel closes (e.g. to restore terminal focus). */
  onClose?: () => void;
}

interface TurnState {
  turn: HTMLElement;
  thinking: HTMLElement;
  stream: HTMLElement | null;
}

export class TerminalAgent {
  private readonly root: HTMLElement;
  private readonly transcript: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly modelLabel: HTMLElement;
  private permission: Permission = "read";
  private open = false;
  private busy = false;
  private settingsLoaded = false;
  private enabled = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: TerminalAgentOptions,
  ) {
    this.root = el("div", "term-agent");
    this.root.style.display = "none";

    // Header: title · model · permission segmented · close.
    const head = el("div", "term-agent-head");
    const title = el("div", "term-agent-title");
    title.append(glyph("sparkle"), span("Agent", "term-agent-title-text"));
    this.modelLabel = span("", "term-agent-model");
    const perm = this.buildPermission();
    const close = el("button", "term-agent-close") as HTMLButtonElement;
    close.append(glyph("close"));
    close.title = "Close agent (Esc)";
    close.addEventListener("click", () => this.close());
    head.append(title, this.modelLabel, perm, close);

    this.transcript = el("div", "term-agent-body");

    const inputRow = el("div", "term-agent-input-row");
    this.input = el("textarea", "term-agent-input") as HTMLTextAreaElement;
    this.input.rows = 1;
    this.input.placeholder = "Ask the agent to do something…";
    this.input.addEventListener("keydown", (e) => this.onInputKey(e));
    this.input.addEventListener("input", () => this.autosize());
    this.sendBtn = el("button", "term-agent-send") as HTMLButtonElement;
    this.sendBtn.append(glyph("send"));
    this.sendBtn.title = "Send (Enter)";
    this.sendBtn.addEventListener("click", () => void this.submit());
    inputRow.append(this.input, this.sendBtn);

    this.root.append(head, this.transcript, inputRow);
    this.container.appendChild(this.root);
  }

  // ── Open / close ──────────────────────────────────────────────────────────────

  toggle(): void {
    this.open ? this.close() : void this.show();
  }

  async show(): Promise<void> {
    this.open = true;
    this.root.style.display = "";
    this.input.focus();
    if (!this.settingsLoaded) await this.loadSettings();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.style.display = "none";
    this.opts.onClose?.();
  }

  isOpen(): boolean {
    return this.open;
  }

  private async loadSettings(): Promise<void> {
    this.settingsLoaded = true;
    try {
      const s = await host.invoke("ai:settings", undefined);
      this.enabled = s.enabled;
      const def = s.connections.find((c) => c.id === s.defaultId) ?? s.connections[0];
      this.modelLabel.textContent = def ? `via ${def.label}` : "no model";
      this.permission = s.agent?.permission ?? "read";
      this.syncPermission();
      if (!this.enabled) {
        this.input.placeholder = "Connect a model in Settings to use the agent…";
        this.input.disabled = true;
        this.sendBtn.disabled = true;
      }
    } catch {
      this.modelLabel.textContent = "";
    }
  }

  // ── Permission segmented control ──────────────────────────────────────────────

  private permButtons: Record<Permission, HTMLButtonElement> = {} as never;

  private buildPermission(): HTMLElement {
    const seg = el("div", "term-agent-perm");
    const mk = (p: Permission, label: string): void => {
      const b = el("button", "term-agent-perm-btn") as HTMLButtonElement;
      b.textContent = label;
      b.title = `Permission: ${p}`;
      b.addEventListener("click", () => {
        this.permission = p;
        this.syncPermission();
      });
      this.permButtons[p] = b;
      seg.appendChild(b);
    };
    mk("read", "Read");
    mk("write", "Write");
    mk("destructive", "All");
    return seg;
  }

  private syncPermission(): void {
    for (const p of ["read", "write", "destructive"] as Permission[]) {
      this.permButtons[p]?.classList.toggle("is-active", p === this.permission);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────────

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.submit();
    }
  }

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  private async submit(): Promise<void> {
    const goal = this.input.value.trim();
    if (!goal || this.busy || !this.enabled) return;
    this.input.value = "";
    this.autosize();
    await this.runGoal(goal);
  }

  // ── Agent run (reuses the Assistant's IPC contract) ────────────────────────────

  private async runGoal(goal: string): Promise<void> {
    this.busy = true;
    this.sendBtn.disabled = true;

    this.addBubble("user", goal);
    const turn = el("div", "assistant-turn");
    const thinking = el("div", "assistant-thinking");
    const dots = el("span", "ai-think-dots");
    dots.append(el("i"), el("i"), el("i"));
    thinking.append(dots, span("Thinking", "ai-think-label"));
    turn.appendChild(thinking);
    this.transcript.appendChild(turn);
    this.scrollDown();

    const state: TurnState = { turn, thinking, stream: null };
    const requestId = crypto.randomUUID();

    const offDelta = host.on("ai:delta", (e) => {
      if (e.requestId === requestId) this.onDelta(state, e.delta);
    });
    const offEvent = host.on("ai:agentEvent", (e) => {
      if (e.requestId === requestId) this.onEvent(state, e);
    });
    const offConfirm = host.on("ai:confirmRequest", (c) => {
      if (c.requestId === requestId) void this.onConfirm(requestId, c);
    });

    try {
      const done = await host.invoke("ai:agentRun", {
        requestId,
        goal,
        allowWrite: this.permission !== "read",
        allowDestructive: this.permission === "destructive",
      });
      this.finalizeStream(state);
      if (!done.ok && done.message) {
        turn.appendChild(this.errorBlock(done.message));
      } else if (done.text && !turn.querySelector(".assistant-msg")) {
        turn.appendChild(this.markdownBlock(done.text));
      }
    } catch (err) {
      this.finalizeStream(state);
      turn.appendChild(this.errorBlock(String(err)));
    } finally {
      offDelta();
      offEvent();
      offConfirm();
      thinking.remove();
      this.busy = false;
      this.sendBtn.disabled = !this.enabled;
      this.scrollDown();
    }
  }

  private onDelta(state: TurnState, delta: string): void {
    if (!state.stream) {
      state.stream = el("div", "assistant-msg is-streaming");
      state.turn.insertBefore(state.stream, state.thinking);
    }
    state.stream.textContent += delta;
    this.scrollDown();
  }

  private onEvent(state: TurnState, e: AgentEventWire): void {
    switch (e.kind) {
      case "assistant":
        if (state.stream) {
          this.renderInto(state.stream, state.stream.textContent ?? "");
          state.stream.classList.remove("is-streaming");
          state.stream = null;
        } else if (e.text?.trim()) {
          state.turn.insertBefore(this.markdownBlock(e.text), state.thinking);
        }
        break;
      case "tool_call":
        this.finalizeStream(state);
        state.turn.insertBefore(this.toolCard(e), state.thinking);
        break;
      case "tool_result": {
        const card = state.turn.querySelector<HTMLElement>(`.assistant-tool[data-call="${e.callId}"]`);
        if (card) this.finishToolCard(card, e);
        break;
      }
      case "tool_denied": {
        const card = state.turn.querySelector<HTMLElement>(`.assistant-tool[data-call="${e.callId}"]`);
        card?.classList.add("is-denied");
        break;
      }
      case "error":
        this.finalizeStream(state);
        state.turn.insertBefore(this.errorBlock(e.text ?? "Error"), state.thinking);
        break;
    }
    this.scrollDown();
  }

  private async onConfirm(requestId: string, c: { callId: string; title: string; summary: string; mode: string }): Promise<void> {
    const approved = await confirmDialog({
      title: c.mode === "destructive" ? "Approve destructive action" : "Approve action",
      message: c.summary,
      confirmLabel: c.mode === "destructive" ? "Yes, do it" : "Approve",
      danger: c.mode === "destructive",
    });
    await host.invoke("ai:agentConfirm", { requestId, callId: c.callId, approved });
  }

  // ── Transcript building blocks ────────────────────────────────────────────────

  private addBubble(role: "user" | "assistant", text: string): void {
    const b = el("div", `assistant-bubble is-${role}`);
    b.textContent = text;
    this.transcript.appendChild(b);
    this.scrollDown();
  }

  private markdownBlock(text: string): HTMLElement {
    const d = el("div", "assistant-msg");
    this.renderInto(d, text);
    return d;
  }

  /** Render markdown into `host`, then wire "Insert in terminal" on shell blocks. */
  private renderInto(target: HTMLElement, text: string): void {
    target.innerHTML = renderMarkdown(text);
    for (const pre of Array.from(target.querySelectorAll("pre"))) {
      const code = pre.querySelector("code")?.textContent ?? "";
      if (!code.trim()) continue;
      const bar = el("div", "term-agent-codebar");
      const singleLine = !code.trim().includes("\n");
      const btn = el("button", "term-agent-run") as HTMLButtonElement;
      if (singleLine) {
        btn.append(glyph("terminal"), span("Insert in terminal"));
        btn.addEventListener("click", () => {
          if (!this.opts.atPrompt()) return;
          // Put it on the prompt line; the user reviews and presses Enter.
          this.opts.insertCommand(code.trim());
          this.close();
        });
      } else {
        btn.append(glyph("copy"), span("Copy"));
        btn.addEventListener("click", () => void navigator.clipboard?.writeText(code).catch(() => {}));
      }
      bar.appendChild(btn);
      pre.appendChild(bar);
    }
  }

  private toolCard(e: AgentEventWire): HTMLElement {
    const card = el("div", "assistant-tool");
    if (e.callId) card.dataset.call = e.callId;
    const headEl = el("div", "assistant-tool-head");
    headEl.append(glyph("tools"), span(e.tool ?? "tool", "assistant-tool-name"));
    const spin = glyph("loading");
    spin.classList.add("loading");
    headEl.appendChild(spin);
    card.appendChild(headEl);
    return card;
  }

  private finishToolCard(card: HTMLElement, e: AgentEventWire): void {
    card.querySelector(".loading")?.remove();
    const ok = !e.isError;
    const mark = glyph(ok ? "check" : "error");
    mark.classList.add(ok ? "is-ok" : "is-error");
    card.querySelector(".assistant-tool-head")?.appendChild(mark);
  }

  private errorBlock(text: string): HTMLElement {
    const d = el("div", "assistant-error");
    d.textContent = text;
    return d;
  }

  private finalizeStream(state: TurnState): void {
    if (!state.stream) return;
    this.renderInto(state.stream, state.stream.textContent ?? "");
    state.stream.classList.remove("is-streaming");
    state.stream = null;
  }

  private scrollDown(): void {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  dispose(): void {
    this.root.remove();
  }
}
