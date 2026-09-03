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
import { clickIntent, parseRowKey, rangeBetween, reconcile, rowKey, selectionEntries, selectionPaths } from "./selection";
import { installNavStack } from "./navStack";
import { renderCommit } from "./views/commit";
import { renderJobLog } from "./views/jobLog";
import { renderReleaseCompose } from "./views/releaseCompose";
import { renderIssueCompose } from "./views/issueCompose";
import { renderRefDetail } from "./views/refDetail";
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
import { ReadonlyFileView } from "./readonlyFileView";
import { renderMarkdown } from "./markdown";
import { renderAssistant, seedAssistantGoal } from "./assistant";
import { aiModelsCard, agentAccessCard } from "./aiSettings";
import { aiChip, openAssistantTab, registerAssistantTab, streamInto, aiEnabled } from "./aiAssist";
import { toast, confirmDialog, promptInline, openModal } from "./dialogs";
import { TerminalDock } from "./terminalDock";
import { openCloneDialog } from "./cloneDialog";
import { gget, peek, bust, setCacheScope, swr, sameData} from "./cache";
import {
  el,
  span,
  glyph,
  relTime,
  absTime,
  relTimeISO,
  initials,
  avatarHue,
  avatarInk,
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
  markSegment,
  statusWord,
} from "./ui";
import type { MenuItem } from "./ui";
import { plural } from "./textFit";
import { dismissLayers, pageOwnsKeys } from "./overlays";
import { setFocusScope, clearFocusReturn } from "./focusReturn";
import { closePeek } from "./peek";
import type { GitPeekHost } from "./peeks";
import { CommitContextMenu } from "./contextMenu";
import { wireListNav, commitList, ghHeader, searchField, segmented, secRow, facetBar } from "./views/common";
import { resolveRelative, wireProseNav } from "./proseNav";
import { refreshHighlightTheme } from "./highlight";
import { openCommandPalette, paletteIsOpen } from "./commandPalette";
import type { PaletteGroup, PaletteItem } from "./commandPalette";
import type { SectionRender, SectionTarget } from "./views/common";
import type { FacetSpec, FacetState } from "./facetModel";
import { renderIssues, openNewIssue } from "./views/issues";
import { renderMyWork } from "./views/mywork";
import { renderPrs, openCreatePr } from "./views/prs";
import { renderActions } from "./views/actions";
import { renderReleases } from "./views/releases";
import { openNotificationsPanel, fetchUnreadCount, renderNotifications } from "./views/notifications";
import { renderExplore } from "./views/explore";
import { repoRouteId, searchTargetId } from "./exploreRoutes";
import { renderOrgs, setPeekNav } from "./views/orgs";
import { renderProjects } from "./views/projects";
import { renderGists } from "./views/gists";
import { renderRepositories } from "./views/repositories";
import { renderRebase } from "./views/rebase";
import type { CommitDetails as CommitDetailsEl } from "@gitstudio/webview-ui/commit-details";
import { COLUMN_DROP_TAIL_AT } from "@gitstudio/webview-ui/limits";
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
  HeadInfo,
  LocalCopy,
  PrDetail,
  ProjectInfo,
  PullRequest,
  RefInfo,
  GitHubStatus,
  RepoInfo,
  SshKey,
  StashInfo,
  WorktreeInfo,
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
  /** Re-clamps the graph/details split when the pane's box changes. */
  private graphSplitRO?: ResizeObserver;
  /** The top-bar account chip's re-reader, so signing in or out can refresh it. */
  private syncAccountChip?: () => Promise<void>;
  /** The live composer's label writer, so HEAD resolving can refresh it. */
  private syncCommitLabel?: () => void;
  /**
   * What the Changes view had open and where it was scrolled.
   *
   * Every per-row Stage / Unstage / Discard, Stage all, Stash and Refresh ends
   * in `showChangesView()`, which replaces the whole subtree — so the diff you
   * were reading closed, the row you had selected deselected, and the list
   * jumped back to the top. Staging one file in a list of forty meant finding
   * your place again, every single time.
   *
   * Remembered as a row KEY (`kind:path`), never a bare path: a partially-staged
   * file — git's `MM`, a staged edit plus a newer unstaged one — is deliberately
   * TWO rows sharing one path, and only the kind says which half is open.
   */
  private changesOpenKey?: string;
  private changesScroll = 0;
  /** The repo changed while the graph was parked — reload in place on return. */
  private graphDirty = false;
  private diffSurfaceEl?: HTMLElement;
  private repoSwitchName?: HTMLElement;
  private branchSwitchName?: HTMLElement;
  private notifBellBadge?: HTMLElement;
  /** The resolved HEAD from `head:get` — the authoritative answer to "which
   *  branch am I on?", and the one the top bar already uses. */
  private headInfo?: HeadInfo;
  private selectedSha?: string;
  private currentRepo?: RepoInfo;
  private refs: RefInfo[] = [];
  private viewHost!: HTMLElement;
  private navButtons: HTMLElement[] = [];
  /**
   * The view the app opens on before any preference is restored.
   *
   * Not "code". A desktop Git client's first screen should answer a question
   * you actually have when you open it — what have I changed, what is staged,
   * what am I about to commit — and Changes is the surface that does. The file
   * tree answered none of them, and the files are already open in the editor
   * the user just came from.
   *
   * A returning user does not see this at all: `prefs.currentView` puts you
   * back on the surface you were last working in.
   */
  private currentView = "changes";
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
  /** The repo root `composerDraft` was typed in. See showRepoScreen. */
  private composerDraftRoot?: string;
  private composerDraft: {
    message: string;
    amend: boolean;
    signoff: boolean;
    coAuthors: string[];
    /**
     * The text Amend PUT in the box, so un-ticking can tell "the previous
     * commit's message, untouched" from "something the user wrote".
     *
     * This lived as a render-local `let` while every sibling piece of composer
     * state lived here — so the withdrawal only worked inside a single render.
     * Every stage, unstage, discard, stash, Refresh, route change and
     * filesystem-watcher tick rebuilds the composer, which means the guard was
     * almost never in force: tick Amend to look at the last message, change your
     * mind, untick, and the box kept the previous commit's message while the
     * toggle, the button label and the branch line all returned to the
     * new-commit shape. Committing then duplicated someone else's subject.
     */
    prefilled?: string;
    /** Where the caret was, so a rebuild can put it back. */
    caret?: { start: number; end: number };
  } = { message: "", amend: false, signoff: false, coAuthors: [] };
  /** A pending deep-link target for the next section mount (e.g. an issue number
   *  to open from the project board). Consumed + cleared by mountSection. */
  private sectionTarget?: SectionTarget;
  /** In-app navigation history — every routed view (with its deep-link target)
   *  lands here so ⌘[/⌘] and the top-bar chevrons walk back/forward like a real
   *  app. Reset on repo switch (entries would point into the previous repo). */
  private navHistory: Array<{ view: string; target?: SectionTarget; label?: string }> = [];
  private navPos = -1;
  /** True while back/forward drives routeView, so the travel isn't re-recorded. */
  private navTravel = false;
  private navBackBtn?: HTMLButtonElement;
  private navFwdBtn?: HTMLButtonElement;
  /** Current directory inside the Code (repo browser) view; "" = repo root. */
  private codePath = "";
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
  /** Where each kept-alive view was scrolled when it was parked. Keyed by the
   *  node itself, so a rebuilt view never inherits the old one's position. */
  private viewScroll = new WeakMap<HTMLElement, [HTMLElement, number, number, boolean][]>();
  /** Per view root, the elements inside it that have ever been scrolled. */
  private scrolledIn = new WeakMap<HTMLElement, Set<HTMLElement>>();
  /** Views safe to keep alive (no Monaco surface / dispose lifecycle of their own). */
  /** A search that came back rate-limited is a REFUSAL, not an answer — caching
   *  it makes every retry a cache hit for the whole TTL. See cache.gget. */
  private static readonly SEARCH_KEEP = { cacheable: (r: { limited?: unknown }) => !r.limited };

  /** Every scrolled element inside a view, with where it was.
   *
   *  Nested scrollers included, not just the outermost: these views nest them —
   *  a list pane beside a detail pane, a rail beside a log — and restoring only
   *  the outer one puts you back at the top of the part you were reading.
   *
   *  This used to find them by walking the whole view and reading `scrollTop`
   *  on every node, which is a layout read per element: leaving the issues list
   *  cost 10,666 of them, and a nine-view lap of the app cost 11,774. Nothing
   *  in it was wrong — it was just asking five thousand elements a question
   *  only three of them can answer yes to. The scroll handler on the view host
   *  now records the answer as it happens, so this reads only the elements that
   *  have actually been scrolled. Measured with
   *  `node harness/perf.mjs changes --extra=many=1 --repeat=…`. */
  private scrollSnapshot(root: HTMLElement): [HTMLElement, number, number, boolean][] {
    const out: [HTMLElement, number, number, boolean][] = [];
    const seen = this.scrolledIn.get(root);
    if (!seen) return out;
    for (const n of seen) {
      // A node the view has since rebuilt away. Drop it rather than carry it.
      if (!root.contains(n)) {
        seen.delete(n);
        continue;
      }
      // NOT MONACO. It manages its own viewport — partly by transform, partly
      // by scrollTop on nodes it recreates — and restores its position from the
      // model when it is re-attached. Snapshotting those nodes and writing them
      // back afterwards can only fight it, and this harness cannot catch that:
      // with the animation frame starved, Monaco never lays out, so its
      // internal scrollers all read 0 here and it looks harmless.
      if (n.closest(".monaco-editor")) continue;
      if (n.scrollTop > 0 || n.scrollLeft > 0) {
        // …and whether that offset WAS the bottom, which is a different
        // intention from "this many pixels down" for anything still growing.
        const atTail = n.scrollHeight - n.scrollTop - n.clientHeight <= 24;
        out.push([n, n.scrollTop, n.scrollLeft, atTail]);
      }
    }
    return out;
  }

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
    "repositories",
    "notifications",
    "mywork",
  ]);
  /** Whether the working tree has anything to commit. Read by the composer's
   *  enable rule, which used to gate on the message text alone and offered a
   *  live Commit button over a clean tree. */
  private changesHaveWork = false;
  private syncCommitEnabled: (() => void) | undefined;
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
    // Views can pop the history from here on. Before this the only way back
    // from a detail page was a forward navigation dressed as a back button.
    this.installNav();
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
      // A PAGE-LEVEL key, so any open layer outranks it — including the sheet
      // itself. Skipping the text-field check alone let "?" open a second
      // identical sheet over the first (its own first focusable is a button,
      // not a field), and a third, and a fourth — each needing its own Escape.
      // It also fired straight through an open dropdown or dialog.
      if (!pageOwnsKeys()) return;
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
    // `branchCatsCollapsed` is gone with the four collapsible groups it
    // remembered — the Branches view shows ONE kind at a time now. An old
    // stored value is simply ignored rather than migrated; it described a
    // shape that no longer exists.
    if (
      prefs.branchTab === "local" ||
      prefs.branchTab === "remote" ||
      prefs.branchTab === "tags" ||
      prefs.branchTab === "stashes" ||
      prefs.branchTab === "worktrees"
    ) {
      this.branchTab = prefs.branchTab;
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
        // An "auto" dock icon must follow the OS flip too — and so must the
        // Appearance card's preview OF that icon, which is built once and kept.
        this.syncDockIcon();
        this.invalidateAppearanceCard();
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
    open.append(glyph("folder-opened"), span("Open repository…"));
    open.addEventListener("click", () => void this.openRepo());
    const clone = el("button", "btn btn-soft welcome-clone");
    clone.append(glyph("cloud-download"), span("Clone repository…"));
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
        // A ROW holding two controls, not one control containing another: a
        // recent whose folder has been deleted or moved looked exactly like a
        // live one, and there was no way to get rid of it from this screen —
        // the only screen you see when no repository is open. Opening it toasts
        // "not inside a Git repository" and the row stays, forever.
        const rowWrap = el("div", "recent-card-row");
        const row = el("button", "recent-card");
        const meta = el("div", "recent-card-meta");
        const name = el("div", "recent-card-name");
        name.textContent = r.name;
        const path = el("div", "recent-card-path");
        path.textContent = r.root;
        meta.append(name, path);
        row.append(glyph("folder"), meta);
        row.addEventListener("click", () => void this.openPath(r.root));

        const forget = el("button", "recent-card-forget") as HTMLButtonElement;
        forget.appendChild(glyph("close"));
        forget.title = `Forget ${r.name} — the folder itself is not touched`;
        forget.setAttribute("aria-label", forget.title);
        forget.addEventListener("click", (e) => {
          e.stopPropagation();
          void (async () => {
            try {
              await host.invoke("repos:removeRecent", r.root);
            } catch {
              /* the list is rebuilt either way */
            }
            void this.showWelcome();
          })();
        });
        rowWrap.append(row, forget);
        list.appendChild(rowWrap);
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
    // A different repo makes every remembered row meaningless — issue #31 in
    // one repo is not issue #31 in another.
    clearFocusReturn();
    // Baseline the on-disk state for this repo, so the FIRST window focus can
    // tell "nothing changed" from "no idea" and skip a full refresh it does not
    // need. Fire-and-forget: it only has to land before the user alt-tabs.
    void this.recordDiskFingerprint();
    // A half-written commit message belongs to the repo it was typed in — and
    // that is the rule this line USED to break. It reset unconditionally, so
    // "Back to main menu" and straight back into the SAME repo (the recent-repo
    // list is right there, one click away) destroyed the message, and so did
    // every re-open of the repo you were already in. Ask which repo first.
    if (this.composerDraftRoot !== info.root) {
      this.composerDraft = { message: "", amend: false, signoff: false, coAuthors: [], prefilled: undefined, caret: undefined };
      this.composerDraftRoot = undefined;
    }
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
    // Programmatically focusable, not tab-reachable. Closing the terminal dock
    // has to put the keyboard back somewhere in the view, and "the first
    // focusable thing in it" is a lottery — a toolbar button, whatever happens
    // to be first in the DOM. The container itself is the honest answer: Tab
    // then continues from the view rather than from the top of the window.
    viewHost.tabIndex = -1;
    this.viewHost = viewHost;
    // Which elements in a view have been scrolled — recorded as it happens,
    // rather than discovered by asking every node in the view afterwards. See
    // `scrollSnapshot`, which used to be the app's single most expensive
    // operation per route change.
    //
    // Capture, because `scroll` does not bubble; passive, because this never
    // calls preventDefault and saying so keeps it off the scrolling path.
    viewHost.addEventListener(
      "scroll",
      (e) => {
        const node = e.target as HTMLElement | null;
        if (!node || node.nodeType !== 1) return;
        // Attribute it to the view it belongs to — the direct child of the
        // host — so a parked view keeps its own set and drops it when the
        // cached root is dropped.
        let root: HTMLElement | null = node;
        while (root && root.parentElement && root.parentElement !== viewHost) {
          root = root.parentElement;
        }
        if (!root || root.parentElement !== viewHost) return;
        let set = this.scrolledIn.get(root);
        if (!set) {
          set = new Set();
          this.scrolledIn.set(root, set);
        }
        set.add(node);
      },
      { capture: true, passive: true },
    );
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
    // ORDER IS DAILY USE, and the first entry is the one the app opens on when
    // it has no memory of where you were.
    //
    // Code — a read-only file tree of HEAD — held that slot, and it is the one
    // view in this list nothing else in the app ever navigates to: the only two
    // callers of routeView("code") are its own folder hop and the unknown-view
    // fallback. It is also the view a user least needs from a Git client, since
    // the files are already open in their editor. Landing there answered none
    // of the questions you open this app with. It keeps its route and its seat;
    // it just stops being the front door.
    //
    // Five rail entries — Changes, Branches, Rebase, Compare, Pull Requests —
    // used to be five variations on the same fork-with-two-nodes motif, which
    // at 16px in a single column is no icon at all. `git-branch`, `git-compare`
    // and `git-pull-request` have the strongest claim on that shape and keep
    // it (and are separated in the rail); the other two take glyphs that say
    // what those screens actually are.
    //
    // Changes is a set of pending file diffs, not the SCM view's fork.
    { id: "changes", label: "Changes", icon: "diff-multiple" },
    { id: "graph", label: "Commits", icon: "git-commit" },
    { id: "branches", label: "Branches", icon: "git-branch" },
    { id: "compare", label: "Compare", icon: "git-compare" },
    // Rebase here IS an ordered list of commits you reorder and replay — a
    // truer picture than `git-merge`, which is a different operation besides.
    { id: "rebase", label: "Rebase", icon: "list-ordered" },
    { id: "code", label: "Code", icon: "code" },
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
    // Repositories leads the account group: "where is my work" comes before
    // anything you might do inside one of them, and it is the only destination
    // that still means something when no repository is open at all.
    { id: "repositories", label: "Repositories", icon: "repo", divider: true, dividerLabel: "Account" },
    { id: "explore", label: "Explore", icon: "telescope" },
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
        // Collapsed to icons the label is hidden, so the group's name lives on
        // the rule itself.
        sep.title = it.dividerLabel ?? "GitHub";
        sep.setAttribute("role", "separator");
        sep.setAttribute("aria-label", sep.title);
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
      // The TITLE is what the user bubble says — "Analyze #42", not the whole
      // prompt the action builds around the issue body and its comments.
      // Only route if the goal was not taken by an Assistant already on screen.
      // `force: true` drops the view from the cache and rebuilds it, so firing
      // a second ✨ action while the agent was answering the first destroyed
      // the transcript and the Stop button and orphaned the run.
      // NEVER with force when the goal was taken. `force` is what drops the
      // kept-alive mount and rebuilds it — the unforced route re-attaches the
      // same node, with its transcript and its live Stop button intact.
      if (seedAssistantGoal(req.goal, req.title)) this.routeView("assistant", true);
      else this.routeView("assistant");
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
      branchTab: this.branchTab,
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
    this.invalidateAppearanceCard();
    this.persist();
  }

  /** Change the dock icon mode: push to the dock + persist. */
  private setLogoMode(mode: LogoMode): void {
    this.logoMode = mode;
    this.syncDockIcon();
    this.invalidateAppearanceCard();
    this.persist();
  }

  /**
   * Settings holds a kept-alive DOM built when it was last rendered, so its
   * Appearance card kept showing whichever theme was selected THEN. Changing
   * the theme from anywhere else — ⌘K, the menu, an OS light/dark flip — left
   * the segment highlighting the old mode and the App-icon preview painting
   * the old variant, both stating as fact something that had already changed.
   */
  private invalidateAppearanceCard(): void {
    // Update the card IN PLACE. It used to rebuild the whole Settings view —
    // which throws away every other card's in-progress state, so changing the
    // theme with ⌘K while half-way through typing a Git identity, an SSH
    // passphrase or a clone folder destroyed what was typed. That is the same
    // rule this codebase already enforces everywhere else ("a form is not the
    // app's to throw away"), broken by the fix for the card NEXT to it.
    this.syncAppearanceCard?.();
    // The cached DOM is still correct, because the card just updated itself —
    // but a card built LATER must start from the current values, and that is
    // what showSettingsView does on a fresh build.
  }

  /** Re-sync the Appearance card's own controls, set when that card is built. */
  private syncAppearanceCard?: () => void;

  /** The dock icon variant to show: pinned light/dark, or (auto) the resolved theme. */
  private dockVariant(): AppTheme {
    return this.logoMode === "auto" ? resolveTheme(this.themeMode) : this.logoMode;
  }

  /** Push the resolved dock icon variant to the main process (best-effort). */
  private syncDockIcon(): void {
    void host.invoke("appearance:dockIcon", { variant: this.dockVariant() }).catch(() => {});
  }

  /** Step back in the in-app navigation history (⌘[ / topbar chevron). */
  private navBack(): boolean {
    if (this.navPos <= 0) return false;
    this.navPos--;
    this.navTravelTo(this.navHistory[this.navPos]);
    return true;
  }

  /**
   * Hand the history to the views, so a detail page's own Back can POP.
   *
   * It used to PUSH — every `.det-back` called `nav(view, {list:true})`, which
   * appends. Measured: pressing back left FORWARD disabled, which only happens
   * if nothing was stepped over. The one control that should restore your place
   * was the one destroying it.
   */
  private installNav(): void {
    installNavStack({
      back: () => this.navBack(),
      prev: () => (this.navPos > 0 ? this.navHistory[this.navPos - 1] : undefined),
      label: (label: string) => {
        const cur = this.navHistory[this.navPos];
        if (cur) cur.label = label;
      },
      retarget: (patch) => {
        const cur = this.navHistory[this.navPos];
        if (cur) cur.target = { ...(cur.target ?? {}), ...patch } as SectionTarget;
      },
    });
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
    // Where the app actually navigated, for the harness to assert against.
    // Several defects are "it went somewhere else" — a commit reference
    // ejecting you into the graph, a back button landing on a list — and none
    // of them were checkable, because a check can see the DOM that resulted
    // but not the route that produced it. Costs one array push in a build the
    // harness page is the only consumer of; `__GS_ROUTES` is absent in
    // production because nothing ever creates it.
    const spy = (window as unknown as { __GS_ROUTES?: Array<{ view: string; target?: SectionTarget }> })
      .__GS_ROUTES;
    if (spy) spy.push({ view: id, target });
    // Any route change dismisses every floating layer — a peek, a menu, a
    // modal, the palette, the notifications popover. They all mount on
    // document.body, so a view swap cannot take them with it: an Inbox facet
    // menu used to survive navigation and hover over the next view, filtering
    // a list that was no longer on screen.
    dismissLayers();
    // Which list a row belongs to, so Escaping out of a detail can put the
    // keyboard back on the row you opened instead of on <body>.
    setFocusScope(id);
    // The Assistant has no rail item to light up; its launcher is its tab.
    queueMicrotask(() => this.syncAssistantChip?.());
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
      const last = this.navHistory[this.navPos];
      const same = (a?: SectionTarget, b?: SectionTarget): boolean =>
        a?.number === b?.number &&
        a?.jobId === b?.jobId &&
        a?.id === b?.id &&
        a?.sha === b?.sha &&
        a?.path === b?.path &&
        // The FILE too. Without it, opening a file from the listing it lives in
        // compares equal to the listing (same `path`), so no history entry was
        // pushed: Back skipped past the folder entirely and Forward could never
        // return to the file. That is half of what SectionTarget.file was added
        // for, and it was silently doing nothing.
        a?.file === b?.file &&
        a?.ref === b?.ref &&
        (a?.list ?? false) === (b?.list ?? false);
      if (!last || last.view !== id || (target && !same(last.target, target))) {
        // The forward-truncate belongs HERE, with the push it accompanies —
        // browser semantics are "navigating after going back discards the
        // abandoned forward entries", and a re-route to the place you are
        // already standing is not navigating.
        //
        // Above the check, it ran on every route that reached this point,
        // including the one `refreshAll` performs — which is fired by the file
        // watcher on every save, by a window focus whose fingerprint moved, and
        // by every git action the app runs. So Forward died constantly, seconds
        // after going Back, for reasons the reader could not see.
        // The forward-truncate belongs HERE, with the push it accompanies —
        // browser semantics are "navigating after going back discards the
        // abandoned forward entries", and a re-route to the place you are
        // already standing is not navigating.
        //
        // Above the check, it ran on every route that reached this point,
        // including the one `refreshAll` performs — which the file watcher
        // fires on every save, a window focus fires whenever the fingerprint
        // moved, and every git action the app runs fires too. So Forward died
        // constantly, seconds after going Back, for reasons nobody could see.
        this.navHistory.splice(this.navPos + 1);
        this.navHistory.push({ view: id, target });
        this.navPos = this.navHistory.length - 1;
      }
      this.updateNavButtons();
    }
    // Stash the OUTGOING view if it's keep-alive-able, so returning to it later
    // restores the rendered DOM (scroll, expanded state) instead of refetching.
    //
    // But only if it actually FINISHED. A section you clicked into and left
    // before its data arrived was cached mid-load — skeleton and all — and
    // restored from that cache on every later visit, so Issues came back
    // permanently empty for the rest of the session and nothing but the header
    // refresh button could recover it. The trigger is ordinary: click a section,
    // get impatient, click something else. A view that never painted is not a
    // view worth keeping.
    const prev = this.currentView;
    const outgoing = this.viewHost.firstElementChild as HTMLElement | null;
    const stillLoading =
      !!outgoing?.querySelector(".skeleton, .sk-row, .list-loading, .loading-state, .spinner");
    // NOT gated on `force`. `force` means "rebuild the view I am going TO with
    // fresh data" — and it is set by every navigation that carries a target,
    // which is every navigation INTO a detail page. Letting it also throw away
    // the view being left meant opening a branch's page discarded the Branches
    // list, so Back rebuilt it from scratch: the filter you had typed to find
    // that branch was gone and you were back at the top of ninety rows. The
    // incoming view's own cache is still dropped below, which is what force is
    // actually for.
    if (App.KEEPALIVE.has(prev) && outgoing && !stillLoading) {
      // Take the scroll positions BEFORE the node is detached. Detaching zeroes
      // every `scrollTop` inside it, so by the time it is re-attached there is
      // nothing left to restore — which is why keeping the DOM alive returned
      // you to a 90-row branch list, or a long settings page, at the top of it
      // every time. The comment above has promised otherwise since it was
      // written.
      this.viewScroll.set(outgoing, this.scrollSnapshot(outgoing));
      this.viewCache.set(prev, outgoing);
    } else if (stillLoading) {
      // …and drop any older good copy, so the next visit rebuilds rather than
      // restoring something staler than what we just abandoned.
      this.viewCache.delete(prev);
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
    // Roving tabindex: exactly ONE rail item is in the Tab order.
    //
    // "The active one" is not enough, because some routes are not rail items at
    // all — the Assistant is reached from the top bar, and a detail page is a
    // route with no rail entry. On those, nothing matched, every one of the 17
    // destinations got tabIndex -1, and the entire navigation rail dropped out
    // of the keyboard's reach until you happened to press ⌘1-8. A roving tab
    // stop needs a fallback, or it is not a tab stop.
    let anyActive = false;
    for (const btn of this.navButtons) {
      const active = btn.dataset.view === id;
      if (active) anyActive = true;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }
    if (!anyActive && this.navButtons.length) this.navButtons[0].tabIndex = 0;
    // Restore a kept-alive view instantly, skipping the rebuild + refetch.
    // Any soft-reload hook belongs to the view being replaced, and its captured
    // routeGen can never match again (routeGen bumps on every route). Left in
    // place it made refreshBranchesSoft await a function that returns
    // immediately — so a fetch or pull silently refreshed nothing.
    //
    // This has to run BEFORE the keep-alive restore below, which returns early.
    // It did not, so a route change into a CACHED view skipped it and left the
    // dead hook armed: Branches then stopped refreshing for the rest of the
    // session. A dropped stash stayed on the list, and dropping it a second
    // time ran `stash drop` against an index that now names a DIFFERENT stash —
    // destroying work the user never chose.
    this.reloadBranchRows = null;
    const cached = App.KEEPALIVE.has(id) ? this.viewCache.get(id) : undefined;
    if (cached) {
      this.viewHost.replaceChildren(cached);
      // …and put them back, on the frame after the attach so layout has run.
      const shot = this.viewScroll.get(cached);
      if (shot) {
        const apply = (): void => {
          for (const [node, top, left, atTail] of shot) {
            if (!node.isConnected) continue;
            // A node that GREW while parked is a different problem from one
            // that did not. The Assistant's transcript keeps taking a live
            // turn's output behind your back, so restoring the pixel offset put
            // you permanently behind the answer — pinned to a fixed point while
            // it wrote past you. If the reader was at the TAIL when they left,
            // the tail is where they meant to be, wherever that now is.
            node.scrollTop = atTail ? node.scrollHeight : top;
            node.scrollLeft = left;
          }
        };
        apply();
        requestAnimationFrame(apply);
      }
      return;
    }
    if (id === "refdetail") {
      // A ref is a PLACE. A branch's history used to be a modal peek: no route,
      // no back-stack entry, no ⌘[/⌘], gone on Escape — and for a remote
      // branch, a tag or a stash that modal was the ONLY door to every action
      // they had.
      void renderRefDetail(this.viewHost, (v, t) => this.routeView(v, false, t), target);
    } else if (id === "predit") {
      // A pull request's title and body are the same two fields, and editing
      // one was the last surface still doing it in a modal — one with no draft
      // at all, so Escape took everything you had written.
      void renderIssueCompose(this.viewHost, (v, t) => this.routeView(v, false, t), target, "pr");
    } else if (id === "issuenew") {
      // Writing an issue is a PAGE. As a modal it had a title box, a body box
      // and nowhere to say who it is for — so labels, assignees and milestone
      // were a second trip through the issue's own page, after GitHub had
      // already announced it.
      void renderIssueCompose(this.viewHost, (v, t) => this.routeView(v, false, t), target);
    } else if (id === "releasenew") {
      // Writing a release is a PAGE. As a modal it gave the notes — the only
      // part anyone spends time on — about 180px of a 560px card.
      void renderReleaseCompose(this.viewHost, (v, t) => this.routeView(v, false, t), target);
    } else if (id === "joblog") {
      // The log is a PAGE, not a pane inside one. It used to get 523px of a
      // 913px window, on a run page that itself scrolled — two nested scroll
      // contexts and whatever height was left over.
      void renderJobLog(this.viewHost, (v, t) => this.routeView(v, false, t), target);
    } else if (id === "commit") {
      // A commit is a PLACE, not a row to reveal in the graph. Everything that
      // referenced one used to route to "graph" and call reveal(sha), which
      // shows no files, returns silently when the sha is off the loaded page,
      // and abandons wherever you were.
      void renderCommit(this.viewHost, (v, t) => this.routeView(v, false, t), target, (req) =>
        this.runAction(req),
      );
    } else if (id === "code") {
      // A path target deep-links a folder — that's how the Code browser's own
      // folder hops travel, so ⌘[/⌘] walk the folder trail like a browser.
      if (target?.path !== undefined) this.codePath = target.path;
      // …and a `file` target is the open FILE, which is a place in the app just
      // as much as a folder is. See SectionTarget.file.
      if (target?.file) void this.openCodeFile(target.file);
      else void this.showCodeView();
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
    } else if (id === "repositories") {
      this.mountSection(renderRepositories);
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
    const nav = (v: string, t?: SectionTarget): void => this.routeView(v, false, t);
    // The person peek's router, set from the one place every section mounts —
    // it is opened by chips on views that have nothing to do with orgs, and
    // used to be wired only by the Organizations view itself.
    setPeekNav(nav);
    render(wrap, nav, target);
  }

  /** A real branch manager: local branches with upstream + ahead/behind + last
   *  commit, plus remotes, tags and stashes. `highlightRef` deep-links one row:
   *  its group builds expanded and the row scrolls into view with a flash. */
  /**
   * The ref manager: local branches, remote branches, tags and stashes.
   *
   * It was the last view in the app still hand-rolling its own chrome — a bare
   * filter input, a "New branch" button, and four collapsible groups of four
   * incompatible row shapes. No title, no count, no Refresh, no facets, no
   * routed detail; the most-used repo-wide verb on the screen (Fetch) was a
   * menu item inside ONE local branch's hover-revealed kebab, and remote
   * branches, tags and stashes had no row actions at all — their entire action
   * set required opening a modal first.
   *
   * Now: one KIND per screen behind a segmented switch, one row anatomy, and
   * every verb visible at rest.
   */
  private async showBranchesView(highlightRef?: string): Promise<void> {
    // A deep link must SHOW the ref it names (a graph ref chip lands here), so
    // it drops the sticky filter below — otherwise the row it asks to scroll to
    // and flash is filtered out and the arrival looks like an empty list.
    if (highlightRef) this.branchQuery = "";
    const wrap = el("div", "list-view branches-view");
    const body = el("div", "list-body");
    body.appendChild(skeletonList(8));

    const header = ghHeader("Branches", undefined, () => this.refreshBranchesSoft());
    // The search field the rest of the app uses: 110ms debounce, a clear ✕, and
    // Escape to empty it — none of which a raw `input.list-filter` had. It also
    // searches more than the name now (upstream, tip subject, short sha, a
    // stash's message), because a name-only filter cannot find "the branch with
    // the log-stream fix in it".
    // Seeded from instance state, like branchTab/branchFacets beside it. Opening
    // a ref carries a target, which forces a rebuild AND skips caching the
    // outgoing list — so this view is reconstructed on the way back, and a
    // closure-local query meant the filter you typed to find the branch was
    // gone the moment you looked at it. Every other section keeps its query
    // outside the build for exactly this reason (views/issues.ts).
    let query = this.branchQuery;
    const search = searchField({
      placeholder: "Search refs…",
      initial: query,
      onInput: (q) => {
        query = q;
        this.branchQuery = q;
        render();
      },
    });
    header.querySelector(".gh-head-titlewrap")?.appendChild(search);

    const tools = el("div", "gh-head-tools");
    // FETCH, at the surface. It was reachable only from inside one local
    // branch's ⋯ menu — the action that makes every ahead/behind number on this
    // screen true, two hover levels deep. Refresh (in .gh-acct) re-reads what
    // git already has; Fetch goes to the network. Different promises, so
    // different buttons, and the titles say which is which.
    const fetchBtn = el("button", "mini-btn") as HTMLButtonElement;
    fetchBtn.append(glyph("sync"), span("Fetch"));
    fetchBtn.title = "Fetch from every remote — updates what ahead and behind mean here";
    fetchBtn.addEventListener("click", () => void this.fetchAllLive(fetchBtn));
    const ctaSlot = el("div", "gh-head-cta");
    tools.append(fetchBtn, ctaSlot);
    header.querySelector(".gh-acct")?.before(tools);

    const segSlot = el("div", "branches-segbar");
    const facetSlot = el("div", "branches-facets");
    wrap.append(header, segSlot, facetSlot, body);
    wireListNav(body, ".sec-row");
    this.viewHost.replaceChildren(wrap);

    const gen = this.routeGen;
    await this.refreshRefs();
    let locals: BranchInfo[];
    try {
      locals = await gget("branches:list", undefined);
    } catch (e) {
      // A failed read is not an empty repository. This used to be impossible to
      // reach — the bridge turned every git failure into `[]` — so a repo with a
      // corrupt packed-refs or a held index.lock rendered as "No branches yet",
      // which is a confident lie about a repo full of them.
      if (gen !== this.routeGen) return;
      body.replaceChildren(
        errorState("Couldn't list branches", cleanErr(e) || "Git could not read this repository's refs.", () =>
          void this.showBranchesView(highlightRef),
        ),
      );
      return;
    }
    if (gen !== this.routeGen) return;
    // Stashes join the ref manager: they're refs too, and this is the only
    // browsable surface they have.
    let stashes: StashInfo[] = [];
    let stashFailed = false;
    try {
      stashes = await host.invoke("stash:list", undefined);
    } catch {
      // Swallowing this used to render "no stashes" over a repo that has some.
      stashFailed = true;
    }
    if (gen !== this.routeGen) return;
    // Recomputed on every render so a live reload (fetch from the branch menu)
    // picks up new remote branches/tags without rebuilding the whole view.
    //
    // `refs/remotes/origin/HEAD` shortens to the bare remote NAME ("origin"),
    // not "origin/HEAD" — so the old `endsWith("/HEAD")` guard never fired and
    // the list carried a phantom row called "origin" offering to check out a
    // branch that does not exist. Its symref names the DEFAULT branch, which is
    // worth keeping; the row is not.
    const isRemoteHead = (r: RefInfo): boolean => !!r.symref || !r.name.includes("/");
    let remotes = this.refs.filter((r) => r.type === "remote" && !isRemoteHead(r));
    let tags = this.refs.filter((r) => r.type === "tag");
    let defaultBranch = this.defaultBranchName(locals);
    // Worktrees: four channels that have existed since the IPC contract was
    // written with NO caller in any view. The segment appears only when there
    // is more than one — a single worktree is just "the repository".
    let worktrees: WorktreeInfo[] = [];
    // A failed read is not an empty list — the same rule the stash list already
    // follows. Swallowing it let the view assert "No other worktrees" from a
    // git call that never answered.
    let worktreeFailed = false;
    try {
      worktrees = await host.invoke("worktree:list", undefined);
    } catch {
      worktrees = [];
      worktreeFailed = true;
    }
    if (gen !== this.routeGen) return;

    // Which KIND is on screen. One homogeneous kind per screen is what makes a
    // shared row and a facet bar possible at all — and it stops 300 tags
    // burying six branches, which is what the four-groups-in-one-scroller shape
    // did every time a repo had any history.
    type Kind = "local" | "remote" | "tags" | "stashes" | "worktrees";
    if (highlightRef) {
      this.branchTab = locals.some((b) => b.name === highlightRef)
        ? "local"
        : remotes.some((r) => r.name === highlightRef)
          ? "remote"
          : tags.some((r) => r.name === highlightRef)
            ? "tags"
            : stashes.some((st) => st.ref === highlightRef)
              ? "stashes"
              : this.branchTab;
      // A deep link must SHOW the row it names, so it clears EVERY narrowing
      // that could hide it — not just the search box. The age cut alone was
      // enough to swallow the arrival silently: `branchAge` defaults to
      // "active", so a link to any branch untouched for three months landed on
      // a list that did not contain it, with nothing saying why. The facets can
      // do the same, and they persist per segment across launches.
      this.branchFacets[this.branchTab] = Object.create(null) as FacetState;
      this.branchAge = "all";
    }

    const counts = (): Record<Kind, number> => ({
      local: locals.length,
      remote: remotes.length,
      tags: tags.length,
      stashes: stashes.length,
      worktrees: worktrees.length,
    });

    /**
     * How recently a branch moved, as GitHub cuts it: Active / Stale / All.
     *
     * Three months is github.com's own line, and it is the difference between
     * "the branches I am working on" and "everything this clone has ever
     * touched" — the distinction that makes a list of ninety branches usable.
     */
    const STALE_AFTER = 90 * 24 * 3600;
    const isStale = (date?: number): boolean =>
      !!date && Date.now() / 1000 - date > STALE_AFTER;

    /** The one word that describes where a branch stands. First match wins, and
     *  the order is the order a person cares about them in. */
    const standing = (b: BranchInfo): string => {
      if (b.current) return "current";
      if (b.gone) return "gone";
      // `merged` means "ahead === 0 against the default branch", so the default
      // branch satisfies it trivially — and reading "Merged" beside main, in a
      // facet grouping it with the branches whose work is done, says something
      // false about the branch everything else is measured from. It is judged
      // on its own upstream instead, like any other branch with one.
      if (b.merged && b.name !== defaultBranch) return "merged";
      if (!b.upstream) return "unpublished";
      if (b.ahead && b.behind) return "diverged";
      if (b.ahead) return "ahead";
      if (b.behind) return "behind";
      return "insync";
    };
    const STANDING_LABELS: Record<string, string> = {
      current: "Current",
      gone: "Upstream gone",
      merged: "Merged",
      unpublished: "Unpublished",
      diverged: "Diverged",
      ahead: "Ahead",
      behind: "Behind",
      insync: "In sync",
    };

    const render = (): void => {
      const n = counts();
      segSlot.replaceChildren(
        segmented<Kind>({
          ariaLabel: "Which refs to show",
          value: this.branchTab,
          options: [
            { value: "local", label: `Local (${n.local})`, icon: "git-branch" },
            { value: "remote", label: `Remotes (${n.remote})`, icon: "cloud" },
            { value: "tags", label: `Tags (${n.tags})`, icon: "tag" },
            { value: "stashes", label: `Stashes (${n.stashes})`, icon: "archive" },
            // Only when there is more than one: a single worktree is just "the
            // repository", and a segment reading "Worktrees (1)" is a tab that
            // tells you nothing.
            //
            // …unless you are STANDING on it. Removing the second-to-last
            // worktree dropped the option out from under the reader, leaving
            // them on a segment with no button — the bar showed four, none
            // active, while the body still rendered worktrees. A tab may not
            // disappear while it is the one you are looking at.
            ...(n.worktrees > 1 || this.branchTab === "worktrees"
              ? [{ value: "worktrees" as Kind, label: `Worktrees (${n.worktrees})`, icon: "window" }]
              : []),
          ],
          onChange: (v) => {
            this.branchTab = v;
            this.persist();
            render();
          },
        }),
      );

      // "What is safe to delete" — the question a branch list is opened to
      // answer at least as often as "what do I switch to", and one this view
      // could never answer at all. A branch is finished when every commit on it
      // is already in the default branch (merged), or when the upstream it
      // tracked has been deleted (gone) — which is what a merged pull request
      // leaves behind.
      //
      // The default branch is NEVER finished, and excluding it is not a nicety:
      // `merged` is `ahead === 0` measured against the default branch, and the
      // default branch is zero commits ahead of itself. So `main` qualified,
      // and any moment you were standing on a feature branch the sweep offered
      // — in a confirm listing it by name, among five others — to delete the
      // one branch the repository is organised around.
      const sweep = el("button", "mini-btn branches-sweep") as HTMLButtonElement;
      segSlot.appendChild(sweep);

      // ── the filter bar ────────────────────────────────────────────────
      //
      // All client-side: `branches:list` and `refs:list` are whole-set reads,
      // so every spec carries a predicate and changing one is a re-render, not
      // a refetch. State is per KIND — a Standing filter means nothing on the
      // tags screen.
      const specs: FacetSpec<unknown>[] =
        this.branchTab === "local"
          ? [
              {
                key: "standing",
                label: "Standing",
                icon: "git-branch",
                options: [...new Set(locals.map(standing))].map((v) => ({
                  value: v,
                  label: STANDING_LABELS[v] ?? v,
                })),
                predicate: (item: unknown, v: string) => standing(item as BranchInfo) === v,
              },
              {
                key: "remote",
                label: "Remote",
                icon: "cloud",
                options: [...new Set(locals.map((b) => b.upstream?.split("/")[0]).filter(Boolean))].map(
                  (v) => ({ value: v as string, label: v as string }),
                ),
                predicate: (item: unknown, v: string) => (item as BranchInfo).upstream?.split("/")[0] === v,
              },
            ]
          : this.branchTab === "remote"
            ? [
                {
                  key: "remote",
                  label: "Remote",
                  icon: "cloud",
                  options: [...new Set(remotes.map((r) => r.name.split("/")[0]))].map((v) => ({
                    value: v,
                    label: v,
                  })),
                  predicate: (item: unknown, v: string) => (item as RefInfo).name.split("/")[0] === v,
                },
                {
                  key: "local",
                  label: "Local copy",
                  icon: "git-branch",
                  options: [
                    { value: "yes", label: "Have one" },
                    { value: "no", label: "None" },
                  ],
                  predicate: (item: unknown, v: string) => {
                    const short = (item as RefInfo).name.split("/").slice(1).join("/");
                    const have = locals.some((b) => b.name === short);
                    return v === "yes" ? have : !have;
                  },
                },
              ]
            : this.branchTab === "tags"
              ? [
                  {
                    key: "kind",
                    label: "Kind",
                    icon: "tag",
                    options: [
                      { value: "annotated", label: "Annotated" },
                      { value: "lightweight", label: "Lightweight" },
                    ],
                    predicate: (item: unknown, v: string) =>
                      ((item as RefInfo).objectType === "tag" ? "annotated" : "lightweight") === v,
                  },
                ]
              : [];

      // A menu that offers one value is not a filter, it is furniture.
      //
      // Most repositories have exactly one remote, so "Remote" offered
      // "origin" and nothing else — a dropdown whose only choice was the state
      // the list is already in. Same for any other facet the current set
      // happens to agree on. They cost a control each in a toolbar the owner
      // called complicated, and they can only ever narrow to what is already
      // shown.
      // Only when the options are STATED. A facet that harvests or loads its
      // options has none yet at this point, and dropping those would remove
      // working filters rather than empty ones.
      const usableSpecs = specs.filter((sp) => !sp.options || sp.options.length > 1);
      const state = (this.branchFacets[this.branchTab] ??= {});
      const bar = facetBar<unknown>({
        specs: usableSpecs,
        state,
        items: [],
        onChange: () => render(),
      });
      facetSlot.replaceChildren();
      if (usableSpecs.length) facetSlot.appendChild(bar.el);

      const q = query.trim().toLowerCase();
      // Beyond the name: the upstream, the tip subject and the short sha, so
      // "the branch with the log-stream fix" is findable by what it did.
      const hit = (...parts: Array<string | undefined>): boolean =>
        !q || parts.some((x) => (x ?? "").toLowerCase().includes(q));

      // "What is safe to delete" — the question a branch list is opened to
      // answer at least as often as "what do I switch to", and one this view
      // could never answer at all. A branch is finished when every commit on it
      // is already in the default branch (merged), or when the upstream it
      // tracked has been deleted (gone) — which is what a merged pull request
      // leaves behind.
      //
      // The default branch is NEVER finished, and excluding it is not a nicety:
      // `merged` is `ahead === 0` measured against the default branch, and the
      // default branch is zero commits ahead of itself. So `main` qualified,
      // and any moment you were standing on a feature branch the sweep offered
      // — in a confirm listing it by name, among five others — to delete the
      // one branch the repository is organised around.
      //
      // Downstream of the SEARCH and the FACETS, like the age counts beside it:
      // computed above them, the button read "Delete 6 finished…" beside a list
      // you had narrowed to one, offering to delete five branches that were not
      // on screen. Not downstream of the age cut, which is a browsing lens
      // rather than a narrowing — a finished branch is usually a stale one, and
      // filtering by it would empty the sweep from the segment it opens on.
      const finished = locals
        .filter((b) => hit(b.name, b.upstream, b.subject))
        .filter((b) => bar.passes(b))
        .filter((b) => !b.current && b.name !== defaultBranch && (b.merged || b.gone));
      sweep.replaceChildren(glyph("trash"), span(`Delete ${finished.length} finished…`));
      sweep.title = q
        ? `Of the branches matching “${q}”: those already in ${defaultBranch ?? "the default branch"}, or whose upstream is gone`
        : `Branches whose work is already in ${defaultBranch ?? "the default branch"}, or whose upstream is gone`;
      sweep.hidden = this.branchTab !== "local" || finished.length === 0;
      sweep.onclick = () => void this.sweepFinishedBranches(finished, defaultBranch);

      // Active / Stale / All — github.com's own cut, and the difference between
      // "what I am working on" and "everything this clone has touched".
      if (this.branchTab === "local") {
        // The counts answer "how many if I press this", so they sit downstream
        // of the search and the facets: a segment reading (12) while the list
        // it would produce holds three is worse than no count at all.
        const inScope = locals.filter((b) => hit(b.name, b.upstream, b.subject)).filter((b) => bar.passes(b));
        const stale = inScope.filter((b) => !b.current && isStale(b.date)).length;
        facetSlot.appendChild(
          segmented<"active" | "stale" | "all">({
            ariaLabel: "How recently these branches moved",
            value: this.branchAge,
            options: [
              { value: "active", label: `Active (${inScope.length - stale})` },
              { value: "stale", label: `Stale (${stale})` },
              { value: "all", label: `All (${inScope.length})` },
            ],
            onChange: (v) => {
              this.branchAge = v;
              render();
            },
          }),
        );
      }
      const sortBtn = this.branchSortBtn(() => render());
      if (sortBtn) facetSlot.appendChild(sortBtn);

      body.replaceChildren();
      ctaSlot.replaceChildren(this.branchesCta(this.branchTab));

      // The order the segment on screen can actually carry out — not whatever
      // was last picked on a segment that had more choices.
      const order = this.effectiveSort();
      const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
      const byDate = (a?: number, b?: number): number => (b ?? 0) - (a ?? 0);

      let shown = 0;
      let total = 0;
      // Did the Active/Stale lens actually remove anything? It defaults to
      // Active, so "is a lens set" is true before the reader has touched a
      // control — and the empty state used that to blame "the filters you have
      // set" for every search that matched nothing, in a repo where the lens
      // may well be hiding nothing at all. Only a cut that HID something is a
      // reason the list is empty.
      let ageHid = 0;
      if (this.branchTab === "local") {
        total = locals.length;
        const searched = locals
          .filter((b) => hit(b.name, b.upstream, b.subject))
          .filter((b) => bar.passes(b));
        const rows = searched
          // The current branch is never "stale" — it is where you are standing.
          // Which means it belongs in Active whatever its date says, and NOT in
          // Stale: a bare `|| b.current` put it in both, so a repo left alone
          // for a year showed its own checked-out branch under Stale while the
          // segment's count, which excludes it, said one fewer.
          .filter((b) =>
            this.branchAge === "all"
              ? true
              : this.branchAge === "stale"
                ? !b.current && isStale(b.date)
                : b.current || !isStale(b.date),
          )
          .sort((a, b) =>
            order === "name"
              ? byName(a.name, b.name)
              : order === "ahead"
                ? (b.ahead ?? 0) - (a.ahead ?? 0) || byDate(a.date, b.date)
                : order === "stale"
                  ? (a.date ?? 0) - (b.date ?? 0)
                  : byDate(a.date, b.date),
          );
        shown = rows.length;
        ageHid = searched.length - rows.length;
        // The sweep is a repo-level cleanup and is deliberately NOT cut by the
        // age lens — a finished branch is usually a stale one, so binding it
        // would empty the button from the segment it opens on. But then its
        // number can exceed the rows beneath it, and a destructive control
        // whose count contradicts the list is one nobody should press. Say so.
        const visible = new Set(rows.map((b) => b.name));
        const unseen = finished.filter((b) => !visible.has(b.name)).length;
        if (unseen) {
          sweep.title +=
            `\n${unseen} of them ${unseen === 1 ? "is" : "are"} not shown by the current view — ` +
            "the confirm lists every one by name.";
        }
        // Scaled to what is ON SCREEN, so the bars stay comparable down the
        // list rather than against a branch the filter has removed.
        for (const b of rows) body.appendChild(this.localBranchRow(b, defaultBranch));
      } else if (this.branchTab === "remote") {
        total = remotes.length;
        const rows = remotes
          .filter((r) => hit(r.name, r.subject, r.sha.slice(0, 7)))
          .filter((r) => bar.passes(r))
          .sort((a, b) =>
            order === "name"
              ? byName(a.name, b.name)
              : order === "stale"
                ? (a.date ?? 0) - (b.date ?? 0)
                : byDate(a.date, b.date),
          );
        shown = rows.length;
        const haveLocal = new Set(locals.map((b) => b.name));
        for (const r of rows) body.appendChild(this.remoteRefRow(r, haveLocal));
      } else if (this.branchTab === "tags") {
        total = tags.length;
        const rows = tags
          .filter((r) => hit(r.name, r.subject, r.sha.slice(0, 7)))
          .filter((r) => bar.passes(r))
          // By DATE by default, not by name: alphabetical puts v1.10.0 before
          // v1.9.0, which is wrong about every version scheme anyone uses.
          .sort((a, b) =>
            order === "name"
              ? byName(a.name, b.name)
              : order === "stale"
                ? (a.date ?? 0) - (b.date ?? 0)
                : byDate(a.date, b.date),
          );
        shown = rows.length;
        for (const r of rows) body.appendChild(this.tagRefRow(r));
      } else if (this.branchTab === "stashes") {
        total = stashes.length;
        const rows = stashes.filter((st) => hit(st.message, st.ref));
        shown = rows.length;
        for (const st of rows) body.appendChild(this.stashRow(st));
      } else {
        total = worktrees.length;
        const rows = worktrees.filter((w) => hit(w.branch, w.path, w.head.slice(0, 7)));
        shown = rows.length;
        for (const w of rows) body.appendChild(this.worktreeRow(w));
      }

      header.setCount?.(shown, total);
      if (!shown) {
        // Which control emptied it. The search box speaks for itself; a facet
        // or the age cut does not, and without this the view announced that the
        // REPOSITORY had no branches over a repo with ninety.
        const narrowed = bar.activeCount() > 0 || ageHid > 0;
        body.appendChild(
          this.branchesEmpty(this.branchTab, q, stashFailed, narrowed, worktreeFailed, () => {
            bar.clear();
            this.branchAge = "all";
            render();
          }),
        );
      }
    };

    this.reloadBranchRows = async (): Promise<void> => {
      if (gen !== this.routeGen) return;
      await this.refreshRefs();
      locals = await gget("branches:list", undefined);
      try {
        stashes = await host.invoke("stash:list", undefined);
        stashFailed = false;
      } catch {
        // The rows already on screen are kept — they are the last thing git
        // actually said — but the failure has to REACH the reader, or a stash
        // list that stopped updating looks like one that stopped changing.
        // `branchesEmpty` can only speak when the list is EMPTY, so with stale
        // rows showing this was the one path with no way to say anything.
        stashFailed = true;
        if (stashes.length) toast("Couldn't re-read the stashes — showing the last list git gave.", "info");
      }
      // Worktrees too. This re-read everything EXCEPT them, so the list was
      // fetched exactly once when the view was first built — and every soft
      // refresh in the view goes through here, including `removeWorktreeLive`.
      // "Worktree removed." left the row and its count on screen, and pressing
      // Remove again ran git against a path that no longer existed.
      try {
        worktrees = await host.invoke("worktree:list", undefined);
        worktreeFailed = false;
      } catch {
        // KEEP the rows we have. Replacing them with [] on a failed refresh
        // deleted a list git never said was gone.
        worktreeFailed = true;
        if (worktrees.length) toast("Couldn't re-read the worktrees — showing the last list git gave.", "info");
      }
      if (gen !== this.routeGen) return;
      remotes = this.refs.filter((r) => r.type === "remote" && !isRemoteHead(r));
      tags = this.refs.filter((r) => r.type === "tag");
      defaultBranch = this.defaultBranchName(locals);
      render();
    };
    // ── the keyboard ──────────────────────────────────────────────────────
    //
    // Nothing in this view had a shortcut: not the filter, not Fetch, not New
    // branch, not a row's own verb. `sectionList`'s ↑↓/j/k/Home/End already
    // move between rows; these are the two that make it operable without a
    // mouse at all.
    wrap.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

      // "/" focuses the search, the way it does in every list people already
      // know. Not while typing — a slash is a character in a branch name.
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        search.querySelector("input")?.focus();
        return;
      }
      // ⌘Enter runs the focused row's PRIMARY verb — Checkout, Pull, Publish,
      // Push, Apply — without reaching for the pointer. Plain Enter still opens
      // the row, which is what every other list in the app does.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const row = t?.closest?.(".sec-row") as HTMLElement | null;
        const verb = row?.querySelector<HTMLButtonElement>(".sec-row-actions .row-btn:not(.lv-menu-btn)");
        if (verb) {
          e.preventDefault();
          verb.click();
        }
        return;
      }
      // Shift+F fetches. The action the whole screen depends on deserves one.
      if ((e.key === "f" || e.key === "F") && e.shiftKey && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        fetchBtn.click();
      }
    });

    render();
    if (highlightRef) {
      const row = body.querySelector<HTMLElement>(`[data-ref="${CSS.escape(highlightRef)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      row?.classList.add("is-flash");
    }
  }

  /** Which KIND of ref the Branches view is showing. Survives re-renders and
   *  is persisted, the way every other section remembers its sub-tab. */
  private branchTab: "local" | "remote" | "tags" | "stashes" | "worktrees" = "local";
  /** Facet state per KIND — a Standing filter means nothing on the tags screen,
   *  so each segment keeps its own and switching back finds it as you left it. */
  private branchFacets: Record<string, FacetState> = Object.create(null) as Record<string, FacetState>;
  /** The live text filter. Outside the build like the facets, so opening a ref
   *  and pressing Back doesn't throw away the search that found it. */
  private branchQuery = "";
  /** Active / Stale / All — github.com's own cut at three months. */
  private branchAge: "active" | "stale" | "all" = "active";
  /** How the list is ordered. Recency is the default because it answers "what
   *  was I just doing", which is why this view is opened most often. */
  private branchSort: "recent" | "name" | "ahead" | "stale" = "recent";

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

  /**
   * Run a refresh with a visible busy state, and put the keyboard back on the
   * Refresh button afterwards.
   *
   * These buttons rebuild their whole view, so the button you pressed is
   * destroyed and replaced mid-click: nothing spun, nothing said "working", and
   * the focus you had went to <body>. The replacement occupies the same seat, so
   * it is found by class and re-focused only if the keyboard was here to start.
   */
  private async refreshInPlace(btn: HTMLElement, run: () => void | Promise<void>): Promise<void> {
    if ((btn as HTMLButtonElement).disabled) return;
    const hadFocus = document.activeElement === btn;
    const host_ = btn.parentElement;
    const nth = host_ ? [...host_.children].indexOf(btn) : -1;
    (btn as HTMLButtonElement).disabled = true;
    btn.classList.add("is-busy");
    btn.querySelector(".codicon")?.classList.add("spin");
    try {
      await run();
    } finally {
      if (btn.isConnected) {
        (btn as HTMLButtonElement).disabled = false;
        btn.classList.remove("is-busy");
        btn.querySelector(".codicon")?.classList.remove("spin");
      } else if (hadFocus && host_?.isConnected && nth >= 0) {
        (host_.children[nth] as HTMLElement | undefined)?.focus?.();
      }
    }
  }

  /**
   * A remote branch.
   *
   * It used to be a single-line button showing a name and a short sha, with NO
   * actions whatsoever — its entire verb set required opening a modal first.
   * It now carries what it points at, when, whether you already have it
   * locally, and the two things you actually do with one.
   */
  private remoteRefRow(r: RefInfo, haveLocal: Set<string>): HTMLElement {
    // "origin/feat/x" reads as "feat/x on origin" — the remote is a column, not
    // a prefix repeated down every title.
    const short = r.name.split("/").slice(1).join("/") || r.name;
    const remote = r.name.split("/")[0];
    const mine = haveLocal.has(short);

    const actions: HTMLElement[] = [];
    const primary = el("button", "row-btn") as HTMLButtonElement;
    primary.textContent = mine ? "Checkout" : "Check out here";
    primary.title = mine
      ? `Check out your local ${short}`
      : `Create ${short} from ${r.name} and check it out`;
    primary.setAttribute("aria-label", primary.title);
    primary.addEventListener("click", () =>
      void this.checkoutRef(mine ? short : r.name, primary, mine ? "head" : "remote"),
    );
    actions.push(primary);
    const more = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    more.setAttribute("aria-label", `More actions for ${r.name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.appendChild(glyph("ellipsis"));
    const menu = (): void =>
      openMenu(more, [
        { label: `Compare with ${short}`, icon: "git-compare", onClick: () => this.compareWithRef(r.name) },
        { label: "Show in the graph", icon: "git-commit", onClick: () => this.routeView("graph", false, { sha: r.sha }) },
        { separator: true },
        { label: "Copy name", icon: "copy", onClick: () => void copyText(r.name, `Copied “${r.name}”.`) },
      ]);
    more.addEventListener("click", menu);
    actions.push(more);

    const row = secRow({
      lead: glyph("cloud"),
      title: short,
      titleSuffix: mine ? [] : [span("no local copy", "ab-pill unpublished")],
      chips: r.subject ? [span(r.subject, "br-subject")] : [],
      meta: [span(remote, "br-remote"), span(r.sha.slice(0, 7), "br-sha sec-mono")],
      time: r.date ? relTime(r.date) : "",
      timeTitle: r.date ? absTime(r.date) : undefined,
      actions,
      onOpen: () => this.routeView("refdetail", false, { ref: r.name, id: "remote" }),
      ariaLabel: `${short} on ${remote}${mine ? "" : ", no local copy"}${r.date ? `, updated ${relTime(r.date)}` : ""}`,
    });
    row.classList.add("ref-row");
    row.dataset.ref = r.name;
    row.title = [r.name, r.subject].filter(Boolean).join("\n");
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu();
    });
    return row;
  }

  /**
   * A tag.
   *
   * Annotated vs lightweight is the one fact that distinguishes the two kinds
   * and NOTHING has ever carried it — `%(objecttype)` was there all along.
   * Delete and Push are new: `tag:create` existed and the app could not remove
   * or publish what it made.
   */
  private tagRefRow(r: RefInfo): HTMLElement {
    const annotated = r.objectType === "tag";
    const actions: HTMLElement[] = [];
    const push = el("button", "row-btn") as HTMLButtonElement;
    push.textContent = "Push";
    push.setAttribute("aria-label", `Push tag ${r.name} to the remote`);
    push.title = `Publish ${r.name} to the remote`;
    push.addEventListener("click", () => void this.pushTagLive(r.name, push));
    actions.push(push);
    const more = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    more.setAttribute("aria-label", `More actions for ${r.name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.appendChild(glyph("ellipsis"));
    const menu = (): void =>
      openMenu(more, [
        { label: "Show in the graph", icon: "git-commit", onClick: () => this.routeView("graph", false, { sha: r.sha }) },
        { label: `Compare with ${r.name}`, icon: "git-compare", onClick: () => this.compareWithRef(r.name) },
        { separator: true },
        { label: "Copy name", icon: "copy", onClick: () => void copyText(r.name, `Copied “${r.name}”.`) },
        { separator: true },
        {
          label: "Delete tag…",
          icon: "trash",
          danger: true,
          onClick: () => void this.deleteTagLive(r.name),
        },
      ]);
    more.addEventListener("click", menu);
    actions.push(more);

    const row = secRow({
      lead: glyph("tag"),
      title: r.name,
      titleSuffix: [span(annotated ? "annotated" : "lightweight", `ab-pill ${annotated ? "annotated" : "lightweight"}`)],
      chips: r.subject ? [span(r.subject, "br-subject")] : [],
      meta: [span(r.sha.slice(0, 7), "br-sha sec-mono")],
      time: r.date ? relTime(r.date) : "",
      timeTitle: r.date ? absTime(r.date) : undefined,
      actions,
      onOpen: () => this.routeView("refdetail", false, { ref: r.name, id: "tag" }),
      ariaLabel: `${r.name}, ${annotated ? "annotated" : "lightweight"} tag${r.date ? `, ${relTime(r.date)}` : ""}`,
    });
    row.classList.add("ref-row");
    row.dataset.ref = r.name;
    row.title = [r.name, r.subject].filter(Boolean).join("\n");
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu();
    });
    return row;
  }

  /**
   * A stash.
   *
   * `stash@{n}` is POSITIONAL: dropping one renumbers every stash below it, so
   * a row built from a stale list can act on a DIFFERENT stash than the one it
   * names. Every mutation here re-reads the list first and refuses if the
   * selector no longer points at the same commit.
   */
  private stashRow(st: StashInfo): HTMLElement {
    const actions: HTMLElement[] = [];
    const apply = el("button", "row-btn") as HTMLButtonElement;
    apply.textContent = "Apply";
    apply.setAttribute("aria-label", `Apply ${st.ref}`);
    apply.title = `Apply ${st.ref} and keep it in the stash list`;
    apply.addEventListener("click", () => void this.stashActLive("apply", st, apply));
    actions.push(apply);
    const more = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    more.setAttribute("aria-label", `More actions for ${st.ref}`);
    more.setAttribute("aria-haspopup", "menu");
    more.appendChild(glyph("ellipsis"));
    const menu = (): void =>
      openMenu(more, [
        { label: "Pop — apply and remove", icon: "arrow-up", onClick: () => void this.stashActLive("pop", st, more) },
        { separator: true },
        {
          label: "Drop this stash…",
          icon: "trash",
          danger: true,
          onClick: () => void this.stashActLive("drop", st, more),
        },
      ]);
    more.addEventListener("click", menu);
    actions.push(more);

    const row = secRow({
      lead: glyph("archive"),
      title: st.message || st.ref,
      meta: [span(st.ref, "stash-sel sec-mono")],
      time: st.time ? relTime(st.time) : "",
      timeTitle: st.time ? absTime(st.time) : undefined,
      actions,
      onOpen: () => this.routeView("refdetail", false, { ref: st.ref, id: "stash" }),
      ariaLabel: `${st.message || st.ref}, ${st.ref}${st.time ? `, ${relTime(st.time)}` : ""}`,
    });
    row.classList.add("ref-row", "stash-row");
    row.dataset.ref = st.ref;
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu();
    });
    return row;
  }

  /** Compare the current branch against a ref, in the Compare view. */
  private compareWithRef(head: string): void {
    const current = this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
    this.compareBase = current ?? "HEAD";
    this.compareHead = head;
    this.routeView("compare", true);
  }

  /** Publish one tag. */
  private async pushTagLive(name: string, btn: HTMLButtonElement): Promise<void> {
    await this.refreshInPlace(btn, async () => {
      const r = await host.invoke("tag:push", { name });
      if (!r.ok) {
        toast(r.message ?? `Couldn't push ${name}.`, r.expected ? "info" : "error");
        return;
      }
      toast(`Pushed ${name}.`, "success");
    });
  }

  /** Delete a tag LOCALLY — and say that the pushed copy outlives it, because
   *  "delete" on a tag that has been published is only half true. */
  private async deleteTagLive(name: string): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete tag ${name}?`,
      message:
        `This removes the tag from this clone only. If it has already been pushed, ` +
        `the copy on the remote is untouched and a fetch brings it straight back.`,
      confirmLabel: "Delete locally",
      danger: true,
    });
    if (!ok) return;
    const r = await host.invoke("tag:delete", name);
    if (!r.ok) {
      toast(r.message ?? `Couldn't delete ${name}.`, r.expected ? "info" : "error");
      return;
    }
    toast(`Deleted tag ${name} locally.`, "success");
    await this.refreshBranchesSoft();
  }

  /**
   * Apply / pop / drop a stash, safely.
   *
   * `stash@{n}` is a POSITION, not an identity: dropping one renumbers every
   * stash below it. A row built from a list that has since changed therefore
   * names one stash and acts on another — and for `drop` that is unrecoverable.
   * So: re-read the list first and refuse unless the selector still points at
   * the same commit.
   */
  private async stashActLive(
    action: "apply" | "pop" | "drop",
    st: StashInfo,
    btn: HTMLElement,
  ): Promise<void> {
    if (action === "drop") {
      const ok = await confirmDialog({
        title: `Drop ${st.ref}?`,
        message: `“${st.message || st.ref}” is deleted permanently. This cannot be undone.`,
        confirmLabel: "Drop",
        danger: true,
      });
      if (!ok) return;
    }
    await this.refreshInPlace(btn, async () => {
      let fresh: StashInfo[];
      try {
        fresh = await host.invoke("stash:list", undefined);
      } catch {
        toast("Couldn't re-read the stash list — nothing was changed.", "error");
        return;
      }
      const still = fresh.find((x) => x.ref === st.ref);
      if (!still || (st.sha && still.sha && still.sha !== st.sha)) {
        toast(
          `${st.ref} is not the stash it was — the list changed underneath. Refreshed instead.`,
          "info",
        );
        await this.refreshBranchesSoft();
        return;
      }
      const r = await host.invoke(
        action === "apply" ? "stash:apply" : action === "pop" ? "stash:pop" : "stash:drop",
        st.ref,
      );
      if (!r.ok) {
        toast(r.message ?? `Couldn't ${action} ${st.ref}.`, r.expected ? "info" : "error");
        return;
      }
      toast(
        action === "apply"
          ? `Applied ${st.ref}.`
          : action === "pop"
            ? `Popped ${st.ref}.`
            : `Dropped ${st.ref}.`,
        "success",
      );
      await this.refreshBranchesSoft();
    });
  }

  /**
   * Delete the branches whose work is done.
   *
   * The confirm NAMES every one of them, and says which ref merged-ness was
   * measured against — because "merged" is a claim about a specific branch, a
   * squash-merged branch reads as unmerged, and a branch merged into a release
   * line but not into the default reads as unmerged too. A bulk delete that
   * does not show its list is a bulk delete nobody should press.
   *
   * Sequential, stopping at the first failure, and it reports what actually
   * happened rather than assuming: there is no transaction here, and claiming
   * six deletions when the third one failed would be a lie about the repo.
   */
  private async sweepFinishedBranches(finished: BranchInfo[], defaultBranch?: string): Promise<void> {
    // Belt and braces on the one destructive action here that takes a LIST: the
    // caller already excludes the default branch and the current one, and this
    // refuses to delete them anyway. A bulk delete is the wrong place to trust
    // that a filter upstream still says what it said when it was written.
    finished = finished.filter((b) => !b.current && b.name !== defaultBranch);
    if (!finished.length) return;
    const names = finished.map((b) => b.name);
    const ok = await confirmDialog({
      title: `Delete ${finished.length} finished ${finished.length === 1 ? "branch" : "branches"}?`,
      message:
        `${names.join("\n")}\n\n` +
        `“Finished” means every commit is already in ${defaultBranch ?? "the default branch"}, ` +
        `or the upstream it tracked no longer exists. A squash-merged branch does NOT look ` +
        `merged to git, and a branch merged somewhere other than ${defaultBranch ?? "the default branch"} ` +
        `will not be listed here. Only the local copies are deleted.`,
      confirmLabel: `Delete ${finished.length}`,
      danger: true,
    });
    if (!ok) return;

    const done: string[] = [];
    for (const b of finished) {
      let r;
      try {
        r = await host.invoke("branch:delete", { name: b.name, force: false });
      } catch (e) {
        toast(
          `Deleted ${done.length} of ${finished.length}, then ${b.name} failed: ${cleanErr(e) || "git error"}.`,
          "error",
        );
        break;
      }
      if (!r?.ok) {
        toast(
          done.length
            ? `Deleted ${done.join(", ")}. Stopped at ${b.name}: ${r?.message ?? "git refused."}`
            : `${b.name} was not deleted: ${r?.message ?? "git refused."}`,
          "error",
        );
        break;
      }
      done.push(b.name);
    }
    if (done.length === finished.length) {
      toast(`Deleted ${done.length} finished ${done.length === 1 ? "branch" : "branches"}.`, "success");
    }
    bust("branches");
    await this.refreshBranchesSoft();
  }

  /**
   * The sort control. Recency is the default because "what was I just doing"
   * is the question this view is opened for most often.
   *
   * It offers only the orders the CURRENT segment can actually carry out. It
   * used to offer all four everywhere and render on every segment, so:
   * "Most ahead" and "Stalest first" reordered nothing on Remotes and Tags
   * (a RefInfo has no divergence from the default branch) yet the button
   * relabelled itself, standing there naming an order the list was not in; and
   * on Stashes and Worktrees, which apply no sort at all, every one of the four
   * was inert. A control that states a false fact about the list beneath it is
   * worse than no control.
   */
  private branchSortBtn(rerender: () => void): HTMLElement | undefined {
    const LABELS: Record<string, string> = {
      recent: "Recently committed",
      name: "Name",
      ahead: "Most ahead",
      stale: "Stalest first",
    };
    // Stashes are a STACK — stash@{0} is the newest and the numbering is the
    // order — and worktrees are a handful of paths. Neither has an order to
    // choose, so neither gets a control.
    const keys = this.branchSortKeys();
    if (!keys.length) return undefined;
    // A segment can drop the order that is currently selected (switching from
    // Local to Tags with "Most ahead" active). Show the one it will really use.
    const shown = keys.includes(this.branchSort) ? this.branchSort : "recent";
    const b = el("button", "mini-btn branches-sort") as HTMLButtonElement;
    b.append(glyph("list-ordered"), span(LABELS[shown]));
    b.title = "How this list is ordered";
    b.setAttribute("aria-haspopup", "menu");
    b.addEventListener("click", () =>
      openMenu(
        b,
        keys.map((k) => ({
          label: LABELS[k],
          current: shown === k,
          onClick: () => {
            this.branchSort = k;
            rerender();
          },
        })),
      ),
    );
    return b;
  }

  /**
   * The repository's default branch, as a LOCAL branch name.
   *
   * `refs/remotes/<remote>/HEAD` has a symref of "<remote>/<branch>", and the
   * remote is not always called origin: `git clone -o upstream`, a
   * `git remote rename`, or simply a second remote whose name sorts first —
   * `refs:list` is refname-ordered, so the first symref found may be anyone's.
   * Stripping the literal "origin/" left "upstream/main", which no local branch
   * is ever named, and every check written against this value silently stopped
   * firing: no row got the "default" pill, the divergence bar rendered for the
   * default branch against itself, and the sweep's guard let `main` through
   * into a bulk delete.
   *
   * Strip the remote the ref actually names — on a remote HEAD `name` IS the
   * bare remote — which also keeps `origin/release/2.x` → `release/2.x` right.
   */
  private defaultBranchName(locals: BranchInfo[]): string | undefined {
    const head = this.refs.find((r) => r.type === "remote" && r.symref);
    const symref = head?.symref;
    if (symref) {
      const prefix = `${head!.name}/`;
      return symref.startsWith(prefix) ? symref.slice(prefix.length) : symref;
    }
    return locals.find((b) => b.current)?.name;
  }

  /** Which orders the segment on screen can honour. */
  private branchSortKeys(): Array<"recent" | "name" | "ahead" | "stale"> {
    if (this.branchTab === "local") return ["recent", "name", "ahead", "stale"];
    // A remote branch or a tag carries a date and a name, and nothing that
    // could answer "most ahead".
    if (this.branchTab === "remote" || this.branchTab === "tags") return ["recent", "name", "stale"];
    return [];
  }

  /** The order actually applied, once the segment has had its say. */
  private effectiveSort(): "recent" | "name" | "ahead" | "stale" {
    const keys = this.branchSortKeys();
    return keys.includes(this.branchSort) ? this.branchSort : "recent";
  }

  /** A worktree row. `worktree:list/add/remove/open` have existed in the IPC
   *  contract with no caller in any view — the cheapest capability in the app. */
  private worktreeRow(w: WorktreeInfo): HTMLElement {
    const actions: HTMLElement[] = [];
    if (!w.current) {
      const open = el("button", "row-btn") as HTMLButtonElement;
      open.textContent = "Open";
      open.setAttribute("aria-label", `Open the worktree at ${w.path}`);
      open.title = `Switch this window to ${w.path}`;
      open.addEventListener("click", () => void this.openWorktreeLive(w, open));
      actions.push(open);
    }
    const more = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    more.setAttribute("aria-label", `More actions for ${w.path}`);
    more.setAttribute("aria-haspopup", "menu");
    more.appendChild(glyph("ellipsis"));
    const menu = (): void =>
      openMenu(more, [
        { label: "Copy path", icon: "copy", onClick: () => void copyText(w.path, "Copied the path.") },
        { separator: true },
        {
          label: "Remove this worktree…",
          icon: "trash",
          danger: true,
          disabled: w.current,
          title: w.current ? "This is the worktree you are in" : undefined,
          onClick: () => void this.removeWorktreeLive(w),
        },
      ]);
    more.addEventListener("click", menu);
    actions.push(more);

    const pills: HTMLElement[] = [];
    if (w.current) {
      const p = span("this window", "ab-pill current");
      p.title = "The worktree this window has open";
      pills.push(p);
    }
    if (w.locked) pills.push(span("locked", "ab-pill unpublished"));
    if (w.prunable) {
      const p = span("prunable", "ab-pill gone");
      p.title = "Its directory is gone — git would prune this entry";
      pills.push(p);
    }

    const row = secRow({
      lead: glyph("window"),
      title: w.branch ?? (w.bare ? "(bare)" : w.head.slice(0, 7)),
      titleSuffix: pills,
      chips: [span(w.path, "br-subject")],
      meta: [span(w.head.slice(0, 7), "br-sha sec-mono")],
      time: "",
      actions,
      // A detached or bare worktree went to `copyText` here — so activating the
      // row performed a side effect on data the user owns (whatever was on
      // their clipboard), navigated nowhere, and disagreed with the row's own
      // "Open" button, while every other row in this view routes somewhere. It
      // has a HEAD, and a commit is a page.
      onOpen: () =>
        w.branch
          ? this.routeView("refdetail", false, { ref: w.branch, id: "head" })
          : this.routeView("commit", false, { sha: w.head }),
      ariaLabel: `${w.branch ?? w.head.slice(0, 7)} at ${w.path}${w.current ? ", this window" : ""}`,
    });
    row.classList.add("ref-row");
    row.dataset.ref = w.path;
    row.title = w.path;
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu();
    });
    return row;
  }

  /** Point this window at another worktree. */
  private async openWorktreeLive(w: WorktreeInfo, btn: HTMLButtonElement): Promise<void> {
    await this.refreshInPlace(btn, async () => {
      const repo = await host.invoke("worktree:open", w.path);
      if (!repo) {
        toast(`Couldn't open ${w.path}.`, "error");
        return;
      }
      toast(`Opened ${w.branch ?? w.path}.`, "success");
    });
  }

  /** Remove a worktree — the directory goes with it, so say so. */
  private async removeWorktreeLive(w: WorktreeInfo): Promise<void> {
    const ok = await confirmDialog({
      title: `Remove the worktree at ${w.path}?`,
      message:
        `git removes the directory as well as the entry. Any uncommitted work inside ` +
        `${w.path} goes with it. The branch ${w.branch ?? "it holds"} is not deleted.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const r = await host.invoke("worktree:remove", { path: w.path, force: false });
    if (!r.ok) {
      toast(r.message ?? "Couldn't remove the worktree.", r.expected ? "info" : "error");
      return;
    }
    toast("Worktree removed.", "success");
    await this.refreshBranchesSoft();
  }

  private async refreshBranchesSoft(): Promise<void> {
    if (this.currentView === "branches" && this.reloadBranchRows) {
      await this.reloadBranchRows();
    } else if (this.currentView === "branches") {
      void this.showBranchesView();
    }
  }

  /**
   * Fetch every remote, from the header.
   *
   * This existed only as a menu item inside ONE local branch's hover-revealed
   * ⋯ — the action that makes every ahead/behind number on the screen true,
   * two hover levels deep and attached to a row it has nothing to do with.
   */
  private async fetchAllLive(btn: HTMLButtonElement): Promise<void> {
    await this.refreshInPlace(btn, async () => {
      // Honour the preference, as the other two fetch call sites do. Passing
      // `undefined` here meant Settings → "Prune on fetch" was silently ignored
      // by the Fetch button on the view whose whole job is showing which
      // branches still exist — so a branch deleted on the remote stayed in the
      // list after exactly the action that should have removed it.
      const r = await host.invoke("sync:fetch", { prune: this.pruneOnFetchPref });
      if (!r.ok) {
        toast(r.message ?? "Fetch failed.", r.expected ? "info" : "error");
        return;
      }
      bust("branches");
      await this.refreshBranchesSoft();
      toast("Fetched from every remote.", "success");
    });
  }

  /** Push a branch that has never been pushed, and set its upstream. */
  private async publishBranchLive(b: BranchInfo, btn: HTMLButtonElement): Promise<void> {
    await this.refreshInPlace(btn, async () => {
      const r = await host.invoke("branch:push", { name: b.name });
      if (!r.ok) {
        toast(r.message ?? `Couldn't publish ${b.name}.`, r.expected ? "info" : "error");
        return;
      }
      bust("branches");
      await this.refreshBranchesSoft();
      toast(`Published ${b.name}.`, "success");
    });
  }

  /** The per-kind primary action in the header. Each segment has exactly one
   *  thing you come here to MAKE; Remotes has none, because Fetch is it. */
  private branchesCta(tab: "local" | "remote" | "tags" | "stashes" | "worktrees"): HTMLElement {
    const mk = (label: string, icon: string, title: string, run: () => void): HTMLElement => {
      const b = el("button", "mini-btn") as HTMLButtonElement;
      b.append(glyph(icon), span(label));
      b.title = title;
      b.addEventListener("click", run);
      return b;
    };
    if (tab === "local") {
      return mk("New branch", "add", "Create a branch from the current HEAD", () => void this.newBranch());
    }
    if (tab === "tags") {
      return mk("New tag", "tag", "Tag the current HEAD", () => void this.newTagHere());
    }
    if (tab === "stashes") {
      // The one screen that LISTS stashes could not make one.
      return mk("Stash changes", "archive", "Stash the working tree", () => void this.stashHere());
    }
    return el("span", "gh-head-cta-blank");
  }

  /** Tag the current HEAD, from the Tags segment's own CTA. */
  private async newTagHere(): Promise<void> {
    const name = await promptInline("Tag name", "v1.0.0");
    if (!name?.trim()) return;
    const msg = await promptInline(
      `Message for ${name.trim()}`,
      "Leave empty for a lightweight tag",
      "",
      "Create tag",
      true,
    );
    if (msg === null) return;
    const r = await host.invoke("tag:create", {
      name: name.trim(),
      message: msg.trim() || undefined,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't create the tag.", r.expected ? "info" : "error");
      return;
    }
    toast(`Created tag ${name.trim()}.`, "success");
    await this.refreshBranchesSoft();
  }

  /** Stash the working tree. The one screen that LISTS stashes could not make
   *  one — the verb lived only in the Changes view. */
  private async stashHere(): Promise<void> {
    const msg = await promptInline("Stash message", "What is this work?", "", "Stash", true);
    if (msg === null) return;
    const r = await host.invoke("stash:save", { message: msg.trim() || undefined });
    if (!r.ok) {
      toast(r.message ?? "Couldn't stash.", r.expected ? "info" : "error");
      return;
    }
    toast("Stashed your working changes.", "success");
    await this.refreshBranchesSoft();
  }

  /** Empty and error states per kind, each with the verb that fills it. */
  private branchesEmpty(
    tab: "local" | "remote" | "tags" | "stashes" | "worktrees",
    query: string,
    stashFailed: boolean,
    /** A facet or the Active/Stale cut is narrowing the list, and it is not the
     *  search box. Without this the view claimed the REPOSITORY was empty. */
    filtered = false,
    /** `worktree:list` threw. A failed read is not an empty list. */
    worktreeFailed = false,
    onClear?: () => void,
  ): HTMLElement {
    // What the reader calls this list, not the internal key. `tab` is
    // "local" / "remote" / "tags", and printing it produced "Nothing in local
    // matches …" and "No tag here matches …".
    const NOUN: Record<string, { one: string; many: string }> = {
      local: { one: "branch", many: "branches" },
      remote: { one: "remote branch", many: "remote branches" },
      tags: { one: "tag", many: "tags" },
      stashes: { one: "stash", many: "stashes" },
      worktrees: { one: "worktree", many: "worktrees" },
    };
    const noun = NOUN[tab] ?? { one: "ref", many: "refs" };

    // A NARROWING emptied it, not the repository. Both narrowings are named
    // when both are active: the search branch used to return first, so a search
    // that matched something and a facet that matched nothing blamed the search
    // box alone — and offered no way to clear the filter actually responsible.
    if (query || filtered) {
      const why =
        query && filtered
          ? `No ${noun.many} match “${query}” and the filters in effect.`
          : query
            ? `No ${noun.many} match “${query}”.`
            : `No ${noun.many} match the filters in effect.`;
      return emptyState("No matches", why, {
        icon: filtered ? "filter" : "search",
        anchor: "inline",
        // Offered whenever there is a filter to clear — a search you can see in
        // the box you typed it into needs no button, but a facet or an age cut
        // three controls away does.
        ...(filtered && onClear ? { action: { label: "Clear filters", onClick: onClear } } : {}),
      });
    }
    if (tab === "worktrees" && worktreeFailed) {
      return errorState(
        "Couldn't read the worktrees",
        "Git did not answer. Whether this repository has others is unknown, not settled.",
        () => void this.refreshBranchesSoft(),
      );
    }
    if (tab === "stashes" && stashFailed) {
      // A failed read is not an empty list — the old view swallowed the error
      // and rendered "no stashes" over a repo that has some.
      return errorState(
        "Couldn't read the stashes",
        "Git did not answer. The stash list is unknown, not empty.",
        () => void this.refreshBranchesSoft(),
      );
    }
    // Every segment, INCLUDING worktrees. `branchTab` is persisted across
    // launches, and the Worktrees segment only renders when there is more than
    // one — so a repo that loses its extra worktree, or whose `worktree:list`
    // fails (the catch turns that into `[]`), reopens on a segment with no
    // entry here. Destructuring undefined threw, and the whole Branches view
    // rendered blank with a console error nobody sees.
    const copy: Record<string, [string, string]> = {
      local: ["No branches yet", "Every repository has at least one — this read found none."],
      remote: ["No remote branches", "Nothing has been fetched yet. Fetch brings them in."],
      tags: ["No tags", "Tag a commit to mark a release or a milestone."],
      stashes: ["No stashes", "Stashing puts your working changes aside without committing them."],
      worktrees: [
        "No other worktrees",
        "A worktree checks out a second branch into its own directory, so you can work on two at once.",
      ],
    };
    const [title, desc] = copy[tab] ?? ["Nothing here", "This list is empty."];
    return emptyState(title, desc, { icon: tab === "stashes" ? "archive" : "git-branch" });
  }

  /**
   * One local branch, on the shared `secRow` anatomy.
   *
   * The old row was a bespoke two-line `div[role=button]` whose entire action
   * cluster was `opacity: 0` until hover — which is why every deeper verb had
   * to be exiled into a ⋯ menu, and why none of them could be reached by
   * keyboard or touch at all. One primary verb and the menu render at rest.
   */
  private localBranchRow(b: BranchInfo, defaultBranch?: string): HTMLElement {
    const pills: HTMLElement[] = [];
    const pill = (text: string, cls: string, title: string): HTMLElement => {
      const p = span(text, `ab-pill ${cls}`);
      p.title = title;
      return p;
    };
    if (b.current) pills.push(pill("current", "current", "This is the checked-out branch"));
    else if (b.name === defaultBranch) pills.push(pill("default", "default", "The repository's default branch"));
    if (b.gone) {
      // Without this the row reads "0 ahead, 0 behind" — the same shape as
      // perfectly in sync — about a remote that no longer exists, which is what
      // every merged pull request leaves behind.
      pills.push(
        pill(
          "upstream gone",
          "gone",
          `${b.upstream ?? "Its upstream"} no longer exists — this branch is probably finished with.`,
        ),
      );
    } else if (b.merged && !b.current && b.name !== defaultBranch) {
      pills.push(
        pill(
          "merged",
          "merged",
          `Every commit here is already in ${defaultBranch ?? "the default branch"} — safe to delete.`,
        ),
      );
    } else if (!b.upstream) {
      pills.push(pill("unpublished", "unpublished", "This branch has never been pushed"));
    }

    const chips: HTMLElement[] = [];
    // NO divergence bar.
    //
    // There used to be one here: two numbers either side of a 64px sparkline
    // showing distance from the default branch, scaled to the widest divergence
    // on screen. It cost about a hundred pixels on every row, it was the second
    // thing your eye hit after the name, and nobody could read a quantity off
    // it — the scale changed with whatever else happened to be listed. Those
    // hundred pixels came out of the branch NAME, which is the only thing
    // anyone scans this list for.
    //
    // The number is still available where it can be stated plainly: the
    // branch's own page, and the row tooltip. What stays on the row is the
    // ahead/behind pair, which is not decoration — it says what Push and Pull
    // will do, and the row has buttons for both.
    if (b.subject) chips.push(span(b.subject, "br-subject"));

    const meta: HTMLElement[] = [];
    const track = el("span", "br-track");
    // The upstream pair answers a DIFFERENT question from the bar: not "how far
    // from main" but "what will Push and Pull do".
    if (b.ahead) {
      const p = span(`↑ ${b.ahead}`, "ab-pill ahead");
      p.title = `${plural(b.ahead, "commit")} to push to ${b.upstream ?? "upstream"}`;
      track.appendChild(p);
    }
    if (b.behind) {
      const p = span(`↓ ${b.behind}`, "ab-pill behind");
      p.title = `${plural(b.behind, "commit")} to pull from ${b.upstream ?? "upstream"}`;
      track.appendChild(p);
    }
    // Only when it HAS a count. The slot is a fixed 78px so the pairs line up
    // down the list, and it was pushed onto every row — including the many with
    // nothing to push or pull, where it reserved 78px to align nothing at all
    // against a branch name that was being cut off four pixels short.
    if (track.childElementCount) meta.push(track);
    // The upstream, ONLY when it is not the obvious one.
    //
    // A 160px right-aligned column held `origin/<this branch's name>` on nearly
    // every row — the same string as the name three columns to its left, and
    // truncated from the LEFT, so a list of long branches read
    // "…ly-long-descriptive-name" over and over, identical on every line. It
    // told you nothing and it took its width from the name.
    //
    // A branch tracking a DIFFERENTLY named upstream is a real and surprising
    // fact, so that still shows.
    const conventionalUpstream = !!b.upstream && b.upstream.endsWith("/" + b.name);
    if (b.upstream && !conventionalUpstream) {
      meta.push(span(b.upstream, "br-upstream sec-mono"));
    }

    // ONE contextual primary verb, plus the menu. Delete deliberately does NOT
    // live on the row: it is one stray click away from a name you are scanning.
    const actions: HTMLElement[] = [];
    if (b.behind) {
      const pull = el("button", "row-btn") as HTMLButtonElement;
      pull.textContent = "Pull";
      pull.setAttribute("aria-label", `Pull ${b.name}`);
      pull.title = b.current
        ? `Pull ${plural(b.behind, "commit")} from ${b.upstream ?? "upstream"}`
        : `Pull ${plural(b.behind, "commit")} into ${b.name} — fast-forward, no checkout`;
      pull.addEventListener("click", () => void this.pullBranchLive(b, pull));
      actions.push(pull);
    } else if (!b.upstream) {
      const pub = el("button", "row-btn") as HTMLButtonElement;
      pub.textContent = "Publish";
      pub.setAttribute("aria-label", `Publish ${b.name}`);
      pub.title = `Push ${b.name} and set its upstream`;
      pub.addEventListener("click", () => void this.publishBranchLive(b, pub));
      actions.push(pub);
    } else if (!b.current) {
      const co = el("button", "row-btn") as HTMLButtonElement;
      co.textContent = "Checkout";
      co.setAttribute("aria-label", `Check out ${b.name}`);
      co.title = `Check out ${b.name}`;
      co.addEventListener("click", () => void this.checkoutRef(b.name, co));
      actions.push(co);
    }
    const moreBtn = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    moreBtn.setAttribute("aria-label", `More actions for ${b.name}`);
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.appendChild(glyph("ellipsis"));
    moreBtn.addEventListener("click", () => this.openBranchActions(b, moreBtn));
    actions.push(moreBtn);

    const row = secRow({
      lead: glyph(b.current ? "check" : b.name === defaultBranch ? "home" : "git-branch"),
      title: b.name,
      titleSuffix: pills,
      chips,
      meta,
      time: b.date ? relTime(b.date) : "",
      timeTitle: b.date ? absTime(b.date) : undefined,
      actions,
      // The row is a PLACE now, not a modal: it routes to the branch's own page.
      onOpen: () => this.routeView("refdetail", false, { ref: b.name, id: "head" }),
      // What the row says out loud, rather than "Inspect branch main".
      ariaLabel: [
        b.name,
        b.current ? "current branch" : "",
        b.gone ? "upstream gone" : b.merged ? "merged" : "",
        // The divergence as a FACT, not as the verbs the row's own buttons
        // carry — "3 to push, 5 to pull" beside a Pull button makes a screen
        // reader recite the actions back before it reaches them.
        b.ahead ? `${b.ahead} ahead` : "",
        b.behind ? `${b.behind} behind` : "",
        b.date ? `updated ${relTime(b.date)}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    });
    row.classList.add("branch-row");
    row.dataset.ref = b.name;
    row.title = [
      b.name,
      b.subject,
      // The divergence the bar used to draw, said in words.
      b.aheadDefault !== undefined && b.behindDefault !== undefined && b.name !== defaultBranch
        ? `${b.aheadDefault} ahead of and ${b.behindDefault} behind ${defaultBranch ?? "the default branch"}`
        : "",
      b.upstream && conventionalUpstream ? `tracking ${b.upstream}` : "",
      b.date ? absTime(b.date) : "",
    ]
      .filter(Boolean)
      .join("\n");
    // Right-click MIRRORS the menu — a shortcut, never a verb's only door.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openBranchActions(b, moreBtn);
    });
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
          ? `${plural(b.ahead, "commit")} to ${b.upstream}`
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
          const to = await promptInline("Rename branch", "new-name", b.name, "Rename");
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
          const up = await promptInline("Set upstream", "origin/" + b.name, b.upstream ?? "", "Set upstream");
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
          // `allowEmpty` so Cancel is distinguishable from a deliberate blank.
          // Without it both answered `null`, the flow could not tell them
          // apart, and cancelling the OPTIONAL second prompt created the tag
          // anyway — a Cancel that performs the action, on an object nothing in
          // the app can delete afterwards.
          const msg = await promptInline(
            "Tag message (optional — blank = lightweight)",
            "Release 1.0.0",
            "",
            "Create tag",
            true,
          );
          if (msg === null) return;
          await run("create tag", host.invoke("tag:create", { name: name.trim(), ref: b.name, message: msg.trim() || undefined }));
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
    // Deleting the LOCAL branch belongs here too. The row behind this menu
    // offered it as a plain "Delete" button while the menu — reached from the
    // branch's own peek, where you have just read its history and decided — did
    // not, so the peek was a dead end for the one decision it prepares you for.
    if (!b.current) {
      items.push({ separator: true });
      items.push({
        label: `Delete ${b.name}`,
        icon: "trash",
        danger: true,
        title: `Delete the local branch ${b.name}`,
        onClick: () => void this.deleteBranch(b.name),
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
    // The peek this was very likely launched from is ABOUT the branch that no
    // longer exists. Leaving it open left a card offering Checkout, Merge,
    // Rename and Push on a ref git would refuse — and a second Delete on
    // nothing. A mutation that invalidates a card's subject closes the card;
    // the stash peek already works this way.
    closePeek();
    bust();
    await this.refreshRefs();
    if (this.currentView === "branches") void this.showBranchesView();
  }

  /**
   * Check out a ref by name, then refresh refs + the view.
   *
   * `kind` is not decoration: it decides what checking out MEANS. A local head
   * attaches by name; a remote branch has to create a local tracking branch
   * (issues #12/#19); a tag genuinely detaches. Sending a name down the plain
   * `checkout` action instead runs `git checkout origin/foo`, which detaches
   * HEAD onto the remote-tracking ref — no branch, no upstream, and the next
   * commit lands where nothing points at it, under a toast saying "Checked out
   * foo."
   */
  private async checkoutRef(
    ref: string,
    btn?: HTMLElement,
    kind: "head" | "remote" | "tag" = "head",
  ): Promise<void> {
    // Checking out is the slowest thing this list does — it rewrites the working
    // tree — and it used to show nothing at all while it ran, so the row looked
    // like it had ignored the click.
    const b = btn as HTMLButtonElement | undefined;
    if (b?.disabled) return;
    const label = b?.textContent ?? "";
    if (b) {
      b.disabled = true;
      b.classList.add("is-busy");
      b.textContent = "Checking out…";
    }
    const restore = (): void => {
      if (!b || !b.isConnected) return;
      b.disabled = false;
      b.classList.remove("is-busy");
      b.textContent = label;
    };
    let result;
    try {
      result = await host.invoke("commit:action", {
        action: "checkout-ref",
        // `sha` is required by the request shape but unused on this path; the
        // ref travels in `name`, where the kind can be applied to it.
        sha: ref,
        name: ref,
        refKind: kind,
      } as Parameters<App["runAction"]>[0]);
    } catch (e) {
      restore();
      toast(cleanErr(e) || "Couldn't check out.", "error");
      return;
    }
    restore();
    // On failure (e.g. uncommitted changes block the switch) HEAD didn't move —
    // surface the error and DON'T refresh as if it succeeded (which made the UI
    // look like the branch was checked out when it wasn't).
    //
    // `result` is typed non-nullable but arrives over IPC: a channel that
    // failed to register, or a main-process throw, hands back undefined, and
    // reading `.ok` off it threw inside an async handler — no toast, no error,
    // the click simply did nothing.
    if (!result?.ok) {
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
      heads.find((r) => !r.isCurrent && r.name !== head)?.name ??
      // …and past the local branches. A fresh clone has ONE local head, and
      // stopping here left the view announcing that the repository has nothing
      // to compare against while the picker eight pixels above it listed every
      // remote-tracking branch and tag in the repo. The upstream is the base
      // anyone actually wants there.
      this.refs.find((r) => r.type === "remote" && r.name.endsWith(`/${head}`))?.name ??
      this.refs.find((r) => r.type === "remote")?.name;

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
      // Both sides, or neither. With only one local branch there is no base to
      // start with, and this exchanged `undefined` into the HEAD slot: the
      // picker rendered an icon, a chevron and an EMPTY label, and the
      // comparison ran against nothing.
      if (!this.compareBase || !this.compareHead) return;
      [this.compareBase, this.compareHead] = [this.compareHead, this.compareBase];
      setLabel(baseBtn, this.compareBase);
      setLabel(headBtn, this.compareHead);
      void runCompare();
    });
    /** Swap needs two sides to exchange. */
    const syncSwap = (): void => {
      const ok = !!this.compareBase && !!this.compareHead;
      (swap as HTMLButtonElement).disabled = !ok;
      swap.title = ok ? "Swap base and compare" : "Pick a base first";
      swap.setAttribute("aria-label", swap.title);
    };
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
    markSegment(seg, "Comparison view", ".cmp-seg-btn");
    const summary = el("div", "cmp-summary");
    // The one action GitHub makes PRIMARY on a comparison was missing entirely:
    // you could line up base…head, read every commit and file — and then had
    // to rebuild the same comparison on github.com to open the PR. The button
    // carries this exact base/head into the create form.
    const prBtn = el("button", "mini-btn cmp-pr-btn") as HTMLButtonElement;
    prBtn.append(glyph("git-pull-request"), span("Create pull request"));
    prBtn.title = "Open a pull request from this comparison";
    prBtn.hidden = true;
    /** Whether GitHub could take a pull request at all — the swr answer, kept.
     *
     *  It used to be applied straight to `prBtn.hidden`, and the base===head
     *  path then hid the button on its own. Nothing ever un-hid it: the swr
     *  callback had already delivered its cached answer and never fires again,
     *  and the success path never touched the button. So picking your own
     *  current branch as the base once removed "Create pull request" for the
     *  rest of the session — the view's whole purpose, gone, with no way back
     *  short of a reload. */
    let canPr = false;
    /** The two conditions, kept apart and re-asserted on every exit. */
    const syncPrBtn = (): void => {
      prBtn.hidden = !(canPr && !!this.compareBase && this.compareBase !== this.compareHead);
    };
    prBtn.addEventListener("click", () =>
      void openCreatePr(() => this.routeView("prs", true), {
        base: this.compareBase,
        head: this.compareHead,
      }),
    );
    // Through the cache, not a fresh round trip on every route. Whether you are
    // signed in to GitHub cannot change between two clicks in the same app, and
    // asking again each time was one of two calls that fired on EVERY entry to
    // Compare and Changes — latency spent to re-learn something we already knew.
    swr("github:status", undefined, {
      // Signing in or out busts the cache explicitly, so a minute of staleness
      // costs nothing and saves a round trip on every single route.
      ttl: 60_000,
      alive: () => prBtn.isConnected,
      onData: (s) => {
        canPr = s.connected && !!s.repo;
        syncPrBtn();
      },
    });
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
      // "Comparing main … feature" belongs on a comparison you have not seen.
      // Re-entering Compare on the SAME two refs used to blank the result and
      // re-run the whole comparison, so returning to a screen you had just left
      // cost a git round trip and a flash of a loading card — for an answer that
      // was already on the page a second earlier.
      const cmpKey =
        this.compareBase && this.compareHead
          ? { base: this.compareBase, head: this.compareHead, mode: this.compareMode }
          : undefined;
      if (!cmpKey || peek("compare:refs", cmpKey) === undefined) {
        body.replaceChildren(loadingState(`Comparing ${this.compareBase} … ${this.compareHead}`));
      }
      // The previous comparison's answer is no longer an answer to anything.
      // `last` was only reassigned on the success path, so the early return
      // below left it holding the PRIOR result — and the Commits/Changed-files
      // panes went on rendering those commits and files as though they were the
      // comparison now on screen, for refs that were never compared.
      last = undefined;
      // …and so are the numbers derived from it. `last` was nulled because the
      // previous comparison's answer is no longer an answer to anything — but
      // only the body honoured that. The summary and both tab badges went on
      // showing the previous comparison's counts while a new one loaded, so
      // "Comparing A … B" sat directly under "12 commits · 9 files" describing
      // an entirely different pair of refs.
      summary.textContent = "";
      commitsCount.textContent = "";
      filesCount.textContent = "";
      syncPrBtn();
      syncSwap();
      // Nothing to compare yet (a single-branch repo, or base === head):
      // prompt for a second ref instead of running a doomed comparison.
      if (!this.compareBase || this.compareBase === this.compareHead) {
        summary.textContent = "";
        commitsCount.textContent = "";
        filesCount.textContent = "";
        // …and you cannot open a pull request from a branch to itself. Through
        // `syncPrBtn`, which owns BOTH conditions — a bare `hidden = true` here
        // is what made this state permanent.
        syncPrBtn();
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
      // Through the cache: comparing the same two refs twice should not re-run
      // the comparison. Any mutation that could change the answer already calls
      // bust(), so this cannot go stale behind the user's back.
      const res = await gget(
        "compare:refs",
        { base: this.compareBase, head: this.compareHead!, mode: this.compareMode },
        15_000,
      );
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
      // The COUNT is the real one; the LIST may be the first page of it. Showing
      // `commits.length` made a 400-commit cap read as a fact, printed beside a
      // `behind` that genuinely was one.
      const n = res.ahead ?? res.commits.length;
      const m = res.files.length;
      commitsCount.textContent = String(n);
      filesCount.textContent = String(m);
      summary.textContent =
        n === 0 && m === 0
          ? `${this.compareHead} is up to date with ${this.compareBase}.`
          : `${n} commit${n === 1 ? "" : "s"} · ${m} file${m === 1 ? "" : "s"} changed` +
            // "redesign/issues-detail is 2 ahead" made the reader work out
            // whose commits those were; say it straight.
            (res.behind > 0
              ? ` · ${res.behind} commit${res.behind === 1 ? "" : "s"} only on ${this.compareBase}`
              : "");
      renderBody();
    };
    void runCompare();
  }

  /** Commits-only view: the commits `compare` adds over `base`. */
  private renderCompareCommits(body: HTMLElement, res: CompareResult | undefined): void {
    body.replaceChildren();
    // A capped list has to say it is capped, or the rows read as the whole set.
    const capNote = (): void => {
      if (!res?.commitsTruncated) return;
      const note = el("div", "list-cap-note");
      // NOT "the first": the list reads oldest-first, but the cap keeps the
      // NEWEST N — so "first" named the wrong end of the range it dropped.
      note.textContent = `Showing ${res.commits.length} of ${res.ahead} commits — the most recent.`;
      body.appendChild(note);
    };
    if (!res || !res.commits.length) {
      body.appendChild(
        emptyState("No commits", "These refs share the same history in this direction.", {
          icon: "git-commit",
        }),
      );
      return;
    }
    // The SAME list the pull request's Commits tab draws. Both surfaces built
    // their own rows out of the same five fields and had drifted apart: this
    // one still announced "reveal in the graph" to assistive tech long after
    // the click had been changed to open the commit page.
    body.appendChild(
      commitList(
        res.commits.map((c) => ({
          sha: c.sha,
          shortSha: c.shortSha,
          subject: c.subject,
          body: c.body,
          author: c.author,
          date: c.date,
          isMerge: c.isMerge,
        })),
        {
          onOpen: (sha) => this.routeView("commit", false, { sha }),
          onCopy: (sha) => void copyText(sha, "Copied the full SHA."),
        },
      ),
    );
    capNote();
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

    // Release the previous surface BEFORE taking its handle. Overwriting the
    // handle orphaned a live Monaco editor — its models, its DOM and its
    // listeners all still attached, with nothing left holding a reference to
    // dispose them. Every rebuild of this pane leaked one. Every other
    // assignment site already does this.
    this.activeMonacoView?.dispose();
    // The SAME panel every other diff surface uses — which is where the
    // Inline/Split toggle lives. Compare had its own class (`CompareDiff`), so
    // it had no toggle at all: "on the compare its missing the switch to toggle
    // inline vs split view". Monaco's own width-driven
    // `useInlineViewWhenSpaceIsLimited` was deciding for you, invisibly, and
    // the segmented control already in Compare's header is the two-dot /
    // three-dot RANGE toggle — so the switch looked present and was the wrong
    // one.
    const diff = new DiffPanel(right);
    this.activeMonacoView = diff;
    diff.showEmpty("Select a changed file to view its diff.");

    let activeRow: HTMLElement | undefined;
    const open = (path: string, row: HTMLElement, oldPath?: string): void => {
      if (activeRow) activeRow.classList.remove("active");
      activeRow = row;
      row.classList.add("active");
      void this.openCompareFile(diff, path, oldPath);
    };

    res.files.forEach((f, i) => {
      // Same two-line treatment the Changes list uses: the FILE NAME, then its
      // directory. One path printed whole in a 370px column truncated from the
      // right, which ate the only part that tells two files apart
      // ("apps/desktop/src/renderer/diffPan…").
      const row = el("button", `file-row dc-file status-${f.status}`);
      const st = el("span", "file-status");
      st.textContent = f.status;
      const cut = f.path.lastIndexOf("/");
      const meta = el("div", "dc-file-meta");
      meta.appendChild(span(cut < 0 ? f.path : f.path.slice(cut + 1), "dc-file-name"));
      if (cut > 0) meta.appendChild(span(f.path.slice(0, cut), "dc-file-dir"));
      row.append(st, meta);
      row.title = f.path;
      row.addEventListener("click", () => open(f.path, row, f.oldPath));
      fileScroll.appendChild(row);
      if (i === 0) open(f.path, row, f.oldPath); // auto-open the first file
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
  private wireCompareResizer(divider: HTMLElement, left: HTMLElement, diff: DiffPanel): void {
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

  private async openCompareFile(diff: DiffPanel, path: string, oldPath?: string): Promise<void> {
    // The same staleness guard openFile and openWorkingFile already use, and
    // the only diff surface that was missing it. Click a big file then a small
    // one and the big one's response lands last and paints over your actual
    // selection — after which the file list and the pane disagree, and nothing
    // short of picking a third file resolves it.
    const gen = ++this.diffGen;
    const fileDiff = await host.invoke("compare:fileDiff", {
      base: this.compareBase!,
      head: this.compareHead!,
      path,
      // A rename's base side lives under the OLD name.
      leftPath: oldPath,
      mode: this.compareMode,
    });
    if (gen !== this.diffGen) return;
    if (fileDiff) {
      // A file CAN legitimately have identical text on both sides — a mode
      // change, or a rename with no edit — and `diff.show` says so itself.
      diff.showDiff(fileDiff);
      return;
    }
    // No answer is not the same as "no difference".
    //
    // `compareFileDiff` returns undefined only when there is no repository open
    // or a ref failed its safety check — never because the two sides matched.
    // Printing "These two refs have identical content for this file." asserted
    // equality the app had no basis for, about a file that is in the changed
    // list PRECISELY BECAUSE it differs. The same laundering of an absent
    // answer into a reassuring one as "working tree clean" over uncommitted
    // work, on a smaller surface.
    diff.showEmpty(
      `${path} is listed as changed between these refs, so this is a failure to read it — not two sides that match.`,
      { title: "Couldn't load this file's diff", kind: "error" },
    );
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
    markSegment(seg, "Theme");

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
    const syncLogoPreview = (): void => {
      const light = this.dockVariant() === "light";
      preview.src = light ? "./icon-light.png" : "./icon.png";
      preview.alt = `Dock icon preview — the ${light ? "light" : "dark"} mark`;
      preview.title = preview.alt;
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
    markSegment(logoSeg, logoLabel);
    syncLogoPreview();
    // Let a theme change from anywhere else — ⌘K, the menu, an OS flip — bring
    // these two controls up to date without rebuilding the page around them.
    this.syncAppearanceCard = (): void => {
      // NOT gated on `seg.isConnected`. Settings is a keep-alive view, so
      // leaving it PARKS this card — detached, and re-attached verbatim on
      // return. The guard that used to sit here unsubscribed the hook on the
      // way out, so a theme changed from anywhere else while you were away
      // left the card showing the old one for the rest of the session, with
      // its highlight and its `aria-pressed` both stale.
      //
      // Nothing accumulates: this is a single slot, overwritten by the next
      // build, so at most one closure is ever held. Same lesson the Assistant's
      // `gs:ai-changed` listener carries — an `isConnected` guard on a
      // keep-alive view fires on precisely the path that matters.
      btns.forEach((b, i) => b.classList.toggle("active", modes[i].id === this.themeMode));
      logoBtns.forEach((b, i) => b.classList.toggle("active", logoModes[i].id === this.logoMode));
      // `aria-pressed` too, not just the class. `markSegment` keeps it in step
      // from a delegated CLICK listener, so a theme changed from anywhere else
      // — ⌘K, the menu, an OS flip — moved the highlight while leaving the
      // announced state on the button that is no longer chosen.
      for (const b of [...btns, ...logoBtns]) {
        b.setAttribute("aria-pressed", String(b.classList.contains("active")));
      }
      syncLogoPreview();
    };
    // The preview trails the segment so the card's two segmented controls keep
    // one left edge. What made it read as a fourth segment was its BORDER —
    // a bordered, rounded box a hair from three bordered, rounded buttons —
    // so it lost the border, gained a plinth, and stands off by --sp-4.
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
    markSegment(seg, label);
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
    // A checkbox's own text, not a group heading — micro-caps would shout a
    // whole sentence at you.
    const askTitle = el("div", "settings-check-title");
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

    // The list of every clone on this machine used to live here, 480px down a
    // preferences page — with Open, Reveal in Finder and Delete from disk on
    // each row. Choosing which repository to work on is the most frequent thing
    // anyone does in a Git client and the one thing that must happen before
    // anything else works; burying it under "Settings" put it behind the least
    // likely door. And nothing on a preferences page should be able to move
    // 2GB of someone's work to the Trash: Settings is where reversible knobs
    // live. It has its own surface now, reachable from the repository chip in
    // the top bar (and from ⌘K). What stays here is the actual preference —
    // where clones land — plus a way in.
    const manageRow = el("div", "settings-clonedir-row");
    const manageText = el("div", "settings-clonedir-text");
    const manageLabel = el("div", "settings-field-label");
    manageLabel.textContent = "On this machine";
    const manageSub = el("div", "settings-sub");
    manageSub.textContent = "Open, reveal or remove any clone GitStudio knows about.";
    manageText.append(manageLabel, manageSub);
    const manageBtn = el("button", "mini-btn") as HTMLButtonElement;
    manageBtn.append(glyph("repo"), span("Manage repositories…"));
    manageBtn.addEventListener("click", () => this.openRepoManager());
    manageRow.append(manageText, manageBtn);

    body.append(sub, row, askRow, manageRow);
    return card;
  }

  /**
   * Every clone on this machine, as a surface of its own.
   *
   * Moved out of Settings wholesale — the same rows, the same actions — so that
   * picking a repository is one gesture from the repository chip instead of a
   * scroll through preferences, and so that "Delete from disk" sits in a file
   * management context rather than beside the theme switcher.
   */
  private openRepoManager(): void {
    const body = el("div", "repo-manager");
    const sub = el("div", "settings-sub");
    sub.textContent =
      "Every clone GitStudio knows about — the ones in your clone folder plus anything you've opened.";
    const list = el("div", "settings-copies");
    list.appendChild(loadingState("Looking for local copies…"));

    const renderCopies = (copies: LocalCopy[]): void => {
      list.replaceChildren();
      if (!copies.length) {
        list.appendChild(
          emptyState(
            "No local copies yet",
            "Open or clone a repository and it will show up here.",
            {
              icon: "repo",
              action: {
                label: "Clone repository…",
                icon: "cloud-download",
                onClick: () => openCloneDialog((root) => void this.openPath(root)),
              },
            },
          ),
        );
        return;
      }
      for (const c of copies) list.appendChild(this.localCopyRow(c, renderCopies));
    };
    void host
      .invoke("repos:local", undefined)
      .then(renderCopies)
      .catch((e) => {
        list.replaceChildren(
          emptyState("Couldn't list local copies", cleanErr(e) || "Try again in a moment."),
        );
      });

    openModal((close) => {
      const card = el("div", "modal-card repo-manager-card");
      const h = el("div", "modal-title");
      h.textContent = "Repositories";
      card.append(h, sub, list);

      const actions = el("div", "modal-actions");
      const openBtn = el("button", "mini-btn") as HTMLButtonElement;
      openBtn.append(glyph("folder-opened"), span("Open repository…"));
      openBtn.addEventListener("click", () => {
        close();
        void this.openRepo();
      });
      const cloneBtn = el("button", "btn btn-primary") as HTMLButtonElement;
      cloneBtn.append(glyph("cloud-download"), span("Clone repository…"));
      cloneBtn.addEventListener("click", () => {
        close();
        openCloneDialog((root) => void this.openPath(root));
      });
      const doneBtn = el("button", "mini-btn") as HTMLButtonElement;
      doneBtn.textContent = "Done";
      doneBtn.addEventListener("click", close);
      actions.append(openBtn, cloneBtn, doneBtn);
      card.appendChild(actions);

      return { card, focusEl: cloneBtn, label: "Repositories", onClose: () => {} };
    });
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

    // ONE shape for every row: the thing you'd actually do, spelled out, plus
    // an overflow menu for the rest. The cluster used to be two to five
    // unlabelled icons whose set changed with an invisible flag — two rows
    // both badged MANAGED offered different buttons because one happened to
    // also be in recents. A toolbar that changes shape per row can't be
    // scanned; a menu whose ITEMS vary by what's possible can.
    const acts = el("div", "settings-copy-acts");
    if (!c.missing && !c.current) {
      acts.appendChild(
        textBtn("Open", `Open ${c.name} in GitStudio`, () => void this.openPath(c.root), false, c.name),
      );
    }

    const items: MenuItem[] = [];
    if (!c.missing) {
      items.push({
        label: "Reveal in Finder",
        icon: "link-external",
        onClick: () => {
          void host
            .invoke("repos:reveal", c.root)
            .catch(() => toast("Couldn't reveal that folder.", "error"));
        },
      });
    }
    items.push({
      label: "Copy path",
      icon: "copy",
      onClick: () => void copyText(c.root, "Path copied."),
    });
    if (c.recent) {
      items.push({
        label: "Remove from recents",
        sub: "Keeps the folder on disk",
        icon: "close",
        onClick: () => {
          void host
            .invoke("repos:removeRecent", c.root)
            .then(refresh)
            .catch((e) => toast(cleanErr(e) || "Couldn't update the list.", "error"));
        },
      });
    }
    if (c.managed && !c.current && !c.missing) {
      items.push({ separator: true });
      items.push({
        label: "Delete from disk",
        sub: `Moves ${c.name} to the Trash`,
        icon: "trash",
        danger: true,
        onClick: () => {
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
        },
      });
    }
    const more = el("button", "icon-btn settings-copy-more");
    more.title = `More actions for ${c.name}`;
    more.setAttribute("aria-label", more.title);
    more.appendChild(glyph("kebab-horizontal"));
    more.addEventListener("click", () => openMenu(more, items));
    acts.appendChild(more);

    row.appendChild(acts);
    return row;
  }

  /** Resolves once the account card's async body has painted — see below. */
  private accountCardReady: Promise<unknown> = Promise.resolve();

  private settingsAccountCard(): HTMLElement {
    const { card, body } = settingsCard("GitHub Account", "github");
    body.appendChild(loadingState());
    // AWAITABLE. `showSettingsView` returns as soon as the card's shell is in
    // the DOM, and everything the card actually shows arrives in this async
    // body — so "Switch account", which awaits `showSettingsView()` and then
    // looks for the new Sign-in button, was searching a card that still held a
    // loading spinner. It found nothing, started nothing, and left you signed
    // out: a quieter Sign out under a label promising the opposite.
    this.accountCardReady = (async () => {
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
        // Switching means signing in as SOMEONE ELSE. This ran the sign-out
        // code and stopped there — not even the toast — so the button labelled
        // "Switch account" was a quieter Sign out that left you on a
        // signed-out card with nothing started and no account to switch to.
        switchBtn.addEventListener("click", async () => {
          await host.invoke("github:disconnect", undefined);
          await this.authChanged();
          // AWAITED, so the card really has been rebuilt before the new
          // sign-in is opened against it. (Not a rAF: the callback would fire
          // before the async rebuild had replaced the card.)
          await this.showSettingsView();
          // …and for the card INSIDE it, which paints on its own promise.
          await this.accountCardReady;
          const fresh = document.querySelector<HTMLElement>(".settings-view");
          const btn = fresh
            ? [...fresh.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
                /sign in with github/i.test(b.textContent ?? ""),
              )
            : undefined;
          btn?.click();
        });
        const signOut = el("button", "mini-btn danger");
        signOut.append(span("Sign out"));
        signOut.addEventListener("click", async () => {
          await host.invoke("github:disconnect", undefined);
          await this.authChanged();
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
    })().catch(() => {
      /* the card shows its own error; the promise exists only to be awaited */
    });
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
      const manage = el("button", "mini-btn") as HTMLButtonElement;
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
    const versionRow = el("div", "settings-sub");
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

    // One action language per card: a bordered button beside a bare purple
    // text link made two peers look like a control and a footnote. Leaving the
    // app is a mini-btn with an external glyph everywhere else in the product.
    const repo = el("button", "mini-btn") as HTMLButtonElement;
    repo.append(glyph("link-external"), span("View the project on GitHub"));
    repo.addEventListener("click", () =>
      window.open("https://github.com/GitStudioHQ/gitstudio", "_blank"),
    );
    updRow.insertBefore(repo, status);
    body.append(sub, versionRow, updRow);
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
    refreshBtn.addEventListener("click", () =>
      // BUST first. The listing is read through `gget("repo:tree", …)`, so a
      // Refresh that only re-ran the view was answered from the cache — the
      // commit bar and the README (which fetch separately) updated while the
      // file list beneath them did not, which is the one thing Refresh is
      // pressed for.
      void this.refreshInPlace(refreshBtn, () => {
        bust("repo:tree");
        return this.showCodeView();
      }),
    );
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
    // The view's own keys — "/" to jump to the filter, Backspace to go up a
    // folder — are bound on `wrap`, so they only fire for keys pressed INSIDE
    // it. Nothing here had focus after a render, so both were dead until you
    // happened to click a row first, while the filter placeholder went on
    // advertising "(/)". Making the view itself the focus target fixes that and
    // the more general "nothing is focused after a folder hop".
    wrap.tabIndex = -1;
    if (document.activeElement === document.body || document.activeElement === null) {
      wrap.focus({ preventScroll: true });
    }

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

    if (!sorted.length) {
      colhead.hidden = true;
      // A subfolder can be empty too — and used to render as a bare card with
      // nothing in it and nothing said, which reads as a failed load rather
      // than as an answer. The repository-level copy is only right at the root.
      listing.appendChild(
        this.codePath
          ? emptyState(
              "This folder is empty",
              `${this.codePath} has no tracked files at HEAD.`,
              { icon: "folder" },
            )
          : emptyState("Empty repository", "No tracked files at HEAD yet."),
      );
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
        else this.goCodeFile(e.path);
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
              if (/\.[A-Za-z0-9]{1,8}$/.test(p.split("/").pop() ?? "")) this.goCodeFile(p);
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
    const seed = hc.authorEmail || hc.author;
    av.style.setProperty("--av", avatarHue(seed));
    av.style.setProperty("--av-ink", avatarInk(seed));

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
  /** Open a file AS A NAVIGATION — the sibling of `goCodePath` for blobs. The
   *  folder rides along so Back returns to the listing the file came from. */
  private goCodeFile(path: string): void {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.routeView("code", true, { path: dir, file: path });
  }

  private async openCodeFile(path: string): Promise<void> {
    const wrap = el("div", "code-view code-file-view");
    const back = el("button", "mini-btn");
    back.append(glyph("arrow-left"), span("Back"));
    // Through routeView, like every other hop in this view — a bare
    // `showCodeView()` repainted the listing without telling the navigation
    // history anything, so the top-bar Back chevron (and ⌘[) still pointed at
    // whatever you were doing before you opened the file: pressing it from the
    // listing jumped out of Code entirely, and Forward came back to the FILE,
    // a page you had already left.
    back.addEventListener("click", () =>
      this.goCodePath(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""),
    );
    // The tree header carries a clickable trail, a count and a filter; opening a
    // file used to replace all of it with "Back" and a raw path string, so the
    // routine things — go up a folder, copy this path, see it on GitHub, reload
    // it — all became "Back, then find the file again".
    const crumbs = el("div", "code-crumbs code-file-crumbs");
    const parts = path.split("/");
    const seg = (label: string, dir: string, isLast: boolean): void => {
      const btn = el("button", "code-crumb" + (isLast ? " is-current" : ""));
      btn.append(glyph(isLast ? "file" : dir === "" ? "repo" : "folder"), span(label));
      if (!isLast) btn.addEventListener("click", () => this.goCodePath(dir));
      crumbs.appendChild(btn);
      if (!isLast) crumbs.appendChild(span("/", "code-crumb-sep"));
    };
    seg(this.currentRepo?.name ?? "repo", "", false);
    parts.forEach((p, i) => {
      seg(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    });

    const copyBtn = el("button", "topbar-icon");
    copyBtn.title = "Copy this file's path";
    copyBtn.setAttribute("aria-label", copyBtn.title);
    copyBtn.appendChild(glyph("copy"));
    copyBtn.addEventListener("click", () => void copyText(path, "Path copied."));

    const reloadBtn = el("button", "topbar-icon");
    reloadBtn.title = "Reload this file";
    reloadBtn.setAttribute("aria-label", reloadBtn.title);
    reloadBtn.appendChild(glyph("refresh"));
    reloadBtn.addEventListener("click", () =>
      void this.refreshInPlace(reloadBtn, () => this.openCodeFile(path)),
    );

    const bar = el("div", "code-head");
    bar.append(back, crumbs, el("div", "topbar-spacer"), copyBtn, reloadBtn);
    const surface = el("div", "diff-surface code-file-surface");
    // Something to look at while the read lands. The surface was mounted empty
    // and filled only once the file came back, so opening or reloading a file
    // showed a blank pane under a full toolbar — indistinguishable from a file
    // that is genuinely empty, or from a load that failed. Every other surface
    // in the app paints a skeleton first.
    surface.appendChild(skeletonList(8, false));
    wrap.append(bar, surface);
    this.viewHost.replaceChildren(wrap);

    // Reuse one viewer; dispose any prior Monaco surface so files don't leak.
    this.activeMonacoView?.dispose();
    const viewer = new ReadonlyFileView(surface);
    this.activeMonacoView = viewer;
    // Which route this read belongs to. `routeView` disposes `activeMonacoView`
    // and clears it the moment you navigate, so leaving while this fetch is in
    // flight meant the editor was built AFTER its owner had let go of it: a
    // Monaco instance in a detached node, with nothing holding a reference that
    // could ever dispose it. `showCodeView` already guards its own read this
    // way; this one did not.
    const gen = this.routeGen;
    const file = await host.invoke("repo:file", { path });
    if (gen !== this.routeGen || !surface.isConnected) {
      viewer.dispose();
      return;
    }
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
    // Built from the awaited `head:get` (what the top bar uses), not from
    // `refs`, which is filled by a fire-and-forget refreshRefs() and is empty
    // on first paint — the old fallback told you that you were on a detached
    // HEAD while the top bar said "main" one row above. When HEAD is not known
    // yet the label is a placeholder that syncComposerBranch() fills in.
    const head = this.headInfo;
    const refsKnown = !!head;
    const curBranch =
      head && !head.detached
        ? head.branch
        : this.refs.find((r) => r.type === "head" && r.isCurrent)?.name;
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
    // The repo this composer BELONGS to, captured now — not read at event time.
    // An `input` fires for a streaming AI message too, and that stream outlives
    // a repo switch: repo A's generated message landed in repo B's box, stamped
    // with B, so the guard above then PROTECTED it and it survived every later
    // re-open of B. Stamping the repo the composer was built for makes the
    // guard drop it instead, which is what it is for.
    const composerRepo = this.currentRepo?.root;
    // The caret, not just the text. `showChangesView()` rebuilds this whole
    // subtree on every stage, unstage, discard and filesystem-watcher tick, and
    // a rebuilt textarea is a NEW element: focus fell to <body> and the caret
    // went to 0. Typing a paragraph of commit message while a build tool
    // touched a file meant the next keystroke landed at the START of it.
    const rememberCaret = (): void => {
      this.composerDraft.caret = { start: textarea.selectionStart, end: textarea.selectionEnd };
    };
    for (const ev of ["keyup", "click", "select", "input"] as const) {
      textarea.addEventListener(ev, rememberCaret);
    }
    textarea.addEventListener("input", () => {
      this.composerDraft.message = textarea.value;
      // Whose draft this is. Without it the reset above cannot tell a repo
      // SWITCH (drop it) from a re-open of the same repo (keep it).
      this.composerDraftRoot = composerRepo;
    });
    /**
     * Put text in the composer the way a keystroke would.
     *
     * Assigning `.value` fires no `input` event, so everything hanging off that
     * event goes stale: the surviving draft, and — worse — the commit buttons'
     * enabled state. Ticking "Amend last commit" prefilled the previous
     * message and then left BOTH Commit and Commit & Push greyed out, insisting
     * you "write a commit message first" while it sat in front of you.
     */
    /** The exact text the amend prefill put in the box, while it is untouched. */
    let prefilled: string | undefined = this.composerDraft.prefilled;
    const setMessage = (text: string): void => {
      textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    textarea.addEventListener("input", () => {
      if (prefilled !== undefined && textarea.value !== prefilled) {
        prefilled = undefined;
        this.composerDraft.prefilled = undefined;
        this.composerDraft.prefilled = undefined;
      }
    });
    // ⌘/Ctrl+Enter commits. Every commit box in every tool does this, and here
    // it did nothing at all — the only way to commit was to leave the keyboard.
    textarea.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (commitBtn.hasAttribute("disabled")) return;
      commitBtn.click();
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
      syncCommitLabel();
      // Amending needs no changes — rewording the last commit is a commit with
      // nothing staged — so the enable rule has to be re-evaluated here too.
      syncCommitEnabled();
      // Prefill the last commit message when amending an empty composer.
      if (amend && !textarea.value.trim()) {
        void host.invoke("repo:headCommit", undefined).then((hc) => {
          // The WHOLE message. Prefilling only the subject meant that ticking
          // Amend and pressing commit silently deleted the body and every
          // trailer — the box looked like the commit, so nothing warned you.
          const prefill = hc?.message || hc?.subject;
          if (amend && prefill && !textarea.value.trim()) {
            setMessage(prefill);
            prefilled = prefill;
            this.composerDraft.prefilled = prefill;
          }
        });
      } else if (!amend && prefilled !== undefined && textarea.value === prefilled) {
        // Un-ticking takes the prefill back. It is the LAST COMMIT'S text, and
        // leaving it in the box with amend off armed the composer to create a
        // brand-new commit carrying the previous one's exact message — with
        // nothing on screen to distinguish it from something you wrote. Only
        // withdrawn when untouched: the moment you edit it, it is yours.
        setMessage("");
        prefilled = undefined;
      }
    });
    signoffToggle.addEventListener("click", () => {
      signoff = !signoff;
      this.composerDraft.signoff = signoff;
      signoffToggle.classList.toggle("is-on", signoff);
      signoffToggle.setAttribute("aria-checked", signoff ? "true" : "false");
    });
    coAuthorBtn.addEventListener("click", async () => {
      const v = await promptInline("Add co-author", "Name <email@example.com>", "", "Add");
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
    const commitLabel = span(curBranch ? `Commit to ${curBranch}` : "Commit", "dc-commit-label");
    commitBtn.append(glyph("git-commit"), commitLabel);
    /**
     * The primary button's label, from the one state that decides it.
     *
     * It used to be written in two places, and the second one — the repaint
     * after status loads — did not consult `amend`. So staging a file with
     * Amend on left the toggle lit, the label reading "Commit to main", and a
     * click still sending `amend: true`. The button promised a new commit and
     * rewrote the last one.
     */
    const syncCommitLabel = (): void => {
      // Reads `this.headInfo` LIVE rather than the `curBranch` const captured
      // when the composer was built. HEAD is often still resolving at that
      // moment, so the const is undefined and stays undefined — which meant
      // ticking Amend and un-ticking it turned "Commit to main" into a bare
      // "Commit" and shrank the button by 51px, with the branch line right
      // beside it still reading "main". syncComposerBranch used to paper over
      // it by writing this element's text directly; now it calls this.
      const head = this.headInfo;
      const branch = head && !head.detached ? head.branch : undefined;
      const name = branch ?? curBranch;
      commitLabel.textContent = amend ? "Amend commit" : name ? `Commit to ${name}` : "Commit";
    };
    this.syncCommitLabel = syncCommitLabel;
    commitBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, commitBtn, false, getOpts()));
    const pushBtn = el("button", "btn dc-commit dc-push");
    pushBtn.append(glyph("arrow-up"), span("Commit & Push"));
    pushBtn.addEventListener("click", () => void this.doDesktopCommit(textarea, pushBtn, true, getOpts()));
    commitRow.append(commitBtn, pushBtn);
    // A commit needs a message, so the buttons must LOOK unavailable until
    // there is one. They used to sit in full accent and swallow the click in
    // silence — the app's most important action, dead on arrival.
    const syncCommitEnabled = (): void => {
      const written = textarea.value.trim().length > 0;
      // A message is not enough. On a CLEAN working tree the button was a live
      // accent control that could only ever produce git's "nothing to commit",
      // because it gated on the text alone. Amend is the exception and a real
      // one: rewording the last commit needs no changes at all.
      const somethingToCommit = amend || this.changesHaveWork;
      const ready = written && somethingToCommit;
      for (const b of [commitBtn, pushBtn]) {
        b.toggleAttribute("disabled", !ready);
        b.title = !written
          ? "Write a commit message first"
          : somethingToCommit
            ? ""
            : "Nothing to commit — the working tree is clean";
      }
    };
    this.syncCommitEnabled = syncCommitEnabled;
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
    swr("github:status", undefined, {
      ttl: 60_000,
      alive: () => createPrBtn.isConnected,
      onData: (s) => {
        createPrBtn.hidden = !(s.connected && !!s.repo);
      },
    });
    // Hunk / line staging: stage (or unstage) exactly the lines selected in the
    // open file's diff. Hidden until a file is open; relabelled by stage state.
    let openFile: { path: string; staged: boolean } | null = null;
    let whitespaceIgnored = false;
    const stageLinesBtn = el("button", "mini-btn dc-stagelines") as HTMLButtonElement;
    // Disabled, not hidden: hiding these two made every button to their left
    // slide ~160px sideways the instant you clicked a file — the control you
    // were aiming at moved out from under the cursor.
    stageLinesBtn.disabled = true;
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
      void this.repaintChanges();
    });
    const wsBtn = el("button", "topbar-icon dc-ws") as HTMLButtonElement;
    wsBtn.disabled = true;
    wsBtn.title = "Ignore leading and trailing whitespace";
    wsBtn.setAttribute("aria-label", "Ignore leading and trailing whitespace");
    wsBtn.appendChild(glyph("whitespace"));
    wsBtn.setAttribute("aria-pressed", "false");
    // A toggle you cannot read is a toggle you cannot trust: this one was an
    // unlabelled glyph whose title said the same thing whichever way it was
    // set, and which announced no state at all.
    const syncWs = (): void => {
      wsBtn.classList.toggle("is-on", whitespaceIgnored);
      wsBtn.setAttribute("aria-pressed", String(whitespaceIgnored));
      wsBtn.title = whitespaceIgnored
        ? "Leading and trailing whitespace is ignored — click to show it"
        : "Ignore leading and trailing whitespace";
      wsBtn.setAttribute("aria-label", wsBtn.title);
    };
    syncWs();
    wsBtn.addEventListener("click", () => {
      whitespaceIgnored = !whitespaceIgnored;
      syncWs();
      diffPanel.setRenderOptions({ whitespace: whitespaceIgnored ? "trailing" : "none" });
    });
    const refreshBtn = el("button", "topbar-icon");
    refreshBtn.title = "Refresh";
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.appendChild(glyph("refresh"));
    refreshBtn.addEventListener("click", () => void this.refreshInPlace(refreshBtn, () => this.showChangesView()));
    // A stash button that follows the selection and relabels itself, matching the
    // extension. Without one, the toolbar could stage everything but never stash
    // anything, and the only stash route was a right-click most people never try.
    // Stashing moves your working tree; its only affordance used to be an
    // unlabelled archive glyph sitting between two text buttons. Label it.
    const stashBtn = el("button", "mini-btn") as HTMLButtonElement;
    stashBtn.append(glyph("archive"), span("Stash"));
    // What the button will actually do, captured when its label is written.
    //
    // The label used to be computed from `selectionPaths()` at toolbar-build
    // time, when `this.rowOrder` still held the PREVIOUS render's keys — and
    // the click then called `selectionPaths()` AGAIN, against the rebuilt
    // order, where those keys no longer matched. So the button could read
    // "Stash 1 selected file…" and hand `[]` to `stashPaths`, which means the
    // whole working tree. A control must do what it says, even when the state
    // underneath it has moved.
    let stashScope: string[] = [];
    const syncStashBtn = (): void => {
      stashScope = this.selectionPaths();
      const n = stashScope.length;
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
      // and the title has already said which. `stashScope` is what the title
      // was written from, so the two can never disagree.
      void this.stashPaths(stashScope).then(() => this.clearSelection(lists, selBar));
    });

    toolbar.append(tTitle, tSpacer, modelBtn, reviewBtn, createPrBtn, stageLinesBtn, wsBtn, stashBtn, stageAllBtn, refreshBtn);

    const body = el("div", "dc-body");
    const lists = el("div", "dc-lists");
    // ↑/↓ and j/k, the same as every other list in the app — and the same as the
    // app's own cheat sheet has been promising. Five lists wired this; the
    // LANDING view was not one of them, so the first list most people ever touch
    // was the one where the documented keys did nothing.
    wireListNav(lists, ".dc-file");
    lists.style.flex = `0 0 ${this.changesListW}px`;
    // Only when there is nothing cached to draw. See the status load below.
    if (peek("status", undefined) === undefined) lists.appendChild(skeletonList(6));

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
        listCol.style.flex = `0 1 ${w}px`;
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
    // `0 1` — the basis is the width the user chose, but the column SHRINKS
    // before the diff does. Pinned at `0 0` it held that width at every window
    // size and the diff paid for all of it: 529px of file names beside a 254px
    // diff pane at 1000px, which cannot show a diff at all.
    listCol.style.flex = `0 1 ${this.changesListW}px`;
    lists.style.flex = "1 1 auto";
    listCol.append(lists, selBar, dropZone);
    body.append(listCol, divider, surface);
    wrap.append(composer, toolbar, body);
    // Whether the composer had the keyboard is read HERE, immediately before
    // the swap — not at the top of this method, which is several awaits away
    // and could have been true about a textarea the user has since left.
    const composerHadFocus = document.activeElement?.classList.contains("dc-message") === true;
    this.viewHost.replaceChildren(wrap);
    if (composerHadFocus) {
      textarea.focus({ preventScroll: true });
      const caret = this.composerDraft.caret;
      const end = textarea.value.length;
      textarea.setSelectionRange(Math.min(caret?.start ?? end, end), Math.min(caret?.end ?? end, end));
    }

    this.activeMonacoView?.dispose();
    const diffPanel = new DiffPanel(surface);
    this.activeMonacoView = diffPanel;
    diffPanel.showEmpty("Select a file to view its diff.");

    // Paint from what we already know, and only rebuild if the tree ACTUALLY
    // moved. Before this, the file list was a 6-row skeleton on every entry and
    // the answer was re-fetched past a 3s TTL — so clicking away for four
    // seconds and coming back cost a git round trip and a flash of nothing, on
    // the app's landing view, for a working tree that had not changed. The
    // skeleton now appears only when there is genuinely nothing to show yet.
    let files: ChangedFile[];
    const known = peek("status", undefined);
    if (known !== undefined) {
      files = known;
      void gget("status", undefined, 0)
        .then((fresh) => {
          // Drop an answer for a view the user has already left, and repaint
          // only on a real difference — a rebuild here would otherwise throw
          // away the open file, the scroll position and the selection every
          // few seconds for no reason.
          this.staleTreeWarned = false;
          if (this.currentView !== "changes" || !lists.isConnected) return;
          if (sameData(fresh, known)) return;
          void this.showChangesView();
        })
        .catch((e) => {
          // Keep the last good tree on screen — blanking it would turn a
          // transient blip into a visible regression — but SAY that we could not
          // confirm it. Silence here means a genuinely broken repo goes on
          // showing a stale working tree that the user believes is current.
          if (this.currentView !== "changes" || !lists.isConnected) return;
          if (this.staleTreeWarned) return;
          this.staleTreeWarned = true;
          toast(
            cleanErr(e) || "Couldn't re-read the working tree — showing the last known state.",
            "error",
          );
        });
    } else {
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
    }
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => !f.staged);
    syncCommitLabel();
    // A quiet context line: how many changes are staged vs. still to stage.
    //
    // In the same UNITS as the rows underneath it. `staged` and `unstaged` are
    // status RECORDS, and a partially staged file (git's `MM`) appears in both
    // — which is correct for the two-list model, where it really does have a
    // row in each. The checkbox model deliberately collapses it to ONE row with
    // an indeterminate tick, so counting records there put "5 staged · 6 to
    // stage" directly above a header reading "Changes (10)": two numbers about
    // the same list that cannot both be right.
    const sumBits: string[] = [];
    if (this.stagingModel() === "checkboxes") {
      const paths = new Set([...staged, ...unstaged].map((f) => f.path));
      const stagedPaths = new Set(staged.map((f) => f.path));
      const unstagedPaths = new Set(unstaged.map((f) => f.path));
      const partial = [...stagedPaths].filter((p) => unstagedPaths.has(p)).length;
      const fully = stagedPaths.size - partial;
      sumBits.push(fully ? `${fully} staged` : "nothing staged");
      if (partial) sumBits.push(`${partial} partly staged`);
      const todo = paths.size - fully - partial;
      if (todo) sumBits.push(`${todo} to stage`);
    } else {
      sumBits.push(staged.length ? `${staged.length} staged` : "nothing staged");
      if (unstaged.length) sumBits.push(`${unstaged.length} to stage`);
    }
    branchSummary.textContent = `· ${sumBits.join(" · ")}`;

    // Mid-operation banner: a merge/rebase/cherry-pick/revert in progress gets an
    // Abort / Continue affordance (Continue is gated on zero remaining conflicts).
    void host.invoke("git:opState", undefined).then((op) => {
      if (this.currentView !== "changes") return;
      // The host decides WHAT is in progress and WHAT its buttons can do. This
      // used to re-derive both from five booleans, and got each wrong in turn:
      // "merging first" named a rebase stopped on a merge step a merge (whose
      // Abort discards the resolution), and the Skip/Continue choice came out
      // wrong in both directions in consecutive commits.
      const kind = op.kind;
      if (!kind) return;
      const label = kind === "am" ? "patch series (git am)" : kind;
      const banner = el("div", "dc-opbanner");
      const txt = el("div", "dc-opbanner-text");
      txt.append(
        glyph("warning"),
        span(
          op.conflicts > 0
            ? `${label} in progress — ${op.conflicts} file${op.conflicts === 1 ? "" : "s"} still conflicted`
            : op.canSkip && !op.canContinue
              // Zero conflicts does not mean "ready to continue": an empty
              // patch, or one that would not apply, leaves nothing to record
              // and git refuses. Saying "resolve and continue" there sent the
              // user at a button that could never work.
              ? kind === "am"
                ? `${label} in progress — git couldn't apply this patch`
                : `${label} in progress — nothing left to commit, this one is already on the branch`
              : `${label} in progress — resolve and continue`,
          "dc-opbanner-strong",
        ),
      );
      const acts = el("div", "dc-opbanner-actions");
      const abort = el("button", "mini-btn") as HTMLButtonElement;
      abort.append(glyph("discard"), span("Abort"));
      const cont = el("button", "btn btn-primary mini-btn") as HTMLButtonElement;
      cont.append(glyph("check"), span("Continue"));
      cont.disabled = !op.canContinue;
      type OpChannel =
        | "merge:abort" | "merge:continue"
        | "rebase:abort" | "rebase:continue" | "rebase:skip"
        | "cherryPick:abort" | "cherryPick:continue" | "cherryPick:skip"
        | "revert:abort" | "revert:continue" | "revert:skip"
        | "am:abort" | "am:continue" | "am:skip";
      const family =
        kind === "rebase" ? "rebase"
        : kind === "cherry-pick" ? "cherryPick"
        : kind === "revert" ? "revert"
        : kind === "am" ? "am"
        : "merge";
      const buttons: HTMLButtonElement[] = [];
      /** Ask, with the trigger held down for the whole dialog.
       *
       *  A confirm that leaves its own button live stacks one dialog per click:
       *  three impatient presses of Abort opened three modals, and dismissing
       *  them one at a time then fired the command once per Yes. `runOp`
       *  already locks the banner, but only once it starts — the window
       *  between the click and the answer belonged to nobody. */
      const askThen = (
        btn: HTMLButtonElement,
        opts: Parameters<typeof confirmDialog>[0],
        go: () => void,
      ): void => {
        if (btn.disabled) return;
        btn.disabled = true;
        void confirmDialog(opts).then((yes) => {
          btn.disabled = false;
          if (yes) go();
        });
      };
      const runOp = async (ch: OpChannel): Promise<void> => {
        // Disabled for the whole round trip, and deliberately NOT restored:
        // the repaint below rebuilds the banner with fresh buttons. Restoring
        // in a `finally` is not enough — the invoke takes ~10ms and the repaint
        // lands a fresh enabled button within ~15ms, so the guard would be
        // narrower than a double-click. These controls discard patches one
        // press at a time, and `serialize()` QUEUES a second call rather than
        // dropping it, so two clicks really did throw away two patches.
        for (const b of buttons) b.disabled = true;
        try {
          const r = await host.invoke(ch, undefined);
          // A failure here is ALWAYS shown as a failure, whatever `expected`
          // says. That flag has one job — keep an ordinary condition out of the
          // crash reports — and it was doing a second one badly: the sequencer
          // verbs are marked expected wholesale, so "I could not take the index
          // lock" arrived in the same calm blue as "stopped on the next patch",
          // and those are not the same news. Every failure of one of these
          // buttons means the operation did not finish, which is worth red even
          // when the reason is routine.
          //
          // A message on SUCCESS is the opposite case — a caveat, not a
          // failure. `git am --abort` exits 0 while declining to rewind a HEAD
          // that has moved.
          if (!r.ok) toast(r.message || "Operation failed.", "error");
          else toast(r.message || "Done.", r.message ? "info" : "success");
        } catch (e) {
          toast(cleanErr(e) || "Operation failed.", "error");
        }
        bust();
        await this.refreshRefs();
        await this.updateSync();
        if (this.currentView === "changes") void this.showChangesView();
      };
      abort.addEventListener("click", () => {
        // EVERY abort asks now, not only `am`.
        //
        // The old reasoning was that the other aborts "return you to a commit
        // still in the reflog", so nothing is lost. That is true of the
        // COMMITS and false of the thing that actually costs time: the conflict
        // resolutions. Working through eight conflicted files by hand and then
        // pressing Abort — one click, no confirm, right beside Continue —
        // throws all of that away, and none of it was ever committed, so the
        // reflog has no copy of it. It is the most expensive irreversible click
        // in the app and was the only one that did not ask.
        const ASK: Record<string, { title: string; message: string; confirmLabel: string }> = {
          am: {
            title: "Abandon this patch series?",
            message:
              "git has applied part of the series already. Abandoning it discards those patches, and " +
              "the patch files themselves are usually not something the app can replay.",
            confirmLabel: "Abandon series",
          },
          merge: {
            title: "Abandon this merge?",
            message:
              "Your branch goes back to where it was before the merge. Any conflicts you have already " +
              "resolved are discarded with it — those were never committed, so nothing can bring them back.",
            confirmLabel: "Abandon merge",
          },
          rebase: {
            title: "Abandon this rebase?",
            message:
              "Your branch goes back to where it was before the rebase. Any conflicts you have already " +
              "resolved are discarded with it — those were never committed, so nothing can bring them back.",
            confirmLabel: "Abandon rebase",
          },
          "cherry-pick": {
            title: "Abandon this cherry-pick?",
            message:
              "The commit is not applied, and any conflicts you have already resolved are discarded — " +
              "those were never committed, so nothing can bring them back.",
            confirmLabel: "Abandon cherry-pick",
          },
          revert: {
            title: "Abandon this revert?",
            message:
              "The revert is not applied, and any conflicts you have already resolved are discarded — " +
              "those were never committed, so nothing can bring them back.",
            confirmLabel: "Abandon revert",
          },
        };
        const ask = ASK[kind] ?? {
          title: "Abandon this operation?",
          message:
            "Any conflicts you have already resolved are discarded. Those were never committed, so " +
            "nothing can bring them back.",
          confirmLabel: "Abandon",
        };
        askThen(abort, { ...ask, danger: true }, () =>
          runOp(`${kind === "am" ? "am" : family}:abort` as OpChannel),
        );
      });
      cont.addEventListener("click", () => void runOp(`${family}:continue` as OpChannel));
      if (op.canSkip) {
        const skip = el("button", "mini-btn") as HTMLButtonElement;
        skip.append(glyph("arrow-right"), span(kind === "am" ? "Skip this patch" : "Skip this commit"));
        skip.title =
          kind === "am"
            ? "Drop the patch git is stuck on and carry on with the rest of the series"
            : "Drop this commit and carry on with the rest";
        // Skipping discards work — a patch, or a commit — and cannot be undone
        // from inside the app. It asks, and it is never the primary button.
        skip.addEventListener("click", () => {
          askThen(
            skip,
            {
              title: kind === "am" ? "Skip this patch?" : "Skip this commit?",
              message:
                kind === "am"
                  ? "The patch git is stuck on is dropped and the rest of the series carries on. The app cannot replay it."
                  : "This commit is dropped from the rebase and the rest carries on.",
              confirmLabel: kind === "am" ? "Skip patch" : "Skip commit",
              danger: true,
            },
            () => runOp(`${family}:skip` as OpChannel),
          );
        });
        acts.append(abort, skip, cont);
        buttons.push(abort, skip, cont);
      } else {
        acts.append(abort, cont);
        buttons.push(abort, cont);
      }
      banner.append(txt, acts);
      wrap.insertBefore(banner, wrap.firstChild);
    });

    /** Select a row and open its diff — the one path a click and a restore share. */
    const selectRow = (row: HTMLElement, f: ChangedFile): void => {
      lists.querySelectorAll(".file-row.active").forEach((n) => n.classList.remove("active"));
      row.classList.add("active");
      openFile = { path: f.path, staged: !!f.staged };
      this.changesOpenKey = rowKey(f.staged ? "staged" : "unstaged", f.path);
      stageLinesLabel.textContent = f.staged ? "Unstage lines" : "Stage lines";
      // Held CLOSED until the diff actually arrives and turns out to have a
      // line editor in it. These used to be opened by the click that selected
      // the row, before the diff had even been asked for — so over a binary, a
      // conflict, a truncated file or a failed read they sat lit above a pane
      // with no editor, and answered a press with "select some lines first":
      // advice that cannot be followed, about a control that could never work
      // on this file.
      stageLinesBtn.disabled = true;
      wsBtn.disabled = true;
      // `finally`, not `then`: these buttons start CLOSED, so a rejection here
      // would leave them shut over a file whose diff is on screen, and the only
      // way out would be to pick a different file. A read that failed has no
      // line editor either, which is the state this settles them into.
      void this.openWorkingFile(diffPanel, f.path).finally(() => {
        if (this.changesOpenKey !== rowKey(f.staged ? "staged" : "unstaged", f.path)) return;
        const live = diffPanel.hasLineEditor();
        stageLinesBtn.disabled = !live;
        wsBtn.disabled = !live;
        const why = "This file has no line-by-line diff to work with.";
        stageLinesBtn.title = live ? "" : why;
        // `syncWs` OWNS this title — it depends on whether whitespace is
        // currently ignored, not only on whether there is a diff to ignore it
        // in. Writing the "turn it on" text here unconditionally relabelled a
        // toggle that was already ON as though it were off, on every file you
        // opened: the exact "titles never change with their state" defect the
        // log toolbar was fixed for, reintroduced one toolbar over.
        if (live) syncWs();
        else wsBtn.title = why;
      });
    };

    const fileRow = (f: ChangedFile, kind: "staged" | "unstaged"): HTMLElement => {
      const row = el("button", `file-row dc-file status-${f.status}`);
      const slash = f.path.lastIndexOf("/");
      const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
      const dir = slash >= 0 ? f.path.slice(0, slash) : "";
      // NAME the row explicitly, because it is a <button> that CONTAINS
      // buttons. Without a name of its own it derives one from its contents,
      // so giving the row actions labels that name their file — the right fix
      // for the actions — folded that path into the row's announcement three
      // times over: "app.css Stage app.css Discard app.css". Carrying the
      // status letter and the staged side says what the path alone cannot.
      row.setAttribute(
        "aria-label",
        `${kind === "staged" ? "Staged" : "Unstaged"} ${statusWord(f.status)} ${f.path}`,
      );
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
          textBtn("Unstage", "Unstage this file", () => void this.changesAction("unstage", f.path), false, f.path),
        );
      } else {
        actions.appendChild(
          textBtn("Stage", "Stage this file", () => void this.changesAction("stage", f.path), false, f.path),
        );
        actions.appendChild(
          textBtn("Discard", "Discard changes to this file", () => {
            void confirmDialog(this.discardConfirm([f.path])).then((ok) => {
              if (ok) void this.changesAction("discard", f.path);
            });
          }, true, f.path),
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
        selectRow(row, f);
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
    // What the composer's enable rule needs to know: is there anything here to
    // commit at all. Set on every render, before the empty-tree early return.
    this.changesHaveWork = files.length > 0;
    this.syncCommitEnabled?.();
    // Rebuilt with the rows below, so a shift-range always covers what is on
    // screen rather than what was there before the last stage.
    this.rowOrder = [];
    if (files.length === 0) {
      lists.appendChild(
        emptyState("Working tree clean", "No changes to commit.", { icon: "check-all" }),
      );
      // Reconcile before leaving, exactly as the populated path does. Returning
      // early left `selectedRows` holding keys for files that no longer exist,
      // so the selection bar and the stash button went on describing a
      // selection over a clean tree.
      this.reconcileSelection(lists, selBar);
      return;
    }
    if (this.stagingModel() === "checkboxes") {
      // One list, a tick per file (issue #16). The tick IS the index: ticking
      // stages, unticking unstages, and the checked state is read back from what
      // git reports — so there is no shadow selection able to drift away from the
      // repository, and an external `git add` keeps agreeing with the UI.
      // ONE row per FILE. Concatenating the two lists gave a partially-staged
      // file (git's `MM`: a staged edit plus a newer unstaged one) two rows —
      // the same path listed twice, once ticked and once not, contradicting
      // itself, and counted twice in "Changes (N)". In a model whose entire
      // promise is "the tick is the index", one file cannot be both.
      //
      // Partial is a real third state, and a checkbox has one: indeterminate.
      const byPath = new Map<string, { f: ChangedFile; staged: boolean; partial: boolean }>();
      for (const f of staged) byPath.set(f.path, { f, staged: true, partial: false });
      for (const f of unstaged) {
        const prior = byPath.get(f.path);
        // The UNSTAGED record wins the row: it is the one with unstaged hunks
        // to open, which is what a partial file needs its twisty for.
        byPath.set(f.path, { f, staged: false, partial: !!prior });
      }
      const all = [...byPath.values()].sort((a, b) => a.f.path.localeCompare(b.f.path));

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

      for (const { f, staged: isStaged, partial } of all) {
        const row = fileRow(f, isStaged ? "staged" : "unstaged");
        const ck = document.createElement("input");
        ck.type = "checkbox";
        ck.className = "dc-ck";
        ck.checked = isStaged;
        // Partly in, partly out — the state the two-row version could not say.
        ck.indeterminate = partial;
        // NAMED FOR THE FILE, not just the state.
        //
        // Every tick in the list said "Not included" or "Included in the
        // commit", so three of them shared one name — which is useless to a
        // screen reader ("not included" — WHAT isn't?) and actively harmful to
        // the focus rescue: `sameThing` matches on `title`, so after the
        // rebuild a tick took focus from the FIRST checkbox with that state,
        // and ticking the fourth file moved the keyboard to the first.
        const stateWord = partial
          ? "Partly included — some changes to this file are staged"
          : isStaged
            ? "Included in the commit"
            : "Not included";
        ck.title = `${stateWord} — ${f.path}`;
        ck.setAttribute("aria-label", ck.title);
        ck.addEventListener("click", (ev) => {
          // The row opens the diff; the tick must not.
          ev.stopPropagation();
          // Ticking the whole file supersedes any hunk view of it: those indexes
          // describe a state that is about to stop existing.
          this.expandedHunks.delete(f.path);
          // From partial, one click means "include the whole file" — matching
          // the master tick above, and the only reading that leaves the file in
          // a state the checkbox can then describe.
          void this.changesAction(partial ? "stage" : isStaged ? "unstage" : "stage", f.path);
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
        } else {
          // Staged rows have no twisty, so without a spacer their content
          // started ~29px left of the unstaged rows and the list read as two
          // ragged columns. The cell is always there; only its ink isn't.
          const spacer = el("span", "dc-hunk-twisty is-spacer");
          spacer.setAttribute("aria-hidden", "true");
          row.insertBefore(spacer, row.firstChild);
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
      // NO `return` here: the tail below is model-agnostic — it keys off the
      // `.dc-file` rows this branch emits too — and skipping it threw the open
      // diff away on every tick, in the one model whose whole interaction is
      // "tick boxes while reading the diff".
    } else {
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
    }
    this.reconcileSelection(lists, selBar);

    // Put the view back where the user left it. Everything above rebuilt the
    // list from scratch — which is what closed the diff you were reading,
    // deselected the row you had picked and scrolled you back to the top on
    // every single stage, unstage, discard or refresh.
    lists.addEventListener("scroll", () => {
      this.changesScroll = lists.scrollTop;
    });
    const reopen = this.changesOpenKey;
    if (reopen) {
      const rows = [...lists.querySelectorAll<HTMLElement>(".dc-file")];
      // Reopen the exact HALF that was open, matched by row KEY. A partially-
      // staged file (git's `MM`) is two rows sharing one path in the split
      // model, and the STAGED one renders first — so matching on the path alone
      // always landed on it. Having the unstaged half open and touching
      // anything at all (stage, unstage, discard, Refresh, a watcher tick)
      // moved you to the staged half, which relabels this toolbar's
      // "Stage lines" to "Unstage lines" and flips the `reverse` its click
      // sends. `file:diff` is HEAD↔working tree either way, so the pane looked
      // identical and the next click unstaged what you meant to stage.
      //
      // The half can legitimately be gone — staged in full, or discarded — and
      // the file's other half is then the right place to land; only when no row
      // is left for the path at all is the open diff actually dropped.
      const row =
        rows.find((r) => r.dataset.key === reopen) ??
        rows.find((r) => r.dataset.path === parseRowKey(reopen).path);
      // The ROW decides which record to reopen with, not the other way round.
      // A partially-staged file has a record on both sides, and the checkbox
      // model renders only the UNSTAGED one — reading `staged` first there
      // reopened it labelled "Unstage lines" against an unstaged row.
      const f = row
        ? (row.dataset.kind === "staged" ? staged : unstaged).find(
            (x) => x.path === row.dataset.path,
          )
        : undefined;
      if (f && row) selectRow(row, f);
      else this.changesOpenKey = undefined;
    }
    if (this.changesScroll > 0) lists.scrollTop = this.changesScroll;
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
          void this.repaintChanges();
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
      // NOT "no changes". `fileDiff` returns undefined when there is no
      // repository open or the path failed its containment check — never
      // because the two sides matched. This file is in the changed list
      // PRECISELY BECAUSE it differs, so claiming equality here asserts
      // something the app has no basis for. The same laundering of an absent
      // answer into a reassuring one that "working tree clean" over
      // uncommitted work would be.
      diffPanel.showEmpty(
        `${path} is listed as changed, so this is a failure to read it — not a file that matches HEAD.`,
        { title: "Couldn't read this file", kind: "error" },
      );
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", path);
      if (gen !== this.diffGen) return;
      if (model) {
        // A conflicted BINARY, or a modify/delete, has no line-by-line merge to
        // make — the three-pane editor was mounted over decoded bytes, or over
        // one deliberately blank pane that never said the file had been deleted
        // on that side.
        diffPanel.showMerge(
          model,
          () => {
            void this.repaintChanges();
          },
          { noText: model.binary
              ? "binary"
              : model.truncated
                ? "too-large"
                : model.bothDeleted
                  ? "both-deleted"
                  : model.missingSide
                    ? "modify-delete"
                    : undefined },
        );
        return;
      }
    }
    diffPanel.showDiff(diff);
  }

  /** Selection helpers — see selectedRows for why the key is kind:path. */
  /**
   * The confirmation for a Discard, told truthfully for these exact files.
   *
   * Discard means two different things and the dialog only ever described one.
   * For a TRACKED file it reverts edits and the file stays. For an UNTRACKED one
   * the bridge runs `git clean`, which deletes the file from disk — and git has
   * no copy of it, so there is nothing to restore it from, ever. Both cases said
   * "Discard your changes to <path>? This can't be undone", which someone with a
   * brand-new file reasonably reads as "revert my edits". They lose the file.
   */
  private discardConfirm(paths: string[]): {
    title: string;
    message: string;
    confirmLabel: string;
    danger: true;
  } {
    const files = peek("status", undefined) ?? [];
    const untrackedPaths = new Set(
      files.filter((f) => f.status === "?" && !f.staged).map((f) => f.path),
    );
    const conflictedPaths = new Set(files.filter((f) => f.conflicted).map((f) => f.path));
    const gone = paths.filter((p) => untrackedPaths.has(p));
    const reverted = paths.filter((p) => !untrackedPaths.has(p));
    const one = paths.length === 1;

    // A CONFLICTED path is a third thing, and the dialog described neither of
    // the two it knew about. Discard here does not delete the file and does not
    // revert it to HEAD — it recreates the conflict from the index, throwing
    // away the resolution work and nothing else. Said as "permanently discard",
    // it read as if the file were about to be destroyed.
    const stuck = paths.filter((p) => conflictedPaths.has(p));
    if (stuck.length) {
      const onlyStuck = stuck.length === paths.length;
      // Every OTHER kind in the selection still has to be described. This
      // branch used to return the moment it saw one conflicted path, so a
      // selection holding a conflicted file AND an untracked one lost the
      // sentence saying the untracked file would be DELETED from disk with
      // nothing to restore it from — the single most important sentence this
      // dialog can say, dropped because something else in the list was
      // conflicted.
      const alsoGone = gone.filter((p) => !conflictedPaths.has(p));
      const alsoReverted = reverted.filter((p) => !conflictedPaths.has(p));
      const parts: string[] = [
        stuck.length === 1
          ? `${stuck[0]} is still conflicted: discarding puts its conflict back exactly as git left ` +
            `it, and whatever you have resolved in it is lost. The file itself stays.`
          : `${stuck.length} of these files are still conflicted: their conflicts come back as git ` +
            `left them, and the resolution work in them is lost. The files themselves stay.`,
      ];
      if (alsoGone.length) {
        parts.push(
          alsoGone.length === 1
            ? `${alsoGone[0]} isn't tracked by git, so discarding it DELETES the file from disk. ` +
              `Git has no copy of it — there is nothing to restore it from.`
            : `${alsoGone.length} of them aren't tracked by git, so discarding them DELETES those ` +
              `files from disk. Git has no copy of them — there is nothing to restore them from.`,
        );
      }
      if (alsoReverted.length) {
        parts.push(
          `The other ${alsoReverted.length === 1 ? "file has its" : `${alsoReverted.length} have their`} ` +
            `changes reverted.`,
        );
      }
      if (!onlyStuck) parts.push("None of it can be undone.");
      return {
        title: alsoGone.length
          ? "Discard changes and delete files?"
          : stuck.length === 1
            ? "Start this conflict again?"
            : "Start these conflicts again?",
        message: parts.join(" "),
        confirmLabel: alsoGone.length
          ? "Discard and delete"
          : stuck.length === 1
            ? "Restore the conflict"
            : "Restore the conflicts",
        danger: true,
      };
    }

    if (gone.length === 0) {
      return {
        title: "Discard changes?",
        message: one
          ? `Discard your changes to ${paths[0]}? This can't be undone.`
          : `Discard your changes to ${paths.length} files? This can't be undone.`,
        confirmLabel: "Discard",
        danger: true,
      };
    }
    if (reverted.length === 0) {
      return {
        title: one ? "Delete this file?" : `Delete ${gone.length} files?`,
        message: one
          ? `${gone[0]} isn't tracked by git, so discarding it DELETES the file from disk. ` +
            `Git has no copy of it — there is nothing to restore it from.`
          : `${gone.length} of these files aren't tracked by git, so discarding them DELETES ` +
            `them from disk. Git has no copy of them — there is nothing to restore them from.`,
        confirmLabel: one ? "Delete file" : `Delete ${gone.length} files`,
        danger: true,
      };
    }
    return {
      title: "Discard changes and delete files?",
      message:
        `${gone.length} of these ${paths.length} files aren't tracked by git and will be ` +
        `DELETED from disk with no way to restore them. The other ${reverted.length} will have ` +
        `their changes reverted. Neither can be undone.`,
      confirmLabel: "Discard and delete",
      danger: true,
    };
  }

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
          void confirmDialog(this.discardConfirm([f.path])).then((ok) => {
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
          void confirmDialog(this.discardConfirm(discardable)).then((ok) => {
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
    void this.repaintChanges();
  }

  /** Stash the given paths, then refresh. Empty means the whole tree. */
  private async stashPaths(paths: string[]): Promise<void> {
    const r = await host.invoke("stash:save", { paths, message: undefined });
    if (!r.ok) {
      toast(r.message ?? "Could not stash.", r.expected ? "info" : "error");
      return;
    }
    toast(paths.length === 1 ? "Stashed 1 file." : `Stashed ${paths.length} files.`);
    void this.repaintChanges();
  }

  /**
   * Re-read the working tree IN PLACE, then repaint Changes.
   *
   * `bust("status")` DELETES the cached tree, so `showChangesView`'s
   * paint-from-what-we-know path found nothing and fell back to a 6-row
   * skeleton — on every stage, unstage, discard, stash and hunk apply. The
   * list you were working in blanked and the open diff went back to "Select a
   * file to view its diff.", several times a minute, for an operation that
   * usually moves one row.
   *
   * Re-reading into the same cache entry keeps a real tree on screen the whole
   * time, and the existing change-diff gate then swaps in only what moved. The
   * status read must land BEFORE `bust("diff")`, because a bust supersedes
   * every request already in flight — including this one.
   */
  private async repaintChanges(): Promise<void> {
    try {
      await gget("status", undefined, 0);
    } catch {
      // Leave the last-known tree up; showChangesView reports the failure.
    }
    bust("diff"); // a staged/unstaged file's diff genuinely changed
    if (this.currentView === "changes") void this.showChangesView();
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
    void this.repaintChanges();
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
    // Both commit buttons go out together. Disabling only the one you pressed
    // left "Commit & Push" fully clickable while a commit was already in
    // flight, so an impatient second click started a second commit of the same
    // staged tree.
    const row = btn.closest(".dc-commit-row");
    const pair = row
      ? [...row.querySelectorAll<HTMLButtonElement>("button")]
      : [btn as HTMLButtonElement];
    for (const b of pair) b.disabled = true;
    btn.classList.add("is-busy");
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
            for (const b of pair) b.disabled = false;
            btn.classList.remove("is-busy");
            return;
          }
          // Stage for real rather than using commit -a: -a skips untracked files
          // and bypasses the index, so what landed would not match the list.
          const staged = await host.invoke("stageAll", undefined);
          if (!staged.ok) {
            toast(staged.message || "Couldn't stage the changes.", "error");
            for (const b of pair) b.disabled = false;
            btn.classList.remove("is-busy");
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
      this.composerDraft = { message: "", amend: false, signoff: false, coAuthors: [], prefilled: undefined, caret: undefined };
      this.composerDraftRoot = undefined;
      bust(); // a commit (± push) touches refs/branches/status/sync/graph
      await this.refreshRefs();
      await this.updateSync();
      if (this.currentView === "changes") void this.showChangesView();
    } catch (e) {
      toast(cleanErr(e) || "Commit failed.", "error");
    } finally {
      for (const b of pair) b.disabled = false;
            btn.classList.remove("is-busy");
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
        // Every cached GitHub answer was computed while signed OUT — the empty
        // issue lists, the hidden PR buttons, the connect prompts. None of it is
        // true any more.
        //
        // Dropped WHOLESALE, because the prefixes this replaced matched almost
        // nothing: the channels are `issue:list`, `pr:list`,
        // `notifications:list`, `actions:runs`, `release:list`, `orgs:list`,
        // `gist:list`, `project:list` — only `github:status` and
        // `github:myWork` ever began with "github:", and no channel at all
        // begins with "gh".
        void this.authChanged();
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
      errorState("View unavailable", `“${id}” isn’t a known view.`, () => this.routeView("changes", true)),
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
        set("arrow-down", `Pull ${s.behind}`, `Pull ${plural(s.behind, "commit")} from ${s.upstream}`, () => void this.doSync("pull"));
        wrap.classList.add("has-action");
      } else if (s.ahead > 0) {
        set("arrow-up", `Push ${s.ahead}`, `Push ${plural(s.ahead, "commit")} to ${s.upstream}`, () => void this.doSync("push"));
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
      // refreshAll() already re-routes — and it does so WITH the current
      // history target, so you keep your place. This second, targetless
      // re-route undid that: pressing Push while reading PR #106 refreshed
      // correctly and was then immediately replaced by the PR list.
      await this.refreshAll();
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
        views.push({ icon: "gear", label: "Settings", run: () => go("settings") });
        // The Assistant is a routed, keep-alive view like any other, but it
        // lives only behind a sparkle icon in the top bar — absent from the
        // rail, from ⌘1-8, and (until now) from here. Typing "assistant" into
        // the palette found a GitHub search instead of the app's own view.
        views.push({
          icon: "sparkle",
          label: "Assistant",
          keywords: "ai chat assistant help",
          run: () => go("assistant"),
        });

        const refs: PaletteItem[] = [
          ...this.refs
            .filter((r) => r.type === "head")
            .map((r): PaletteItem => ({
              icon: "git-branch",
              label: r.name,
              // Only the fact you can't see: which one you're on.
              hint: r.isCurrent ? "current" : "",
              keywords: `branch ${r.name}`,
              run: () => go("branches", { ref: r.name }),
            })),
          ...this.refs
            .filter((r) => r.type === "tag")
            .map((r): PaletteItem => ({
              icon: "tag",
              label: r.name,
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
              hint: "",
              run: () => go("explore", { id: searchTargetId("repos", query) }),
            },
          ],
        }),
        // Never remember a rate-limit refusal. The palette shares the search
        // cache with Explore, so a refusal cached here left Explore's own
        // "Retry now" answering from cache — no request made — for the whole
        // 60s window. Same guard Explore's fetchPage uses.
        gget("search:repos", { query, sort: "best", page: 1 }, 60_000, App.SEARCH_KEEP)
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
        gget("search:users", { query, kind: "users", page: 1 }, 60_000, App.SEARCH_KEEP)
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
    b.append(glyph("sparkle"), span("Assistant", "topbar-assistant-label"));
    // The Assistant is a full view like any other, but its only entry point is
    // this button — and the button looked identical whether you were in the
    // Assistant or not, so the one surface with no rail item and no tab was
    // also the one surface that never said you were on it.
    const sync = (): void => {
      const here = this.currentView === "assistant";
      b.classList.toggle("is-current", here);
      b.setAttribute("aria-current", here ? "page" : "false");
      b.title = here ? "You are in the Assistant" : "Assistant";
      b.setAttribute("aria-label", here ? "Assistant (current view)" : "Open the AI Assistant");
    };
    sync();
    this.syncAssistantChip = sync;
    b.addEventListener("click", () => this.routeView("assistant"));
    return b;
  }

  /** Repaint the Assistant launcher's current-view state after a route change. */
  private syncAssistantChip?: () => void;

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
    bell.addEventListener("click", () => {
      // A popover OF the page you are already reading has nothing to add, and
      // it put a second copy of the Inbox on screen: two "Inbox 7" headers,
      // two identical refresh buttons, two lists of the same threads. On the
      // Inbox the bell just refreshes the page.
      if (this.currentView === "notifications") {
        this.routeView("notifications", true);
        return;
      }
      openNotificationsPanel(
        bell,
        (v, target) => this.routeView(v, false, target),
        () => void this.refreshNotifBadge(),
      );
    });
    void this.refreshNotifBadge();
    return bell;
  }

  /** Fill in the commit composer's branch once HEAD resolves. Without this the
   *  placeholder stayed "…" forever, which is worse than the wrong answer it
   *  replaced. */
  private syncComposerBranch(): void {
    const head = this.headInfo;
    if (!head) return;
    const name = head.detached ? "detached HEAD" : (head.branch ?? "HEAD");
    const nameEl = document.querySelector<HTMLElement>(".dc-branch-name");
    if (nameEl) nameEl.textContent = name;
    // The composer owns its own label — writing it from here made two writers
    // for one string, and the other one holds the amend flag.
    this.syncCommitLabel?.();
  }

  /** Pull the unread count and reflect it on the bell badge (hidden at zero). */
  private async refreshNotifBadge(): Promise<void> {
    const count = await fetchUnreadCount();
    this.setNotifBadge(count);
  }

  /** Paint a known unread count onto the bell. The Inbox broadcasts what it
   *  actually loaded (gs:unread), so the badge and the panel header can never
   *  disagree — they used to differ by one, 200px apart. */
  private setNotifBadge(count: number): void {
    const badge = this.notifBellBadge;
    if (!badge || !badge.isConnected) return;
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
    // Asked ONCE, at construction — and the top bar is built by showRepoScreen,
    // which runs only on `repo:changed`. So the chip kept naming the account
    // you had signed out of for the rest of the session, avatar and all, while
    // Settings one click away said "Not connected". Stored as a hook so the
    // three auth sites can re-ask, the way `syncCommitLabel` and
    // `syncAssistantChip` already do for their own surfaces.
    let gen = 0;
    let nameRetry: number | undefined;
    // What the last SUCCESSFUL answer said. A failed question is not an answer:
    // it used to fall through to `{connected: false}`, so a dropped IPC or a
    // moment offline turned a signed-in user's chip into a "Sign in" button —
    // and the chip is the only place in the window that would have said it.
    let lastKnown: GitHubStatus | undefined;
    const sync = async (): Promise<void> => {
      const mine = ++gen;
      let status: GitHubStatus;
      try {
        // Cached: the top bar and the section headers both ask on every route,
        // and this is the copy that was not sharing with the others.
        status = await gget("github:status", undefined);
        lastKnown = status;
      } catch {
        // Keep saying what we last knew to be true; only an actual answer of
        // "not connected" may take the account off the top bar.
        status = lastKnown ?? { connected: false };
      }
      // A switch immediately followed by a sign-in can resolve out of order;
      // the later question owns the answer.
      if (!chip.isConnected || mine !== gen) return;

      // CONNECTED is the question. The login NAME is a separate, slower fact.
      //
      // `github:status` deliberately does not decrypt the token — doing so
      // raises the OS keychain prompt on every launch — so a signed-in user
      // gets `{connected: true, login: undefined}` until some real GitHub
      // request unlocks it. Branching on `connected && login` put that state in
      // the ELSE, so the chip said "Sign in" to someone who was signed in, and
      // then flipped to their name once anything else made a request. Two
      // strings one character apart that mean opposite things.
      if (status.connected) {
        chip.classList.add("is-connected");
        if (status.login) {
          window.clearTimeout(nameRetry);
          chip.title = `Signed in to GitHub as ${status.login}`;
          chip.replaceChildren(
            avatar(status.login, `https://github.com/${status.login}.png`, 22),
            span(status.login, "topbar-acct-name"),
          );
        } else {
          // Signed in, name not known yet. Say so honestly rather than
          // guessing, and ask again shortly — the first real request fills it
          // in, and this stops only when it does.
          chip.title = "Signed in to GitHub";
          chip.replaceChildren(glyph("github"), span("Signed in", "topbar-acct-name"));
          window.clearTimeout(nameRetry);
          nameRetry = window.setTimeout(() => void sync(), 2000);
        }
      } else {
        window.clearTimeout(nameRetry);
        chip.classList.remove("is-connected");
        chip.title = "Sign in to GitHub";
        chip.replaceChildren(glyph("github"), span("Sign in", "topbar-acct-name"));
      }
    };
    this.syncAccountChip = sync;
    // Exposed to the harness ONLY when the harness is there, so a check can
    // re-ask the question under a broken channel — "a failed question is not an
    // answer" is not observable any other way.
    if ((window as { __GS_ROUTES?: unknown }).__GS_ROUTES) {
      (window as { __gsSyncAccountChip?: () => Promise<void> }).__gsSyncAccountChip = sync;
    }
    void sync();
    return chip;
  }

  /**
   * Everything that stops being true when the signed-in account changes.
   *
   * ONE helper, called from all three auth sites, because they had drifted:
   * Sign out dropped the caches, Switch account dropped neither, and neither
   * touched the top-bar chip. Three sites each remembering four things is how
   * that happened, and splitting the fix across them again would only reset the
   * clock. The toast stays at the call site — only Sign out has one to say.
   */
  private async authChanged(): Promise<void> {
    // Every cached GitHub answer was computed for a session that is over.
    bust();
    // …and the kept-alive DOM those answers were rendered into, which `bust()`
    // does not touch: a stashed view is re-attached verbatim on return, so
    // Issues and PRs came back showing the previous account's pages — names,
    // avatars, private titles — on a window that was signed out.
    this.viewCache.clear();
    await this.syncAccountChip?.();
    void this.refreshNotifBadge();
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
    // The Inbox tells the shell what it actually loaded, so the bell badge and
    // the panel header can't drift apart.
    window.addEventListener("gs:unread", (e) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === "number") this.setNotifBadge(n);
    });
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
    // Coming back to the front does NOT mean anything changed. This used to call
    // refreshFromDisk(true) unconditionally, which drops the entire cache, throws
    // away every kept-alive view and force-rebuilds the current one — so a plain
    // alt-tab away and back cost a full reload of the app and ejected you from
    // whatever detail page you were reading. Ask what changed first; if the
    // answer is nothing, do nothing.
    window.addEventListener("focus", () => {
      void this.refreshIfDiskMoved();
    });
    host.on("menu:command", (msg) => {
      if (msg.command === "openRepo") void this.openRepo();
      else if (msg.command === "refresh") void this.refreshAll();
      else if (msg.command === "closeRepo") void this.backToMenu();
      else if (msg.command === "toggleTerminal") this.toggleTerminal();
      else if (msg.command === "cloneRepo") openCloneDialog((root) => void this.openPath(root));
      else if (msg.command === "toggleSidebar") this.toggleRail();
      else if (msg.command === "palette") this.openPalette();
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

  /** What the repo looked like on disk the last time we synced with it. */
  private diskFingerprint?: string;
  /** One warning per run of failures, not one per revalidation. */
  private staleTreeWarned = false;

  /**
   * Refresh only if the repository actually moved while we were away.
   *
   * The window-focus refresh is the safety net for edits made in another app —
   * a real need, and the reason it deliberately does not check whether a file
   * watcher is running. But it fired on EVERY focus, and its full refresh drops
   * the whole cache, clears every kept-alive view and force-rebuilds. So alt-tab
   * to a browser and back and the app rebuilt itself from nothing, which is both
   * slow and destructive: the Settings sign-in card had to be special-cased out
   * of it by hand, and any detail page you were reading was replaced by its list.
   *
   * Two cheap reads answer "did anything change?" — the working tree and HEAD.
   * They cost a few milliseconds against the seconds a full refresh costs, and
   * in the common case (nothing changed) the answer is: do nothing at all.
   */
  private async refreshIfDiskMoved(): Promise<void> {
    if (!this.currentRepo || this.refreshingFromDisk) return;
    let print: string;
    try {
      const [status, head] = await Promise.all([
        host.invoke("status", undefined),
        host.invoke("head:get", undefined),
      ]);
      print = JSON.stringify({ status, head });
    } catch {
      // Could not tell — leave the screen alone rather than rebuild on a guess.
      return;
    }
    if (this.diskFingerprint === print) return; // nothing moved while we were away
    this.diskFingerprint = print;
    await this.refreshFromDisk(true);
  }

  private async refreshFromDisk(gitDir: boolean): Promise<void> {
    if (!this.currentRepo || this.refreshingFromDisk) {
      return;
    }
    this.refreshingFromDisk = true;
    try {
      if (gitDir) {
        await this.refreshAll();
        // Our OWN refresh has just re-read the tree; record it, or the next
        // window focus sees a fingerprint from before this change and rebuilds
        // the app a second time for something it has already applied.
        void this.recordDiskFingerprint();
        return;
      }
      if (this.currentView === "changes") {
        // Re-read into the cache rather than deleting it. `bust("status")`
        // removes the very entry showChangesView paints from, so every save in
        // your editor blanked the file list to a 6-row skeleton and closed the
        // diff you were reading — the same defect as staging, which this fix
        // wave already corrected for the buttons but not for the watcher.
        await this.repaintChanges();
        return;
      }
      bust("status");
      bust("diff");
      if (this.currentView === "graph" && this.graph) {
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

  /**
   * Snapshot the on-disk state so the next focus can tell "changed" from "same".
   *
   * Read through the cache. These run alongside the view's own status and HEAD
   * reads — at boot inside the same tick, and after an external git operation
   * right behind the refresh that just repopulated them — so raw invokes meant
   * the app ran `git status` over the whole worktree twice to learn one thing
   * once. `gget` shares the in-flight promise rather than starting a second.
   *
   * Both reads here must stay value-comparable with the ones in
   * `refreshIfDiskMoved`, which are deliberately RAW: that side is the
   * forced-fresh half of the comparison, and caching it would compare a value
   * against itself.
   */
  private async recordDiskFingerprint(): Promise<void> {
    try {
      const [status, head] = await Promise.all([
        gget("status", undefined),
        gget("head:get", undefined),
      ]);
      this.diskFingerprint = JSON.stringify({ status, head });
    } catch {
      this.diskFingerprint = undefined;
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
    //
    // EXCEPT a parked Assistant. Every other kept-alive view holds a rendering
    // of repo state that this refresh has just invalidated; the Assistant holds
    // a conversation, and possibly a turn still streaming into it. Dropping it
    // here is the same defect the `currentView === "assistant"` guard below
    // fixes, reached by the other door: leave the Assistant to answer something,
    // go and read an issue, and the agent's own commit — or any file the build
    // touched — deleted the transcript and the Stop button out from under a run
    // that kept going. Held by identity, so nothing is refetched or rebuilt.
    const parkedChat = this.viewCache.get("assistant");
    this.viewCache.clear();
    if (parkedChat) this.viewCache.set("assistant", parkedChat);
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
    // The Assistant, for the same reason and a sharper one. Nothing on it is
    // derived from the repository's disk state — it is a transcript — and the
    // agent's own work is what fires this: approve a commit and the file
    // watcher calls refreshAll, which re-routed the view the agent was
    // streaming into. The answer, the tool steps and the Stop button were all
    // destroyed mid-run, while the run itself carried on in the main process
    // with nothing left on screen to stop it or show it.
    if (this.currentView === "assistant") {
      return;
    }
    // The Assistant, for the same reason and a sharper one. Nothing on it is
    // derived from the repository's disk state — it is a transcript — and the
    // agent's own work is what fires this: approve a commit and the file
    // watcher calls refreshAll, which re-routed the view the agent was
    // streaming into. The answer, the tool steps and the Stop button were all
    // destroyed mid-run, while the run itself carried on in the main process
    // with nothing left on screen to stop it or show it.

    // The graph reloads in place when showing; when it's PARKED (kept alive
    // behind another view) it's only marked dirty, so returning to Commits
    // re-syncs the data without ever tearing the mount down.
    if (this.currentView === "graph" && this.graph) {
      await this.graph.reload();
    } else {
      // Re-route to WHERE YOU ARE, not just to which section you are in. This
      // passed no target, so a refresh while reading PR #106 rebuilt the PR
      // LIST — you were ejected from the page you were on by a background
      // event you never asked for. The history stack already knows the target;
      // it is the same value Back would return you to.
      const here = this.navHistory[this.navPos];
      this.routeView(this.currentView, true, here?.view === this.currentView ? here.target : undefined);
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
      title: "Every clone on this machine",
      onClick: () => this.openRepoManager(),
    });
    items.push({
      // Was "Back to the main menu" — a name for a destination that does not
      // exist. It closes the repository, and what it opened was a full-screen
      // card offering Open… / Clone… / Recent: the same three things this menu
      // already offers, one row above. One name for one act.
      label: "Close repository",
      icon: "close",
      title: "Close this repository and go back to the picker",
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
      const found = this.graph.reveal(sha);
      void this.selectCommit(sha);
      if (!found) {
        toast(
          `${sha.slice(0, 7)} is further back than the loaded history — its details are below.`,
          "info",
        );
      }
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
      if (this.graph?.reveal(sha)) return;
      if (++tries < 6 && this.currentView === "graph") {
        window.setTimeout(tryReveal, 120);
        return;
      }
      // GIVE UP OUT LOUD. The graph holds only the pages it has loaded, so a
      // commit further back than that — which is most of the history in any
      // real repository — can never be revealed however long we retry. The
      // details pane below has loaded it either way, so the work is not lost;
      // saying nothing just made the list look like it had ignored the click.
      if (this.currentView === "graph") {
        toast(
          `${sha.slice(0, 7)} is further back than the loaded history — its details are below.`,
          "info",
        );
      }
    };
    requestAnimationFrame(tryReveal);
  }

  /**
   * The branch switcher.
   *
   * It used to switch nothing. Every row — branches, remotes and tags alike —
   * called `revealInGraph`, so clicking "fix/log-stream" under a chip whose own
   * tooltip reads "On branch main — switch branch" left you on main and dropped
   * you in the Commits view instead. The app's most load-bearing control did
   * something other than its name, silently, every time.
   *
   * Now a branch row CHECKS OUT. Revealing a ref in the graph is still one
   * gesture away — it moved to a trailing button on the row, where it reads as
   * the secondary thing it is.
   *
   * Remotes and tags keep reveal as their primary: checking either out detaches
   * HEAD, which is not what someone picking from a branch chip is asking for.
   * The remote rows offer "check out as a local branch", which is what they
   * actually mean, through the same path the Branches list uses.
   */
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
          sub: b.isCurrent ? "current" : undefined,
          title: b.isCurrent ? `Already on ${b.name}` : `Check out ${b.name}`,
          onClick: () => {
            if (b.isCurrent) {
              this.revealInGraph(b.sha);
              return;
            }
            void this.checkoutRef(b.name);
          },
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
          title: `Check out ${b.name} as a local branch`,
          onClick: () => void this.checkoutRef(b.name, undefined, "remote"),
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
          title: `Show ${t.name} in Commits`,
          onClick: () => this.revealInGraph(t.sha),
        });
      }
    }
    if (items.length === 0) {
      items.push({ label: "No branches yet", disabled: true });
    } else {
      items.push({ separator: true });
      items.push({
        label: "New branch…",
        icon: "add",
        onClick: () => void this.newBranch(),
      });
      items.push({
        label: "Manage branches…",
        icon: "git-branch",
        onClick: () => this.routeView("branches"),
      });
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
    this.headInfo = head;
    this.syncComposerBranch();
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
    // Loading a commit's details is a round trip, and this pane used to sit
    // showing the PREVIOUS commit's files the whole time — so a slow load was
    // indistinguishable from a fast one, and a FAILED load was invisible: the
    // old commit stayed on screen as though it were the one you just clicked.
    // The open diff belongs to the PREVIOUS commit, and `loadingState` is about
    // to replace the node it lives in — so close it properly rather than
    // orphaning it. Without this, a details load that FAILS returned before
    // `renderDetails` ever ran, leaving `diff-open` on the wrapper: the graph
    // stayed squeezed to half width around an error card, in a pane sized for a
    // diff that was no longer in the DOM, and only opening another commit
    // successfully could undo it.
    this.closeGraphDiff();
    this.detailsEl?.replaceChildren(loadingState(`Loading ${sha.slice(0, 7)}…`));
    let details;
    try {
      details = await host.invoke("commit:details", sha);
    } catch (e) {
      if (this.selectedSha !== sha) return;
      this.detailsEl?.replaceChildren(
        errorState("Couldn't load this commit", cleanErr(e) || "The commit details request failed."),
      );
      return;
    }
    if (this.selectedSha !== sha) return;
    if (!details) {
      this.detailsEl?.replaceChildren(
        errorState("Couldn't load this commit", `Git returned nothing for ${sha.slice(0, 7)}.`),
      );
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
    // The graph drops its Date and SHA columns below a breakpoint of its own (a
    // container query in commit-graph), so the details column must never
    // squeeze it past that — otherwise columns silently vanish and their resize
    // handles go with them.
    //
    // TAKEN FROM THE GRAPH, not restated here. This was a literal 800 beside a
    // comment saying the drop happened at 760; the graph package has since
    // raised it to 860, and nothing connected the two — so the resizer let you
    // drag the details pane 60px past the point where the graph starts losing
    // columns, which is exactly what the guard exists to prevent. Plus the
    // headroom the comment always intended.
    const GRAPH_FLOOR = COLUMN_DROP_TAIL_AT + 40;
    const maxFor = (): number =>
      Math.max(MIN, Math.min(900, Math.round(wrap.getBoundingClientRect().width) - GRAPH_FLOOR));
    const saved = Number(localStorage.getItem(KEY));
    /**
     * What the user ASKED for, kept apart from what currently fits.
     *
     * These used to be one variable, and clamping wrote back into it. The first
     * clamp runs while `wrap` is still detached — `graphSplitResizer(wrap)` is
     * called inside `wrap.append(...)` — so its width is 0, maxFor() collapses
     * to the 320px floor, and the 420px default was destroyed on the way in.
     * The resize handler then re-clamped 320 against every later width, so the
     * column could only ever shrink: the pane opened at its hard minimum every
     * time, and a width you dragged to 600px came back as 320. The comment
     * promising "width persists across sessions" could not have been true.
     */
    let desired = Number.isFinite(saved) && saved > 0 ? saved : 420;
    let applied = desired;
    const apply = (): void => {
      applied = Math.min(maxFor(), Math.max(MIN, Math.round(desired)));
      wrap.style.setProperty("--graph-details-w", `${applied}px`);
    };
    const setW = (n: number): void => {
      desired = Math.max(MIN, Math.round(n));
      apply();
    };
    apply();

    // Re-apply whenever the pane's own box changes — which covers both the
    // window resize (narrowing starves the details column rather than the
    // graph) and the first real layout after `wrap` is attached. Clamping from
    // `desired` every time means widening the window grows the column back
    // toward what was asked for instead of leaving it stuck at the floor.
    this.graphSplitRO?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      this.graphSplitRO = new ResizeObserver(() => apply());
      this.graphSplitRO.observe(wrap);
    } else {
      window.addEventListener("resize", () => apply());
    }

    const split = el("div", "cmp-vsplit graph-vsplit");
    split.append(el("div", "cmp-vsplit-grip"));
    wireResizerKeys(split, {
      orientation: "vertical",
      label: "Resize the commit details column",
      min: MIN,
      max: maxFor,
      get: () => applied,
      set: setW,
      inverted: true,
      onCommit: () => localStorage.setItem(KEY, String(desired)),
    });
    split.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = applied;
      document.body.classList.add("resizing-h");
      // Dragging LEFT widens the details column (it is the right-hand pane).
      const move = (ev: PointerEvent): void => setW(startW - (ev.clientX - startX));
      const up = (): void => {
        document.body.classList.remove("resizing-h");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        localStorage.setItem(KEY, String(desired));
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
      // The FOURTH caller of this shape, and the last one still laundering a
      // failure into good news. `fileDiff` returns undefined when there is no
      // repository open or the path failed its containment check — never
      // because the two sides matched. Saying "no textual changes" with a green
      // tick asserts something the app has no basis for, about a file that is
      // in this list precisely because it differs. Changes, Compare and the
      // commit page each got this treatment; this one was missed.
      panel.showEmpty(
        `${file.path} is listed as changed, so this is a failure to read it — not a file with nothing in it.`,
        { title: "Couldn't read this file", kind: "error" },
      );
      return;
    }
    if (diff.conflicted) {
      const model = await host.invoke("conflict:model", file.path);
      if (gen !== this.diffGen || panel !== this.diffPanel) return;
      if (model) {
        panel.showMerge(model, undefined, {
          noText: model.binary
              ? "binary"
              : model.truncated
                ? "too-large"
                : model.bothDeleted
                  ? "both-deleted"
                  : model.missingSide
                    ? "modify-delete"
                    : undefined,
        });
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
      // Branches answered to three keys this sheet had never heard of, and one
      // of them CONTRADICTED what the sheet said ⌘Enter does — pressing the
      // documented "submit" on a branch row checks it out. A sheet that is
      // wrong about a key is worse than a sheet that omits it.
      title: "Branches",
      rows: [
        ["/", "Filter the list"],
        [`${mod}Enter`, "Run the focused row's main action — checkout, pull, publish"],
        ["Shift+F", "Fetch from every remote"],
      ],
    },
    {
      title: "Detail pages",
      rows: [
        ["Esc  or  ←", "Back to the list"],
        [`${mod}Enter`, "Submit the open form"],
        ["/", "Commit page: filter the changed files"],
      ],
    },
    {
      // The log grew a page of its own and a keyboard to go with it, and a
      // shortcut nothing advertises is a shortcut nobody has.
      title: "Reading a log",
      rows: [
        ["↑ ↓  PgUp PgDn", "Move through the output"],
        ["Home / End", "Start / newest line"],
        ["n", "Jump to the next failure"],
        ["j / k", "Next / previous job in this run"],
        ["Enter  Shift+Enter", "Step through search matches"],
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
