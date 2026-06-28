// The "Output" tab body: a live, scrollback log of every git command GitStudio
// runs on the open repo. It subscribes to the main process's `git:log` event the
// moment it's constructed (so the log fills even while the dock is collapsed),
// keeps a capped ring of rows, and sticks to the bottom unless the user has
// scrolled up to read history.

import { host } from "./bridge";
import { el, span } from "./ui";
import type { GitLogEntry } from "../shared/ipc";

/** Hard cap on rendered rows — a busy session can run thousands of commands. */
const MAX_ROWS = 600;

export class OutputsPanel {
  /** The scroll container — mount this as the tab surface. */
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private off: (() => void) | null = null;
  private stick = true;

  constructor() {
    this.el = el("div", "outputs-panel");
    this.empty = el("div", "outputs-empty");
    this.empty.append(
      span("Git command log", "outputs-empty-title"),
      span("Every git command GitStudio runs will appear here.", "outputs-empty-sub"),
    );
    this.list = el("div", "outputs-list");
    this.el.append(this.empty, this.list);

    // Stick to the bottom only when the user is already near it.
    this.el.addEventListener("scroll", () => {
      this.stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 32;
    });

    this.off = host.on("git:log", (e) => this.append(e));
  }

  private append(e: GitLogEntry): void {
    if (this.empty.isConnected) this.empty.remove();

    const row = el("div", "outputs-row" + (e.failed ? " is-failed" : ""));
    row.append(
      span(clock(e.at), "outputs-time"),
      span("git", "outputs-kw"),
      span(e.args.join(" "), "outputs-args"),
      span(`${e.durationMs}ms`, "outputs-dur"),
    );
    if (e.failed || (e.exitCode !== null && e.exitCode !== 0)) {
      const code = el("span", "outputs-code");
      code.textContent = e.exitCode === null ? "error" : `exit ${e.exitCode}`;
      row.appendChild(code);
    }
    this.list.appendChild(row);

    // Trim the oldest rows past the cap.
    while (this.list.childElementCount > MAX_ROWS) {
      this.list.firstElementChild?.remove();
    }

    if (this.stick) this.el.scrollTop = this.el.scrollHeight;
  }

  /** Clear the log. */
  clear(): void {
    this.list.replaceChildren();
    if (!this.empty.isConnected) this.el.insertBefore(this.empty, this.list);
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
