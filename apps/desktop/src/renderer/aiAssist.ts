// Reusable inline-AI affordances surfaced across the app (Changes, Compare, PRs,
// Issues): a ✨ chip button, a helper that opens a named, conversational AI chat
// tab in the footer dock (Explain / Review / Analyze / Draft a comment), and a
// "stream straight into a textarea" helper (commit messages / comment drafts).
// The chat tabs run on the persistent agent backend (ai:chat*); the textarea
// helper runs the one-shot ai:task. Both reuse the Assistant's model + keys.

import { host } from "./bridge";
import { el, span, glyph, cleanErr } from "./ui";
import { toast } from "./dialogs";
import type { AssistantTabRequest } from "./terminalDock";
import type { AiTaskInput, AiTaskName } from "../shared/ipc";

let enabledCache: boolean | undefined;

/** Whether any AI model is connected (gates the ✨ affordances). Cached. */
export async function aiEnabled(): Promise<boolean> {
  if (enabledCache !== undefined) return enabledCache;
  try {
    enabledCache = (await host.invoke("ai:settings", undefined)).enabled;
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

/** Drop the cached enabled-state so the next aiEnabled() re-checks. Call after any
 *  change to model connections (connect / remove / set key) so the ✨ affordances
 *  appear or disappear without a full reload. */
export function invalidateAiEnabled(): void {
  enabledCache = undefined;
}

/** A small ✨ action chip. */
export function aiChip(label: string, onClick: () => void, icon = "sparkle"): HTMLElement {
  const b = el("button", "ai-chip");
  b.append(glyph(icon), span(label));
  b.addEventListener("click", onClick);
  return b;
}

/** Run a task, streaming text deltas through onDelta; resolves with the outcome. */
export async function streamTask(
  task: AiTaskName,
  input: AiTaskInput,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text?: string; message?: string }> {
  const requestId = crypto.randomUUID();
  const off = host.on("ai:delta", (e) => {
    if (e.requestId === requestId) onDelta(e.delta);
  });
  if (signal) {
    signal.addEventListener("abort", () => void host.invoke("ai:cancel", { requestId }), { once: true });
  }
  try {
    return await host.invoke("ai:task", { requestId, task, input });
  } catch (e) {
    return { ok: false, message: cleanErr(e) };
  } finally {
    off();
  }
}

// ── Footer AI chat tabs ──────────────────────────────────────────────────────
// The ✨ Explain / Review / Analyze / Draft actions open a named, conversational
// tab in the footer dock instead of a dead-end modal. aiAssist stays decoupled
// from the dock: the shell registers the opener once the dock is mounted.

let tabOpener: ((req: AssistantTabRequest) => void) | undefined;

/** Register the footer-dock opener. The shell calls this once after creating the
 *  TerminalDock, so aiAssist need not import it (avoids a layering cycle). */
export function registerAssistantTab(open: (req: AssistantTabRequest) => void): void {
  tabOpener = open;
}

/** Open a named, seeded AI chat tab in the footer dock. Falls back to a toast if
 *  no dock is mounted yet (e.g. before a repository is open). */
export function openAssistantTab(req: AssistantTabRequest): void {
  if (tabOpener) tabOpener(req);
  else toast("Open a repository to use the Assistant.", "info");
}

/**
 * Stream a task's result directly into a textarea (commit messages, comment
 * drafts). Disables the trigger button while running; replaces the field's text.
 */
export async function streamInto(
  task: AiTaskName,
  input: AiTaskInput,
  textarea: HTMLTextAreaElement,
  btn?: HTMLButtonElement,
): Promise<void> {
  const original = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.replaceChildren(glyph("loading"), span("Writing…"));
  }
  const prev = textarea.value;
  textarea.value = "";
  let got = false;
  const res = await streamTask(task, input, (d) => {
    got = true;
    textarea.value += d;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (btn) {
    btn.disabled = false;
    if (original) btn.innerHTML = original;
  }
  if (!res.ok || (!got && !res.text)) {
    textarea.value = prev; // restore on failure
    toast(res.message ?? "Couldn't generate that.", "error");
    return;
  }
  if (!got && res.text) {
    textarea.value = res.text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.value = textarea.value.trim();
  textarea.focus();
}
