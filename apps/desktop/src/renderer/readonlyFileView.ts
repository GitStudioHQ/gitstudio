// A single read-only Monaco editor for viewing a file's content in the Code
// (repo browser) view. Mirrors CompareDiff's theme/font wiring but with one
// model instead of two.

import * as monaco from "monaco-editor";
import { ensureNativeTheme, nativeFontOptions } from "@gitstudio/webview-ui/theme";
import { languageForFile } from "@gitstudio/webview-ui/language";
import { bootMonaco } from "./monacoBoot";

export class ReadonlyFileView {
  private editor?: monaco.editor.IStandaloneCodeEditor;
  private model?: monaco.editor.ITextModel;

  constructor(private readonly container: HTMLElement) {
    bootMonaco();
  }

  show(path: string, text: string): void {
    this.teardown();
    const hostEl = document.createElement("div");
    hostEl.className = "cmp-diff-editor"; // reuse the absolute-inset host rule
    this.container.replaceChildren(hostEl);
    this.model = monaco.editor.createModel(text, languageForFile(path));
    this.editor = monaco.editor.create(hostEl, {
      model: this.model,
      theme: ensureNativeTheme(),
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      glyphMargin: false,
      folding: false,
      lineNumbersMinChars: 3,
      scrollbar: { useShadows: false },
      inlayHints: { enabled: "off" },
      codeLens: false,
      occurrencesHighlight: "off",
      quickSuggestions: false,
      ...nativeFontOptions(),
    });
  }

  /** Centered placeholder (binary / truncated / missing file). */
  showMessage(text: string): void {
    this.teardown();
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = text;
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
    this.model?.dispose();
    this.model = undefined;
    this.container.replaceChildren();
  }
}
