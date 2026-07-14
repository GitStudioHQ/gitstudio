import * as vscode from "vscode";
import { relativeTime } from "../util/relativeTime";
import type { RepoManager } from "../git/repoManager";
import type { GitHubAuth } from "./githubAuth";
import { GitHubApi, GitHubApiError, type PullRequest } from "./githubApi";
import { resolveGitHubContext, type GitHubRepoContext } from "./repoContext";

// The Pull Requests tree (gitstudio.pullRequests). It groups the active GitHub
// repo's open PRs into "Waiting for my review" / "Created by me" / "All open",
// best-effort using the signed-in login. Loads are silent: if GitHub isn't
// connected or the repo isn't on github.com, the tree is empty and the
// viewsWelcome connect-prompt shows. A short cache + debounced refresh keeps it
// responsive on RepoManager churn.

const REFRESH_DEBOUNCE_MS = 400;

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

/** A single pull request row. */
export class PrNode extends vscode.TreeItem {
  readonly kind = "pr" as const;
  constructor(
    readonly pr: PullRequest,
    readonly ctx: GitHubRepoContext,
    statusGlyph?: string,
  ) {
    super(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.None);

    const author = pr.user?.login ?? "unknown";
    const age = relativeTime(Date.parse(pr.createdAt) / 1000);

    // The PR icon carries CI status as a themed color so the row stays a clean
    // single line; draft PRs read muted regardless of CI.
    const ciColor = statusColor(statusGlyph);
    this.iconPath = pr.draft
      ? new vscode.ThemeIcon("git-pull-request-draft")
      : new vscode.ThemeIcon("git-pull-request", ciColor);

    // CI glyph (when known) leads the muted metadata: status · author · age.
    this.description = statusGlyph
      ? `${statusGlyph} ${author} · ${age}`
      : `${author} · ${age}`;

    this.contextValue = "gitstudio.pr";
    this.tooltip = buildTooltip(pr, statusGlyph);
    this.command = {
      command: "gitstudio.pr.openDescription",
      title: "Open Description",
      arguments: [this],
    };
  }
}

/** A leaf row used for transient messages (loading / errors). */
class MessageNode extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(label: string, icon = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "gitstudio.prMessage";
  }
}

/** Map a CI glyph to a themed status color for the row icon. */
function statusColor(glyph?: string): vscode.ThemeColor | undefined {
  switch (glyph) {
    case "$(check)":
      return new vscode.ThemeColor("charts.green");
    case "$(x)":
      return new vscode.ThemeColor("charts.red");
    case "$(circle-filled)":
      return new vscode.ThemeColor("charts.yellow");
    default:
      return undefined;
  }
}

/** Human-readable CI label for the tooltip. */
function statusLabel(glyph?: string): string | undefined {
  switch (glyph) {
    case "$(check)":
      return "$(check) Checks passing";
    case "$(x)":
      return "$(x) Checks failing";
    case "$(circle-filled)":
      return "$(circle-filled) Checks running";
    default:
      return undefined;
  }
}

function buildTooltip(
  pr: PullRequest,
  statusGlyph?: string,
): vscode.MarkdownString {
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
  const ci = statusLabel(statusGlyph);
  if (ci) {
    md.appendMarkdown(`${ci}\n\n`);
  }
  md.appendMarkdown(
    `$(git-branch) \`${escapeMd(pr.base.ref)}\` ← \`${escapeMd(pr.head.label)}\`\n\n`,
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
  ctx: GitHubRepoContext;
  groups: Record<GroupKind, PullRequest[]>;
  statusByNumber: Map<number, string>;
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
  private lastError: string | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly auth: GitHubAuth,
  ) {
    this.api = new GitHubApi({ getToken: (o) => this.auth.getToken(o) });
    this.disposables.push(
      this.repos.onDidChange(() => this.scheduleRefresh()),
      this.auth.onDidChange(() => this.scheduleRefresh()),
    );
  }

  /** Resolve the current GitHub context, for commands that need owner/repo. */
  resolveContext(): Promise<GitHubRepoContext | null> {
    return resolveGitHubContext(this.repos);
  }

  getApi(): GitHubApi {
    return this.api;
  }

  refresh(): void {
    this.lastError = undefined;
    if (this.data) {
      // Stale-while-revalidate: keep the current rows on screen and refresh in
      // the background. Routine git activity (a local commit, a fetch) triggers
      // a refresh, and we don't want it to blank the list and re-run the whole
      // GitHub load before anything shows again.
      void this.revalidate();
    } else {
      // Nothing loaded yet — let getChildren do the first (lazy) load.
      this.emitter.fire(undefined);
    }
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
      this.lastError = friendlyError(err);
    } finally {
      this.revalidating = false;
      this.emitter.fire(undefined);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  getTreeItem(element: PrTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PrTreeNode): Promise<PrTreeNode[]> {
    if (element) {
      if (element.kind === "group") {
        return element.prs.map(
          (pr) =>
            new PrNode(
              pr,
              this.data!.ctx,
              this.data?.statusByNumber.get(pr.number),
            ),
        );
      }
      return [];
    }

    // Root: ensure data is loaded.
    const ctx = await resolveGitHubContext(this.repos);
    if (!ctx) {
      // Not a GitHub repo (or no active repo) → empty; welcome view covers it.
      return [];
    }

    // Connected? A silent check; the connect-prompt (viewsWelcome) handles the
    // not-connected case so we don't show a noisy error row.
    if (!(await this.auth.isConnected())) {
      return [];
    }

    if (!this.data) {
      try {
        this.data = await this.load(ctx);
        this.lastError = undefined;
      } catch (err) {
        this.lastError = friendlyError(err);
        return [new MessageNode(this.lastError, "warning")];
      }
    }

    const groups = this.data.groups;
    const result: GroupNode[] = [];
    // "Waiting for my review" only when we could compute it (login known).
    if (groups.review.length > 0) {
      result.push(new GroupNode("review", groups.review));
    }
    result.push(new GroupNode("mine", groups.mine));
    result.push(new GroupNode("open", groups.open));
    return result;
  }

  private async load(ctx: GitHubRepoContext): Promise<LoadedData> {
    // The pulls list and the current login are independent — fetch them together
    // rather than one after the other (saves a full GitHub round-trip on first
    // paint).
    const [pulls, me] = await Promise.all([
      this.api.listOpenPulls(ctx.owner, ctx.repo),
      this.api.currentLogin(),
    ]);
    const login = me?.login;

    const mine: PullRequest[] = [];
    const review: PullRequest[] = [];
    for (const pr of pulls) {
      if (login && pr.user?.login === login) {
        mine.push(pr);
      }
      if (
        login &&
        pr.user?.login !== login &&
        pr.requestedReviewers.some((r) => r.login === login)
      ) {
        review.push(pr);
      }
    }

    const data: LoadedData = {
      ctx,
      groups: { review, mine, open: pulls },
      statusByNumber: new Map<number, string>(),
    };
    // CI status is a purely cosmetic per-row glyph. Previously the whole list
    // waited on up to 8 `commits/{sha}/status` calls before ANY row painted;
    // now we return immediately and fetch them in the background, repainting the
    // glyphs when they arrive.
    void this.loadStatuses(ctx, pulls.slice(0, 8), data);
    return data;
  }

  /** Best-effort CI-status glyphs, fetched off the first-paint path. */
  private async loadStatuses(
    ctx: GitHubRepoContext,
    pulls: PullRequest[],
    data: LoadedData,
  ): Promise<void> {
    await Promise.all(
      pulls.map(async (pr) => {
        try {
          const status = await this.api.getCombinedStatus(
            ctx.owner,
            ctx.repo,
            pr.head.sha,
          );
          const glyph = statusGlyph(status.state);
          if (glyph) {
            data.statusByNumber.set(pr.number, glyph);
          }
        } catch {
          // ignore — no glyph for this PR.
        }
      }),
    );
    // Only repaint if this data is still the one on screen — a later refresh may
    // have replaced it, and we must not clobber fresher rows with stale glyphs.
    if (this.data === data && data.statusByNumber.size > 0) {
      this.emitter.fire(undefined);
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

function statusGlyph(state: string): string | undefined {
  switch (state) {
    case "success":
      return "$(check)";
    case "failure":
    case "error":
      return "$(x)";
    case "pending":
      return "$(circle-filled)";
    default:
      return undefined;
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof GitHubApiError) {
    return err.message;
  }
  return "Couldn't load pull requests from GitHub.";
}
