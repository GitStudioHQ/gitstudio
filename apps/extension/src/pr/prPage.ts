import * as vscode from "vscode";
import { notifyCopied } from "../ui/notify";
import { fetchPrPage, fileStatusOf, markReadyForReview, mergeBoxOf } from "@gitstudio/engine/forge/prPage";
import { isCheckedOut, PrListError, type GraphqlFn, type LocalHead } from "@gitstudio/engine/forge/prList";
import { prKey, type ReviewEvent } from "@gitstudio/engine/forge/pullRequests";
import type {
  PrDetail,
  PrKind,
  PrListAction,
  PrListMessage,
  PrMergeMethod,
  PrPageBusy,
  PrPageFile,
  PrPageMessageToHost,
  PrPageTab,
  PrPageViewState,
  PrPerson,
  PrReviewState,
  PrThread,
  PrTimelineEvent,
  PrTimelineItem,
} from "@gitstudio/host-bridge/prProtocol";
import { getNonce } from "../webview/html";
import { GitHubApi, GitHubApiError, type PrFile, type PullRequest } from "./githubApi";
import { prPageHtml } from "./prPageHtml";
import type { GitHubRepoContext } from "./repoContext";
import { openCommitFileDiff } from "./reviewDiff";
import type { ReviewController } from "./reviewMode";

// A pull request's page: one editor tab per pull request (owner/repo#n —
// reopening it reveals the tab it has), titled with its repository. It mounts
// the shared page (packages/webview-ui/src/pr/prPage.ts) and feeds it:
// GitHub's answer to one GraphQL question for the page (engine/forge/prPage)
// and the changed files from REST, whose patches decide where a review
// comment may go.
//
// ONE-CLICK MUTATIONS ARE OPTIMISTIC. Close, Reopen, Mark ready, Merge,
// Resolve, a comment and a reply patch the page at once and are sent; a
// failure puts the page back as it was and says why, with what can be done.
// GitHub is then asked again, quietly — never a reload that throws away the
// scroll or what is typed.
//
// AN ANSWER BELONGS TO ITS QUESTION. A read that was asked before the page
// changed the pull request itself (a merge, a close) describes it as it WAS,
// and never paints over the change; a later read does.
//
// WHILE CHECKS RUN (or GitHub is still working out whether it can be
// merged), the page reads the pull request again every POLL_MS — only while
// it is in sight in a focused window.

const POLL_MS = 15_000;
/** A page shown again after this long is read again. */
const STALE_MS = 60_000;

/** What the Pull Requests list is told of a change the page made. */
export interface PrListHooks {
  markKind(owner: string, repo: string, n: number, kind: PrKind): void;
}

export interface PrPageDeps {
  api: GitHubApi;
  graphql: GraphqlFn;
  review: ReviewController;
  extensionUri: vscode.Uri;
  list?: PrListHooks;
  /** The branch checked out in the clone the page acts in (git only). */
  localHead?: (ctx: GitHubRepoContext) => Promise<LocalHead | undefined>;
  /** The context PR commands act in, for a repository the page was opened without one. */
  contextFor?: (owner: string, repo: string) => Promise<GitHubRepoContext | undefined>;
  /** The merge method offered first (gitstudio.pr.defaultMergeMethod). */
  mergeMethod?: () => string | undefined;
  pollMs?: number;
}

export interface PrPageOpen {
  /** What the list knew, drawn while the page loads. */
  preview?: PullRequest;
  tab?: PrPageTab;
  open?: "merge" | "review";
}

/** A failure, in the page's terms. */
interface Described {
  message: string;
  kind: string;
  status?: number;
  helpUrl?: string;
}

function describe(err: unknown): Described {
  if (err instanceof GitHubApiError) return { message: err.message, kind: err.kind, status: err.status, helpUrl: err.helpUrl };
  if (err instanceof PrListError) return { message: err.message, kind: err.kind };
  return { message: "GitHub didn't answer.", kind: "unknown" };
}

/** A first read that failed: why, and the one thing that can put it right. */
export function pageFailure(err: Described, repo: string, n: number): PrListMessage {
  const retry = { label: "Retry", icon: "refresh", action: { kind: "retry" } as PrListAction };
  if (err.kind === "auth" && err.status === 401) {
    return {
      icon: "warning",
      tone: "warning",
      title: "Your GitHub session expired",
      detail: `Sign in again to see ${repo}#${n}.`,
      buttons: [{ label: "Sign in again", icon: "sign-in", primary: true, action: { kind: "signIn", again: true } }],
    };
  }
  if (err.kind === "auth" || err.kind === "forbidden") {
    return {
      icon: "warning",
      tone: "warning",
      title: `GitHub refused to show ${repo}#${n}`,
      detail: err.message,
      buttons: [
        err.helpUrl
          ? { label: "Authorize on GitHub", icon: "link-external", primary: true, action: { kind: "openUrl", url: err.helpUrl }, title: "Open GitHub's page that authorizes this sign-in for the organization" }
          : { label: "Open on GitHub", icon: "link-external", primary: true, action: { kind: "openUrl", url: `https://github.com/${repo}/pull/${n}` } },
        retry,
      ],
    };
  }
  if (err.kind === "not-found") {
    return {
      icon: "warning",
      tone: "warning",
      title: `GitHub has no pull request ${repo}#${n}`,
      detail: `${err.message} A private repository needs a sign-in with access to it.`,
      buttons: [{ label: "Sign in again", icon: "sign-in", action: { kind: "signIn", again: true }, title: "Sign in to GitHub, with another account if need be" }, retry],
    };
  }
  if (err.kind === "rate-limit") return { icon: "clock", tone: "warning", title: "GitHub's rate limit was reached", detail: err.message, buttons: [retry] };
  if (err.kind === "network") return { icon: "error", tone: "error", title: "Couldn't reach GitHub", detail: "Check your network connection.", buttons: [{ ...retry, primary: true }] };
  return { icon: "error", tone: "error", title: `Couldn't load ${repo}#${n}`, detail: err.message, buttons: [{ ...retry, primary: true }] };
}

/** A page's pull request, as the PR commands take it. */
export function restPullOf(d: PrDetail, repo: string): PullRequest {
  const [owner] = repo.split("/");
  return {
    number: d.number,
    title: d.title,
    body: d.body,
    state: d.state,
    draft: d.draft,
    htmlUrl: d.url,
    user: d.author ? { login: d.author.login, avatarUrl: d.author.avatarUrl, htmlUrl: `https://github.com/${d.author.login}` } : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    mergedAt: d.mergedAt,
    head: {
      ref: d.headRef,
      sha: d.headSha,
      label: `${d.headOwner ?? owner}:${d.headRef}`,
      repoFullName: d.headRepo,
      cloneUrl: d.headRepo ? `https://github.com/${d.headRepo}.git` : null,
    },
    base: { ref: d.baseRef, sha: d.baseSha, label: `${owner}:${d.baseRef}`, repoFullName: repo, cloneUrl: `https://github.com/${repo}.git` },
    labels: d.labels,
    requestedReviewers: d.reviewers
      .filter((r) => r.requested && r.login)
      .map((r) => ({ login: r.login!, avatarUrl: r.avatarUrl ?? null, htmlUrl: `https://github.com/${r.login}` })),
    maintainerCanModify: d.maintainerCanModify,
    additions: d.additions,
    deletions: d.deletions,
    changedFiles: d.changedFiles,
  };
}

function pageFile(f: PrFile): PrPageFile {
  return {
    path: f.filename,
    ...(f.previousFilename ? { previousPath: f.previousFilename } : {}),
    status: fileStatusOf(f.status),
    additions: f.additions,
    deletions: f.deletions,
    noDiff: f.patch === undefined,
  };
}

const VERDICT_STATE: Record<ReviewEvent, PrReviewState> = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" };

export class PrPage {
  private static readonly pages = new Map<string, PrPage>();

  /** The page of owner/repo#n, if one is open. */
  static get(owner: string, repo: string, n: number): PrPage | undefined {
    return PrPage.pages.get(prKey(owner, repo, n).toLowerCase());
  }

  /** Open a pull request's page — or reveal the one it has, where it says to open. */
  static async show(deps: PrPageDeps, ref: { owner: string; repo: string }, n: number, ctx: GitHubRepoContext | undefined, open: PrPageOpen = {}): Promise<PrPage> {
    const id = prKey(ref.owner, ref.repo, n).toLowerCase();
    const existing = PrPage.pages.get(id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (ctx) existing.ctx = ctx;
      existing.focus(open);
      if (Date.now() - existing.loadedAt > STALE_MS) void existing.load();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel("gitstudio.pullRequest", `${ref.owner}/${ref.repo}#${n}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist")],
    });
    const page = new PrPage(id, panel, deps, ref, n, ctx, open);
    PrPage.pages.set(id, page);
    return page;
  }

  private readonly key: string;
  private readonly repoId: string;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private pageReady = false;
  private seq = 0;
  private status: PrPageViewState["status"] = "loading";
  private message: PrListMessage | undefined;
  private notice: PrListMessage | undefined;
  private detail: PrDetail | undefined;
  private files: PrFile[] | undefined;
  private filesError: string | undefined;
  private filesTruncated = false;
  private readonly commitFiles: PrPageViewState["commitFiles"] = {};
  private readonly commitParents = new Map<string, { parent?: string; files: PrFile[] }>();
  private readonly busy = new Set<PrPageBusy>();
  private refreshing = false;
  private checkedOut = false;
  private tab: PrPageTab;
  private focusState: PrPageViewState["focus"];
  private restoreState: PrPageViewState["restore"];
  private sentState: PrPageViewState["sent"];
  private preview: PrPageViewState["preview"];
  /** Counts loads: only the latest one started may paint. */
  private loadGen = 0;
  /** Counts changes the page made itself: a read asked before one describes the PR as it was. */
  private stateGen = 0;
  private loadedAt = 0;
  private loading: Promise<void> | undefined;
  private mergeBase: { pair: string; sha: string } | undefined;
  private readonly poller: ReturnType<typeof setInterval>;
  /** Resolves (and unresolves) on their way to GitHub, by thread id. */
  private readonly resolving = new Map<string, boolean>();
  private sendSeq = 0;

  private constructor(
    private readonly id: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PrPageDeps,
    private readonly ref: { owner: string; repo: string },
    private readonly n: number,
    private ctx: GitHubRepoContext | undefined,
    open: PrPageOpen,
  ) {
    this.key = prKey(ref.owner, ref.repo, n);
    this.repoId = `${ref.owner}/${ref.repo}`;
    this.tab = open.tab ?? "conversation";
    if (open.preview) {
      const p = open.preview;
      this.preview = {
        title: p.title,
        kind: p.mergedAt ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open",
        author: p.user ? { login: p.user.login, avatarUrl: p.user.avatarUrl } : null,
        headRef: p.head.repoFullName && p.head.repoFullName !== p.base.repoFullName ? p.head.label : p.head.ref,
        baseRef: p.base.ref,
      };
    }
    this.focus(open, false);
    const dist = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", ...p)).toString();
    panel.webview.html = prPageHtml({
      cspSource: panel.webview.cspSource,
      nonce: getNonce(),
      codiconCss: dist("codicons", "codicon.css"),
      pageCss: dist("webview", "pr-page.css"),
      pageJs: dist("webview", "pr-page.js"),
      mergeMethod: deps.mergeMethod?.(),
      title: `${this.repoId}#${n}`,
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: PrPageMessageToHost) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      deps.review.onDidChange((key) => {
        if (key === this.key) this.post();
      }),
      deps.review.onDidChangeThread(({ key, thread }) => {
        if (key === this.key) this.patchThread(thread);
      }),
    );
    this.poller = setInterval(() => this.poll(), deps.pollMs ?? POLL_MS);
    this.poller.unref?.();
    void this.load();
  }

  /** The page has read its pull request (or failed to). */
  loaded(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /** Where the page opens: a tab, a box. */
  focus(open: PrPageOpen, post = true): void {
    if (!open.tab && !open.open) return;
    if (open.tab) this.tab = open.tab;
    this.focusState = { seq: ++this.sendSeq, ...(open.tab ? { tab: open.tab } : {}), ...(open.open ? { open: open.open } : {}) };
    if (post) this.post();
  }

  // ── What the page is sent ──────────────────────────────────────────────────

  viewState(): PrPageViewState {
    const d = this.detail;
    return {
      seq: this.seq,
      status: this.status,
      ...(this.message ? { message: this.message } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
      repo: this.repoId,
      number: this.n,
      tab: this.tab,
      ...(this.preview ? { preview: this.preview } : {}),
      ...(d ? { pr: d } : {}),
      ...(this.files || this.filesError
        ? { files: { items: (this.files ?? []).map(pageFile), truncated: this.filesTruncated, ...(this.filesError ? { error: this.filesError } : {}) } }
        : {}),
      commitFiles: { ...this.commitFiles },
      ...(() => {
        const r = this.deps.review.pendingFor(this.key, d?.headSha);
        return r ? { review: r } : {};
      })(),
      busy: [...this.busy],
      refreshing: this.refreshing,
      checkedOut: this.checkedOut,
      ...(this.focusState ? { focus: this.focusState } : {}),
      ...(this.restoreState ? { restore: this.restoreState } : {}),
      ...(this.sentState ? { sent: this.sentState } : {}),
      now: Date.now(),
    };
  }

  private post(): void {
    if (this.disposed || !this.pageReady) return;
    this.seq++;
    void this.panel.webview.postMessage({ type: "state", state: this.viewState() });
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Read the pull request (and its files) again; what is on the page stays while it runs. */
  load(): Promise<void> {
    const gen = ++this.loadGen;
    const stateAt = this.stateGen;
    const run = (async () => {
      this.refreshing = !!this.detail;
      this.post();
      const { owner, repo } = this.ref;
      const [d, f] = await Promise.allSettled([
        fetchPrPage(this.deps.graphql, owner, repo, this.n),
        this.deps.api.getPullFiles(owner, repo, this.n),
      ]);
      if (this.disposed || gen !== this.loadGen) return;
      this.refreshing = false;
      if (d.status === "fulfilled") {
        if (this.stateGen !== stateAt) {
          // Asked before the page changed the pull request: it describes it
          // as it was. Ask again rather than paint that.
          void this.load();
          return;
        }
        this.detail = this.withInFlight(d.value);
        this.status = "ready";
        this.message = undefined;
        this.loadedAt = Date.now();
      } else {
        const why = describe(d.reason);
        if (this.detail) {
          this.notice = {
            icon: "warning",
            tone: "warning",
            title: `Couldn't refresh: ${why.message}`,
            detail: "Showing the pull request as it was.",
            buttons:
              why.kind === "auth" && why.status === 401
                ? [{ label: "Sign in again", icon: "sign-in", action: { kind: "signIn", again: true } }]
                : [{ label: "Retry", icon: "refresh", action: { kind: "retry" } }],
          };
        } else {
          this.status = "message";
          this.message = pageFailure(why, this.repoId, this.n);
        }
      }
      if (f.status === "fulfilled") {
        this.files = f.value.items;
        this.filesTruncated = f.value.truncated;
        this.filesError = undefined;
      } else {
        this.filesError = describe(f.reason).message;
      }
      this.post();
      await this.afterLoad().catch(() => undefined);
    })();
    const p: Promise<void> = run.finally(() => {
      if (this.loading === p) this.loading = undefined;
    });
    this.loading = p;
    return p;
  }

  /**
   * A read that answers while a comment, a reply or a Resolve is on its way
   * doesn't know of it yet: what is being sent stays on the page until
   * GitHub has answered for it.
   */
  private withInFlight(next: PrDetail): PrDetail {
    const now = this.detail;
    if (!now) return next;
    const sending = now.timeline.filter((t) => "sending" in t && t.sending && !next.timeline.some((x) => x.id === t.id));
    const threads = next.threads.map((t) => {
      const had = now.threads.find((x) => x.id === t.id);
      const replies = had?.comments.filter((c) => c.sending && !t.comments.some((x) => x.id === c.id)) ?? [];
      const resolving = this.resolving.get(t.id);
      if (replies.length === 0 && resolving === undefined) return t;
      return {
        ...t,
        comments: [...t.comments, ...replies],
        ...(resolving !== undefined ? { resolved: resolving, canResolve: !resolving, canUnresolve: resolving } : {}),
      };
    });
    return { ...next, timeline: [...next.timeline, ...sending], threads };
  }

  /** What follows a read: its diffs take comments, its threads are drawn, "Checked out" is read. */
  private async afterLoad(): Promise<void> {
    const d = this.detail;
    if (!d) return;
    const baseSha = await this.diffBase(d);
    if (this.disposed || this.detail !== d) return;
    if (this.files) {
      this.deps.review.know({ owner: this.ref.owner, repo: this.ref.repo, number: this.n, title: d.title, headSha: d.headSha, baseSha, files: this.files });
      this.deps.review.showThreads(this.key, d.threads);
    }
    await this.readCheckedOut();
  }

  /** The merge base of the PR's base and head: its diffs' left side. Asked once per pair. */
  private async diffBase(d: PrDetail): Promise<string> {
    const pair = `${d.baseSha}...${d.headSha}`;
    if (this.mergeBase?.pair === pair) return this.mergeBase.sha;
    const sha = await this.deps.api.mergeBase(this.ref.owner, this.ref.repo, d.baseSha, d.headSha).catch(() => undefined);
    if (sha) this.mergeBase = { pair, sha };
    return sha ?? d.baseSha;
  }

  private async context(): Promise<GitHubRepoContext | undefined> {
    this.ctx ??= await this.deps.contextFor?.(this.ref.owner, this.ref.repo);
    return this.ctx;
  }

  private async readCheckedOut(): Promise<void> {
    const d = this.detail;
    const ctx = await this.context();
    if (!d || !ctx || !this.deps.localHead) return;
    const head = await this.deps.localHead(ctx).catch(() => undefined);
    const now = isCheckedOut({ number: d.number, headRef: d.headRef, headRepo: d.headRepo, isFork: d.isFork }, head);
    if (now !== this.checkedOut) {
      this.checkedOut = now;
      this.post();
    }
  }

  /** While checks run, or GitHub hasn't decided whether it can be merged. */
  private poll(): void {
    const d = this.detail;
    if (!d || this.loading || this.busy.size > 0 || !this.panel.visible) return;
    if (vscode.window.state?.focused === false) return;
    if (d.kind !== "open" && d.kind !== "draft") return;
    if (d.ci.state === "pending" || d.mergeState === "UNKNOWN") void this.load();
  }

  // ── What the page asks ─────────────────────────────────────────────────────

  private async onMessage(m: PrPageMessageToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.pageReady = true;
        this.post();
        return;
      case "refresh":
        this.notice = undefined;
        await this.load();
        return;
      case "tab":
        if (["conversation", "commits", "checks", "files"].includes(m.tab)) this.tab = m.tab;
        return;
      case "checkout":
        return this.checkout();
      case "openOnGitHub":
        if (this.detail && /^https:\/\/github\.com\//.test(this.detail.url)) void vscode.env.openExternal(vscode.Uri.parse(this.detail.url));
        else void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${this.repoId}/pull/${this.n}`));
        return;
      case "copyLink": {
        const url = this.detail?.url ?? `https://github.com/${this.repoId}/pull/${this.n}`;
        await vscode.env.clipboard.writeText(url);
        notifyCopied(`the link to pull request #${this.n}`);
        return;
      }
      case "openUrl":
        if (/^https?:\/\//i.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case "openRef":
        return this.openRef(m.repo, m.number);
      case "merge":
        return this.merge(m.method, m.title, m.deleteBranch);
      case "updateBranch":
        return this.updateBranch();
      case "close":
        return this.setState("closed");
      case "reopen":
        return this.setState("open");
      case "markReady":
        return this.markReady();
      case "comment":
        return this.comment(m.body);
      case "reply":
        return this.reply(m.threadId, m.body);
      case "resolve":
        return this.resolve(m.threadId, m.resolved);
      case "openFile":
        return this.openFile(m.path, m.line, m.side);
      case "expandCommit":
        return this.expandCommit(m.sha);
      case "openCommitFile":
        return this.openCommitFile(m.sha, m.path);
      case "startReview":
        await this.startReview();
        return;
      case "submitReview":
        return this.submitReview(m.event, m.body);
      case "discardReview":
        this.deps.review.discard(this.key);
        return;
      case "action":
        return this.runAction(m.action);
    }
  }

  private async runAction(a: PrListAction): Promise<void> {
    switch (a.kind) {
      case "retry":
        this.notice = undefined;
        if (!this.detail) {
          this.status = "loading";
          this.message = undefined;
        }
        await this.load();
        return;
      case "signIn":
        await vscode.commands.executeCommand("gitstudio.pr.signIn", a.again ? { again: true } : undefined);
        await this.load();
        return;
      case "openUrl":
        if (/^https:\/\/github\.com\//.test(a.url)) void vscode.env.openExternal(vscode.Uri.parse(a.url));
        return;
    }
  }

  /** `#12` in this repository opens its page when it is a pull request; anything else, GitHub's. */
  private async openRef(repo: string | undefined, n: number): Promise<void> {
    const target = repo ?? this.repoId;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target) || !Number.isSafeInteger(n) || n <= 0) return;
    if (target.toLowerCase() === this.repoId.toLowerCase()) {
      const pr = await this.deps.api.getPull(this.ref.owner, this.ref.repo, n).catch(() => undefined);
      if (pr) {
        await PrPage.show(this.deps, this.ref, n, this.ctx, { preview: pr });
        return;
      }
    }
    // Another repository's number is another repository's: GitHub's page,
    // never this clone's #n.
    void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${target}/issues/${n}`));
  }

  private failed(what: string, err: unknown, extra?: string): void {
    const why = describe(err);
    this.notice = {
      icon: "warning",
      tone: "warning",
      title: `Couldn't ${what}: ${why.message}`,
      ...(extra ? { detail: extra } : {}),
      buttons:
        why.kind === "auth" && why.status === 401
          ? [{ label: "Sign in again", icon: "sign-in", action: { kind: "signIn", again: true } }]
          : [{ label: "Open on GitHub", icon: "link-external", action: { kind: "openUrl", url: this.detail?.url ?? `https://github.com/${this.repoId}/pull/${this.n}` } }],
    };
  }

  private viewer(): PrPerson | null {
    const v = this.detail?.viewer;
    return v?.login ? { login: v.login, avatarUrl: v.avatarUrl ?? null } : null;
  }

  private event(event: PrTimelineEvent): PrTimelineItem {
    return { kind: "event", id: `local-${event}-${++this.sendSeq}`, event, actor: this.viewer(), createdAt: new Date().toISOString() };
  }

  private async checkout(): Promise<void> {
    const d = this.detail;
    if (!d || this.busy.has("checkout")) return;
    const ctx = await this.context();
    if (!ctx) {
      void vscode.window.showWarningMessage(`This repository has no remote for ${this.repoId}, so its pull requests can't be checked out here.`);
      return;
    }
    this.busy.add("checkout");
    this.post();
    try {
      await vscode.commands.executeCommand("gitstudio.pr.checkout", { pr: restPullOf(d, this.repoId), ctx });
    } finally {
      this.busy.delete("checkout");
      this.post();
      await this.readCheckedOut();
    }
  }

  private async merge(method: PrMergeMethod, title: string | undefined, deleteBranch: boolean): Promise<void> {
    const d = this.detail;
    if (!d || this.busy.has("merge")) return;
    if (!mergeBoxOf(d)?.canMerge || !d.repo.mergeMethods.includes(method)) return;
    this.busy.add("merge");
    this.notice = undefined;
    this.post();
    try {
      await this.deps.api.mergePull(this.ref.owner, this.ref.repo, this.n, method, { ...(title ? { title } : {}), sha: d.headSha });
    } catch (err) {
      this.busy.delete("merge");
      const why = describe(err);
      this.failed(
        `merge #${this.n}`,
        err,
        why.status === 409 ? "The branch moved on since this page read it. Refresh, look at what changed, and merge again." : "It is still open.",
      );
      this.post();
      return;
    }
    this.stateGen++;
    const now = new Date().toISOString();
    this.detail = { ...d, kind: "merged", state: "closed", mergedAt: now, closedAt: now, mergedBy: this.viewer(), timeline: [...d.timeline, this.event("merged")] };
    this.busy.delete("merge");
    this.deps.list?.markKind(this.ref.owner, this.ref.repo, this.n, "merged");
    this.post();
    if (deleteBranch && !d.isFork) {
      try {
        await this.deps.api.deleteBranch(this.ref.owner, this.ref.repo, d.headRef);
      } catch (err) {
        this.failed(`delete ${d.headRef}`, err, `#${this.n} is merged; its branch is still on GitHub.`);
        this.post();
      }
    }
    void this.load();
  }

  private async updateBranch(): Promise<void> {
    const d = this.detail;
    if (!d || this.busy.has("updateBranch")) return;
    this.busy.add("updateBranch");
    this.post();
    try {
      await this.deps.api.updateBranch(this.ref.owner, this.ref.repo, this.n, d.headSha);
      this.stateGen++;
      this.detail = { ...d, mergeState: "UNKNOWN" };
      this.notice = {
        icon: "info",
        tone: "info",
        title: `GitHub is merging ${d.baseRef} into ${d.headRef}`,
        detail: "The page follows as it happens.",
        buttons: [],
      };
    } catch (err) {
      this.failed("update the branch", err);
    } finally {
      this.busy.delete("updateBranch");
      this.post();
    }
  }

  private async setState(to: "open" | "closed"): Promise<void> {
    const d = this.detail;
    const busy: PrPageBusy = to === "closed" ? "close" : "reopen";
    if (!d || this.busy.has(busy) || d.kind === "merged") return;
    const was = d;
    const kind: PrKind = to === "closed" ? "closed" : d.draft ? "draft" : "open";
    this.stateGen++;
    this.detail = {
      ...d,
      kind,
      state: to,
      closedAt: to === "closed" ? new Date().toISOString() : null,
      mergeState: to === "open" ? "UNKNOWN" : d.mergeState,
      timeline: [...d.timeline, this.event(to === "closed" ? "closed" : "reopened")],
    };
    this.busy.add(busy);
    this.notice = undefined;
    this.post();
    try {
      await this.deps.api.setPullState(this.ref.owner, this.ref.repo, this.n, to);
      this.deps.list?.markKind(this.ref.owner, this.ref.repo, this.n, kind);
    } catch (err) {
      this.stateGen++;
      this.detail = was;
      this.failed(`${to === "closed" ? "close" : "reopen"} #${this.n}`, err, `It is still ${was.kind === "closed" ? "closed" : "open"}.`);
    } finally {
      this.busy.delete(busy);
      this.post();
    }
    void this.load();
  }

  private async markReady(): Promise<void> {
    const d = this.detail;
    if (!d || this.busy.has("ready") || d.kind !== "draft") return;
    const was = d;
    this.stateGen++;
    this.detail = { ...d, kind: "open", draft: false, mergeState: "UNKNOWN", timeline: [...d.timeline, this.event("ready")] };
    this.busy.add("ready");
    this.notice = undefined;
    this.post();
    try {
      await markReadyForReview(this.deps.graphql, d.id);
      this.deps.list?.markKind(this.ref.owner, this.ref.repo, this.n, "open");
    } catch (err) {
      this.stateGen++;
      this.detail = was;
      this.failed(`mark #${this.n} ready for review`, err, "It is still a draft.");
    } finally {
      this.busy.delete("ready");
      this.post();
    }
    void this.load();
  }

  private async comment(body: string): Promise<void> {
    const d = this.detail;
    const text = body.trim();
    if (!d || !text || this.busy.has("comment")) return;
    const id = `sending-${++this.sendSeq}`;
    const item: PrTimelineItem = { kind: "comment", id, author: this.viewer(), body: text, createdAt: new Date().toISOString(), url: "", sending: true };
    this.detail = { ...d, timeline: [...d.timeline, item] };
    this.busy.add("comment");
    this.notice = undefined;
    this.post();
    try {
      const c = await this.deps.api.addComment(this.ref.owner, this.ref.repo, this.n, text);
      const now = this.detail;
      if (now) {
        this.detail = {
          ...now,
          timeline: now.timeline.map((t) =>
            t.id === id
              ? { kind: "comment", id: c.id || id, author: c.author ? { login: c.author.login, avatarUrl: c.author.avatarUrl } : this.viewer(), body: text, createdAt: c.createdAt, url: c.url }
              : t,
          ),
        };
      }
    } catch (err) {
      const now = this.detail;
      if (now) this.detail = { ...now, timeline: now.timeline.filter((t) => t.id !== id) };
      this.restoreState = { seq: ++this.sendSeq, key: "comment", body };
      this.failed("post your comment", err, "Your comment is back in its box.");
    } finally {
      this.busy.delete("comment");
      this.post();
    }
  }

  private threadOf(id: string): PrThread | undefined {
    return this.detail?.threads.find((t) => t.id === id);
  }

  private patchThread(next: PrThread): void {
    const d = this.detail;
    if (!d || !d.threads.some((t) => t.id === next.id)) return;
    this.detail = { ...d, threads: d.threads.map((t) => (t.id === next.id ? next : t)) };
    this.post();
  }

  private async reply(threadId: string, body: string): Promise<void> {
    const t = this.threadOf(threadId);
    const text = body.trim();
    const busy: PrPageBusy = `reply:${threadId}`;
    if (!t || !text || this.busy.has(busy)) return;
    const sending = { id: `sending-${++this.sendSeq}`, author: this.viewer(), body: text, createdAt: new Date().toISOString(), url: "", sending: true };
    this.patchThread({ ...t, comments: [...t.comments, sending] });
    this.busy.add(busy);
    this.post();
    try {
      await this.deps.review.replyToThread(this.key, t, text);
    } catch (err) {
      this.patchThread(t);
      this.restoreState = { seq: ++this.sendSeq, key: busy, body };
      this.failed("post your reply", err, "Your reply is back in its box.");
    } finally {
      this.busy.delete(busy);
      this.post();
    }
  }

  private async resolve(threadId: string, resolved: boolean): Promise<void> {
    const t = this.threadOf(threadId);
    const busy: PrPageBusy = `resolve:${threadId}`;
    if (!t || this.busy.has(busy) || t.resolved === resolved) return;
    this.patchThread({ ...t, resolved, canResolve: !resolved, canUnresolve: resolved, ...(resolved && this.viewer() ? { resolvedBy: this.viewer()!.login } : {}) });
    this.busy.add(busy);
    this.resolving.set(threadId, resolved);
    this.post();
    try {
      await this.deps.review.resolveThread(this.key, t, resolved);
    } catch (err) {
      this.resolving.delete(threadId);
      this.patchThread(t);
      this.failed(resolved ? "resolve the conversation" : "unresolve the conversation", err);
    } finally {
      this.resolving.delete(threadId);
      this.busy.delete(busy);
      this.post();
    }
  }

  private async openFile(path: string, line?: number, side?: "LEFT" | "RIGHT"): Promise<void> {
    await this.loaded();
    const opened = await this.deps.review.openFile(this.key, path, { ...(line ? { line } : {}), ...(side ? { side } : {}) }).catch(() => false);
    if (!opened) void vscode.window.showInformationMessage(`${path} isn't among #${this.n}'s changed files any more.`);
  }

  private async expandCommit(sha: string): Promise<void> {
    // Only one of this pull request's own commits is asked for.
    if (!this.detail?.commits.some((c) => c.sha === sha)) return;
    if (this.commitFiles[sha]?.status === "loading" || this.commitFiles[sha]?.status === "loaded") return;
    this.commitFiles[sha] = { status: "loading" };
    this.post();
    try {
      const c = await this.deps.api.commitFiles(this.ref.owner, this.ref.repo, sha);
      this.commitParents.set(sha, c);
      this.commitFiles[sha] = { status: "loaded", files: c.files.map(pageFile) };
    } catch (err) {
      this.commitFiles[sha] = { status: "failed", error: describe(err).message };
    }
    this.post();
  }

  private async openCommitFile(sha: string, path: string): Promise<void> {
    const c = this.commitParents.get(sha);
    const file = c?.files.find((f) => f.filename === path);
    const commit = this.detail?.commits.find((x) => x.sha === sha);
    if (!c || !file) return;
    await openCommitFileDiff(this.ref, { sha, short: commit?.shortSha ?? sha.slice(0, 7) }, c.parent, file);
  }

  /**
   * Start Review: the review exists, the Files tab shows, and the first file
   * opens. The pull request is read again first: a page loaded before a push
   * would pin the review to a head that is no longer the pull request's.
   */
  async startReview(): Promise<void> {
    await this.loaded();
    if (!this.deps.review.pendingFor(this.key)) await this.load();
    this.focus({ tab: "files" });
    const started = await this.deps.review.start(this.key);
    if (!started) void vscode.window.showWarningMessage(`#${this.n}'s changed files couldn't be read, so its review can't start yet. Refresh and try again.`);
  }

  private async submitReview(event: ReviewEvent, body: string): Promise<void> {
    const d = this.detail;
    if (!d || this.busy.has("review")) return;
    this.busy.add("review");
    this.notice = undefined;
    this.post();
    const out = await this.deps.review.submit(this.key, event, body, { owner: this.ref.owner, repo: this.ref.repo, number: this.n, headSha: d.headSha });
    this.busy.delete("review");
    if (!out.ok) {
      const said = /[.!?]$/.test(out.message) ? out.message : `${out.message}.`;
      this.notice = { icon: "warning", tone: "warning", title: "Couldn't submit your review", detail: `${said} Your comments are kept.`, buttons: [] };
      this.post();
      return;
    }
    const now = this.detail ?? d;
    const me = this.viewer();
    const state = VERDICT_STATE[event];
    this.detail = {
      ...now,
      timeline: [...now.timeline, { kind: "review", id: out.id || `local-review-${++this.sendSeq}`, author: me, state, body: body.trim(), createdAt: out.submittedAt ?? new Date().toISOString(), url: out.url ?? "" }],
      reviewers:
        me && event !== "COMMENT"
          ? [...now.reviewers.filter((r) => r.login?.toLowerCase() !== me.login.toLowerCase()), { login: me.login, avatarUrl: me.avatarUrl, verdict: state, requested: false }]
          : now.reviewers,
    };
    this.sentState = { seq: ++this.sendSeq, key: "review" };
    this.post();
    void vscode.window.showInformationMessage(
      `Review submitted on #${this.n}: ${event === "APPROVE" ? "approved" : event === "REQUEST_CHANGES" ? "changes requested" : "commented"}.`,
    );
    void this.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.poller);
    PrPage.pages.delete(this.id);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.panel.dispose();
  }
}
