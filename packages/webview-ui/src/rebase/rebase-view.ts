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

import { LitElement, html, css } from "lit";
import { codiconStyles } from "../styles/codicons";
import { hostTokens } from "../styles/hostTokens";
import type {
  WireRebaseAction,
  WireRebaseRow,
} from "@gitstudio/host-bridge/rebaseProtocol";

export type RebaseIntent =
  | { type: "start"; rows: Array<{ id: number; action: WireRebaseAction }> }
  | { type: "abort" };

const ACTIONS: ReadonlyArray<{
  value: WireRebaseAction;
  label: string;
  hint: string;
}> = [
  { value: "pick", label: "pick", hint: "use the commit as-is" },
  { value: "reword", label: "reword", hint: "use commit, edit its message" },
  { value: "edit", label: "edit", hint: "stop to amend the commit" },
  { value: "squash", label: "squash", hint: "meld into the previous commit" },
  { value: "fixup", label: "fixup", hint: "meld in, drop this message" },
  { value: "drop", label: "drop", hint: "remove the commit" },
];

interface Row extends WireRebaseRow {}

export class RebaseView extends LitElement {
  static properties = {
    headerComment: { attribute: false },
    rows: { attribute: false },
    onIntent: { attribute: false },
    dragIndex: { state: true },
    overIndex: { state: true },
  };

  headerComment: string | null = null;
  rows: Row[] = [];
  onIntent: ((intent: RebaseIntent) => void) | null = null;

  private dragIndex: number | null = null;
  private overIndex: number | null = null;

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
    .row.dragging {
      opacity: 0.5;
    }
    .row.over {
      border-color: var(--gs-accent);
      box-shadow: inset 0 2px 0 var(--gs-accent);
    }
    .row.drop {
      opacity: 0.55;
    }

    .grip {
      grid-column: 2;
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
    const kept = this.rows.filter((r) => r.action !== "drop").length;
    return html`
      <header>
        <p class="eyebrow">Interactive Rebase</p>
        <div class="title">
          ${this.headerComment
            ? this.headerComment
            : html`Rebasing
                <span class="mono">${total}</span> commit${total === 1
                  ? ""
                  : "s"}`}
        </div>
        <div class="hint">
          <span>Drag rows or press</span>
          <kbd>Alt</kbd>
          <span aria-hidden="true">+</span>
          <kbd aria-label="Up arrow">${RebaseView.chevronUp}</kbd>
          <span aria-hidden="true">/</span>
          <kbd aria-label="Down arrow">${RebaseView.chevronDown}</kbd>
          <span>to reorder. Topmost runs first; set each commit's action.</span>
        </div>
      </header>

      <div class="list" role="list" aria-label="Rebase commits">
        ${total === 0
          ? html`<div class="empty">No commits to rebase.</div>`
          : this.rows.map((row, index) => this.renderRow(row, index, total))}
      </div>

      <footer>
        <span class="count" aria-live="polite">
          <span class="mono">${kept}</span> of
          <span class="mono">${total}</span> commit${total === 1 ? "" : "s"} kept
        </span>
        <span class="spacer"></span>
        <button class="cta danger" @click=${this.abort}>Abort</button>
        <button
          class="cta primary"
          @click=${this.start}
          ?disabled=${total === 0}
        >
          Start rebase
        </button>
      </footer>
    `;
  }

  private renderRow(row: Row, index: number, total: number) {
    const dragging = this.dragIndex === index;
    const over = this.overIndex === index && this.dragIndex !== index;
    const classes = [
      "row",
      dragging ? "dragging" : "",
      over ? "over" : "",
      row.action === "drop" ? "drop" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${classes}
        role="listitem"
        tabindex="0"
        data-action=${row.action}
        aria-label=${`Commit ${row.shortSha}, ${row.subject}, action ${row.action}`}
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
          aria-label=${`Action for ${row.shortSha}`}
          .value=${row.action}
          @change=${(e: Event) =>
            this.setAction(index, (e.target as HTMLSelectElement).value as WireRebaseAction)}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
        >
          ${ACTIONS.map(
            (a) => html`<option value=${a.value} title=${a.hint}>
              ${a.label}
            </option>`,
          )}
        </select>
        <span class="sha" title=${row.sha}>${row.shortSha}</span>
        <span class="subject" title=${row.subject}>${row.subject}</span>
        <span class="move">
          <button
            class="icon"
            title="Move up (Alt+Up)"
            aria-label="Move up"
            ?disabled=${index === 0}
            @click=${() => this.move(index, index - 1)}
          >
            <span class="codicon codicon-chevron-up" aria-hidden="true"></span>
          </button>
          <button
            class="icon"
            title="Move down (Alt+Down)"
            aria-label="Move down"
            ?disabled=${index === total - 1}
            @click=${() => this.move(index, index + 1)}
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

  private setAction(index: number, action: WireRebaseAction): void {
    const next = this.rows.slice();
    next[index] = { ...next[index], action };
    this.rows = next;
  }

  /** Move the row at `from` to `to`, clamping and re-focusing the moved row. */
  private move(from: number, to: number): void {
    if (to < 0 || to >= this.rows.length || from === to) {
      return;
    }
    const next = this.rows.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.rows = next;
    // Restore focus to the row at its new index after the re-render.
    this.updateComplete.then(() => {
      const items = this.renderRoot.querySelectorAll<HTMLElement>(".row");
      items[to]?.focus();
    });
  }

  // ── Keyboard reorder (Alt+Up/Down) ───────────────────────────────────────

  private onRowKeydown(e: KeyboardEvent, index: number): void {
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      this.move(index, index - 1);
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      this.move(index, index + 1);
    }
  }

  // ── Drag-and-drop reorder ────────────────────────────────────────────────

  private onDragStart(e: DragEvent, index: number): void {
    this.dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require data to be set for the drag to start.
      e.dataTransfer.setData("text/plain", String(index));
    }
  }

  private onDragOver(e: DragEvent, index: number): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    this.overIndex = index;
  }

  private onDragLeave(index: number): void {
    if (this.overIndex === index) {
      this.overIndex = null;
    }
  }

  private onDrop(e: DragEvent, index: number): void {
    e.preventDefault();
    if (this.dragIndex !== null && this.dragIndex !== index) {
      this.move(this.dragIndex, index);
    }
    this.dragIndex = null;
    this.overIndex = null;
  }

  private onDragEnd = (): void => {
    this.dragIndex = null;
    this.overIndex = null;
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
