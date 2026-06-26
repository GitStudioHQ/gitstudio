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
  HeadInfo,
  RefInfo,
  RepoInfo,
} from "../shared/ipc";

class App {
  private graph!: GraphMount;
  private diffPanel!: DiffPanel;
  private contextMenu = new CommitContextMenu((req) => this.runAction(req));

  private repoName!: HTMLElement;
  private repoBranch!: HTMLElement;
  private refsList!: HTMLElement;
  private recentList!: HTMLElement;
  private detailsEl!: HTMLElement;
  private selectedSha?: string;
  private currentRepo?: RepoInfo;

  async start(): Promise<void> {
    applyTheme(preferredTheme());
    followSystemTheme();

    this.render();
    this.wireHostEvents();

    const current = await host.invoke("repo:current", undefined);
    if (current) {
      await this.onRepoChanged(current);
    } else {
      await this.refreshRecent();
      this.graph.clear();
    }
  }

  // ── Shell DOM ──────────────────────────────────────────────────────────────

  private render(): void {
    const root = document.getElementById("root")!;
    root.replaceChildren();

    root.appendChild(this.titlebar());

    const body = el("div", "app-body");
    body.appendChild(this.sidebar());

    const main = el("div", "app-main");
    const graphHost = el("div", "graph-host");
    const detailsHost = el("div", "details-host");
    this.detailsEl = detailsHost;
    main.append(graphHost, detailsHost);
    body.appendChild(main);

    root.appendChild(body);

    this.graph = new GraphMount(graphHost, {
      onSelect: (sha) => void this.selectCommit(sha),
      onOpen: (sha) => void this.selectCommit(sha),
      onContext: (sha, x, y) => this.contextMenu.open(sha, x, y),
    });
    this.diffPanel = new DiffPanel(this.diffSurface());
    this.showDetailsPlaceholder();
  }

  private titlebar(): HTMLElement {
    const bar = el("header", "titlebar");
    const brand = el("div", "titlebar-brand");
    const dot = el("span", "brand-dot");
    const name = el("span", "brand-name");
    name.textContent = "GitStudio";
    brand.append(dot, name);

    const repoChip = el("button", "titlebar-repo");
    repoChip.textContent = "Open Repository…";
    repoChip.addEventListener("click", () => void this.openRepo());
    this.repoBranch = repoChip;

    bar.append(brand, repoChip);
    return bar;
  }

  private sidebar(): HTMLElement {
    const aside = el("aside", "sidebar");

    const header = el("div", "sidebar-header");
    const repoName = el("div", "repo-name");
    repoName.textContent = "No repository";
    this.repoName = repoName;
    const openBtn = el("button", "btn btn-primary");
    openBtn.textContent = "Open Repo";
    openBtn.addEventListener("click", () => void this.openRepo());
    header.append(repoName, openBtn);

    const refsSection = el("div", "sidebar-section");
    refsSection.appendChild(sectionTitle("Branches & Tags"));
    const refs = el("div", "refs-list");
    this.refsList = refs;
    refsSection.appendChild(refs);

    const recentSection = el("div", "sidebar-section");
    recentSection.appendChild(sectionTitle("Recent"));
    const recent = el("div", "recent-list");
    this.recentList = recent;
    recentSection.appendChild(recent);

    aside.append(header, refsSection, recentSection);
    return aside;
  }

  private diffSurfaceEl?: HTMLElement;
  private diffSurface(): HTMLElement {
    // The diff/merge surface lives inside the details host but below the
    // metadata + file list; created lazily on first file open.
    const surface = el("div", "diff-surface");
    this.diffSurfaceEl = surface;
    return surface;
  }

  // ── Host events ──────────────────────────────────────────────────────────────

  private wireHostEvents(): void {
    host.on("repo:changed", (info) => {
      if (info) {
        void this.onRepoChanged(info);
      } else {
        this.onRepoClosed();
      }
    });
    host.on("menu:command", (msg) => {
      if (msg.command === "openRepo") {
        void this.openRepo();
      } else if (msg.command === "refresh") {
        void this.refreshAll();
      } else if (msg.command === "closeRepo") {
        void host.invoke("repo:close", undefined);
      }
    });
  }

  // ── Repo lifecycle ───────────────────────────────────────────────────────────

  private async openRepo(): Promise<void> {
    const info = await host.invoke("repo:open", undefined);
    if (info) {
      await this.onRepoChanged(info);
    }
  }

  private async onRepoChanged(info: RepoInfo): Promise<void> {
    this.currentRepo = info;
    this.repoName.textContent = info.name;
    this.repoName.title = info.root;
    this.selectedSha = undefined;
    this.showDetailsPlaceholder();
    await Promise.all([this.refreshRefs(), this.refreshRecent()]);
    await this.graph.reload();
  }

  private onRepoClosed(): void {
    this.currentRepo = undefined;
    this.repoName.textContent = "No repository";
    this.repoBranch.textContent = "Open Repository…";
    this.refsList.replaceChildren();
    this.graph.clear();
    this.showDetailsPlaceholder();
  }

  private async refreshAll(): Promise<void> {
    if (!this.currentRepo) {
      return;
    }
    await Promise.all([this.refreshRefs(), this.refreshRecent()]);
    await this.graph.reload();
  }

  // ── Sidebar data ─────────────────────────────────────────────────────────────

  private async refreshRefs(): Promise<void> {
    const [refs, head] = await Promise.all([
      host.invoke("refs:list", undefined),
      host.invoke("head:get", undefined),
    ]);
    this.renderHead(head);
    this.renderRefs(refs);
  }

  private renderHead(head: HeadInfo | undefined): void {
    if (!head) {
      this.repoBranch.textContent = this.currentRepo?.name ?? "GitStudio";
      return;
    }
    this.repoBranch.textContent = head.detached
      ? `detached @ ${head.sha.slice(0, 7)}`
      : `⎇ ${head.branch}`;
  }

  private renderRefs(refs: RefInfo[]): void {
    const order: RefInfo["type"][] = ["head", "remote", "tag"];
    const groups: Record<string, RefInfo[]> = {};
    for (const ref of refs) {
      if (ref.type === "stash") {
        continue;
      }
      (groups[ref.type] ??= []).push(ref);
    }
    this.refsList.replaceChildren();
    for (const type of order) {
      const list = groups[type];
      if (!list || list.length === 0) {
        continue;
      }
      const label = el("div", "refs-group-label");
      label.textContent =
        type === "head" ? "Local" : type === "remote" ? "Remotes" : "Tags";
      this.refsList.appendChild(label);
      for (const ref of list) {
        const row = el("button", `ref-row ref-${ref.type}`);
        if (ref.isCurrent) {
          row.classList.add("ref-current");
        }
        const icon = el("span", "ref-icon");
        icon.textContent = type === "head" ? "⎇" : type === "remote" ? "☁" : "⌖";
        const name = el("span", "ref-name");
        name.textContent = ref.name;
        row.append(icon, name);
        row.title = `${ref.fullName} · ${ref.sha.slice(0, 12)}`;
        row.addEventListener("click", () => void this.selectCommit(ref.sha));
        this.refsList.appendChild(row);
      }
    }
  }

  private async refreshRecent(): Promise<void> {
    const recent = await host.invoke("repo:recent", undefined);
    this.recentList.replaceChildren();
    for (const r of recent) {
      const row = el("button", "recent-row");
      const name = el("span", "recent-name");
      name.textContent = r.name;
      const path = el("span", "recent-path");
      path.textContent = r.root;
      row.append(name, path);
      row.addEventListener("click", () => void host.invoke("repo:openPath", r.root));
      this.recentList.appendChild(row);
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

function sectionTitle(text: string): HTMLElement {
  const t = el("div", "section-title");
  t.textContent = text;
  return t;
}

function tag(kind: string, text: string): HTMLElement {
  const t = el("span", `meta-tag meta-${kind}`);
  t.textContent = text;
  return t;
}

function formatDate(epochSeconds: number): string {
  if (!epochSeconds) {
    return "";
  }
  return new Date(epochSeconds * 1000).toLocaleString();
}

new App().start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Renderer failed:", err);
});
