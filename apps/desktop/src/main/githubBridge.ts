// The desktop's GitHub layer: PAT-based auth (encrypted at rest via Electron
// safeStorage), owner/repo resolution from the active repo's `origin` remote,
// and thin wrappers over GitHubClient for the PRs / Issues / Projects views.
// OAuth device flow can be layered on later behind the same `status/connect`
// surface; the renderer only knows about connect/disconnect + the data calls.

import { app, safeStorage } from "electron";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { GitHubClient } from "./githubClient";
import { requestDeviceCode, pollForToken } from "./githubAuth";
import type { RepoStore } from "./repoStore";
import type {
  CheckRun,
  CommitActionResult,
  DeviceCodeInfo,
  DevicePollResult,
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

  constructor(private readonly repos: RepoStore) {}

  private tokenPath(): string {
    return join(app.getPath("userData"), "github-token.bin");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    // Only ever read a token back when the OS can decrypt it. We never persist
    // a plaintext token (see persistToken), so a non-decryptable file is junk.
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }
    try {
      const buf = await readFile(this.tokenPath());
      this.token = safeStorage.decryptString(buf);
    } catch {
      // no stored token, or it can't be decrypted on this machine
    }
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
    await this.ensureLoaded();
    const repo = await this.resolveOwnerRepo();
    if (!this.token) {
      return { connected: false, repo };
    }
    if (!this.login) {
      this.login = await this.client.currentLogin();
    }
    return { connected: !!this.login, login: this.login, repo };
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
    // No OS-level encryption (e.g. a headless Linux box with no keyring)? Never
    // write the token in cleartext — keep it in memory for this session only.
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }
    try {
      const data = safeStorage.encryptString(token);
      // Owner-only perms on the (encrypted) blob as a second layer.
      await writeFile(this.tokenPath(), data, { mode: 0o600 });
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
    try {
      await unlink(this.tokenPath());
    } catch {
      // already gone
    }
  }

  async prList(): Promise<PullRequest[]> {
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
    if (!this.token) {
      throw new Error("Not connected to GitHub.");
    }
    const r = await this.resolveOwnerRepo();
    if (!r) {
      throw new Error("This repository isn't on github.com.");
    }
    return fn(this.client, r.owner, r.repo);
  }

  /** Run `fn` with just the client (user-level endpoints: orgs, gists, notifications). */
  async withClient<T>(fn: (client: GitHubClient) => Promise<T>): Promise<T> {
    if (!this.token) {
      throw new Error("Not connected to GitHub.");
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
      return { ok: false, changed: false, message: "Not connected to GitHub." };
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
    if (!r || !this.token) return { ok: false, changed: false, message: "Not connected to GitHub." };
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
