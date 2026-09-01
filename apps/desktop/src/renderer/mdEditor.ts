// The markdown editor, shared.
//
// Release notes, issue bodies, issue comments, PR descriptions and gist
// descriptions were each a bare `<textarea class="modal-input modal-textarea">`
// — no preview, no toolbar, no paste handling, no keyboard beyond what a
// textarea gives you for free. The owner's words about two of them: "editing a
// release is complete garbage compared to github ui ux" and "Same goes for
// issues creating and editing".
//
// One component, five callers. Two things in it are deliberately better than
// the reference:
//
//   · PREVIEW RENDERS THROUGH THE REAL RENDERER. `renderMarkdown` is the same
//     function that draws a published issue body, so preview and published
//     output cannot drift. GitHub runs a separate preview implementation and
//     they differ in practice.
//   · ⌘Enter SUBMITS from inside the field. Every one of these forms had its
//     primary button somewhere the text had already scrolled past.

import { el, span, glyph } from "./ui";
import { renderMarkdown } from "./markdown";

export interface MdEditorOpts {
  value?: string;
  placeholder?: string;
  /** Visible rows before it grows. */
  rows?: number;
  /** Called on every keystroke — for a draft store, or to enable a Save. */
  onInput?: (value: string) => void;
  /** ⌘/Ctrl+Enter. Without one, the key does nothing. */
  onSubmit?: () => void;
  /** Accessible name for the text area. */
  label?: string;
  /**
   * Fill the height the container gives it instead of growing with the text.
   *
   * Auto-grow is right inside a modal, where the editor is one field among
   * several. On a composer PAGE the body is the page: growing to half the
   * window and then scrolling a box inside a box is the same "the window is
   * too small" complaint in a different surface.
   */
  fill?: boolean;
}

export interface MdEditor {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  get(): string;
  set(v: string): void;
  focus(): void;
}

/** A toolbar button: what it does to the selection. */
interface Tool {
  icon: string;
  title: string;
  /** Wrap the selection, e.g. `**` for bold. */
  wrap?: string;
  /** Prefix each selected LINE, e.g. "> " for quote. */
  linePrefix?: string;
  key?: string;
}

const TOOLS: Tool[] = [
  { icon: "bold", title: "Bold  ⌘B", wrap: "**", key: "b" },
  { icon: "italic", title: "Italic  ⌘I", wrap: "_", key: "i" },
  { icon: "code", title: "Code", wrap: "`" },
  { icon: "link", title: "Link  ⌘K", wrap: "[](url)", key: "k" },
  { icon: "quote", title: "Quote", linePrefix: "> " },
  { icon: "list-unordered", title: "Bulleted list", linePrefix: "- " },
  { icon: "list-ordered", title: "Numbered list", linePrefix: "1. " },
  { icon: "tasklist", title: "Task list", linePrefix: "- [ ] " },
];

/** Apply a tool to the current selection, keeping the caret sensible. */
function applyTool(ta: HTMLTextAreaElement, t: Tool): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);

  if (t.linePrefix) {
    // Whole lines, so a prefix applied to a selection spanning three lines
    // marks three lines rather than gluing itself to the middle of the first.
    const from = ta.value.lastIndexOf("\n", start - 1) + 1;
    const to = ta.value.indexOf("\n", end);
    const stop = to === -1 ? ta.value.length : to;
    const block = ta.value.slice(from, stop);
    const already = block.split("\n").every((l) => l.startsWith(t.linePrefix!));
    const next = block
      .split("\n")
      .map((l) => (already ? l.slice(t.linePrefix!.length) : t.linePrefix! + l))
      .join("\n");
    ta.setRangeText(next, from, stop, "select");
    return;
  }

  const w = t.wrap ?? "";
  if (w === "[](url)") {
    // A link keeps the selection as the TEXT and puts the caret on the url,
    // which is the part that still needs typing.
    const text = selected || "text";
    ta.setRangeText(`[${text}](url)`, start, end, "end");
    const urlAt = start + text.length + 3;
    ta.setSelectionRange(urlAt, urlAt + 3);
    return;
  }
  // Toggling off, when the selection is already wrapped.
  if (selected.startsWith(w) && selected.endsWith(w) && selected.length >= w.length * 2) {
    ta.setRangeText(selected.slice(w.length, -w.length), start, end, "select");
    return;
  }
  ta.setRangeText(`${w}${selected}${w}`, start, end, selected ? "select" : "end");
  if (!selected) {
    const caret = start + w.length;
    ta.setSelectionRange(caret, caret);
  }
}

/** The list marker a line starts with, if any — for continuation on Enter. */
function listMarker(line: string): string | undefined {
  const m = /^(\s*)(-\s\[[ xX]\]\s|[-*+]\s|\d+\.\s)/.exec(line);
  if (!m) return undefined;
  // A finished task box continues as an empty one, not a ticked one.
  return `${m[1]}${m[2].replace(/\[[xX]\]/, "[ ]")}`;
}

export function mdEditor(opts: MdEditorOpts = {}): MdEditor {
  const root = el("div", "md-editor" + (opts.fill ? " md-fill" : ""));

  // ── Write | Preview ───────────────────────────────────────────────────────
  const tabs = el("div", "md-tabs");
  const writeTab = el("button", "md-tab is-active") as HTMLButtonElement;
  writeTab.textContent = "Write";
  writeTab.setAttribute("role", "tab");
  const previewTab = el("button", "md-tab") as HTMLButtonElement;
  previewTab.textContent = "Preview";
  previewTab.setAttribute("role", "tab");
  tabs.append(writeTab, previewTab);

  const bar = el("div", "md-toolbar");
  const ta = document.createElement("textarea");
  ta.className = "md-text";
  ta.rows = opts.rows ?? 10;
  ta.placeholder = opts.placeholder ?? "Write something…";
  ta.value = opts.value ?? "";
  if (opts.label) ta.setAttribute("aria-label", opts.label);

  const preview = el("div", "gh-body-md md-preview");
  preview.hidden = true;

  for (const t of TOOLS) {
    const b = el("button", "md-tool") as HTMLButtonElement;
    b.append(glyph(t.icon));
    b.title = t.title;
    b.setAttribute("aria-label", t.title);
    b.tabIndex = -1; // the toolbar is a shortcut, not a tab stop before the text
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret
    b.addEventListener("click", () => {
      applyTool(ta, t);
      ta.focus();
      opts.onInput?.(ta.value);
    });
    bar.appendChild(b);
  }

  const head = el("div", "md-head");
  head.append(tabs, bar);

  const show = (mode: "write" | "preview"): void => {
    const writing = mode === "write";
    writeTab.classList.toggle("is-active", writing);
    previewTab.classList.toggle("is-active", !writing);
    writeTab.setAttribute("aria-selected", String(writing));
    previewTab.setAttribute("aria-selected", String(!writing));
    ta.hidden = !writing;
    preview.hidden = writing;
    bar.hidden = !writing;
    if (!writing) {
      // The REAL renderer, so preview cannot disagree with what gets published.
      const text = ta.value.trim();
      preview.innerHTML = text
        ? renderMarkdown(text)
        : `<p class="md-preview-empty">Nothing to preview yet.</p>`;
      // Match the text area's height so switching tabs does not jump the form.
      preview.style.minHeight = `${ta.offsetHeight}px`;
    } else {
      ta.focus();
    }
  };
  writeTab.addEventListener("click", () => show("write"));
  previewTab.addEventListener("click", () => show("preview"));

  // Grow with the text, to a point — a release note is not a tweet, and a
  // fixed six rows meant scrolling a box inside a box.
  const autoGrow = (): void => {
    if (opts.fill) return; // the container decides the height; see `fill`
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.5))}px`;
  };

  ta.addEventListener("input", () => {
    autoGrow();
    opts.onInput?.(ta.value);
  });

  ta.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      opts.onSubmit?.();
      return;
    }
    if (mod && !e.shiftKey) {
      const tool = TOOLS.find((t) => t.key && t.key === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        applyTool(ta, tool);
        opts.onInput?.(ta.value);
        return;
      }
    }
    if (e.key === "Enter" && !mod && !e.shiftKey) {
      // Continue a list. Typing "- a" then Enter should give "- ", not a bare
      // line you have to re-mark — and an empty marker ENDS the list, which is
      // how every editor that does this behaves.
      const upto = ta.value.slice(0, ta.selectionStart);
      const line = upto.slice(upto.lastIndexOf("\n") + 1);
      const marker = listMarker(line);
      if (marker) {
        e.preventDefault();
        if (line.trim() === marker.trim()) {
          // An empty item: clear it and break out of the list.
          ta.setRangeText("", ta.selectionStart - line.length, ta.selectionStart, "end");
        } else {
          ta.setRangeText(`\n${marker}`, ta.selectionStart, ta.selectionEnd, "end");
        }
        autoGrow();
        opts.onInput?.(ta.value);
      }
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      // Indent inside the field rather than leaving it — a markdown list needs
      // indentation, and Tab was the only way to lose the field mid-thought.
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      opts.onInput?.(ta.value);
    }
  });

  root.append(head, ta, preview);
  queueMicrotask(autoGrow);

  return {
    root,
    textarea: ta,
    get: () => ta.value,
    set: (v: string) => {
      ta.value = v;
      autoGrow();
    },
    focus: () => ta.focus(),
  };
}
