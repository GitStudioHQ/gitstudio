import * as vscode from "vscode";
import {
  fetchFacetOptions,
  fetchPrListPage,
  fetchRepoInfo,
  isCheckedOut,
  PrListError,
  type GraphqlFn,
  type LocalHead,
  type PrFacetOptions,
  type PrListItem,
  type PrRepoInfo,
} from "@gitstudio/engine/forge/prList";
import { prKind } from "@gitstudio/engine/forge/pullRequests";
import type {
  PrListAction,
  PrListCounts,
  PrListFilters,
  PrListMessage,
  PrListMessageToHost,
  PrListState,
  PrListViewState,
  PrPerson,
} from "@gitstudio/host-bridge/prProtocol";
import type { RepoEntry, RepoManager } from "../git/repoManager";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
import type { GitHubAuth } from "./githubAuth";
import { GitHubApi, GitHubApiError, type PullRequest } from "./githubApi";
import { prListHtml } from "./prListHtml";
import { contextFor, resolvePrTargets, type PrTarget } from "./prTargets";
import {
  LOOKING_FOR_A_REPOSITORY,
  listGitHubRemotes,
  whyNoGitHub,
  type GitHubRemote,
  type GitHubRepoContext,
} from "./repoContext";
import * as l10n from "@vscode/l10n";

// The Pull Requests view (gitstudio.pullRequests): a webview view that mounts
// the shared list (packages/webview-ui/src/pr/prList.ts) and feeds it. It
// shows one repository's pull requests — a fork's parent by default, with the
// clone's other GitHub repositories in a switcher — a segment at a time
// (Open, Merged, Closed, All), searchable and filtered by author, review
// requested, assignee and label, a page at a time.
//
// WHERE THE ROWS COME FROM. One GraphQL request per page (@gitstudio/engine/
// forge/prList): every row with its checks' rollup and review decision, and
// on the first page the segments' counts and the signed-in account.
//
// WHEN IT TALKS TO GITHUB. On the first show; on Refresh; when a segment,
// the search or a filter changes; for the next page; when the active
// repository (or its GitHub remotes) changes; when sign-in changes; when the
// view comes back into sight with a list older than STALE_MS; and every
// STALE_MS while it is in sight in a focused window. Never on working-tree
// churn: RepoManager fires on every file save, and the old tree reloaded on
// each one, in sight or not. A change of the checked-out branch re-reads
// only git (which row is "Checked out"), never GitHub.
//
// AN ANSWER BELONGS TO ITS QUESTION. Every request knows the query it was
// for — repository, target, segment, filters — and paints nothing if the
// view has moved on by the time it answers: a slow answer for the
// repository you left used to paint over the one you switched to.
//
// ONE-CLICK MUTATIONS PATCH THE LIST: a merge moves the row, a new pull
// request joins it, with no reload.

const REFRESH_DEBOUNCE_MS = 400;
/** A list older than this is read again when the view is shown, and while it is in sight. */
const STALE_MS = 2 * 60 * 1000;
/** Rows per page. */
export const PR_PAGE = 30;
/** How many rows a refresh re-reads at most (the rows on screen, up to GitHub's page). */
const REFRESH_MAX = 100;

/** A store for the repository the user chose to see, per clone. */
export interface TargetMemory {
  get(key: string): string | undefined;
  update(key: string, value: string | undefined): Thenable<void> | Promise<void> | void;
}

interface Loaded {
  key: string;
  /** The question it answers, in parts: whose clone, which repository (lower case), segment, filters (as in the key). */
  root: string;
  target: string;
  segment: PrListState;
  filters: string;
  items: PrListItem[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
  counts?: PrListCounts;
  at: number;
}

/** The repositories a clone offers, the one the list shows (or would), and the clone. */
export interface ResolvedTargets {
  targets: PrTarget[];
  target: PrTarget;
  entry: RepoEntry;
}

type RepoState =
  | { kind: "message"; root: string | undefined; discovering: boolean; message: PrListMessage }
  | { kind: "github"; root: string; sig: string; entry: RepoEntry; remotes: GitHubRemote[]; targets: PrTarget[]; target: PrTarget };

/** The key a list is known by: whose, which segment, which filters — and those parts. */
function queryOf(root: string, target: string, segment: PrListState, filters: PrListFilters): Pick<Loaded, "key" | "root" | "target" | "segment" | "filters"> {
  const f = JSON.stringify(
    Object.entries(filters)
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const t = target.toLowerCase();
  return { key: `${root}|${t}|${segment}|${f}`, root, target: t, segment, filters: f };
}

/** The filters of a list with none. */
const NO_FILTERS = "[]";

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function remoteSig(remotes: readonly GitHubRemote[]): string {
  return JSON.stringify(remotes.map((r) => [r.name, r.owner.toLowerCase(), r.repo.toLowerCase()]));
}

/** "just now" / "3 minutes ago", from epoch milliseconds. */
function ago(ms: number): string {
  const r = relativeTime(ms / 1000);
  if (r === "now") return l10n.t("just now");
  const m = /^(\d+)(mo|m|h|d|w|y)$/.exec(r);
  if (!m) return l10n.t("{0} ago", r);
  const n = Number(m[1]);
  const unit = {
    m: n === 1 ? l10n.t("minute") : l10n.t("minutes"),
    h: n === 1 ? l10n.t("hour") : l10n.t("hours"),
    d: n === 1 ? l10n.t("day") : l10n.t("days"),
    w: n === 1 ? l10n.t("week") : l10n.t("weeks"),
    mo: n === 1 ? l10n.t("month") : l10n.t("months"),
    y: n === 1 ? l10n.t("year") : l10n.t("years"),
  }[m[2] as "m"];
  return l10n.t("{0} {1} ago", n, unit);
}

// ── A row, to the PR commands and back ─────────────────────────────────────

/** A list row as the PR commands take it (the page fetches the rest). */
export function toPullRequest(item: PrListItem): PullRequest {
  const [owner] = item.repository.split("/");
  return {
    number: item.number,
    title: item.title,
    body: null,
    state: item.state,
    draft: item.draft,
    htmlUrl: item.url,
    user: item.author ? { login: item.author.login, avatarUrl: item.author.avatarUrl, htmlUrl: `https://github.com/${item.author.login}` } : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mergedAt: item.mergedAt,
    head: {
      ref: item.headRef,
      sha: item.headSha,
      label: `${item.headOwner ?? owner}:${item.headRef}`,
      repoFullName: item.headRepo,
      cloneUrl: item.headUrl ? `${item.headUrl}.git` : null,
    },
    base: {
      ref: item.baseRef,
      sha: item.baseSha,
      label: `${owner}:${item.baseRef}`,
      repoFullName: item.repository,
      cloneUrl: `https://github.com/${item.repository}.git`,
    },
    labels: item.labels.map((l) => ({ name: l.name, color: l.color })),
    requestedReviewers: item.reviewRequests
      .filter((r): r is { login: string; avatarUrl?: string | null } => typeof r.login === "string")
      .map((r) => ({ login: r.login, avatarUrl: r.avatarUrl ?? null, htmlUrl: `https://github.com/${r.login}` })),
    maintainerCanModify: item.maintainerCanModify,
  };
}

/** A pull request we just made, as a row — until GitHub's own row replaces it. */
export function itemFromPullRequest(pr: PullRequest): PrListItem {
  const repository = pr.base.repoFullName ?? "";
  const headRepo = pr.head.repoFullName;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.htmlUrl,
    kind: prKind(pr),
    draft: pr.draft,
    state: pr.state === "closed" ? "closed" : "open",
    mergedAt: pr.mergedAt,
    closedAt: null,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: pr.user ? { login: pr.user.login, avatarUrl: pr.user.avatarUrl } : null,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headOwner: headRepo ? headRepo.split("/")[0] : null,
    headRepo,
    headUrl: headRepo ? `https://github.com/${headRepo}` : null,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    isFork: !!headRepo && headRepo.toLowerCase() !== repository.toLowerCase(),
    maintainerCanModify: pr.maintainerCanModify ?? false,
    labels: pr.labels.map((l) => ({ name: l.name, color: l.color })),
    assignees: [],
    reviewRequests: pr.requestedReviewers.map((u) => ({ login: u.login, avatarUrl: u.avatarUrl })),
    ci: { state: "none", total: 0, failed: 0, pending: 0 },
    comments: 0,
    repository,
  };
}

// ── What the view says when there is nothing to list ─────────────────────────

interface Described {
  message: string;
  kind: GitHubApiError["kind"] | PrListError["kind"] | "unknown";
  status?: number;
  helpUrl?: string;
}

function describe(err: unknown): Described {
  if (err instanceof GitHubApiError) return { message: err.message, kind: err.kind, status: err.status, helpUrl: err.helpUrl };
  if (err instanceof PrListError) return { message: err.message, kind: err.kind };
  return { message: l10n.t("GitHub didn't answer."), kind: "unknown" };
}

/** A first load that failed: why, and the one thing that can put it right. */
export function failureMessage(err: Described, repo: string): PrListMessage {
  const retry = { label: l10n.t("Retry"), icon: "refresh", action: { kind: "retry" } as PrListAction };
  if (err.kind === "auth" && err.status === 401) {
    // Signing in helps only as a NEW sign-in: VS Code hands the refused
    // session straight back to a plain request for one.
    return {
      icon: "warning",
      tone: "warning",
      title: l10n.t("Your GitHub session expired"),
      detail: l10n.t("Sign in again to see {0}'s pull requests.", repo),
      buttons: [{ label: l10n.t("Sign in again"), icon: "sign-in", primary: true, action: { kind: "signIn", again: true } }],
    };
  }
  if (err.kind === "auth" || err.kind === "forbidden") {
    // Signed in, and refused: a permission, an organization's SSO. GitHub's
    // page for it, where it names one — a new sign-in would not change it.
    return {
      icon: "warning",
      tone: "warning",
      title: l10n.t("GitHub refused to list {0}'s pull requests", repo),
      detail: err.message,
      buttons: [
        err.helpUrl
          ? {
              label: l10n.t("Authorize on GitHub"),
              icon: "link-external",
              primary: true,
              action: { kind: "openUrl", url: err.helpUrl },
              title: l10n.t("Open GitHub's page that authorizes this sign-in for the organization"),
            }
          : { label: l10n.t("Open on GitHub"), icon: "link-external", primary: true, action: { kind: "openUrl", url: `https://github.com/${repo}/pulls` } },
        retry,
      ],
    };
  }
  if (err.kind === "not-found") {
    return {
      icon: "warning",
      tone: "warning",
      title: l10n.t("GitHub has no repository {0}", repo),
      detail: l10n.t("Or this GitHub sign-in can't see it: a private repository needs an account with access to it."),
      buttons: [
        { label: l10n.t("Sign in again"), icon: "sign-in", action: { kind: "signIn", again: true }, title: l10n.t("Sign in to GitHub, with another account if need be") },
        retry,
      ],
    };
  }
  if (err.kind === "rate-limit") {
    return { icon: "clock", tone: "warning", title: l10n.t("GitHub's rate limit was reached"), detail: err.message, buttons: [retry] };
  }
  if (err.kind === "network") {
    return { icon: "error", tone: "error", title: l10n.t("Couldn't reach GitHub"), detail: l10n.t("Check your network connection."), buttons: [{ ...retry, primary: true }] };
  }
  return { icon: "error", tone: "error", title: l10n.t("Couldn't load pull requests"), detail: err.message, buttons: [{ ...retry, primary: true }] };
}

export const SIGNED_OUT: PrListMessage = {
  icon: "github",
  tone: "info",
  title: l10n.t("Sign in to GitHub to see pull requests"),
  detail: l10n.t("GitStudio uses VS Code's GitHub account — no token to paste. Then list, check out, review, merge and create pull requests here."),
  buttons: [{ label: l10n.t("Sign in to GitHub"), icon: "sign-in", primary: true, action: { kind: "signIn" } }],
};

// ── The view ─────────────────────────────────────────────────────────────────

export class PullRequestsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "gitstudio.pullRequests";

  private view: vscode.WebviewView | undefined;
  private pageReady = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly api: GitHubApi;
  private readonly graphql: GraphqlFn;
  /**
   * Aborted on dispose. A read under way stops with the view: the request in
   * flight is handed the signal, and a refresh that re-reads its rows a page
   * at a time asks for no page after it (the old tree went on paging GitHub
   * for rows nobody would see).
   */
  private readonly stopped = new AbortController();

  private seq = 0;
  private segment: PrListState = "open";
  private filters: PrListFilters = {};
  private repo: RepoState | undefined;
  /** Resolving the repository (its remotes, a fork's parent) is under way. */
  private resolving: Promise<void> | undefined;
  private readonly loaded = new Map<string, Loaded>();
  private current: Loaded | undefined;
  private status: PrListViewState["status"] = "loading";
  private message: PrListMessage | undefined;
  private notice: PrListMessage | undefined;
  private refreshing = false;
  private loadingMore = false;
  private readonly inFlight = new Set<string>();
  private viewer: PrPerson | undefined;
  private readonly repoInfo = new Map<string, Promise<PrRepoInfo | undefined>>();
  private readonly facets = new Map<string, PrFacetOptions>();
  private facetsLoading = false;
  private localHead: LocalHead | undefined;
  private localHeadSig = "";

  constructor(
    private readonly repos: RepoManager,
    private readonly auth: GitHubAuth,
    private readonly extensionUri: vscode.Uri,
    private readonly memory?: TargetMemory,
    /** How old a list in sight may get before it is read again. */
    private readonly staleMs: number = STALE_MS,
  ) {
    this.api = new GitHubApi({ getToken: (o) => this.auth.getToken(o) });
    this.graphql = (query, variables) => this.api.graphqlRaw(query, variables, { signal: this.stopped.signal });
    // Checked four times per period, so a list is at most a quarter period
    // past stale when it is read again.
    this.pollTimer = setInterval(() => this.poll(), this.staleMs / 4);
    this.pollTimer.unref?.();
    this.disposables.push(
      this.repos.onDidChange(() => this.scheduleRepoCheck()),
      this.auth.onDidChange(() => {
        // Another account (or none): what can be seen, and who "you" is,
        // are different — start over.
        this.viewer = undefined;
        this.repoInfo.clear();
        this.facets.clear();
        this.forget();
        if (this.visible()) void this.ensure();
      }),
    );
  }

  // ── The webview ────────────────────────────────────────────────────────────

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const d of this.viewDisposables.splice(0)) d.dispose();
    this.view = view;
    this.pageReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    const dist = (...p: string[]) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", ...p)).toString();
    view.webview.html = prListHtml({
      cspSource: view.webview.cspSource,
      nonce: getNonce(),
      codiconCss: dist("codicons", "codicon.css"),
      listCss: dist("webview", "pr-list.css"),
      listJs: dist("webview", "pr-list.js"),
    });
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((m: PrListMessageToHost) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => {
        if (!view.visible) return;
        if (this.current && Date.now() - this.current.at > this.staleMs) void this.refresh();
        else void this.checkRepo();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.pageReady = false;
        }
      }),
    );
    this.setDescription();
  }

  private visible(): boolean {
    return this.view?.visible ?? false;
  }

  private async onMessage(m: PrListMessageToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.pageReady = true;
        this.post();
        void this.ensure();
        return;
      case "segment":
        if (m.segment !== this.segment && ["open", "merged", "closed", "all"].includes(m.segment)) {
          this.segment = m.segment;
          this.showQuery();
        }
        return;
      case "filters": {
        const next = cleanFilters(m.filters);
        if (JSON.stringify(next) !== JSON.stringify(cleanFilters(this.filters))) {
          this.filters = next;
          this.showQuery();
        }
        return;
      }
      case "loadMore":
        return this.loadMore();
      case "refresh":
        return this.refresh();
      case "open":
      case "checkout":
      case "startReview":
      case "merge":
      case "copyLink": {
        const it = this.pullRequestFor(m.number);
        if (!it) return;
        const command = {
          open: "gitstudio.pr.openDescription",
          checkout: "gitstudio.pr.checkout",
          startReview: "gitstudio.pr.startReview",
          merge: "gitstudio.pr.merge",
          copyLink: "gitstudio.pr.copyUrl",
        }[m.type];
        await vscode.commands.executeCommand(command, it);
        if (m.type === "checkout") void this.readLocalHead(true);
        return;
      }
      case "openOnGitHub": {
        const it = this.pullRequestFor(m.number);
        if (it && /^https:\/\/github\.com\//.test(it.pr.htmlUrl)) void vscode.env.openExternal(vscode.Uri.parse(it.pr.htmlUrl));
        return;
      }
      case "target":
        return this.chooseTarget(m.id);
      case "facetOptions":
        return this.loadFacets();
      case "action":
        return this.runAction(m.action);
    }
  }

  private async runAction(a: PrListAction): Promise<void> {
    switch (a.kind) {
      case "signIn":
        await vscode.commands.executeCommand("gitstudio.pr.signIn", a.again ? { again: true } : undefined);
        return;
      case "retry":
        if (this.current) return this.refresh();
        this.forget();
        return this.ensure();
      case "loadMore":
        this.notice = undefined;
        return this.loadMore();
      case "openUrl":
        if (/^https:\/\/github\.com\//.test(a.url)) void vscode.env.openExternal(vscode.Uri.parse(a.url));
        return;
      case "createPr":
        await vscode.commands.executeCommand("gitstudio.pr.create");
        return;
      case "clearFilters":
        this.filters = {};
        this.showQuery();
        return;
      case "switchRepository":
        await vscode.commands.executeCommand("gitstudio.switchRepository");
        return;
    }
  }

  // ── What is shown ──────────────────────────────────────────────────────────

  private queryNow(): Pick<Loaded, "key" | "root" | "target" | "segment" | "filters"> | undefined {
    const r = this.repo;
    return r?.kind === "github" ? queryOf(r.root, r.target.id, this.segment, this.filters) : undefined;
  }

  private queryKeyNow(): string | undefined {
    return this.queryNow()?.key;
  }

  /**
   * The repositories the list offers for a clone (the active one by
   * default), and the one it shows — resolved the list's way, a fork's
   * parent unless another was chosen, even while the view has never been
   * opened (it is collapsed until it is): the palette's commands and the New
   * pull request form act where the list would. Nothing is listed.
   */
  async resolveTargets(entry: RepoEntry | undefined = this.repos.getActive()): Promise<ResolvedTargets | undefined> {
    if (!entry) return undefined;
    const r = this.repo;
    if (r?.kind === "github" && r.root === entry.root) return { targets: r.targets, target: r.target, entry: r.entry };
    return this.pickTarget(entry, await listGitHubRemotes(entry));
  }

  /** The context the PR commands act in: the repository the list shows, or would. */
  async contextResolved(): Promise<GitHubRepoContext | undefined> {
    const t = await this.resolveTargets();
    return t ? contextFor(t.target, t.entry) : undefined;
  }

  /** A clone's targets from its GitHub remotes, and the one shown: the one chosen before, else the default (a fork's parent). */
  private async pickTarget(entry: RepoEntry, remotes: GitHubRemote[]): Promise<ResolvedTargets | undefined> {
    const resolved = await resolvePrTargets(remotes, (owner, repo) => this.infoFor(owner, repo));
    if (!resolved) return undefined;
    const chosen = this.memory?.get(memoryKey(entry.root));
    const target =
      resolved.targets.find((t) => !!chosen && sameId(t.id, chosen)) ??
      resolved.targets.find((t) => t.id === resolved.defaultId) ??
      resolved.targets[0];
    return { targets: resolved.targets, target, entry };
  }

  /** A row of the list on screen, with the context its commands act in. */
  pullRequestFor(n: number): { pr: PullRequest; ctx: GitHubRepoContext } | undefined {
    const r = this.repo;
    const item = this.current?.items.find((i) => i.number === n);
    if (r?.kind !== "github" || !item) return undefined;
    return { pr: toPullRequest(item), ctx: contextFor(r.target, r.entry) };
  }

  /** The state the page is sent. */
  viewState(): PrListViewState {
    const r = this.repo;
    const facets = r?.kind === "github" ? this.facets.get(r.target.id.toLowerCase()) : undefined;
    const cur = this.current;
    const status: PrListViewState["status"] = r === undefined ? "loading" : r.kind === "message" ? "message" : this.status;
    const message = r?.kind === "message" ? r.message : status === "message" ? this.message : undefined;
    return {
      seq: this.seq,
      status,
      ...(message ? { message } : {}),
      ...(this.notice && status === "list" ? { notice: this.notice } : {}),
      targets: r?.kind === "github" ? r.targets.map((t) => ({ id: t.id, owner: t.owner, repo: t.repo, detail: t.detail })) : [],
      ...(r?.kind === "github" ? { target: r.target.id } : {}),
      ...(this.viewer ? { viewer: this.viewer } : {}),
      segment: this.segment,
      filters: { ...this.filters },
      ...(status === "list" && cur?.counts ? { counts: cur.counts } : {}),
      rows: (status === "list" ? (cur?.items ?? []) : []).map((i) => ({ ...i, checkedOut: isCheckedOut(i, this.localHead) })),
      total: status === "list" ? (cur?.total ?? 0) : 0,
      hasMore: status === "list" && !!cur?.hasMore,
      loadingMore: this.loadingMore,
      refreshing: this.refreshing,
      ...(facets ? { facetOptions: facets } : {}),
      ...(this.facetsLoading ? { facetOptionsLoading: true } : {}),
      now: Date.now(),
    };
  }

  private post(): void {
    this.setDescription();
    if (!this.view || !this.pageReady) return;
    this.seq++;
    void this.view.webview.postMessage({ type: "state", state: this.viewState() });
  }

  private setDescription(): void {
    if (!this.view) return;
    this.view.description = this.repo?.kind === "github" ? this.repo.target.id : undefined;
  }

  // ── Which repository ───────────────────────────────────────────────────────

  /** Resolve the repository (once), then read what is not read yet. */
  private async ensure(): Promise<void> {
    if (!this.repo) {
      if (!this.resolving) {
        this.resolving = this.resolveRepo().finally(() => {
          this.resolving = undefined;
        });
      }
      await this.resolving;
    }
    const r = this.repo;
    if (r?.kind !== "github") {
      this.post();
      return;
    }
    if (!this.current || this.current.key !== this.queryKeyNow()) this.showQuery();
  }

  private async resolveRepo(): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      const discovering = !!this.repos.isDiscovering?.();
      this.repo = {
        kind: "message",
        root: undefined,
        discovering,
        message: {
          icon: "repo",
          tone: "info",
          title: discovering ? LOOKING_FOR_A_REPOSITORY : l10n.t("Open a Git repository to see its pull requests."),
          buttons: [],
        },
      };
      return;
    }
    const remotes = await listGitHubRemotes(entry);
    if (this.repos.getActive()?.root !== entry.root) return; // another one since; its check resolves it
    if (remotes.length === 0) {
      this.repo = { kind: "message", root: entry.root, discovering: false, message: noGitHubMessage(await whyNoGitHub(this.repos)) };
      return;
    }
    if (!(await this.auth.isConnected())) {
      this.repo = { kind: "message", root: entry.root, discovering: false, message: SIGNED_OUT };
      return;
    }
    const resolved = await this.pickTarget(entry, remotes);
    if (!resolved || this.repos.getActive()?.root !== entry.root) return;
    this.repo = { kind: "github", root: entry.root, sig: remoteSig(remotes), entry, remotes, targets: resolved.targets, target: resolved.target };
    void this.readLocalHead(false);
  }

  /** Is `owner/repo` a fork (and of what)? Asked once per session. */
  private infoFor(owner: string, repo: string): Promise<PrRepoInfo | undefined> {
    const key = `${owner}/${repo}`.toLowerCase();
    let p = this.repoInfo.get(key);
    if (!p) {
      p = fetchRepoInfo(this.graphql, owner, repo).catch(() => {
        // Not known now (offline, refused): asked again next time.
        this.repoInfo.delete(key);
        return undefined;
      });
      this.repoInfo.set(key, p);
    }
    return p;
  }

  private async chooseTarget(id: string): Promise<void> {
    const r = this.repo;
    if (r?.kind !== "github") return;
    const t = r.targets.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!t || t.id === r.target.id) return;
    await this.memory?.update(memoryKey(r.root), t.id);
    // Another repository: its labels and people are its own.
    this.filters = {};
    this.repo = { ...r, target: t };
    this.current = undefined;
    this.notice = undefined;
    this.showQuery();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Show the list for the query now: what is known of it at once, then GitHub's answer. */
  private showQuery(): void {
    const key = this.queryKeyNow();
    if (!key) {
      this.post();
      return;
    }
    const cached = this.loaded.get(key);
    this.current = cached;
    this.notice = undefined;
    this.message = undefined;
    this.status = cached ? "list" : "loading";
    this.loadingMore = false;
    void this.load();
  }

  /** Read the first page of the query now — or re-read the rows on screen. */
  private async load(): Promise<void> {
    const r = this.repo;
    const q = this.queryNow();
    const key = q?.key;
    if (r?.kind !== "github" || !q || !key || this.inFlight.has(key)) {
      this.post();
      return;
    }
    this.inFlight.add(key);
    const shown = this.current?.key === key ? this.current : undefined;
    this.refreshing = !!shown;
    this.post();
    // A refresh re-reads every row on screen — a page of up to 100 at a
    // time — so the rows paged in stay where they are.
    const want = shown ? Math.max(PR_PAGE, shown.items.length) : PR_PAGE;
    const ask = { owner: r.target.owner, repo: r.target.repo, state: this.segment, filters: this.filters };
    try {
      const page = await fetchPrListPage(this.graphql, { ...ask, first: Math.min(REFRESH_MAX, want) });
      if (this.stopped.signal.aborted || this.queryKeyNow() !== key) return; // closed, or another question's answer
      let items = page.items;
      let { hasMore, cursor } = page;
      while (hasMore && cursor && items.length < want) {
        const next = await fetchPrListPage(this.graphql, { ...ask, first: Math.min(REFRESH_MAX, want - items.length), after: cursor });
        if (this.stopped.signal.aborted || this.queryKeyNow() !== key) return;
        // Sorted by last update: a row can move to a later page between reads.
        const seen = new Set(items.map((i) => i.number));
        items = [...items, ...next.items.filter((i) => !seen.has(i.number))];
        ({ hasMore, cursor } = next);
        if (next.items.length === 0) break;
      }
      const loaded: Loaded = {
        ...q,
        items,
        total: page.total,
        hasMore,
        cursor,
        counts: page.counts ?? shown?.counts,
        at: Date.now(),
      };
      if (page.viewer) this.viewer = page.viewer;
      this.loaded.set(key, loaded);
      this.current = loaded;
      this.status = "list";
      this.notice = undefined;
      this.message = undefined;
    } catch (err) {
      if (this.stopped.signal.aborted || this.queryKeyNow() !== key) return;
      const d = describe(err);
      if (shown) {
        // The rows on screen are still worth reading; say they are old.
        this.notice = {
          icon: "warning",
          tone: "warning",
          title: l10n.t("Couldn't refresh: {0}", d.message),
          detail: l10n.t("Showing the list as it was {0}.", ago(shown.at)),
          buttons:
            d.kind === "auth" && d.status === 401
              ? [{ label: l10n.t("Sign in again"), icon: "sign-in", action: { kind: "signIn", again: true } }]
              : [{ label: l10n.t("Retry"), icon: "refresh", action: { kind: "retry" } }],
        };
      } else {
        this.status = "message";
        this.message = failureMessage(d, r.target.id);
      }
    } finally {
      this.inFlight.delete(key);
      if (!this.stopped.signal.aborted && this.queryKeyNow() === key) {
        this.refreshing = false;
        this.post();
      }
    }
  }

  /** The next page of the list on screen. */
  private async loadMore(): Promise<void> {
    const r = this.repo;
    const cur = this.current;
    const key = this.queryKeyNow();
    if (r?.kind !== "github" || !cur || cur.key !== key || !cur.hasMore || !cur.cursor || this.loadingMore) return;
    this.loadingMore = true;
    this.notice = undefined;
    this.post();
    try {
      const page = await fetchPrListPage(this.graphql, {
        owner: r.target.owner,
        repo: r.target.repo,
        state: this.segment,
        filters: this.filters,
        first: PR_PAGE,
        after: cur.cursor,
      });
      if (this.queryKeyNow() !== key || this.current !== cur) return;
      // Sorted by last update: a row can move to a later page between reads.
      const seen = new Set(cur.items.map((i) => i.number));
      cur.items = [...cur.items, ...page.items.filter((i) => !seen.has(i.number))];
      cur.hasMore = page.hasMore;
      cur.cursor = page.cursor;
      if (page.total) cur.total = page.total;
    } catch (err) {
      if (this.queryKeyNow() !== key) return;
      this.notice = {
        icon: "warning",
        tone: "warning",
        title: l10n.t("Couldn't load more: {0}", describe(err).message),
        buttons: [{ label: l10n.t("Retry"), icon: "refresh", action: { kind: "loadMore" } }],
      };
    } finally {
      if (this.queryKeyNow() === key) {
        this.loadingMore = false;
        this.post();
      }
    }
  }

  /** Read the list again (Refresh, a sign-in, a stale list in sight). Rows stay while it runs — all of them. */
  async refresh(): Promise<void> {
    if (!this.repo || this.repo.kind === "message") {
      this.forget();
      return this.ensure();
    }
    if (!this.current) {
      this.showQuery();
      return;
    }
    await this.load();
  }

  private async loadFacets(): Promise<void> {
    const r = this.repo;
    if (r?.kind !== "github" || this.facetsLoading) return;
    const id = r.target.id.toLowerCase();
    if (this.facets.has(id)) {
      this.post();
      return;
    }
    this.facetsLoading = true;
    this.post();
    try {
      this.facets.set(id, await fetchFacetOptions(this.graphql, r.target.owner, r.target.repo));
    } catch {
      // The menus offer what the rows show, and a login can be typed.
      this.facets.set(id, { labels: [], people: [], truncated: false });
    } finally {
      this.facetsLoading = false;
      this.post();
    }
  }

  /**
   * The slow refresh of a list in sight: only while the view is visible and
   * the window has focus (a window in the background asks nothing), and
   * only once the list is stale. Quiet — the rows stay while it runs.
   */
  private poll(): void {
    if (!this.current || this.refreshing || !this.visible()) return;
    if (vscode.window.state?.focused === false) return;
    if (Date.now() - this.current.at < this.staleMs) return;
    void this.load();
  }

  // ── When the repository changes ────────────────────────────────────────────

  /**
   * RepoManager fires on EVERY working-tree change. Only a different
   * repository (or a different GitHub remote on it) matters to the list:
   * what the view shows is dropped at once (rows of another repository would
   * aim every action at it). The branch checked out is re-read from git.
   */
  private scheduleRepoCheck(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.checkRepo();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async checkRepo(): Promise<void> {
    const r = this.repo;
    if (!r) {
      if (this.visible()) void this.ensure();
      return;
    }
    const active = this.repos.getActive();
    const discovering = !active && !!this.repos.isDiscovering?.();
    if (active?.root !== r.root || (r.kind === "message" && r.discovering !== discovering)) {
      this.forget();
      if (this.visible()) void this.ensure();
      return;
    }
    if (!this.visible() || !active) return; // hidden: asked again when shown
    // The same repository: was a GitHub remote added, removed or re-pointed?
    // A read of its remotes on disk — GitHub is not asked.
    const remotes = await listGitHubRemotes(active);
    if ((r.kind === "github" ? r.sig : remoteSig([])) !== remoteSig(remotes)) {
      if (r.kind === "github" && (await this.adoptRemotes(r, remotes))) return;
      this.forget();
      void this.ensure();
      return;
    }
    if (r.kind === "github") void this.readLocalHead(true);
  }

  /**
   * A remote added or removed — a Checkout adds a fork's, and removes it
   * again when it fails — while the repository shown is still one of the
   * clone's: the switcher learns of it, and the rows, the filters and every
   * list on hand stay. Nothing is read from GitHub but, for a new first
   * remote, whether it is a fork. False when the repository shown is gone
   * (or re-pointed): then the view starts over.
   */
  private async adoptRemotes(r: Extract<RepoState, { kind: "github" }>, remotes: GitHubRemote[]): Promise<boolean> {
    if (remotes.length === 0) return false;
    const resolved = await resolvePrTargets(remotes, (owner, repo) => this.infoFor(owner, repo)).catch(() => undefined);
    if (this.repo !== r) return true; // changed meanwhile: that change's own check decides
    const target = resolved?.targets.find((t) => sameId(t.id, r.target.id));
    if (!resolved || !target) return false;
    this.repo = { ...r, sig: remoteSig(remotes), remotes, targets: resolved.targets, target };
    // A repository no longer offered takes its lists with it.
    for (const [k, l] of this.loaded) if (l.root === r.root && !resolved.targets.some((t) => sameId(t.id, l.target))) this.loaded.delete(k);
    this.post();
    void this.readLocalHead(true);
    return true;
  }

  /** Drop what the view shows — it is another repository's — and draw again. */
  private forget(): void {
    this.repo = undefined;
    this.loaded.clear();
    this.current = undefined;
    this.message = undefined;
    this.notice = undefined;
    this.status = "loading";
    this.refreshing = false;
    this.loadingMore = false;
    this.filters = {};
    this.localHead = undefined;
    this.localHeadSig = "";
    this.post();
  }

  /** Which branch is checked out, and what it tracks — git only. */
  private async readLocalHead(repaint: boolean): Promise<void> {
    const r = this.repo;
    if (r?.kind !== "github") return;
    const head = await readLocalHead(r.entry, r.remotes);
    const now = this.repo;
    if (now?.kind !== "github" || now.root !== r.root) return;
    const sig = JSON.stringify(head ?? null);
    if (sig === this.localHeadSig) return;
    this.localHeadSig = sig;
    this.localHead = head;
    if (repaint || this.current) this.post();
  }

  // ── Our own mutations, patched in ──────────────────────────────────────────

  /** A PR was merged here: it leaves Open, and reads Merged everywhere else. */
  markMerged(owner: string, repo: string, n: number): void {
    this.markKind(owner, repo, n, "merged");
  }

  /**
   * A PR's state changed here (merged, closed, reopened, marked ready): each
   * list on hand moves the row — out of a segment it no longer belongs to,
   * into the top of one it now does, the counts with it. A patch, never a
   * reload; the next read of GitHub has the last word.
   */
  markKind(owner: string, repo: string, n: number, kind: PrListItem["kind"]): void {
    const r = this.repo;
    if (r?.kind !== "github") return;
    // THIS repository's lists only: another one's #n is another pull request
    // (a fork's own, while the list shows its parent).
    const lists = this.listsOf(r.root, `${owner}/${repo}`);
    const inSegment = (segment: PrListState, k: PrListItem["kind"]) =>
      segment === "all" || (segment === "open" ? k === "open" || k === "draft" : segment === k);
    const countOf = (k: PrListItem["kind"]): keyof PrListCounts => (k === "draft" ? "open" : k);
    let known: PrListItem | undefined;
    for (const l of lists) known ??= l.items.find((i) => i.number === n);
    if (!known) return;
    // The filters it is known to answer: those of a list that had it — and
    // none at all. A list under other filters may not count it.
    const answers = new Set([NO_FILTERS, ...lists.filter((l) => l.items.some((i) => i.number === n)).map((l) => l.filters)]);
    const now = new Date().toISOString();
    const next: PrListItem = {
      ...known,
      kind,
      draft: kind === "draft" ? true : kind === "open" ? false : known.draft,
      state: kind === "open" || kind === "draft" ? "open" : "closed",
      mergedAt: kind === "merged" ? (known.mergedAt ?? now) : null,
      closedAt: kind === "closed" || kind === "merged" ? (known.closedAt ?? now) : null,
    };
    const was = known.kind;
    for (const l of lists) {
      const had = l.items.some((i) => i.number === n);
      const belongs = inSegment(l.segment, kind);
      const counted = answers.has(l.filters);
      if (had && !belongs) {
        l.items = l.items.filter((i) => i.number !== n);
        l.total = Math.max(0, l.total - 1);
      } else if (had) {
        l.items = l.items.map((i) => (i.number === n ? next : i));
      } else if (belongs && counted) {
        l.items = [next, ...l.items];
        l.total += 1;
      }
      if (counted && l.counts && countOf(was) !== countOf(kind)) {
        l.counts = { ...l.counts, [countOf(was)]: Math.max(0, l.counts[countOf(was)] - 1), [countOf(kind)]: l.counts[countOf(kind)] + 1 };
      }
    }
    this.post();
  }

  /** The lists on hand of one repository, for one clone. */
  private listsOf(root: string, repository: string): Loaded[] {
    return [...this.loaded.values()].filter((l) => l.root === root && sameId(l.target, repository));
  }

  /** A PR we just created joins the top of the lists it belongs to. */
  addPr(owner: string, repo: string, pr: PullRequest): void {
    const r = this.repo;
    if (r?.kind !== "github") return;
    const item = itemFromPullRequest(pr);
    // That repository's lists, shown or not — under no filters, where it surely belongs.
    for (const l of this.listsOf(r.root, `${owner}/${repo}`)) {
      if (l.filters !== NO_FILTERS || (l.segment !== "open" && l.segment !== "all")) continue;
      if (l.items.some((i) => i.number === item.number)) continue;
      l.items = [item, ...l.items];
      l.total += 1;
      if (l.counts) l.counts = { ...l.counts, open: l.counts.open + 1 };
    }
    this.post();
  }

  dispose(): void {
    this.stopped.abort();
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    clearInterval(this.pollTimer);
    for (const d of [...this.disposables, ...this.viewDisposables]) d.dispose();
    this.disposables.length = 0;
    this.viewDisposables.length = 0;
  }
}

function memoryKey(root: string): string {
  return `gitstudio.pr.target:${root}`;
}

function cleanFilters(f: PrListFilters | undefined): PrListFilters {
  const out: PrListFilters = {};
  for (const k of ["text", "author", "reviewRequested", "assignee", "label"] as const) {
    const v = f?.[k];
    if (typeof v === "string" && v.trim().length > 0) out[k] = k === "text" ? v : v.trim();
  }
  return out;
}

/** whyNoGitHub's sentences as a message: a short title, and what it read. */
function noGitHubMessage(why: string): PrListMessage {
  if (/^None of this repository's remotes is on github\.com/.test(why)) {
    return { icon: "repo", tone: "info", title: l10n.t("This repository isn't on GitHub"), detail: why, buttons: [] };
  }
  if (/^This repository has no remotes/.test(why)) {
    return {
      icon: "repo",
      tone: "info",
      title: l10n.t("This repository has no remotes"),
      detail: l10n.t("Pull requests show here once a remote points at github.com."),
      buttons: [],
    };
  }
  return { icon: "repo", tone: "info", title: why, buttons: [] };
}

/** The branch checked out, and what it tracks (its remote, as a GitHub repository). */
export async function readLocalHead(entry: RepoEntry, remotes: readonly GitHubRemote[]): Promise<LocalHead | undefined> {
  try {
    const b = await entry.ctx.process.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (b.code !== 0) return {};
    const branch = b.stdout.trim();
    if (!branch) return {};
    const up = await entry.ctx.process.run([
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ]);
    const [remote, ref] = (up.code === 0 ? up.stdout.trim() : "").split("\0");
    const tracked = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
    const gh = remotes.find((r) => r.name === remote);
    return {
      branch,
      ...(tracked ? { upstream: { branch: tracked, ...(gh ? { repo: `${gh.owner}/${gh.repo}` } : {}) } } : {}),
    };
  } catch {
    return undefined;
  }
}
