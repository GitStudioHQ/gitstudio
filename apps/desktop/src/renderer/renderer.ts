// GitStudio desktop renderer — the app shell.
//
// Layout: a welcome / repo-picker screen, or — once a repo is open — a top bar
// (brand mark, repo + branch switchers, refresh) above a main area that mounts
// the shared <gitstudio-graph>. A commit selection opens a details + changed-
// files panel; clicking a file opens the shared Monaco DiffView, or the 3-pane
// MergeView for a conflict. Theme is supplied via the desktopTheme shim so every
// shared component renders unchanged.

// Reuse the shared component stylesheets verbatim: the JetBrains diff/merge
// palette + gutter chrome, and the graph host-page frame. The renderer carries
// the same look as the extension because it ships the same CSS.
import "@gitstudio/webview-ui/styles/diff.css";
import "@gitstudio/webview-ui/styles/graph.css";
import "@gitstudio/webview-ui/commit-details";
import "./styles/app.css";
import { host } from "./bridge";
import { applyTheme, followSystemTheme, resolveTheme } from "./desktopTheme";
import type { ThemeMode } from "./desktopTheme";
import { GraphMount } from "./graphMount";
import { DiffPanel } from "./diffPanel";
import { CompareDiff } from "./compareDiff";
import { ReadonlyFileView } from "./readonlyFileView";
import { renderMarkdown } from "./markdown";
import { toast, confirmDialog, promptInline } from "./dialogs";
import {
  el,
  span,
  glyph,
  relTime,
  relTimeISO,
  textBtn,
  groupLabel,
  pill,
  emptyState,
  loadingState,
  errorState,
  settingsCard,
  settingsField,
  copyText,
  cleanErr,
  isBenignError,
  brandMark,
  openMenu,
} from "./ui";
import type { MenuItem } from "./ui";
import { CommitContextMenu } from "./contextMenu";
import type { SectionRender } from "./views/common";
import { renderIssues } from "./views/issues";
import { renderPrs } from "./views/prs";
import { renderActions } from "./views/actions";
import { renderReleases } from "./views/releases";
import { renderNotifications } from "./views/notifications";
import { renderOrgs } from "./views/orgs";
import { renderProjects } from "./views/projects";
import { renderGists } from "./views/gists";
import type { CommitDetails as CommitDetailsEl } from "@gitstudio/webview-ui/commit-details";
import type {
  BranchInfo,
  ChangedFile,
  CommitDetailsPayload,
  CompareMode,
  CompareResult,
  IssueInfo,
  MergeMethod,
  PrDetail,
  ProjectInfo,
  PullRequest,
  RefInfo,
  RepoInfo,
  SshKey,
  SyncStatus,
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
  private viewHost!: HTMLElement;
  private navButtons: HTMLElement[] = [];
  private currentView = "code";
  /** Current directory inside the Code (repo browser) view; "" = repo root. */
  private codePath = "";
  /** Branches view: per-category collapse memory (label → collapsed), persisted
   *  across re-renders so checkout/new/delete/filter don't reset expand state. */
  private branchCatsCollapsed: Record<string, boolean> = Object.create(null) as Record<
    string,
    boolean
  >;
  private compareBase?: string;
  private compareHead?: string;
  private compareMode: CompareMode = "three-dot";
  /** Compare sub-view: the commits list, or the files master/detail. */
  private compareView: "commits" | "files" = "files";
  /** Persisted width (px) of the compare file list when the diff is showing. */
  private compareFileListW = 300;
  private compareFilesCollapsed = false;
  /** The Monaco-backed surface mounted in the current view, disposed on route
   *  change so editors + models + their document.body theme observers don't leak. */
  private activeMonacoView?: { dispose(): void };
  private syncStatus?: SyncStatus;
  private renderSyncWidget?: (s: SyncStatus | undefined) => void;
  private prSubTab = "conversation";
  /** Bumped whenever the visible surface changes; async work captures it and
   *  bails if superseded, so a slow IPC reply can't clobber a newer view. */
  private routeGen = 0;
  /** True while a fetch/pull/push is in flight — locks the sync trigger. */
  private syncing = false;
  /** Theme preference: follow the OS, or pin light/dark. */
  private themeMode: ThemeMode = "system";

  async start(): Promise<void> {
    // Catch-all error boundary: a rejected promise or thrown render should never
    // leave the app silently broken — surface it as a toast. BUT skip the benign
    // Monaco worker noise (it asks the base worker for TS language-service methods
    // we don't bundle, and ResizeObserver loop warnings) — those are harmless.
    window.addEventListener("unhandledrejection", (e) => {
      const msg = cleanErr(e.reason);
      if (isBenignError(msg)) return;
      toast(msg || "Something went wrong.", "error");
    });
    window.addEventListener("error", (e) => {
      const msg = e.error ? cleanErr(e.error) : e.message || "";
      if (isBenignError(msg, e.filename)) return;
      if (e.error || e.message) toast(msg || "Something went wrong.", "error");
    });

    // Power-user view switching: Cmd/Ctrl+1..8 jumps between sidebar views; Cmd/Ctrl+, opens Settings.
    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (!this.currentRepo || !this.navButtons.length) return;
      if (/^[1-8]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < App.TABS.length) {
          e.preventDefault();
          this.routeView(App.TABS[idx].id);
          this.navButtons[idx]?.focus();
        }
      } else if (e.key === ",") {
        e.preventDefault();
        this.routeView("settings");
      }
    });

    // Restore persisted UI preferences so the app reopens where you left it.
    const prefs = loadPrefs();
    if (typeof prefs.currentView === "string" && App.TABS.some((t) => t.id === prefs.currentView)) {
      this.currentView = prefs.currentView;
    }
    if (typeof prefs.compareFileListW === "number" && prefs.compareFileListW >= 180) {
      this.compareFileListW = prefs.compareFileListW;
    }
    if (prefs.compareView === "commits" || prefs.compareView === "files") {
      this.compareView = prefs.compareView;
    }
    if (prefs.branchCatsCollapsed && typeof prefs.branchCatsCollapsed === "object") {
      this.branchCatsCollapsed = prefs.branchCatsCollapsed as Record<string, boolean>;
    }
    if (prefs.themeMode === "system" || prefs.themeMode === "light" || prefs.themeMode === "dark") {
      this.themeMode = prefs.themeMode;
    }

    applyTheme(resolveTheme(this.themeMode));
    // Re-apply on OS theme flips ONLY when following the system.
    followSystemTheme((osTheme) => {
      if (this.themeMode === "system") {
        applyTheme(osTheme);
        this.rerenderForTheme();
      }
    });
    this.wireHostEvents();

    try {
      const current = await host.invoke("repo:current", undefined);
      if (current) {
        this.showRepoScreen(current);
      } else {
        await this.showWelcome();
      }
    } catch (e) {
      toast(cleanErr(e) || "Couldn't open the repository.", "error");
      await this.showWelcome();
    }
  }

  /**
   * Re-render after a live OS light↔dark flip. Only the welcome screen carries
   * theme-keyed <img> sources (the hero mark + the wordmark); the repo screen is
   * entirely CSS-var / inline-SVG driven and re-themes itself from the body class.
   */
  private rerenderForTheme(): void {
    if (!this.currentRepo) {
      void this.showWelcome();
    }
  }

  // ── Welcome / repo-picker screen ────────────────────────────────────────────

  private async showWelcome(): Promise<void> {
    this.currentRepo = undefined;
    const screen = el("div", "screen welcome");
    const card = el("div", "welcome-card");

    const dark = document.body.classList.contains("vscode-dark");

    const logo = document.createElement("img");
    logo.className = "welcome-logo";
    // The squircle app-icon mark, theme-swapped so its tile matches the page
    // (a light-tile sibling on light theme — never a dark square on a light page).
    logo.src = dark ? "./brand-icon.svg" : "./brand-icon-light.svg";
    logo.alt = "GitStudio";

    const wordmark = document.createElement("img");
    wordmark.className = "welcome-wordmark";
    // dark theme → the light-text lockup; light theme → the ink-text lockup.
    wordmark.src = dark ? "./brand-wordmark-dark.svg" : "./brand-wordmark-light.svg";
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
        row.append(glyph("folder"), meta);
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
    this.codePath = "";
    this.routeGen++; // a repo switch supersedes the previous repo's in-flight work
    // Each repo starts Compare from its own current/main defaults — don't carry
    // the previous repo's (possibly non-existent) refs over.
    this.compareBase = undefined;
    this.compareHead = undefined;
    const screen = el("div", "screen repo");
    screen.appendChild(this.topbar(info));
    // A left sidebar rail routes the main area between the repo's surfaces.
    const main = el("div", "repo-main");
    const viewHost = el("div", "view-host");
    this.viewHost = viewHost;
    main.append(this.buildNav(), viewHost);
    screen.appendChild(main);

    document.getElementById("root")!.replaceChildren(screen);
    this.routeView(this.currentView);
    void this.refreshRefs();
    void this.updateSync();
  }

  // ── Sidebar rail + view router ──────────────────────────────────────────────

  private static readonly TABS: ReadonlyArray<{
    id: string;
    label: string;
    icon: string;
    /** A group divider is drawn before this item. */
    divider?: boolean;
  }> = [
    { id: "code", label: "Code", icon: "code" },
    { id: "changes", label: "Changes", icon: "request-changes" },
    { id: "graph", label: "Commits", icon: "git-commit" },
    { id: "branches", label: "Branches", icon: "git-branch" },
    { id: "compare", label: "Compare", icon: "git-compare" },
    { id: "prs", label: "Pull Requests", icon: "git-pull-request", divider: true },
    { id: "issues", label: "Issues", icon: "issue-opened" },
    { id: "actions", label: "Actions", icon: "play" },
    { id: "releases", label: "Releases", icon: "tag" },
    { id: "projects", label: "Projects", icon: "project" },
    { id: "notifications", label: "Notifications", icon: "bell" },
    { id: "orgs", label: "Organizations", icon: "organization" },
    { id: "gists", label: "Gists", icon: "code" },
  ];

  private buildNav(): HTMLElement {
    const nav = el("nav", "nav-rail");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-orientation", "vertical");
    nav.setAttribute("aria-label", "Repository views");
    this.navButtons = [];
    const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

    const mkItem = (id: string, label: string, icon: string, shortcut?: string): HTMLElement => {
      const btn = el("button", "nav-item");
      btn.dataset.view = id;
      btn.title = shortcut ? `${label}  (${shortcut})` : label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", label);
      btn.append(glyph(icon), span(label, "nav-label"));
      btn.addEventListener("click", () => this.routeView(id));
      btn.addEventListener("keydown", (e) => {
        const i = this.navButtons.indexOf(btn);
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          this.navButtons[(i + 1) % this.navButtons.length].focus();
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          this.navButtons[(i - 1 + this.navButtons.length) % this.navButtons.length].focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          this.navButtons[0].focus();
        } else if (e.key === "End") {
          e.preventDefault();
          this.navButtons[this.navButtons.length - 1].focus();
        }
      });
      this.navButtons.push(btn);
      return btn;
    };

    App.TABS.forEach((it, i) => {
      if (it.divider) {
        const sep = el("div", "nav-divider");
        sep.setAttribute("aria-hidden", "true");
        sep.append(span("GitHub", "nav-divider-label"));
        nav.appendChild(sep);
      }
      nav.appendChild(mkItem(it.id, it.label, it.icon, i < 8 ? `${mod}${i + 1}` : undefined));
    });
    // Settings is pinned to the bottom of the rail (app-level, not a repo view).
    nav.appendChild(el("div", "nav-spacer"));
    nav.appendChild(mkItem("settings", "Settings", "gear", `${mod},`));
    return nav;
  }

  /** Persist the UI preferences worth restoring on next launch. */
  private persist(): void {
    savePrefs({
      currentView: this.currentView,
      compareFileListW: this.compareFileListW,
      compareView: this.compareView,
      branchCatsCollapsed: this.branchCatsCollapsed,
      themeMode: this.themeMode,
    });
  }

  /** Change the theme mode: apply live + persist. */
  private setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    applyTheme(resolveTheme(mode));
    this.rerenderForTheme();
    this.persist();
  }

  /** Swap the main area to the chosen view's surface. */
  private routeView(id: string): void {
    this.currentView = id;
    this.persist();
    this.routeGen++; // supersede any in-flight async work from the prior view
    // Free the previous view's Monaco surface before swapping the DOM under it.
    this.activeMonacoView?.dispose();
    this.activeMonacoView = undefined;
    for (const btn of this.navButtons) {
      const active = btn.dataset.view === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      // Roving tabindex: only the active tab is in the Tab order.
      btn.tabIndex = active ? 0 : -1;
    }
    if (id === "code") {
      void this.showCodeView();
    } else if (id === "graph") {
      this.showGraphView();
    } else if (id === "branches") {
      void this.showBranchesView();
    } else if (id === "changes") {
      void this.showChangesView();
    } else if (id === "compare") {
      void this.showCompareView();
    } else if (id === "prs") {
      this.mountSection(renderPrs);
    } else if (id === "issues") {
      this.mountSection(renderIssues);
    } else if (id === "actions") {
      this.mountSection(renderActions);
    } else if (id === "releases") {
      this.mountSection(renderReleases);
    } else if (id === "notifications") {
      this.mountSection(renderNotifications);
    } else if (id === "orgs") {
      this.mountSection(renderOrgs);
    } else if (id === "projects") {
      this.mountSection(renderProjects);
    } else if (id === "gists") {
      this.mountSection(renderGists);
    } else if (id === "settings") {
      void this.showSettingsView();
    } else {
      this.showPlaceholderView(id);
    }
  }

  /** Mount a per-section view module into a fresh container inside the view host.
   *  The module owns its container, so a stale async render writes into detached
   *  DOM (harmless) once the user navigates on. */
  private mountSection(render: SectionRender): void {
    const wrap = el("div", "view-host-inner");
    this.viewHost.replaceChildren(wrap);
    render(wrap, (v) => this.routeView(v));
  }

  /** A real branch manager: local branches with upstream + ahead/behind + last
   *  commit, plus remotes and tags — checkout, new, delete. */
  private async showBranchesView(): Promise<void> {
    const wrap = el("div", "list-view");
    const headRow = el("div", "list-head list-head-row");
    const filterInput = document.createElement("input");
    filterInput.className = "list-filter";
    filterInput.type = "text";
    filterInput.placeholder = "Filter branches & tags…";
    filterInput.setAttribute("aria-label", "Filter branches and tags");
    const newBtn = el("button", "mini-btn");
    newBtn.append(glyph("add"), span("New branch"));
    newBtn.addEventListener("click", () => void this.newBranch());
    headRow.append(filterInput, newBtn);
    const body = el("div", "list-body");
    wrap.append(headRow, body);
    this.viewHost.replaceChildren(wrap);

    await this.refreshRefs();
    const locals = await host.invoke("branches:list", undefined);
    const remotes = this.refs.filter((r) => r.type === "remote" && !r.name.endsWith("/HEAD"));
    const tags = this.refs.filter((r) => r.type === "tag");

    // A collapsible category: a clickable header (chevron + label + count) over a
    // body div holding its rows. Collapse state lives on the App instance so it
    // survives re-renders; while filtering we force-expand so matches stay visible.
    const group = (label: string, count: number, build: (host: HTMLElement) => void): void => {
      if (!count) return;
      const filtering = !!filterInput.value.trim();
      const collapsed = !filtering && !!this.branchCatsCollapsed[label];
      const head = el("button", "list-group-head" + (collapsed ? " collapsed" : ""));
      head.append(
        glyph("chevron-down"),
        span(label, "list-group-label"),
        span(String(count), "list-group-count"),
      );
      const groupBody = el("div", "list-group-body");
      if (collapsed) groupBody.style.display = "none";
      build(groupBody);
      // Toggle from the DISPLAYED state (seeded per-render), so the first click
      // always matches what the user sees — even when filtering force-expanded it.
      let cur = collapsed;
      head.addEventListener("click", () => {
        cur = !cur;
        this.branchCatsCollapsed[label] = cur;
        head.classList.toggle("collapsed", cur);
        groupBody.style.display = cur ? "none" : "";
        this.persist();
      });
      body.append(head, groupBody);
    };

    const render = (): void => {
      const q = filterInput.value.trim().toLowerCase();
      const match = (n: string): boolean => !q || n.toLowerCase().includes(q);
      body.replaceChildren();

      const localRows = locals.filter((b) => match(b.name));
      group("Local", localRows.length, (host) => {
        for (const b of localRows) host.appendChild(this.localBranchRow(b));
      });

      const refSection = (label: string, refs: RefInfo[], icon: string, pick: (r: RefInfo) => void): void => {
        const rows = refs.filter((r) => match(r.name));
        group(label, rows.length, (host) => {
          for (const r of rows) {
            const row = el("button", "list-row");
            row.append(glyph(icon));
            const nm = el("span", "list-row-name");
            nm.textContent = r.name;
            row.appendChild(nm);
            row.addEventListener("click", () => pick(r));
            host.appendChild(row);
          }
        });
      };
      refSection("Remote", remotes, "cloud", (r) =>
        void this.checkoutRef(r.name.split("/").slice(1).join("/") || r.name),
      );
      refSection("Tags", tags, "tag", (r) => void this.checkoutRef(r.name));

      if (!body.children.length) {
        body.appendChild(emptyState(q ? "No matches" : "No branches yet", q ? "Try a different filter." : ""));
      }
    };
    filterInput.addEventListener("input", render);
    render();
  }

  private localBranchRow(b: BranchInfo): HTMLElement {
    const row = el("div", "list-row branch-row" + (b.current ? " is-current" : ""));
    row.appendChild(glyph(b.current ? "check" : "git-branch"));
    const meta = el("div", "row-meta");
    const top = el("div", "row-meta-title branch-title");
    const nm = el("span", "branch-name-txt");
    nm.textContent = b.name;
    top.appendChild(nm);
    if (b.ahead) {
      const p = el("span", "ab-pill ahead");
      p.textContent = `↑${b.ahead}`;
      top.appendChild(p);
    }
    if (b.behind) {
      const p = el("span", "ab-pill behind");
      p.textContent = `↓${b.behind}`;
      top.appendChild(p);
    }
    meta.appendChild(top);
    const bits: string[] = [];
    if (b.upstream) bits.push(b.upstream);
    if (b.date) bits.push(relTime(b.date));
    if (b.subject) bits.push(b.subject);
    const sub = el("div", "row-meta-sub");
    sub.textContent = bits.join("  ·  ");
    meta.appendChild(sub);
    row.appendChild(meta);
    const actions = el("div", "row-actions");
    if (!b.current) {
      actions.append(
        textBtn("Checkout", "Check out this branch", () => void this.checkoutRef(b.name)),
        textBtn("Delete", "Delete this branch", () => void this.deleteBranch(b.name), true),
      );
      row.addEventListener("click", () => void this.checkoutRef(b.name));
    }
    row.appendChild(actions);
    return row;
  }

  private async newBranch(): Promise<void> {
    const name = await promptInline("New branch", "feature/my-change");
    if (!name) return;
    const r = await host.invoke("branch:create", { name, checkout: true });
    if (!r.ok && r.message) toast(r.message, "error");
    await this.refreshRefs();
    await this.updateSync();
    if (this.currentView === "branches") void this.showBranchesView();
  }

  private async deleteBranch(name: string): Promise<void> {
    let r = await host.invoke("branch:delete", { name });
    if (!r.ok && r.message && /not fully merged/i.test(r.message)) {
      const force = await confirmDialog({
        title: "Force-delete branch?",
        message: `'${name}' isn't fully merged. Force-deleting may discard unmerged commits.`,
        confirmLabel: "Force delete",
        danger: true,
      });
      if (!force) return;
      r = await host.invoke("branch:delete", { name, force: true });
    }
    if (!r.ok && r.message) toast(r.message, "error");
    if (this.currentView === "branches") void this.showBranchesView();
  }

  /** Check out a branch/tag by name, then refresh refs + the view. */
  private async checkoutRef(ref: string): Promise<void> {
    const result = await host.invoke("commit:action", {
      action: "checkout",
      sha: ref,
    } as Parameters<App["runAction"]>[0]);
    if (!result.ok && result.message) {
      toast(result.message, "error");
    }
    await this.refreshRefs();
    if (this.currentView === "branches") {
      void this.showBranchesView();
    }
  }

  // ── Compare view (base…head, GitHub-style: commits | files master/detail) ────

  private async showCompareView(): Promise<void> {
    await this.refreshRefs();
    const current = this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
    this.compareHead = this.compareHead ?? current ?? "HEAD";
    this.compareBase =
      this.compareBase ??
      this.refs.find((r) => r.type === "head" && r.name === "main")?.name ??
      this.refs.find((r) => r.type === "head" && !r.isCurrent)?.name ??
      current ??
      "HEAD";

    const wrap = el("div", "compare-view");

    // ── Toolbar: base ⇄ compare pickers + the dot-mode toggle. ────────────────
    const bar = el("div", "compare-bar");
    const baseBtn = el("button", "ref-pick");
    const headBtn = el("button", "ref-pick");
    const setLabel = (btn: HTMLElement, ref: string): void => {
      btn.replaceChildren(glyph("git-branch"), span(ref), glyph("chevron-down"));
    };
    setLabel(baseBtn, this.compareBase);
    setLabel(headBtn, this.compareHead);
    baseBtn.addEventListener("click", () =>
      this.pickRef(baseBtn, (r) => {
        this.compareBase = r;
        setLabel(baseBtn, r);
        void runCompare();
      }),
    );
    headBtn.addEventListener("click", () =>
      this.pickRef(headBtn, (r) => {
        this.compareHead = r;
        setLabel(headBtn, r);
        void runCompare();
      }),
    );
    const baseLbl = el("span", "compare-lbl");
    baseLbl.textContent = "base";
    const headLbl = el("span", "compare-lbl");
    headLbl.textContent = "compare";
    const swap = el("button", "topbar-icon");
    swap.title = "Swap base and compare";
    swap.appendChild(glyph("git-compare"));
    swap.addEventListener("click", () => {
      [this.compareBase, this.compareHead] = [this.compareHead, this.compareBase];
      setLabel(baseBtn, this.compareBase!);
      setLabel(headBtn, this.compareHead!);
      void runCompare();
    });
    const modeWrap = el("div", "cmp-mode");
    const dot3 = el("button", "cmp-mode-btn");
    dot3.textContent = "What this branch adds";
    dot3.title = "Three-dot (base...compare): changes introduced since the common ancestor — GitHub's default";
    const dot2 = el("button", "cmp-mode-btn");
    dot2.textContent = "Everything different";
    dot2.title = "Two-dot (base..compare): every difference between the two branch tips";
    const syncMode = (): void => {
      dot3.classList.toggle("active", this.compareMode === "three-dot");
      dot2.classList.toggle("active", this.compareMode === "two-dot");
    };
    dot3.addEventListener("click", () => {
      this.compareMode = "three-dot";
      syncMode();
      void runCompare();
    });
    dot2.addEventListener("click", () => {
      this.compareMode = "two-dot";
      syncMode();
      void runCompare();
    });
    modeWrap.append(dot2, dot3);
    bar.append(baseLbl, baseBtn, swap, headLbl, headBtn, modeWrap);
    syncMode();

    // ── View toggle: Commits | Changed files, with live counts + a summary. ───
    const viewBar = el("div", "cmp-viewbar");
    const seg = el("div", "cmp-seg");
    const commitsTab = el("button", "cmp-seg-btn");
    commitsTab.append(glyph("git-commit"), span("Commits"));
    const commitsCount = el("span", "cmp-seg-count");
    commitsTab.appendChild(commitsCount);
    const filesTab = el("button", "cmp-seg-btn");
    filesTab.append(glyph("file"), span("Changed files"));
    const filesCount = el("span", "cmp-seg-count");
    filesTab.appendChild(filesCount);
    seg.append(commitsTab, filesTab);
    const summary = el("div", "cmp-summary");
    viewBar.append(seg, summary);

    const body = el("div", "cmp-body");
    wrap.append(bar, viewBar, body);
    this.viewHost.replaceChildren(wrap);

    let last: CompareResult | undefined;
    const renderBody = (): void => {
      commitsTab.classList.toggle("active", this.compareView === "commits");
      filesTab.classList.toggle("active", this.compareView === "files");
      if (this.compareView === "commits") {
        this.renderCompareCommits(body, last);
      } else {
        this.renderCompareFiles(body, last);
      }
    };
    commitsTab.addEventListener("click", () => {
      this.compareView = "commits";
      this.persist();
      renderBody();
    });
    filesTab.addEventListener("click", () => {
      this.compareView = "files";
      this.persist();
      renderBody();
    });

    const runCompare = async (): Promise<void> => {
      body.replaceChildren(loadingState(`Comparing ${this.compareBase} … ${this.compareHead}`));
      const res = await host.invoke("compare:refs", {
        base: this.compareBase!,
        head: this.compareHead!,
        mode: this.compareMode,
      });
      last = res ?? undefined;
      if (!res) {
        summary.textContent = "";
        commitsCount.textContent = "";
        filesCount.textContent = "";
        body.replaceChildren(
          errorState(
            "Couldn't compare these refs",
            `Make sure ${this.compareBase} and ${this.compareHead} both exist.`,
            () => void runCompare(),
          ),
        );
        return;
      }
      const n = res.commits.length;
      const m = res.files.length;
      commitsCount.textContent = String(n);
      filesCount.textContent = String(m);
      summary.textContent =
        n === 0 && m === 0
          ? `${this.compareHead} is up to date with ${this.compareBase}.`
          : `${n} commit${n === 1 ? "" : "s"} · ${m} file${m === 1 ? "" : "s"} changed` +
            (res.behind > 0 ? ` · ${this.compareBase} is ${res.behind} ahead` : "");
      renderBody();
    };
    void runCompare();
  }

  /** Commits-only view: the commits `compare` adds over `base`. */
  private renderCompareCommits(body: HTMLElement, res: CompareResult | undefined): void {
    body.replaceChildren();
    if (!res || !res.commits.length) {
      body.appendChild(
        emptyState("No commits", "These refs share the same history in this direction."),
      );
      return;
    }
    const list = el("div", "cmp-commits");
    for (const c of res.commits) {
      const row = el("div", "compare-commit");
      const subj = el("div", "cc-subject");
      subj.textContent = c.subject;
      const meta = el("div", "cc-meta");
      meta.textContent = `${c.author} · ${c.shortSha} · ${relTime(c.date)}`;
      row.append(subj, meta);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  /** Changed-files view: a GitHub-style master/detail — file list (left,
   *  resizable + collapsible) and a native Monaco diff (right, inline/split). */
  private renderCompareFiles(body: HTMLElement, res: CompareResult | undefined): void {
    body.replaceChildren();
    if (!res || !res.files.length) {
      body.appendChild(
        emptyState("No file changes", "Nothing differs between these refs in this direction."),
      );
      return;
    }

    const split = el("div", "cmp-split" + (this.compareFilesCollapsed ? " files-collapsed" : ""));
    const left = el("div", "cmp-filelist");
    left.style.flex = `0 0 ${this.compareFileListW}px`;
    const lhead = el("div", "cmp-filelist-head");
    const ltitle = el("span", "cmp-filelist-title");
    ltitle.textContent = `${res.files.length} file${res.files.length === 1 ? "" : "s"}`;
    const collapseBtn = el("button", "cmp-collapse");
    collapseBtn.title = "Hide file list";
    collapseBtn.appendChild(glyph("chevron-left"));
    lhead.append(ltitle, collapseBtn);
    const fileScroll = el("div", "cmp-file-scroll");
    left.append(lhead, fileScroll);

    const divider = el("div", "cmp-vsplit");
    divider.appendChild(el("div", "cmp-vsplit-grip"));

    const right = el("div", "cmp-diffpane");
    const restore = el("button", "cmp-restore");
    restore.title = "Show file list";
    restore.appendChild(glyph("chevron-right"));

    split.append(left, divider, right, restore);
    body.appendChild(split);

    const diff = new CompareDiff(right);
    this.activeMonacoView = diff;
    diff.showEmpty("Select a changed file to view its diff.");

    let activeRow: HTMLElement | undefined;
    const open = (path: string, row: HTMLElement): void => {
      if (activeRow) activeRow.classList.remove("active");
      activeRow = row;
      row.classList.add("active");
      void this.openCompareFile(diff, path);
    };

    res.files.forEach((f, i) => {
      const row = el("button", `file-row status-${f.status}`);
      const st = el("span", "file-status");
      st.textContent = f.status;
      const path = el("span", "file-path");
      path.textContent = f.path;
      row.append(st, path);
      row.addEventListener("click", () => open(f.path, row));
      fileScroll.appendChild(row);
      if (i === 0) open(f.path, row); // auto-open the first file
    });

    const setCollapsed = (c: boolean): void => {
      this.compareFilesCollapsed = c;
      split.classList.toggle("files-collapsed", c);
      requestAnimationFrame(() => diff.layout());
    };
    collapseBtn.addEventListener("click", () => setCollapsed(true));
    restore.addEventListener("click", () => setCollapsed(false));
    this.wireCompareResizer(divider, left, diff);
  }

  /** Drag the vertical divider to resize the file list; relayout the diff live. */
  private wireCompareResizer(divider: HTMLElement, left: HTMLElement, diff: CompareDiff): void {
    divider.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = left.getBoundingClientRect().width;
      const onMove = (ev: MouseEvent): void => {
        const w = Math.max(180, Math.min(580, startW + (ev.clientX - startX)));
        this.compareFileListW = w;
        left.style.flex = `0 0 ${w}px`;
        diff.layout();
      };
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("resizing-h");
        this.persist(); // remember the chosen file-list width
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.classList.add("resizing-h");
    });
  }

  private async openCompareFile(diff: CompareDiff, path: string): Promise<void> {
    const fileDiff = await host.invoke("compare:fileDiff", {
      base: this.compareBase!,
      head: this.compareHead!,
      path,
      mode: this.compareMode,
    });
    if (fileDiff) {
      diff.show(fileDiff);
    } else {
      diff.showEmpty("No diff available.");
    }
  }

  /** Open a branch/tag picker anchored to `anchor`; calls back with the ref name. */
  private pickRef(anchor: HTMLElement, onPick: (ref: string) => void): void {
    const items: MenuItem[] = [];
    const add = (label: string, refs: RefInfo[], icon: string): void => {
      if (!refs.length) return;
      items.push({ separator: true, label });
      for (const r of refs) {
        items.push({ label: r.name, icon, onClick: () => onPick(r.name) });
      }
    };
    add("Branches", this.refs.filter((r) => r.type === "head"), "git-branch");
    add("Remotes", this.refs.filter((r) => r.type === "remote" && !r.name.endsWith("/HEAD")), "cloud");
    add("Tags", this.refs.filter((r) => r.type === "tag"), "tag");
    if (items.length === 0) items.push({ label: "No refs", disabled: true });
    openMenu(anchor, items);
  }

  // ── Settings view (appearance · account · git identity · SSH keys) ──────────

  private async showSettingsView(): Promise<void> {
    const wrap = el("div", "settings-view");
    const head = el("div", "settings-head");
    const h = el("div", "settings-title");
    h.textContent = "Settings";
    head.appendChild(h);
    const scroll = el("div", "settings-scroll");
    scroll.append(
      this.settingsAppearanceCard(),
      this.settingsAccountCard(),
      this.settingsIdentityCard(),
      this.settingsSshCard(),
      this.settingsAboutCard(),
    );
    wrap.append(head, scroll);
    this.viewHost.replaceChildren(wrap);
  }

  private settingsAppearanceCard(): HTMLElement {
    const { card, body } = settingsCard("Appearance", "gear");
    const sub = el("div", "settings-sub");
    sub.textContent = "Choose how GitStudio looks. “System” follows your OS.";
    const seg = el("div", "settings-seg");
    const modes: Array<{ id: ThemeMode; label: string; icon: string }> = [
      { id: "system", label: "System", icon: "device-desktop" },
      { id: "light", label: "Light", icon: "color-mode" },
      { id: "dark", label: "Dark", icon: "color-mode" },
    ];
    const btns: HTMLElement[] = [];
    for (const m of modes) {
      const b = el("button", "settings-seg-btn" + (this.themeMode === m.id ? " active" : ""));
      b.append(span(m.label));
      b.addEventListener("click", () => {
        this.setThemeMode(m.id);
        btns.forEach((x) => x.classList.toggle("active", x === b));
      });
      btns.push(b);
      seg.appendChild(b);
    }
    body.append(sub, seg);
    return card;
  }

  private settingsAccountCard(): HTMLElement {
    const { card, body } = settingsCard("GitHub Account", "github");
    body.appendChild(loadingState());
    void (async () => {
      let status: { connected: boolean; login?: string } = { connected: false };
      try {
        status = await host.invoke("github:status", undefined);
      } catch {
        // keep the disconnected default
      }
      body.replaceChildren();
      if (status.connected) {
        const who = el("div", "settings-account-who");
        who.append(glyph("github"));
        const name = el("span", "settings-account-name");
        name.textContent = `@${status.login ?? "you"}`;
        who.appendChild(name);
        const sub = el("div", "settings-sub");
        sub.textContent = "Signed in via OAuth Device Flow · access: repos, actions, org, gists, notifications.";
        const actions = el("div", "settings-actions");
        const switchBtn = el("button", "mini-btn");
        switchBtn.append(glyph("sign-in"), span("Switch account"));
        switchBtn.addEventListener("click", async () => {
          await host.invoke("github:disconnect", undefined);
          void this.showSettingsView();
        });
        const signOut = el("button", "mini-btn danger");
        signOut.append(span("Sign out"));
        signOut.addEventListener("click", async () => {
          await host.invoke("github:disconnect", undefined);
          toast("Signed out of GitHub.", "info");
          void this.showSettingsView();
        });
        actions.append(switchBtn, signOut);
        body.append(who, sub, actions);
      } else {
        const sub = el("div", "settings-sub");
        sub.textContent = "Not connected. Sign in to review pull requests and issues and control GitHub Actions.";
        const signIn = el("button", "btn btn-primary");
        signIn.append(glyph("github"), span("Sign in with GitHub"));
        const flow = el("div", "gh-flow");
        signIn.addEventListener("click", () =>
          void this.startDeviceFlow(card, flow, signIn, () => void this.showSettingsView()),
        );
        body.append(sub, signIn, flow);
      }
    })();
    return card;
  }

  private settingsIdentityCard(): HTMLElement {
    const { card, body } = settingsCard("Git Identity", "git-commit");
    body.appendChild(loadingState());
    void (async () => {
      let id;
      try {
        id = await host.invoke("git:identity", undefined);
      } catch {
        id = { name: "", email: "" };
      }
      body.replaceChildren();
      const sub = el("div", "settings-sub");
      sub.textContent = "The author name and email stamped on your commits (git config --global).";
      const nameF = settingsField("Name", id.name, "Your Name");
      const emailF = settingsField("Email", id.email, "you@example.com");
      const save = el("button", "mini-btn settings-save");
      save.append(glyph("check"), span("Save identity"));
      save.addEventListener("click", async () => {
        (save as HTMLButtonElement).disabled = true;
        try {
          const r = await host.invoke("git:setIdentity", {
            name: nameF.input.value.trim(),
            email: emailF.input.value.trim(),
          });
          if (r.ok) toast("Git identity updated.", "success");
          else toast(r.message ?? "Couldn't update identity.", "error");
        } catch (e) {
          toast(cleanErr(e) || "Couldn't update identity.", "error");
        } finally {
          (save as HTMLButtonElement).disabled = false;
        }
      });
      body.append(sub, nameF.row, emailF.row, save);
    })();
    return card;
  }

  private settingsSshCard(): HTMLElement {
    const { card, body } = settingsCard("SSH Keys", "key");
    body.appendChild(loadingState());
    void (async () => {
      let keys: SshKey[] = [];
      try {
        keys = await host.invoke("ssh:keys", undefined);
      } catch {
        keys = [];
      }
      body.replaceChildren();
      const sub = el("div", "settings-sub");
      sub.textContent = "Public keys found in ~/.ssh on this machine.";
      body.appendChild(sub);
      if (!keys.length) {
        const none = el("div", "settings-empty");
        none.textContent = "No SSH keys found in ~/.ssh.";
        body.appendChild(none);
      } else {
        const list = el("div", "settings-keys");
        for (const k of keys) {
          const row = el("div", "settings-key");
          row.appendChild(glyph("key"));
          const meta = el("div", "settings-key-meta");
          const top = el("div", "settings-key-file");
          top.textContent = k.file;
          const bottom = el("div", "settings-key-sub");
          bottom.textContent = [k.type, k.comment].filter(Boolean).join(" · ");
          meta.append(top, bottom);
          row.appendChild(meta);
          const copyBtn = el("button", "icon-btn");
          copyBtn.title = "Copy public key path";
          copyBtn.appendChild(glyph("copy"));
          copyBtn.addEventListener("click", () => void copyText(`~/.ssh/${k.file}`, "Path copied."));
          row.appendChild(copyBtn);
          list.appendChild(row);
        }
        body.appendChild(list);
      }
      const manage = el("button", "gh-link");
      manage.append(glyph("link-external"), span("Manage SSH keys on GitHub"));
      manage.addEventListener("click", () => window.open("https://github.com/settings/keys", "_blank"));
      body.appendChild(manage);
    })();
    return card;
  }

  private settingsAboutCard(): HTMLElement {
    const { card, body } = settingsCard("About", "info");
    const sub = el("div", "settings-sub");
    sub.textContent = "GitStudio — an open-source, JetBrains-grade Git client.";
    const repo = el("button", "gh-link");
    repo.append(glyph("github"), span("View the project on GitHub"));
    repo.addEventListener("click", () =>
      window.open("https://github.com/", "_blank"),
    );
    body.append(sub, repo);
    return card;
  }

  // ── Code view (GitHub-style repo browser: breadcrumb + listing + README) ─────

  private async showCodeView(): Promise<void> {
    // Returning to the browser (Back / folder nav) bypasses routeView, so drop
    // any open-file Monaco viewer here too.
    this.activeMonacoView?.dispose();
    this.activeMonacoView = undefined;
    const wrap = el("div", "code-view");

    // Breadcrumb: clickable path segments that reset this.codePath.
    const crumbs = el("div", "code-crumbs");
    const seg = (label: string, path: string, isLast: boolean): void => {
      const btn = el("button", "code-crumb" + (isLast ? " is-current" : ""));
      btn.append(glyph(path === "" ? "repo" : "folder"), span(label));
      if (!isLast) {
        btn.addEventListener("click", () => {
          this.codePath = path;
          void this.showCodeView();
        });
      }
      crumbs.appendChild(btn);
      if (!isLast) crumbs.appendChild(span("/", "code-crumb-sep"));
    };
    const repoName = this.currentRepo?.name ?? "repo";
    const parts = this.codePath ? this.codePath.split("/") : [];
    seg(repoName, "", parts.length === 0);
    parts.forEach((p, i) => {
      seg(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    });

    const refreshBtn = el("button", "topbar-icon");
    refreshBtn.title = "Refresh";
    refreshBtn.appendChild(glyph("refresh"));
    refreshBtn.addEventListener("click", () => void this.showCodeView());
    const head = el("div", "code-head");
    head.append(crumbs, el("div", "topbar-spacer"), refreshBtn);

    const listing = el("div", "code-listing");
    const readme = el("div", "code-readme");
    const scroll = el("div", "code-scroll");
    scroll.append(listing, readme);
    listing.appendChild(loadingState());
    wrap.append(head, scroll);
    this.viewHost.replaceChildren(wrap);

    const gen = this.routeGen;
    let entries;
    try {
      entries = await host.invoke("repo:tree", { path: this.codePath });
    } catch (e) {
      if (gen !== this.routeGen) return;
      listing.replaceChildren(
        errorState("Couldn't read this folder", cleanErr(e) || "git ls-tree failed.", () =>
          void this.showCodeView(),
        ),
      );
      return;
    }
    if (gen !== this.routeGen) return;
    listing.replaceChildren();

    // ".." up-row when not at the repo root.
    if (this.codePath) {
      const up = el("button", "file-row code-row");
      up.append(glyph("folder-opened"), span("..", "file-path"));
      up.addEventListener("click", () => {
        this.codePath = this.codePath.split("/").slice(0, -1).join("/");
        void this.showCodeView();
      });
      listing.appendChild(up);
    }

    if (!entries.length && !this.codePath) {
      listing.appendChild(emptyState("Empty repository", "No tracked files at HEAD yet."));
    }

    for (const e of entries) {
      const row = el("button", "file-row code-row");
      row.append(
        glyph(e.type === "tree" ? "folder" : "file"),
        span(e.name, "file-path"),
      );
      row.addEventListener("click", () => {
        if (e.type === "tree") {
          this.codePath = e.path;
          void this.showCodeView();
        } else {
          void this.openCodeFile(e.path);
        }
      });
      listing.appendChild(row);
    }

    // README: case-insensitive readme / readme.md among THIS dir's blobs.
    const readmeEntry = entries.find(
      (e) => e.type === "blob" && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name),
    );
    if (readmeEntry) {
      const card = el("div", "code-readme-card");
      const rhead = el("div", "code-readme-head");
      rhead.append(glyph("book"), span(readmeEntry.name));
      const bodyEl = el("div", "code-md");
      card.append(rhead, bodyEl);
      readme.appendChild(card);
      const file = await host.invoke("repo:file", { path: readmeEntry.path });
      const text = file?.text ?? "";
      if (file?.binary || file?.truncated) {
        bodyEl.classList.add("code-md-plain");
        bodyEl.textContent = file?.truncated ? "(README too large to preview)" : "(binary)";
      } else if (/\.(md|markdown)$/i.test(readmeEntry.name)) {
        // renderMarkdown is escape-first (XSS-safe); guard anyway so a malformed
        // README can never abort the surrounding Code-view render.
        try {
          bodyEl.innerHTML = renderMarkdown(text);
        } catch {
          bodyEl.classList.add("code-md-plain");
          bodyEl.textContent = text;
        }
      } else {
        bodyEl.classList.add("code-md-plain");
        bodyEl.textContent = text;
      }
    }
  }

  /** Opens a tracked file read-only over the listing (Back restores the browser). */
  private async openCodeFile(path: string): Promise<void> {
    const wrap = el("div", "code-view code-file-view");
    const back = el("button", "mini-btn");
    back.append(glyph("arrow-left"), span("Back"));
    back.addEventListener("click", () => void this.showCodeView());
    const name = el("span", "code-file-name");
    name.textContent = path;
    const bar = el("div", "code-head");
    bar.append(back, name);
    const surface = el("div", "diff-surface code-file-surface");
    wrap.append(bar, surface);
    this.viewHost.replaceChildren(wrap);

    // Reuse one viewer; dispose any prior Monaco surface so files don't leak.
    this.activeMonacoView?.dispose();
    const viewer = new ReadonlyFileView(surface);
    this.activeMonacoView = viewer;
    const file = await host.invoke("repo:file", { path });
    if (!file) {
      viewer.showMessage("Couldn't read this file.");
    } else if (file.binary) {
      viewer.showMessage("Binary file — not shown.");
    } else if (file.truncated) {
      viewer.showMessage("File is too large to preview.");
    } else {
      viewer.show(path, file.text);
    }
  }

  // ── Changes view (working tree: stage / commit) ─────────────────────────────

  private async showChangesView(): Promise<void> {
    const wrap = el("div", "changes-view");

    const composer = el("div", "dc-composer");
    const curBranch = this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
    const branchLine = el("div", "dc-branch");
    branchLine.append(glyph("git-branch"), span(curBranch ? `Commit to ${curBranch}` : "Commit"));
    const textarea = document.createElement("textarea");
    textarea.className = "dc-message";
    textarea.placeholder = "Message (what & why)…";
    textarea.rows = 2;
    const commitRow = el("div", "dc-commit-row");
    const commitBtn = el("button", "btn btn-primary dc-commit");
    const commitLabel = span("Commit");
    commitBtn.append(glyph("git-commit"), commitLabel);
    commitBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, commitBtn, false));
    const pushBtn = el("button", "btn dc-commit dc-push");
    pushBtn.append(glyph("arrow-up"), span("Commit & Push"));
    pushBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, pushBtn, true));
    commitRow.append(commitBtn, pushBtn);
    composer.append(branchLine, textarea, commitRow);

    const toolbar = el("div", "dc-toolbar");
    const tTitle = el("span", "dc-toolbar-title");
    tTitle.textContent = "Changes";
    const tSpacer = el("div", "topbar-spacer");
    const stageAllBtn = el("button", "mini-btn");
    stageAllBtn.append(span("Stage all"));
    stageAllBtn.addEventListener("click", () => void this.changesAction("stageAll", undefined));
    const refreshBtn = el("button", "topbar-icon");
    refreshBtn.title = "Refresh";
    refreshBtn.appendChild(glyph("refresh"));
    refreshBtn.addEventListener("click", () => void this.showChangesView());
    toolbar.append(tTitle, tSpacer, stageAllBtn, refreshBtn);

    const body = el("div", "dc-body");
    const lists = el("div", "dc-lists");
    const surface = el("div", "diff-surface");
    body.append(lists, surface);
    wrap.append(composer, toolbar, body);
    this.viewHost.replaceChildren(wrap);

    const diffPanel = new DiffPanel(surface);
    this.activeMonacoView = diffPanel;
    diffPanel.showEmpty("Select a file to view its diff.");

    const files = await host.invoke("status", undefined);
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => !f.staged);
    commitLabel.textContent = staged.length ? `Commit ${staged.length}` : "Commit";

    const fileRow = (f: ChangedFile, kind: "staged" | "unstaged"): HTMLElement => {
      const row = el("button", `file-row status-${f.status}`);
      const st = el("span", "file-status");
      st.textContent = f.status;
      const path = el("span", "file-path");
      path.textContent = f.path;
      row.append(st, path);
      const actions = el("div", "row-actions");
      if (kind === "staged") {
        actions.appendChild(
          textBtn("Unstage", "Unstage this file", () => void this.changesAction("unstage", f.path)),
        );
      } else {
        actions.appendChild(
          textBtn("Stage", "Stage this file", () => void this.changesAction("stage", f.path)),
        );
        actions.appendChild(
          textBtn("Discard", "Discard changes to this file", () => {
            void confirmDialog({
              title: "Discard changes?",
              message: `Discard your changes to ${f.path}? This can't be undone.`,
              confirmLabel: "Discard",
              danger: true,
            }).then((ok) => {
              if (ok) void this.changesAction("discard", f.path);
            });
          }, true),
        );
      }
      row.appendChild(actions);
      row.addEventListener("click", () => {
        lists.querySelectorAll(".file-row.active").forEach((n) => n.classList.remove("active"));
        row.classList.add("active");
        void this.openWorkingFile(diffPanel, f.path);
      });
      return row;
    };

    lists.replaceChildren();
    if (files.length === 0) {
      lists.appendChild(emptyState("Working tree clean", "No changes to commit."));
      return;
    }
    if (staged.length) {
      lists.appendChild(groupLabel(`Staged (${staged.length})`));
      staged.forEach((f) => lists.appendChild(fileRow(f, "staged")));
    }
    if (unstaged.length) {
      lists.appendChild(groupLabel(`Changes (${unstaged.length})`));
      unstaged.forEach((f) => lists.appendChild(fileRow(f, "unstaged")));
    }
  }

  private async openWorkingFile(diffPanel: DiffPanel, path: string): Promise<void> {
    const diff = await host.invoke("file:diff", { path });
    if (!diff) {
      diffPanel.showEmpty("No diff available.");
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", path);
      if (model) {
        diffPanel.showMerge(model);
        return;
      }
    }
    diffPanel.showDiff(diff);
  }

  private async changesAction(
    channel: "stage" | "unstage" | "discard" | "stageAll",
    path: string | undefined,
  ): Promise<void> {
    try {
      const r =
        channel === "stageAll"
          ? await host.invoke("stageAll", undefined)
          : await host.invoke(channel, path ?? "");
      if (!r.ok) {
        const verb = channel === "stageAll" ? "stage all changes" : `${channel} ${path ?? ""}`.trim();
        toast(r.message || `Couldn't ${verb}.`, "error");
      }
    } catch (e) {
      toast(cleanErr(e) || "The operation failed.", "error");
    }
    if (this.currentView === "changes") void this.showChangesView();
  }

  private async doDesktopCommit(
    textarea: HTMLTextAreaElement,
    btn: HTMLElement,
    push: boolean,
  ): Promise<void> {
    const message = textarea.value.trim();
    if (!message) {
      textarea.focus();
      return;
    }
    (btn as HTMLButtonElement).disabled = true;
    try {
      const r = await host.invoke("commit", { message });
      if (!r.ok) {
        toast(r.message ?? "Commit failed.", "error");
        return;
      }
      if (push) {
        const p = await host.invoke(
          "sync:push",
          this.syncStatus?.noUpstream ? { setUpstream: true } : undefined,
        );
        // The commit already happened — be explicit if only the push failed.
        if (!p.ok) {
          toast(`Committed, but push failed: ${p.message ?? "unknown error"}`, "error");
        } else {
          toast("Committed and pushed.", "success");
        }
      } else {
        toast("Changes committed.", "success");
      }
      textarea.value = "";
      await this.refreshRefs();
      await this.updateSync();
      if (this.currentView === "changes") void this.showChangesView();
    } catch (e) {
      toast(cleanErr(e) || "Commit failed.", "error");
    } finally {
      (btn as HTMLButtonElement).disabled = false;
    }
  }

  /** Kick off the OAuth Device Flow: fetch a user code, show it, open GitHub, poll. */
  private async startDeviceFlow(
    wrap: HTMLElement,
    flow: HTMLElement,
    signIn: HTMLElement,
    onConnected: () => void,
  ): Promise<void> {
    (signIn as HTMLButtonElement).disabled = true;
    flow.replaceChildren(loadingState("Starting sign-in…"));
    let dc;
    try {
      dc = await host.invoke("github:deviceStart", undefined);
    } catch (e) {
      dc = { ok: false, message: cleanErr(e) };
    }
    if (!dc.ok || !dc.deviceCode || !dc.userCode) {
      flow.replaceChildren(
        errorState("Couldn't start sign-in", dc.message ?? "Try again in a moment.", () =>
          void this.startDeviceFlow(wrap, flow, signIn, onConnected),
        ),
      );
      (signIn as HTMLButtonElement).disabled = false;
      return;
    }

    const openUrl = dc.verificationUriComplete ?? dc.verificationUri ?? "https://github.com/login/device";
    const card = el("div", "gh-device");
    const step = el("div", "gh-device-step");
    step.append(span("Enter this code at "), (() => { const b = el("b"); b.textContent = "github.com/login/device"; return b; })());
    const codeRow = el("div", "gh-device-code-row");
    const code = el("div", "gh-device-code");
    code.textContent = dc.userCode;
    const copyBtn = el("button", "icon-btn gh-device-copy");
    copyBtn.title = "Copy code";
    copyBtn.appendChild(glyph("copy"));
    copyBtn.addEventListener("click", () => void copyText(dc.userCode!, "Code copied."));
    codeRow.append(code, copyBtn);
    const openBtn = el("button", "btn btn-primary gh-device-open");
    openBtn.append(glyph("link-external"), span("Open GitHub to authorize"));
    openBtn.addEventListener("click", () => window.open(openUrl, "_blank"));
    const status = el("div", "gh-device-status");
    status.append(el("div", "spinner"), span("Waiting for you to authorize…"));
    card.append(step, codeRow, openBtn, status);
    flow.replaceChildren(card);

    // Smooth the path: copy the code and open GitHub automatically.
    void copyText(dc.userCode, "Code copied — paste it on GitHub.");
    window.open(openUrl, "_blank");

    this.pollDeviceFlow(wrap, dc.deviceCode, dc.interval ?? 5, dc.expiresIn ?? 900, status, onConnected);
  }

  /** Poll the device-flow token endpoint until authorized / expired / dismissed. */
  private pollDeviceFlow(
    wrap: HTMLElement,
    deviceCode: string,
    interval: number,
    expiresIn: number,
    status: HTMLElement,
    onConnected: () => void,
  ): void {
    const deadline = Date.now() + expiresIn * 1000;
    let intervalSec = interval;
    const fail = (msg: string): void => {
      status.replaceChildren(span(msg));
      status.classList.add("gh-device-failed");
    };
    const tick = async (): Promise<void> => {
      if (!wrap.isConnected) return; // panel was replaced — stop polling
      if (Date.now() > deadline) {
        fail("The code expired. Click “Sign in with GitHub” to try again.");
        return;
      }
      let r;
      try {
        r = await host.invoke("github:devicePoll", { deviceCode });
      } catch {
        r = { state: "pending" as const };
      }
      if (!wrap.isConnected) return;
      if (r.state === "authorized") {
        toast(`Signed in as @${r.login}.`, "success");
        onConnected();
        return;
      }
      if (r.state === "denied" || r.state === "expired" || r.state === "error") {
        fail(r.message ?? "Sign-in failed. Try again.");
        return;
      }
      if (r.state === "slow_down") intervalSec += 5;
      window.setTimeout(() => void tick(), intervalSec * 1000);
    };
    window.setTimeout(() => void tick(), intervalSec * 1000);
  }


  /** The commit graph + a collapsible / drag-resizable commit-details panel. */
  private showGraphView(): void {
    const wrap = el("div", "graph-view");
    const graphHost = el("div", "graph-host");
    const resizer = el("div", "graph-resizer");
    const grip = el("div", "graph-grip");
    const collapseBtn = el("button", "graph-collapse");
    collapseBtn.title = "Collapse / expand the details panel";
    collapseBtn.appendChild(glyph("chevron-down"));
    resizer.append(grip, collapseBtn);
    const detailsHost = el("div", "details-host");
    this.detailsEl = detailsHost;
    wrap.append(graphHost, resizer, detailsHost);
    this.viewHost.replaceChildren(wrap);
    this.wireGraphResizer(wrap, resizer, detailsHost, collapseBtn);

    this.graph?.dispose(); // tear down a prior mount before replacing it
    this.graph = new GraphMount(graphHost, {
      onSelect: (sha) => void this.selectCommit(sha),
      onOpen: (sha) => void this.selectCommit(sha),
      onContext: (sha, x, y) => this.contextMenu.open(sha, x, y),
    });
    this.showDetailsPlaceholder();
    void this.graph.reload();
  }

  /** Drag the splitter to resize the details panel; click the chevron to collapse it. */
  private wireGraphResizer(
    wrap: HTMLElement,
    resizer: HTMLElement,
    details: HTMLElement,
    collapseBtn: HTMLElement,
  ): void {
    let collapsed = false;
    let lastHeight = 0;
    const setHeight = (h: number): void => {
      details.style.flex = `0 0 ${Math.round(h)}px`;
    };
    resizer.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".graph-collapse")) return;
      if (collapsed) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const onMove = (ev: MouseEvent): void => {
        const h = Math.max(90, Math.min(rect.bottom - ev.clientY, rect.height - 140));
        setHeight(h);
      };
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    collapseBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      collapseBtn.classList.toggle("collapsed", collapsed);
      if (collapsed) {
        lastHeight = details.getBoundingClientRect().height;
        details.style.display = "none";
      } else {
        details.style.display = "";
        if (lastHeight) setHeight(lastHeight);
      }
    });
  }

  /** A branded "coming next" panel for views still being built out. */
  private showPlaceholderView(id: string): void {
    const copy: Record<string, { icon: string; title: string; desc: string }> = {
      changes: { icon: "request-changes", title: "Changes", desc: "Stage, review, and commit your working tree — the full Changes experience is landing here next." },
      branches: { icon: "git-branch", title: "Branches", desc: "Every local, remote, and tag with checkout, compare, and favorites — coming to the app next." },
      compare: { icon: "git-compare", title: "Compare", desc: "Pick a base and a head to see the commits, files, and diffs between them — GitHub/GitLab-style." },
      stashes: { icon: "archive", title: "Stashes", desc: "Save and restore work-in-progress without committing — arriving with the next pass." },
      worktrees: { icon: "list-tree", title: "Worktrees", desc: "Check out multiple branches side by side — ideal for running agents in parallel." },
      prs: { icon: "git-pull-request", title: "Pull Requests", desc: "Review, check, and merge pull requests — a github.com-grade experience, in the app." },
    };
    const m = copy[id] ?? { icon: "git-commit", title: id, desc: "Coming soon." };
    const wrap = el("div", "view-placeholder");
    const badge = el("div", "vp-badge");
    badge.appendChild(glyph(m.icon));
    const title = el("div", "vp-title");
    title.textContent = m.title;
    const desc = el("div", "vp-desc");
    desc.textContent = m.desc;
    const tag = el("div", "vp-tag");
    tag.textContent = "Coming next";
    wrap.append(badge, title, desc, tag);
    this.viewHost.replaceChildren(wrap);
  }

  // ── Sync widget (fetch / pull / push — control remote changes) ──────────────

  private buildSyncWidget(): HTMLElement {
    const wrap = el("div", "topbar-sync");
    const main = el("button", "sync-main");
    const caret = el("button", "sync-caret");
    caret.title = "Sync options";
    caret.appendChild(glyph("chevron-down"));
    caret.addEventListener("click", () => this.openSyncMenu(caret));
    wrap.append(main, caret);

    this.renderSyncWidget = (s: SyncStatus | undefined): void => {
      main.replaceChildren();
      if (!s || !s.branch) {
        wrap.style.display = "none";
        return;
      }
      wrap.style.display = "";
      const set = (icon: string, label: string, title: string, fn: () => void): void => {
        main.append(glyph(icon), span(label));
        main.title = title;
        main.onclick = fn;
      };
      if (s.noUpstream) {
        set("cloud", "Publish", "Publish this branch to its remote", () => void this.doSync("publish"));
        wrap.classList.add("has-action");
      } else if (s.behind > 0) {
        set("arrow-down", `Pull ${s.behind}`, `Pull ${s.behind} commit(s) from ${s.upstream}`, () => void this.doSync("pull"));
        wrap.classList.add("has-action");
      } else if (s.ahead > 0) {
        set("arrow-up", `Push ${s.ahead}`, `Push ${s.ahead} commit(s) to ${s.upstream}`, () => void this.doSync("push"));
        wrap.classList.add("has-action");
      } else {
        set("sync", "Fetch", `Up to date with ${s.upstream} — fetch for updates`, () => void this.doSync("fetch"));
        wrap.classList.remove("has-action");
      }
    };
    this.renderSyncWidget(this.syncStatus);
    return wrap;
  }

  private async updateSync(): Promise<void> {
    this.syncStatus = await host.invoke("sync:status", undefined);
    this.renderSyncWidget?.(this.syncStatus);
  }

  private async doSync(action: "fetch" | "pull" | "push" | "publish"): Promise<void> {
    if (this.syncing) return; // lock the trigger against double-invocation
    this.syncing = true;
    const widget = document.querySelector(".topbar-sync");
    widget?.classList.add("busy");
    try {
      const r =
        action === "fetch"
          ? await host.invoke("sync:fetch", undefined)
          : action === "pull"
            ? await host.invoke("sync:pull", undefined)
            : action === "push"
              ? await host.invoke("sync:push", undefined)
              : await host.invoke("sync:push", { setUpstream: true });
      if (!r.ok) {
        toast(r.message ?? `${action} failed.`, "error");
        return;
      }
      const verb =
        action === "fetch" ? "Fetched" : action === "pull" ? "Pulled" : action === "publish" ? "Published branch" : "Pushed";
      toast(`${verb} successfully.`, "success");
      await this.updateSync();
      await this.refreshAll();
      // Refresh the active data view so its content reflects the sync.
      this.routeView(this.currentView);
    } catch (e) {
      toast(cleanErr(e) || `${action} failed.`, "error");
    } finally {
      this.syncing = false;
      document.querySelector(".topbar-sync")?.classList.remove("busy");
    }
  }

  private openSyncMenu(anchor: HTMLElement): void {
    const s = this.syncStatus;
    const items: MenuItem[] = [
      { label: "Fetch", icon: "sync", onClick: () => void this.doSync("fetch") },
    ];
    if (s?.noUpstream) {
      items.push({ label: "Publish branch", icon: "cloud", onClick: () => void this.doSync("publish") });
    } else {
      items.push({ label: "Pull", icon: "arrow-down", onClick: () => void this.doSync("pull") });
      items.push({ label: "Push", icon: "arrow-up", onClick: () => void this.doSync("push") });
    }
    openMenu(anchor, items);
  }

  private topbar(info: RepoInfo): HTMLElement {
    const bar = el("header", "topbar");

    const home = el("button", "topbar-home");
    home.title = "Back to main menu";
    home.setAttribute("aria-label", "Back to main menu");
    home.appendChild(brandMark());
    home.addEventListener("click", () => void this.backToMenu());

    const repoSwitch = el("button", "topbar-switch");
    const repoName = el("span", "switch-name");
    repoName.textContent = info.name;
    this.repoSwitchName = repoName;
    repoSwitch.append(repoName, glyph("chevron-down"));
    repoSwitch.title = info.root;
    repoSwitch.addEventListener("click", () => void this.openRepoMenu(repoSwitch));

    const spacer = el("div", "topbar-spacer");

    const branchSwitch = el("button", "topbar-switch");
    const branchName = el("span", "switch-name");
    branchName.textContent = "…";
    this.branchSwitchName = branchName;
    branchSwitch.append(glyph("git-branch"), branchName, glyph("chevron-down"));
    branchSwitch.addEventListener("click", () => this.openBranchMenu(branchSwitch));

    const sync = this.buildSyncWidget();

    const refresh = el("button", "topbar-icon");
    refresh.title = "Refresh";
    refresh.appendChild(glyph("refresh"));
    refresh.addEventListener("click", () => void this.refreshAll());

    bar.append(home, repoSwitch, spacer, branchSwitch, sync, refresh);
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
          icon: "folder",
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
    this.activeMonacoView = this.diffPanel;
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
      await copyText(req.sha, "Commit SHA copied.");
      return;
    }
    try {
      const result = await host.invoke("commit:action", req);
      if (!result.ok) {
        toast(result.message ?? `Couldn't ${req.action.replace(/-/g, " ")}.`, "error");
        return;
      }
      const verbs: Record<string, string> = {
        checkout: "Checked out commit",
        branch: "Branch created",
        tag: "Tag created",
        "cherry-pick": "Cherry-picked",
        revert: "Revert commit created",
        "reset-soft": "Reset (soft) to commit",
        "reset-mixed": "Reset (mixed) to commit",
        "reset-hard": "Reset (hard) to commit",
      };
      toast(`${verbs[req.action] ?? "Done"}.`, "success");
      if (result.changed) {
        await this.refreshAll();
      }
    } catch (e) {
      toast(cleanErr(e) || "The action failed.", "error");
    }
  }
}

const PREFS_KEY = "gitstudio.ui.prefs";

/** Load persisted UI preferences (best-effort; never throws). */
function loadPrefs(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Persist UI preferences (best-effort; never throws). */
function savePrefs(p: Record<string, unknown>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable; prefs are non-essential */
  }
}


new App().start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Renderer failed:", err);
});
