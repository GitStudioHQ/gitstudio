// A lightweight, theme-native right-click menu for a commit row in the graph.
// Destructive actions (reset --hard, revert) are confirm-gated here in the
// renderer before the request reaches the main process, per the brief.

import type { CommitActionRequest } from "../shared/ipc";

interface MenuItem {
  label: string;
  action: CommitActionRequest["action"];
  /** Requires a free-text name (new branch / tag). */
  prompt?: string;
  /** Show a confirm() dialog before dispatching. */
  confirm?: string;
  danger?: boolean;
}

const ITEMS: MenuItem[] = [
  { label: "Checkout", action: "checkout", confirm: "Checkout this commit (detached HEAD)?" },
  { label: "Create Branch Here…", action: "branch", prompt: "New branch name:" },
  { label: "Create Tag Here…", action: "tag", prompt: "New tag name:" },
  { label: "Cherry-pick", action: "cherry-pick" },
  { label: "Revert", action: "revert", confirm: "Create a revert commit for this commit?" },
  { label: "Reset (soft)", action: "reset-soft", confirm: "Move HEAD here, keep index & working tree?" },
  { label: "Reset (mixed)", action: "reset-mixed", confirm: "Move HEAD here, reset index, keep working tree?" },
  { label: "Reset (hard)", action: "reset-hard", confirm: "DISCARD all changes and reset HEAD here? This cannot be undone.", danger: true },
  { label: "Copy SHA", action: "copy-sha" },
];

export class CommitContextMenu {
  private menu?: HTMLElement;

  constructor(
    /** Dispatches a fully-resolved action request to the host. */
    public readonly resolve: (req: CommitActionRequest) => void,
  ) {
    document.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.close();
      }
    });
  }

  open(sha: string, x: number, y: number): void {
    this.close();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    const header = document.createElement("div");
    header.className = "ctx-menu-header";
    header.textContent = sha.slice(0, 10);
    menu.appendChild(header);

    for (const item of ITEMS) {
      const button = document.createElement("button");
      button.className = `ctx-menu-item${item.danger ? " ctx-danger" : ""}`;
      button.textContent = item.label;
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close();
        this.dispatch(item, sha);
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    // Clamp to the viewport.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    this.menu = menu;
  }

  private dispatch(item: MenuItem, sha: string): void {
    let name: string | undefined;
    if (item.prompt) {
      const value = window.prompt(item.prompt)?.trim();
      if (!value) {
        return;
      }
      name = value;
    }
    if (item.confirm && !window.confirm(item.confirm)) {
      return;
    }
    this.resolve({ action: item.action, sha, name });
  }

  private close(): void {
    this.menu?.remove();
    this.menu = undefined;
  }
}
