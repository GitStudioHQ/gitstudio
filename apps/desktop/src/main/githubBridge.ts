// The desktop's GitHub layer: PAT-based auth (encrypted at rest, without the OS
// keyring — see @gitstudio/secret-store), owner/repo resolution from the active
// repo's `origin` remote, and thin wrappers over GitHubClient for the PRs /
// Issues / Projects views. OAuth device flow can be layered on later behind the
// same `status/connect` surface; the renderer only knows about connect/disconnect
// plus the data calls.

import { app, safeStorage } from "electron";
import { readFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { SecretStore } from "@gitstudio/secret-store/secretStore";

/** Secret name for the GitHub PAT inside the keychain-free store. */
const TOKEN_SECRET = "github.token";
import { GitHubClient } from "./githubClient";
import { requestDeviceCode, pollForToken } from "./githubAuth";
import type { RepoStore } from "./repoStore";
import { ExpectedError } from "./expectedError";
import type {
  CheckRun,
  CommitActionResult,
  DeviceCodeInfo,
  DevicePollResult,
  ExternalItemDetail,
  GitHubStatus,
  IssueInfo,
  MergeMethod,
  PrComment,
  PrCommitInfo,
  PrDetail,
  ProjectInfo,
  PullRequest,
  WorkflowRun,
} from "../shared/ipc";

export class GitHubBridge {
  private token: string | undefined;
  private login: string | undefined;
  private loaded = false;
  private readonly client = new GitHubClient(() => this.token);
  private ownerRepoRoot: string | undefined;
  private cachedOwnerRepo: { owner: string; repo: string } | undefined;
  /** Lazily built: `app.getPath` is only valid once Electron is ready. */
  private store: SecretStore | undefined;

  constructor(private readonly repos: RepoStore) {}

  /** Pre-1.4 location: a safeStorage blob, i.e. the OS keyring. */
  private legacyTokenPath(): string {
    return join(app.getPath("userData"), "github-token.bin");
  }

  private secrets(): SecretStore {
    this.store ??= new SecretStore(join(app.getPath("userData"), "secrets"));
    return this.store;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.token = await this.secrets().get(TOKEN_SECRET);
    if (this.token === undefined) {
      this.token = await this.adoptLegacyToken();
    }
  }

  /**
   * Move a pre-1.4 safeStorage token into the keychain-free store, once.
   *
   * The only remaining path that can raise an OS password prompt, and it is
   * reached only from `ensureLoaded`, which callers now invoke exclusively
   * before a real GitHub request — never from `status()`, never at launch. After
   * a successful adopt the legacy blob is deleted, so this costs at most one
   * prompt, ever. Declining it just leaves GitHub disconnected for the session.
   */
  private async adoptLegacyToken(): Promise<string | undefined> {
    let buf: Buffer;
    try {
      buf = await readFile(this.legacyTokenPath());
    } catch {
      return undefined; // no stored token — the keyring is never touched
    }
    // We never persisted a plaintext token, so a blob we can't decrypt is junk.
    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    let token: string;
    try {
      token = safeStorage.decryptString(buf);
    } catch {
      return undefined; // stored by a different machine/user
    }
    await this.secrets().set(TOKEN_SECRET, token);
    await unlink(this.legacyTokenPath()).catch(() => {});
    return token;
  }

  /** Resolve owner/repo from `git remote get-url origin` (cached per repo root). */
  private async resolveOwnerRepo(): Promise<{ owner: string; repo: string } | undefined> {
    const ctx = this.repos.getContext();
    if (!ctx) {
      return undefined;
    }
    if (this.ownerRepoRoot === ctx.root) {
      return this.cachedOwnerRepo;
    }
    let url = "";
    try {
      const r = await ctx.process.run(["remote", "get-url", "origin"]);
      url = r.stdout.trim();
    } catch {
      url = "";
    }
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    this.ownerRepoRoot = ctx.root;
    this.cachedOwnerRepo = m ? { owner: m[1], repo: m[2] } : undefined;
    return this.cachedOwnerRepo;
  }

  async status(): Promise<GitHubStatus> {
    const repo = await this.resolveOwnerRepo();
    // DO NOT decrypt here. The Changes view asks for status on every launch just
    // to decide whether to show "Create pull request", and decrypting means
    // touching the login keychain — which raises the OS password prompt on
    // every start (and again after any rebuild, because the keychain ACL is
    // bound to the app's code signature). Whether a token FILE exists is enough
    // to answer "connected"; the token itself is decrypted lazily, the first
    // time an actual GitHub call needs it.
    if (this.token) {
      if (!this.login) {
        this.login = await this.client.currentLogin();
      }
      return { connected: !!this.login, login: this.login, repo };
    }
    if (await this.hasStoredToken()) {
      // Connected, but not yet unlocked — the login name fills in after the
      // first real request.
      return { connected: true, login: this.login, repo };
    }
    return { connected: false, repo };
  }

  /** Is there a stored token, WITHOUT decrypting it? */
  private async hasStoredToken(): Promise<boolean> {
    if (this.secrets().has(TOKEN_SECRET)) {
      return true;
    }
    try {
      await access(this.legacyTokenPath());
      return true;
    } catch {
      return false;
    }
  }

  async connect(pat: string): Promise<{ ok: boolean; login?: string; message?: string }> {
    this.token = pat.trim();
    this.login = await this.client.currentLogin();
    if (!this.login) {
      this.token = undefined;
      return { ok: false, message: "That token didn't work — make sure it has 'repo' scope." };
    }
    await this.persistToken(this.token);
    this.loaded = true;
    return { ok: true, login: this.login };
  }

  /** Encrypt + persist the user token at rest (best-effort). */
  private async persistToken(token: string): Promise<void> {
    try {
      await this.secrets().set(TOKEN_SECRET, token);
      // A freshly entered token supersedes any pre-1.4 blob; drop it so
      // `hasStoredToken` can't be satisfied by a file we will never read again.
      await unlink(this.legacyTokenPath()).catch(() => {});
    } catch {
      // best-effort persistence; the in-memory token still works this session
    }
  }

  /** Device Flow step 1: request a user code to show in the sign-in panel. */
  async deviceStart(): Promise<DeviceCodeInfo> {
    try {
      const dc = await requestDeviceCode();
      return {
        ok: true,
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        verificationUriComplete: dc.verificationUriComplete,
        deviceCode: dc.deviceCode,
        interval: dc.interval,
        expiresIn: dc.expiresIn,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Device Flow step 2: poll once; on authorization, store the token + login. */
  async devicePoll(req: { deviceCode: string }): Promise<DevicePollResult> {
    let r;
    try {
      r = await pollForToken(req.deviceCode);
    } catch (err) {
      return { state: "error", message: err instanceof Error ? err.message : String(err) };
    }
    if (r.state !== "authorized") {
      return { state: r.state, message: r.message };
    }
    this.token = r.accessToken;
    this.login = await this.client.currentLogin();
    if (!this.login) {
      this.token = undefined;
      return { state: "error", message: "Signed in, but GitHub didn't return a user." };
    }
    await this.persistToken(r.accessToken);
    this.loaded = true;
    return { state: "authorized", login: this.login };
  }

  async disconnect(): Promise<void> {
    this.token = undefined;
    this.login = undefined;
    await this.secrets().delete(TOKEN_SECRET);
    try {
      await unlink(this.legacyTokenPath());
    } catch {
      // already gone
    }
  }

  async prList(): Promise<PullRequest[]> {
    await this.ensureLoaded();
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return [];
    }
    // Let API errors (rate limit / auth / network) propagate so the renderer can
    // show a real error state instead of a misleading "no pull requests".
    return this.client.listOpenPulls(r.owner, r.repo);
  }

  /**
   * Run `fn` with the resolved owner/repo + the client, for the per-section
   * modules under ./github. Throws a clean error (→ renderer errorState) when
   * not connected or the repo isn't on github.com.
   */
  async withRepo<T>(
    fn: (client: GitHubClient, owner: string, repo: string) => Promise<T>,
  ): Promise<T> {
    // Unlock on demand: the user asked for GitHub data, so a keychain prompt
    // here is expected and explicable — unlike one at launch.
    await this.ensureLoaded();
    if (!this.token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    const r = await this.resolveOwnerRepo();
    if (!r) {
      throw new ExpectedError("This repository isn't on github.com.");
    }
    return fn(this.client, r.owner, r.repo);
  }

  /** Run `fn` with just the client (user-level endpoints: orgs, gists, notifications). */
  async withClient<T>(fn: (client: GitHubClient) => Promise<T>): Promise<T> {
    await this.ensureLoaded();
    if (!this.token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    return fn(this.client);
  }

  /**
   * Like `withClient`, but NEVER unlocks the token.
   *
   * For ambient, unprompted reads — the notification badge polls on launch, and
   * unlocking for it meant a macOS keychain password prompt every single start,
   * for something the user never asked for. If the token is already unlocked
   * (because a real GitHub action happened this session) the call proceeds;
   * otherwise it yields `undefined` and the caller degrades quietly.
   */
  async withClientIfUnlocked<T>(
    fn: (client: GitHubClient) => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.token) {
      return undefined;
    }
    return fn(this.client);
  }

  async prDetail(n: number): Promise<PrDetail | undefined> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return undefined;
    }
    try {
      const pr = await this.client.getPull(r.owner, r.repo, n);
      const [files, status] = await Promise.all([
        this.client.getPullFiles(r.owner, r.repo, n).catch(() => []),
        this.client.getCombinedStatus(r.owner, r.repo, pr.head.sha).catch(() => ({ state: "", totalCount: 0 })),
      ]);
      return { pr, files, checks: status.state };
    } catch {
      return undefined;
    }
  }

  /** Read-only fetch of an issue/PR from ANY repo (cross-repo notifications open
   *  in-app instead of github.com). Uses the client directly — not the current
   *  repo's owner/repo — so any subject the user is notified about can be read here. */
  async externalItem(req: {
    owner: string;
    repo: string;
    number: number;
    kind: "issue" | "pull";
  }): Promise<ExternalItemDetail | undefined> {
    if (!this.token) return undefined;
    const { owner, repo, number, kind } = req;
    try {
      const comments = (await this.client.listConversation(owner, repo, number).catch(() => []))
        .filter((c) => c.kind === "comment")
        .map((c) => ({ author: c.author || null, body: c.body, createdAt: c.createdAt }));
      if (kind === "pull") {
        const pr = await this.client.getPull(owner, repo, number);
        return {
          kind: "pull", number, repo: `${owner}/${repo}`, title: pr.title,
          state: pr.draft ? "draft" : pr.state, body: pr.body, htmlUrl: pr.htmlUrl,
          author: pr.user?.login ?? null, createdAt: pr.createdAt, comments,
        };
      }
      const issue = await this.client.getIssue(owner, repo, number);
      return {
        kind: "issue", number, repo: `${owner}/${repo}`, title: issue.title,
        state: issue.state, body: issue.body, htmlUrl: issue.htmlUrl,
        author: issue.user?.login ?? null, createdAt: issue.createdAt, comments,
      };
    } catch {
      return undefined;
    }
  }

  /** Fetch the PR's head into a local `pr/<n>` branch and check it out. */
  async prCheckout(n: number): Promise<CommitActionResult> {
    const ctx = this.repos.getContext();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    try {
      const f = await ctx.process.run(["fetch", "origin", `pull/${n}/head:pr/${n}`]);
      if (f.code !== 0) {
        return { ok: false, changed: false, message: f.stderr.trim() };
      }
      const c = await ctx.process.run(["checkout", `pr/${n}`]);
      return c.code === 0
        ? { ok: true, changed: true }
        : { ok: false, changed: false, message: c.stderr.trim() };
    } catch (err) {
      return { ok: false, changed: false, message: String(err) };
    }
  }

  async prMerge(req: { number: number; method: MergeMethod }): Promise<CommitActionResult> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return { ok: false, changed: false, message: "Not connected to GitHub.", expected: true };
    }
    try {
      await this.client.mergePull(r.owner, r.repo, req.number, req.method);
      return { ok: true, changed: true };
    } catch (err) {
      return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async prCommits(n: number): Promise<PrCommitInfo[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) return [];
    return this.client.listPrCommits(r.owner, r.repo, n).catch(() => []);
  }
  async prConversation(n: number): Promise<PrComment[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) return [];
    return this.client.listConversation(r.owner, r.repo, n).catch(() => []);
  }
  async prChecks(n: number): Promise<CheckRun[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) return [];
    try {
      const pr = await this.client.getPull(r.owner, r.repo, n);
      return await this.client.listCheckRuns(r.owner, r.repo, pr.head.sha);
    } catch {
      return [];
    }
  }
  async prApprove(n: number): Promise<CommitActionResult> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) return { ok: false, changed: false, message: "Not connected to GitHub.", expected: true };
    try {
      await this.client.approvePull(r.owner, r.repo, n);
      return { ok: true, changed: false };
    } catch (err) {
      return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  async actionsRuns(): Promise<WorkflowRun[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) return [];
    return this.client.listWorkflowRuns(r.owner, r.repo);
  }

  async issueList(): Promise<IssueInfo[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return [];
    }
    return this.client.listOpenIssues(r.owner, r.repo);
  }

  async issueDetail(n: number): Promise<IssueInfo | undefined> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return undefined;
    }
    try {
      return await this.client.getIssue(r.owner, r.repo, n);
    } catch {
      return undefined;
    }
  }

  async projectList(): Promise<ProjectInfo[]> {
    const r = await this.resolveOwnerRepo();
    if (!r || !this.token) {
      return [];
    }
    return this.client.listProjects(r.owner, r.repo);
  }
}
