// The "Output" tab body: a live, scrollback log of every git command GitStudio
// runs on the open repo. It subscribes to the main process's `git:log` event the
// moment it's constructed (so the log fills even while the dock is collapsed),
// keeps a capped ring of rows, and sticks to the bottom unless the user has
// scrolled up to read history.
//
// Readability contract:
// - Commands executed by ONE user action (same `actionId`, tagged by the main
//   process) group under that action's label ("Pull", "Commit", …) once the
//   action runs a 2nd command; single-command actions stay lean rows with a
//   muted action tag. Group headers are collapsible and total their commands.
// - Consecutive identical single-command actions coalesce into one ×N row
//   (background pollers would otherwise flood the log).
// - The subcommand carries the line ("git" is muted; `fetch` is the keyword).
// - Failures are tinted, show their exit code, and expand on click to reveal
//   the captured stderr — the WHY, not just the fact.
// - A sticky toolbar shows totals, filters to failures only, and clears.

import { host } from "./bridge";
import { el, span, glyph } from "./ui";
import type { GitLogEntry } from "../shared/ipc";

/** Hard cap on rendered top-level blocks (rows/groups). */
const MAX_BLOCKS = 600;
/** Durations at/above this read as slow and get the warn tint. */
const SLOW_MS = 800;

/** The in-flight action being appended to (one group / lean row). */
interface ActionCtx {
  actionId: number | undefined;
  action: string | undefined;
  /** Group container + body once promoted (2+ commands). */
  group: HTMLElement | null;
  body: HTMLElement | null;
  /** Live header meta (count · duration), present once promoted. */
  meta: HTMLElement | null;
  rows: HTMLElement[];
  count: number;
  totalMs: number;
  failed: boolean;
  /** For in-group ×N coalescing of an immediately repeated command. */
  lastCommand: string | null;
  lastRow: HTMLElement | null;
  repeat: number;
}

export class OutputsPanel {
  /** The tab surface: sticky toolbar + scrolling list. */
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly countEl: HTMLElement;
  private off: (() => void) | null = null;
  private stick = true;
  private total = 0;
  private failed = 0;
  private failuresOnly = false;
  private ctx: ActionCtx | null = null;
  /** The last CLOSED single-command action, for cross-action ×N coalescing. */
  private lastSingle: {
    command: string;
    action: string | undefined;
    row: HTMLElement;
    count: number;
  } | null = null;

  constructor() {
    this.el = el("div", "outputs-wrap");

    // ── Sticky toolbar: totals · failures filter · clear ──────────────────
    const bar = el("div", "outputs-bar");
    this.countEl = el("span", "outputs-count");
    const failBtn = el("button", "mini-btn outputs-failbtn") as HTMLButtonElement;
    failBtn.append(glyph("error"), span("Errors only"));
    failBtn.title = "Show only failed commands";
    failBtn.setAttribute("aria-pressed", "false");
    failBtn.addEventListener("click", () => {
      this.failuresOnly = !this.failuresOnly;
      failBtn.classList.toggle("is-on", this.failuresOnly);
      failBtn.setAttribute("aria-pressed", String(this.failuresOnly));
      this.el.classList.toggle("failures-only", this.failuresOnly);
      if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    const clearBtn = el("button", "mini-btn") as HTMLButtonElement;
    clearBtn.append(glyph("clear-all"), span("Clear"));
    clearBtn.title = "Clear the log";
    clearBtn.addEventListener("click", () => this.clear());
    bar.append(this.countEl, el("span", "outputs-bar-spacer"), failBtn, clearBtn);

    // ── Scrolling log ──────────────────────────────────────────────────────
    this.scroller = el("div", "outputs-panel");
    this.empty = el("div", "outputs-empty");
    this.empty.append(
      span("Git command log", "outputs-empty-title"),
      span("Every git command GitStudio runs will appear here.", "outputs-empty-sub"),
    );
    this.list = el("div", "outputs-list");
    this.scroller.append(this.empty, this.list);
    this.el.append(bar, this.scroller);
    this.renderCount();

    // Stick to the bottom only when the user is already near it.
    this.scroller.addEventListener("scroll", () => {
      this.stick =
        this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 32;
    });

    this.off = host.on("git:log", (e) => this.append(e));
  }

  private renderCount(): void {
    this.countEl.replaceChildren(
      span(`${this.total} command${this.total === 1 ? "" : "s"}`, "outputs-count-n"),
    );
    if (this.failed > 0) {
      this.countEl.append(span(`· ${this.failed} failed`, "outputs-count-f"));
    }
  }

  private append(e: GitLogEntry): void {
    if (this.empty.isConnected) this.empty.remove();
    this.total++;
    if (e.failed) this.failed++;

    if (this.ctx && e.actionId !== undefined && this.ctx.actionId === e.actionId) {
      this.appendToAction(this.ctx, e);
    } else {
      this.startAction(e);
    }

    // Trim the oldest top-level blocks past the cap.
    while (this.list.childElementCount > MAX_BLOCKS) {
      this.list.firstElementChild?.remove();
    }
    this.renderCount();
    if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Close the current action and open a new one for this entry. */
  private startAction(e: GitLogEntry): void {
    // The previous action closed as a lean single row → remember it so an
    // identical follow-up action (the status poller) coalesces into ×N.
    const prev = this.ctx;
    if (prev && !prev.group && prev.count === 1 && !prev.failed) {
      this.lastSingle = {
        command: prev.lastCommand ?? "",
        action: prev.action,
        row: prev.rows[0],
        count: this.lastSingle && this.lastSingle.row === prev.rows[0]
          ? this.lastSingle.count
          : 1,
      };
    } else if (prev) {
      this.lastSingle = null;
    }

    // Cross-action ×N: an identical, successful, single-command action right
    // after the same one bumps the existing row instead of adding a line.
    if (
      this.lastSingle &&
      !e.failed &&
      this.lastSingle.command === e.command &&
      this.lastSingle.action === e.action
    ) {
      this.lastSingle.count++;
      this.updateRepeat(this.lastSingle.row, this.lastSingle.count, e);
      this.ctx = null;
      return;
    }

    const row = this.buildRow(e, true);
    this.list.appendChild(row);
    this.ctx = {
      actionId: e.actionId,
      action: e.action,
      group: null,
      body: null,
      meta: null,
      rows: [row],
      count: 1,
      totalMs: e.durationMs,
      failed: e.failed,
      lastCommand: e.command,
      lastRow: row,
      repeat: 1,
    };
  }

  /** A 2nd+ command for the SAME action: group it under the action label. */
  private appendToAction(ctx: ActionCtx, e: GitLogEntry): void {
    this.lastSingle = null;
    // Immediate repeat of the same successful command inside the action.
    if (!e.failed && ctx.lastCommand === e.command && ctx.lastRow) {
      ctx.repeat++;
      ctx.count++;
      ctx.totalMs += e.durationMs;
      this.updateRepeat(ctx.lastRow, ctx.repeat, e);
      this.updateGroupMeta(ctx);
      return;
    }

    if (!ctx.group) this.promoteToGroup(ctx);

    const row = this.buildRow(e, false);
    ctx.body!.appendChild(row);
    ctx.rows.push(row);
    ctx.count++;
    ctx.totalMs += e.durationMs;
    ctx.lastCommand = e.command;
    ctx.lastRow = row;
    ctx.repeat = 1;
    if (e.failed) {
      ctx.failed = true;
      ctx.group!.classList.add("has-fail");
    }
    this.updateGroupMeta(ctx);
  }

  /** Wrap a lean first row into a labeled, collapsible action group. */
  private promoteToGroup(ctx: ActionCtx): void {
    const group = el("div", "outputs-group" + (ctx.failed ? " has-fail" : ""));
    const head = el("button", "outputs-group-head") as HTMLButtonElement;
    const chev = glyph("chevron-down");
    chev.classList.add("outputs-group-chev");
    const label = span(ctx.action ?? "Action", "outputs-group-label");
    const meta = span("", "outputs-group-meta");
    head.append(chev, label, meta);
    head.setAttribute("aria-expanded", "true");
    head.addEventListener("click", () => {
      const collapsed = group.classList.toggle("is-collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
    });
    const body = el("div", "outputs-group-body");

    const first = ctx.rows[0];
    this.list.replaceChild(group, first);
    // The first row's inline action tag is redundant under the group header.
    first.querySelector(".outputs-act")?.remove();
    body.appendChild(first);
    group.append(head, body);
    ctx.group = group;
    ctx.body = body;
    ctx.meta = meta;
  }

  private updateGroupMeta(ctx: ActionCtx): void {
    if (ctx.meta) {
      ctx.meta.textContent = `${ctx.count} command${ctx.count === 1 ? "" : "s"} · ${dur(ctx.totalMs)}`;
    }
  }

  /** One log line: time · git subcommand args · [action] · ×N · duration. */
  private buildRow(e: GitLogEntry, leanTag: boolean): HTMLElement {
    const row = el("div", "outputs-row" + (e.failed ? " is-failed" : ""));
    const line = el("div", "outputs-line");
    const sub = e.args[0] ?? "";
    const rest = e.args.slice(1).join(" ");
    line.append(
      span(clock(e.at), "outputs-time"),
      span("git", "outputs-kw"),
      span(sub, "outputs-sub"),
      span(rest, "outputs-args"),
    );
    // Lean (ungrouped) rows carry their action as a muted inline tag.
    if (leanTag && e.action) {
      line.appendChild(span(e.action, "outputs-act"));
    }
    line.append(
      span("", "outputs-rep"),
      span(dur(e.durationMs), "outputs-dur" + (e.durationMs >= SLOW_MS ? " is-slow" : "")),
    );
    if (e.failed || (e.exitCode !== null && e.exitCode !== 0)) {
      const code = el("span", "outputs-code");
      code.textContent = e.exitCode === null ? "error" : `exit ${e.exitCode}`;
      line.appendChild(code);
    }
    row.appendChild(line);

    // Failures expand to show WHY (the captured stderr).
    const err = e.failed ? (e.stderr ?? "").trim() : "";
    if (err) {
      const chev = glyph("chevron-right");
      chev.classList.add("outputs-chevron");
      line.prepend(chev);
      const detail = el("pre", "outputs-stderr");
      detail.textContent = err;
      row.appendChild(detail);
      line.setAttribute("role", "button");
      line.setAttribute("tabindex", "0");
      line.title = "Show error output";
      const toggle = (): void => {
        const open = row.classList.toggle("is-open");
        line.title = open ? "Hide error output" : "Show error output";
      };
      line.addEventListener("click", toggle);
      line.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      });
    }
    return row;
  }

  /** Refresh a coalesced row in place: ×N badge, latest time + duration. */
  private updateRepeat(row: HTMLElement, count: number, e: GitLogEntry): void {
    const rep = row.querySelector(".outputs-rep");
    if (rep) rep.textContent = `×${count}`;
    const time = row.querySelector(".outputs-time");
    if (time) time.textContent = clock(e.at);
    const d = row.querySelector(".outputs-dur");
    if (d) {
      d.textContent = dur(e.durationMs);
      d.classList.toggle("is-slow", e.durationMs >= SLOW_MS);
    }
  }

  /** Clear the log. */
  clear(): void {
    this.list.replaceChildren();
    this.ctx = null;
    this.lastSingle = null;
    this.total = 0;
    this.failed = 0;
    this.renderCount();
    if (!this.empty.isConnected) this.scroller.insertBefore(this.empty, this.list);
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }
}

/** Format an epoch (ms) as a local HH:MM:SS clock. */
function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact duration: 45ms, 1.3s. */
function dur(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
