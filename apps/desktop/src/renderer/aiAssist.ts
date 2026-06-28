// Reusable inline-AI affordances surfaced across the app (Changes, Compare, PRs,
// Issues): a ✨ chip button, a streaming result sheet that renders Markdown live,
// and a "stream straight into a textarea" helper (for commit messages / comment
// drafts). Everything runs through the existing ai:task IPC, so the model, keys
// and streaming all reuse the Assistant's plumbing.

import { host } from "./bridge";
import { el, span, glyph, copyText, cleanErr } from "./ui";
import { renderMarkdown } from "./markdown";
import { toast } from "./dialogs";
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

interface SheetOptions {
  title: string;
  task: AiTaskName;
  input: AiTaskInput;
  /** When set, an "Insert" button hands the result back (e.g. into a comment box). */
  onInsert?: (text: string) => void;
  insertLabel?: string;
}

/** Open a modal sheet that streams a task's Markdown result, with copy/insert. */
export function aiSheet(opts: SheetOptions): void {
  const overlay = el("div", "ai-sheet-overlay");
  const panel = el("div", "ai-sheet");

  const head = el("div", "ai-sheet-head");
  const spinner = glyph("loading");
  spinner.classList.add("ai-sheet-spin");
  const closeBtn = el("button", "icon-btn");
  closeBtn.append(glyph("close"));
  head.append(glyph("sparkle"), span(opts.title, "ai-sheet-title"), spinner, closeBtn);

  const body = el("div", "ai-sheet-body assistant-msg");
  const foot = el("div", "ai-sheet-foot");
  panel.append(head, body, foot);
  overlay.append(panel);
  document.body.append(overlay);

  const abort = new AbortController();
  const close = (): void => {
    abort.abort();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Live-render the streamed Markdown (throttled to one paint per frame).
  let raw = "";
  let pending = false;
  const renderLive = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      body.innerHTML = renderMarkdown(raw);
      body.scrollTop = body.scrollHeight;
    });
  };

  void streamTask(
    opts.task,
    opts.input,
    (d) => {
      raw += d;
      renderLive();
    },
    abort.signal,
  ).then((res) => {
    spinner.remove();
    if (!res.ok) {
      body.innerHTML = "";
      const err = el("div", "ai-sheet-error");
      err.append(glyph("error"), span(res.message ?? "The request failed."));
      body.append(err);
      return;
    }
    const text = (res.text ?? raw).trim();
    body.innerHTML = renderMarkdown(text);
    // Footer actions appear once there's a result.
    const copy = el("button", "mini-btn");
    copy.append(glyph("copy"), span("Copy"));
    copy.addEventListener("click", () => void copyText(text, "Copied."));
    foot.append(copy);
    if (opts.onInsert) {
      const insert = el("button", "btn btn-primary");
      insert.append(glyph("insert"), span(opts.insertLabel ?? "Insert"));
      insert.addEventListener("click", () => {
        opts.onInsert!(text);
        close();
      });
      foot.append(insert);
    }
  });
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
