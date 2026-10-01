import * as vscode from "vscode";
import {
  canSetMetadata,
  createProblem,
  defaultTemplate,
  fetchCreateData,
  headForGitHub,
  metadataNote,
  proposedBody,
  proposedTitle,
  statusOfLetter,
  type PrCreateRepoData,
} from "@gitstudio/engine/forge/prCreate";
import { fetchRepoInfo, PrListError, type GraphqlFn } from "@gitstudio/engine/forge/prList";
import { fetchRefTip } from "@gitstudio/git-service/prCheckout";
import { isSafeBranchName, isSafeRemoteName } from "@gitstudio/git-service/prBranch";
import type {
  PrCreateCommit,
  PrCreateFile,
  PrCreateHead,
  PrCreateMessageToHost,
  PrCreateRequest,
  PrCreateViewState,
  PrListAction,
  PrListMessage,
} from "@gitstudio/host-bridge/prProtocol";
import type { RepoEntry } from "../git/repoManager";
import { compareRefsData, type CompareResult } from "../compare/refCompare";
import { toRevisionUri } from "../history/revisionContentProvider";
import { getNonce } from "../webview/html";
import { GitHubApi, GitHubApiError, type PullRequest } from "./githubApi";
import { prCreateHtml } from "./prCreateHtml";
import { contextFor, resolvePrTargets, type PrTarget } from "./prTargets";
import { listGitHubRemotes, type GitHubRemote, type GitHubRepoContext } from "./repoContext";
import * as l10n from "@vscode/l10n";

// A new pull request, as ONE form in an editor tab (the shared webview-ui
// PullRequestCreate) — not a chain of questions in the sidebar. The host
// reads what the form shows and does what it asks:
//
// - WHERE IT OPENS: the repository the Pull Requests list shows (a fork's
//   parent), with the clone's other GitHub repositories in a switcher.
// - INTO: that repository's default branch, or any of its branches.
// - FROM: the branch checked out, or any local branch; where it is pushed is
//   git's own push-remote rule — but a branch started from the target's base
//   (`git switch -c feature upstream/main`) goes to YOUR FORK when the clone
//   has one, as `gh pr create` would, not into the repository you may not
//   push to — and the form lets you pick another remote. A branch in your
//   fork is sent as `owner:branch`. Not pushed yet, or behind: Create pushes
//   it first, and the button says so.
// - LIVE: a commit, a pull or a push made while the form is open is read
//   (git only, never GitHub) — and Create reads the branch once more before
//   it pushes, so what is created is the branch as it is when pressed.
// - WHAT IT WILL HAVE: the commits and files of <base>...<head>, against the
//   base as GitHub has it now (fetched), each file opening its diff.
// - TITLE and DESCRIPTION: what github.com proposes (engine/forge/prCreate) —
//   the repository's template when it has one — until the user types.
// - Draft, reviewers, assignees and labels (the latter three only for someone
//   who may set them).
// - A branch that already has an open pull request says so, with Open; a
//   create that GitHub answers "already exists" opens the one that exists.

/** What the form is told of the list, and tells it. */
export interface PrCreateList {
  /** The clone's repositories and the one the list shows — or would, resolved its way while the view is closed. */
  resolveTargets(entry: RepoEntry): Promise<{ targets: PrTarget[]; target: PrTarget } | undefined>;
  addPr(owner: string, repo: string, pr: PullRequest): void;
}

export interface PrCreateBrain {
  isEnabled(): Promise<boolean>;
  generatePrDescription(commits: string[], diff: string): Promise<string | undefined | null>;
}

export interface PrCreateDeps {
  api: GitHubApi;
  /** Fires when the repository may have changed (RepoManager.onDidChange: every save, commit, pull, push). */
  onDidChangeRepo?: vscode.Event<unknown>;
  graphql: GraphqlFn;
  brain?: PrCreateBrain;
  extensionUri: vscode.Uri;
  list?: PrCreateList;
  /** Open a pull request's page. */
  openPr(pr: PullRequest, ctx: GitHubRepoContext): Promise<unknown>;
}

interface Described {
  message: string;
  kind: string;
  status?: number;
  helpUrl?: string;
}

function describe(err: unknown): Described {
  if (err instanceof GitHubApiError) return { message: err.message, kind: err.kind, status: err.status, helpUrl: err.helpUrl };
  if (err instanceof PrListError) return { message: err.message, kind: err.kind };
  return { message: err instanceof Error && err.message ? err.message : l10n.t("GitHub didn't answer."), kind: "unknown" };
}

/** A first read that failed: why, and the one thing that can put it right. */
function readFailure(err: Described, repo: string): PrListMessage {
  const retry = { label: l10n.t("Retry"), icon: "refresh", action: { kind: "retry" } as PrListAction };
  if (err.kind === "auth" && err.status === 401) {
    return {
      icon: "github",
      tone: "info",
      title: l10n.t("Sign in to GitHub to open a pull request"),
      detail: l10n.t("GitStudio uses VS Code's GitHub account — no token to paste."),
      buttons: [{ label: l10n.t("Sign in to GitHub"), icon: "sign-in", primary: true, action: { kind: "signIn", again: err.message.includes("expired") } }],
    };
  }
  if (err.kind === "auth" || err.kind === "forbidden") {
    return {
      icon: "warning",
      tone: "warning",
      title: l10n.t("GitHub refused to show {0}", repo),
      detail: err.message,
      buttons: [
        err.helpUrl
          ? { label: l10n.t("Authorize on GitHub"), icon: "link-external", primary: true, action: { kind: "openUrl", url: err.helpUrl } }
          : { label: l10n.t("Open on GitHub"), icon: "link-external", primary: true, action: { kind: "openUrl", url: `https://github.com/${repo}` } },
        retry,
      ],
    };
  }
  if (err.kind === "not-found") {
    return { icon: "warning", tone: "warning", title: l10n.t("GitHub has no repository {0}", repo), detail: l10n.t("Or this GitHub sign-in can't see it."), buttons: [retry] };
  }
  if (err.kind === "rate-limit") return { icon: "clock", tone: "warning", title: l10n.t("GitHub's rate limit was reached"), detail: err.message, buttons: [retry] };
  if (err.kind === "network") return { icon: "error", tone: "error", title: l10n.t("Couldn't reach GitHub"), detail: l10n.t("Check your network connection."), buttons: [{ ...retry, primary: true }] };
  return { icon: "error", tone: "error", title: l10n.t("Couldn't read {0}", repo), detail: err.message, buttons: [{ ...retry, primary: true }] };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** How long the form waits after a change of the repository before it reads git (RepoManager fires on every save). */
const GIT_DEBOUNCE_MS = 300;

export class PrCreatePage {
  private static readonly pages = new Map<string, PrCreatePage>();

  /** The form open for a clone, if one is. */
  static get(root: string): PrCreatePage | undefined {
    return PrCreatePage.pages.get(root);
  }

  /** Open the form for a clone — or reveal the one it has. */
  static show(deps: PrCreateDeps, entry: RepoEntry, opts: { head?: string } = {}): PrCreatePage {
    const existing = PrCreatePage.pages.get(entry.root);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (opts.head && opts.head !== existing.headBranch) void existing.chooseHead(opts.head);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel("gitstudio.newPullRequest", l10n.t("New pull request"), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist")],
    });
    const page = new PrCreatePage(panel, deps, entry, opts.head);
    PrCreatePage.pages.set(entry.root, page);
    return page;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private pageReady = false;
  private seq = 0;
  private sendSeq = 0;
  private status: PrCreateViewState["status"] = "loading";
  private message: PrListMessage | undefined;
  private notice: PrListMessage | undefined;
  private targets: PrTarget[] = [];
  private target: PrTarget | undefined;
  private remotes: GitHubRemote[] = [];
  private branches: { name: string; current: boolean }[] = [];
  private headBranch: string | undefined;
  private head: PrCreateHead | undefined;
  private readonly repoData = new Map<string, PrCreateRepoData>();
  private base: string | undefined;
  private template: string | undefined;
  private compare: PrCreateViewState["compare"] = { status: "idle", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0 };
  /** The ref each file's left side is read at (the merge base), and the head's. */
  private diffRefs: { left: string; right: string } | undefined;
  private rawCommits: { sha: string; subject: string; body: string }[] = [];
  private existing: PrCreateViewState["existing"];
  private busy: PrCreateViewState["busy"];
  private ai = false;
  private aiBody: PrCreateViewState["aiBody"];
  private refreshing = false;
  /** Counts reads: only the latest one started may paint. */
  private gen = 0;
  private loading: Promise<void> | undefined;
  /** The base's tip as last fetched, so a re-read of git compares without asking GitHub. */
  private baseTip: { target: string; base: string; sha: string; stale: boolean } | undefined;
  /** Where the user chose to push a branch, from the form. */
  private pushChoice: { branch: string; remote: string } | undefined;
  /** The branches and remote-tracking refs as last read: a change of the repository that leaves them is nothing to read. */
  private gitSig = "";
  private gitTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PrCreateDeps,
    private readonly entry: RepoEntry,
    head: string | undefined,
  ) {
    this.headBranch = head;
    const dist = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", ...p)).toString();
    panel.webview.html = prCreateHtml({
      cspSource: panel.webview.cspSource,
      nonce: getNonce(),
      codiconCss: dist("codicons", "codicon.css"),
      formCss: dist("webview", "pr-create.css"),
      formJs: dist("webview", "pr-create.js"),
      title: l10n.t("New pull request"),
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: PrCreateMessageToHost) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
    );
    if (deps.onDidChangeRepo) {
      this.disposables.push(
        deps.onDidChangeRepo(() => {
          if (this.gitTimer !== undefined) clearTimeout(this.gitTimer);
          this.gitTimer = setTimeout(() => {
            this.gitTimer = undefined;
            void this.gitChanged();
          }, GIT_DEBOUNCE_MS);
        }),
      );
    }
    void deps.brain?.isEnabled().then(
      (on) => {
        this.ai = on;
        this.post();
      },
      () => undefined,
    );
    void this.load();
  }

  /** The form has read what it shows (or failed to). */
  loaded(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  // ── What the form is sent ──────────────────────────────────────────────────

  viewState(): PrCreateViewState {
    const t = this.target;
    const data = t ? this.repoData.get(t.id.toLowerCase()) : undefined;
    const proposal = this.proposal(data);
    const sameRepository = !this.head?.owner || !t || same(this.head.owner, t.owner);
    return {
      seq: this.seq,
      status: this.status,
      ...(this.message ? { message: this.message } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
      targets: this.targets.map((x) => ({ id: x.id, owner: x.owner, repo: x.repo, detail: x.detail })),
      target: t?.id ?? "",
      ...(data?.viewer ? { viewer: data.viewer } : {}),
      branches: this.branches,
      ...(this.head ? { head: this.head } : {}),
      pushRemotes: this.remotes.map((r) => ({
        name: r.name,
        repo: `${r.owner}/${r.repo}`,
        ...(data?.viewer && same(r.owner, data.viewer.login) && !(t && same(`${r.owner}/${r.repo}`, t.id))
          ? { detail: l10n.t("your fork") }
          : t && same(`${r.owner}/${r.repo}`, t.id)
            ? { detail: l10n.t("where it opens") }
            : {}),
      })),
      bases: this.bases(data),
      ...(this.base ? { base: this.base } : {}),
      compare: this.compare,
      proposed: proposal,
      templates: (data?.templates ?? []).map((x) => ({ filename: x.filename })),
      ...(this.template ? { template: this.template } : {}),
      ...(data ? { options: { labels: data.labels, people: data.people, truncated: data.truncated } } : {}),
      canSetMetadata: !!data && canSetMetadata(data.permission),
      ...(data && !canSetMetadata(data.permission) && t ? { metadataNote: metadataNote(t.id) } : {}),
      ...(this.existing ? { existing: this.existing } : {}),
      ...(() => {
        const problem = this.status === "ready"
          ? createProblem({
              branch: this.head?.branch,
              base: this.base,
              sameRepository,
              compareReady: this.compare.status === "ready",
              commits: this.compare.commitsTotal,
              ...(this.existing ? { existing: this.existing } : {}),
              ...(this.head ? { push: this.head.push, ...(this.head.remote ? { remote: this.head.remote } : {}) } : {}),
            })
          : undefined;
        return problem ? { problem } : {};
      })(),
      ...(this.busy ? { busy: this.busy } : {}),
      ai: this.ai,
      ...(this.aiBody ? { aiBody: this.aiBody } : {}),
      refreshing: this.refreshing,
      now: Date.now(),
    };
  }

  private bases(data: PrCreateRepoData | undefined): { name: string; isDefault: boolean }[] {
    const names = new Set<string>();
    const def = data?.defaultBranch;
    if (def) names.add(def);
    if (this.base) names.add(this.base);
    for (const b of data?.branches ?? []) names.add(b);
    return [...names].map((name) => ({ name, isDefault: name === def })).sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
  }

  private proposal(data: PrCreateRepoData | undefined): PrCreateViewState["proposed"] {
    const commits = this.rawCommits;
    const ready = this.compare.status === "ready";
    const branch = this.head?.branch ?? "";
    const body = proposedBody(ready ? commits : [], data?.templates ?? [], this.template);
    return {
      key: JSON.stringify([this.target?.id ?? "", branch, this.base ?? "", this.template ?? "", ready ? commits.map((c) => c.sha).slice(0, 2).join(",") + `:${commits.length}` : "…"]),
      title: branch ? proposedTitle(ready ? commits : [], branch) : "",
      body: body.body,
      bodyFrom: body.from,
    };
  }

  private post(): void {
    if (this.disposed || !this.pageReady) return;
    this.seq++;
    void this.panel.webview.postMessage({ type: "state", state: this.viewState() });
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Read everything the form shows; what it shows stays while it runs. */
  load(): Promise<void> {
    const gen = ++this.gen;
    const run = (async () => {
      this.refreshing = this.status === "ready";
      this.post();
      const git = this.entry.ctx.process;
      this.remotes = await listGitHubRemotes(this.entry);
      if (this.disposed || gen !== this.gen) return;
      // Where it opens: the list's repository for this clone — resolved the
      // list's way (a fork's parent, or the one chosen there) whether or not
      // the view has been opened.
      const resolved = await (async () => {
        if (this.deps.list) return this.deps.list.resolveTargets(this.entry);
        const r = await resolvePrTargets(this.remotes, (o, n) => fetchRepoInfo(this.deps.graphql, o, n));
        return r ? { targets: r.targets, target: r.targets.find((x) => x.id === r.defaultId) ?? r.targets[0] } : undefined;
      })().catch(() => undefined);
      if (this.disposed || gen !== this.gen) return;
      if (!resolved) {
        this.fail({
          icon: "repo",
          tone: "info",
          title: l10n.t("This repository has no GitHub remote"),
          detail: l10n.t("Pull requests are opened on github.com repositories. Add a remote that points at one."),
          buttons: [],
        });
        return;
      }
      this.targets = resolved.targets;
      const keep = this.target && this.targets.find((x) => same(x.id, this.target!.id));
      this.target = keep ?? resolved.target;
      this.panel.title = l10n.t("New pull request · {0}", this.target.id);

      // The branches it can come from.
      const cur = await this.readBranches();
      if (this.branches.length === 0) {
        this.fail({ icon: "git-branch", tone: "info", title: l10n.t("This repository has no branches yet"), detail: l10n.t("Commit something first, then open a pull request from its branch."), buttons: [] });
        return;
      }
      if (!this.headBranch || !this.branches.some((b) => b.name === this.headBranch)) this.headBranch = cur;

      // What GitHub says about the repository it opens on.
      let data: PrCreateRepoData;
      try {
        data = await this.readRepo(this.target);
      } catch (err) {
        if (this.disposed || gen !== this.gen) return;
        this.fail(readFailure(describe(err), this.target.id));
        return;
      }
      if (this.disposed || gen !== this.gen) return;
      if (!this.base || !data.branches.includes(this.base)) this.base = data.defaultBranch ?? this.base ?? "main";
      if (this.template === undefined || !data.templates.some((x) => x.filename === this.template)) this.template = defaultTemplate(data.templates);
      this.message = undefined;
      await this.readHead(gen);
      if (this.disposed || gen !== this.gen) return;
      await this.readCompare(gen);
      if (this.disposed || gen !== this.gen) return;
      this.gitSig = await this.readGitSig();
      this.status = "ready";
      this.refreshing = false;
      this.post();
    })();
    const p: Promise<void> = run.finally(() => {
      if (this.loading === p) this.loading = undefined;
    });
    this.loading = p;
    return p;
  }

  /** The local branches, the one checked out first; returns that one. */
  private async readBranches(): Promise<string | undefined> {
    const git = this.entry.ctx.process;
    const [heads, current] = await Promise.all([
      git.run(["for-each-ref", "--format=%(refname)", "refs/heads/"]),
      git.run(["symbolic-ref", "--quiet", "HEAD"]),
    ]);
    const cur = current.code === 0 ? current.stdout.trim().replace(/^refs\/heads\//, "") : undefined;
    this.branches = heads.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("refs/heads/"))
      .map((l) => l.slice("refs/heads/".length))
      .filter(isSafeBranchName)
      .map((name) => ({ name, current: name === cur }))
      .sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)));
    return cur;
  }

  /** Every branch and remote-tracking ref with its commit, HEAD, and what the branches track and push to: what the form shows of git. */
  private async readGitSig(): Promise<string> {
    const git = this.entry.ctx.process;
    const [refs, head, config] = await Promise.all([
      git.run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/remotes/"]),
      git.run(["symbolic-ref", "--quiet", "HEAD"]),
      git.run(["config", "--get-regexp", "^(branch\\.|remote\\.pushdefault)"]),
    ]);
    return JSON.stringify([refs.stdout, head.stdout, config.stdout]);
  }

  /**
   * The repository changed (a save, a commit, a pull, a push): when its
   * branches did, the branches, the head's push state and the comparison
   * are read again — from git; the base is not fetched again.
   */
  private async gitChanged(): Promise<void> {
    if (this.disposed || this.status !== "ready" || this.busy || this.loading) return;
    const sig = await this.readGitSig();
    if (this.disposed || sig === this.gitSig || this.busy || this.loading) return;
    this.gitSig = sig;
    const gen = ++this.gen;
    const cur = await this.readBranches();
    if (this.disposed || gen !== this.gen) return;
    if (!this.headBranch || !this.branches.some((b) => b.name === this.headBranch)) this.headBranch = cur;
    await this.readHead(gen, "ifMoved");
    if (this.disposed || gen !== this.gen) return;
    await this.readCompare(gen, false);
    if (!this.disposed && gen === this.gen) this.post();
  }

  private fail(message: PrListMessage): void {
    this.status = "message";
    this.message = message;
    this.refreshing = false;
    this.post();
  }

  private async readRepo(t: PrTarget): Promise<PrCreateRepoData> {
    const key = t.id.toLowerCase();
    const had = this.repoData.get(key);
    if (had) return had;
    const data = await fetchCreateData(this.deps.graphql, t.owner, t.repo);
    this.repoData.set(key, data);
    return data;
  }

  /**
   * The head: where the branch is, or will be, on GitHub (headNow) — and
   * whether it already has an open pull request, asked of GitHub when the
   * head is another than before (always, unless `ifMoved`).
   */
  private async readHead(gen: number, ask: "always" | "ifMoved" = "always"): Promise<void> {
    const branch = this.headBranch;
    const t = this.target;
    if (!branch || !t) {
      this.head = undefined;
      this.existing = undefined;
      this.existingPr = undefined;
      return;
    }
    const was = this.head;
    const head = await this.headNow(branch, t);
    if (gen !== this.gen) return;
    this.head = head;
    if (ask === "ifMoved" && was && was.branch === head.branch && was.ref === head.ref) return;
    this.existing = undefined;
    this.existingPr = undefined;
    // An open pull request this head already has: said, with Open.
    const headRef = this.head.ref.includes(":") ? this.head.ref : `${t.owner}:${branch}`;
    void this.deps.api
      .findOpenPullForHead(t.owner, t.repo, headRef)
      .then((pr) => {
        if (this.disposed || gen !== this.gen || this.head?.branch !== branch) return;
        this.existing = pr ? { number: pr.number, title: pr.title, url: pr.htmlUrl, draft: pr.draft } : undefined;
        this.existingPr = pr;
        this.post();
      })
      .catch(() => undefined);
  }

  private existingPr: PullRequest | undefined;

  /**
   * Where `branch` is pushed, and how it stands there — read from git now.
   * The remote: the one picked in the form; else git's own rule,
   * branch.<b>.pushRemote, remote.pushDefault — then, for a branch that
   * tracks ANOTHER branch of the repository it opens on (started from its
   * base: `git switch -c feature upstream/main`), your fork when the clone
   * has a remote for it; else branch.<b>.remote, origin, the repository it
   * opens on. A value that reads as an option is no remote name.
   */
  private async headNow(branch: string, t: PrTarget): Promise<PrCreateHead> {
    const git = this.entry.ctx.process;
    const get = async (key: string, check: (v: string) => boolean = isSafeRemoteName): Promise<string | undefined> => {
      const r = await git.run(["config", "--get", key]);
      const v = r.stdout.trim();
      return r.code === 0 && v && check(v) ? v : undefined;
    };
    const chosen = this.pushChoice?.branch === branch && this.remotes.some((r) => r.name === this.pushChoice!.remote) ? this.pushChoice.remote : undefined;
    const configured = (await get(`branch.${branch}.pushRemote`)) ?? (await get("remote.pushDefault"));
    const tracking = await get(`branch.${branch}.remote`);
    const merge = await get(`branch.${branch}.merge`, (v) => v.startsWith("refs/heads/"));
    const trackingRepo = this.remotes.find((r) => r.name === tracking);
    const viewer = this.repoData.get(t.id.toLowerCase())?.viewer?.login;
    const fork =
      viewer && trackingRepo && same(`${trackingRepo.owner}/${trackingRepo.repo}`, t.id) && merge && merge !== `refs/heads/${branch}`
        ? this.remotes.find((r) => same(r.owner, viewer) && !same(`${r.owner}/${r.repo}`, t.id))?.name
        : undefined;
    const origin = this.remotes.find((r) => r.name === "origin")?.name;
    const remote = chosen ?? configured ?? fork ?? tracking ?? origin ?? t.remoteName ?? this.remotes[0]?.name;
    const owner = remote ? this.remotes.find((r) => r.name === remote)?.owner : undefined;
    let push: PrCreateHead["push"] = "unknown";
    let ahead = 0;
    let behind = 0;
    if (remote && owner) {
      const there = `refs/remotes/${remote}/${branch}`;
      const known = (await git.run(["rev-parse", "--verify", "--quiet", `${there}^{commit}`])).code === 0;
      if (!known) push = "new";
      else {
        const c = await git.run(["rev-list", "--left-right", "--count", `refs/heads/${branch}...${there}`]);
        const [a, b] = c.stdout.trim().split(/\s+/).map((x) => Number.parseInt(x, 10));
        ahead = Number.isFinite(a) ? a : 0;
        behind = Number.isFinite(b) ? b : 0;
        push = ahead > 0 && behind > 0 ? "diverged" : ahead > 0 ? "ahead" : "pushed";
      }
    }
    return {
      branch,
      ...(remote ? { remote } : {}),
      ...(owner ? { owner } : {}),
      ref: headForGitHub(branch, owner, t.owner),
      push,
      ahead,
      behind,
    };
  }

  /**
   * <base>...<head>: the commits and files the pull request will have, against
   * the base as GitHub has it NOW — fetched, from the remote that names the
   * repository or its URL; as last fetched when that fails (and said).
   */
  private async readCompare(gen: number, refetch = true): Promise<void> {
    const t = this.target;
    const branch = this.head?.branch;
    const base = this.base;
    this.rawCommits = [];
    this.diffRefs = undefined;
    if (!t || !branch || !base || !isSafeBranchName(base)) {
      this.compare = { status: "idle", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0 };
      return;
    }
    this.compare = { ...this.compare, status: "loading" };
    this.post();
    const git = this.entry.ctx.process;
    const where = t.remoteName ?? `https://github.com/${t.owner}/${t.repo}.git`;
    let baseSha: string | undefined;
    let stale = false;
    const known = this.baseTip && same(this.baseTip.target, t.id) && this.baseTip.base === base ? this.baseTip : undefined;
    const fetched: Awaited<ReturnType<typeof fetchRefTip>> = !refetch && known ? { sha: known.sha } : await fetchRefTip(git, where, `refs/heads/${base}`);
    if (!refetch && known) stale = known.stale;
    if ("sha" in fetched) baseSha = fetched.sha;
    else if (t.remoteName) {
      const r = await git.run(["rev-parse", "--verify", "--quiet", `refs/remotes/${t.remoteName}/${base}^{commit}`]);
      if (r.code === 0 && r.stdout.trim()) {
        baseSha = r.stdout.trim();
        stale = true;
      }
    }
    if (gen !== this.gen || this.head?.branch !== branch || this.base !== base) return;
    if (baseSha) this.baseTip = { target: t.id, base, sha: baseSha, stale };
    if (!baseSha) {
      this.compare = {
        status: "failed",
        commits: [],
        commitsTotal: 0,
        files: [],
        additions: 0,
        deletions: 0,
        error: "error" in fetched ? l10n.t("{0} couldn't be fetched from {1}: {2}", base, t.id, fetched.error) : l10n.t("{0} couldn't be read.", base),
      };
      return;
    }
    let result: CompareResult;
    try {
      result = await compareRefsData(this.entry, baseSha, `refs/heads/${branch}`, true);
    } catch (err) {
      if (gen !== this.gen) return;
      this.compare = { status: "failed", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0, error: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (gen !== this.gen || this.head?.branch !== branch || this.base !== base) return;
    this.rawCommits = result.commits.map((c) => ({ sha: c.sha, subject: c.subject, body: c.body }));
    this.diffRefs = { left: result.filesLeftRef, right: `refs/heads/${branch}` };
    const commits: PrCreateCommit[] = result.commits.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      subject: c.subject,
      author: c.author,
      date: new Date(c.committerDate * 1000).toISOString(),
    }));
    const files: PrCreateFile[] = result.files.map((f) => ({
      path: f.path,
      ...(f.oldPath ? { previousPath: f.oldPath } : {}),
      status: statusOfLetter(f.status),
      additions: Math.max(0, f.additions),
      deletions: Math.max(0, f.deletions),
      binary: f.additions < 0 || f.deletions < 0,
    }));
    this.compare = {
      status: "ready",
      commits,
      commitsTotal: result.ahead,
      files,
      additions: result.additions,
      deletions: result.deletions,
      ...(stale ? { stale: true } : {}),
    };
  }

  // ── What the form asks ─────────────────────────────────────────────────────

  private async onMessage(m: PrCreateMessageToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.pageReady = true;
        this.post();
        return;
      case "refresh":
        this.repoData.clear();
        this.notice = undefined;
        await this.load();
        return;
      case "target":
        return this.chooseTarget(m.id);
      case "head":
        return this.chooseHead(m.branch);
      case "pushRemote":
        return this.choosePushRemote(m.remote);
      case "base":
        return this.chooseBase(m.branch);
      case "template": {
        const data = this.target ? this.repoData.get(this.target.id.toLowerCase()) : undefined;
        this.template = m.filename && data?.templates.some((x) => x.filename === m.filename) ? m.filename : undefined;
        this.post();
        return;
      }
      case "openFile":
        return this.openFile(m.path);
      case "openExisting":
        if (this.existingPr && this.target) {
          await this.deps.openPr(this.existingPr, contextFor(this.target, this.entry));
        }
        return;
      case "aiDraft":
        return this.draftWithAi();
      case "cancel":
        this.dispose();
        return;
      case "create": {
        const { type: _t, ...req } = m;
        return this.create(req);
      }
      case "action":
        return this.runAction(m.action);
    }
  }

  private async runAction(a: PrListAction): Promise<void> {
    switch (a.kind) {
      case "retry":
        this.notice = undefined;
        if (this.status === "message") {
          this.status = "loading";
          this.message = undefined;
        }
        this.repoData.clear();
        await this.load();
        return;
      case "signIn":
        await vscode.commands.executeCommand("gitstudio.pr.signIn", a.again ? { again: true } : undefined);
        this.repoData.clear();
        await this.load();
        return;
      case "openUrl":
        if (/^https:\/\/github\.com\//.test(a.url)) void vscode.env.openExternal(vscode.Uri.parse(a.url));
        return;
    }
  }

  async chooseHead(branch: string): Promise<void> {
    if (!this.branches.some((b) => b.name === branch) || this.busy) return;
    this.headBranch = branch;
    const gen = ++this.gen;
    await this.readHead(gen);
    if (gen !== this.gen) return;
    this.post();
    await this.readCompare(gen);
    if (gen === this.gen) this.post();
  }

  /** Push the branch to another of the clone's GitHub remotes: the head, and where it stands, read again. */
  private async choosePushRemote(remote: string): Promise<void> {
    const branch = this.head?.branch;
    if (!branch || this.busy || !this.remotes.some((r) => r.name === remote) || remote === this.head?.remote) return;
    this.pushChoice = { branch, remote };
    const gen = ++this.gen;
    await this.readHead(gen);
    if (gen === this.gen) this.post();
  }

  private async chooseBase(branch: string): Promise<void> {
    if (!isSafeBranchName(branch) || this.busy) return;
    this.base = branch;
    const gen = ++this.gen;
    await this.readCompare(gen);
    if (gen === this.gen) this.post();
  }

  private async chooseTarget(id: string): Promise<void> {
    const t = this.targets.find((x) => same(x.id, id));
    if (!t || this.busy || (this.target && same(this.target.id, t.id))) return;
    this.target = t;
    this.base = undefined;
    this.template = undefined;
    this.notice = undefined;
    await this.load();
  }

  private async openFile(path: string): Promise<void> {
    const refs = this.diffRefs;
    const f = this.compare.files.find((x) => x.path === path);
    if (!refs || !f) return;
    const root = this.entry.root;
    const left = toRevisionUri(root, refs.left, f.previousPath ?? f.path);
    const right = toRevisionUri(root, refs.right, f.path);
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name} (${this.base} ↔ ${this.head?.branch})`, { preview: true });
  }

  private async draftWithAi(): Promise<void> {
    const brain = this.deps.brain;
    const refs = this.diffRefs;
    if (!brain || !refs || this.busy) return;
    this.busy = "ai";
    this.post();
    try {
      const d = await this.entry.ctx.process.run(["diff", "-M", refs.left, refs.right]);
      const drafted = await brain.generatePrDescription(
        this.rawCommits.map((c) => c.subject),
        d.code === 0 ? d.stdout.slice(0, 200_000) : "",
      );
      if (drafted && drafted.trim()) this.aiBody = { seq: ++this.sendSeq, body: drafted.trim() };
      else this.notice = { icon: "info", tone: "info", title: l10n.t("The AI had nothing to say about this change"), buttons: [] };
    } catch (err) {
      this.notice = { icon: "warning", tone: "warning", title: l10n.t("Couldn't draft the description: {0}", describe(err).message), buttons: [] };
    } finally {
      this.busy = undefined;
      this.post();
    }
  }

  /**
   * Create it: push the branch first when it isn't on its remote (or is
   * behind there) — exactly there, under its own name — then ask GitHub, then
   * add the reviewers, assignees and labels. The form stays filled until
   * GitHub has the pull request; its page then opens in this tab's place.
   */
  private async create(req: PrCreateRequest): Promise<void> {
    const t = this.target;
    const h = this.head;
    const base = this.base;
    const state = this.viewState();
    if (!t || !h || !base || this.busy || state.problem || !req.title.trim()) return;
    this.busy = "create";
    this.notice = undefined;
    this.post();
    try {
      // The branch as it is NOW: a commit made since the form read it is pushed too.
      const now = await this.headNow(h.branch, t);
      if (this.disposed) return;
      if (now.push !== h.push || now.ahead !== h.ahead || now.behind !== h.behind || now.remote !== h.remote) {
        this.head = now;
        // Moved on somewhere else, or pushed elsewhere now: said beside Create, which waits for another press.
        if (now.push === "diverged" || now.push === "unknown" || now.remote !== h.remote) return;
      }
      if (now.push === "new" || now.push === "ahead") {
        if (!now.remote) return;
        const tracks = (await this.entry.ctx.process.run(["config", "--get", `branch.${h.branch}.merge`])).code === 0;
        // push-force-reviewed: publishes the pull request's branch, or adds
        // commits to it — a fast-forward, which git refuses rather than
        // overwrite anything.
        const pushed = await this.entry.ctx.sync.push({ remote: now.remote, branch: h.branch, dest: h.branch, setUpstream: !tracks });
        if (!pushed.ok) {
          this.notice = {
            icon: "warning",
            tone: "warning",
            title: l10n.t("Couldn't push {0} to {1}", h.branch, now.remote),
            detail: (pushed.stderr ?? "").split("\n").find((l) => l.trim()) ?? l10n.t("git refused the push."),
            buttons: [],
          };
          return;
        }
        this.head = { ...now, push: "pushed", ahead: 0 };
      }
      let pr: PullRequest;
      try {
        pr = await this.deps.api.createPull(t.owner, t.repo, { title: req.title.trim(), head: h.ref, base, body: req.body, draft: req.draft });
      } catch (err) {
        if (err instanceof GitHubApiError && err.kind === "validation" && /already exists/i.test(err.message)) {
          const existing = await this.deps.api.findOpenPullForHead(t.owner, t.repo, h.ref.includes(":") ? h.ref : `${t.owner}:${h.ref}`).catch(() => undefined);
          if (existing) {
            void vscode.window.showInformationMessage(l10n.t("{0} already has an open pull request: #{1}.", h.branch, existing.number));
            await this.deps.openPr(existing, contextFor(t, this.entry));
            this.dispose();
            return;
          }
        }
        const why = describe(err);
        this.notice = {
          icon: "warning",
          tone: "warning",
          title: l10n.t("Couldn't create the pull request: {0}", why.message),
          detail: l10n.t("Everything you wrote is still here."),
          buttons: why.kind === "auth" && why.status === 401 ? [{ label: l10n.t("Sign in again"), icon: "sign-in", action: { kind: "signIn", again: true } }] : [],
        };
        return;
      }
      // What only someone with triage access may set, once it exists.
      const data = this.repoData.get(t.id.toLowerCase());
      const may = !!data && canSetMetadata(data.permission);
      const followUps: [string, Promise<unknown> | undefined][] = [
        [l10n.t("request its reviewers"), may && req.reviewers.length > 0 ? this.deps.api.requestReviewers(t.owner, t.repo, pr.number, req.reviewers) : undefined],
        [l10n.t("add its assignees"), may && req.assignees.length > 0 ? this.deps.api.addAssignees(t.owner, t.repo, pr.number, req.assignees) : undefined],
        [l10n.t("add its labels"), may && req.labels.length > 0 ? this.deps.api.addLabels(t.owner, t.repo, pr.number, req.labels) : undefined],
      ];
      const failed: string[] = [];
      await Promise.all(
        followUps.map(async ([what, p]) => {
          if (!p) return;
          try {
            await p;
          } catch (err) {
            failed.push(l10n.t("couldn't {0} ({1})", what, describe(err).message));
          }
        }),
      );
      this.deps.list?.addPr(t.owner, t.repo, pr);
      await this.deps.openPr(pr, contextFor(t, this.entry));
      const made = l10n.t("Created {0}pull request #{1}.", req.draft ? l10n.t("draft ") : "", pr.number);
      if (failed.length > 0) void vscode.window.showWarningMessage(l10n.t("{0} But GitStudio {1}.", made, failed.join(l10n.t(", and "))));
      else void vscode.window.showInformationMessage(made);
      this.dispose();
    } finally {
      if (!this.disposed) {
        this.busy = undefined;
        this.post();
        // What git has now (a push made, a commit found): read, if it changed.
        void this.gitChanged();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gitTimer !== undefined) clearTimeout(this.gitTimer);
    if (PrCreatePage.pages.get(this.entry.root) === this) PrCreatePage.pages.delete(this.entry.root);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.panel.dispose();
  }
}
