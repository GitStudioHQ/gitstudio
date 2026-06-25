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

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
    }

    header {
      flex: 0 0 auto;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    }
    .title {
      font-size: 1.05em;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title .glyph {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      box-shadow: 0 0 0 3px
        color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 25%, transparent);
    }
    .subtitle {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    .hint {
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      opacity: 0.85;
    }
    kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
      background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.12));
    }

    .list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .row {
      display: grid;
      grid-template-columns: 22px 110px 70px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-radius: 7px;
      border: 1px solid transparent;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.06));
      cursor: default;
      transition: background 0.08s ease, border-color 0.08s ease,
        transform 0.08s ease, opacity 0.08s ease;
    }
    .row:hover {
      border-color: var(--vscode-focusBorder, rgba(128, 128, 128, 0.35));
    }
    .row:focus-visible {
      outline: none;
      border-color: var(--vscode-focusBorder, #3794ff);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #3794ff);
    }
    .row.dragging {
      opacity: 0.5;
    }
    .row.over {
      border-color: var(--vscode-focusBorder, #3794ff);
      box-shadow: inset 0 2px 0 var(--vscode-focusBorder, #3794ff);
    }
    .row.drop {
      opacity: 0.45;
      filter: grayscale(0.4);
    }

    .grip {
      cursor: grab;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      user-select: none;
      line-height: 1;
      font-size: 14px;
    }
    .grip:active {
      cursor: grabbing;
    }

    select.action {
      font-family: inherit;
      font-size: 0.9em;
      font-weight: 600;
      padding: 3px 6px;
      border-radius: 5px;
      border: 1px solid var(--vscode-dropdown-border, rgba(128, 128, 128, 0.4));
      background: var(--vscode-dropdown-background);
      color: var(--action-fg, var(--vscode-dropdown-foreground));
      cursor: pointer;
    }
    /* Distinct accent per action — a colored left border + tinted text. */
    .row {
      --action-fg: var(--vscode-foreground);
      --action-accent: var(--vscode-descriptionForeground);
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
      width: 4px;
      align-self: stretch;
      border-radius: 3px;
      background: var(--action-accent);
      grid-column: 1;
      justify-self: start;
      min-height: 18px;
    }
    select.action {
      color: var(--action-accent);
      border-color: color-mix(in srgb, var(--action-accent) 50%, transparent);
    }
    select.action:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, #3794ff);
      outline-offset: 1px;
    }
    /* Respect the OS "reduce motion" setting: keep the layout, drop the easing. */
    @media (prefers-reduced-motion: reduce) {
      .row {
        transition: none;
      }
    }

    .sha {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
    }
    .subject {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row[data-action="drop"] .subject {
      text-decoration: line-through;
      opacity: 0.6;
    }

    .move {
      display: inline-flex;
      gap: 2px;
    }
    button.icon {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      width: 22px;
      height: 22px;
      font-size: 12px;
      line-height: 1;
      padding: 0;
    }
    button.icon:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-foreground);
    }
    button.icon:disabled {
      opacity: 0.3;
      cursor: default;
    }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, #3794ff);
      outline-offset: 1px;
    }

    footer {
      flex: 0 0 auto;
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 12px 18px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    }
    .spacer {
      flex: 1 1 auto;
    }
    button.cta {
      font-family: inherit;
      font-size: 0.95em;
      padding: 6px 16px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    }
    button.danger {
      background: transparent;
      color: var(--vscode-errorForeground, #f14c4c);
      border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 45%, transparent);
    }
    button.danger:hover {
      background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 12%, transparent);
    }
    .count {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .empty {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  `;

  render() {
    const total = this.rows.length;
    const kept = this.rows.filter((r) => r.action !== "drop").length;
    return html`
      <header>
        <div class="title">
          <span class="glyph"></span>
          Interactive Rebase
        </div>
        <div class="subtitle">
          ${this.headerComment ??
          `Rebasing ${total} commit${total === 1 ? "" : "s"}`}
        </div>
        <div class="hint">
          Drag rows or use <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> to reorder.
          Topmost runs first. Set each commit's action below.
        </div>
      </header>

      <div class="list" role="list" aria-label="Rebase commits">
        ${total === 0
          ? html`<div class="empty">No commits to rebase.</div>`
          : this.rows.map((row, index) => this.renderRow(row, index, total))}
      </div>

      <footer>
        <span class="count">
          ${kept} of ${total} commit${total === 1 ? "" : "s"} kept
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
            ↑
          </button>
          <button
            class="icon"
            title="Move down (Alt+Down)"
            aria-label="Move down"
            ?disabled=${index === total - 1}
            @click=${() => this.move(index, index + 1)}
          >
            ↓
          </button>
        </span>
        <span class="grip" aria-hidden="true">⠿</span>
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
