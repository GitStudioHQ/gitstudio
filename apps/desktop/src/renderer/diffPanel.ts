// Mounts the SHARED Monaco surfaces — @gitstudio/webview-ui/diffView (2-pane,
// JetBrains-style, word-level) and mergeView (3-pane conflict resolver) — into
// a desktop container. The views are reused unchanged; this only feeds them the
// payload shapes they already expect (DiffInitPayload / MergeInitPayload), which
// the main process produced from git-service + the engine diff/merge models.

import * as monaco from "monaco-editor";
import { DiffView } from "@gitstudio/webview-ui/diffView";
import type { TickRow } from "@gitstudio/webview-ui/stageTicks";
import { selectedLineNumbers } from "./selectionLines";
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
 * How long the unified view waits for Monaco's worker to compute its diff
 * before falling back to the in-process split view.
 *
 * Long enough that a cold worker (the bundle is ~576KB and starts on first use)
 * wins the race on any normal machine; short enough that a dead one does not
 * leave someone staring at an unmarked file wondering what changed.
 */
const INLINE_WORKER_GRACE_MS = 2500;
/**
 * The diff worker failed to answer once this session.
 *
 * Once is enough to stop asking: a worker that did not load will not load for
 * the next file either, and making every single file wait out the grace period
 * before falling back turns one broken dependency into a permanently slow app.
 * Module-level, so it resets when the window does — which is also when a
 * genuinely transient failure gets its second chance.
 */
let workerDiffBroken = false;

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
  /** Pending "did the diff worker answer?" timer — see `renderInline`. */
  private inlineWatchdog?: number;
  /** The mode segment, so a fallback can say which view is actually on screen. */
  private seg?: HTMLElement;
  /** Whitespace / granularity, so a newly built editor starts where the last
   *  one left off — and so BOTH modes answer to the same setting. */
  private renderOpts: { whitespace: "none" | "all"; showInner?: boolean } = { whitespace: "none" };
  /** The last-shown file, so the mode toggle can re-render it. */
  private lastFile?: FileDiff;
  /** The mode actually on screen. Diverges from the stored preference whenever
   *  the inline worker misses its grace period and we fall back to Split. */
  private renderedMode?: DiffMode;
  /** Fired after a tick changes the index, so the Changes list can refresh. */
  public onStagingChanged?: () => void;

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
    // A BINARY file has no text diff, and mounting an editor over two empty
    // strings is how "the diff doesn't show" happened: two blank panes, no
    // explanation, and the app looking broken over a PNG behaving normally.
    if (file.binary) {
      this.showEmpty(
        `${file.path} is a binary file, so there is nothing to diff line by line. Its contents changed.`,
        { title: "Binary file", kind: "none" },
      );
      return;
    }
    // IDENTICAL SIDES. A rename with no edit, or a mode-only change, has two
    // equal texts — and the inline editor is built with
    // `hideUnchangedRegions`, which then collapses the entire file and renders
    // as an empty box, while Split shows two identical panes. That is exactly
    // "sometimes it doesn't show the diff on just one of the two views". Say
    // what happened instead of drawing nothing.
    if (file.leftText === file.rightText && file.leftText.length > 0) {
      this.showEmpty(
        `${file.path} has the same contents on both sides — it was renamed, or only its file mode changed.`,
        { title: "No line changes", kind: "none" },
      );
      return;
    }
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
      b.dataset.mode = m;
      b.addEventListener("click", () => {
        // A no-op only when there is nothing to change on EITHER side.
        //
        // It used to compare the click to the stored preference alone. After a
        // worker fallback that preference is still "inline" while the segment
        // correctly shows Split, so pressing Inline matched and returned —
        // leaving the button inert for the rest of the session with no way to
        // ask for the unified view again. Comparing only to what is rendered
        // has the mirror problem: pressing Split while Split is showing
        // BECAUSE of a fallback is a real choice, and it has to record the
        // preference and clear the note explaining a fallback you have now
        // accepted.
        if (this.renderedMode === m && localStorage.getItem(LS_DIFF_MODE) === m) return;
        try {
          localStorage.setItem(LS_DIFF_MODE, m);
        } catch {
          /* non-fatal */
        }
        // Swap the EDITOR, not the toolbar. This used to re-run showDiff, which
        // replaced the whole panel — so the button you had just pressed was
        // destroyed under your finger, taking hover, focus and the pressed
        // state with it, and the panel's Monaco instance was thrown away and
        // rebuilt even though the file had not changed.
        this.swapMode(body, m);
      });
      return b;
    };
    seg.append(mkBtn("inline", "list-flat", "Inline"), mkBtn("split", "split-horizontal", "Split"));
    this.seg = seg;
    // The path is truncated from the LEFT (the filename is the part that
    // identifies it), which the stylesheet does with `direction: rtl`. That
    // reorders NEUTRAL characters at the edges of the string, and a leading dot
    // is neutral: ".github/workflows/ci.yml" rendered as
    // "github/workflows/ci.yml." — every dotfile path in the app naming a file
    // that does not exist. An inner LTR isolate keeps the characters in the
    // order they were written while the outer box still ellipsises on the left.
    const path = span("", "diffmode-path");
    path.appendChild(span(file.path, "diffmode-path-text"));
    path.title = file.path;
    bar.append(path, seg);
    const body = el("div", "diffmode-body");
    wrap.append(bar, body);
    this.container.replaceChildren(wrap);

    // Say it BEFORE the editor, not after: a diff that silently stops halfway
    // through a large file reads as a diff, and the reader draws conclusions
    // from the half they can see.
    if (file.truncated) {
      const note = el("div", "diff-truncated-note");
      note.append(
        glyph("warning"),
        span("This file is too large to diff in full — showing the first part of it."),
      );
      wrap.insertBefore(note, body);
    }

    this.renderMode(body, file, mode);
  }

  /** Paint one mode's editor into the panel body. Owns nothing above it. */
  private renderMode(body: HTMLElement, file: FileDiff, mode: DiffMode): void {
    // A worker that already failed this session will fail again; skip the wait.
    if (mode === "inline" && workerDiffBroken) {
      this.markSegment("split");
      this.noteFallback(body);
      this.renderMode(body, file, "split");
      return;
    }
    // The single funnel every render passes through, so the toggle's guard can
    // ask what is on screen rather than what was once preferred.
    this.renderedMode = mode;
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
      this.diff.onToggleTick = (row, staged) => {
        void this.toggleTick(file.path, row, staged);
      };
      // Start where the last editor left off — a rebuild (a file switch, a
      // mode toggle) used to silently reset the whitespace setting to the
      // default, so the toggle appeared to un-toggle itself.
      this.diff.setRenderOptions(this.renderOpts);
      this.diff.render(payload);
      // Staging ticks only where staging means something: a working-tree diff
      // (HEAD on the left) that is not conflicted. A commit diff carries no
      // index text and gets none.
      this.diff.setStagingState(file.indexText);
    } else {
      this.renderInline(body, file);
      if (file.indexText !== undefined) {
        this.showInlineStagingHint(body);
      }
    }
  }

  /**
   * Change diff mode in place: dispose only the editor, repaint only the body,
   * and re-mark the segment. The bar — and the button under the pointer —
   * survives.
   */
  private swapMode(body: HTMLElement, mode: DiffMode): void {
    const file = this.lastFile;
    if (!file) return;
    this.disposeEditors();
    body.replaceChildren();
    body.parentElement?.querySelector(".diff-staging-hint")?.remove();
    // A note left by an earlier fallback describes a render that no longer
    // exists — asking for a mode explicitly clears it.
    //
    // The FALLBACK note only. This used to remove `.diff-truncated-note`, which
    // was the class for both notes, so on any file over FILE_CAP_BYTES one
    // press of the toggle permanently deleted "this file is too large to diff
    // in full" — a warning about the CONTENT, still true in either mode, and
    // the only thing telling the reader the diff they are drawing conclusions
    // from stops halfway.
    body.parentElement?.querySelector(".diff-fallback-note")?.remove();
    this.markSegment(mode);
    this.renderMode(body, file, mode);
  }

  /** Paint the segment to match the view that is actually rendered. */
  private markSegment(mode: DiffMode): void {
    this.renderedMode = mode;
    for (const b of this.seg?.querySelectorAll<HTMLElement>(".cmp-mode-btn") ?? []) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /**
   * Inline mode carries no ticks, and says so rather than looking broken.
   *
   * Monaco's unified view renders deleted lines as view zones with no model line
   * behind them, so nothing — glyph margin or overlay — can put a control beside
   * a pure deletion there. Inline is the reading mode; Split is the staging one.
   */
  private showInlineStagingHint(body: HTMLElement): void {
    const hint = el("div", "diff-staging-hint");
    hint.append(glyph("info"), span("Switch to Split to stage individual changes"));
    body.parentElement?.insertBefore(hint, body);
  }

  /** Round-trips one tick to git, then repaints from the index git reports. */
  private async toggleTick(path: string, row: TickRow, staged: boolean): Promise<void> {
    const view = this.diff;
    if (!view) return;
    // Locked while in flight so a double click cannot stage twice.
    view.setTicksBusy(true);
    try {
      const r = await host.invoke("blocks:set", {
        path,
        block: {
          head: { start: row.block.leftSpan.start, end: row.block.leftSpan.endExclusive },
          working: { start: row.block.rightSpan.start, end: row.block.rightSpan.endExclusive },
          state: row.state,
        },
        staged,
      });
      if (!r.ok) {
        toast(r.message ?? "Could not stage that change.", r.expected ? "info" : "error");
        this.onStagingChanged?.();
        return;
      }
      // Repaint from what git now holds, never from an optimistic guess.
      view.setStagingState(r.indexText ?? "");
      this.onStagingChanged?.();
    } finally {
      view.setTicksBusy(false);
    }
  }

  /**
   * Unified diff via Monaco's native diff editor (renderSideBySide: false).
   *
   * This mode has a dependency the Split mode does not: Monaco computes its
   * diff in the EDITOR WEB WORKER, asynchronously. The editor mounts and paints
   * the modified text immediately, and if the worker is missing, cold, crashed,
   * or answering for a model that has since been disposed, the diff never
   * arrives and you are left looking at a plain file with no changes marked —
   * or, for a deleted file, at nothing at all. Every error that path produces
   * is swallowed as worker noise, so the surface simply looks broken.
   *
   * Split has no such failure mode: it computes in-process. So inline waits a
   * moment for the worker, and if the diff has not been computed by then it
   * falls back to Split, which cannot fail this way, and says why.
   */
  private renderInline(body: HTMLElement, file: FileDiff): void {
    const language = languageForFile(file.path);
    const original = monaco.editor.createModel(file.leftText, language);
    const modified = monaco.editor.createModel(file.rightText, language);
    this.inlineModels = [original, modified];
    this.inline = monaco.editor.createDiffEditor(body, {
      theme: ensureNativeTheme(),
      ...nativeFontOptions(),
      renderSideBySide: false,
      // The SAME whitespace rule the split view uses. Monaco defaults
      // `ignoreTrimWhitespace` to TRUE; the engine's `buildDiffModel` maps our
      // default `whitespace: "none"` to FALSE. So a trailing-whitespace-only
      // change showed in Split and vanished in Inline — the same file, the same
      // click, one view showing a diff and the other showing none.
      ignoreTrimWhitespace: this.renderOpts.whitespace === "all",
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

    // Did the worker actually answer? `onDidUpdateDiff` fires once the
    // computation lands; `getLineChanges()` is null until it does.
    const editor = this.inline;
    let answered = false;
    const sub = editor.onDidUpdateDiff(() => {
      answered = true;
      sub.dispose();
      window.clearTimeout(this.inlineWatchdog);
    });
    this.inlineWatchdog = window.setTimeout(() => {
      sub.dispose();
      // Identical texts legitimately produce no changes — and `showDiff`
      // already refused that case above, so reaching here with a diff still
      // uncomputed means the worker did not answer.
      if (answered || this.inline !== editor) return;
      if (editor.getLineChanges()) return;
      this.fallBackToSplit(body, file);
    }, INLINE_WORKER_GRACE_MS);
  }

  /**
   * The inline editor never got its diff. Render the Split view instead, which
   * computes in-process, and say so — quietly, once, above the diff.
   */
  private fallBackToSplit(body: HTMLElement, file: FileDiff): void {
    this.disposeEditors();
    body.replaceChildren();
    // "Switch to Split to stage individual changes" — which is what is about to
    // be rendered. swapMode has always cleared this; the fallback did not, so
    // the surface flipped to Split and went on telling you to switch to Split.
    body.parentElement?.querySelector(".diff-staging-hint")?.remove();
    workerDiffBroken = true;
    this.noteFallback(body);
    // Mark the segment to match what is ON SCREEN. The stored preference is
    // deliberately left alone: it is still what you asked for, and it comes
    // back the next time the window starts with a working worker.
    this.markSegment("split");
    this.renderMode(body, file, "split");
  }

  /** One line above the diff saying which view this actually is, and why. */
  private noteFallback(body: HTMLElement): void {
    if (body.parentElement?.querySelector(".diff-fallback-note")) return;
    // Its OWN class. Sharing one with the truncation note also meant that on a
    // truncated file this early return fired against the wrong note and the
    // fallback said nothing at all.
    const note = el("div", "diff-truncated-note diff-fallback-note");
    note.append(
      glyph("warning"),
      span("Showing this diff side by side — the unified view didn't come back."),
    );
    body.parentElement?.insertBefore(note, body);
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
   *  for line/hunk staging. Returns null when no real diff/selection is present.
   *
   *  ALL selections, not just the primary one: Monaco supports multi-cursor, and
   *  reading getSelection() staged the first range and dropped the rest. */
  getSelectedLines(): number[] | null {
    // Both modes, not just split. `this.diff` is undefined in inline mode, and
    // inline is the DEFAULT below 1000px of surface width — so on a narrow
    // window "Stage lines" was reading from an editor that did not exist and
    // reporting "select some lines first" over a live selection.
    const ed = this.diff?.right ?? this.inline?.getModifiedEditor();
    if (!ed) return null;
    return selectedLineNumbers(ed.getSelections());
  }

  /**
   * Re-run the diff with new whitespace / granularity options.
   *
   * BOTH surfaces. This reached only the split view, so the app's own
   * whitespace toggle silently did nothing in unified mode — and the two modes
   * then disagreed about what counted as a change.
   */
  setRenderOptions(opts: { whitespace?: "none" | "all"; showInner?: boolean }): void {
    this.renderOpts = { ...this.renderOpts, ...opts };
    this.diff?.setRenderOptions(opts);
    if (this.inline && opts.whitespace !== undefined) {
      this.inline.updateOptions({ ignoreTrimWhitespace: opts.whitespace === "all" });
    }
  }

  /**
   * The placeholder this panel shows when there is no diff on screen.
   *
   * It used to be one line of grey text under the same compare icon whatever
   * the reason was — "select a file", "there is no diff", and "the request
   * failed" all looked identical, so a failure read as an instruction. It now
   * takes a title and picks its icon from the KIND of nothing it is showing.
   */
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

  /**
   * Re-measure the editors after the container changes size for a reason no
   * observer will see (a resizer drag, a pane collapsing).
   *
   * Both surfaces do keep themselves laid out — DiffView watches its container,
   * the inline editor uses automaticLayout — but a host that resizes on a
   * pointer drag wants the new width THIS frame, not on the observer's.
   */
  layout(): void {
    this.diff?.layout?.();
    this.inline?.layout();
    (this.merge as { layout?: () => void } | undefined)?.layout?.();
  }

  dispose(): void {
    this.teardown();
  }

  /** Dispose every editor and model this panel owns, keeping the DOM. */
  private disposeEditors(): void {
    window.clearTimeout(this.inlineWatchdog);
    this.inlineWatchdog = undefined;
    this.diff?.dispose();
    this.diff = undefined;
    this.merge?.dispose();
    this.merge = undefined;
    this.inline?.dispose();
    this.inline = undefined;
    // Monaco models are not owned by the editor that used them: leaving these
    // behind on every rebuild leaked one pair of models per diff shown.
    for (const m of this.inlineModels) m.dispose();
    this.inlineModels = [];
  }

  private teardown(): void {
    this.disposeEditors();
    this.container.replaceChildren();
  }
}
