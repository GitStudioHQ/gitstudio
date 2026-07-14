// Mounts the SHARED Monaco surfaces — @gitstudio/webview-ui/diffView (2-pane,
// JetBrains-style, word-level) and mergeView (3-pane conflict resolver) — into
// a desktop container. The views are reused unchanged; this only feeds them the
// payload shapes they already expect (DiffInitPayload / MergeInitPayload), which
// the main process produced from git-service + the engine diff/merge models.

import * as monaco from "monaco-editor";
import { DiffView } from "@gitstudio/webview-ui/diffView";
import { MergeView } from "@gitstudio/webview-ui/mergeView";
import { languageForFile } from "@gitstudio/webview-ui/language";
import { ensureNativeTheme, nativeFontOptions } from "@gitstudio/webview-ui/theme";
import type { DiffInitPayload, MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { ConflictModel, FileDiff } from "../shared/ipc";
import { bootMonaco } from "./monacoBoot";
import { host } from "./bridge";
import { toast } from "./dialogs";
import { el, span, glyph } from "./ui";

/** How the diff renders: unified single column, or the 2-pane split view. */
type DiffMode = "inline" | "split";
const LS_DIFF_MODE = "gitstudio.diffMode";
/** Below this surface width, an unset preference defaults to inline. */
const INLINE_DEFAULT_BELOW = 1000;

/**
 * A single reusable diff/merge surface. Swaps between the 2-pane DiffView and
 * the 3-pane MergeView depending on whether the opened file is conflicted,
 * disposing the previous view so Monaco editors never leak.
 */
export class DiffPanel {
  private diff?: DiffView;
  private merge?: MergeView;
  /** Inline (unified) mode: Monaco's native diff editor + its two models. */
  private inline?: monaco.editor.IStandaloneDiffEditor;
  private inlineModels: monaco.editor.ITextModel[] = [];
  /** The last-shown file, so the mode toggle can re-render it. */
  private lastFile?: FileDiff;

  constructor(private readonly container: HTMLElement) {
    bootMonaco();
  }

  /** The active mode: the user's persisted choice, else width-derived —
   *  narrow surfaces read better unified, wide ones side-by-side. */
  private resolveMode(): DiffMode {
    try {
      const saved = localStorage.getItem(LS_DIFF_MODE);
      if (saved === "inline" || saved === "split") return saved;
    } catch {
      /* storage unavailable → width heuristic */
    }
    const w = this.container.clientWidth || window.innerWidth;
    return w < INLINE_DEFAULT_BELOW ? "inline" : "split";
  }

  /** Renders a file diff — unified or 2-pane per the mode toggle. */
  showDiff(file: FileDiff): void {
    this.teardown();
    this.lastFile = file;
    const mode = this.resolveMode();

    const wrap = el("div", "diffmode-wrap");
    const bar = el("div", "diffmode-bar");
    const seg = el("div", "cmp-mode diffmode-seg");
    const mkBtn = (m: DiffMode, icon: string, label: string): HTMLButtonElement => {
      const b = el("button", "cmp-mode-btn" + (mode === m ? " active" : "")) as HTMLButtonElement;
      b.append(glyph(icon), span(label));
      b.title = m === "inline" ? "Unified diff (one column)" : "Side-by-side diff";
      b.setAttribute("aria-pressed", String(mode === m));
      b.addEventListener("click", () => {
        if (this.resolveMode() === m && localStorage.getItem(LS_DIFF_MODE)) return;
        try {
          localStorage.setItem(LS_DIFF_MODE, m);
        } catch {
          /* non-fatal */
        }
        if (this.lastFile) this.showDiff(this.lastFile);
      });
      return b;
    };
    seg.append(mkBtn("inline", "list-flat", "Inline"), mkBtn("split", "split-horizontal", "Split"));
    bar.append(span(file.path, "diffmode-path"), seg);
    const body = el("div", "diffmode-body");
    wrap.append(bar, body);
    this.container.replaceChildren(wrap);

    if (mode === "split") {
      const payload: DiffInitPayload = {
        leftLabel: file.leftLabel,
        rightLabel: file.rightLabel,
        leftText: file.leftText,
        rightText: file.rightText,
        fileName: file.path,
        rightEditable: false,
      };
      this.diff = new DiffView(body);
      this.diff.render(payload);
    } else {
      this.renderInline(body, file);
    }
  }

  /** Unified diff via Monaco's native diff editor (renderSideBySide: false). */
  private renderInline(body: HTMLElement, file: FileDiff): void {
    const language = languageForFile(file.path);
    const original = monaco.editor.createModel(file.leftText, language);
    const modified = monaco.editor.createModel(file.rightText, language);
    this.inlineModels = [original, modified];
    this.inline = monaco.editor.createDiffEditor(body, {
      theme: ensureNativeTheme(),
      ...nativeFontOptions(),
      renderSideBySide: false,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      folding: false,
      stickyScroll: { enabled: false },
      hideUnchangedRegions: { enabled: true },
      renderOverviewRuler: false,
      diffWordWrap: "off",
      lineNumbersMinChars: 3,
    });
    this.inline.setModel({ original, modified });
  }

  /**
   * Renders the 3-pane merge for a conflicted file via the engine merge model,
   * with a resolution action bar — "Take ours/theirs" (whole-file, via git
   * stages) and "Mark resolved" (writes the edited result + `git add`). The
   * merge editor was previously display-only; this is the write-back path.
   * `onResolved` fires after a successful resolve so the caller can refresh.
   */
  showMerge(model: ConflictModel, onResolved?: () => void): void {
    this.teardown();

    const wrap = el("div", "merge-wrap");
    const bar = el("div", "merge-bar");
    const title = el("div", "merge-bar-title");
    title.append(glyph("git-merge"), span(model.path, "merge-bar-path"));
    const actions = el("div", "merge-bar-actions");
    const ours = el("button", "mini-btn") as HTMLButtonElement;
    ours.append(glyph("arrow-left"), span("Take ours"));
    ours.title = "Replace the file with your version (current change) and stage it";
    const theirs = el("button", "mini-btn") as HTMLButtonElement;
    theirs.append(glyph("arrow-right"), span("Take theirs"));
    theirs.title = "Replace the file with the incoming version and stage it";
    const resolve = el("button", "btn btn-primary mini-btn merge-resolve") as HTMLButtonElement;
    resolve.append(glyph("check"), span("Mark resolved"));
    resolve.title = "Save your merged result and stage the file as resolved";
    actions.append(ours, theirs, resolve);
    bar.append(title, actions);

    const surface = el("div", "merge-surface");
    wrap.append(bar, surface);
    this.container.replaceChildren(wrap);

    this.merge = new MergeView(surface);
    this.merge.render({
      fileName: model.path,
      conflictType: "content",
      source: "git-stages",
      hasBase: model.hasBase,
      oursLabel: model.oursLabel,
      theirsLabel: model.theirsLabel,
      base: model.base,
      ours: model.ours,
      theirs: model.theirs,
      result: model.result,
    });
    // The surface starts at 0 height until Monaco lays out — nudge it.
    requestAnimationFrame(() => (this.merge as { layout?: () => void } | undefined)?.layout?.());

    const run = async (
      btn: HTMLButtonElement,
      op: () => Promise<{ ok: boolean; message?: string }>,
      okMsg: string,
    ): Promise<void> => {
      const prev = btn.textContent;
      btn.disabled = true;
      try {
        const r = await op();
        if (r.ok) {
          toast(okMsg, "success");
          onResolved?.();
        } else {
          toast(r.message || "Could not resolve the conflict.", "error");
        }
      } catch (err) {
        toast(String(err), "error");
      } finally {
        btn.disabled = false;
        void prev;
      }
    };

    ours.addEventListener("click", () =>
      run(ours, () => host.invoke("conflict:takeSide", { path: model.path, side: "ours" }), "Took your version."),
    );
    theirs.addEventListener("click", () =>
      run(theirs, () => host.invoke("conflict:takeSide", { path: model.path, side: "theirs" }), "Took the incoming version."),
    );
    resolve.addEventListener("click", () =>
      run(
        resolve,
        () =>
          host.invoke("conflict:resolve", {
            path: model.path,
            content: this.merge?.getResultText() ?? model.result,
          }),
        "Resolved and staged.",
      ),
    );
  }

  /** The 1-based line numbers currently selected in the working (right) editor —
   *  for line/hunk staging. Returns null when no real diff/selection is present. */
  getSelectedLines(): number[] | null {
    const ed = this.diff?.right;
    if (!ed) return null;
    const sel = ed.getSelection();
    if (!sel) return null;
    const lines: number[] = [];
    // A zero-width selection (just a caret) still stages that one line.
    for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) lines.push(l);
    return lines;
  }

  /** Re-run the 2-pane diff with new whitespace / granularity options. */
  setRenderOptions(opts: { whitespace?: "none" | "all"; showInner?: boolean }): void {
    this.diff?.setRenderOptions(opts);
  }

  /** Shows a composed placeholder (icon badge + text) when nothing is selected. */
  showEmpty(text: string): void {
    this.teardown();
    const empty = document.createElement("div");
    empty.className = "diff-empty list-empty";
    const badge = document.createElement("div");
    badge.className = "list-empty-badge";
    badge.innerHTML = '<span class="glyph codicon codicon-git-compare"></span>';
    const t = document.createElement("div");
    t.className = "list-empty-desc";
    t.textContent = text;
    empty.append(badge, t);
    this.container.replaceChildren(empty);
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    this.diff?.dispose();
    this.diff = undefined;
    this.merge?.dispose();
    this.merge = undefined;
    this.inline?.dispose();
    this.inline = undefined;
    for (const m of this.inlineModels) m.dispose();
    this.inlineModels = [];
    this.container.replaceChildren();
  }
}
