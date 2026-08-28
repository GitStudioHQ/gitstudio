// A GitHub-style diff surface for the Compare view: Monaco's NATIVE diff editor,
// which renders side-by-side when there's room and auto-folds to a single inline
// view when the pane gets narrow (`useInlineViewWhenSpaceIsLimited`). That's the
// behaviour the shared 2-pane DiffView can't give us — it's always split — so the
// master/detail compare pane uses this instead.

import * as monaco from "monaco-editor";
import { ensureNativeTheme, nativeFontOptions } from "@gitstudio/webview-ui/theme";
import { languageForFile } from "@gitstudio/webview-ui/language";
import type { FileDiff } from "../shared/ipc";
import { bootMonaco } from "./monacoBoot";

/** Below this container width Monaco collapses the diff to a single inline view. */
const INLINE_BREAKPOINT = 720;

export class CompareDiff {
  private editor?: monaco.editor.IStandaloneDiffEditor;
  private models: monaco.editor.ITextModel[] = [];

  constructor(private readonly container: HTMLElement) {
    bootMonaco();
  }

  /** Render `file` as original (left/base) → modified (right/compare). */
  show(file: FileDiff): void {
    this.teardown();
    const host = document.createElement("div");
    host.className = "cmp-diff-editor";
    this.container.replaceChildren(host);

    const language = languageForFile(file.path);
    const original = monaco.editor.createModel(file.leftText, language);
    const modified = monaco.editor.createModel(file.rightText, language);
    this.models = [original, modified];

    this.editor = monaco.editor.createDiffEditor(host, {
      theme: ensureNativeTheme(),
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      // GitHub-like: split when wide, inline when cramped.
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: INLINE_BREAKPOINT,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { useShadows: false },
      folding: false,
      glyphMargin: false,
      lineNumbersMinChars: 3,
      ignoreTrimWhitespace: false,
      inlayHints: { enabled: "off" },
      codeLens: false,
      occurrencesHighlight: "off",
      quickSuggestions: false,
      ...nativeFontOptions(),
    });
    this.editor.setModel({ original, modified });
  }

  /** Same contract as DiffPanel.showEmpty — see the note there on why the KIND
   *  of nothing matters. Kept in step so the two panels never disagree. */
  showEmpty(text: string, opts: { title?: string; kind?: "waiting" | "none" | "error" } = {}): void {
    this.teardown();
    const kind = opts.kind ?? "waiting";
    const icon = kind === "error" ? "warning" : kind === "none" ? "check-all" : "git-compare";
    const title =
      opts.title ??
      (kind === "error" ? "Couldn't load this diff" : kind === "none" ? "No changes" : "Nothing selected");
    const empty = document.createElement("div");
    empty.className = `diff-empty list-empty is-${kind}`;
    const badge = document.createElement("div");
    badge.className = "list-empty-badge";
    badge.innerHTML = `<span class="glyph codicon codicon-${icon}"></span>`;
    const h = document.createElement("div");
    h.className = "list-empty-title";
    h.textContent = title;
    const t = document.createElement("div");
    t.className = "list-empty-desc";
    t.textContent = text;
    empty.append(badge, h, t);
    this.container.replaceChildren(empty);
  }

  layout(): void {
    this.editor?.layout();
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    this.editor?.dispose();
    this.editor = undefined;
    for (const m of this.models) {
      m.dispose();
    }
    this.models = [];
    this.container.replaceChildren();
  }
}
