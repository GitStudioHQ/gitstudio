// The DesktopHostBridge: the main-process implementation of the IPC contract.
// Every handler wraps the SAME @gitstudio/git-service providers + @gitstudio/
// engine the VS Code extension uses, so the desktop app is a reuse of the proven
// core, not a rewrite. The graph handler in particular streams commits →
// computeGraphLayout → buildWireRows, the exact transformation the extension's
// graphPanel performs (now factored into @gitstudio/host-bridge/graphWire and
// shared by both hosts).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import { buildWireRows } from "@gitstudio/host-bridge/graphWire";
import type {
  CommitRecord,
  GitContext,
  GitRef,
} from "@gitstudio/git-service/index";
import type {
  ChangedFile,
  CommitActionRequest,
  CommitActionResult,
  CommitDetails,
  ConflictModel,
  FileDiff,
  GraphPage,
  HeadInfo,
  RefInfo,
  RowStat,
} from "../shared/ipc";
import type { RepoStore } from "./repoStore";

/** Commits per graph page — matches the extension's PAGE_SIZE. */
const PAGE_SIZE = 500;

export class GitBridge {
  /** sha → record, accumulated as the graph pages stream in (for details). */
  private records = new Map<string, CommitRecord>();
  /** Every loaded input commit, so a page append relayouts the full DAG. */
  private loaded: GraphInputCommit[] = [];
  private refsBySha = new Map<string, GitRef[]>();
  private currentHeadSha = "";
  private loadedRoot: string | undefined;

  constructor(private readonly repos: RepoStore) {}

  private ctx(): GitContext | undefined {
    return this.repos.getContext();
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  /**
   * Streams a page of `git log --all`, lays it out with the engine, decorates
   * the rows with ref chips, and returns the wire rows. On the first page
   * (skip 0) it resets the accumulated state and reloads the refs; later pages
   * relayout the full loaded DAG so cross-page lanes stay continuous — exactly
   * the extension's loadInitial / loadMore behavior, server-side.
   */
  async graphLoad(opts: { skip?: number; maxCount?: number }): Promise<GraphPage> {
    const ctx = this.ctx();
    if (!ctx) {
      return { rows: [], head: "", totalColumns: 1, hasMore: false, nextSkip: 0 };
    }

    const maxCount = opts.maxCount ?? PAGE_SIZE;
    const skip = opts.skip ?? 0;
    const fresh = skip === 0 || ctx.root !== this.loadedRoot;

    if (fresh) {
      this.records.clear();
      this.loaded = [];
      this.loadedRoot = ctx.root;
      await this.loadRefs(ctx);
    }

    const page = await this.readPage(ctx, fresh ? 0 : skip, maxCount);
    const before = fresh ? 0 : this.loaded.length;
    this.loaded = fresh ? page : this.loaded.concat(page);
    const hasMore = page.length === maxCount;

    const layout = computeGraphLayout(this.loaded, { colorCount: 8 });
    const allRows = buildWireRows({
      rows: layout.rows,
      records: this.records,
      refsBySha: this.refsBySha,
    });

    return {
      rows: allRows.slice(before),
      head: this.currentHeadSha,
      totalColumns: layout.totalColumns,
      hasMore,
      nextSkip: this.loaded.length,
    };
  }

  private async readPage(
    ctx: GitContext,
    skip: number,
    maxCount: number,
  ): Promise<GraphInputCommit[]> {
    const page: GraphInputCommit[] = [];
    for await (const commit of ctx.log.streamCommits({
      revRange: "--all",
      maxCount,
      skip,
    })) {
      this.records.set(commit.sha, commit);
      page.push({ sha: commit.sha, parents: commit.parents });
    }
    return page;
  }

  private async loadRefs(ctx: GitContext): Promise<void> {
    this.refsBySha.clear();
    this.currentHeadSha = "";
    let refs: GitRef[] = [];
    try {
      refs = await ctx.refs.listRefs();
    } catch {
      refs = [];
    }
    for (const ref of refs) {
      if (ref.type === "stash") {
        continue;
      }
      const list = this.refsBySha.get(ref.sha);
      if (list) {
        list.push(ref);
      } else {
        this.refsBySha.set(ref.sha, [ref]);
      }
      if (ref.type === "head" && ref.isCurrent) {
        this.currentHeadSha = ref.sha;
      }
    }
  }

  // ── Refs / HEAD ────────────────────────────────────────────────────────────

  async refsList(): Promise<RefInfo[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    try {
      const refs = await ctx.refs.listRefs();
      return refs.map((r) => ({
        type: r.type,
        name: r.name,
        fullName: r.fullName,
        sha: r.sha,
        isCurrent: r.isCurrent,
        upstream: r.upstream,
      }));
    } catch {
      return [];
    }
  }

  async head(): Promise<HeadInfo | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    try {
      const h = await ctx.refs.getHead();
      return h.detached
        ? { detached: true, sha: h.sha }
        : { detached: false, branch: h.branch, sha: h.sha };
    } catch {
      return undefined;
    }
  }

  // ── Commit details ─────────────────────────────────────────────────────────

  async commitDetails(sha: string): Promise<CommitDetails | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    let record = this.records.get(sha);
    if (!record) {
      for await (const c of ctx.log.streamCommits({ revRange: sha, maxCount: 1 })) {
        record = c;
        break;
      }
    }
    if (!record) {
      return undefined;
    }
    return {
      sha: record.sha,
      shortSha: record.sha.slice(0, 7),
      parents: record.parents,
      author: record.author,
      authorEmail: record.authorEmail,
      authorDate: record.authorDate,
      committer: record.committer,
      committerEmail: record.committerEmail,
      committerDate: record.committerDate,
      subject: record.subject,
      body: record.body,
      files: await this.commitFiles(ctx, record),
    };
  }

  /** CHANGES-column stats (file count + add/del) for the given (visible) shas. */
  async rowStats(shas: string[]): Promise<RowStat[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    const out: RowStat[] = [];
    await Promise.all(
      shas.slice(0, 60).map(async (sha) => {
        let record = this.records.get(sha);
        if (!record) {
          for await (const c of ctx.log.streamCommits({
            revRange: sha,
            maxCount: 1,
          })) {
            record = c;
            break;
          }
        }
        if (!record) {
          return;
        }
        try {
          const files = await ctx.commitDetails.getCommitFiles(
            sha,
            record.parents[0],
          );
          let add = 0,
            del = 0;
          for (const f of files) {
            if (f.additions > 0) add += f.additions;
            if (f.deletions > 0) del += f.deletions;
          }
          out.push({ sha, files: files.length, additions: add, deletions: del });
        } catch {
          out.push({ sha, files: 0, additions: 0, deletions: 0 });
        }
      }),
    );
    return out;
  }

  /** Changed files for a commit via `git show --name-status` (or root-diff). */
  private async commitFiles(
    ctx: GitContext,
    record: CommitRecord,
  ): Promise<ChangedFile[]> {
    const range =
      record.parents.length > 0 ? `${record.parents[0]}..${record.sha}` : record.sha;
    const args =
      record.parents.length > 0
        ? ["diff", "--name-status", "-M", range]
        : ["show", "--name-status", "-M", "--format=", record.sha];
    const result = await ctx.process.run(args);
    return parseNameStatus(result.stdout);
  }

  // ── Working-tree status & diff ─────────────────────────────────────────────

  async status(): Promise<ChangedFile[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    const result = await ctx.process.run(["status", "--porcelain=v1", "-z"]);
    return parsePorcelainStatus(result.stdout);
  }

  async diffFiles(): Promise<ChangedFile[]> {
    return this.status();
  }

  /**
   * The two sides of a file diff. For a working-tree file, left = HEAD/index,
   * right = the working text; for a commit, left = parent, right = the commit's
   * version. Reuses StagingProvider.headContent / ConflictProvider.getHeadVersion
   * — the same content readers the extension's diff panel uses.
   */
  async fileDiff(req: { path: string; sha?: string }): Promise<FileDiff | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    const rel = req.path;

    if (req.sha) {
      const right = await showAt(ctx, req.sha, rel);
      const parent = await parentOf(ctx, req.sha);
      const left = parent ? await showAt(ctx, parent, rel) : "";
      return {
        path: rel,
        leftLabel: parent ? `${parent.slice(0, 7)} ${rel}` : `(new) ${rel}`,
        rightLabel: `${req.sha.slice(0, 7)} ${rel}`,
        leftText: left,
        rightText: right,
        conflicted: false,
      };
    }

    // Working-tree diff: is it conflicted?
    const conflicted = await ctx.conflict.isConflicted(rel).catch(() => false);
    const headText = await ctx.staging.headContent(rel).catch(() => "");
    const workingText = await readWorking(ctx, rel);
    return {
      path: rel,
      leftLabel: `HEAD ${rel}`,
      rightLabel: `Working Tree ${rel}`,
      leftText: headText,
      rightText: workingText,
      conflicted,
    };
  }

  /** The three sides of a conflicted file for the shared 3-pane MergeView. */
  async conflictModel(path: string): Promise<ConflictModel | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    const workingText = await readWorking(ctx, path);
    const versions = await ctx.conflict.getConflictVersions(path, { workingText });
    return {
      path,
      hasBase: versions.hasBase,
      base: versions.base,
      ours: versions.ours,
      theirs: versions.theirs,
      result: workingText,
      oursLabel: "Current Change (ours)",
      theirsLabel: "Incoming Change (theirs)",
    };
  }

  // ── Blame ──────────────────────────────────────────────────────────────────

  async blameFile(path: string): Promise<unknown> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    try {
      return await ctx.blame.blameFile(path);
    } catch {
      return undefined;
    }
  }

  // ── Commit actions (graph context menu) ─────────────────────────────────────

  /**
   * Runs a git action against a commit via `ctx.process.run`. Destructive ops
   * (reset --hard) are still confirm-gated in the renderer before this fires.
   */
  async commitAction(req: CommitActionRequest): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    const args = actionArgs(req);
    if (!args) {
      // copy-sha is handled entirely in the renderer; nothing to run here.
      return { ok: true, changed: false };
    }
    try {
      const result = await ctx.process.run(args);
      if (result.code !== 0) {
        return { ok: false, changed: false, message: result.stderr.trim() };
      }
      return { ok: true, changed: true };
    } catch (err) {
      return { ok: false, changed: false, message: String(err) };
    }
  }
}

/** The git argv for a commit action, or undefined for renderer-only actions. */
function actionArgs(req: CommitActionRequest): string[] | undefined {
  switch (req.action) {
    case "checkout":
      return ["checkout", req.sha];
    case "branch":
      return req.name ? ["branch", req.name, req.sha] : undefined;
    case "tag":
      return req.name ? ["tag", req.name, req.sha] : undefined;
    case "cherry-pick":
      return ["cherry-pick", req.sha];
    case "revert":
      return ["revert", "--no-edit", req.sha];
    case "reset-soft":
      return ["reset", "--soft", req.sha];
    case "reset-mixed":
      return ["reset", "--mixed", req.sha];
    case "reset-hard":
      return ["reset", "--hard", req.sha];
    case "copy-sha":
      return undefined;
  }
}

// ── content helpers ──────────────────────────────────────────────────────────

async function showAt(ctx: GitContext, sha: string, rel: string): Promise<string> {
  const r = await ctx.process.run(["show", `${sha}:${rel}`]);
  return r.code === 0 ? r.stdout : "";
}

async function parentOf(ctx: GitContext, sha: string): Promise<string | undefined> {
  const r = await ctx.process.run(["rev-parse", `${sha}^`]);
  const parent = r.stdout.trim();
  return r.code === 0 && parent.length > 0 ? parent : undefined;
}

/**
 * Reads the on-disk working-tree text of a file. The desktop main process has
 * real fs access (this is what an Electron host adds over a webview), so we read
 * the actual file; if it's gone (a deletion) we fall back to the index, then
 * HEAD, so the diff still shows the prior content on the left.
 */
async function readWorking(ctx: GitContext, rel: string): Promise<string> {
  try {
    return await readFile(join(ctx.root, rel), "utf8");
  } catch {
    const indexed = await ctx.staging.indexContent(rel).catch(() => "");
    return indexed || (await ctx.staging.headContent(rel).catch(() => ""));
  }
}

// ── parse helpers ────────────────────────────────────────────────────────────

/** Parses `git diff --name-status` (tab-separated, newline-delimited). */
export function parseNameStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const status = code.charAt(0);
    // Renames/copies carry two paths (R100\told\tnew); take the destination.
    const path = parts.length >= 3 ? parts[2] : parts[1] ?? "";
    if (path) {
      files.push({ path, status });
    }
  }
  return files;
}

/**
 * Parses `git status --porcelain=v1 -z` into changed files, flattening the
 * two-column XY status into one entry per path with the staged flag set.
 */
export function parsePorcelainStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const entries = stdout.split("\0").filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    let path = entry.slice(3);
    // Renames consume the next NUL-delimited token (the original path).
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      i++;
    }
    const staged = x !== " " && x !== "?";
    const status = (staged ? x : y).trim() || "?";
    if (path) {
      files.push({ path, status, staged });
    }
  }
  return files;
}
