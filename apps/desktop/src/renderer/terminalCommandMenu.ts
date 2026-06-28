// Terminal command menu — the launcher/history popup (à la Warp's shot 4).
//
// A fully self-owned overlay (no PTY interception): a search box over two
// sections — quick Actions (with keybinding hints) and Recent commands (from
// history, fuzzy-filtered). Picking an action runs a callback; picking a recent
// command rewrites the current prompt line (only when at a prompt) so the user
// can review and run it. Because it never submits and only writes at a prompt,
// it can't disrupt a running program.

import { el, glyph, span } from "./ui";
import { fuzzyMatch } from "./fuzzyMatch";
import type { HistoryItem } from "./terminalCompletion";

export interface MenuAction {
  id: string;
  label: string;
  icon: string;
  /** A keybinding hint shown right-aligned, e.g. "⌘K". */
  hint?: string;
}

export interface CommandMenuOptions {
  history: () => HistoryItem[];
  atPrompt: () => boolean;
  actions: MenuAction[];
  onAction: (id: string) => void;
  /** Rewrite the current prompt line to `cmd` (caller guarantees at-prompt). */
  onInsertCommand: (cmd: string) => void;
}

export type Row =
  | { kind: "action"; action: MenuAction }
  | { kind: "command"; command: string; detail?: string };

const RECENT_LIMIT = 8;

/**
 * Pure row builder (DOM-free, unit-tested): actions fuzzy-filtered by label, then
 * recent commands (only when at a prompt) — recents when the query is empty,
 * fuzzy-ranked matches otherwise.
 */
export function buildMenuRows(
  query: string,
  actions: MenuAction[],
  history: HistoryItem[],
  atPrompt: boolean,
  recentLimit = RECENT_LIMIT,
): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  for (const a of actions) {
    if (!q || fuzzyMatch(q, a.label)) rows.push({ kind: "action", action: a });
  }
  if (atPrompt) {
    const matched = q
      ? history
          .map((h) => ({ h, m: fuzzyMatch(q, h.command) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m!.score - a.m!.score)
          .map((x) => x.h)
          .slice(0, 30)
      : history.slice(0, recentLimit);
    for (const h of matched) {
      rows.push({ kind: "command", command: h.command, detail: h.count > 1 ? `${h.count}×` : undefined });
    }
  }
  return rows;
}

export class TerminalCommandMenu {
  private readonly scrim: HTMLElement;
  private readonly card: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private rows: Row[] = [];
  private selected = 0;
  private open = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: CommandMenuOptions,
  ) {
    this.scrim = el("div", "term-menu-scrim");
    this.scrim.style.display = "none";
    this.card = el("div", "term-menu");
    this.input = el("input", "term-menu-input") as HTMLInputElement;
    this.input.placeholder = "Search commands and actions…";
    this.input.setAttribute("aria-label", "Search commands and actions");
    this.list = el("div", "term-menu-list");
    this.card.append(this.input, this.list);
    this.scrim.appendChild(this.card);
    this.container.appendChild(this.scrim);

    this.scrim.addEventListener("mousedown", (e) => {
      if (e.target === this.scrim) this.close();
    });
    this.input.addEventListener("input", () => {
      this.selected = 0;
      this.rebuild();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }

  show(): void {
    this.open = true;
    this.input.value = "";
    this.selected = 0;
    this.scrim.style.display = "";
    this.rebuild();
    this.input.focus();
  }

  close(): void {
    this.open = false;
    this.scrim.style.display = "none";
  }

  isOpen(): boolean {
    return this.open;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.activate(this.rows[this.selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private move(dir: 1 | -1): void {
    const n = this.rows.length;
    if (!n) return;
    this.selected = (this.selected + dir + n) % n;
    this.renderSelection();
  }

  private activate(row: Row | undefined): void {
    if (!row) return;
    this.close();
    if (row.kind === "action") {
      this.opts.onAction(row.action.id);
    } else if (this.opts.atPrompt()) {
      this.opts.onInsertCommand(row.command);
    }
  }

  private rebuild(): void {
    this.rows = buildMenuRows(
      this.input.value,
      this.opts.actions,
      this.opts.history(),
      this.opts.atPrompt(),
    );
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    let lastKind: Row["kind"] | null = null;
    this.rows.forEach((row, i) => {
      if (row.kind !== lastKind) {
        this.list.appendChild(
          span(row.kind === "action" ? "Actions" : "Recent commands", "term-menu-section"),
        );
        lastKind = row.kind;
      }
      const r = el("div", "term-menu-row" + (i === this.selected ? " is-active" : ""));
      r.dataset.idx = String(i);
      if (row.kind === "action") {
        r.append(glyph(row.action.icon), span(row.action.label, "term-menu-label"));
        if (row.action.hint) r.appendChild(span(row.action.hint, "term-menu-hint"));
      } else {
        r.append(glyph("history"), span(row.command, "term-menu-label"));
        if (row.detail) r.appendChild(span(row.detail, "term-menu-hint"));
      }
      r.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.activate(row);
      });
      r.addEventListener("mouseenter", () => {
        this.selected = i;
        this.renderSelection();
      });
      this.list.appendChild(r);
    });
  }

  private renderSelection(): void {
    for (const node of Array.from(this.list.querySelectorAll<HTMLElement>(".term-menu-row"))) {
      const on = Number(node.dataset.idx) === this.selected;
      node.classList.toggle("is-active", on);
      if (on) node.scrollIntoView({ block: "nearest" });
    }
  }

  dispose(): void {
    this.scrim.remove();
  }
}
