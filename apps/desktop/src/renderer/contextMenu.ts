// A lightweight, theme-native right-click menu for a commit row in the graph.
// Destructive actions (reset --hard, revert) are confirm-gated here in the
// renderer (via the in-app dialog, not native confirm()) before the request
// reaches the main process. Fully keyboard-navigable.

import type { CommitActionRequest } from "../shared/ipc";
import { confirmDialog, promptInline } from "./dialogs";

interface MenuItem {
  label: string;
  action: CommitActionRequest["action"];
  /** Requires a free-text name (new branch / tag). */
  prompt?: string;
  /** Show a confirm dialog before dispatching. */
  confirm?: string;
  danger?: boolean;
}

const ITEMS: MenuItem[] = [
  { label: "Checkout", action: "checkout", confirm: "Checkout this commit (detached HEAD)?" },
  { label: "Create Branch Here…", action: "branch", prompt: "feature/my-branch" },
  { label: "Create Tag Here…", action: "tag", prompt: "v1.0.0" },
  { label: "Cherry-pick", action: "cherry-pick" },
  { label: "Revert", action: "revert", confirm: "Create a revert commit for this commit?" },
  { label: "Reset (soft)", action: "reset-soft", confirm: "Move HEAD here, keep index & working tree?" },
  { label: "Reset (mixed)", action: "reset-mixed", confirm: "Move HEAD here, reset index, keep working tree?" },
  { label: "Reset (hard)", action: "reset-hard", confirm: "DISCARD all changes and reset HEAD here? This cannot be undone.", danger: true },
  { label: "Copy SHA", action: "copy-sha" },
];

export class CommitContextMenu {
  private menu?: HTMLElement;
  private prevFocus?: HTMLElement | null;
  private rows: HTMLElement[] = [];
  private readonly onDocClick = (): void => this.close();
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(
    /** Dispatches a fully-resolved action request to the host. */
    public readonly resolve: (req: CommitActionRequest) => void,
  ) {}

  open(sha: string, x: number, y: number): void {
    this.close();
    this.prevFocus = document.activeElement as HTMLElement | null;
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.setAttribute("role", "menu");
    const header = document.createElement("div");
    header.className = "ctx-menu-header";
    header.textContent = sha.slice(0, 10);
    menu.appendChild(header);

    this.rows = [];
    for (const item of ITEMS) {
      const button = document.createElement("button");
      button.className = `ctx-menu-item${item.danger ? " ctx-danger" : ""}`;
      button.textContent = item.label;
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(false);
        void this.dispatch(item, sha);
      });
      menu.appendChild(button);
      this.rows.push(button);
    }

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    this.menu = menu;

    document.addEventListener("keydown", this.onKey, true);
    setTimeout(() => {
      document.addEventListener("click", this.onDocClick);
      this.rows[0]?.focus();
    }, 0);
  }

  private focusAt(i: number): void {
    if (!this.rows.length) return;
    const idx = ((i % this.rows.length) + this.rows.length) % this.rows.length;
    this.rows[idx].focus();
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.menu) return;
    const cur = this.rows.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.focusAt(cur < 0 ? 0 : cur + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.focusAt(cur < 0 ? this.rows.length - 1 : cur - 1);
        break;
      case "Home":
        e.preventDefault();
        this.focusAt(0);
        break;
      case "End":
        e.preventDefault();
        this.focusAt(this.rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (cur >= 0) {
          e.preventDefault();
          this.rows[cur].click();
        }
        break;
      case "Tab":
        this.close(false);
        break;
    }
  }

  private async dispatch(item: MenuItem, sha: string): Promise<void> {
    let name: string | undefined;
    if (item.prompt) {
      const value = (await promptInline(item.label.replace(/…$/, ""), item.prompt))?.trim();
      if (!value) return;
      name = value;
    }
    if (item.confirm) {
      const ok = await confirmDialog({
        title: item.label,
        message: item.confirm,
        confirmLabel: item.danger ? "Reset" : item.label.replace(/…$/, ""),
        danger: item.danger,
      });
      if (!ok) return;
    }
    this.resolve({ action: item.action, sha, name });
  }

  private close(restoreFocus = true): void {
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("click", this.onDocClick);
    this.menu?.remove();
    this.menu = undefined;
    this.rows = [];
    if (restoreFocus) this.prevFocus?.focus?.();
  }
}
