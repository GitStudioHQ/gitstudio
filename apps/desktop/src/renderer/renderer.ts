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
import { clickIntent, rangeBetween, reconcile, rowKey, selectionEntries, selectionPaths } from "./selection";
import "@gitstudio/webview-ui/styles/graph.css";
import "@gitstudio/webview-ui/commit-details";
import "./styles/app.css";
// The COMPLETE codicon codepoint map from the real @vscode/codicons library —
// imported last so its correct codepoints override any legacy hand-typed one.
import "./styles/codicons-full.css";
import { host } from "./bridge";
import { applyTheme, followSystemTheme, resolveTheme } from "./desktopTheme";
import type { AppTheme, ThemeMode, LogoMode } from "./desktopTheme";
import { GraphMount } from "./graphMount";
import { DiffPanel } from "./diffPanel";
import { CompareDiff } from "./compareDiff";
import { ReadonlyFileView } from "./readonlyFileView";
import { renderMarkdown } from "./markdown";
import { renderAssistant, seedAssistantGoal } from "./assistant";
import { aiModelsCard, agentAccessCard } from "./aiSettings";
import { aiChip, openAssistantTab, registerAssistantTab, streamInto, aiEnabled } from "./aiAssist";
import { toast, confirmDialog, promptInline, openModal } from "./dialogs";
import { TerminalDock } from "./terminalDock";
import { openCloneDialog } from "./cloneDialog";
import { gget, peek, bust, setCacheScope } from "./cache";
import {
  el,
  span,
  glyph,
  relTime,
  absTime,
  relTimeISO,
  initials,
  avatarHue,
  avatar,
  fileIcon,
  formatBytes,
  textBtn,
  groupLabel,
  pill,
  emptyState,
  loadingState,
  skeletonList,
  errorState,
  settingsCard,
  settingsField,
  copyText,
  cleanErr,
  isBenignError,
  brandMark,
  openMenu,
  wireResizerKeys,
  middleTruncate,
} from "./ui";
import type { MenuItem } from "./ui";
import { dismissLayers } from "./overlays";
import { openBranchPeek, openRefPeek, openStashPeek } from "./peeks";
import type { GitPeekHost } from "./peeks";
import { CommitContextMenu } from "./contextMenu";
import { wireListNav } from "./views/common";
import { resolveRelative, wireProseNav } from "./proseNav";
import { refreshHighlightTheme } from "./highlight";
import { openCommandPalette, paletteIsOpen } from "./commandPalette";
import type { PaletteGroup, PaletteItem } from "./commandPalette";
import type { SectionRender, SectionTarget } from "./views/common";
import { renderIssues, openNewIssue } from "./views/issues";
import { renderMyWork } from "./views/mywork";
import { renderPrs, openCreatePr } from "./views/prs";
import { renderActions } from "./views/actions";
import { renderReleases } from "./views/releases";
import { openNotificationsPanel, fetchUnreadCount, renderNotifications } from "./views/notifications";
import { renderExplore } from "./views/explore";
import { repoRouteId, searchTargetId } from "./exploreRoutes";
import { renderOrgs } from "./views/orgs";
import { renderProjects } from "./views/projects";
import { renderGists } from "./views/gists";
import { renderRebase } from "./views/rebase";
import type { CommitDetails as CommitDetailsEl } from "@gitstudio/webview-ui/commit-details";
import type {
  BranchInfo,
  ChangedFile,
  CommitDetailsPayload,
  CompareMode,
  CompareResult,
  HeadCommit,
  IssueInfo,
  MergeMethod,
  AppSettingsView,
  LocalCopy,
  PrDetail,
  ProjectInfo,
  PullRequest,
  RefInfo,
  GitHubStatus,
  RepoInfo,
  SshKey,
  StashInfo,
  SyncStatus,
} from "../shared/ipc";

class App {
  private graph?: GraphMount;
  private diffPanel?: DiffPanel;
  private contextMenu = new CommitContextMenu((req) => this.runAction(req));

  private detailsEl?: HTMLElement;
  /** The commit-details column beside the graph (commits view). */
  private graphDetailsPane?: HTMLElement;
  /** The kept-alive Commits view DOM — re-attached on return, never rebuilt. */
  private graphViewWrap?: HTMLElement;
  /** The repo changed while the graph was parked — reload in place on return. */
  private graphDirty = false;
  private diffSurfaceEl?: HTMLElement;
  private repoSwitchName?: HTMLElement;
  private branchSwitchName?: HTMLElement;
  private notifBellBadge?: HTMLElement;
  private selectedSha?: string;
  private currentRepo?: RepoInfo;
  private refs: RefInfo[] = [];
  private viewHost!: HTMLElement;
  private navButtons: HTMLElement[] = [];
  private currentView = "code";
  /** Guards re-entrant disk-triggered refreshes (see refreshFromDisk). */
  private refreshingFromDisk = false;
  /** "split" (staged/unstaged groups) or "checkboxes" (one ticked list) — issue #16. */
  private stagingModelPref: "split" | "checkboxes" = "split";
  /** Fetch with --prune so branches deleted on the remote drop out — issue #23. */
  private pruneOnFetchPref = true;
  /** Paths whose individual changes are currently showing (#20). */
  private expandedHunks = new Set<string>();
  /**
   * Multi-selected file rows, for stashing / staging several at once.
   *
   * Keyed "kind:path", not path. In the split model a partly staged file appears
   * TWICE — once under Staged, once under Changes — and those rows mean different
   * things; keying by path alone would select both from one click and act on the
   * wrong half. Instance state rather than DOM state because showChangesView()
   * rebuilds the whole subtree on every mutation, exactly like expandedHunks.
   */
  private selectedRows = new Set<string>();
  /** The row a shift-range extends from. */
  private selectionAnchor: string | undefined;
  /** Visual order of selectable rows, rebuilt on each repaint. */
  private rowOrder: string[] = [];
  /** Paths being dragged right now; empty when no drag is in progress. */
  private dragPaths: string[] = [];
  /** Relabels the toolbar's stash button whenever the selection changes. */
  private syncStashButton: (() => void) | undefined;
  /**
   * The Changes composer's in-progress state, held on the instance because
   * every stage / unstage / discard rebuilds that whole subtree. Without it,
   * typing a message and then staging one more file discarded the message —
   * along with the amend / sign-off toggles and any co-authors.
   */
  private composerDraft: {
    message: string;
    amend: boolean;
    signoff: boolean;
    coAuthors: string[];
  } = { message: "", amend: false, signoff: false, coAuthors: [] };
  /** A pending deep-link target for the next section mount (e.g. an issue number
   *  to open from the project board). Consumed + cleared by mountSection. */
  private sectionTarget?: SectionTarget;
  /** In-app navigation history — every routed view (with its deep-link target)
   *  lands here so ⌘[/⌘] and the top-bar chevrons walk back/forward like a real
   *  app. Reset on repo switch (entries would point into the previous repo). */
  private navHistory: Array<{ view: string; target?: SectionTarget }> = [];
  private navPos = -1;
  /** True while back/forward drives routeView, so the travel isn't re-recorded. */
  private navTravel = false;
  private navBackBtn?: HTMLButtonElement;
  private navFwdBtn?: HTMLButtonElement;
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
  /**
   * Bumped whenever a new file diff starts loading. Diffs are fetched over IPC,
   * so clicking a second file (or a second commit) while the first is still in
   * flight used to paint the SLOWER, older diff over the newer selection.
   */
  private diffGen = 0;
  /** Keep-alive cache of rendered (non-Monaco) view containers, so navigating
   *  back to a view restores it instantly instead of rebuilding from scratch.
   *  Cleared on a repo switch; busted per-view on an explicit refresh. */
  private viewCache = new Map<string, HTMLElement>();
  /** Views safe to keep alive (no Monaco surface / dispose lifecycle of their own). */
  private static readonly KEEPALIVE = new Set([
    "branches",
    "explore",
    "settings",
    "assistant",
    "prs",
    "issues",
    "actions",
    "releases",
    "orgs",
    "projects",
    "gists",
    "notifications",
    "mywork",
  ]);
  /** True while a fetch/pull/push is in flight — locks the sync trigger. */
  private syncing = false;
  /** Theme preference: follow the OS, or pin light/dark. */
  private themeMode: ThemeMode = "system";
  /** Dock icon preference: "auto" follows the resolved theme, or pin light/dark. */
  private logoMode: LogoMode = "auto";
  /** Sidebar rail: persisted width (px) + collapsed-to-icons state. */
  private railWidth = 188;
  private railCollapsed = false;
  /** Changes view: persisted width (px) of the file list pane. */
  private changesListW = 340;
  private railEl?: HTMLElement;
  private railToggleEl?: HTMLElement;
  private mainStackEl?: HTMLElement;
  /** The permanent bottom terminal dock (a footer bar that expands/collapses,
   *  with the Output log + multiple terminal tabs). Lives for the repo session. */
  private terminalDock?: TerminalDock;
  /** Whether the dock is expanded vs collapsed to its footer bar. */
  private terminalExpanded = false;
  private terminalHeight = 280;

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
      } else if (e.key === "`") {
        e.preventDefault();
        this.toggleTerminal();
      } else if (e.key === "[") {
        e.preventDefault();
        this.navBack();
      } else if (e.key === "]") {
        e.preventDefault();
        this.navForward();
      } else if (e.key === "k" || e.key === "p") {
        // The Linear move: everything — sections, branches, PRs, repos,
        // actions — one keystroke away, from anywhere. One carve-out: on
        // macOS, Ctrl+K/Ctrl+P are kill-line / previous-line inside text
        // fields — leave those to the field (⌘K still opens the palette).
        const t = e.target as HTMLElement | null;
        const editable =
          !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (editable && e.ctrlKey && !e.metaKey && navigator.platform.toLowerCase().includes("mac")) {
          return;
        }
        e.preventDefault();
        if (!paletteIsOpen()) this.openPalette();
      }
    });

    // "?" opens the keyboard cheat sheet — the j/k/e/Esc layer is worthless
    // if nobody can discover it.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.currentRepo) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      openShortcutsHelp();
    });

    // Mouse back/forward buttons (buttons 3/4) walk the same history — the
    // muscle memory every browser user brings to a mouse with side buttons.
    window.addEventListener("mouseup", (e) => {
      if (!this.currentRepo) return;
      if (e.button === 3) {
        e.preventDefault();
        this.navBack();
      } else if (e.button === 4) {
        e.preventDefault();
        this.navForward();
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
    if (prefs.stagingModel === "checkboxes" || prefs.stagingModel === "split") {
      this.stagingModelPref = prefs.stagingModel;
    }
    if (typeof prefs.pruneOnFetch === "boolean") {
      this.pruneOnFetchPref = prefs.pruneOnFetch;
    }
    if (prefs.themeMode === "system" || prefs.themeMode === "light" || prefs.themeMode === "dark") {
      this.themeMode = prefs.themeMode;
    }
    if (prefs.logoMode === "auto" || prefs.logoMode === "light" || prefs.logoMode === "dark") {
      this.logoMode = prefs.logoMode;
    }
    if (typeof prefs.railWidth === "number" && prefs.railWidth >= 168 && prefs.railWidth <= 360) {
      this.railWidth = prefs.railWidth;
    }
    if (typeof prefs.railCollapsed === "boolean") this.railCollapsed = prefs.railCollapsed;
    if (typeof prefs.changesListW === "number" && prefs.changesListW >= 220) {
      this.changesListW = prefs.changesListW;
    }
    if (typeof prefs.terminalOpen === "boolean") this.terminalExpanded = prefs.terminalOpen;
    if (typeof prefs.terminalHeight === "number" && prefs.terminalHeight >= 120) {
      this.terminalHeight = prefs.terminalHeight;
    }

    applyTheme(resolveTheme(this.themeMode));
    // Reflect the resolved brand mark on the dock now that the theme is settled.
    this.syncDockIcon();
    // Re-apply on OS theme flips ONLY when following the system.
    followSystemTheme((osTheme) => {
      if (this.themeMode === "system") {
        applyTheme(osTheme);
        this.rerenderForTheme();
        // Monaco's token classes are global — without this, every highlighted
        // code block keeps the OLD theme's colors after an OS light/dark flip.
        refreshHighlightTheme();
        this.terminalDock?.applyTheme();
        // An "auto" dock icon must follow the OS flip too.
        this.syncDockIcon();
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

    const hero = el("div", "welcome-hero");
    const logo = document.createElement("img");
    logo.className = "welcome-logo";
    // The squircle app-icon mark, theme-swapped so its tile matches the page
    // (a light-tile sibling on light theme — never a dark square on a light page).
    logo.src = dark ? "./brand-icon.svg" : "./brand-icon-light.svg";
    logo.alt = "GitStudio";
    hero.appendChild(logo);

    // Wordmark as crafted text (not the brand SVG, which carries its own cube and
    // would double the mark) — tracks the theme via CSS with no asset swap.
    const wordmark = el("div", "welcome-wordmark");
    wordmark.append(span("Git", "wm-git"), span("Studio", "wm-studio"));

    const tagline = el("div", "welcome-tagline");
    tagline.textContent =
      "A JetBrains-grade Git client — your whole workflow, beautifully.";

    const actions = el("div", "welcome-actions");
    const open = el("button", "btn btn-primary welcome-open");
    open.append(glyph("folder-opened"), span("Open Repository…"));
    open.addEventListener("click", () => void this.openRepo());
    const clone = el("button", "btn btn-soft welcome-clone");
    clone.append(glyph("cloud-download"), span("Clone…"));
    clone.addEventListener("click", () =>
      openCloneDialog((root) => void this.openPath(root)),
    );
    actions.append(open, clone);

    card.append(hero, wordmark, tagline, actions);

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

    const footer = el("div", "welcome-footer");
    footer.append(
      span("Open source", "welcome-footer-tag"),
      span("·"),
      span("Free forever", "welcome-footer-tag"),
      span("·"),
      span("Desktop & VS Code", "welcome-footer-tag"),
    );
    card.appendChild(footer);

    screen.appendChild(card);
    document.getElementById("root")!.replaceChildren(screen);
  }

  // ── Repo screen (the full window is dedicated to the open repo) ──────────────

  private showRepoScreen(info: RepoInfo): void {
    this.currentRepo = info;
    this.selectedSha = undefined;
    this.codePath = "";
    this.routeGen++; // a repo switch supersedes the previous repo's in-flight work
    // A new repo invalidates every kept-alive view (they hold the old repo's DOM).
    this.viewCache.clear();
    // …and the navigation history: its entries (and deep-link targets) belong
    // to the previous repo's sections.
    this.navHistory = [];
    this.navPos = -1;
    // Namespace (and wipe) the SWR cache so the previous repo's branches/status/
    // graph can never bleed into this one.
    setCacheScope(info.root);
    // A half-written commit message belongs to the repo it was typed in.
    this.composerDraft = { message: "", amend: false, signoff: false, coAuthors: [] };
    // Drop the previous repo's graph mount so a refresh from a non-graph view
    // never reloads stale history.
    this.graph?.dispose();
    this.graph = undefined;
    this.graphViewWrap = undefined;
    // Tear down the previous repo's terminal sessions — a new repo means a new
    // working directory, so its shells start fresh.
    this.terminalDock?.dispose();
    this.terminalDock = undefined;
    // Each repo starts Compare from its own current/main defaults — don't carry
    // the previous repo's (possibly non-existent) refs over.
    this.compareBase = undefined;
    this.compareHead = undefined;
    const screen = el("div", "screen repo");
    screen.appendChild(this.topbar(info));
    // A left sidebar rail routes the main area; a vertical stack holds the routed
    // view above the permanent bottom terminal dock.
    const main = el("div", "repo-main");
    const stack = el("div", "main-stack");
    this.mainStackEl = stack;
    const viewHost = el("div", "view-host");
    this.viewHost = viewHost;
    stack.append(viewHost);
    main.append(this.buildNav(), this.buildRailResizer(), stack);
    screen.appendChild(main);

    document.getElementById("root")!.replaceChildren(screen);
    // The terminal dock is a permanent footer bar — always mounted (after the
    // screen is in the DOM so xterm measures cleanly), starting collapsed or
    // expanded per the saved preference.
    this.mountTerminalDock();
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
    /** The label shown on the divider before this item (defaults to "GitHub"). */
    dividerLabel?: string;
  }> = [
    { id: "code", label: "Code", icon: "code" },
    // `source-control` (not `request-changes`, a PR-review verdict icon) — this
    // is the working tree.
    { id: "changes", label: "Changes", icon: "source-control" },
    { id: "graph", label: "Commits", icon: "git-commit" },
    { id: "branches", label: "Branches", icon: "git-branch" },
    // `git-merge` keeps Rebase in the same visual family as the other git tabs
    // (commit / branch / compare) instead of a generic list glyph.
    { id: "rebase", label: "Rebase", icon: "git-merge" },
    { id: "compare", label: "Compare", icon: "git-compare" },
    // Inbox first in the GitHub group — the "what needs me" surface (Linear's
    // Inbox translated): review requests, mentions, assignments, CI failures.
    // The top-bar bell stays for a quick glance; this is the full triage page.
    { id: "notifications", label: "Inbox", icon: "inbox", divider: true },
    // "What needs me?" answered in one page: review requests, assignments,
    // your own PRs, mentions — each row one click from acting on it.
    { id: "mywork", label: "My Work", icon: "person" },
    { id: "prs", label: "Pull Requests", icon: "git-pull-request" },
    // `issues` (the list glyph) rather than `issue-opened`, which reads as a
    // single issue's OPEN state and clashed with per-issue status icons.
    { id: "issues", label: "Issues", icon: "issues" },
    // CI pipelines read as "runs" — a play badge, not the abstract Actions logo.
    { id: "actions", label: "Actions", icon: "play-circle" },
    { id: "releases", label: "Releases", icon: "tag" },
    { id: "projects", label: "Projects", icon: "project" },
    // Account-scoped (not repo-scoped) surfaces get their own quiet group.
    // Explore leads it: discovery comes before the things you already have.
    { id: "explore", label: "Explore", icon: "telescope", divider: true, dividerLabel: "Account" },
    { id: "orgs", label: "Organizations", icon: "organization" },
    // `gist` — was `code`, a duplicate of the Code tab's glyph.
    { id: "gists", label: "Gists", icon: "gist" },
  ];

  private buildNav(): HTMLElement {
    const nav = el("nav", "nav-rail" + (this.railCollapsed ? " collapsed" : ""));
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-orientation", "vertical");
    nav.setAttribute("aria-label", "Repository views");
    nav.style.width = this.railCollapsed ? "" : `${this.railWidth}px`;
    this.railEl = nav;
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
        sep.append(span(it.dividerLabel ?? "GitHub", "nav-divider-label"));
        nav.appendChild(sep);
      }
      nav.appendChild(mkItem(it.id, it.label, it.icon, i < 8 ? `${mod}${i + 1}` : undefined));
    });
    // Footer: just Settings, pinned to the bottom of the rail. The terminal lives
    // permanently in the bottom footer dock; the sidebar toggle lives in the top
    // bar — neither clutters the rail. A dedicated class makes it a quiet, compact
    // affordance hugging the rail's bottom edge, roughly at the footer dock's level.
    nav.appendChild(el("div", "nav-spacer"));
    const settingsItem = mkItem("settings", "Settings", "gear", `${mod},`);
    settingsItem.classList.add("nav-foot-item");
    nav.appendChild(settingsItem);
    return nav;
  }

  /** The rail's right-edge divider: a pure drag-to-resize handle (the collapse
   *  toggle lives in the top bar). Dragging the rail narrow enough collapses it
   *  by hand — the "collapse by hand" the user asked for. */
  private buildRailResizer(): HTMLElement {
    /** Below this drag width the rail snaps shut. */
    const SNAP = 150;
    const grip = el("div", "rail-resizer");
    grip.append(el("div", "rail-resizer-grip"));
    wireResizerKeys(grip, {
      orientation: "vertical",
      label: "Resize sidebar",
      min: 168,
      max: () => 360,
      get: () => this.railWidth,
      set: (w) => {
        this.railWidth = w;
        if (this.railEl) this.railEl.style.width = `${w}px`;
      },
      onCommit: () => this.persist(),
      disabled: () => this.railCollapsed,
    });

    const onDown = (e: PointerEvent): void => {
      if (this.railCollapsed) return;
      e.preventDefault();
      document.body.classList.add("resizing-h");
      const startX = e.clientX;
      const startW = this.railWidth;
      let collapsedDuringDrag = false;
      const move = (ev: PointerEvent): void => {
        const raw = startW + (ev.clientX - startX);
        // Drag narrow enough → collapse by hand, and end the drag.
        if (raw < SNAP) {
          collapsedDuringDrag = true;
          up();
          this.toggleRail();
          return;
        }
        const w = Math.max(168, Math.min(360, raw));
        this.railWidth = w;
        if (this.railEl) this.railEl.style.width = `${w}px`;
      };
      const up = (): void => {
        document.body.classList.remove("resizing-h");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (!collapsedDuringDrag) this.persist();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    grip.addEventListener("pointerdown", onDown);
    grip.addEventListener("dblclick", () => {
      if (this.railCollapsed) return;
      this.railWidth = 188;
      if (this.railEl) this.railEl.style.width = "188px";
      this.persist();
    });
    return grip;
  }

  /** Update the top-bar sidebar toggle's icon + tooltip (VS Code's layout icon). */
  private syncRailToggle(): void {
    const t = this.railToggleEl;
    if (!t) return;
    t.title = this.railCollapsed ? "Show sidebar" : "Hide sidebar";
    t.setAttribute("aria-label", t.title);
    t.classList.toggle("is-collapsed", this.railCollapsed);
    t.replaceChildren(glyph(this.railCollapsed ? "layout-sidebar-left-off" : "layout-sidebar-left"));
  }

  /** Collapse the rail to an icon-only strip (or expand it back). */
  private toggleRail(): void {
    this.railCollapsed = !this.railCollapsed;
    this.persist();
    if (this.railEl) {
      this.railEl.classList.toggle("collapsed", this.railCollapsed);
      this.railEl.style.width = this.railCollapsed ? "" : `${this.railWidth}px`;
    }
    this.syncRailToggle();
    // The graph/diff Monaco + terminal surfaces need a relayout after the width change.
    this.terminalDock?.layout();
  }

  // ── Integrated terminal (permanent bottom dock) ─────────────────────────────

  /** Expand/collapse the terminal dock (Terminal nav button + Cmd/Ctrl+`). */
  private toggleTerminal(): void {
    if (this.terminalDock) {
      this.terminalDock.toggle();
      return;
    }
    // Safety net: the dock is normally mounted with the repo screen.
    this.mountTerminalDock()?.expand();
  }

  /** Mount the permanent terminal dock (footer bar) into the main stack. */
  private mountTerminalDock(): TerminalDock | undefined {
    if (!this.mainStackEl || this.terminalDock) return this.terminalDock;
    this.terminalDock = new TerminalDock(this.mainStackEl, {
      expanded: this.terminalExpanded,
      // Never let a restored dock eat the window — the screenshot that
      // triggered this fix had it at ~60% height, drowning the actual app.
      height: Math.min(this.terminalHeight, Math.round(window.innerHeight * 0.4)),
      onStateChange: ({ expanded, height }) => {
        this.terminalExpanded = expanded;
        this.terminalHeight = height;
        this.persist();
      },
    });
    // Shrinking the window must not leave the dock covering the whole view.
    window.addEventListener("resize", () => this.terminalDock?.handleWindowResize());
    // The ✨ inline AI actions land in the ASSISTANT SECTION — one AI surface,
    // full height, instead of a chat tab splitting the window in half from
    // the bottom dock.
    registerAssistantTab((req) => {
      seedAssistantGoal(req.goal);
      this.routeView("assistant", true);
    });
    return this.terminalDock;
  }

  /** Persist the UI preferences worth restoring on next launch. */
  private persist(): void {
    savePrefs({
      currentView: this.currentView,
      stagingModel: this.stagingModelPref,
      pruneOnFetch: this.pruneOnFetchPref,
      compareFileListW: this.compareFileListW,
      compareView: this.compareView,
      branchCatsCollapsed: this.branchCatsCollapsed,
      themeMode: this.themeMode,
      logoMode: this.logoMode,
      railWidth: this.railWidth,
      railCollapsed: this.railCollapsed,
      changesListW: this.changesListW,
      terminalOpen: this.terminalExpanded,
      terminalHeight: this.terminalHeight,
    });
  }

  /** Change the theme mode: apply live + persist. */
  private setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    applyTheme(resolveTheme(mode));
    this.rerenderForTheme();
    // Recolor every highlighted code block for the new palette.
    refreshHighlightTheme();
    this.terminalDock?.applyTheme();
    // An "auto" dock icon follows the new theme.
    this.syncDockIcon();
    this.persist();
  }

  /** Change the dock icon mode: push to the dock + persist. */
  private setLogoMode(mode: LogoMode): void {
    this.logoMode = mode;
    this.syncDockIcon();
    this.persist();
  }

  /** The dock icon variant to show: pinned light/dark, or (auto) the resolved theme. */
  private dockVariant(): AppTheme {
    return this.logoMode === "auto" ? resolveTheme(this.themeMode) : this.logoMode;
  }

  /** Push the resolved dock icon variant to the main process (best-effort). */
  private syncDockIcon(): void {
    void host.invoke("appearance:dockIcon", { variant: this.dockVariant() }).catch(() => {});
  }

  /** Step back in the in-app navigation history (⌘[ / topbar chevron). */
  private navBack(): void {
    if (this.navPos <= 0) return;
    this.navPos--;
    this.navTravelTo(this.navHistory[this.navPos]);
  }

  /** Step forward in the in-app navigation history (⌘] / topbar chevron). */
  private navForward(): void {
    if (this.navPos >= this.navHistory.length - 1) return;
    this.navPos++;
    this.navTravelTo(this.navHistory[this.navPos]);
  }

  private navTravelTo(entry: { view: string; target?: SectionTarget }): void {
    this.navTravel = true;
    try {
      // Same-view travel must FORCE: without it routeView's "already showing"
      // early-return swallowed the hop (navPos moved, nothing on screen
      // changed — Back looked dead). Cross-view travel stays unforced so
      // kept-alive views restore from cache.
      this.routeView(entry.view, entry.view === this.currentView, entry.target);
    } finally {
      this.navTravel = false;
    }
    this.updateNavButtons();
  }

  /** Enable/disable the top-bar back/forward chevrons to match the stack. */
  private updateNavButtons(): void {
    if (this.navBackBtn) this.navBackBtn.disabled = this.navPos <= 0;
    if (this.navFwdBtn) this.navFwdBtn.disabled = this.navPos >= this.navHistory.length - 1;
  }

  /** Swap the main area to the chosen view's surface. `target` deep-links a
   *  specific item in a section view (e.g. opening an issue from the project
   *  board) — keeping navigation inside the app instead of bouncing to GitHub. */
  private routeView(id: string, force = false, target?: SectionTarget): void {
    // Any route change dismisses every floating layer — a peek, a menu, a
    // modal, the palette, the notifications popover. They all mount on
    // document.body, so a view swap cannot take them with it: an Inbox facet
    // menu used to survive navigation and hover over the next view, filtering
    // a list that was no longer on screen.
    dismissLayers();
    // Deep-linking an item must rebuild the section so it can select that item —
    // never restore a stale cached view (which wouldn't have it open). The ONE
    // exception: a sha-only graph reveal, which works against the live
    // kept-alive mount — forcing would tear it down and refetch history for a
    // scroll that needs nothing rebuilt.
    const shaOnlyGraphReveal =
      id === "graph" &&
      !!target?.sha &&
      target.number === undefined &&
      target.ref === undefined &&
      target.path === undefined;
    if (target && !shaOnlyGraphReveal) force = true;
    this.sectionTarget = target;
    // Re-clicking the section you're already on (or navigating to it) should do
    // nothing — the view is already there. Only an explicit refresh rebuilds.
    if (!force && id === this.currentView && this.viewHost.firstChild) {
      if (shaOnlyGraphReveal && target?.sha) this.revealWhenReady(target.sha);
      return;
    }
    // The Code browser's identity includes its folder: a plain "code" route is
    // normalized to carry the CURRENT folder, so its history entry restores the
    // exact place on back/forward instead of whatever codePath happens to be.
    if (id === "code" && !target) target = { path: this.codePath };
    // Record real navigation (not back/forward travel) in the history stack.
    // A forward-truncate on push gives browser semantics: navigating after
    // going back discards the abandoned forward entries.
    if (!this.navTravel) {
      this.navHistory.splice(this.navPos + 1);
      const last = this.navHistory[this.navPos];
      const same = (a?: SectionTarget, b?: SectionTarget): boolean =>
        a?.number === b?.number &&
        a?.jobId === b?.jobId &&
        a?.id === b?.id &&
        a?.sha === b?.sha &&
        a?.path === b?.path &&
        a?.ref === b?.ref &&
        (a?.list ?? false) === (b?.list ?? false);
      if (!last || last.view !== id || (target && !same(last.target, target))) {
        this.navHistory.push({ view: id, target });
        this.navPos = this.navHistory.length - 1;
      }
      this.updateNavButtons();
    }
    // Stash the OUTGOING view if it's keep-alive-able, so returning to it later
    // restores the rendered DOM (scroll, expanded state) instead of refetching.
    const prev = this.currentView;
    if (!force && App.KEEPALIVE.has(prev) && this.viewHost.firstElementChild) {
      this.viewCache.set(prev, this.viewHost.firstElementChild as HTMLElement);
    }
    if (force) {
      this.viewCache.delete(id); // a refresh must rebuild with fresh data
    }
    this.currentView = id;
    this.persist();
    this.routeGen++; // supersede any in-flight async work from the prior view
    // Free the previous view's Monaco surface before swapping the DOM under it.
    this.activeMonacoView?.dispose();
    this.activeMonacoView = undefined;
    // The "Diff" dock tab exists ONLY while a file diff is actually open — it
    // used to appear the moment you entered the commits view and sit there
    // empty. openFile() creates it on demand; leaving the view removes it.
    // Done AFTER disposing the Monaco diff (which lives in its surface) so we
    // never remove a surface with a live editor in it.
    if (id !== "graph") {
      this.closeGraphDiff();
      this.detailsEl = undefined;
    }
    for (const btn of this.navButtons) {
      const active = btn.dataset.view === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      // Roving tabindex: only the active tab is in the Tab order.
      btn.tabIndex = active ? 0 : -1;
    }
    // Restore a kept-alive view instantly, skipping the rebuild + refetch.
    const cached = App.KEEPALIVE.has(id) ? this.viewCache.get(id) : undefined;
    if (cached) {
      this.viewHost.replaceChildren(cached);
      return;
    }
    // Any soft-reload hook belongs to the view being replaced, and its captured
    // routeGen can never match again (routeGen bumps on every route). Left in
    // place it made refreshBranchesSoft await a function that returns
    // immediately — so a fetch or pull silently refreshed nothing.
    this.reloadBranchRows = null;
    if (id === "code") {
      // A path target deep-links a folder — that's how the Code browser's own
      // folder hops travel, so ⌘[/⌘] walk the folder trail like a browser.
      if (target?.path !== undefined) this.codePath = target.path;
      void this.showCodeView();
    } else if (id === "graph") {
      this.showGraphView(force);
      // A sha target deep-links a commit: scroll to + select it once the rows
      // stream in (e.g. "View in Commits" from a peek, or a tag detail).
      if (target?.sha) this.revealWhenReady(target.sha);
    } else if (id === "branches") {
      void this.showBranchesView(target?.ref);
    } else if (id === "changes") {
      void this.showChangesView();
    } else if (id === "compare") {
      void this.showCompareView();
    } else if (id === "rebase") {
      this.mountSection(renderRebase);
    } else if (id === "assistant") {
      this.mountSection(renderAssistant);
    } else if (id === "prs") {
      this.mountSection(renderPrs);
    } else if (id === "issues") {
      this.mountSection(renderIssues);
    } else if (id === "notifications") {
      this.mountSection(renderNotifications);
    } else if (id === "mywork") {
      this.mountSection(renderMyWork);
    } else if (id === "actions") {
      this.mountSection(renderActions);
    } else if (id === "releases") {
      this.mountSection(renderReleases);
    } else if (id === "explore") {
      this.mountSection(renderExplore);
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
    // Paint a content-shaped skeleton NOW — sections gate on github:status
    // before their first render, and that await used to leave a blank pane
    // (blank → skeleton → content, three stages on every visit).
    wrap.appendChild(skeletonList(6));
    this.viewHost.replaceChildren(wrap);
    const target = this.sectionTarget;
    this.sectionTarget = undefined;
    render(wrap, (v, t) => this.routeView(v, false, t), target);
  }

  /** A real branch manager: local branches with upstream + ahead/behind + last
   *  commit, plus remotes, tags and stashes. `highlightRef` deep-links one row:
   *  its group builds expanded and the row scrolls into view with a flash. */
  private async showBranchesView(highlightRef?: string): Promise<void> {
    const wrap = el("div", "list-view");
    const headRow = el("div", "list-head list-head-row");
    const filterInput = document.createElement("input");
    filterInput.className = "list-filter";
    filterInput.type = "text";
    filterInput.placeholder = "Filter branches, tags & stashes…";
    filterInput.setAttribute("aria-label", "Filter branches, tags and stashes");
    const newBtn = el("button", "mini-btn");
    newBtn.append(glyph("add"), span("New branch"));
    newBtn.addEventListener("click", () => void this.newBranch());
    headRow.append(filterInput, newBtn);
    const body = el("div", "list-body");
    // Content-shaped skeleton paints immediately; replaced once data lands.
    body.appendChild(skeletonList(8));
    wrap.append(headRow, body);
    wireListNav(body, ".list-row");
    this.viewHost.replaceChildren(wrap);

    const gen = this.routeGen;
    await this.refreshRefs();
    let locals = await gget("branches:list", undefined);
    if (gen !== this.routeGen) return;
    // Stashes join the ref manager: they're refs too, and this is the only
    // browsable surface they have (the peek offers apply / pop / drop).
    let stashes: StashInfo[] = [];
    try {
      stashes = await host.invoke("stash:list", undefined);
    } catch {
      stashes = [];
    }
    if (gen !== this.routeGen) return;
    // Recomputed on every render so a live reload (fetch from the branch menu)
    // picks up new remote branches/tags without rebuilding the whole view.
    let remotes = this.refs.filter((r) => r.type === "remote" && !r.name.endsWith("/HEAD"));
    let tags = this.refs.filter((r) => r.type === "tag");

    // A deep-linked ref must be visible: un-collapse its group before render.
    if (highlightRef) {
      const grp = locals.some((b) => b.name === highlightRef)
        ? "Local"
        : remotes.some((r) => r.name === highlightRef)
          ? "Remote"
          : tags.some((r) => r.name === highlightRef)
            ? "Tags"
            : stashes.some((s) => s.ref === highlightRef)
              ? "Stashes"
              : undefined;
      if (grp) this.branchCatsCollapsed[grp] = false;
    }

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
            const row = el("button", "list-row ref-row");
            row.dataset.ref = r.name;
            // Clicking now INSPECTS (peek with history + a deliberate Checkout
            // action) — it used to check the ref out on the spot, the only rows
            // in the app where a plain click mutated the repo.
            row.setAttribute("aria-label", `Inspect ${label.toLowerCase()} ${r.name}`);
            row.setAttribute("aria-haspopup", "dialog");
            row.append(glyph(icon));
            const nm = el("span", "list-row-name");
            nm.textContent = r.name;
            row.appendChild(nm);
            // Parity with local rows: show the commit each ref points at, so a
            // remote/tag row isn't a bare name floating in the list.
            if (r.sha) {
              const sha = el("span", "ref-sha");
              sha.textContent = r.sha.slice(0, 7);
              sha.title = r.sha;
              row.appendChild(sha);
            }
            row.addEventListener("click", () => pick(r));
            host.appendChild(row);
          }
        });
      };
      refSection("Remote", remotes, "cloud", (r) =>
        openRefPeek(this.peekHost(), r, r.name.split("/").slice(1).join("/") || r.name),
      );
      refSection("Tags", tags, "tag", (r) => openRefPeek(this.peekHost(), r, r.name));

      // Stashes — browsable at last: the peek shows the stashed files and
      // offers apply / pop / drop. (stash:list existed in the IPC contract all
      // along; no surface ever called it.)
      const stashRows = stashes.filter((s) => match(s.message) || match(s.ref));
      group("Stashes", stashRows.length, (host) => {
        for (const s of stashRows) {
          const row = el("button", "list-row ref-row stash-row");
          row.dataset.ref = s.ref;
          row.setAttribute("aria-label", `Inspect stash ${s.ref}`);
          row.setAttribute("aria-haspopup", "dialog");
          row.append(glyph("archive"));
          const meta = el("div", "row-meta");
          const top = el("div", "row-meta-title");
          top.textContent = s.message || s.ref;
          meta.appendChild(top);
          const sub = el("div", "row-meta-sub");
          sub.textContent = [s.ref, s.time ? relTime(s.time) : ""].filter(Boolean).join("  ·  ");
          if (s.time) sub.title = absTime(s.time);
          meta.appendChild(sub);
          row.appendChild(meta);
          row.addEventListener("click", () => openStashPeek(this.peekHost(), s));
          host.appendChild(row);
        }
      });

      if (!body.children.length) {
        body.appendChild(
          emptyState(q ? "No matches" : "No branches yet", q ? "Try a different filter." : "", {
            icon: "git-branch",
          }),
        );
      }
    };
    filterInput.addEventListener("input", render);
    render();

    // Deep-link: scroll the target row into view and flash it, like GitHub's
    // anchor highlight — the reader's eye lands exactly where the link pointed.
    if (highlightRef) {
      const row = Array.from(body.querySelectorAll<HTMLElement>(".list-row")).find(
        (r) => r.dataset.ref === highlightRef,
      );
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("row-flash");
        row.addEventListener("animationend", () => row.classList.remove("row-flash"), {
          once: true,
        });
      }
    }

    // Live row reload — refreshes counts/refs IN PLACE (no skeleton, and an
    // open branch-actions menu survives) after fetch/pull. Stale-guarded by
    // the route generation; cleared implicitly when another view renders.
    this.reloadBranchRows = async (): Promise<void> => {
      if (gen !== this.routeGen) return;
      await this.refreshRefs();
      locals = await gget("branches:list", undefined);
      try {
        stashes = await host.invoke("stash:list", undefined);
      } catch {
        /* keep the stashes we had */
      }
      if (gen !== this.routeGen) return;
      remotes = this.refs.filter((r) => r.type === "remote" && !r.name.endsWith("/HEAD"));
      tags = this.refs.filter((r) => r.type === "tag");
      render();
    };
  }

  /** Set while the Branches view is live — see showBranchesView. */
  private reloadBranchRows: (() => Promise<void>) | null = null;

  /** The App-side operations handed to peek cards (peeks.ts). Every mutation a
   *  peek can trigger routes through the same helpers the views use, so toasts,
   *  cache busting, and refreshes behave identically everywhere. */
  private peekHost(): GitPeekHost {
    return {
      checkout: (ref) => void this.checkoutRef(ref),
      branchMenu: (b, anchor) => this.openBranchActions(b, anchor),
      compareWith: (head) => {
        const current = this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
        this.compareBase = current ?? "HEAD";
        this.compareHead = head;
        this.routeView("compare", true);
      },
      revealInGraph: (sha) => this.revealInGraph(sha),
      openBranch: (ref) => this.routeView("branches", false, { ref }),
      openCommitFile: (file, sha) => void this.openFile({ path: file.path, status: file.status }, sha),
      stashesChanged: () => {
        // Applying/popping a stash changes the working tree; dropping changes
        // the list. Bust the SWR cache and refresh whatever's showing.
        bust();
        void this.refreshBranchesSoft();
        void this.updateSync();
      },
    };
  }

  /** Refresh branch rows in place when the Branches view is up, else fully. */
  private async refreshBranchesSoft(): Promise<void> {
    if (this.currentView === "branches" && this.reloadBranchRows) {
      await this.reloadBranchRows();
    } else if (this.currentView === "branches") {
      void this.showBranchesView();
    }
  }

  private localBranchRow(b: BranchInfo): HTMLElement {
    const row = el("div", "list-row branch-row" + (b.current ? " is-current" : ""));
    row.dataset.ref = b.name;
    row.appendChild(glyph(b.current ? "check" : "git-branch"));
    const meta = el("div", "row-meta");
    const top = el("div", "row-meta-title branch-title");
    const nm = el("span", "branch-name-txt");
    nm.textContent = b.name;
    top.appendChild(nm);
    if (b.ahead) {
      const p = el("span", "ab-pill ahead");
      p.textContent = `↑${b.ahead}`;
      p.title = `${b.ahead} commit(s) to push to ${b.upstream ?? "upstream"}`;
      top.appendChild(p);
    }
    if (b.behind) {
      // The behind count IS the pull button: click pulls those commits live
      // (fast-forwarding the branch in place when it isn't checked out).
      const p = el("button", "ab-pill behind ab-btn") as HTMLButtonElement;
      p.append(glyph("arrow-down"), span(`Pull ${b.behind}`, "ab-lbl"));
      p.title = b.current
        ? `Pull ${b.behind} commit(s) from ${b.upstream ?? "upstream"}`
        : `Pull ${b.behind} commit(s) into ${b.name} — fast-forward, no checkout`;
      p.setAttribute("aria-label", p.title);
      p.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.pullBranchLive(b, p);
      });
      top.appendChild(p);
    }
    meta.appendChild(top);
    const bits: string[] = [];
    if (b.upstream) bits.push(b.upstream);
    if (b.date) bits.push(relTime(b.date));
    if (b.subject) bits.push(b.subject);
    const sub = el("div", "row-meta-sub");
    sub.textContent = bits.join("  ·  ");
    if (b.date) sub.title = absTime(b.date);
    meta.appendChild(sub);
    row.appendChild(meta);
    const actions = el("div", "row-actions");
    if (!b.current) {
      actions.append(
        textBtn("Checkout", "Check out this branch", () => void this.checkoutRef(b.name)),
        textBtn("Delete", "Delete this branch", () => void this.deleteBranch(b.name), true),
      );
    }
    // Clicking a row opens the branch's PEEK — a browsable card with its recent
    // commits, tracking state, and actions — never a stray checkout. The ⋯
    // button keeps the quick-actions menu for one-click operations. The row
    // contains buttons, so it can't BE a <button> — role + keyboard contract.
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Inspect branch ${b.name}`);
    row.setAttribute("aria-haspopup", "dialog");
    row.classList.add("is-clickable");
    row.addEventListener("click", () => openBranchPeek(this.peekHost(), b));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openBranchPeek(this.peekHost(), b);
      }
    });
    const moreBtn = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    moreBtn.setAttribute("aria-label", `More actions for ${b.name}`);
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.appendChild(glyph("ellipsis"));
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openBranchActions(b, moreBtn);
    });
    actions.appendChild(moreBtn);
    row.appendChild(actions);
    return row;
  }

  /** The per-branch action menu: merge / rebase / rename / set-upstream / tag /
   *  delete-remote — the depth that makes Branches a real manager, not a list. */
  private openBranchActions(b: BranchInfo, anchor: HTMLElement): void {
    const refresh = async (): Promise<void> => {
      bust();
      await this.refreshRefs();
      await this.updateSync();
      if (this.currentView === "branches") void this.showBranchesView();
    };
    const run = async (
      label: string,
      p: Promise<{ ok: boolean; message?: string }>,
    ): Promise<void> => {
      try {
        const r = await p;
        if (!r.ok) toast(cleanErr(r.message) || `Couldn't ${label}.`, "error");
        else toast(`${label} ✓`, "success");
      } catch (e) {
        toast(cleanErr(e) || `Couldn't ${label}.`, "error");
      }
      await refresh();
    };
    const items: MenuItem[] = [];
    // Fetch is pinned on top and runs IN PLACE: the menu stays open, the item
    // spins while the remotes refresh, and every row's ↓/↑ counts update live
    // behind it — so "what's unpulled where?" is one click, not a round trip.
    items.push({
      label: "Fetch",
      sub: "update remote tracking",
      icon: "sync",
      keepOpen: true,
      onClick: (itemEl) => void this.fetchLiveInMenu(itemEl, b),
    });
    // Push / Publish for THIS branch. The menu offered no way to push at all —
    // only the top-bar widget could, and only for the checked-out branch, so an
    // ahead or unpublished branch was unpushable from the list showing it.
    items.push({
      label: b.upstream ? "Push" : "Publish branch",
      sub: b.upstream
        ? b.ahead
          ? `${b.ahead} commit(s) to ${b.upstream}`
          : `to ${b.upstream}`
        : "create it on the remote and track it",
      icon: b.upstream ? "arrow-up" : "cloud-upload",
      onClick: () =>
        void run(
          b.upstream ? `push ${b.name}` : `publish ${b.name}`,
          host.invoke("branch:push", { name: b.name }),
        ),
    });
    items.push({ separator: true });
    if (!b.current) {
      items.push({
        label: `Checkout ${b.name}`,
        icon: "check",
        onClick: () => void this.checkoutRef(b.name),
      });
    }
    // Always offered while an upstream exists (a fetch from this very menu can
    // surface new commits): pulls WITHOUT checking the branch out. The current
    // branch gets a real pull instead, shown only when it's actually behind.
    if (b.upstream && !b.current) {
      items.push({
        label: b.behind ? `Pull ${b.behind} into ${b.name}` : `Pull latest into ${b.name}`,
        sub: "fast-forward — no checkout",
        icon: "arrow-down",
        onClick: () => void this.pullBranchLive(b),
      });
    } else if (b.current && b.behind && b.upstream) {
      items.push({
        label: `Pull ${b.behind} commit${b.behind === 1 ? "" : "s"}`,
        sub: b.upstream,
        icon: "arrow-down",
        onClick: () => void this.pullBranchLive(b),
      });
    }
    if (!b.current || b.behind) items.push({ separator: true });
    if (!b.current) {
      items.push({
        label: `Merge ${b.name} into current`,
        icon: "git-merge",
        onClick: () => void run(`merge ${b.name}`, host.invoke("branch:merge", { name: b.name })),
      });
      items.push({
        label: `Rebase current onto ${b.name}`,
        icon: "git-pull-request",
        onClick: () => void run(`rebase onto ${b.name}`, host.invoke("branch:rebase", { onto: b.name })),
      });
      items.push({ separator: true });
    }
    items.push({
      label: "Copy branch name",
      icon: "copy",
      onClick: () => void copyText(b.name, `Copied “${b.name}”.`),
    });
    items.push({
      label: "Rename…",
      icon: "edit",
      onClick: () => {
        void (async (): Promise<void> => {
          const to = await promptInline("Rename branch", "new-name", b.name);
          if (to && to.trim() && to.trim() !== b.name)
            await run("rename branch", host.invoke("branch:rename", { from: b.name, to: to.trim() }));
        })();
      },
    });
    items.push({
      label: "Set upstream…",
      icon: "cloud",
      onClick: () => {
        void (async (): Promise<void> => {
          const up = await promptInline("Set upstream", "origin/" + b.name, b.upstream ?? "");
          if (up && up.trim())
            await run("set upstream", host.invoke("branch:setUpstream", { name: b.name, upstream: up.trim() }));
        })();
      },
    });
    items.push({
      label: "Create tag here…",
      icon: "tag",
      onClick: () => {
        void (async (): Promise<void> => {
          const name = await promptInline("Tag name", "v1.0.0");
          if (!name || !name.trim()) return;
          const msg = await promptInline("Tag message (optional — blank = lightweight)", "Release 1.0.0");
          await run("create tag", host.invoke("tag:create", { name: name.trim(), ref: b.name, message: msg?.trim() || undefined }));
        })();
      },
    });
    if (b.upstream && b.upstream.includes("/")) {
      const slash = b.upstream.indexOf("/");
      const remote = b.upstream.slice(0, slash);
      const rname = b.upstream.slice(slash + 1);
      items.push({ separator: true });
      items.push({
        label: `Delete remote branch (${b.upstream})`,
        icon: "trash",
        onClick: () => {
          void (async (): Promise<void> => {
            const ok = await confirmDialog({
              title: "Delete remote branch",
              message: `Delete ${b.upstream} from ${remote}? This affects everyone.`,
              confirmLabel: "Delete remote branch",
              danger: true,
            });
            if (ok) await run("delete remote branch", host.invoke("branch:deleteRemote", { remote, name: rname }));
          })();
        },
      });
    }
    openMenu(anchor, items);
  }

  /** Fetch triggered from an open branch menu: spins the menu item in place
   *  (the menu stays open) and live-refreshes every row's ↑/↓ counts — plus
   *  the menu's own "Pull … into <branch>" label, so it never goes stale. */
  private async fetchLiveInMenu(itemEl?: HTMLElement, b?: BranchInfo): Promise<void> {
    const g = itemEl?.querySelector(".glyph");
    itemEl?.classList.add("is-busy-item");
    g?.classList.add("spin");
    try {
      const r = await host.invoke("sync:fetch", { prune: this.pruneOnFetchPref });
      if (!r.ok) {
        toast(r.message || "Fetch failed.", "error");
        return;
      }
      bust();
      await this.updateSync();
      await this.refreshBranchesSoft();
      if (b) {
        const fresh = (await gget("branches:list", undefined)).find(
          (x) => x.name === b.name,
        );
        const pullLabel = itemEl
          ?.closest(".dropdown")
          ?.querySelector<HTMLElement>(".dropdown-item .codicon-arrow-down")
          ?.parentElement?.querySelector(".dropdown-label");
        if (fresh && pullLabel) {
          pullLabel.textContent = fresh.current
            ? `Pull ${fresh.behind} commit${fresh.behind === 1 ? "" : "s"}`
            : fresh.behind
              ? `Pull ${fresh.behind} into ${fresh.name}`
              : `Pull latest into ${fresh.name}`;
        }
      }
    } catch (e) {
      toast(cleanErr(e) || "Fetch failed.", "error");
    } finally {
      itemEl?.classList.remove("is-busy-item");
      g?.classList.remove("spin");
    }
  }

  /** Pull a branch live: the current branch does a real pull; any other local
   *  fast-forwards straight from its upstream without a checkout. `btn` (the
   *  row's ↓ pill) spins while the pull runs; rows then refresh in place. */
  private async pullBranchLive(b: BranchInfo, btn?: HTMLButtonElement): Promise<void> {
    const g = btn?.querySelector(".glyph");
    const lbl = btn?.querySelector(".ab-lbl");
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("busy");
      g?.classList.remove("codicon-arrow-down");
      g?.classList.add("codicon-sync", "spin");
      if (lbl) lbl.textContent = "Pulling…";
    }
    try {
      const r = b.current
        ? await host.invoke("sync:pull", undefined)
        : await host.invoke("branch:pullFf", { name: b.name });
      if (!r.ok) {
        toast(r.message || `Couldn't pull ${b.name}.`, "error");
        return;
      }
      toast(b.current ? "Pulled successfully." : `Fast-forwarded ${b.name}.`, "success");
      bust();
      await this.updateSync();
      if (b.current) await this.refreshAll();
      await this.refreshBranchesSoft();
    } catch (e) {
      toast(cleanErr(e) || `Couldn't pull ${b.name}.`, "error");
    } finally {
      // On success the live reload rebuilt the row (and this button); only a
      // still-connected button — the failure path — needs restoring.
      if (btn?.isConnected) {
        btn.disabled = false;
        btn.classList.remove("busy");
        g?.classList.remove("codicon-sync", "spin");
        g?.classList.add("codicon-arrow-down");
        if (lbl) lbl.textContent = `Pull ${b.behind}`;
      }
    }
  }

  private async newBranch(): Promise<void> {
    const name = await promptInline("New branch", "feature/my-change");
    if (!name) return;
    const r = await host.invoke("branch:create", { name, checkout: true });
    if (!r.ok) {
      toast(r.message || `Couldn't create branch '${name}'.`, "error");
      return; // nothing changed — don't refresh as if it had
    }
    toast(`Created and checked out ${name}.`, "success");
    bust();
    await this.refreshRefs();
    await this.updateSync();
    if (this.currentView === "branches") void this.showBranchesView();
  }

  private async deleteBranch(name: string): Promise<void> {
    // Confirm FIRST. This sits a few pixels from Checkout in a hover-revealed
    // row cluster, and every other destructive action in the app asks before
    // acting — deleting a branch outright was the one that did not. The
    // force-delete prompt below is a different question (it only fires for an
    // unmerged branch) and is not a substitute for this one.
    const ok = await confirmDialog({
      title: "Delete branch",
      message: `Delete '${name}'? Commits that are only on this branch may become unreachable.`,
      confirmLabel: "Delete branch",
      danger: true,
    });
    if (!ok) {
      return;
    }
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
    if (!r.ok) {
      toast(r.message || `Couldn't delete branch '${name}'.`, "error");
      return; // branch still exists — don't refresh as if it were gone
    }
    toast(`Deleted ${name}.`, "success");
    bust();
    await this.refreshRefs();
    if (this.currentView === "branches") void this.showBranchesView();
  }

  /** Check out a branch/tag by name, then refresh refs + the view. */
  private async checkoutRef(ref: string): Promise<void> {
    const result = await host.invoke("commit:action", {
      action: "checkout",
      sha: ref,
    } as Parameters<App["runAction"]>[0]);
    // On failure (e.g. uncommitted changes block the switch) HEAD didn't move —
    // surface the error and DON'T refresh as if it succeeded (which made the UI
    // look like the branch was checked out when it wasn't).
    if (!result.ok) {
      toast(result.message || "Couldn't check out — you may have uncommitted changes.", "error");
      return;
    }
    toast(`Checked out ${ref}.`, "success");
    bust(); // checkout moves HEAD: refs/branches/status/graph/tree all change
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
    // The base must never default to the ref we're already comparing FROM.
    // It used to fall back to "main" unconditionally, so standing on main —
    // the common case — opened this view on main…main and rendered an error
    // the user could do nothing about.
    const head = this.compareHead;
    const heads = this.refs.filter((r) => r.type === "head");
    this.compareBase =
      this.compareBase ??
      heads.find((r) => (r.name === "main" || r.name === "master") && r.name !== head)?.name ??
      heads.find((r) => !r.isCurrent && r.name !== head)?.name;

    const wrap = el("div", "compare-view");

    // ── Toolbar: base ⇄ compare pickers + the dot-mode toggle. ────────────────
    const bar = el("div", "compare-bar");
    const baseBtn = el("button", "ref-pick");
    const headBtn = el("button", "ref-pick");
    const setLabel = (btn: HTMLElement, ref: string): void => {
      btn.replaceChildren(glyph("git-branch"), span(ref), glyph("chevron-down"));
    };
    // With no second ref in the repo the picker says so rather than naming a
    // ref that would compare against itself.
    setLabel(baseBtn, this.compareBase ?? "Choose a base…");
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
    // Was a bare `topbar-icon` glyph with no border or fill, wedged between two
    // bordered ref pickers — it read as a decorative separator, like the tiny
    // BASE/COMPARE labels around it. And `git-compare` is the view's own icon,
    // not "swap"; the two-way arrow says what the button does.
    const swap = el("button", "mini-btn gh-icon-btn cmp-swap");
    swap.title = "Swap base and compare";
    swap.setAttribute("aria-label", "Swap base and compare");
    swap.appendChild(glyph("arrow-swap"));
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
    // ✨ AI: explain or review what this comparison changes — opens a footer chat
    // tab the user can keep talking to. The agent runs the diff itself.
    const aiWrap = el("div", "cmp-ai");
    aiWrap.hidden = true;
    const nav = (v: string): void => this.routeView(v);
    aiWrap.append(
      aiChip(
        "Explain",
        () => {
          const b = this.compareBase, h = this.compareHead;
          openAssistantTab({
            title: `Explain ${b}…${h}`,
            goal: `Explain what changes between \`${b}\` and \`${h}\`. Run \`git diff ${b}..${h}\` to see the changes, then give a clear, structured summary of what changed and why it matters.`,
            nav,
          });
        },
        "comment",
      ),
      aiChip(
        "Review",
        () => {
          const b = this.compareBase, h = this.compareHead;
          openAssistantTab({
            title: `Review ${b}…${h}`,
            goal: `Review the changes between \`${b}\` and \`${h}\` for correctness bugs, security issues and risky changes. Run \`git diff ${b}..${h}\` to see them. Be specific and cite files.`,
            nav,
          });
        },
        "search",
      ),
    );
    void aiEnabled().then((ok) => (aiWrap.hidden = !ok));
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
    // The one action GitHub makes PRIMARY on a comparison was missing entirely:
    // you could line up base…head, read every commit and file — and then had
    // to rebuild the same comparison on github.com to open the PR. The button
    // carries this exact base/head into the create form.
    const prBtn = el("button", "mini-btn cmp-pr-btn") as HTMLButtonElement;
    prBtn.append(glyph("git-pull-request"), span("Create pull request"));
    prBtn.title = "Open a pull request from this comparison";
    prBtn.hidden = true;
    prBtn.addEventListener("click", () =>
      void openCreatePr(() => this.routeView("prs", true), {
        base: this.compareBase,
        head: this.compareHead,
      }),
    );
    void host
      .invoke("github:status", undefined)
      .then((s) => {
        prBtn.hidden = !(s.connected && !!s.repo);
      })
      .catch(() => {});
    // The Explain / Review actions live on the right of the results row — they act
    // on the comparison's diff, so they belong with the results, not the pickers.
    viewBar.append(seg, summary, prBtn, aiWrap);

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
      // Nothing to compare yet (a single-branch repo, or base === head):
      // prompt for a second ref instead of running a doomed comparison.
      if (!this.compareBase || this.compareBase === this.compareHead) {
        summary.textContent = "";
        commitsCount.textContent = "";
        filesCount.textContent = "";
        body.replaceChildren(
          emptyState(
            "Pick two refs to compare",
            this.compareBase
              ? `Base and compare are both ${this.compareHead}. Choose a different ref on either side.`
              : "This repository has only one branch. Compare needs a second ref — create or fetch one first.",
            { icon: "git-compare" },
          ),
        );
        return;
      }
      const res = await host.invoke("compare:refs", {
        base: this.compareBase,
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
        emptyState("No commits", "These refs share the same history in this direction.", {
          icon: "git-commit",
        }),
      );
      return;
    }
    const list = el("div", "cmp-commits");
    for (const c of res.commits) {
      // A real button — keyboard-focusable + clickable to reveal the commit in the
      // graph (the hover affordance now actually does something).
      const row = el("button", "compare-commit");
      row.setAttribute("aria-label", `Commit ${c.shortSha}: ${c.subject} — reveal in the graph`);
      row.title = "Reveal in the commit graph";
      const subj = el("div", "cc-subject");
      subj.textContent = c.subject;
      const meta = el("div", "cc-meta");
      meta.textContent = `${c.author} · ${c.shortSha} · ${relTime(c.date)}`;
      if (c.date) meta.title = absTime(c.date);
      row.append(subj, meta);
      row.addEventListener("click", () => this.revealInGraph(c.sha));
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
        emptyState("No file changes", "Nothing differs between these refs in this direction.", {
          icon: "git-compare",
        }),
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
    collapseBtn.setAttribute("aria-label", "Hide file list");
    collapseBtn.setAttribute("aria-expanded", "true");
    collapseBtn.appendChild(glyph("chevron-left"));
    lhead.append(ltitle, collapseBtn);
    const fileScroll = el("div", "cmp-file-scroll");
    left.append(lhead, fileScroll);

    const divider = el("div", "cmp-vsplit");
    divider.appendChild(el("div", "cmp-vsplit-grip"));

    const right = el("div", "cmp-diffpane");
    const restore = el("button", "cmp-restore");
    restore.title = "Show file list";
    restore.setAttribute("aria-label", "Show file list");
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
      collapseBtn.setAttribute("aria-expanded", c ? "false" : "true");
      requestAnimationFrame(() => diff.layout());
    };
    collapseBtn.addEventListener("click", () => setCollapsed(true));
    restore.addEventListener("click", () => setCollapsed(false));
    this.wireCompareResizer(divider, left, diff);
  }

  /** Drag the vertical divider to resize the file list; relayout the diff live. */
  private wireCompareResizer(divider: HTMLElement, left: HTMLElement, diff: CompareDiff): void {
    wireResizerKeys(divider, {
      orientation: "vertical",
      label: "Resize file list",
      min: 180,
      max: () => 580,
      get: () => this.compareFileListW,
      set: (w) => {
        this.compareFileListW = w;
        left.style.flex = `0 0 ${w}px`;
        diff.layout();
      },
      onCommit: () => this.persist(),
      disabled: () => this.compareFilesCollapsed,
    });
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
      this.settingsRepositoriesCard(),
      aiModelsCard(),
      agentAccessCard(),
      this.settingsIdentityCard(),
      this.settingsGitCard(),
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
        // The auto preview tracks the theme, so refresh it on a theme switch.
        syncLogoPreview();
      });
      btns.push(b);
      seg.appendChild(b);
    }

    // App icon: sits right next to the theme control, same card. "Auto" matches
    // the theme; the others pin the dock mark regardless of the in-app theme.
    const logoLabel = el("div", "settings-field-label");
    logoLabel.textContent = "App icon";
    const logoSub = el("div", "settings-sub");
    logoSub.textContent = "Match the theme automatically, or pin the dock icon light or dark.";
    const logoRow = el("div", "settings-logo-row");
    const logoSeg = el("div", "settings-seg");
    // A small live preview of the mark that will actually be shown on the dock.
    const preview = el("img", "settings-logo-preview") as HTMLImageElement;
    preview.alt = "";
    const syncLogoPreview = (): void => {
      preview.src = this.dockVariant() === "light" ? "./icon-light.png" : "./icon.png";
    };
    const logoModes: Array<{ id: LogoMode; label: string }> = [
      { id: "auto", label: "Auto" },
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
    ];
    const logoBtns: HTMLElement[] = [];
    for (const m of logoModes) {
      const b = el("button", "settings-seg-btn" + (this.logoMode === m.id ? " active" : ""));
      b.append(span(m.label));
      b.addEventListener("click", () => {
        this.setLogoMode(m.id);
        logoBtns.forEach((x) => x.classList.toggle("active", x === b));
        syncLogoPreview();
      });
      logoBtns.push(b);
      logoSeg.appendChild(b);
    }
    syncLogoPreview();
    logoRow.append(logoSeg, preview);

    body.append(sub, seg, logoLabel, logoSub, logoRow);
    return card;
  }

  /** Fetch behavior (issue #23): whether fetch passes --prune. Default on —
   *  stale remote-tracking branches silently pile up otherwise, and pruning
   *  only ever drops refs the remote itself already deleted. */
  private settingsGitCard(): HTMLElement {
    const { card, body } = settingsCard("Fetch", "sync");
    const label = el("div", "settings-field-label");
    label.textContent = "Prune deleted remote branches";
    const sub = el("div", "settings-sub");
    sub.textContent =
      "When fetching, drop remote-tracking branches that were deleted on the remote so the branch list never goes stale. Local branches are never touched.";
    const seg = el("div", "settings-seg");
    const modes: Array<{ prune: boolean; label: string }> = [
      { prune: true, label: "Prune on fetch" },
      { prune: false, label: "Keep stale branches" },
    ];
    const btns: HTMLElement[] = [];
    for (const m of modes) {
      const b = el(
        "button",
        "settings-seg-btn" + (this.pruneOnFetchPref === m.prune ? " active" : ""),
      );
      b.append(span(m.label));
      b.addEventListener("click", () => {
        this.pruneOnFetchPref = m.prune;
        this.persist();
        btns.forEach((x) => x.classList.toggle("active", x === b));
      });
      btns.push(b);
      seg.appendChild(b);
    }
    body.append(label, sub, seg);
    return card;
  }

  private settingsRepositoriesCard(): HTMLElement {
    const { card, body } = settingsCard("Repositories", "repo");
    const sub = el("div", "settings-sub");
    sub.textContent = "Where one-click opens and clones from GitHub land on disk.";

    const row = el("div", "settings-clonedir-row");
    const rowText = el("div", "settings-clonedir-text");
    const rowLabel = el("div", "settings-field-label");
    rowLabel.textContent = "Default clone folder";
    const rowValue = el("div", "settings-clonedir-path");
    rowValue.textContent = "Loading…";
    rowText.append(rowLabel, rowValue);
    const rowBtns = el("div", "settings-clonedir-btns");
    const changeBtn = el("button", "mini-btn");
    changeBtn.append(glyph("folder-opened"), span("Change…"));
    const resetBtn = el("button", "mini-btn");
    resetBtn.textContent = "Reset";
    resetBtn.hidden = true;
    rowBtns.append(changeBtn, resetBtn);
    row.append(rowText, rowBtns);

    const askRow = el("label", "settings-check settings-ask-row");
    const askBox = document.createElement("input");
    askBox.type = "checkbox";
    askBox.setAttribute("aria-label", "Ask where to put each clone");
    const askText = el("div", "settings-check-text");
    const askTitle = el("div", "settings-field-label");
    askTitle.textContent = "Ask where to put each clone";
    const askSub = el("div", "settings-sub");
    askSub.textContent = "Every one-click open shows the destination sheet first.";
    askText.append(askTitle, askSub);
    askRow.append(askBox, askText);

    const apply = (v: AppSettingsView): void => {
      rowValue.textContent = v.cloneDirDisplay;
      rowValue.title = v.cloneDir;
      resetBtn.hidden = v.cloneDirIsDefault;
      askBox.checked = v.askWhereEveryTime;
    };
    changeBtn.addEventListener("click", () => {
      void host
        .invoke("settings:pickCloneDir", undefined)
        .then((v) => v && apply(v))
        .catch((e) => toast(cleanErr(e) || "Couldn't choose a folder.", "error"));
    });
    resetBtn.addEventListener("click", () => {
      void host
        .invoke("settings:update", { cloneDir: null })
        .then(apply)
        .catch((e) => toast(cleanErr(e) || "Couldn't reset the folder.", "error"));
    });
    askBox.addEventListener("change", () => {
      void host
        .invoke("settings:update", { askWhereEveryTime: askBox.checked })
        .then(apply)
        .catch((e) => {
          askBox.checked = !askBox.checked;
          toast(cleanErr(e) || "Couldn't save the setting.", "error");
        });
    });
    void host
      .invoke("settings:get", undefined)
      .then(apply)
      .catch(() => {
        rowValue.textContent = "Unavailable";
      });

    // ── the local-copies manager ──────────────────────────────────────────
    const listHead = el("div", "settings-field-label settings-copies-head");
    listHead.textContent = "On this machine";
    const listSub = el("div", "settings-sub");
    listSub.textContent =
      "Every clone GitStudio knows about — the ones in your clone folder plus anything you've opened.";
    const list = el("div", "settings-copies");
    list.appendChild(loadingState("Looking for local copies…"));

    const renderCopies = (copies: LocalCopy[]): void => {
      list.replaceChildren();
      if (!copies.length) {
        const none = el("div", "settings-sub");
        none.textContent = "No local copies yet — open or clone a repository and it'll show up here.";
        list.appendChild(none);
        return;
      }
      for (const c of copies) list.appendChild(this.localCopyRow(c, renderCopies));
    };
    const loadCopies = (): void => {
      void host
        .invoke("repos:local", undefined)
        .then(renderCopies)
        .catch((e) => {
          list.replaceChildren(
            emptyState("Couldn't list local copies", cleanErr(e) || "Try again in a moment."),
          );
        });
    };
    loadCopies();

    body.append(sub, row, askRow, listHead, listSub, list);
    return card;
  }

  /** One row in the local-copies manager: what it is, where it lives, and the
   *  actions that only make sense for THAT copy (a missing folder can't be
   *  opened; an unmanaged one can't be deleted from here). */
  private localCopyRow(c: LocalCopy, refresh: (copies: LocalCopy[]) => void): HTMLElement {
    const row = el("div", "settings-copy" + (c.missing ? " is-missing" : "") + (c.current ? " is-current" : ""));
    row.appendChild(glyph(c.missing ? "warning" : "repo"));

    const meta = el("div", "settings-copy-meta");
    const top = el("div", "settings-copy-name");
    top.textContent = c.name;
    if (c.origin) {
      const chip = span(c.origin, "settings-copy-origin");
      chip.title = `origin → github.com/${c.origin}`;
      top.appendChild(chip);
    }
    for (const [label, on] of [
      ["Open", c.current],
      ["Managed", c.managed && !c.current],
      ["Recent", c.recent && !c.managed && !c.current],
      ["Missing", c.missing],
    ] as Array<[string, boolean]>) {
      if (on) top.appendChild(span(label, "settings-copy-badge"));
    }
    const bottom = el("div", "settings-copy-path");
    bottom.textContent = c.root;
    bottom.title = c.root;
    meta.append(top, bottom);
    row.appendChild(meta);

    const acts = el("div", "settings-copy-acts");
    const iconBtn = (icon: string, title: string, run: () => void): HTMLElement => {
      const b = el("button", "icon-btn");
      b.title = title;
      b.setAttribute("aria-label", title);
      b.appendChild(glyph(icon));
      b.addEventListener("click", run);
      return b;
    };
    if (!c.missing && !c.current) {
      acts.appendChild(
        iconBtn("folder-opened", `Open ${c.name} in GitStudio`, () => void this.openPath(c.root)),
      );
      acts.appendChild(
        iconBtn("link-external", "Reveal in Finder", () => {
          void host.invoke("repos:reveal", c.root).catch(() => toast("Couldn't reveal that folder.", "error"));
        }),
      );
    }
    acts.appendChild(iconBtn("copy", "Copy path", () => void copyText(c.root, "Path copied.")));
    if (c.recent) {
      acts.appendChild(
        iconBtn("close", "Remove from recents (keeps the folder)", () => {
          void host
            .invoke("repos:removeRecent", c.root)
            .then(refresh)
            .catch((e) => toast(cleanErr(e) || "Couldn't update the list.", "error"));
        }),
      );
    }
    if (c.managed && !c.current && !c.missing) {
      const del = iconBtn("trash", `Delete this clone from disk`, () => {
        void (async () => {
          const ok = await confirmDialog({
            title: `Delete ${c.name}?`,
            message: `${c.root} moves to the Trash. Anything not pushed to ${c.origin ?? "a remote"} is gone with it.`,
            confirmLabel: "Move to Trash",
            danger: true,
            requireTyped: c.name,
          });
          if (!ok) return;
          try {
            const r = await host.invoke("repos:trash", c.root);
            if (!r.ok) {
              toast(r.message || "Couldn't delete that clone.", "error");
              return;
            }
            toast(`Moved ${c.name} to the Trash.`, "success");
            refresh(await host.invoke("repos:local", undefined));
          } catch (e) {
            toast(cleanErr(e) || "Couldn't delete that clone.", "error");
          }
        })();
      });
      del.classList.add("danger");
      acts.appendChild(del);
    }
    row.appendChild(acts);
    return row;
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
        who.append(
          avatar(
            status.login ?? "you",
            status.login ? `https://github.com/${status.login}.png` : null,
            36,
          ),
        );
        const name = el("span", "settings-account-name");
        name.textContent = status.login ?? "you";
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
      let failed = false;
      try {
        id = await host.invoke("git:identity", undefined);
      } catch {
        id = { name: "", email: "" };
        failed = true;
      }
      body.replaceChildren();
      const sub = el("div", "settings-sub");
      sub.textContent = "The author name and email stamped on your commits (git config --global).";
      if (failed) {
        const warn = el("div", "settings-sub settings-warn");
        warn.textContent = "Couldn't read your current git identity — you can still set it below.";
        body.appendChild(warn);
      }
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
      let failed = false;
      try {
        keys = await host.invoke("ssh:keys", undefined);
      } catch {
        keys = [];
        failed = true;
      }
      body.replaceChildren();
      const sub = el("div", "settings-sub");
      // The card used to state "Public keys found in ~/.ssh" and then, on the
      // very next line, "No SSH keys found in ~/.ssh" — contradicting itself.
      // Describe the card, and let the body report what was actually found.
      sub.textContent = keys.length
        ? `Public keys in ~/.ssh on this machine.`
        : "GitStudio looks for public keys in ~/.ssh on this machine.";
      body.appendChild(sub);
      if (failed) {
        const none = el("div", "settings-empty");
        none.textContent = "Couldn't read ~/.ssh on this machine.";
        body.appendChild(none);
      } else if (!keys.length) {
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
          copyBtn.setAttribute("aria-label", "Copy public key path");
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
    const versionRow = el("div", "settings-sub settings-version");
    versionRow.textContent = "…";
    void host
      .invoke("app:info", undefined)
      .then((i) => {
        versionRow.textContent = `Version ${i.version}`;
      })
      .catch(() => {
        versionRow.textContent = "";
      });

    // Check for updates — the manual end of the same poll→confirm→pull flow
    // the background check drives. The status line doubles as the live
    // download-progress label while a pull is running.
    const updRow = el("div", "settings-update-row");
    const checkBtn = el("button", "mini-btn") as HTMLButtonElement;
    checkBtn.append(glyph("sync"), span("Check for updates"));
    const status = el("span", "settings-sub settings-update-status");
    this.updateProgressEl = status;
    updRow.append(checkBtn, status);
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      status.textContent = "Checking…";
      try {
        const r = await host.invoke("update:check", undefined);
        if (r.status === "uptodate") {
          status.textContent = `You're on the latest version (${r.current}).`;
        } else if (r.status === "available" && r.version) {
          status.textContent = `GitStudio ${r.version} is available.`;
          void this.promptUpdateAvailable({ version: r.version, current: r.current }, true);
        } else if (r.status === "downloading") {
          status.textContent = "An update is downloading…";
        } else if (r.status === "ready" && r.version) {
          status.textContent = `GitStudio ${r.version} is ready to install.`;
          void host.invoke("update:download", undefined); // re-announces update:ready
        } else {
          status.textContent = r.message || "Couldn't check for updates.";
        }
      } catch (e) {
        status.textContent = cleanErr(e) || "Couldn't check for updates.";
      } finally {
        checkBtn.disabled = false;
      }
    });

    const repo = el("button", "gh-link");
    repo.append(glyph("github"), span("View the project on GitHub"));
    repo.addEventListener("click", () =>
      window.open("https://github.com/GitStudioHQ/gitstudio", "_blank"),
    );
    body.append(sub, versionRow, updRow, repo);
    return card;
  }

  // ── Code view (GitHub-style repo browser: breadcrumb + listing + README) ─────

  /** Every folder hop routes through here (not a bare codePath mutation), so
   *  each one is a navigation-history entry — back/forward walk the folder
   *  trail exactly like a browser. */
  private goCodePath(path: string): void {
    this.routeView("code", false, { path });
  }

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
        btn.addEventListener("click", () => this.goCodePath(path));
      }
      crumbs.appendChild(btn);
      if (!isLast) crumbs.appendChild(span("/", "code-crumb-sep"));
    };
    // At the ROOT the repo crumb carries nothing the top-bar switcher does not
    // already show 45px above it, both with a folder-ish icon. Deeper in, it
    // earns its place as the way back to the root.
    const repoName = this.currentRepo?.name ?? "repo";
    const parts = this.codePath ? this.codePath.split("/") : [];
    if (parts.length > 0) seg(repoName, "", false);
    parts.forEach((p, i) => {
      seg(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    });
    // At the root there is no trail to draw; the folder listing below already
    // says where you are.
    if (parts.length === 0) crumbs.hidden = true;

    const countChip = el("span", "code-count");
    countChip.hidden = true;
    // Instant in-folder filter — GitHub makes you leave the listing for its
    // file finder; here the folder narrows as you type, with keyboard nav.
    const filterInput = document.createElement("input");
    filterInput.className = "code-filter";
    filterInput.type = "text";
    filterInput.placeholder = "Filter files…  (/)";
    filterInput.setAttribute("aria-label", "Filter files in this folder");
    filterInput.spellcheck = false;
    const refreshBtn = el("button", "topbar-icon");
    refreshBtn.title = "Refresh";
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.appendChild(glyph("refresh"));
    refreshBtn.addEventListener("click", () => void this.showCodeView());
    const head = el("div", "code-head");
    head.append(crumbs, countChip, el("div", "topbar-spacer"), filterInput, refreshBtn);

    // The connected "file card": a latest-commit header (repo root only), a
    // Name / Size column header, then the rows — one bordered surface, the way
    // github.com frames a directory listing.
    const card = el("div", "code-filecard");
    const latest = el("div", "code-latest-slot");
    const colhead = el("div", "code-listing-head");
    colhead.append(span("Name", "code-col code-col-name"), span("Size", "code-col code-col-size"));
    const listing = el("div", "code-listing");
    card.append(latest, colhead, listing);
    const readme = el("div", "code-readme");
    const scroll = el("div", "code-scroll");
    scroll.append(card, readme);
    listing.appendChild(skeletonList(8, false));
    wrap.append(head, scroll);
    this.viewHost.replaceChildren(wrap);

    const gen = this.routeGen;
    let entries;
    try {
      entries = await gget("repo:tree", { path: this.codePath });
    } catch (e) {
      if (gen !== this.routeGen) return;
      colhead.hidden = true;
      listing.replaceChildren(
        errorState("Couldn't read this folder", cleanErr(e) || "git ls-tree failed.", () =>
          void this.showCodeView(),
        ),
      );
      return;
    }
    if (gen !== this.routeGen) return;
    listing.replaceChildren();

    // Folders first, then files — each group alphabetical (case-insensitive),
    // the way github.com and every file browser orders a directory. `repo:tree`
    // returns raw ls-tree order, which interleaves the two.
    const sorted = [...entries].sort((a, b) => {
      const ad = a.type === "tree" ? 0 : 1;
      const bd = b.type === "tree" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    // Summarise the folder / file split in the header chip.
    const dirCount = sorted.filter((x) => x.type === "tree").length;
    const fileCount = sorted.length - dirCount;
    const summaryText =
      [
        dirCount ? `${dirCount} folder${dirCount === 1 ? "" : "s"}` : "",
        fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "empty";
    countChip.hidden = sorted.length === 0;
    countChip.replaceChildren(glyph("list-unordered"), span(summaryText));

    // ".." up-row when not at the repo root (styled as a folder row).
    if (this.codePath) {
      const up = el("button", "file-row code-row is-dir code-up");
      up.append(glyph("arrow-up"), span("..", "file-path"), el("span", "code-row-size"));
      up.addEventListener("click", () =>
        this.goCodePath(this.codePath.split("/").slice(0, -1).join("/")),
      );
      listing.appendChild(up);
    }

    if (!sorted.length && !this.codePath) {
      colhead.hidden = true;
      listing.appendChild(emptyState("Empty repository", "No tracked files at HEAD yet."));
    }

    /** Rows in display order, so the filter and keyboard nav can drive them. */
    const rows: Array<{ el: HTMLElement; name: string; label: HTMLElement }> = [];
    for (const e of sorted) {
      const isDir = e.type === "tree";
      const row = el("button", "file-row code-row" + (isDir ? " is-dir" : ""));
      const size = el("span", "code-row-size");
      size.textContent = isDir ? "" : formatBytes(e.size);
      const label = span(e.name, "file-path");
      row.append(glyph(fileIcon(e.name, isDir)), label, size);
      row.addEventListener("click", () => {
        if (isDir) this.goCodePath(e.path);
        else void this.openCodeFile(e.path);
      });
      listing.appendChild(row);
      rows.push({ el: row, name: e.name, label });
    }

    // ── filter + keyboard navigation ──
    const upRow = listing.querySelector(".code-up") as HTMLElement | null;
    const visibleRows = (): HTMLElement[] =>
      rows.filter((r) => !r.el.hidden).map((r) => r.el);

    const applyFilter = (): void => {
      const q = filterInput.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const at = q ? r.name.toLowerCase().indexOf(q) : -1;
        const match = !q || at >= 0;
        r.el.hidden = !match;
        if (match) shown++;
        // Re-render the label so the matched run is highlighted (textContent
        // everywhere — never innerHTML with a user-supplied filename).
        r.label.replaceChildren();
        if (q && at >= 0) {
          r.label.append(
            document.createTextNode(r.name.slice(0, at)),
            (() => {
              const m = document.createElement("mark");
              m.textContent = r.name.slice(at, at + q.length);
              return m;
            })(),
            document.createTextNode(r.name.slice(at + q.length)),
          );
        } else {
          r.label.textContent = r.name;
        }
      }
      if (upRow) upRow.hidden = q.length > 0;
      countChip.hidden = false;
      countChip.replaceChildren(
        glyph("list-unordered"),
        span(q ? `${shown} of ${rows.length} matching` : summaryText),
      );
      if (q && shown === 0) {
        listing.classList.add("is-empty-filter");
      } else {
        listing.classList.remove("is-empty-filter");
      }
    };
    filterInput.addEventListener("input", applyFilter);
    filterInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        filterInput.value = "";
        applyFilter();
      } else if (ev.key === "Enter" || ev.key === "ArrowDown") {
        ev.preventDefault();
        visibleRows()[0]?.focus();
      }
    });

    // Arrow keys walk the listing; "/" (or plain typing) jumps to the filter;
    // Backspace goes up a folder — the shortcuts a file browser should have.
    wrap.addEventListener("keydown", (ev) => {
      const vis = visibleRows();
      const idx = vis.indexOf(document.activeElement as HTMLElement);
      if (ev.key === "ArrowDown" && idx >= 0) {
        ev.preventDefault();
        vis[Math.min(idx + 1, vis.length - 1)]?.focus();
      } else if (ev.key === "ArrowUp" && idx >= 0) {
        ev.preventDefault();
        if (idx === 0) filterInput.focus();
        else vis[idx - 1]?.focus();
      } else if (ev.key === "/" && document.activeElement !== filterInput) {
        ev.preventDefault();
        filterInput.focus();
        filterInput.select();
      } else if (
        ev.key === "Backspace" &&
        document.activeElement !== filterInput &&
        this.codePath
      ) {
        ev.preventDefault();
        this.goCodePath(this.codePath.split("/").slice(0, -1).join("/"));
      }
    });

    // The latest-commit bar — repo root only, mirroring github.com's repo page.
    // Best-effort: if it can't be read, the bar is simply omitted.
    if (!this.codePath) {
      void host
        .invoke("repo:headCommit", undefined)
        .then((hc) => {
          if (gen !== this.routeGen || !hc) return;
          latest.replaceChildren(this.codeLatestBar(hc));
        })
        .catch(() => {});
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
          // README links to this repo's issues/PRs/commits stay IN the app —
          // and RELATIVE links ("./docs/x.md") open in the Code browser.
          const baseDir = this.codePath;
          wireProseNav(
            bodyEl,
            (v, t) => this.routeView(v, false, t),
            undefined,
            (rel) => {
              const p = resolveRelative(baseDir, rel);
              if (/\.[A-Za-z0-9]{1,8}$/.test(p.split("/").pop() ?? "")) void this.openCodeFile(p);
              else this.goCodePath(p);
            },
          );
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

  /** The GitHub-style "latest commit" header bar above the repo-root listing:
   *  author chip · subject · short-sha (copy) · relative time · commit count. */
  private codeLatestBar(hc: HeadCommit): HTMLElement {
    const bar = el("div", "code-latest");

    const av = el("span", "code-latest-av");
    av.textContent = initials(hc.author);
    av.style.setProperty("--av", avatarHue(hc.authorEmail || hc.author));

    const meta = el("div", "code-latest-meta");
    const who = el("span", "code-latest-author");
    who.textContent = hc.author || "Unknown";
    const subj = el("span", "code-latest-subject");
    subj.textContent = hc.subject || "(no commit message)";
    meta.append(who, subj);

    const sha = el("button", "code-latest-sha");
    sha.title = "Copy full SHA";
    sha.setAttribute("aria-label", "Copy full SHA");
    sha.append(glyph("git-commit"), span(hc.shortSha));
    sha.addEventListener("click", () => void copyText(hc.sha, "Commit SHA copied"));

    const when = el("span", "code-latest-when");
    if (hc.date) {
      when.textContent = relTime(hc.date);
      when.title = absTime(hc.date);
    }

    const count = el("span", "code-latest-count");
    count.append(glyph("history"), span(`${hc.total.toLocaleString()} commit${hc.total === 1 ? "" : "s"}`));

    bar.append(av, meta, sha, when, count);
    return bar;
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
    // `refs` is filled by a fire-and-forget refreshRefs(), so on FIRST paint it
    // is empty — and falling back to "detached HEAD" there told the user they
    // were detached while the top bar said "main" one row above. Until the ref
    // is actually known, say nothing rather than something false.
    const refsKnown = this.refs.length > 0;
    const curBranch = this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
    const branchLine = el("div", "dc-branch");
    const branchSummary = span("", "dc-branch-sum");
    branchLine.append(
      glyph("git-branch"),
      span(curBranch ?? (refsKnown ? "detached HEAD" : "…"), "dc-branch-name"),
      branchSummary,
    );
    const msgWrap = el("div", "dc-message-wrap");
    const textarea = document.createElement("textarea");
    textarea.className = "dc-message";
    textarea.placeholder = "Message (what & why)…";
    textarea.rows = 2;
    // Every stage / unstage / discard re-runs showChangesView(), which rebuilds
    // this whole subtree. Without a surviving draft, typing a commit message and
    // then staging one more file silently threw the message away.
    textarea.value = this.composerDraft.message;
    textarea.addEventListener("input", () => {
      this.composerDraft.message = textarea.value;
    });
    msgWrap.append(textarea);
    // ✨ Write the message from the staged diff — sits up in the branch header row
    // (right-aligned), not inside the textarea. Shown only when a model is connected.
    const writeBtn = aiChip("Write message", () =>
      void streamInto("commitMessage", {}, textarea, writeBtn as HTMLButtonElement),
    );
    writeBtn.classList.add("dc-ai-write");
    writeBtn.hidden = true;
    branchLine.append(writeBtn);
    // ✨ Review the working changes — lives in the toolbar (it acts on the diff,
    // not the message). Built here so aiEnabled() can toggle both at once.
    const reviewBtn = el("button", "mini-btn dc-review");
    reviewBtn.append(glyph("sparkle"), span("Review with AI"));
    reviewBtn.hidden = true;
    reviewBtn.addEventListener("click", () =>
      openAssistantTab({
        title: "Review changes",
        goal: "Review my current working-tree changes for correctness bugs, security issues and risky changes. Run `git diff` (and check staged changes) to see them. Be specific and cite files.",
        nav: (v) => this.routeView(v),
      }),
    );
    void aiEnabled().then((ok) => {
      writeBtn.hidden = !ok;
      reviewBtn.hidden = !ok;
    });
    // Commit options: amend the last commit, append a Signed-off-by trailer, or
    // add Co-authored-by trailers — the depth a power committer expects.
    let amend = this.composerDraft.amend;
    let signoff = this.composerDraft.signoff;
    const coAuthors: string[] = [...this.composerDraft.coAuthors];
    const getOpts = (): { amend: boolean; signoff: boolean; coAuthors: string[] } => ({
      amend,
      signoff,
      coAuthors,
    });
    const optsRow = el("div", "dc-options");
    const amendToggle = el("button", "dc-toggle") as HTMLButtonElement;
    amendToggle.setAttribute("role", "switch");
    amendToggle.setAttribute("aria-checked", "false");
    amendToggle.append(glyph("git-commit"), span("Amend last commit"));
    const signoffToggle = el("button", "dc-toggle") as HTMLButtonElement;
    signoffToggle.setAttribute("role", "switch");
    signoffToggle.setAttribute("aria-checked", "false");
    signoffToggle.append(glyph("verified"), span("Sign off"));
    const coAuthorBtn = el("button", "dc-toggle") as HTMLButtonElement;
    coAuthorBtn.append(glyph("person-add"), span("Add co-author"));
    const coAuthorChips = el("div", "dc-coauthors");
    const renderChips = (): void => {
      this.composerDraft.coAuthors = [...coAuthors];
      coAuthorChips.replaceChildren();
      coAuthors.forEach((ca, i) => {
        const chip = el("span", "dc-coauthor-chip");
        chip.append(span(ca));
        const x = el("button", "dc-chip-x") as HTMLButtonElement;
        x.setAttribute("aria-label", `Remove co-author ${ca}`);
        x.appendChild(glyph("close"));
        x.addEventListener("click", () => {
          coAuthors.splice(i, 1);
          renderChips();
        });
        chip.appendChild(x);
        coAuthorChips.appendChild(chip);
      });
    };
    amendToggle.addEventListener("click", () => {
      amend = !amend;
      this.composerDraft.amend = amend;
      amendToggle.classList.toggle("is-on", amend);
      amendToggle.setAttribute("aria-checked", amend ? "true" : "false");
      commitLabel.textContent = amend ? "Amend commit" : curBranch ? `Commit to ${curBranch}` : "Commit";
      // Prefill the last commit message when amending an empty composer.
      if (amend && !textarea.value.trim()) {
        void host.invoke("repo:headCommit", undefined).then((hc) => {
          // The WHOLE message. Prefilling only the subject meant that ticking
          // Amend and pressing commit silently deleted the body and every
          // trailer — the box looked like the commit, so nothing warned you.
          const prefill = hc?.message || hc?.subject;
          if (amend && prefill && !textarea.value.trim()) textarea.value = prefill;
        });
      }
    });
    signoffToggle.addEventListener("click", () => {
      signoff = !signoff;
      this.composerDraft.signoff = signoff;
      signoffToggle.classList.toggle("is-on", signoff);
      signoffToggle.setAttribute("aria-checked", signoff ? "true" : "false");
    });
    coAuthorBtn.addEventListener("click", async () => {
      const v = await promptInline("Add co-author", "Name <email@example.com>");
      if (v && v.trim()) {
        coAuthors.push(v.trim());
        renderChips();
      }
    });
    // Paint the restored toggle state — the buttons are built in the "off" shape.
    if (amend) {
      amendToggle.classList.add("is-on");
      amendToggle.setAttribute("aria-checked", "true");
    }
    if (signoff) {
      signoffToggle.classList.add("is-on");
      signoffToggle.setAttribute("aria-checked", "true");
    }
    renderChips();
    optsRow.append(amendToggle, signoffToggle, coAuthorBtn, coAuthorChips);

    const commitRow = el("div", "dc-commit-row");
    const commitBtn = el("button", "btn btn-primary dc-commit");
    const commitLabel = span(curBranch ? `Commit to ${curBranch}` : "Commit");
    commitBtn.append(glyph("git-commit"), commitLabel);
    commitBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, commitBtn, false, getOpts()));
    const pushBtn = el("button", "btn dc-commit dc-push");
    pushBtn.append(glyph("arrow-up"), span("Commit & Push"));
    pushBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, pushBtn, true, getOpts()));
    commitRow.append(commitBtn, pushBtn);
    // A commit needs a message, so the buttons must LOOK unavailable until
    // there is one. They used to sit in full accent and swallow the click in
    // silence — the app's most important action, dead on arrival.
    const syncCommitEnabled = (): void => {
      const ready = textarea.value.trim().length > 0;
      for (const b of [commitBtn, pushBtn]) {
        b.toggleAttribute("disabled", !ready);
        b.title = ready ? "" : "Write a commit message first";
      }
    };
    textarea.addEventListener("input", syncCommitEnabled);
    syncCommitEnabled();
    // Commit options on the left, the commit buttons up on the right — one row.
    const actionsRow = el("div", "dc-actions");
    actionsRow.append(optsRow, commitRow);
    composer.append(branchLine, msgWrap, actionsRow);

    const toolbar = el("div", "dc-toolbar");
    const tTitle = el("span", "dc-toolbar-title");
    tTitle.textContent = "Changes";
    const tSpacer = el("div", "topbar-spacer");
    // Switch how this view presents staging (issue #16): the staged/unstaged
    // split, or one list with a tick per file. A preference, not a migration —
    // the split stays the default because the separation is clearer to read.
    const modelBtn = el("button", "mini-btn dc-model");
    const syncModelBtn = (): void => {
      const checks = this.stagingModel() === "checkboxes";
      modelBtn.replaceChildren(
        glyph(checks ? "list-selection" : "list-flat"),
        span(checks ? "Checkboxes" : "Staged / Unstaged"),
      );
      modelBtn.title = checks
        ? "Showing one list with a tick per file — click for the staged/unstaged split"
        : "Showing the staged/unstaged split — click for one list with checkboxes";
    };
    syncModelBtn();
    modelBtn.addEventListener("click", () => {
      this.stagingModelPref = this.stagingModel() === "checkboxes" ? "split" : "checkboxes";
      this.persist();
      syncModelBtn();
      void this.showChangesView();
    });

    const stageAllBtn = el("button", "mini-btn");
    stageAllBtn.append(glyph("check-all"), span("Stage all"));
    stageAllBtn.addEventListener("click", () => void this.changesAction("stageAll", undefined));
    // Create a PR from the branch you're working on — closes the local→remote→PR
    // loop right where you commit. Shown only when the repo is on GitHub.
    const createPrBtn = el("button", "mini-btn dc-createpr");
    createPrBtn.append(glyph("git-pull-request"), span("Create pull request"));
    createPrBtn.hidden = true;
    createPrBtn.addEventListener("click", () =>
      void openCreatePr(() => this.routeView("prs", true), { head: curBranch }),
    );
    void host
      .invoke("github:status", undefined)
      .then((s) => {
        createPrBtn.hidden = !(s.connected && !!s.repo);
      })
      .catch(() => {
        /* offline / not connected — leave hidden */
      });
    // Hunk / line staging: stage (or unstage) exactly the lines selected in the
    // open file's diff. Hidden until a file is open; relabelled by stage state.
    let openFile: { path: string; staged: boolean } | null = null;
    let whitespaceIgnored = false;
    const stageLinesBtn = el("button", "mini-btn dc-stagelines") as HTMLButtonElement;
    stageLinesBtn.hidden = true;
    const stageLinesLabel = span("Stage lines");
    stageLinesBtn.append(glyph("list-selection"), stageLinesLabel);
    stageLinesBtn.title = "Stage (or unstage) the lines selected in the diff";
    stageLinesBtn.addEventListener("click", async () => {
      if (!openFile) return;
      const lines = diffPanel.getSelectedLines();
      if (!lines || !lines.length) {
        toast("Select lines in the diff first.", "info");
        return;
      }
      try {
        const r = await host.invoke("stage:lines", {
          path: openFile.path,
          lines,
          reverse: openFile.staged,
        });
        if (!r.ok) toast(r.message || "Couldn't apply the selected lines.", "error");
        else toast(openFile.staged ? "Unstaged selected lines." : "Staged selected lines.", "success");
      } catch (e) {
        toast(cleanErr(e) || "Couldn't apply the selected lines.", "error");
      }
      bust("status");
      bust("diff");
      if (this.currentView === "changes") void this.showChangesView();
    });
    const wsBtn = el("button", "topbar-icon dc-ws") as HTMLButtonElement;
    wsBtn.hidden = true;
    wsBtn.title = "Ignore whitespace in the diff";
    wsBtn.setAttribute("aria-label", "Ignore whitespace");
    wsBtn.appendChild(glyph("whitespace"));
    wsBtn.addEventListener("click", () => {
      whitespaceIgnored = !whitespaceIgnored;
      wsBtn.classList.toggle("is-on", whitespaceIgnored);
      diffPanel.setRenderOptions({ whitespace: whitespaceIgnored ? "all" : "none" });
    });
    const refreshBtn = el("button", "topbar-icon");
    refreshBtn.title = "Refresh";
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.appendChild(glyph("refresh"));
    refreshBtn.addEventListener("click", () => void this.showChangesView());
    // A stash button that follows the selection and relabels itself, matching the
    // extension. Without one, the toolbar could stage everything but never stash
    // anything, and the only stash route was a right-click most people never try.
    const stashBtn = el("button", "topbar-icon") as HTMLButtonElement;
    stashBtn.appendChild(glyph("archive"));
    const syncStashBtn = (): void => {
      const n = this.selectionPaths().length;
      const label =
        n === 0
          ? "Stash all changes\u2026"
          : n === 1
            ? "Stash 1 selected file\u2026"
            : `Stash ${n} selected files\u2026`;
      stashBtn.title = label;
      stashBtn.setAttribute("aria-label", label);
      stashBtn.classList.toggle("is-on", n > 0);
    };
    this.syncStashButton = syncStashBtn;
    syncStashBtn();
    stashBtn.addEventListener("click", () => {
      // With a selection live it follows it; otherwise it means the whole tree,
      // and the title has already said which.
      const paths = this.selectionPaths();
      void this.stashPaths(paths).then(() => this.clearSelection(lists, selBar));
    });

    toolbar.append(tTitle, tSpacer, modelBtn, reviewBtn, createPrBtn, stageLinesBtn, wsBtn, stashBtn, stageAllBtn, refreshBtn);

    const body = el("div", "dc-body");
    const lists = el("div", "dc-lists");
    lists.style.flex = `0 0 ${this.changesListW}px`;
    lists.appendChild(skeletonList(6));

    // Selection bar — present only while a selection exists, so the view is
    // unchanged for anyone who never selects.
    const selBar = el("div", "dc-selbar");
    selBar.hidden = true;
    const selCount = el("span", "dc-selbar-count");
    const selStash = textBtn("Stash", "Stash the selected files", () => {
      const paths = this.selectionPaths();
      if (paths.length === 0) return;
      void this.stashPaths(paths).then(() => this.clearSelection(lists, selBar));
    });
    const selClear = textBtn("Clear", "Clear the selection", () =>
      this.clearSelection(lists, selBar),
    );
    const selActions = el("div", "dc-selbar-actions");
    selActions.append(selStash, selClear);
    selBar.append(selCount, selActions);

    // The stash drop target, revealed only mid-drag.
    const dropZone = el("div", "dc-stash-drop");
    dropZone.hidden = true;
    dropZone.append(glyph("archive"), span("Drop to stash", "dc-drop-label"));
    // dragover must be cancelled or the browser refuses the drop entirely and
    // the whole gesture silently does nothing.
    dropZone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      dropZone.classList.add("is-over");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-over"));
    dropZone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const paths = this.dragPaths.slice();
      this.hideStashDrop(dropZone);
      if (paths.length === 0) return;
      void this.stashPaths(paths).then(() => this.clearSelection(lists, selBar));
    });
    // A draggable divider between the file list and the diff (persisted width).
    const divider = el("div", "cmp-vsplit dc-vsplit");
    divider.append(el("div", "cmp-vsplit-grip"));
    const surface = el("div", "diff-surface");
    wireResizerKeys(divider, {
      orientation: "vertical",
      label: "Resize file list",
      min: 220,
      max: () => 640,
      get: () => this.changesListW,
      set: (w) => {
        this.changesListW = w;
        lists.style.flex = `0 0 ${w}px`;
      },
      onCommit: () => this.persist(),
    });
    divider.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      document.body.classList.add("resizing-h");
      const startX = e.clientX;
      const startW = this.changesListW;
      const move = (ev: PointerEvent): void => {
        const w = Math.max(220, Math.min(640, startW + (ev.clientX - startX)));
        this.changesListW = w;
        lists.style.flex = `0 0 ${w}px`;
      };
      const up = (): void => {
        document.body.classList.remove("resizing-h");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.persist();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    // The list column carries its own selection bar and drop target beneath it,
    // so both stay put while `lists` itself is cleared and refilled on repaint.
    const listCol = el("div", "dc-listcol");
    listCol.style.flex = `0 0 ${this.changesListW}px`;
    lists.style.flex = "1 1 auto";
    listCol.append(lists, selBar, dropZone);
    body.append(listCol, divider, surface);
    wrap.append(composer, toolbar, body);
    this.viewHost.replaceChildren(wrap);

    const diffPanel = new DiffPanel(surface);
    this.activeMonacoView = diffPanel;
    diffPanel.showEmpty("Select a file to view its diff.");

    let files: ChangedFile[];
    try {
      files = await gget("status", undefined, 3000);
    } catch (e) {
      // A failed status load must not leave the skeleton spinning forever.
      lists.replaceChildren(
        errorState("Couldn't read the working tree", cleanErr(e) || "Git status failed.", () =>
          void this.showChangesView(),
        ),
      );
      return;
    }
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => !f.staged);
    commitLabel.textContent = curBranch ? `Commit to ${curBranch}` : "Commit";
    // A quiet context line: how many changes are staged vs. still to stage.
    const sumBits: string[] = [];
    sumBits.push(staged.length ? `${staged.length} staged` : "nothing staged");
    if (unstaged.length) sumBits.push(`${unstaged.length} to stage`);
    branchSummary.textContent = `· ${sumBits.join(" · ")}`;

    // Mid-operation banner: a merge/rebase/cherry-pick/revert in progress gets an
    // Abort / Continue affordance (Continue is gated on zero remaining conflicts).
    void host.invoke("git:opState", undefined).then((op) => {
      if (this.currentView !== "changes") return;
      const kind = op.merging
        ? "merge"
        : op.rebasing
          ? "rebase"
          : op.cherryPicking
            ? "cherry-pick"
            : op.reverting
              ? "revert"
              : null;
      if (!kind) return;
      const banner = el("div", "dc-opbanner");
      const txt = el("div", "dc-opbanner-text");
      txt.append(
        glyph("warning"),
        span(
          op.conflicts > 0
            ? `${kind} in progress — ${op.conflicts} file${op.conflicts === 1 ? "" : "s"} still conflicted`
            : `${kind} in progress — resolve and continue`,
          "dc-opbanner-strong",
        ),
      );
      const acts = el("div", "dc-opbanner-actions");
      const abort = el("button", "mini-btn") as HTMLButtonElement;
      abort.append(glyph("discard"), span("Abort"));
      const cont = el("button", "btn btn-primary mini-btn") as HTMLButtonElement;
      cont.append(glyph("check"), span("Continue"));
      cont.disabled = op.conflicts > 0;
      const runOp = async (ch: "merge:abort" | "merge:continue" | "rebase:abort" | "rebase:continue"): Promise<void> => {
        try {
          const r = await host.invoke(ch, undefined);
          if (!r.ok) toast(r.message || "Operation failed.", r.expected ? "info" : "error");
          else toast("Done.", "success");
        } catch (e) {
          toast(cleanErr(e) || "Operation failed.", "error");
        }
        bust();
        await this.refreshRefs();
        await this.updateSync();
        if (this.currentView === "changes") void this.showChangesView();
      };
      const isRebase = kind === "rebase";
      abort.addEventListener("click", () => void runOp(isRebase ? "rebase:abort" : "merge:abort"));
      cont.addEventListener("click", () => void runOp(isRebase ? "rebase:continue" : "merge:continue"));
      acts.append(abort, cont);
      banner.append(txt, acts);
      wrap.insertBefore(banner, wrap.firstChild);
    });

    const fileRow = (f: ChangedFile, kind: "staged" | "unstaged"): HTMLElement => {
      const row = el("button", `file-row dc-file status-${f.status}`);
      const slash = f.path.lastIndexOf("/");
      const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
      const dir = slash >= 0 ? f.path.slice(0, slash) : "";
      row.appendChild(glyph(fileIcon(base)));
      const meta = el("div", "dc-file-meta");
      meta.appendChild(span(base, "dc-file-name"));
      if (dir) meta.appendChild(span(dir, "dc-file-dir"));
      row.appendChild(meta);
      const st = el("span", "file-status");
      st.textContent = f.status;
      row.appendChild(st);
      row.title = f.path;
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

      const key = rowKey(kind, f.path);
      row.dataset.path = f.path;
      row.dataset.kind = kind;
      row.dataset.key = key;
      this.rowOrder.push(key);
      if (this.selectedRows.has(key)) {
        row.classList.add("is-selected");
        row.setAttribute("aria-selected", "true");
      }

      row.addEventListener("click", (ev) => {
        // A modifier click selects; a plain one opens the file, as before.
        if (this.handleSelectionClick(ev, key, lists, selBar)) return;
        lists.querySelectorAll(".file-row.active").forEach((n) => n.classList.remove("active"));
        row.classList.add("active");
        openFile = { path: f.path, staged: !!f.staged };
        stageLinesLabel.textContent = f.staged ? "Unstage lines" : "Stage lines";
        stageLinesBtn.hidden = false;
        wsBtn.hidden = false;
        void this.openWorkingFile(diffPanel, f.path);
      });

      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        // Right-clicking outside the selection acts on THAT row, so a menu can
        // never quietly operate on files scrolled out of sight.
        if (this.selectedRows.size > 0 && !this.selectedRows.has(key)) {
          this.clearSelection(lists, selBar);
        }
        const multi = this.selectedRows.has(key) && this.selectedRows.size > 1;
        openMenu(row, multi ? this.multiRowMenu(lists, selBar) : this.singleRowMenu(f, kind, lists, selBar));
      });

      // Drag a row — or the whole selection — onto the stash target.
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        if (!this.selectedRows.has(key)) {
          this.selectedRows.clear();
          this.selectedRows.add(key);
          this.selectionAnchor = key;
          this.paintSelection(lists, selBar);
        }
        const paths = this.selectionPaths();
        this.dragPaths = paths;
        ev.dataTransfer?.setData("text/plain", paths.join("\n"));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
        this.showStashDrop(dropZone, paths.length);
      });
      row.addEventListener("dragend", () => {
        this.dragPaths = [];
        row.classList.remove("dragging");
        this.hideStashDrop(dropZone);
      });

      return row;
    };

    lists.replaceChildren();
    // Rebuilt with the rows below, so a shift-range always covers what is on
    // screen rather than what was there before the last stage.
    this.rowOrder = [];
    if (files.length === 0) {
      lists.appendChild(
        emptyState("Working tree clean", "No changes to commit.", { icon: "check-all" }),
      );
      return;
    }
    if (this.stagingModel() === "checkboxes") {
      // One list, a tick per file (issue #16). The tick IS the index: ticking
      // stages, unticking unstages, and the checked state is read back from what
      // git reports — so there is no shadow selection able to drift away from the
      // repository, and an external `git add` keeps agreeing with the UI.
      const all = [
        ...staged.map((f) => ({ f, staged: true })),
        ...unstaged.map((f) => ({ f, staged: false })),
      ].sort((a, b) => a.f.path.localeCompare(b.f.path));

      // Selecting a "section" here means the CHECKED rows or the UNCHECKED ones:
      // this model deliberately has no Staged/Unstaged split to click on.
      const head = this.checklistHeader(`Changes (${all.length})`, all, lists, selBar);
      const master = document.createElement("input");
      master.type = "checkbox";
      master.className = "dc-ck dc-ck-master";
      master.checked = staged.length > 0 && unstaged.length === 0;
      master.indeterminate = staged.length > 0 && unstaged.length > 0;
      master.title = master.checked ? "Uncheck all" : "Check all";
      master.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // From a partial selection, one click means "include everything" — not a
        // per-row toggle.
        void this.changesAction(unstaged.length === 0 ? "unstageAll" : "stageAll", undefined);
      });
      head.insertBefore(master, head.firstChild);
      lists.appendChild(head);

      for (const { f, staged: isStaged } of all) {
        const row = fileRow(f, isStaged ? "staged" : "unstaged");
        const ck = document.createElement("input");
        ck.type = "checkbox";
        ck.className = "dc-ck";
        ck.checked = isStaged;
        ck.title = isStaged ? "Included in the commit" : "Not included";
        ck.addEventListener("click", (ev) => {
          // The row opens the diff; the tick must not.
          ev.stopPropagation();
          // Ticking the whole file supersedes any hunk view of it: those indexes
          // describe a state that is about to stop existing.
          this.expandedHunks.delete(f.path);
          void this.changesAction(isStaged ? "unstage" : "stage", f.path);
        });
        row.insertBefore(ck, row.firstChild);

        // A file with unstaged work opens up to tick individual changes (#20), so
        // partial staging survives the move away from the staged/unstaged split.
        const expandable = !isStaged;
        if (expandable) {
          const open = this.expandedHunks.has(f.path);
          const tw = el("button", "dc-hunk-twisty" + (open ? " open" : ""));
          tw.append(glyph("chevron-right"));
          tw.title = open ? "Hide individual changes" : "Show individual changes";
          tw.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this.expandedHunks.has(f.path)) {
              this.expandedHunks.delete(f.path);
            } else {
              this.expandedHunks.add(f.path);
            }
            void this.showChangesView();
          });
          row.insertBefore(tw, row.firstChild);
        }
        lists.appendChild(row);

        if (expandable && this.expandedHunks.has(f.path)) {
          const holder = el("div", "dc-hunks");
          holder.append(span("Reading changes…", "dc-hunk-empty"));
          lists.appendChild(holder);
          // Asked fresh every time: the file may have changed on disk since the
          // list was built, and these indexes are positional.
          void this.fillHunks(holder, f.path);
        }
      }
      return;
    }

    if (staged.length) {
      lists.appendChild(
        this.sectionHeader(`Staged (${staged.length})`, "staged", staged, lists, selBar),
      );
      staged.forEach((f) => lists.appendChild(fileRow(f, "staged")));
    }
    if (unstaged.length) {
      lists.appendChild(
        // "Changes" already names the view and the pane; this group is the
        // UNSTAGED half, and calling it "Changes" beside "Staged" made the two
        // read as unrelated rather than as a pair.
        this.sectionHeader(`Unstaged (${unstaged.length})`, "unstaged", unstaged, lists, selBar),
      );
      unstaged.forEach((f) => lists.appendChild(fileRow(f, "unstaged")));
    }
    this.reconcileSelection(lists, selBar);
  }

  /**
   * Which staging model the Changes view presents: the staged/unstaged split, or
   * one list with a tick per file (issue #16). Persisted with the other UI prefs
   * and flipped from the View menu.
   */
  /**
   * Populate one file's tickable changes. Ticking one stages exactly that change
   * and leaves the rest of the file — and the working tree — alone.
   */
  private async fillHunks(holder: HTMLElement, path: string): Promise<void> {
    const hunks = await host.invoke("hunks:list", path);
    if (!this.expandedHunks.has(path)) {
      return; // collapsed again while we were reading
    }
    holder.replaceChildren();
    if (hunks.length === 0) {
      holder.append(span("No separate changes to pick from.", "dc-hunk-empty"));
      return;
    }
    for (const h of hunks) {
      const row = el("div", "dc-hunk-row");
      const ck = document.createElement("input");
      ck.type = "checkbox";
      ck.className = "dc-ck";
      ck.checked = false; // by construction these are the UNSTAGED changes
      ck.title = "Include this change in the commit";
      ck.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const r = await host.invoke("hunks:stage", { path, index: h.index });
          if (!r.ok) {
            toast(r.message || "Couldn't stage that change.", r.expected ? "info" : "error");
          }
          bust("status");
          bust("diff");
          void this.showChangesView();
        })();
      });
      // 1-based, matching what an editor's gutter shows.
      const lines = span(
        h.lineCount > 1 ? `L${h.start + 1}–${h.end + 1}` : `L${h.start + 1}`,
        "dc-hunk-lines",
      );
      const preview = span(h.preview || "(whitespace only)", "dc-hunk-preview");
      row.append(ck, lines, preview);
      holder.append(row);
    }
  }

  private stagingModel(): "split" | "checkboxes" {
    return this.stagingModelPref;
  }

  private async openWorkingFile(diffPanel: DiffPanel, path: string): Promise<void> {
    // Same staleness guard as openFile: a slow diff must not overwrite the file
    // the user selected after it.
    const gen = ++this.diffGen;
    const diff = await host.invoke("file:diff", { path });
    if (gen !== this.diffGen) return;
    if (!diff) {
      diffPanel.showEmpty("No diff available.");
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", path);
      if (gen !== this.diffGen) return;
      if (model) {
        diffPanel.showMerge(model, () => {
          bust("status");
          bust("diff");
          if (this.currentView === "changes") void this.showChangesView();
        });
        return;
      }
    }
    diffPanel.showDiff(diff);
  }

  /** Selection helpers — see selectedRows for why the key is kind:path. */
  private selectionEntries(): Array<{ kind: string; path: string }> {
    return selectionEntries(this.rowOrder, this.selectedRows);
  }

  /** Distinct paths in the selection — what git actually needs. */
  private selectionPaths(): string[] {
    return selectionPaths(this.rowOrder, this.selectedRows);
  }

  private paintSelection(lists: HTMLElement, selBar: HTMLElement): void {
    lists.querySelectorAll<HTMLElement>(".dc-file").forEach((r) => {
      const on = !!r.dataset.key && this.selectedRows.has(r.dataset.key);
      r.classList.toggle("is-selected", on);
      if (on) r.setAttribute("aria-selected", "true");
      else r.removeAttribute("aria-selected");
    });
    const n = this.selectionPaths().length;
    selBar.hidden = n === 0;
    const count = selBar.querySelector(".dc-selbar-count");
    if (count) count.textContent = n === 1 ? "1 file selected" : `${n} files selected`;
    this.syncStashButton?.();
  }

  private clearSelection(lists: HTMLElement, selBar: HTMLElement): void {
    this.selectedRows.clear();
    this.selectionAnchor = undefined;
    this.paintSelection(lists, selBar);
  }

  /**
   * Returns true when the click was a SELECTION gesture, so the row's normal
   * action should not also run. A plain click is not one: it clears the
   * selection and opens the file, exactly as before.
   */
  private handleSelectionClick(
    ev: MouseEvent,
    key: string,
    lists: HTMLElement,
    selBar: HTMLElement,
  ): boolean {
    const intent = clickIntent(ev, this.selectionAnchor !== undefined);
    if (intent === "range") {
      const range = rangeBetween(this.rowOrder, this.selectionAnchor!, key);
      if (range.length > 0) {
        this.selectedRows = new Set(range);
        this.paintSelection(lists, selBar);
        return true;
      }
    }
    if (intent === "toggle") {
      if (this.selectedRows.has(key)) this.selectedRows.delete(key);
      else this.selectedRows.add(key);
      this.selectionAnchor = key;
      this.paintSelection(lists, selBar);
      return true;
    }
    if (this.selectedRows.size > 0) {
      this.selectedRows.clear();
      this.paintSelection(lists, selBar);
    }
    this.selectionAnchor = key;
    return false;
  }

  private showStashDrop(zone: HTMLElement, count: number): void {
    const label = zone.querySelector(".dc-drop-label");
    if (label) {
      label.textContent = count === 1 ? "Drop to stash 1 file" : `Drop to stash ${count} files`;
    }
    zone.hidden = false;
  }

  private hideStashDrop(zone: HTMLElement): void {
    zone.hidden = true;
    zone.classList.remove("is-over");
  }

  /**
   * Drop selected rows that no longer exist, after a repaint.
   *
   * A file that was selected and has since been staged, committed or reverted is
   * simply gone from the list; a selection still counting it would offer to
   * stash files that are not there. rowOrder is everything the repaint emitted,
   * so anything outside it is stale.
   */
  private reconcileSelection(lists: HTMLElement, selBar: HTMLElement): void {
    this.selectedRows = reconcile(this.rowOrder, this.selectedRows);
    if (this.selectionAnchor && !this.rowOrder.includes(this.selectionAnchor)) {
      this.selectionAnchor = undefined;
    }
    this.paintSelection(lists, selBar);
  }

  /**
   * A group label that also selects its whole section on ctrl/cmd-click.
   *
   * Same modifier the rows use, so there is one convention rather than a second
   * mechanism beside it. Clicking again clears the section, which is what makes
   * it a toggle rather than a trap.
   */
  private sectionHeader(
    text: string,
    kind: "staged" | "unstaged",
    files: readonly ChangedFile[],
    lists: HTMLElement,
    selBar: HTMLElement,
  ): HTMLElement {
    const head = groupLabel(text);
    head.title = `${text} — Ctrl/Cmd-click to select every file in this section`;
    head.addEventListener("click", (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const keys = files.map((f) => rowKey(kind, f.path));
      const allOn = keys.length > 0 && keys.every((k) => this.selectedRows.has(k));
      for (const k of keys) {
        if (allOn) this.selectedRows.delete(k);
        else this.selectedRows.add(k);
      }
      this.selectionAnchor = keys.length > 0 ? keys[keys.length - 1] : undefined;
      this.paintSelection(lists, selBar);
    });
    return head;
  }

  /**
   * The checkbox model's single header, with section selection on it.
   *
   * Ctrl/cmd-click takes everything, matching the split model's headers.
   * Right-click names the two halves, because there is no second header to
   * modifier-click — in this model "the sections" are checked and unchecked.
   */
  private checklistHeader(
    text: string,
    all: ReadonlyArray<{ f: ChangedFile; staged: boolean }>,
    lists: HTMLElement,
    selBar: HTMLElement,
  ): HTMLElement {
    const head = groupLabel(text);
    head.title =
      `${text} — Ctrl/Cmd-click to select every file, ` +
      "right-click to select just the checked or unchecked ones";

    const keysFor = (which: "all" | "checked" | "unchecked"): string[] =>
      all
        .filter((x) => which === "all" || (which === "checked") === x.staged)
        .map((x) => rowKey(x.staged ? "staged" : "unstaged", x.f.path));

    const selectKeys = (keys: string[]): void => {
      this.selectedRows = new Set(keys);
      this.selectionAnchor = keys.length > 0 ? keys[keys.length - 1] : undefined;
      this.paintSelection(lists, selBar);
    };

    head.addEventListener("click", (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const every = keysFor("all");
      const allOn = every.length > 0 && every.every((k) => this.selectedRows.has(k));
      selectKeys(allOn ? [] : every);
    });

    head.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const checked = keysFor("checked");
      const unchecked = keysFor("unchecked");
      const items: MenuItem[] = [
        { label: `Select All (${all.length})`, icon: "check-all", onClick: () => selectKeys(keysFor("all")) },
      ];
      if (checked.length > 0) {
        items.push({ label: `Select Checked (${checked.length})`, icon: "check", onClick: () => selectKeys(checked) });
      }
      if (unchecked.length > 0) {
        items.push({ label: `Select Unchecked (${unchecked.length})`, icon: "circle-outline", onClick: () => selectKeys(unchecked) });
      }
      items.push({ separator: true });
      items.push({
        label: "Stash All Changes", icon: "archive",
        onClick: () => void this.stashPaths([]).then(() => this.clearSelection(lists, selBar)),
      });
      openMenu(head, items);
    });

    return head;
  }

  /** The row menu for a single file. */
  private singleRowMenu(
    f: ChangedFile,
    kind: "staged" | "unstaged",
    lists: HTMLElement,
    selBar: HTMLElement,
  ): MenuItem[] {
    const items: MenuItem[] = [];
    if (kind === "staged") {
      items.push({
        label: "Unstage", icon: "remove",
        onClick: () => void this.changesAction("unstage", f.path),
      });
    } else {
      items.push({
        label: "Stage", icon: "add",
        onClick: () => void this.changesAction("stage", f.path),
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Stash This File", icon: "archive",
      onClick: () => void this.stashPaths([f.path]).then(() => this.clearSelection(lists, selBar)),
    });
    items.push({
      label: "Stash All Changes", icon: "archive",
      onClick: () => void this.stashPaths([]).then(() => this.clearSelection(lists, selBar)),
    });
    if (kind !== "staged") {
      items.push({ separator: true });
      items.push({
        label: "Discard Changes", icon: "discard",
        onClick: () => {
          void confirmDialog({
            title: "Discard changes?",
            message: `Discard your changes to ${f.path}? This can't be undone.`,
            confirmLabel: "Discard",
            danger: true,
          }).then((ok) => {
            if (ok) void this.changesAction("discard", f.path);
          });
        },
      });
    }
    return items;
  }

  /** The row menu when several rows are selected. Counts are files, not rows. */
  private multiRowMenu(lists: HTMLElement, selBar: HTMLElement): MenuItem[] {
    const entries = this.selectionEntries();
    const paths = this.selectionPaths();
    const noun = (n: number) => (n === 1 ? "1 File" : `${n} Files`);
    const stageable = entries.filter((e) => e.kind !== "staged");
    const unstageable = entries.filter((e) => e.kind === "staged");

    const items: MenuItem[] = [
      {
        label: `Stash ${noun(paths.length)}`, icon: "archive",
        onClick: () => void this.stashPaths(paths).then(() => this.clearSelection(lists, selBar)),
      },
      { separator: true },
    ];
    if (stageable.length > 0) {
      items.push({
        label: `Stage ${noun(stageable.length)}`, icon: "add",
        onClick: () => void this.bulkAction("stage", stageable.map((e) => e.path), lists, selBar),
      });
    }
    if (unstageable.length > 0) {
      items.push({
        label: `Unstage ${noun(unstageable.length)}`, icon: "remove",
        onClick: () => void this.bulkAction("unstage", unstageable.map((e) => e.path), lists, selBar),
      });
    }
    const discardable = entries.filter((e) => e.kind === "unstaged").map((e) => e.path);
    if (discardable.length > 0) {
      items.push({ separator: true });
      items.push({
        label: `Discard ${noun(discardable.length)}`, icon: "discard",
        onClick: () => {
          void confirmDialog({
            title: "Discard changes?",
            message:
              discardable.length === 1
                ? `Discard your changes to ${discardable[0]}? This can't be undone.`
                : `Discard your changes to ${discardable.length} files? This can't be undone.`,
            confirmLabel: "Discard",
            danger: true,
          }).then((ok) => {
            if (ok) void this.bulkAction("discard", discardable, lists, selBar);
          });
        },
      });
    }
    return items;
  }

  /**
   * Apply one staging action to several paths, repainting ONCE at the end.
   *
   * changesAction repaints per call, so looping it over ten files rebuilds the
   * view ten times — visibly, and with the list jumping under the cursor.
   */
  private async bulkAction(
    channel: "stage" | "unstage" | "discard",
    paths: string[],
    lists: HTMLElement,
    selBar: HTMLElement,
  ): Promise<void> {
    let failed = 0;
    for (const path of paths) {
      const r = await host.invoke(channel, path);
      if (!r.ok) failed++;
    }
    if (failed > 0) {
      toast(failed === paths.length ? "Nothing could be applied." : `${failed} of ${paths.length} failed.`, "error");
    }
    this.clearSelection(lists, selBar);
    bust("status");
    bust("diff");
    void this.showChangesView();
  }

  /** Stash the given paths, then refresh. Empty means the whole tree. */
  private async stashPaths(paths: string[]): Promise<void> {
    const r = await host.invoke("stash:save", { paths, message: undefined });
    if (!r.ok) {
      toast(r.message ?? "Could not stash.", r.expected ? "info" : "error");
      return;
    }
    toast(paths.length === 1 ? "Stashed 1 file." : `Stashed ${paths.length} files.`);
    bust("status");
    bust("diff");
    void this.showChangesView();
  }

  private async changesAction(
    channel: "stage" | "unstage" | "discard" | "stageAll" | "unstageAll",
    path: string | undefined,
  ): Promise<void> {
    try {
      const r =
        channel === "stageAll"
          ? await host.invoke("stageAll", undefined)
          : channel === "unstageAll"
            ? await host.invoke("unstageAll", undefined)
            : await host.invoke(channel, path ?? "");
      if (!r.ok) {
        const verb =
          channel === "stageAll" ? "stage all changes"
          : channel === "unstageAll" ? "unstage all changes"
          : `${channel} ${path ?? ""}`.trim();
        toast(r.message || `Couldn't ${verb}.`, "error");
      }
    } catch (e) {
      toast(cleanErr(e) || "The operation failed.", "error");
    }
    bust("status");
    bust("diff");
    if (this.currentView === "changes") void this.showChangesView();
  }

  private async doDesktopCommit(
    textarea: HTMLTextAreaElement,
    btn: HTMLElement,
    push: boolean,
    opts?: { amend?: boolean; signoff?: boolean; coAuthors?: string[] },
  ): Promise<void> {
    let message = textarea.value.trim();
    if (!message) {
      textarea.focus();
      return;
    }
    // Append trailers: co-authors first, then a Signed-off-by line if requested.
    const trailers: string[] = [];
    for (const ca of opts?.coAuthors ?? []) {
      if (ca.trim()) trailers.push(`Co-authored-by: ${ca.trim()}`);
    }
    if (opts?.signoff) {
      try {
        const id = await host.invoke("git:identity", undefined);
        if (id?.name && id?.email) trailers.push(`Signed-off-by: ${id.name} <${id.email}>`);
      } catch {
        /* identity unavailable — skip the sign-off trailer */
      }
    }
    if (trailers.length) message = `${message}\n\n${trailers.join("\n")}`;
    (btn as HTMLButtonElement).disabled = true;
    try {
      // Nothing staged, but there IS work? Offer to commit all of it rather than
      // refusing (issue #16) — VS Code and JetBrains both do this. The
      // confirmation is the point: you see what is about to be included first.
      if (!opts?.amend) {
        const status = await host.invoke("status", undefined);
        const stagedNow = status.filter((f) => f.staged);
        const unstagedNow = status.filter((f) => !f.staged);
        if (stagedNow.length === 0 && unstagedNow.length > 0) {
          const n = unstagedNow.length;
          const yes = await confirmDialog({
            title: `Commit all ${n} changed file${n === 1 ? "" : "s"}?`,
            message:
              "Nothing is staged, so everything currently changed will be included — new files too. " +
              "Stage individually first if you only want some of it.",
            confirmLabel: `Commit all ${n}`,
          });
          if (!yes) {
            (btn as HTMLButtonElement).disabled = false;
            return;
          }
          // Stage for real rather than using commit -a: -a skips untracked files
          // and bypasses the index, so what landed would not match the list.
          const staged = await host.invoke("stageAll", undefined);
          if (!staged.ok) {
            toast(staged.message || "Couldn't stage the changes.", "error");
            (btn as HTMLButtonElement).disabled = false;
            return;
          }
        }
      }
      const r = await host.invoke("commit", { message, amend: opts?.amend });
      if (!r.ok) {
        // `expected` marks a state the user is allowed to be in — nothing staged,
        // a clean tree — so it reads as information, not as a red failure. It is
        // the same flag the crash reporter reads, which keeps the two decisions
        // ("do we report this?" / "does this look like an error?") from drifting.
        toast(r.message || "Commit failed.", r.expected ? "info" : "error");
        // Repaint either way: reaching "nothing is staged" means the list on
        // screen disagreed with the repo, and leaving those rows up would
        // contradict the message we just showed.
        bust("status");
        bust("diff");
        if (this.currentView === "changes") void this.showChangesView();
        return;
      }
      if (push) {
        let p = await host.invoke(
          "sync:push",
          this.syncStatus?.noUpstream ? { setUpstream: true } : undefined,
        );
        // Amending a commit the remote already has leaves the branch diverged,
        // and a plain push is then refused every time. Rather than report a
        // dead end, offer the one thing that can work — with the lease, so a
        // colleague's commits are still safe.
        if (!p.ok && /non-fast-forward|fetch first|behind its remote/i.test(p.message ?? "")) {
          const forced = await confirmDialog({
            title: "Force push?",
            message:
              "The remote still has the version of this commit you rewrote, so a "
              + "normal push was refused. Force pushing uses --force-with-lease, "
              + "which still refuses if someone else has pushed.",
            confirmLabel: "Force push",
            danger: true,
          });
          if (forced) {
            p = await host.invoke("sync:push", { force: true });
          }
        }
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
      // The draft has been spent — do not carry it into the next commit.
      this.composerDraft = { message: "", amend: false, signoff: false, coAuthors: [] };
      bust(); // a commit (± push) touches refs/branches/status/sync/graph
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
    copyBtn.setAttribute("aria-label", "Copy code");
    copyBtn.appendChild(glyph("copy"));
    copyBtn.addEventListener("click", () => void copyText(dc.userCode!, "Code copied."));
    codeRow.append(code, copyBtn);
    // ONE explicit action, nothing automatic. Auto-copying + auto-opening the
    // browser yanked users to GitHub before they'd even read the screen — most
    // didn't know the code was "already on the clipboard". Now the user reads
    // the code, then clicks: the click copies (a real user gesture, so the
    // clipboard write always lands) and opens GitHub. The code stays on screen
    // the whole time for retyping if the clipboard is lost.
    const openBtn = el("button", "btn btn-primary gh-device-open");
    openBtn.append(glyph("link-external"), span("Copy code & open GitHub"));
    openBtn.addEventListener("click", () => {
      void copyText(dc.userCode!, "Code copied — paste it on GitHub.");
      window.open(openUrl, "_blank");
    });
    const status = el("div", "gh-device-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.append(el("div", "spinner"), span("Waiting for you to authorize…"));
    card.append(step, codeRow, openBtn, status);
    flow.replaceChildren(card);

    this.pollDeviceFlow(wrap, dc.deviceCode, dc.interval ?? 5, dc.expiresIn ?? 900, status, signIn, onConnected);
  }

  /** Poll the device-flow token endpoint until authorized / expired / dismissed.
   *  Also polls IMMEDIATELY when the window regains focus: the user authorizes
   *  in the browser and switches back, and the old fixed 5-second cadence made
   *  that moment feel laggy — now success lands the instant they return. */
  private pollDeviceFlow(
    wrap: HTMLElement,
    deviceCode: string,
    interval: number,
    expiresIn: number,
    status: HTMLElement,
    signIn: HTMLElement,
    onConnected: () => void,
  ): void {
    const deadline = Date.now() + expiresIn * 1000;
    let intervalSec = interval;
    let timer = 0;
    let inFlight = false;
    let done = false;
    const cleanup = (): void => {
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
    const fail = (msg: string): void => {
      cleanup();
      status.replaceChildren(span(msg));
      status.classList.add("gh-device-failed");
      // Every failure message says "try again" — the button must be pressable.
      (signIn as HTMLButtonElement).disabled = false;
    };
    const interrupted = (): void => {
      // The settings DOM was detached (view switch) — polling must stop, but
      // the card may be RESTORED from the keep-alive cache later. Leave an
      // actionable message instead of an eternal spinner.
      fail("Sign-in was interrupted — click “Sign in with GitHub” to try again.");
    };
    const tick = async (): Promise<void> => {
      if (done) return;
      if (!wrap.isConnected) {
        interrupted();
        return;
      }
      if (Date.now() > deadline) {
        fail("The code expired. Click “Sign in with GitHub” to try again.");
        return;
      }
      if (inFlight) return; // a focus-poll raced the timer — one at a time
      inFlight = true;
      let r;
      try {
        r = await host.invoke("github:devicePoll", { deviceCode });
      } catch {
        r = { state: "pending" as const };
      } finally {
        inFlight = false;
      }
      if (done) return;
      if (!wrap.isConnected) {
        interrupted();
        return;
      }
      if (r.state === "authorized") {
        cleanup();
        toast(`Signed in as @${r.login}.`, "success");
        onConnected();
        return;
      }
      if (r.state === "denied" || r.state === "expired" || r.state === "error") {
        fail(r.message ?? "Sign-in failed. Try again.");
        return;
      }
      if (r.state === "slow_down") intervalSec += 5;
      timer = window.setTimeout(() => void tick(), intervalSec * 1000);
    };
    const onFocus = (): void => {
      if (done || inFlight) return;
      window.clearTimeout(timer);
      void tick();
    };
    window.addEventListener("focus", onFocus);
    timer = window.setTimeout(() => void tick(), intervalSec * 1000);
  }


  /** The commit graph + a collapsible / drag-resizable commit-details panel. */
  private showGraphView(force = false): void {
    // KEEP-ALIVE: the graph is the most expensive surface in the app, and it
    // used to be torn down and refetched on EVERY tab switch — leave Commits
    // for two seconds and coming back cost a full reload, a loading flash, and
    // your scroll position. The mount owns no Monaco (the diff lives in the
    // dock; the details panel is a plain custom element), so the live DOM can
    // simply be re-attached. `graphDirty` re-syncs data in place when the repo
    // changed underneath while another view was showing.
    if (!force && this.graphViewWrap && this.graph) {
      this.viewHost.replaceChildren(this.graphViewWrap);
      this.detailsEl = this.graphDetailsPane;
      if (this.graphDirty) {
        this.graphDirty = false;
        void this.graph.reload();
      }
      return;
    }
    // Graph LEFT, commit details RIGHT — the same side-by-side arrangement the
    // extension's commit panel uses. Details used to live in the bottom dock,
    // which stacked them under the graph and left the dock competing with the
    // terminal for height.
    const wrap = el("div", "graph-view graph-split");
    const graphHost = el("div", "graph-host graph-host-full");
    const detailsPane = el("div", "graph-details");
    this.graphDetailsPane = detailsPane;
    wrap.append(graphHost, this.graphSplitResizer(wrap), detailsPane);
    this.viewHost.replaceChildren(wrap);
    this.graphViewWrap = wrap;
    this.graphDirty = false;

    this.detailsEl = detailsPane;
    this.showDetailsPlaceholder();

    this.graph?.dispose(); // tear down a prior mount before replacing it
    const graph = new GraphMount(graphHost, {
      onSelect: (sha) => void this.selectCommit(sha),
      onOpen: (sha) => void this.selectCommit(sha),
      onContext: (sha, x, y) => this.contextMenu.open(sha, x, y, this.refsOn(sha)),
      // Ref labels are LINKS now: click a branch/tag chip in the graph and land
      // on that ref in Branches, scrolled + flashed.
      onRefClick: (name) => this.routeView("branches", false, { ref: name }),
      // Show the pane again WITHOUT re-selecting: selectCommit() would call
      // closeGraphDiff() and dispose a diff the user still has open.
      onShowDetails: () => this.setGraphDetailsVisible(true),
      onEmpty: (empty) => this.setDetailsEmptyForNoHistory(empty),
    });
    this.graph = graph;
    void graph.reload();
  }

  /** A branded "coming next" panel for views still being built out. */
  /** Fallback for an unknown view id. Every shipped view has a real builder in
   *  routeView; this only guards against an unrecognized/restored id and never
   *  advertises a finished feature as unbuilt. */
  private showPlaceholderView(id: string): void {
    this.viewHost.replaceChildren(
      errorState("View unavailable", `“${id}” isn’t a known view.`, () => this.routeView("code", true)),
    );
  }

  // ── Sync widget (fetch / pull / push — control remote changes) ──────────────

  private buildSyncWidget(): HTMLElement {
    const wrap = el("div", "topbar-sync");
    const main = el("button", "sync-main");
    const caret = el("button", "sync-caret");
    caret.title = "Sync options";
    caret.setAttribute("aria-label", "Sync options");
    caret.appendChild(glyph("chevron-down"));
    caret.addEventListener("click", () => this.openSyncMenu(caret));
    wrap.append(main, caret);

    this.renderSyncWidget = (s: SyncStatus | undefined): void => {
      main.replaceChildren();
      (main as HTMLButtonElement).disabled = false; // clears doSync's in-flight state
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
    // Paint instantly from the last-known sync state, then refresh.
    const cached = peek("sync:status", undefined);
    if (cached) {
      this.syncStatus = cached;
      this.renderSyncWidget?.(cached);
    }
    this.syncStatus = await gget("sync:status", undefined, 4000);
    this.renderSyncWidget?.(this.syncStatus);
  }

  private async doSync(action: "fetch" | "pull" | "push" | "publish"): Promise<void> {
    if (this.syncing) return; // lock the trigger against double-invocation
    this.syncing = true;
    const widget = document.querySelector(".topbar-sync");
    widget?.classList.add("busy");
    // Live in-flight state: the widget shows WHAT it's doing with a spinning
    // icon ("Pulling… / Pushing…"), not just a dimmed button.
    const main = widget?.querySelector<HTMLButtonElement>(".sync-main");
    if (main) {
      const verbing =
        action === "fetch"
          ? "Fetching…"
          : action === "pull"
            ? "Pulling…"
            : action === "publish"
              ? "Publishing…"
              : "Pushing…";
      main.replaceChildren(glyph("sync"), span(verbing));
      main.querySelector(".glyph")?.classList.add("spin");
      main.disabled = true;
    }
    try {
      const r =
        action === "fetch"
          ? await host.invoke("sync:fetch", { prune: this.pruneOnFetchPref })
          : action === "pull"
            ? await host.invoke("sync:pull", undefined)
            : action === "push"
              ? await host.invoke("sync:push", undefined)
              : await host.invoke("sync:push", { setUpstream: true });
      if (!r.ok) {
        toast(r.message ?? `${action} failed.`, r.expected ? "info" : "error");
        return;
      }
      const verb =
        action === "fetch" ? "Fetched" : action === "pull" ? "Pulled" : action === "publish" ? "Published branch" : "Pushed";
      toast(`${verb} successfully.`, "success");
      bust(); // a fetch/pull/push changes sync/refs/branches/graph
      await this.updateSync();
      await this.refreshAll();
      // Refresh the active data view so its content reflects the sync.
      this.routeView(this.currentView, true);
    } catch (e) {
      toast(cleanErr(e) || `${action} failed.`, "error");
    } finally {
      this.syncing = false;
      document.querySelector(".topbar-sync")?.classList.remove("busy");
      // Restore the widget from its in-flight face (success already repainted
      // it via updateSync; this covers the failure path).
      this.renderSyncWidget?.(this.syncStatus);
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

  /** ⌘K — one fuzzy search over sections, branches/tags, recent repos, open
   *  PRs/issues, and the headline actions. Local groups are instant; the
   *  GitHub groups stream in as they resolve. */
  private openPalette(): void {
    if (!this.currentRepo) return;
    const go = (v: string, t?: SectionTarget): void => this.routeView(v, false, t);
    openCommandPalette({
      local: (): PaletteGroup[] => {
        const views: PaletteItem[] = App.TABS.map((t) => ({
          icon: t.icon,
          label: t.label,
          keywords: t.id,
          run: () => go(t.id),
        }));
        views.push({ icon: "gear", label: "Settings", hint: "view", run: () => go("settings") });

        const refs: PaletteItem[] = [
          ...this.refs
            .filter((r) => r.type === "head")
            .map((r): PaletteItem => ({
              icon: "git-branch",
              label: r.name,
              hint: r.isCurrent ? "current branch" : "branch",
              keywords: `branch ${r.name}`,
              run: () => go("branches", { ref: r.name }),
            })),
          ...this.refs
            .filter((r) => r.type === "tag")
            .map((r): PaletteItem => ({
              icon: "tag",
              label: r.name,
              hint: "tag",
              keywords: `tag ${r.name}`,
              run: () => go("branches", { ref: r.name }),
            })),
        ];

        const actions: PaletteItem[] = [
          { icon: "add", label: "New branch…", run: () => void this.newBranch() },
          {
            icon: "git-pull-request",
            label: "New pull request…",
            run: () => void openCreatePr(() => this.routeView("prs", true)),
          },
          { icon: "issues", label: "New issue…", run: () => void openNewIssue(go) },
          { icon: "sync", label: "Fetch", run: () => void this.doSync("fetch") },
          { icon: "arrow-down", label: "Pull", run: () => void this.doSync("pull") },
          { icon: "arrow-up", label: "Push", run: () => void this.doSync("push") },
          {
            icon: "repo-clone",
            label: "Clone repository…",
            run: () => openCloneDialog((root) => void this.openPath(root)),
          },
          { icon: "folder-opened", label: "Open repository…", run: () => void this.openRepo() },
          { icon: "terminal", label: "Toggle terminal", keywords: "dock shell", run: () => this.toggleTerminal() },
          { icon: "color-mode", label: "Theme: System", keywords: "theme auto", run: () => this.setThemeMode("system") },
          { icon: "color-mode", label: "Theme: Light", keywords: "theme", run: () => this.setThemeMode("light") },
          { icon: "color-mode", label: "Theme: Dark", keywords: "theme", run: () => this.setThemeMode("dark") },
          {
            icon: "cloud-download",
            label: "Check for updates",
            run: () => {
              void host.invoke("update:check", undefined).then((r) => {
                if (r.status === "uptodate") toast(`You're on the latest version (${r.current}).`, "success");
                else if (r.status === "available" && r.version)
                  void this.promptUpdateAvailable({ version: r.version, current: r.current }, true);
                else if (r.message) toast(r.message, "info");
              });
            },
          },
        ];

        return [
          { title: "Go to", items: views },
          { title: "Branches & tags", items: refs },
          { title: "Actions", items: actions },
        ];
      },
      remote: () => {
        // ONE status call shared by every GitHub group. This used to fire
        // three times per palette open — same answer, three round trips.
        const status = host.invoke("github:status", undefined).catch(() => undefined);
        return [
        host
          .invoke("repo:recent", undefined)
          .then((rs): PaletteGroup | undefined => {
            const others = rs.filter((r) => r.root !== this.currentRepo?.root);
            return others.length
              ? {
                  title: "Recent repositories",
                  items: others.map((r) => ({
                    icon: "repo",
                    label: r.name,
                    // Middle-truncated: the right-hand ellipsis ate the repo
                    // folder, which is the only part that tells two clones apart.
                    hint: middleTruncate(r.root, 46),
                    keywords: r.root,
                    run: () => void this.openPath(r.root),
                  })),
                }
              : undefined;
          }),
        status.then(async (st): Promise<PaletteGroup | undefined> => {
          if (!st?.connected || !st.repo) return undefined;
          const prs = await host.invoke("pr:list", undefined).catch(() => []);
          return prs.length
            ? {
                title: "Pull requests",
                items: prs.slice(0, 30).map((pr) => ({
                  icon: "git-pull-request",
                  label: pr.title,
                  hint: `#${pr.number}`,
                  keywords: `#${pr.number} pr ${pr.user?.login ?? ""} ${pr.head.ref}`,
                  run: () => go("prs", { number: pr.number }),
                })),
              }
            : undefined;
        }),
        status.then(async (st): Promise<PaletteGroup | undefined> => {
          if (!st?.connected || !st.repo) return undefined;
          const issues = await host.invoke("issue:list", { state: "open" }).catch(() => []);
          return issues.length
            ? {
                title: "Issues",
                items: issues.slice(0, 30).map((it) => ({
                  icon: "issues",
                  label: it.title,
                  hint: `#${it.number}`,
                  keywords: `#${it.number} issue ${it.user?.login ?? ""}`,
                  run: () => go("issues", { number: it.number }),
                })),
              }
            : undefined;
        }),
        ];
      },

      // ── query-driven: global GitHub search, from ⌘K ──
      //
      // The pinned row is always first and always fires, so ⌘K → type →
      // Enter reaches Explore even when nothing else matched. The two result
      // groups share Explore's EXACT gget cache keys, so opening the full
      // page after previewing here costs nothing — and code search is never
      // called from the palette (10/min is too small to spend on typing).
      search: (query: string) => [
        Promise.resolve<PaletteGroup>({
          title: "Search GitHub",
          pinned: true,
          items: [
            {
              icon: "telescope",
              label: `Search GitHub for “${query}”`,
              hint: "Explore",
              run: () => go("explore", { id: searchTargetId("repos", query) }),
            },
          ],
        }),
        gget("search:repos", { query, sort: "best", page: 1 }, 60_000)
          .then((page): PaletteGroup | undefined =>
            page.items.length
              ? {
                  title: "Repositories on GitHub",
                  pinned: true,
                  items: page.items.slice(0, 3).map((r) => ({
                    icon: "repo",
                    label: r.fullName,
                    hint: r.language ?? "",
                    run: () => go("explore", { id: repoRouteId({ fullName: r.fullName }) }),
                  })),
                }
              : undefined,
          )
          .catch(() => undefined),
        gget("search:users", { query, kind: "users", page: 1 }, 60_000)
          .then((page): PaletteGroup | undefined =>
            page.items.length
              ? {
                  title: "People on GitHub",
                  pinned: true,
                  items: page.items.slice(0, 3).map((u) => ({
                    icon: "person",
                    label: u.login,
                    hint: u.type === "Organization" ? "org" : "person",
                    run: () =>
                      go("explore", {
                        id: `${u.type === "Organization" ? "org" : "user"}/${u.login}`,
                      }),
                  })),
                }
              : undefined,
          )
          .catch(() => undefined),
      ],
    });
  }

  private topbar(info: RepoInfo): HTMLElement {
    const bar = el("header", "topbar");

    // Sidebar toggle — a flat icon at the far left (above the rail), the way
    // VS Code / Linear do it. Seamless, no floating handle on the divider.
    const sidebarToggle = el("button", "topbar-icon topbar-sidebar");
    sidebarToggle.addEventListener("click", () => this.toggleRail());
    this.railToggleEl = sidebarToggle;

    const home = el("button", "topbar-home");
    home.title = "Back to main menu";
    home.setAttribute("aria-label", "Back to main menu");
    home.appendChild(brandMark());
    home.addEventListener("click", () => void this.backToMenu());

    // Back / forward chevrons — the in-app history walkers (⌘[ / ⌘], and the
    // mouse's back/forward buttons). What makes section-hopping feel like a
    // real app instead of a set of disconnected tabs.
    const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
    const backBtn = el("button", "topbar-icon topbar-nav") as HTMLButtonElement;
    backBtn.title = `Back  (${mod}[)`;
    backBtn.setAttribute("aria-label", "Back");
    backBtn.appendChild(glyph("arrow-left"));
    backBtn.addEventListener("click", () => this.navBack());
    this.navBackBtn = backBtn;
    const fwdBtn = el("button", "topbar-icon topbar-nav") as HTMLButtonElement;
    fwdBtn.title = `Forward  (${mod}])`;
    fwdBtn.setAttribute("aria-label", "Forward");
    fwdBtn.appendChild(glyph("arrow-right"));
    fwdBtn.addEventListener("click", () => this.navForward());
    this.navFwdBtn = fwdBtn;
    this.updateNavButtons();

    const repoSwitch = el("button", "topbar-switch");
    const repoName = el("span", "switch-name");
    repoName.textContent = info.name;
    this.repoSwitchName = repoName;
    repoSwitch.append(glyph("folder"), repoName, glyph("chevron-down"));
    repoSwitch.title = info.root;
    repoSwitch.addEventListener("click", () => void this.openRepoMenu(repoSwitch));

    const branchSwitch = el("button", "topbar-switch topbar-branch");
    const branchName = el("span", "switch-name");
    branchName.textContent = "…";
    this.branchSwitchName = branchName;
    branchSwitch.append(glyph("git-branch"), branchName, glyph("chevron-down"));
    branchSwitch.addEventListener("click", () => this.openBranchMenu(branchSwitch));

    // Left cluster: brand + repo + branch, with the sync (fetch/pull/push)
    // widget sitting right next to the branch switcher.
    const left = el("div", "topbar-left");
    left.append(home, sidebarToggle, backBtn, fwdBtn, repoSwitch, branchSwitch, this.buildSyncWidget());
    this.syncRailToggle();

    // Right edge: the notifications center (bell + unread badge) sitting right
    // next to the GitHub account chip — both pinned to the far right of the bar.
    const right = el("div", "topbar-right");
    const cmdk = el("button", "topbar-cmdk");
    // The palette now searches GitHub itself, so the affordance says so —
    // "Jump to…" undersold a box that reaches every repo on github.com.
    cmdk.title = "Jump anywhere, or search GitHub  (⌘K)";
    cmdk.setAttribute("aria-label", "Open the command palette");
    cmdk.append(
      glyph("search"),
      span("Search anything…", "topbar-cmdk-label"),
      span("⌘K", "topbar-cmdk-kbd"),
    );
    cmdk.addEventListener("click", () => this.openPalette());
    right.append(cmdk, this.buildAssistantLauncher(), this.buildNotifBell(), this.buildAccountChip());

    bar.append(left, right);
    return bar;
  }

  /** The Assistant launcher — a sparkle button in the top bar, reachable from any
   *  view. Opens the full Assistant (its chats persist + stay warm). */
  private buildAssistantLauncher(): HTMLElement {
    const b = el("button", "topbar-icon topbar-assistant");
    b.title = "Assistant";
    b.setAttribute("aria-label", "Open the AI Assistant");
    b.append(glyph("sparkle"), span("Assistant", "topbar-assistant-label"));
    b.addEventListener("click", () => this.routeView("assistant"));
    return b;
  }

  /** The notifications center: a bell in the top bar (next to the account chip)
   *  with an unread-count badge, opening the inbox as a floating panel. Replaces
   *  the old sidebar "Notifications" section — the bell IS the center now. */
  private buildNotifBell(): HTMLElement {
    const bell = el("button", "topbar-icon topbar-bell");
    bell.title = "Notifications";
    bell.setAttribute("aria-label", "Notifications");
    bell.appendChild(glyph("bell"));
    const badge = el("span", "topbar-bell-badge");
    badge.hidden = true;
    bell.appendChild(badge);
    this.notifBellBadge = badge;
    bell.addEventListener("click", () =>
      openNotificationsPanel(
        bell,
        (v, target) => this.routeView(v, false, target),
        () => void this.refreshNotifBadge(),
      ),
    );
    void this.refreshNotifBadge();
    return bell;
  }

  /** Pull the unread count and reflect it on the bell badge (hidden at zero). */
  private async refreshNotifBadge(): Promise<void> {
    const badge = this.notifBellBadge;
    if (!badge) return;
    const count = await fetchUnreadCount();
    if (!badge.isConnected) return;
    const bell = badge.parentElement;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = false;
      bell?.classList.add("has-unread");
      bell?.setAttribute("title", `Notifications · ${count} unread`);
    } else {
      badge.hidden = true;
      bell?.classList.remove("has-unread");
      bell?.setAttribute("title", "Notifications");
    }
  }

  /** The single GitHub-account affordance, pinned to the right edge of the top
   *  bar. Shows the signed-in user (avatar + login, no "@"), or a Sign-in prompt
   *  when not connected. Replaces the per-view account chips that used to clutter
   *  every GitHub section header. */
  private buildAccountChip(): HTMLElement {
    const chip = el("button", "topbar-acct");
    chip.append(glyph("github"), span("…", "topbar-acct-name"));
    chip.addEventListener("click", () => this.routeView("settings"));
    void (async () => {
      let status: GitHubStatus = { connected: false };
      try {
        status = await host.invoke("github:status", undefined);
      } catch {
        /* offline / not connected — show the sign-in state */
      }
      if (!chip.isConnected) return;
      if (status.connected && status.login) {
        chip.classList.add("is-connected");
        chip.title = `Signed in to GitHub as ${status.login}`;
        chip.replaceChildren(
          avatar(status.login, `https://github.com/${status.login}.png`, 22),
          span(status.login, "topbar-acct-name"),
        );
      } else {
        chip.classList.remove("is-connected");
        chip.title = "Sign in to GitHub";
        chip.replaceChildren(glyph("github"), span("Sign in", "topbar-acct-name"));
      }
    })();
    return chip;
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
    // Forgetting or trashing a clone changes the welcome screen's recent list
    // (and the repo switcher, which re-reads on open) — repaint the one surface
    // that renders it eagerly, and only when it's actually showing.
    host.on("repo:recentChanged", () => {
      if (!this.currentRepo) void this.showWelcome();
    });
    host.on("app:notice", (n) => {
      toast(n.message, n.kind === "error" ? "error" : n.kind === "warn" ? "error" : "info");
    });
    // Something changed on disk (issue #17). Already debounced in main.
    host.on("repo:filesChanged", (info) => {
      void this.refreshFromDisk(info?.gitDir ?? true);
    });
    // And when the window comes back to the front. This is the reported flow —
    // edit in another app, switch to GitStudio — and it is also the safety net
    // for when the watcher could not start at all (a huge tree on Linux can
    // exhaust inotify), so it deliberately does not check whether one is running.
    window.addEventListener("focus", () => {
      void this.refreshFromDisk(true);
    });
    host.on("menu:command", (msg) => {
      if (msg.command === "openRepo") void this.openRepo();
      else if (msg.command === "refresh") void this.refreshAll();
      else if (msg.command === "closeRepo") void this.backToMenu();
      else if (msg.command === "toggleTerminal") this.toggleTerminal();
      else if (msg.command === "cloneRepo") openCloneDialog((root) => void this.openPath(root));
    });
    // App updates: the main process polls; the USER decides. Nothing downloads
    // or installs without a confirm here.
    host.on("update:available", (u) => void this.promptUpdateAvailable(u));
    host.on("update:ready", (r) => void this.promptUpdateReady(r));
    host.on("update:progress", (p) => {
      if (this.updateProgressEl) this.updateProgressEl.textContent = `Downloading… ${p.percent}%`;
    });
  }

  // ── App updates (confirm → pull → apply) ────────────────────────────────────

  /** Live label updated by update:progress while a download runs (the About
   *  card's status line when Settings is open; harmlessly detached otherwise). */
  private updateProgressEl?: HTMLElement;
  /** Versions the user already saw a prompt for this session. */
  private readonly updatePrompted = new Set<string>();

  private async promptUpdateAvailable(
    u: { version: string; current: string },
    force = false,
  ): Promise<void> {
    if (!force && this.updatePrompted.has(u.version)) return;
    this.updatePrompted.add(u.version);
    const mac = navigator.platform.toLowerCase().includes("mac");
    const ok = await confirmDialog({
      title: `GitStudio ${u.version} is available`,
      message: mac
        ? `You're on ${u.current}. Download the update now? The installer lands in your Downloads folder — one drag to Applications finishes it.`
        : `You're on ${u.current}. Download the update now? You'll confirm again before it restarts.`,
      confirmLabel: "Download update",
    });
    if (!ok) return;
    const r = await host.invoke("update:download", undefined);
    if (!r.ok) {
      toast(r.message || "Couldn't download the update.", "error");
      return;
    }
    toast(`Downloading GitStudio ${u.version}…`, "info");
  }

  private async promptUpdateReady(r: {
    version: string;
    kind: "restart" | "installer";
  }): Promise<void> {
    if (this.updateProgressEl) this.updateProgressEl.textContent = "";
    if (r.kind === "restart") {
      const ok = await confirmDialog({
        title: `GitStudio ${r.version} is ready`,
        message: "Restart now to finish updating? If not, it's applied the next time you quit.",
        confirmLabel: "Restart now",
      });
      if (!ok) {
        toast("The update will be applied when you quit GitStudio.", "info");
        return;
      }
    } else {
      const ok = await confirmDialog({
        title: `GitStudio ${r.version} downloaded`,
        message:
          "The installer is in your Downloads folder. Open it now? Drag GitStudio to Applications to finish.",
        confirmLabel: "Open installer",
      });
      if (!ok) return;
    }
    const res = await host.invoke("update:install", undefined);
    if (!res.ok) toast(res.message || "Couldn't apply the update.", "error");
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

  /**
   * Repaint after something changed on disk outside the app (issue #17).
   *
   * `gitDir` splits the cost. A file edit can only change the working tree, so
   * there is no point re-reading refs or reloading the graph for it — during a
   * build that would mean a graph reload every quarter second. A change under
   * `.git` (a commit, a checkout, staging from the terminal) really can move
   * history, and gets the full refresh.
   *
   * Never runs while a mutation of our own is in flight: our own commands already
   * refresh when they finish, and refreshing underneath them makes the list flicker
   * between two truths.
   */
  /**
   * The refs sitting on one commit, for the graph's context menu (issues #12/#19).
   *
   * `origin/HEAD` is dropped: it is a symbolic pointer at the remote's default
   * branch, so "Checkout origin/HEAD" would put you on a detached HEAD at
   * whatever it happens to point to — never what someone means. The sidebar's
   * ref sections filter it out for the same reason.
   */
  private refsOn(
    sha: string,
  ): Array<{ name: string; kind: "head" | "remote" | "tag"; current?: boolean }> {
    return this.refs
      .filter((r) => r.sha === sha && r.type !== "stash" && !r.name.endsWith("/HEAD"))
      .map((r) => ({
        name: r.name,
        kind: r.type === "remote" ? "remote" : r.type === "tag" ? "tag" : "head",
        current: r.isCurrent,
      }));
  }

  private async refreshFromDisk(gitDir: boolean): Promise<void> {
    if (!this.currentRepo || this.refreshingFromDisk) {
      return;
    }
    this.refreshingFromDisk = true;
    try {
      if (gitDir) {
        await this.refreshAll();
        return;
      }
      bust("status");
      bust("diff");
      if (this.currentView === "changes") {
        await this.showChangesView();
      } else if (this.currentView === "graph" && this.graph) {
        // The graph carries an uncommitted-changes row, so it still cares — but
        // only about that row. Reload IN PLACE: rebuilding the whole view here
        // (the old behavior) threw away the live mount on every disk change.
        await this.graph.reload();
      } else if (this.graph) {
        // Parked graph: its WIP row is stale now — re-sync on return.
        this.graphDirty = true;
      }
    } finally {
      this.refreshingFromDisk = false;
    }
  }

  private async refreshAll(): Promise<void> {
    if (!this.currentRepo) {
      return;
    }
    bust(); // drop the SWR cache so the re-render pulls fresh data
    // …and the kept-alive view DOM with it. routeView(force) only drops the view
    // being rebuilt, so a commit or a branch op made from Changes left the cached
    // Branches DOM untouched — and returning to it re-attached that DOM verbatim
    // without refetching, showing a branch list from before the change.
    this.viewCache.clear();
    // A parked (kept-alive) graph is now stale too — mark it before ANY early
    // return below, so returning to Commits always re-syncs in place.
    if (this.graph && this.currentView !== "graph") this.graphDirty = true;
    await this.refreshRefs();
    // Settings shows NOTHING derived from the repo's disk state — and this runs
    // on every window FOCUS. Rebuilding it here destroyed the GitHub device-flow
    // card the instant the user came back from authorizing in the browser: the
    // code vanished and the token poll died, so sign-in could never complete.
    if (this.currentView === "settings") {
      return;
    }
    // The graph reloads in place when showing; when it's PARKED (kept alive
    // behind another view) it's only marked dirty, so returning to Commits
    // re-syncs the data without ever tearing the mount down.
    if (this.currentView === "graph" && this.graph) {
      await this.graph.reload();
    } else {
      this.routeView(this.currentView, true);
    }
  }

  // ── Top-bar dropdowns (repo switcher + branch switcher) ─────────────────────

  private async openRepoMenu(anchor: HTMLElement): Promise<void> {
    const recent = await host.invoke("repo:recent", undefined);
    const items: MenuItem[] = [
      {
        label: "Open repository…",
        icon: "folder-opened",
        onClick: () => void this.openRepo(),
      },
      {
        label: "Clone repository…",
        icon: "cloud-download",
        onClick: () => openCloneDialog((root) => void this.openPath(root)),
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
          sub: middleTruncate(r.root, 40),
          icon: "folder",
          onClick: () => void this.openPath(r.root),
        });
      }
    }
    items.push({ separator: true });
    items.push({
      label: "Manage repositories…",
      icon: "repo",
      onClick: () => this.routeView("settings", true),
    });
    items.push({
      label: "Back to the main menu",
      icon: "home",
      onClick: () => void this.backToMenu(),
    });
    openMenu(anchor, items);
  }

  /** Jump to a commit in the graph, switching to the graph view first if the
   *  graph isn't currently mounted (the branch switcher is available on every
   *  screen, so `this.graph` may not exist yet). Routing with a sha TARGET puts
   *  the jump in the navigation history, so back/forward reproduces it. */
  private revealInGraph(sha: string): void {
    if (this.currentView === "graph" && this.graph) {
      this.graph.reveal(sha);
      void this.selectCommit(sha);
      return;
    }
    this.routeView("graph", false, { sha });
  }

  /** Scroll to + select a commit once the freshly-mounted graph has rows. The
   *  graph loads its first page asynchronously, so retry briefly — reveal is a
   *  no-op until the row exists. The details pane loads immediately (it's
   *  IPC-driven, not row-driven). */
  private revealWhenReady(sha: string): void {
    void this.selectCommit(sha);
    let tries = 0;
    const tryReveal = (): void => {
      this.graph?.reveal(sha);
      if (++tries < 6 && this.currentView === "graph") {
        window.setTimeout(tryReveal, 120);
      }
    };
    requestAnimationFrame(tryReveal);
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
          onClick: () => this.revealInGraph(b.sha),
        });
      }
    }
    if (remotes.length) {
      items.push({ separator: true, label: "Remotes" });
      // No cap. This menu used to slice to 16 with NO indication, and its
      // type-to-filter only hides rows that were already built — so anything
      // past the 16th was unreachable by any means, including search.
      for (const b of remotes) {
        items.push({
          label: b.name,
          icon: "cloud",
          onClick: () => this.revealInGraph(b.sha),
        });
      }
    }
    if (tags.length) {
      items.push({ separator: true, label: "Tags" });
      // for-each-ref returns refname (byte) order, which puts v1.10 BELOW v1.9
      // and meant the old 16-item cap kept the oldest tags. Numeric-aware
      // descending, matching the extension's branch dialog.
      const tagsSorted = [...tags].sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      );
      for (const t of tagsSorted) {
        items.push({
          label: t.name,
          icon: "tag",
          onClick: () => this.revealInGraph(t.sha),
        });
      }
    }
    if (items.length === 0) {
      items.push({ label: "No branches yet", disabled: true });
    }
    // No `searchable` override: openMenu already turns the filter on above 9
    // rows, which every repo large enough to need it will exceed.
    openMenu(anchor, items);
  }

  // ── Refs / HEAD (drives the branch switcher) ────────────────────────────────

  private async refreshRefs(): Promise<void> {
    // Whose refs are these? Twelve call sites reach this, and a repo switch does
    // not cancel one already in flight — so if the OUTGOING repo's request settles
    // after the incoming one, `this.refs` and the top-bar branch label end up
    // showing the repo you just left. Most likely when the old repo is large and
    // cold and the new one is small.
    //
    // The cache's epoch guard is not enough on its own: it stops a superseded
    // value being CACHED, but the pending promise still resolves with it here.
    const gen = this.routeGen;
    // Cached: refs/head change rarely between view switches, so reuse a recent
    // result instead of re-running git on every navigation.
    const [refs, head] = await Promise.all([
      gget("refs:list", undefined),
      gget("head:get", undefined),
    ]);
    if (gen !== this.routeGen) {
      return; // a different repo is on screen now
    }
    this.refs = refs;
    if (this.branchSwitchName) {
      const label = !head
        ? "HEAD"
        : head.detached
          ? `detached @ ${head.sha.slice(0, 7)}`
          : (head.branch ?? "HEAD");
      this.branchSwitchName.textContent = label;
      // The name truncates in the slim bar — expose the full ref as a tooltip.
      const sw = this.branchSwitchName.closest(".topbar-switch") as HTMLElement | null;
      if (sw) sw.title = head?.detached ? `Detached HEAD at ${head.sha.slice(0, 12)}` : `On branch ${label} — switch branch`;
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
    // Tear down the previous commit's diff editor — it's lazily re-created only
    // when a file is opened (creating Monaco on every commit click is what made
    // this panel lag).
    this.diffPanel?.dispose();
    this.diffPanel = undefined;
    this.activeMonacoView = undefined;

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
      void copyText(detail.text, "Copied.");
    });
    panel.addEventListener("gs-action", (e) => {
      const detail = (e as CustomEvent).detail as { id: string; sha: string };
      void this.runDetailsAction(detail.id, detail.sha);
    });
    // Parent-sha chips: jump the graph to the parent and inspect it.
    panel.addEventListener("gs-reveal", (e) => {
      const detail = (e as CustomEvent).detail as { sha: string };
      this.graph?.reveal(detail.sha);
      void this.selectCommit(detail.sha);
    });
    // "in N branches" — the same lazy containment query the extension runs.
    // Without this the control would spin forever on desktop.
    panel.addEventListener("gs-contains", (e) => {
      const detail = (e as CustomEvent).detail as { sha: string };
      void (async () => {
        try {
          const r = await host.invoke("refs:contains", { sha: detail.sha });
          panel.setContains(detail.sha, r.branches, r.truncated);
        } catch {
          panel.setContains(detail.sha, [], false);
        }
      })();
    });
    // The panel's Close (X) button + its Esc affordance emit gs-close; collapse
    // the details dock (mirrors the extension webview, which handles gs-close in
    // graph/main.ts). Without this the visible Close control is dead on desktop.
    panel.addEventListener("gs-close", () => {
      this.setGraphDetailsVisible(false);
    });

    // The file diff mounts INTO this split (`.details-diff`, see openFile),
    // so the whole commit — metadata, files, editor — lives in ONE place.
    wrap.append(panel);

    if (!this.detailsEl) return;
    this.detailsEl.replaceChildren(wrap);
    // Selecting another commit makes any open diff stale — it belonged to the
    // previous commit's file. Drop the tab rather than leaving the wrong diff up.
    this.closeGraphDiff();
    // Make sure the details column beside the graph is showing.
    this.setGraphDetailsVisible(true);
  }


  /** Tear down the in-view commit diff: dispose the editor, drop the pane,
   *  give the graph its width back. */
  private closeGraphDiff(): void {
    this.diffPanel?.dispose();
    this.diffPanel = undefined;
    if (this.activeMonacoView) {
      this.activeMonacoView = undefined;
    }
    this.diffSurfaceEl = undefined;
    this.graphViewWrap?.classList.remove("diff-open");
    this.detailsEl?.querySelector(".details-diff")?.remove();
  }

  /** Show/hide the commit-details column beside the graph. */
  private setGraphDetailsVisible(visible: boolean): void {
    const wrap = this.graphDetailsPane?.parentElement;
    if (!wrap) return;
    wrap.classList.toggle("details-hidden", !visible);
  }

  /**
   * The drag divider between the graph and the commit-details column. Mirrors
   * detailsPaneResizer (which splits details|diff INSIDE the pane); this one
   * splits graph|details. Width persists across sessions.
   */
  private graphSplitResizer(wrap: HTMLElement): HTMLElement {
    const MIN = 320;
    const KEY = "gitstudio.graphDetailsW";
    // The graph drops its Date and SHA columns below 760px (a container query in
    // commit-graph), so the details column must never squeeze it past that —
    // otherwise columns silently vanish and their resize handles go with them.
    // Leave a little headroom above the breakpoint.
    const GRAPH_FLOOR = 800;
    const maxFor = (): number =>
      Math.max(MIN, Math.min(900, Math.round(wrap.getBoundingClientRect().width) - GRAPH_FLOOR));
    const saved = Number(localStorage.getItem(KEY));
    let w = Number.isFinite(saved) && saved > 0 ? saved : 420;
    const apply = (): void => wrap.style.setProperty("--graph-details-w", `${w}px`);
    const setW = (n: number): void => {
      w = Math.min(maxFor(), Math.max(MIN, Math.round(n)));
      apply();
    };
    setW(w); // clamp the restored value against the CURRENT window

    // Re-clamp when the window changes, so narrowing it starves the details
    // column rather than the graph.
    window.addEventListener("resize", () => setW(w));

    const split = el("div", "cmp-vsplit graph-vsplit");
    split.append(el("div", "cmp-vsplit-grip"));
    wireResizerKeys(split, {
      orientation: "vertical",
      label: "Resize the commit details column",
      min: MIN,
      max: maxFor,
      get: () => w,
      set: setW,
      onCommit: () => localStorage.setItem(KEY, String(w)),
    });
    split.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = w;
      document.body.classList.add("resizing-h");
      // Dragging LEFT widens the details column (it is the right-hand pane).
      const move = (ev: PointerEvent): void => setW(startW - (ev.clientX - startX));
      const up = (): void => {
        document.body.classList.remove("resizing-h");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        localStorage.setItem(KEY, String(w));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return split;
  }

  /** Route a details-panel toolbar action to the existing git context menu. */
  private async runDetailsAction(id: string, sha: string): Promise<void> {
    if (id === "interactive-rebase") {
      // The desktop DOES have the visual rebase workspace — it is the Rebase
      // section in the sidebar. This used to toast "isn't available in the
      // desktop app yet", which was stale the moment that view shipped and
      // contradicted a working tab two rows away.
      this.routeView("rebase", true);
      return;
    }
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
    // The diff opens INSIDE the Commits view: the details column widens and
    // the editor sits right beside the commit's file list. It used to open in
    // the bottom dock's "Diff" tab — graph left, details right, diff BOTTOM —
    // three regions for one task, the literal "split screen" complaint.
    const split = this.detailsEl?.querySelector(".details-split") as HTMLElement | null;
    if (!split) return;
    let pane = split.querySelector(".details-diff") as HTMLElement | null;
    if (!pane) {
      pane = el("div", "details-diff");
      const head = el("div", "details-diff-head");
      head.append(glyph(fileIcon(file.path.split("/").pop() ?? "")), el("span", "details-diff-name"));
      const close = el("button", "peek-nav-btn details-diff-close");
      close.title = "Close diff";
      close.setAttribute("aria-label", "Close diff");
      close.appendChild(glyph("close"));
      close.addEventListener("click", () => this.closeGraphDiff());
      head.appendChild(close);
      const surface = el("div", "details-diff-surface");
      pane.append(head, surface);
      split.appendChild(pane);
      this.diffSurfaceEl = surface;
    }
    const nameEl = pane.querySelector(".details-diff-name") as HTMLElement;
    nameEl.textContent = file.path;
    nameEl.title = file.path;
    // Widen the details side so the editor has real room; the graph yields.
    this.graphViewWrap?.classList.add("diff-open");
    if (!this.diffPanel && this.diffSurfaceEl) {
      this.diffPanel = new DiffPanel(this.diffSurfaceEl);
      this.activeMonacoView = this.diffPanel;
    }
    // Capture the panel — re-reading `this.diffPanel` after an await threw
    // "cannot read showDiff of undefined" when the user picked another commit
    // mid-load and the panel was disposed. `gen` discards a stale result rather
    // than painting it over the newer selection.
    const panel = this.diffPanel;
    if (!panel) return;
    const gen = ++this.diffGen;
    const diff = await host.invoke("file:diff", { path: file.path, sha });
    if (gen !== this.diffGen || panel !== this.diffPanel) return;
    if (!diff) {
      panel.showEmpty("No diff available.");
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", file.path);
      if (gen !== this.diffGen || panel !== this.diffPanel) return;
      if (model) {
        panel.showMerge(model);
        return;
      }
    }
    panel.showDiff(diff);
  }

  private showDetailsPlaceholder(): void {
    if (!this.detailsEl) return;
    const wrap = el("div", "details details-empty");
    wrap.appendChild(
      this.currentRepo
        ? emptyState("Commit details", "Select a commit to inspect its message, author, and changed files.", {
            icon: "git-commit",
          })
        : emptyState("No repository open", "Open a repository to start exploring its history.", {
            icon: "repo",
          }),
    );
    this.detailsEl.replaceChildren(wrap);
  }

  /** With no commits there is nothing to select, so the details pane must not
   *  sit beside "No commits yet" telling you to select one — two competing
   *  empty states, the second contradicting the first. */
  private setDetailsEmptyForNoHistory(noHistory: boolean): void {
    this.graphViewWrap?.classList.toggle("graph-no-history", noHistory);
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
        toast(
          result.message ?? `Couldn't ${req.action.replace(/-/g, " ")}.`,
          result.expected ? "info" : "error",
        );
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
        bust();
        await this.refreshAll();
      }
    } catch (e) {
      toast(cleanErr(e) || "The action failed.", "error");
    }
  }
}

const PREFS_KEY = "gitstudio.ui.prefs";

/** The "?" keyboard cheat sheet — every shortcut the app answers to, grouped
 *  the way the muscle memory works: global chrome, lists, detail pages. */
function openShortcutsHelp(): void {
  const mac = navigator.platform.toLowerCase().includes("mac");
  const mod = mac ? "⌘" : "Ctrl+";
  const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: "Everywhere",
      rows: [
        [`${mod}K`, "Jump anywhere — sections, branches, PRs, actions"],
        [`${mod}1–8`, "Switch between the first eight sections"],
        [`${mod}[  ${mod}]`, "Back / forward through your navigation"],
        [`${mod}\``, "Toggle the terminal dock"],
        [`${mod},`, "Settings"],
        ["?", "This cheat sheet"],
      ],
    },
    {
      title: "Lists",
      rows: [
        ["↑ ↓  or  j k", "Move between rows"],
        ["Enter", "Open the focused row"],
        ["Home / End", "Jump to the first / last row"],
        ["e", "Inbox: mark the focused thread read"],
      ],
    },
    {
      title: "Detail pages",
      rows: [
        ["Esc  or  ←", "Back to the list"],
        [`${mod}Enter`, "Submit the open form / modal"],
      ],
    },
  ];
  openModal((close) => {
    const card = el("div", "modal-card shortcuts-card");
    const h = el("div", "modal-title");
    h.textContent = "Keyboard shortcuts";
    card.appendChild(h);
    const cols = el("div", "shortcuts-cols");
    for (const g of groups) {
      const col = el("div", "shortcuts-group");
      const t = el("div", "shortcuts-group-title");
      t.textContent = g.title;
      col.appendChild(t);
      for (const [keys, what] of g.rows) {
        const row = el("div", "shortcuts-row");
        const k = el("kbd", "shortcuts-keys");
        k.textContent = keys;
        const w = el("span", "shortcuts-what");
        w.textContent = what;
        row.append(k, w);
        col.appendChild(row);
      }
      cols.appendChild(col);
    }
    card.appendChild(cols);
    const actions = el("div", "modal-actions");
    const ok = el("button", "btn btn-primary modal-ok");
    ok.appendChild(span("Done"));
    ok.addEventListener("click", close);
    actions.appendChild(ok);
    card.appendChild(actions);
    return { card, focusEl: ok, label: "Keyboard shortcuts", onClose: () => {} };
  });
}

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
