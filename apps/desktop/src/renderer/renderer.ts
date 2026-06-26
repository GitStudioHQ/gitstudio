// GitStudio desktop renderer — the app shell.
//
// Layout: a custom titlebar, a left sidebar (repo header + refs/branches list +
// Open/recent), and a main area that mounts the shared <gitstudio-graph>. A
// commit selection opens a details + changed-files panel; clicking a file opens
// the shared Monaco DiffView, or the 3-pane MergeView for a conflict. Theme is
// supplied via the desktopTheme shim so every shared component renders unchanged.

// Reuse the shared component stylesheets verbatim: the JetBrains diff/merge
// palette + gutter chrome, and the graph host-page frame. The renderer carries
// the same look as the extension because it ships the same CSS.
import "@gitstudio/webview-ui/styles/diff.css";
import "@gitstudio/webview-ui/styles/graph.css";
import "@gitstudio/webview-ui/commit-details";
import "./styles/app.css";
import { host } from "./bridge";
import { applyTheme, followSystemTheme, preferredTheme } from "./desktopTheme";
import { GraphMount } from "./graphMount";
import { DiffPanel } from "./diffPanel";
import { CommitContextMenu } from "./contextMenu";
import type { CommitDetails as CommitDetailsEl } from "@gitstudio/webview-ui/commit-details";
import type {
  ChangedFile,
  CommitDetailsPayload,
  RefInfo,
  RepoInfo,
} from "../shared/ipc";

class App {
  private graph!: GraphMount;
  private diffPanel!: DiffPanel;
  private contextMenu = new CommitContextMenu((req) => this.runAction(req));

  private detailsEl!: HTMLElement;
  private diffSurfaceEl?: HTMLElement;
  private repoSwitchName?: HTMLElement;
  private branchSwitchName?: HTMLElement;
  private selectedSha?: string;
  private currentRepo?: RepoInfo;
  private refs: RefInfo[] = [];

  async start(): Promise<void> {
    applyTheme(preferredTheme());
    followSystemTheme();
    this.wireHostEvents();

    const current = await host.invoke("repo:current", undefined);
    if (current) {
      this.showRepoScreen(current);
    } else {
      await this.showWelcome();
    }
  }

  // ── Welcome / repo-picker screen ────────────────────────────────────────────

  private async showWelcome(): Promise<void> {
    this.currentRepo = undefined;
    const screen = el("div", "screen welcome");
    const card = el("div", "welcome-card");

    const logo = document.createElement("img");
    logo.className = "welcome-logo";
    logo.src = "./brand-logo.svg";
    logo.alt = "GitStudio";

    const wordmark = document.createElement("img");
    wordmark.className = "welcome-wordmark";
    const dark = document.body.classList.contains("vscode-dark");
    wordmark.src = dark ? "./brand-wordmark-light.svg" : "./brand-wordmark-dark.svg";
    wordmark.alt = "GitStudio";

    const tagline = el("div", "welcome-tagline");
    tagline.textContent =
      "A JetBrains-grade Git client — your whole workflow, beautifully.";

    const open = el("button", "btn btn-primary welcome-open");
    open.append(glyph("folder-opened"), span("Open Repository…"));
    open.addEventListener("click", () => void this.openRepo());

    card.append(logo, wordmark, tagline, open);

    const recentWrap = el("div", "welcome-recent");
    const title = el("div", "welcome-recent-title");
    title.textContent = "Recent repositories";
    const list = el("div", "welcome-recent-list");
    const recent = await host.invoke("repo:recent", undefined);
    if (recent.length === 0) {
      const empty = el("div", "welcome-recent-empty");
      empty.textContent = "No recent repositories yet — open one to begin.";
      list.appendChild(empty);
    } else {
      for (const r of recent) {
        const row = el("button", "recent-card");
        const meta = el("div", "recent-card-meta");
        const name = el("div", "recent-card-name");
        name.textContent = r.name;
        const path = el("div", "recent-card-path");
        path.textContent = r.root;
        meta.append(name, path);
        row.append(glyph("repo"), meta);
        row.addEventListener("click", () => void this.openPath(r.root));
        list.appendChild(row);
      }
    }
    recentWrap.append(title, list);
    card.appendChild(recentWrap);
    screen.appendChild(card);
    document.getElementById("root")!.replaceChildren(screen);
  }

  // ── Repo screen (the full window is dedicated to the open repo) ──────────────

  private showRepoScreen(info: RepoInfo): void {
    this.currentRepo = info;
    this.selectedSha = undefined;
    const screen = el("div", "screen repo");
    screen.appendChild(this.topbar(info));

    const main = el("div", "repo-main");
    const graphHost = el("div", "graph-host");
    const detailsHost = el("div", "details-host");
    this.detailsEl = detailsHost;
    main.append(graphHost, detailsHost);
    screen.appendChild(main);

    document.getElementById("root")!.replaceChildren(screen);

    this.graph = new GraphMount(graphHost, {
      onSelect: (sha) => void this.selectCommit(sha),
      onOpen: (sha) => void this.selectCommit(sha),
      onContext: (sha, x, y) => this.contextMenu.open(sha, x, y),
    });
    this.showDetailsPlaceholder();
    void this.refreshRefs();
    void this.graph.reload();
  }

  private topbar(info: RepoInfo): HTMLElement {
    const bar = el("header", "topbar");

    const home = el("button", "topbar-home");
    home.title = "Back to main menu";
    const mark = document.createElement("img");
    mark.className = "topbar-mark";
    mark.src = "./brand-mark.svg";
    mark.alt = "GitStudio";
    home.appendChild(mark);
    home.addEventListener("click", () => void this.backToMenu());

    const repoSwitch = el("button", "topbar-switch");
    const repoName = el("span", "switch-name");
    repoName.textContent = info.name;
    this.repoSwitchName = repoName;
    repoSwitch.append(glyph("repo"), repoName, glyph("chevron-down"));
    repoSwitch.title = info.root;
    repoSwitch.addEventListener("click", () => void this.openRepoMenu(repoSwitch));

    const spacer = el("div", "topbar-spacer");

    const branchSwitch = el("button", "topbar-switch");
    const branchName = el("span", "switch-name");
    branchName.textContent = "…";
    this.branchSwitchName = branchName;
    branchSwitch.append(glyph("git-branch"), branchName, glyph("chevron-down"));
    branchSwitch.addEventListener("click", () => this.openBranchMenu(branchSwitch));

    const refresh = el("button", "topbar-icon");
    refresh.title = "Refresh";
    refresh.appendChild(glyph("refresh"));
    refresh.addEventListener("click", () => void this.refreshAll());

    bar.append(home, repoSwitch, spacer, branchSwitch, refresh);
    return bar;
  }

  // ── Host events ──────────────────────────────────────────────────────────────

  private wireHostEvents(): void {
    host.on("repo:changed", (info) => {
      if (info) {
        this.showRepoScreen(info);
      } else {
        void this.showWelcome();
      }
    });
    host.on("menu:command", (msg) => {
      if (msg.command === "openRepo") void this.openRepo();
      else if (msg.command === "refresh") void this.refreshAll();
      else if (msg.command === "closeRepo") void this.backToMenu();
    });
  }

  // ── Repo lifecycle (screen transitions are driven by repo:changed) ──────────

  private async openRepo(): Promise<void> {
    await host.invoke("repo:open", undefined);
  }
  private async openPath(root: string): Promise<void> {
    await host.invoke("repo:openPath", root);
  }
  private async backToMenu(): Promise<void> {
    await host.invoke("repo:close", undefined);
  }

  private async refreshAll(): Promise<void> {
    if (!this.currentRepo) {
      return;
    }
    await this.refreshRefs();
    await this.graph.reload();
  }

  // ── Top-bar dropdowns (repo switcher + branch switcher) ─────────────────────

  private async openRepoMenu(anchor: HTMLElement): Promise<void> {
    const recent = await host.invoke("repo:recent", undefined);
    const items: MenuItem[] = [
      {
        label: "Open Repository…",
        icon: "folder-opened",
        onClick: () => void this.openRepo(),
      },
    ];
    const others = recent
      .filter((r) => r.root !== this.currentRepo?.root)
      .slice(0, 8);
    if (others.length) {
      items.push({ separator: true, label: "Recent" });
      for (const r of others) {
        items.push({
          label: r.name,
          sub: r.root,
          icon: "repo",
          onClick: () => void this.openPath(r.root),
        });
      }
    }
    items.push({ separator: true });
    items.push({
      label: "Back to Main Menu",
      icon: "home",
      onClick: () => void this.backToMenu(),
    });
    openMenu(anchor, items);
  }

  private openBranchMenu(anchor: HTMLElement): void {
    const locals = this.refs.filter((r) => r.type === "head");
    const remotes = this.refs.filter((r) => r.type === "remote");
    const tags = this.refs.filter((r) => r.type === "tag");
    const items: MenuItem[] = [];
    if (locals.length) {
      items.push({ separator: true, label: "Branches" });
      for (const b of locals) {
        items.push({
          label: b.name,
          icon: "git-branch",
          current: b.isCurrent,
          onClick: () => this.graph.reveal(b.sha),
        });
      }
    }
    if (remotes.length) {
      items.push({ separator: true, label: "Remotes" });
      for (const b of remotes.slice(0, 16)) {
        items.push({
          label: b.name,
          icon: "cloud",
          onClick: () => this.graph.reveal(b.sha),
        });
      }
    }
    if (tags.length) {
      items.push({ separator: true, label: "Tags" });
      for (const t of tags.slice(0, 16)) {
        items.push({
          label: t.name,
          icon: "tag",
          onClick: () => this.graph.reveal(t.sha),
        });
      }
    }
    if (items.length === 0) {
      items.push({ label: "No branches yet", disabled: true });
    }
    openMenu(anchor, items);
  }

  // ── Refs / HEAD (drives the branch switcher) ────────────────────────────────

  private async refreshRefs(): Promise<void> {
    const [refs, head] = await Promise.all([
      host.invoke("refs:list", undefined),
      host.invoke("head:get", undefined),
    ]);
    this.refs = refs;
    if (this.branchSwitchName) {
      this.branchSwitchName.textContent = !head
        ? "HEAD"
        : head.detached
          ? `detached @ ${head.sha.slice(0, 7)}`
          : (head.branch ?? "HEAD");
    }
  }

  // ── Commit selection & details ───────────────────────────────────────────────

  private async selectCommit(sha: string): Promise<void> {
    this.selectedSha = sha;
    const details = await host.invoke("commit:details", sha);
    if (!details || this.selectedSha !== sha) {
      return;
    }
    this.renderDetails(details);
  }

  /**
   * Mount the shared <gitstudio-commit-details> inspect panel (identical to the
   * extension) above a diff surface. Clicking a file in the panel reveals the
   * inline Monaco diff below it.
   */
  private renderDetails(d: CommitDetailsPayload): void {
    const wrap = el("div", "details-split");

    const panel = document.createElement(
      "gitstudio-commit-details",
    ) as CommitDetailsEl;
    panel.className = "details-panel";
    panel.details = d;
    panel.addEventListener("gs-file-open", (e) => {
      const detail = (e as CustomEvent).detail as { path: string };
      const f = d.files.find((x) => x.path === detail.path);
      if (f) {
        void this.openFile(
          { path: f.path, status: f.status },
          d.kind === "wip" ? undefined : d.sha,
        );
      }
    });
    panel.addEventListener("gs-copy", (e) => {
      const detail = (e as CustomEvent).detail as { text: string };
      void navigator.clipboard?.writeText(detail.text).catch(() => {});
    });
    panel.addEventListener("gs-action", (e) => {
      const detail = (e as CustomEvent).detail as { id: string; sha: string };
      void this.runDetailsAction(detail.id, detail.sha);
    });

    const surface = el("div", "diff-surface");
    this.diffSurfaceEl = surface;
    wrap.append(panel, surface);

    this.detailsEl.replaceChildren(wrap);
    this.diffPanel = new DiffPanel(surface);
    this.diffPanel.showEmpty("Select a file to view its diff.");
  }

  /** Route a details-panel toolbar action to the existing git context menu. */
  private async runDetailsAction(id: string, sha: string): Promise<void> {
    const map: Record<string, string> = {
      checkout: "checkout",
      branch: "branch",
      tag: "tag",
      "cherry-pick": "cherry-pick",
      revert: "revert",
      reset: "reset-mixed",
      "copy-sha": "copy-sha",
    };
    const action = map[id];
    if (action) {
      await this.runAction({ action, sha } as Parameters<App["runAction"]>[0]);
    }
  }

  private async openFile(file: ChangedFile, sha?: string): Promise<void> {
    this.detailsSplitEl()?.classList.add("diff-open");
    const diff = await host.invoke("file:diff", { path: file.path, sha });
    if (!diff) {
      this.diffPanel.showEmpty("No diff available.");
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", file.path);
      if (model) {
        this.diffPanel.showMerge(model);
        return;
      }
    }
    this.diffPanel.showDiff(diff);
  }

  private detailsSplitEl(): HTMLElement | null {
    return this.detailsEl.querySelector(".details-split");
  }

  private showDetailsPlaceholder(): void {
    const wrap = el("div", "details details-empty");
    const msg = el("div", "details-empty-msg");
    msg.textContent = this.currentRepo
      ? "Select a commit to see its details and changes."
      : "Open a repository to start exploring its history.";
    wrap.appendChild(msg);
    this.detailsEl.replaceChildren(wrap);
  }

  // ── Commit actions (context menu) ────────────────────────────────────────────

  private async runAction(req: Parameters<CommitContextMenu["resolve"]>[0]): Promise<void> {
    if (req.action === "copy-sha") {
      await navigator.clipboard?.writeText(req.sha).catch(() => {});
      return;
    }
    const result = await host.invoke("commit:action", req);
    if (!result.ok && result.message) {
      alert(result.message);
    }
    if (result.changed) {
      await this.refreshAll();
    }
  }
}

// ── tiny DOM helpers ───────────────────────────────────────────────────────────

function el(tagName: string, className = ""): HTMLElement {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}

function span(textContent: string): HTMLElement {
  const s = el("span");
  s.textContent = textContent;
  return s;
}

// ── Inline glyphs (the renderer's light DOM, so no codicon font here) ─────────
const GLYPHS: Record<string, string> = {
  "folder-opened":
    '<path d="M2.5 4.5h4l1.2 1.4H13.5v1H3.2L2 12.5V4.5z" fill="currentColor" opacity=".0"/><path d="M2 4.2h4.3l1.3 1.5H14v1.1H2.2zM2 7h12.4l-1.5 5.6a1 1 0 0 1-1 .7H2.5a.7.7 0 0 1-.7-.9L2 7z" fill="currentColor"/>',
  repo:
    '<path d="M4 2.5h7.5a1 1 0 0 1 1 1V13l-2-1.3L8.5 13l-2-1.3L4.5 13H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  "chevron-down":
    '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  "git-branch":
    '<path d="M5 3.5a1.5 1.5 0 1 0-2 1.41V11a1.5 1.5 0 1 0 1 0V8.9c.6.4 1.3.6 2 .6h1A2.5 2.5 0 0 0 10.45 8 1.5 1.5 0 1 0 9.4 7H8a1.5 1.5 0 0 1-1.5-1.5V4.9A1.5 1.5 0 0 0 5 3.5z" fill="currentColor"/>',
  cloud:
    '<path d="M4.5 12a3.2 3.2 0 0 1-.3-6.4A4 4 0 0 1 12 6a2.8 2.8 0 0 1-.4 6H4.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  tag:
    '<path d="M2 2h6l6 6-6 6-6-6V2zm2.6 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" fill="currentColor"/>',
  refresh:
    '<path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5V5h-2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  home:
    '<path d="M3 8l5-4.5L13 8M4.5 7v5.5h7V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  check:
    '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

function glyph(name: string): HTMLElement {
  const s = el("span", "glyph");
  s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${GLYPHS[name] ?? ""}</svg>`;
  return s;
}

interface MenuItem {
  label?: string;
  sub?: string;
  icon?: string;
  current?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

/** A lightweight popover menu anchored below `anchor`, closed on outside click. */
function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  document.querySelectorAll(".dropdown").forEach((n) => n.remove());
  const menu = el("div", "dropdown");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 5)}px`;

  const close = (): void => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
  };
  const onDoc = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close();
  };

  for (const it of items) {
    if (it.separator) {
      const sep = el("div", "dropdown-sep");
      if (it.label) sep.textContent = it.label;
      menu.appendChild(sep);
      continue;
    }
    const row = el(
      "button",
      "dropdown-item" +
        (it.current ? " is-current" : "") +
        (it.disabled ? " is-disabled" : ""),
    );
    if (it.icon) row.appendChild(glyph(it.icon));
    const label = el("span", "dropdown-label");
    label.textContent = it.label ?? "";
    row.appendChild(label);
    if (it.sub) {
      const sub = el("span", "dropdown-sub");
      sub.textContent = it.sub;
      row.appendChild(sub);
    }
    if (it.current) row.appendChild(glyph("check"));
    if (!it.disabled && it.onClick) {
      row.addEventListener("click", () => {
        close();
        it.onClick!();
      });
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const mr = menu.getBoundingClientRect();
  if (mr.right > window.innerWidth - 8) {
    menu.style.left = `${Math.round(window.innerWidth - mr.width - 8)}px`;
  }
  setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
}

new App().start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Renderer failed:", err);
});
