import * as vscode from "vscode";
import { relativeTime } from "../util/relativeTime";
import type { RepoManager } from "../git/repoManager";
import type { GitHubAuth } from "./githubAuth";
import { GitHubApi, GitHubApiError, type PullRequest } from "./githubApi";
import { ciWords, type CiState } from "./prModel";
import {
  resolveGitHubContext,
  whyNoGitHub,
  type GitHubRepoContext,
} from "./repoContext";

// The Pull Requests tree (gitstudio.pullRequests). It groups the active GitHub
// repo's open PRs into "Waiting for my review" / "Created by me" / "All open",
// using the signed-in login. The view's description names the repository;
// when there is none on GitHub, the view's message says why.
//
// WHEN IT TALKS TO GITHUB. On the first show, on Refresh, when the active
// repository (or its GitHub remote) changes, when sign-in changes, and when the
// view comes back into sight with a list older than STALE_MS. Never on
// working-tree churn: the tree used to reload on every RepoManager change —
// every file save — even while collapsed, at up to ten requests a time.

const REFRESH_DEBOUNCE_MS = 400;
/** A list older than this is refreshed when the view is shown again. */
const STALE_MS = 2 * 60 * 1000;

type PrTreeNode = GroupNode | PrNode | MessageNode;

type GroupKind = "review" | "mine" | "open";

const GROUP_LABELS: Record<GroupKind, string> = {
  review: "Waiting for my review",
  mine: "Created by me",
  open: "All open",
};

const GROUP_ICONS: Record<GroupKind, string> = {
  review: "eye",
  mine: "account",
  open: "git-pull-request",
};

/** A collapsible group header. */
class GroupNode extends vscode.TreeItem {
  readonly kind = "group" as const;
  constructor(
    readonly group: GroupKind,
    readonly prs: PullRequest[],
  ) {
    super(
      GROUP_LABELS[group],
      prs.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.description = String(prs.length);
    this.iconPath = new vscode.ThemeIcon(GROUP_ICONS[group]);
    this.tooltip = `${GROUP_LABELS[group]} — ${prs.length} pull request${
      prs.length === 1 ? "" : "s"
    }`;
    this.contextValue = `gitstudio.prGroup.${group}`;
  }
}

/** The colour a row's PR icon takes from its checks. */
const CI_COLORS: Partial<Record<CiState, string>> = {
  success: "charts.green",
  failure: "charts.red",
  pending: "charts.yellow",
};

/** A single pull request row. */
export class PrNode extends vscode.TreeItem {
  readonly kind = "pr" as const;
  constructor(
    readonly pr: PullRequest,
    readonly ctx: GitHubRepoContext,
    ci?: CiState,
  ) {
    super(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.None);

    const author = pr.user?.login ?? "unknown";

    // The list is sorted by LAST UPDATE, so that is the age the row shows —
    // and says so. The creation age beside it made a busy old PR look stale.
    //
    // The PR icon carries the checks' state as a themed colour, drafts
    // included, so the row stays one clean line. A TreeItem description is
    // plain text — `$(check)` there showed as those eight characters — so the
    // words live in the tooltip and the accessible label.
    const color = ci && CI_COLORS[ci] ? new vscode.ThemeColor(CI_COLORS[ci]!) : undefined;
    this.iconPath = new vscode.ThemeIcon(
      pr.draft ? "git-pull-request-draft" : "git-pull-request",
      color,
    );
    this.description = `${author} · updated ${ago(Date.parse(pr.updatedAt))}`;
    this.accessibilityInformation = {
      label: `Pull request ${pr.number}, ${pr.title}${pr.draft ? ", draft" : ""}, by ${author}${
        ci ? `, ${ciWords(ci).toLowerCase()}` : ""
      }`,
    };

    // Drafts get their own context value: GitHub refuses to merge one, so
    // Merge… is not offered on it.
    this.contextValue = pr.draft ? "gitstudio.pr.draft" : "gitstudio.pr";
    this.tooltip = buildTooltip(pr, ci);
    this.command = {
      command: "gitstudio.pr.openDescription",
      title: "Open Description",
      arguments: [this],
    };
  }
}

/** A leaf row for a message: an error with its way out, or a note. */
class MessageNode extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(label: string, icon = "info", command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "gitstudio.prMessage";
    this.tooltip = label;
    if (command) {
      this.command = command;
    }
  }
}

/** The CI line of the tooltip, in words (the tooltip renders icons). */
function ciLine(ci?: CiState): string | undefined {
  switch (ci) {
    case "success":
      return "$(pass) Checks passed";
    case "failure":
      return "$(error) Checks failed";
    case "pending":
      return "$(clock) Checks running";
    case "none":
      return "No checks";
    default:
      return undefined;
  }
}

function buildTooltip(pr: PullRequest, ci?: CiState): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  const headIcon = pr.draft
    ? "$(git-pull-request-draft)"
    : "$(git-pull-request)";
  md.appendMarkdown(`${headIcon} **#${pr.number} ${escapeMd(pr.title)}**\n\n`);
  const author = pr.user?.login;
  if (author) {
    md.appendMarkdown(`$(account) ${escapeMd(author)}\n\n`);
  }
  if (pr.draft) {
    md.appendMarkdown(`$(git-pull-request-draft) Draft\n\n`);
  }
  const line = ciLine(ci);
  if (line) {
    md.appendMarkdown(`${line}\n\n`);
  }
  md.appendMarkdown(
    `Updated ${escapeMd(relativeTime(Date.parse(pr.updatedAt) / 1000))} ago · opened ${escapeMd(
      relativeTime(Date.parse(pr.createdAt) / 1000),
    )} ago\n\n`,
  );
  // Inside a `code span` backslash escapes render LITERALLY (CommonMark), so
  // escapeMd would display "release\-1\.x". Backticks are the only character
  // that can break the span — neutralize just those.
  const codeSpan = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  md.appendMarkdown(
    `$(git-branch) ${codeSpan(pr.base.ref)} ← ${codeSpan(pr.head.label)}\n\n`,
  );
  const body = (pr.body ?? "").trim();
  if (body.length > 0) {
    const excerpt = body.length > 240 ? `${body.slice(0, 240)}…` : body;
    md.appendMarkdown(`${escapeMd(excerpt)}\n`);
  }
  return md;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

interface LoadedData {
  /** Which repository this list is: the root and its GitHub owner/repo. */
  key: string;
  ctx: GitHubRepoContext;
  pulls: PullRequest[];
  /** More open PRs exist than were read (the page cap stopped the read). */
  truncated: boolean;
  /** The signed-in login, when it could be read. */
  login: string | undefined;
  ci: Map<number, CiState>;
  at: number;
}

function identity(ctx: GitHubRepoContext): string {
  return `${ctx.entry.root}|${ctx.owner}/${ctx.repo}`;
}

export class PullRequestsTreeProvider
  implements vscode.TreeDataProvider<PrTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<PrTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly api: GitHubApi;
  private data: LoadedData | undefined;
  private lastError: { message: string; kind?: GitHubApiError["kind"] } | undefined;
  /** The login, read once per sign-in (GET /user was re-sent on every load). */
  private login: string | undefined;
  private view: vscode.TreeView<PrTreeNode> | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly auth: GitHubAuth,
  ) {
    this.api = new GitHubApi({ getToken: (o) => this.auth.getToken(o) });
    this.disposables.push(
      this.repos.onDidChange(() => this.scheduleRepoCheck()),
      this.auth.onDidChange(() => {
        // Another account (or none): what "mine" means, and what can be seen,
        // are different — start over.
        this.login = undefined;
        this.data = undefined;
        this.lastError = undefined;
        this.redraw();
      }),
    );
  }

  /** The view this provider fills: its description and message are ours. */
  attach(view: vscode.TreeView<PrTreeNode>): void {
    this.view = view;
    this.disposables.push(
      view.onDidChangeVisibility((e) => {
        if (!e.visible) {
          return;
        }
        if (this.data && Date.now() - this.data.at > STALE_MS) {
          this.refresh();
        } else {
          // Hidden, it did not ask whether the GitHub remote changed.
          void this.checkRepo();
        }
      }),
    );
  }

  private visible(): boolean {
    return this.view?.visible ?? true;
  }

  /** Resolve the current GitHub context, for commands that need owner/repo. */
  resolveContext(): Promise<GitHubRepoContext | null> {
    return resolveGitHubContext(this.repos);
  }

  getApi(): GitHubApi {
    return this.api;
  }

  /** Reload from GitHub (the Refresh button, a sign-in). Rows stay while it runs. */
  refresh(): void {
    if (this.data) {
      void vscode.window.withProgress(
        { location: { viewId: "gitstudio.pullRequests" } },
        () => this.revalidate(),
      );
    } else {
      this.lastError = undefined;
      // Nothing loaded yet — let getChildren do the first (lazy) load.
      this.emitter.fire(undefined);
    }
  }

  /** Repaint from what is loaded (no request). */
  private redraw(): void {
    this.emitter.fire(undefined);
  }

  /**
   * Optimistic row patches for our own one-click mutations — the list is
   * edited, never reloaded. A merged PR leaves the open list.
   */
  removePr(owner: string, repo: string, n: number): void {
    const d = this.data;
    if (!d || d.ctx.owner !== owner || d.ctx.repo !== repo) {
      return;
    }
    const before = d.pulls.length;
    d.pulls = d.pulls.filter((p) => p.number !== n);
    if (d.pulls.length !== before) {
      this.redraw();
    }
  }

  /** A PR we just created joins the top of the list. */
  addPr(owner: string, repo: string, pr: PullRequest): void {
    const d = this.data;
    if (!d || d.ctx.owner !== owner || d.ctx.repo !== repo) {
      return;
    }
    d.pulls = [pr, ...d.pulls.filter((p) => p.number !== pr.number)];
    this.redraw();
  }

  private revalidating = false;
  private async revalidate(): Promise<void> {
    if (this.revalidating) {
      return;
    }
    this.revalidating = true;
    try {
      const ctx = await resolveGitHubContext(this.repos);
      if (ctx && (await this.auth.isConnected())) {
        this.data = await this.load(ctx);
        this.lastError = undefined;
      } else {
        this.data = undefined;
      }
    } catch (err) {
      this.lastError = describe(err);
    } finally {
      this.revalidating = false;
      this.redraw();
    }
  }

  /**
   * RepoManager fires on EVERY working-tree change. Only a different
   * repository (or a different GitHub remote on it) matters to this list: its
   * rows are dropped at once — they belong to the other repository, and every
   * action on them would target it — and the new one loads when in sight.
   */
  private scheduleRepoCheck(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.checkRepo();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async checkRepo(): Promise<void> {
    const active = this.repos.getActive();
    if (this.data && active?.root !== this.data.ctx.entry.root) {
      this.data = undefined;
      this.lastError = undefined;
      this.redraw();
      return;
    }
    if (!this.visible() || !this.data) {
      // Hidden: whether the remote changed is asked when the view is next
      // shown. Nothing loaded: the next getChildren resolves it anyway.
      return;
    }
    const ctx = await resolveGitHubContext(this.repos);
    const now = ctx ? identity(ctx) : undefined;
    if (now !== this.data?.key) {
      this.data = undefined;
      this.lastError = undefined;
      this.redraw();
    }
  }

  getTreeItem(element: PrTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PrTreeNode): Promise<PrTreeNode[]> {
    if (element) {
      if (element.kind === "group" && this.data) {
        const d = this.data;
        return element.prs.map((pr) => new PrNode(pr, d.ctx, d.ci.get(pr.number)));
      }
      return [];
    }

    // Root: ensure data is loaded.
    const ctx = await resolveGitHubContext(this.repos);
    if (!ctx) {
      // Not a GitHub repo (or no active repo): say which, not a blank view.
      this.data = undefined;
      this.setHeader(undefined, (await this.auth.isConnected()) ? await whyNoGitHub(this.repos) : undefined);
      return [];
    }

    // Connected? A silent check; the connect-prompt (viewsWelcome) handles the
    // not-connected case so we don't show a noisy error row.
    if (!(await this.auth.isConnected())) {
      this.setHeader(undefined, undefined);
      return [];
    }
    this.setHeader(`${ctx.owner}/${ctx.repo}`, undefined);

    if (this.data && this.data.key !== identity(ctx)) {
      this.data = undefined;
    }
    if (!this.data) {
      try {
        this.data = await this.load(ctx);
        this.lastError = undefined;
      } catch (err) {
        this.lastError = describe(err);
        return [this.errorRow(this.lastError)];
      }
    }

    const d = this.data;
    if (this.lastError) {
      // A refresh failed; the rows below are the last good list. Say so.
      this.setHeader(
        `${ctx.owner}/${ctx.repo}`,
        `Couldn't refresh: ${this.lastError.message} Showing the list as it was ${ago(d.at)}.`,
      );
    }
    const result: PrTreeNode[] = [];
    if (d.login) {
      const review = d.pulls.filter(
        (pr) =>
          pr.user?.login !== d.login &&
          pr.requestedReviewers.some((r) => r.login === d.login),
      );
      const mine = d.pulls.filter((pr) => pr.user?.login === d.login);
      if (review.length > 0) {
        result.push(new GroupNode("review", review));
      }
      result.push(new GroupNode("mine", mine));
    }
    // Without a login, "Created by me" would be an empty group claiming you
    // have none — only the list itself is shown.
    result.push(new GroupNode("open", d.pulls));
    if (d.truncated) {
      result.push(
        new MessageNode(
          `Showing the ${d.pulls.length} most recently updated open pull requests — there are more on GitHub.`,
          "info",
          {
            command: "vscode.open",
            title: "Open on GitHub",
            arguments: [vscode.Uri.parse(`https://github.com/${d.ctx.owner}/${d.ctx.repo}/pulls`)],
          },
        ),
      );
    }
    return result;
  }

  private setHeader(description: string | undefined, message: string | undefined): void {
    if (!this.view) {
      return;
    }
    this.view.description = description;
    this.view.message = message;
  }

  private errorRow(err: { message: string; kind?: GitHubApiError["kind"] }): MessageNode {
    return err.kind === "auth"
      ? new MessageNode(`${err.message} Click to sign in.`, "warning", {
          command: "gitstudio.pr.signIn",
          title: "Sign in to GitHub",
        })
      : new MessageNode(`${err.message} Click to retry.`, "warning", {
          command: "gitstudio.pr.refresh",
          title: "Retry",
        });
  }

  private async load(ctx: GitHubRepoContext): Promise<LoadedData> {
    // The pulls list and the current login are independent — fetch them together
    // rather than one after the other (saves a full GitHub round-trip on first
    // paint). The login is asked once per sign-in.
    const [pulls, me] = await Promise.all([
      this.api.listOpenPulls(ctx.owner, ctx.repo),
      this.login !== undefined ? Promise.resolve(undefined) : this.api.currentLogin(),
    ]);
    if (me?.login) {
      this.login = me.login;
    }
    const data: LoadedData = {
      key: identity(ctx),
      ctx,
      pulls: pulls.items,
      truncated: pulls.truncated,
      login: this.login,
      ci: new Map(),
      at: Date.now(),
    };
    // Checks colour every row, fetched off the first-paint path: one GraphQL
    // request per 50 PRs (statusCheckRollup, which counts check runs AND
    // statuses), then a repaint.
    void this.loadCi(data);
    return data;
  }

  private async loadCi(data: LoadedData): Promise<void> {
    try {
      data.ci = await this.api.ciForPulls(
        data.ctx.owner,
        data.ctx.repo,
        data.pulls.map((p) => p.number),
      );
    } catch {
      return; // rows keep their plain icons
    }
    // Only repaint if this data is still the one on screen — a later refresh may
    // have replaced it, and we must not clobber fresher rows with stale colours.
    if (this.data === data) {
      this.redraw();
    }
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

/** "just now" / "3m ago", from epoch milliseconds. */
function ago(ms: number): string {
  const r = relativeTime(ms / 1000);
  return r === "now" ? "just now" : `${r} ago`;
}

function describe(err: unknown): { message: string; kind?: GitHubApiError["kind"] } {
  if (err instanceof GitHubApiError) {
    return { message: err.message, kind: err.kind };
  }
  return { message: "Couldn't load pull requests from GitHub." };
}
