// <gitstudio-rebase> — the interactive-rebase editor surface.
//
// The mission: make `git rebase -i` non-terrifying. Each commit is a legible,
// reorderable row with the short sha + subject and an action <select>
// (pick/reword/edit/squash/fixup/drop) colored distinctly so the plan reads at
// a glance. A header summarizes "Rebasing N commits onto …", and Start rebase /
// Abort are always one click away. Reorder by drag-and-drop OR alt+up/down;
// rows are accessible (roles, aria-labels, focusable, keyboard-operable).
//
// Theme-native: every color is a --vscode-* token (or a token-derived accent),
// so the editor blends with the host. The host serializes the final order via
// the engine and writes the todo — this element only models intent.
//
// Several rows at once (#32): click, Shift/⌘-click, the arrows with and
// without Shift, Home/End, ⌘A and Escape select; the toolbar and git's own
// letters (p r s f e d) set every selected row; Alt+↑/↓, the move buttons and
// a drag move the selection. The rules are the shared engine's
// (engine/rebase/planEdit) — the same ones the extension's workspace and the
// desktop's Rebase view run — in git's own order: oldest at the top, so a
// squash folds into the row ABOVE it and the first row can never be one —
// unless git is already past it: in a paused rebase's `--edit-todo` the last
// commit git applied is kept above the first line (`continuing`).

import { LitElement, html, css } from "lit";
import { codiconStyles } from "../styles/codicons";
import { hostTokens } from "../styles/hostTokens";
import {
  NO_SELECTION,
  PLAN_ACTIONS,
  actionForKey,
  actionTooltip,
  arrowRow,
  clickRow,
  collapseSelection,
  dragKeys,
  isOrphanFold,
  moveKeysToGap,
  moveSelected,
  pruneSelection,
  reachRow,
  refusalText,
  selectAll,
  selectOnly,
  selectedInOrder,
  selectionCountText,
  setActions,
  type PlanSelection,
} from "@gitstudio/engine/rebase/planEdit";
import type {
  WireRebaseAction,
  WireRebaseRow,
} from "@gitstudio/host-bridge/rebaseProtocol";
import * as l10n from "@vscode/l10n";

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export type RebaseIntent =
  | { type: "start"; rows: Array<{ id: number; action: WireRebaseAction }> }
  | { type: "abort" };

const ACTIONS: ReadonlyArray<{
  value: WireRebaseAction;
  label: string;
  hint: string;
}> = [
  { value: "pick", label: l10n.t("pick"), hint: l10n.t("use the commit as-is") },
  { value: "reword", label: l10n.t("reword"), hint: l10n.t("use commit, edit its message") },
  { value: "edit", label: l10n.t("edit"), hint: l10n.t("stop to amend the commit") },
  { value: "squash", label: l10n.t("squash"), hint: l10n.t("meld into the commit above (the older one)") },
  { value: "fixup", label: l10n.t("fixup"), hint: l10n.t("meld into the commit above, drop this message") },
  { value: "drop", label: l10n.t("drop"), hint: l10n.t("remove the commit") },
];

interface Row extends WireRebaseRow {}

export class RebaseView extends LitElement {
  static properties = {
    headerComment: { attribute: false },
    rows: { attribute: false },
    continuing: { attribute: false },
    onIntent: { attribute: false },
    dragIndex: { state: true },
    overIndex: { state: true },
    overSide: { state: true },
    selection: { state: true },
    note: { state: true },
  };

  // Reactive properties are `declare`d, with no initializer, and given their
  // defaults in the constructor — the commit graph's pattern. Under ES2022
  // [[Define]] class fields an initializer REPLACES Lit's accessor with a
  // plain property, so `view.rows = …` from the host re-rendered nothing:
  // the editor opened for a terminal's `git rebase -i` said "No commits to
  // rebase." over a todo full of them.
  declare headerComment: string | null;
  declare rows: Row[];
  /** git has applied part of this rebase already (a paused rebase's
   *  `--edit-todo`): a kept commit sits above the first line. */
  declare continuing: boolean;
  declare onIntent: ((intent: RebaseIntent) => void) | null;

  private declare dragIndex: number | null;
  private declare overIndex: number | null;
  /** Which half of the row under the pointer the drop line is on. */
  private declare overSide: "before" | "after" | null;
  /** Which rows the toolbar and the keys act on, by row key (its todo line id). */
  private declare selection: PlanSelection;
  /** A refusal the toolbar or a key just met, said until the next change. */
  private declare note: string;
  /** The rows a drag carries, by key. */
  private dragging: string[] = [];
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.headerComment = null;
    this.rows = [];
    this.continuing = false;
    this.onIntent = null;
    this.dragIndex = null;
    this.overIndex = null;
    this.overSide = null;
    this.selection = NO_SELECTION;
    this.note = "";
  }

  private static key(row: Row): string {
    return String(row.id);
  }

  private order(): string[] {
    return this.rows.map(RebaseView.key);
  }

  /**
   * The rows' actions as the fold rules must see them. In a paused rebase's
   * `--edit-todo`, the last commit git applied sits above the first line,
   * kept, and git runs a leading squash into it — so the rules are asked
   * about the plan with that commit in front (the desktop's Rebase view does
   * the same for the commits below its display cap). `lead` is how many rows
   * that put in front: row i of the list is row i + lead of the plan.
   */
  private plan(): { actions: WireRebaseAction[]; lead: number } {
    const actions = this.rows.map((r) => r.action);
    return this.continuing ? { actions: ["pick", ...actions], lead: 1 } : { actions, lead: 0 };
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("rows")) return;
    // A fresh todo (the host's init) starts with its first line selected, so
    // the keys work from the first Tab; a reorder keeps the selection, which
    // is named by key and moves with its rows.
    const pruned = pruneSelection(this.selection, this.order());
    this.selection =
      pruned.selected.length || !this.rows.length ? pruned : selectOnly(RebaseView.key(this.rows[0]));
  }

  // Chevron glyphs for the reorder hint — the real VS Code codicon font.
  private static readonly chevronUp = html`<span
    class="codicon codicon-chevron-up"
    aria-hidden="true"
  ></span>`;
  private static readonly chevronDown = html`<span
    class="codicon codicon-chevron-down"
    aria-hidden="true"
  ></span>`;

  static styles = [codiconStyles, css`
    /* Theme-native primitives come from the shared token system. This element
     * renders into a shadow root; the --gs-* tokens are inherited from the
     * document (rebase.css @imports tokens.css), so it does NOT re-declare them
     * here — one source of truth, no drift. */
    :host {
      /* Rebase is an editor-area tab, so pin its elevated surfaces to the
         editor background (not the shared sidebar-based --gs-surface) — keeps
         the header/card lift reading correctly against the editor page. */
      --gs-surface: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      height: 100%;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
    }

    header {
      flex: 0 0 auto;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--gs-border);
      background: color-mix(in srgb, var(--vscode-foreground) 2.5%, var(--vscode-editor-background));
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--gs-accent-text);
      margin: 0 0 5px;
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -0.005em;
    }
    .title .mono {
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      color: var(--gs-accent);
    }
    .hint {
      margin-top: 8px;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      color: var(--gs-fg-muted);
      font-size: 11.5px;
      line-height: 1.5;
    }
    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      font-family: var(--gs-font-mono);
      font-size: 10.5px;
      padding: 0 4px;
      border-radius: var(--gs-radius-sm);
      border: 1px solid var(--gs-border);
      background: var(--vscode-keybindingLabel-background, color-mix(in srgb, var(--gs-fg-muted) 12%, transparent));
      color: var(--vscode-keybindingLabel-foreground, var(--gs-fg));
    }
    kbd svg {
      width: 11px;
      height: 11px;
    }

    .list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .row {
      display: grid;
      grid-template-columns: 3px 18px 96px 64px 1fr auto;
      align-items: center;
      gap: 8px;
      min-height: 26px;
      padding: 4px 8px 4px 4px;
      border-radius: var(--gs-radius);
      border: 1px solid var(--gs-border);
      border-left: 2px solid transparent;
      background: var(--gs-surface);
      cursor: default;
      transition: background var(--gs-motion-fast) var(--gs-ease),
        border-color var(--gs-motion-fast) var(--gs-ease),
        box-shadow var(--gs-motion-fast) var(--gs-ease),
        opacity var(--gs-motion-fast) var(--gs-ease);
    }
    .row:hover {
      background: var(--gs-hover);
    }
    .row:focus-visible {
      outline: 1px solid var(--gs-accent);
      outline-offset: -1px;
    }
    /* Selected (#32): lit, never outlined. The card is tinted with the
     * accent and keeps the same neutral edge as the cards beside it. It
     * used to turn that edge accent, which is the line the owner's rule
     * bans. The tint is mixed into the card's own surface, so it is opaque
     * and the action select's words are measured on it (AA). It stays under
     * the pointer, as VS Code's lists do, and lands at once (.painting), as
     * a selection does. */
    .row.selected,
    .row.selected:hover {
      background: color-mix(in srgb, var(--gs-accent) 18%, var(--gs-surface));
    }
    :host-context(body.vscode-light) .row.selected,
    :host-context(body.vscode-light) .row.selected:hover {
      background: color-mix(in srgb, var(--gs-accent) 12%, var(--gs-surface));
    }
    /* The SHA takes full ink on the tint: Light+'s secondary text read
       4.04:1 on it. */
    .row.selected .sha {
      color: var(--gs-fg);
    }
    :host-context(body.vscode-high-contrast) .row.selected {
      outline: 1px dashed var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }
    :host-context(body.vscode-high-contrast) .row.selected:focus-visible {
      outline-style: solid;
    }
    .list.painting .row {
      transition: none;
    }
    /* A squash/fixup with nothing above it to fold into: git refuses the plan. */
    .row.orphan select.action {
      border-color: var(--vscode-errorForeground, #f14c4c);
    }

    /* The selection's toolbar, in the header. */
    .tools {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .selcount {
      min-width: 78px;
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .tools-label {
      font-size: 11.5px;
      color: var(--gs-fg-muted);
    }
    .setgroup {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--gs-border);
      border-radius: var(--gs-radius);
      overflow: hidden;
      background: var(--gs-surface);
    }
    button.set {
      --action-accent: var(--gs-fg-muted);
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 3px 10px;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      line-height: 18px;
      color: var(--gs-fg);
    }
    button.set + button.set {
      border-left: 1px solid var(--gs-border);
    }
    button.set:hover:not(:disabled) {
      background: var(--gs-hover);
    }
    button.set:disabled {
      opacity: 0.5;
      cursor: default;
    }
    button.set:focus-visible {
      outline: 1px solid var(--gs-accent);
      outline-offset: -1px;
    }
    button.set[data-action="pick"] { --action-accent: var(--vscode-charts-green, #89d185); }
    button.set[data-action="reword"] { --action-accent: var(--vscode-charts-blue, #3794ff); }
    button.set[data-action="edit"] { --action-accent: var(--vscode-charts-yellow, #cca700); }
    button.set[data-action="squash"] { --action-accent: var(--vscode-charts-purple, #b180d7); }
    button.set[data-action="fixup"] { --action-accent: var(--vscode-charts-orange, #d18616); }
    button.set[data-action="drop"] { --action-accent: var(--vscode-charts-red, #f14c4c); }
    /* Every selected commit is already set to this one: lit in the
     * action's own hue, never underlined. It used to carry a 2px rule in
     * that hue along its bottom. .setgroup clips (overflow: hidden), so the
     * glow is drawn inside the segment. */
    button.set.current {
      background: color-mix(in srgb, var(--action-accent) 22%, var(--gs-surface));
      box-shadow: inset 0 0 10px -3px color-mix(in srgb, var(--action-accent) 60%, transparent);
    }
    :host-context(body.vscode-light) button.set.current {
      background: color-mix(in srgb, var(--action-accent) 16%, var(--gs-surface));
    }
    :host-context(body.vscode-high-contrast) button.set.current {
      outline: 1px solid var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -2px;
    }
    .note {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--gs-fg);
    }
    .note .codicon {
      color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #cca700));
      flex: 0 0 auto;
    }
    .row.dragging {
      opacity: 0.5;
    }
    /* The drop line, on the side of the row the drop will land. */
    .row.over-before {
      box-shadow: inset 0 2px 0 var(--gs-accent);
    }
    .row.over-after {
      box-shadow: inset 0 -2px 0 var(--gs-accent);
    }
    .row.drop {
      opacity: 0.55;
    }

    .grip {
      grid-column: 2;
      /* It comes last in the row's markup: without a row of its own it is
       * auto-placed AFTER the cursor, on a second line of every row. */
      grid-row: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      color: var(--gs-fg-muted);
      user-select: none;
      line-height: 1;
    }
    .grip:active {
      cursor: grabbing;
    }

    /* Distinct theme-tinted color per action — drives the left accent bar,
     * the select foreground, and a subtle border tint. */
    .row {
      --action-accent: var(--gs-fg-muted);
    }
    .row[data-action="pick"] {
      --action-accent: var(--vscode-charts-green, #89d185);
    }
    .row[data-action="reword"] {
      --action-accent: var(--vscode-charts-blue, #3794ff);
    }
    .row[data-action="edit"] {
      --action-accent: var(--vscode-charts-yellow, #cca700);
    }
    .row[data-action="squash"] {
      --action-accent: var(--vscode-charts-purple, #b180d7);
    }
    .row[data-action="fixup"] {
      --action-accent: var(--vscode-charts-orange, #d18616);
    }
    .row[data-action="drop"] {
      --action-accent: var(--vscode-charts-red, #f14c4c);
    }
    .accent {
      grid-column: 1;
      align-self: stretch;
      justify-self: stretch;
      border-radius: var(--gs-radius-sm);
      background: var(--action-accent);
      min-height: 16px;
    }

    select.action {
      grid-column: 3;
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 3px 6px;
      border-radius: var(--gs-radius-sm);
      /* Neutral, always-legible label; the action's hue rides the tinted fill
       * and the border (composited over an opaque surface, never transparent),
       * so the chip clears AA on both light and dark instead of painting
       * colored text on a same-hue wash. */
      background: color-mix(in srgb, var(--action-accent) 14%, var(--gs-surface));
      color: var(--gs-fg);
      border: 1px solid color-mix(in srgb, var(--action-accent) 45%, transparent);
      cursor: pointer;
    }
    select.action:hover {
      border-color: color-mix(in srgb, var(--action-accent) 75%, transparent);
      background: color-mix(in srgb, var(--action-accent) 20%, var(--gs-surface));
    }
    select.action:focus-visible {
      outline: 1px solid var(--gs-accent);
      outline-offset: 1px;
    }
    /* The native option popup inherits the select's color but not its tinted
     * background — pin both to the dropdown tokens so the list never renders
     * colored text on the system-default white menu. */
    select.action option {
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    }

    /* Respect the OS "reduce motion" setting: keep the layout, drop the easing. */
    @media (prefers-reduced-motion: reduce) {
      .row {
        transition: none;
      }
    }

    .sha {
      grid-column: 4;
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      color: var(--gs-fg-muted);
    }
    .subject {
      grid-column: 5;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .row[data-action="drop"] .subject {
      text-decoration: line-through;
      color: var(--gs-fg-muted);
    }

    .move {
      grid-column: 6;
      display: inline-flex;
      gap: 2px;
    }
    button.icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--gs-radius);
      color: var(--gs-fg-muted);
      cursor: pointer;
      width: 20px;
      height: 20px;
      padding: 0;
    }
    button.icon:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, var(--gs-hover));
      color: var(--gs-fg);
    }
    button.icon:disabled {
      opacity: 0.3;
      cursor: default;
    }
    button:focus-visible {
      outline: 1px solid var(--gs-accent);
      outline-offset: 1px;
    }

    footer {
      flex: 0 0 auto;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 16px;
      border-top: 1px solid var(--gs-border);
    }
    .spacer {
      flex: 1 1 auto;
    }
    button.cta {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      height: 30px;
      padding: 0 16px;
      border-radius: var(--gs-radius);
      border: 1px solid transparent;
      cursor: pointer;
      transition: background var(--gs-motion) var(--gs-ease),
        box-shadow var(--gs-motion) var(--gs-ease),
        transform var(--gs-motion-fast) var(--gs-ease);
    }
    button.cta svg {
      width: 14px;
      height: 14px;
    }
    button.cta:active:not(:disabled) { transform: translateY(0.5px); }
    button.primary {
      color: var(--vscode-button-foreground);
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--vscode-button-background) 88%, white 12%),
          var(--vscode-button-background));
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16),
        inset 0 1px 0 color-mix(in srgb, white 16%, transparent);
    }
    button.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.16),
        inset 0 1px 0 color-mix(in srgb, white 18%, transparent);
    }
    button.primary:disabled {
      opacity: 0.45;
      cursor: default;
    }
    /* A true ghost-danger button: the error hue is the text + border at rest,
     * and the hover tint composites over an opaque surface so it's visible on
     * light themes (12%-over-transparent washed out to nothing there). */
    button.danger {
      background: transparent;
      color: var(--vscode-errorForeground);
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
    }
    button.danger:hover {
      background: color-mix(in srgb, var(--vscode-errorForeground) 16%, var(--vscode-editor-background));
      border-color: var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
    }
    .count {
      color: var(--gs-fg-muted);
      font-size: 11.5px;
    }
    .count .mono {
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      color: var(--gs-fg);
    }
    .empty {
      padding: 40px;
      text-align: center;
      color: var(--gs-fg-muted);
      font-size: 13px;
    }
    /* Codicon sizing per context (the font is registered via rebase.css). */
    kbd .codicon { font-size: 11px; vertical-align: -1px; }
    button.icon .codicon { font-size: 14px; }
    .grip .codicon { font-size: 16px; }
  `];

  render() {
    const total = this.rows.length;
    // What the plan ends with: a squash or fixup is folded into another
    // commit, not kept as one — the count the workspace and the desktop give
    // for the same plan. It said "12 of 12 kept" for twelve commits squashed
    // into one.
    const kept = this.rows.filter((r) => r.action === "pick" || r.action === "reword" || r.action === "edit").length;
    const folded = this.rows.filter((r) => r.action === "squash" || r.action === "fixup").length;
    const dropped = this.rows.filter((r) => r.action === "drop").length;
    const selectedRows = this.rows.filter((r) => this.selection.selected.includes(RebaseView.key(r)));
    const selectedCount = selectedRows.length;
    // The action every selected row shares, if they share one.
    const shared = new Set(selectedRows.map((r) => r.action)).size === 1 ? selectedRows[0]?.action : undefined;
    // A plan git refuses outright: a squash or fixup with nothing kept above it.
    const plan = this.plan();
    const orphans = this.rows.map((_, i) => isOrphanFold(plan.actions, i + plan.lead, "oldest-first"));
    const orphan = orphans.includes(true);
    return html`
      <header>
        <p class="eyebrow">${l10n.t("Interactive Rebase")}</p>
        <div class="title">
          ${this.headerComment
            ? this.headerComment
            : html`${l10n.t("Rebasing")}
                <span class="mono">${total}</span> ${total === 1
                  ? l10n.t("commit")
                  : l10n.t("commits")}`}
        </div>
        <div class="hint">
          <span>${l10n.t("Drag rows or press")}</span>
          <kbd>${l10n.t("Alt")}</kbd>
          <span aria-hidden="true">+</span>
          <kbd aria-label="${l10n.t("Up arrow")}">${RebaseView.chevronUp}</kbd>
          <span aria-hidden="true">/</span>
          <kbd aria-label="${l10n.t("Down arrow")}">${RebaseView.chevronDown}</kbd>
          <span>${l10n.t("to reorder. Topmost runs first — this is git's todo file, oldest at the top.")}</span>
          <span>${l10n.t("Shift- or {0}-click selects several;", IS_MAC ? "⌘" : "Ctrl")}</span>
          ${PLAN_ACTIONS.map((a) => html`<kbd class="letter" title=${a.label}>${a.key}</kbd>`)}
          <span>${l10n.t("set their action.")}</span>
        </div>
        <div class="tools" role="group" aria-label="${l10n.t("Set the action of the selected commits")}">
          <span class="selcount" aria-live="polite">${selectionCountText(selectedCount)}</span>
          <span class="tools-label">${l10n.t("Set action")}</span>
          <div class="setgroup">
            ${PLAN_ACTIONS.map(
              (a) => html`<button
                class=${`set${selectedCount > 0 && shared === a.id ? " current" : ""}`}
                type="button"
                data-action=${a.id}
                title=${actionTooltip(a.id)}
                aria-keyshortcuts=${a.key}
                ?disabled=${selectedCount === 0}
                @click=${() => this.bulkSet(a.id, false)}
              >
                ${a.label}
              </button>`,
            )}
          </div>
        </div>
      </header>

      <div
        class="list"
        role="grid"
        aria-multiselectable="true"
        aria-label="${l10n.t("Rebase commits, oldest first")}"
        @click=${this.onListClick}
        @mousedown=${this.onListMousedown}
        @focusin=${this.onListFocusin}
      >
        ${total === 0
          ? html`<div class="empty">${l10n.t("No commits to rebase.")}</div>`
          : this.rows.map((row, index) => this.renderRow(row, index, orphans[index]))}
      </div>

      <footer>
        <span class="count" aria-live="polite">
          <span class="mono">${kept}</span> ${l10n.t("of")}
          <span class="mono">${total}</span> commit${total === 1 ? "" : "s"} kept${folded
            ? html` · <span class="mono">${folded}</span> folded`
            : ""}${dropped ? html` · <span class="mono">${dropped}</span> dropped` : ""}
        </span>
        <span class="note" role="status">
          ${this.note
            ? html`<span class="codicon codicon-warning" aria-hidden="true"></span><span>${this.note}</span>`
            : ""}
        </span>
        <button class="cta danger" @click=${this.abort}>${l10n.t("Abort")}</button>
        <button
          class="cta primary"
          @click=${this.start}
          ?disabled=${total === 0 || orphan}
          title=${orphan ? l10n.t("A squash or fixup has nothing above it to fold into — git can't run this plan.") : ""}
        >
          ${l10n.t("Start rebase")}
        </button>
      </footer>
    `;
  }

  private renderRow(row: Row, index: number, orphan: boolean) {
    const key = RebaseView.key(row);
    const dragging = this.dragging.includes(key);
    const over = this.overIndex === index && !dragging;
    const selected = this.selection.selected.includes(key);
    const tabStop = (this.selection.focus ?? RebaseView.key(this.rows[0])) === key;
    // A row's move buttons carry what a drag of it would: the selection when
    // the row is in it, else the row.
    const carried = selected ? this.selection.selected : [key];
    const carriesMany = carried.length > 1;
    const order = this.order();
    const upBlocked = moveSelected(order, carried, -1) === null;
    const downBlocked = moveSelected(order, carried, 1) === null;
    const classes = [
      "row",
      dragging ? "dragging" : "",
      over && this.overSide === "before" ? "over-before" : "",
      over && this.overSide === "after" ? "over-after" : "",
      row.action === "drop" ? "drop" : "",
      selected ? "selected" : "",
      orphan ? "orphan" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${classes}
        role="row"
        tabindex=${tabStop ? "0" : "-1"}
        aria-selected=${selected ? "true" : "false"}
        data-key=${key}
        data-action=${row.action}
        aria-label=${l10n.t("Commit {0}, {1}, action {2}", row.shortSha, row.subject, row.action)}
        draggable="true"
        @dragstart=${(e: DragEvent) => this.onDragStart(e, index)}
        @dragover=${(e: DragEvent) => this.onDragOver(e, index)}
        @dragleave=${() => this.onDragLeave(index)}
        @drop=${(e: DragEvent) => this.onDrop(e, index)}
        @dragend=${this.onDragEnd}
        @keydown=${(e: KeyboardEvent) => this.onRowKeydown(e, index)}
      >
        <span class="accent"></span>
        <select
          class="action"
          aria-label=${l10n.t("Action for {0}", row.shortSha)}
          aria-invalid=${orphan ? "true" : "false"}
          title=${orphan ? l10n.t("Nothing above it is kept to fold into — git can't run this") : ""}
          .value=${row.action}
          @change=${(e: Event) =>
            this.setAction(index, (e.target as HTMLSelectElement).value as WireRebaseAction)}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
        >
          ${ACTIONS.map(
            // `selected` as well as the select's `.value`: Lit sets `.value`
            // before these options exist, so on the first render it matched
            // nothing and every dropdown showed pick — a todo opened with
            // fixups (`--autosquash`, a paused rebase's `--edit-todo`) read
            // as all picks while Start wrote the fixups.
            (a) => html`<option value=${a.value} title=${a.hint} ?selected=${a.value === row.action}>
              ${a.label}
            </option>`,
          )}
        </select>
        <span class="sha" title=${row.sha}>${row.shortSha}</span>
        <span class="subject" title=${row.subject}>${row.subject}</span>
        <span class="move">
          <button
            class="icon"
            title=${carriesMany ? l10n.t("Move the selected commits up (Alt+Up)") : l10n.t("Move up (Alt+Up)")}
            aria-label=${carriesMany ? l10n.t("Move the selected commits up") : l10n.t("Move up")}
            ?disabled=${upBlocked}
            @click=${() => this.moveFrom(key, -1)}
          >
            <span class="codicon codicon-chevron-up" aria-hidden="true"></span>
          </button>
          <button
            class="icon"
            title=${carriesMany ? l10n.t("Move the selected commits down (Alt+Down)") : l10n.t("Move down (Alt+Down)")}
            aria-label=${carriesMany ? l10n.t("Move the selected commits down") : l10n.t("Move down")}
            ?disabled=${downBlocked}
            @click=${() => this.moveFrom(key, 1)}
          >
            <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
          </button>
        </span>
        <span class="grip" aria-hidden="true">
          <span class="codicon codicon-gripper"></span>
        </span>
      </div>
    `;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Set `action` on the rows at `indices` — one row from its dropdown, or the
   * selection from the toolbar and the keys. The shared rule (setActions):
   * a squash or fixup is refused, row by row, where nothing above it is kept
   * to fold into, which git refuses outright ("cannot 'squash' without a
   * previous commit"). Across a selection every row folds into the kept
   * line above it (for a block, the one over the block); only when none is
   * kept above does the first selected line stay as it was, for the rest to
   * fold into. What was refused is said in the footer.
   */
  private applyActions(indices: number[], action: WireRebaseAction): void {
    const before = this.rows.map((r) => r.action);
    const { actions: plan, lead } = this.plan();
    const r = setActions(plan, indices.map((i) => i + lead), action, "oldest-first");
    // Back to the list's own rows: the commit git already applied is not one.
    const toRows = (xs: number[]): number[] => xs.map((i) => i - lead).filter((i) => i >= 0);
    const next = r.actions.slice(lead);
    const refused = toRows(r.refused);
    this.rows = this.rows.map((row, i) => (next[i] === row.action ? row : { ...row, action: next[i] }));
    this.say(
      refusalText(
        action,
        { changed: toRows(r.changed), refused },
        "oldest-first",
        refused.length === 1 ? before[refused[0]] : undefined,
      ),
    );
  }

  private setAction(index: number, action: WireRebaseAction): void {
    this.applyActions([index], action);
    // A refused change leaves the model as it was, so Lit has nothing to
    // re-render — put the dropdown back on the action the row still has.
    void this.updateComplete.then(() => {
      const sel = this.rowEl(RebaseView.key(this.rows[index]))?.querySelector("select");
      if (sel && sel.value !== this.rows[index].action) sel.value = this.rows[index].action;
    });
  }

  /** The toolbar and the keys: every selected row. */
  private bulkSet(action: WireRebaseAction, keepFocusOnRow: boolean): void {
    const order = this.order();
    const indices = selectedInOrder(this.selection, order).map((k) => order.indexOf(k));
    if (!indices.length) return;
    this.applyActions(indices, action);
    if (keepFocusOnRow) this.focusRow();
  }

  /** Say a refusal in the footer until the next one, or for a few seconds. */
  private say(text: string): void {
    clearTimeout(this.noteTimer);
    this.note = text;
    if (text) this.noteTimer = setTimeout(() => (this.note = ""), 6000);
  }

  private rowEl(key: string | null | undefined): HTMLElement | null {
    if (!key) return null;
    return this.renderRoot.querySelector<HTMLElement>(`.row[data-key="${key}"]`);
  }

  /** After the re-render, put the keyboard on the row it is on. */
  private focusRow(): void {
    void this.updateComplete.then(() => {
      const el = this.rowEl(this.selection.focus);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest" });
    });
  }

  /** Point the selection somewhere; the keyboard follows it. */
  private select(next: PlanSelection, focus = true): void {
    // A selection lands at once, as in every list; only the hover eases.
    this.renderRoot.querySelector(".list")?.classList.add("painting");
    this.selection = next;
    void this.updateComplete.then(() => {
      const list = this.renderRoot.querySelector<HTMLElement>(".list");
      void list?.offsetHeight;
      list?.classList.remove("painting");
    });
    if (focus) this.focusRow();
  }

  /** Put the rows in this key order, if it is a different one. */
  private reorder(keys: string[]): void {
    if (keys.join("\n") === this.order().join("\n")) return;
    const byKey = new Map(this.rows.map((r) => [RebaseView.key(r), r] as const));
    this.rows = keys.map((k) => byKey.get(k)).filter((r): r is Row => !!r);
    this.focusRow();
  }

  /** A row's move button: the selection when the row is in it, else the row. */
  private moveFrom(key: string, delta: -1 | 1): void {
    if (!this.selection.selected.includes(key)) this.select(selectOnly(key), false);
    const next = moveSelected(this.order(), this.selection.selected, delta);
    if (next) this.reorder(next);
  }

  // ── Selecting, from the mouse and the keyboard ───────────────────────────

  private rowOf(t: EventTarget | null): HTMLElement | null {
    const el = t as HTMLElement | null;
    return el?.closest?.<HTMLElement>(".row") ?? null;
  }

  private onListMousedown = (e: MouseEvent): void => {
    // A Shift-click selects rows, not the text between two clicks.
    if (e.shiftKey && this.rowOf(e.target)) e.preventDefault();
  };

  private onListClick = (e: MouseEvent): void => {
    const row = this.rowOf(e.target);
    // A row's own controls keep their clicks: the dropdown opens, a move
    // button moves. Focusing one selects its row (focusin, below).
    if (!row || (e.target as HTMLElement).closest("select, button, input, a")) return;
    this.select(
      clickRow(this.selection, this.order(), row.dataset.key ?? "", {
        range: e.shiftKey,
        toggle: IS_MAC ? e.metaKey : e.ctrlKey,
      }),
    );
  };

  private onListFocusin = (e: FocusEvent): void => {
    // Tabbing (or clicking) into a row's dropdown makes that row the one the
    // keys act on. The row's own focus is the click's business: a ⌘-click
    // must not collapse the selection on its way in.
    const row = this.rowOf(e.target);
    if (!row || e.target === row) return;
    const key = row.dataset.key ?? "";
    if (!this.selection.selected.includes(key)) this.select(selectOnly(key), false);
    else if (this.selection.focus !== key) this.select({ ...this.selection, focus: key }, false);
  };

  private onRowKeydown(e: KeyboardEvent, _index: number): void {
    const row = e.currentTarget as HTMLElement;
    // Alt+↑/↓ moves the selection, as a block.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const next = moveSelected(this.order(), this.selection.selected, e.key === "ArrowUp" ? -1 : 1);
      if (next) this.reorder(next);
      return;
    }
    // Everything else only on the row itself: a control's keys are its own.
    if (e.target !== row) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const order = this.order();
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && !e.altKey) {
      e.preventDefault();
      this.select(arrowRow(this.selection, order, e.key === "ArrowUp" ? -1 : 1, e.shiftKey));
    } else if ((e.key === "Home" || e.key === "End") && !mod && !e.altKey) {
      e.preventDefault();
      this.select(reachRow(this.selection, order, e.key === "Home" ? 0 : order.length - 1, e.shiftKey));
    } else if (e.key === "Escape") {
      const next = collapseSelection(this.selection);
      if (next === this.selection) return; // nothing to collapse: Escape is not ours
      e.preventDefault();
      e.stopPropagation();
      this.select(next);
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.select(selectAll(this.selection, order));
    } else if (!e.altKey && !e.ctrlKey && !e.metaKey) {
      // git's own todo letters: p r s f e d.
      const action = actionForKey(e.key);
      if (!action) return;
      e.preventDefault();
      this.bulkSet(action, true);
    }
  }

  // ── Drag-and-drop reorder ────────────────────────────────────────────────
  //
  // Picking up a SELECTED row carries the whole selection, in list order;
  // picking up any other row selects it and carries it alone. The line is
  // drawn on the half of the row the pointer is in, and the drop lands there
  // — the old line sat on top of the row while a downward drop landed below
  // it, one row off from what it promised.

  private onDragStart(e: DragEvent, index: number): void {
    const key = RebaseView.key(this.rows[index]);
    if (!this.selection.selected.includes(key)) this.select(selectOnly(key), false);
    this.dragging = dragKeys(this.selection, this.order(), key);
    this.dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require data to be set for the drag to start.
      e.dataTransfer.setData("text/plain", key);
    }
    this.requestUpdate();
  }

  private sideOf(e: DragEvent): "before" | "after" {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  }

  private onDragOver(e: DragEvent, index: number): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    this.overIndex = index;
    this.overSide = this.sideOf(e);
  }

  private onDragLeave(index: number): void {
    if (this.overIndex === index) {
      this.overIndex = null;
      this.overSide = null;
    }
  }

  private onDrop(e: DragEvent, index: number): void {
    e.preventDefault();
    const side = this.sideOf(e);
    const moving = this.dragging;
    this.dragging = [];
    this.dragIndex = null;
    this.overIndex = null;
    this.overSide = null;
    if (moving.length) this.reorder(moveKeysToGap(this.order(), moving, side === "before" ? index : index + 1));
  }

  private onDragEnd = (): void => {
    this.dragging = [];
    this.dragIndex = null;
    this.overIndex = null;
    this.overSide = null;
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  private start = (): void => {
    this.onIntent?.({
      type: "start",
      rows: this.rows.map((r) => ({ id: r.id, action: r.action })),
    });
  };

  private abort = (): void => {
    this.onIntent?.({ type: "abort" });
  };
}

if (!customElements.get("gitstudio-rebase")) {
  customElements.define("gitstudio-rebase", RebaseView);
}
