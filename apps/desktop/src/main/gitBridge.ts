// The DesktopHostBridge: the main-process implementation of the IPC contract.
// Every handler wraps the SAME @gitstudio/git-service providers + @gitstudio/
// engine the VS Code extension uses, so the desktop app is a reuse of the proven
// core, not a rewrite. The graph handler in particular streams commits →
// computeGraphLayout → buildWireRows, the exact transformation the extension's
// graphPanel performs (now factored into @gitstudio/host-bridge/graphWire and
// shared by both hosts).

import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import { computeHunks, applySelectedChanges } from "@gitstudio/engine/staging/applyLineChanges";
import type { LineRange } from "@gitstudio/engine/staging/applyLineChanges";
import { buildWireRows } from "@gitstudio/host-bridge/graphWire";
import type {
  CommitRecord,
  GitContext,
  GitRef,
} from "@gitstudio/git-service/index";
import type {
  BranchInfo,
  ChangedFile,
  CommitActionRequest,
  CommitActionResult,
  CommitDetailsPayload,
  CompareCommit,
  CompareMode,
  CompareResult,
  ConflictModel,
  FileDiff,
  GitIdentity,
  GitOpState,
  GraphPage,
  HeadCommit,
  HeadInfo,
  RefInfo,
  RepoFile,
  RowStat,
  SshKey,
  StashInfo,
  SyncStatus,
  TreeEntry,
  WorktreeInfo,
} from "../shared/ipc";
import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";
import type { CommitFileChange } from "@gitstudio/host-bridge/git";
import type { RepoStore } from "./repoStore";

/** Commits per graph page — matches the extension's PAGE_SIZE. */
const PAGE_SIZE = 500;

/** Max blob size the read-only file viewer / README will load (512 KiB). */
const FILE_CAP_BYTES = 512 * 1024;

/**
 * True when a renderer-supplied ref / branch name / SHA can't be mistaken by
 * git for a command-line option (it doesn't begin with "-"). Without this a
 * value like `--upload-pack=…` reaches git as a flag rather than a positional
 * (option injection). Git itself forbids ref names that start with "-", so this
 * never rejects a legitimate value.
 */
export function safeArg(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.startsWith("-");
}

/** Standard rejection for an unsafe ref/name reaching a mutation. */
const UNSAFE_REF_RESULT: CommitActionResult = {
  ok: false,
  changed: false,
  message: "That value isn't a valid git reference.",
};

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

  async commitDetails(sha: string): Promise<CommitDetailsPayload | undefined> {
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
    let files: CommitFileChange[];
    try {
      files = await ctx.commitDetails.getCommitFiles(sha, record.parents[0]);
    } catch {
      files = [];
    }
    const refs: WireRef[] = (this.refsBySha.get(sha) ?? [])
      .filter((r) => r.type !== "stash")
      .map((r): WireRef => {
        if (r.type === "tag") return { kind: "tag", name: r.name };
        if (r.type === "remote") return { kind: "remoteHead", name: r.name };
        return r.isCurrent
          ? { kind: "currentHead", name: r.name }
          : { kind: "head", name: r.name };
      });
    const hasRemote = [...this.refsBySha.values()].some((list) =>
      list.some((r) => r.type === "remote"),
    );
    return {
      kind: "commit",
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
      refs,
      files,
      hasRemote,
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
    try {
      const result = await ctx.process.run(["status", "--porcelain=v1", "-z"]);
      return parsePorcelainStatus(result.stdout);
    } catch {
      // A held index.lock, a repo deleted under us, a corrupt index — return an
      // empty working tree rather than rejecting into the renderer (which would
      // leave the Changes view stuck on its skeleton).
      return [];
    }
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

  // ── Working-tree staging + commit (Changes view) ────────────────────────────

  async stage(path: string): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.staging.stageFile(path));
  }
  async unstage(path: string): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.staging.unstageFile(path));
  }
  async discard(path: string): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.staging.discardChanges(path));
  }
  async stageAll(): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.process.run(["add", "-A"]));
  }
  async unstageAll(): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.process.run(["reset"]));
  }
  async commit(req: { message: string; amend?: boolean }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    if (!req.message.trim() && !req.amend) {
      return { ok: false, changed: false, message: "A commit message is required." };
    }
    return this.serialize(async () => {
      const r = await ctx.staging.commit(req.message, { amend: req.amend });
      return { ok: r.ok, changed: r.ok, message: r.ok ? undefined : r.stderr };
    });
  }

  // ── Stashes ─────────────────────────────────────────────────────────────────

  async stashList(): Promise<StashInfo[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    try {
      return (await ctx.stashes.list()).map((s) => ({
        sha: s.sha,
        ref: s.ref,
        message: s.message,
        time: s.time,
      }));
    } catch {
      return [];
    }
  }
  async stashApply(ref: string): Promise<CommitActionResult> {
    if (!safeArg(ref)) return UNSAFE_REF_RESULT;
    return this.staged(async (ctx) => ctx.stashes.apply(ref));
  }
  async stashPop(ref: string): Promise<CommitActionResult> {
    if (!safeArg(ref)) return UNSAFE_REF_RESULT;
    return this.staged(async (ctx) => ctx.stashes.pop(ref));
  }
  async stashDrop(ref: string): Promise<CommitActionResult> {
    if (!safeArg(ref)) return UNSAFE_REF_RESULT;
    return this.staged(async (ctx) => ctx.stashes.drop(ref));
  }
  async stashSave(opts: { message?: string; includeUntracked?: boolean }): Promise<CommitActionResult> {
    return this.staged(async (ctx) =>
      ctx.stashes.save({ message: opts.message, includeUntracked: opts.includeUntracked }),
    );
  }

  // ── Worktrees ─────────────────────────────────────────────────────────────────

  async worktreeList(): Promise<WorktreeInfo[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    try {
      return (await ctx.worktrees.list()).map((w) => ({
        path: w.path,
        head: w.head,
        branch: w.branch,
        bare: w.bare,
        locked: w.locked,
        prunable: w.prunable,
        current: w.path === ctx.root,
      }));
    } catch {
      return [];
    }
  }
  async worktreeAdd(path: string, ref: string, newBranch?: boolean): Promise<CommitActionResult> {
    if (!safeArg(ref)) return UNSAFE_REF_RESULT;
    return this.staged(async (ctx) => ctx.worktrees.add(path, ref, { newBranch }));
  }
  async worktreeRemove(opts: { path: string; force?: boolean }): Promise<CommitActionResult> {
    return this.staged(async (ctx) => ctx.worktrees.remove(opts.path, { force: opts.force }));
  }

  // ── Compare (base…head) ───────────────────────────────────────────────────────

  async compareRefs(req: {
    base: string;
    head: string;
    mode?: CompareMode;
  }): Promise<CompareResult | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    const { base, head } = req;
    if (!safeArg(base) || !safeArg(head)) {
      return undefined;
    }
    const threeDot = req.mode !== "two-dot"; // default: GitHub-style 3-dot
    const commits: CompareCommit[] = [];
    try {
      for await (const c of ctx.log.streamCommits({ revRange: `${base}..${head}`, maxCount: 400 })) {
        commits.push({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          subject: c.subject,
          author: c.author,
          date: c.authorDate,
        });
      }
    } catch {
      // leave commits empty
    }
    let files: ChangedFile[] = [];
    try {
      // 3-dot (base...head) = "what head introduced since the merge-base";
      // 2-dot (base head)   = the literal difference between the two tips.
      const range = threeDot ? [`${base}...${head}`] : [base, head];
      const r = await ctx.process.run(["diff", "--name-status", "-M", ...range]);
      files = parseNameStatus(r.stdout);
    } catch {
      files = [];
    }
    const behind = await this.revCount(ctx, `${head}..${base}`);
    return { commits, files, ahead: commits.length, behind };
  }

  async compareFileDiff(req: {
    base: string;
    head: string;
    path: string;
    mode?: CompareMode;
  }): Promise<FileDiff | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    if (!safeArg(req.base) || !safeArg(req.head)) {
      return undefined;
    }
    const threeDot = req.mode !== "two-dot";
    // 3-dot diffs the merge-base of (base, head) against head.
    let leftRef = req.base;
    if (threeDot) {
      try {
        const mb = await ctx.process.run(["merge-base", req.base, req.head]);
        if (mb.code === 0 && mb.stdout.trim()) leftRef = mb.stdout.trim();
      } catch {
        leftRef = req.base;
      }
    }
    const left = await showAt(ctx, leftRef, req.path);
    const right = await showAt(ctx, req.head, req.path);
    return {
      path: req.path,
      leftLabel: `${threeDot ? req.base + " (merge-base)" : req.base} ${req.path}`,
      rightLabel: `${req.head} ${req.path}`,
      leftText: left,
      rightText: right,
      conflicted: false,
    };
  }

  // ── Code browser (GitHub-style file tree at HEAD) ───────────────────────────

  /**
   * Lists the immediate children of a directory at HEAD via
   * `git ls-tree --long -z HEAD -- <dir>/`. The trailing slash + non-recursive
   * ls-tree gives exactly one level (folders + files); -z is NUL-delimited so
   * paths with spaces parse cleanly. Sorted folders-first then alphabetical —
   * github.com's order. An empty `path` lists the repo root.
   */
  /**
   * The tip commit of HEAD plus the total commit count — backs the Code
   * browser's "latest commit" bar. Two cheap calls (`log -1` + `rev-list
   * --count`); failures degrade to `undefined` (the bar is simply omitted).
   */
  async headCommit(): Promise<HeadCommit | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    const SEP = "\x00";
    try {
      const r = await ctx.process.run([
        "log",
        "-1",
        "--no-color",
        `--format=%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%at${SEP}%s`,
        "HEAD",
      ]);
      if (r.code !== 0 || !r.stdout.trim()) {
        return undefined;
      }
      const [sha, shortSha, author, authorEmail, at, subject] = r.stdout
        .replace(/\n$/, "")
        .split(SEP);
      let total = 0;
      const c = await ctx.process.run(["rev-list", "--count", "HEAD"]);
      if (c.code === 0) {
        total = parseInt(c.stdout.trim(), 10) || 0;
      }
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        author: author ?? "",
        authorEmail: authorEmail ?? "",
        date: parseInt(at ?? "", 10) || 0,
        subject: subject ?? "",
        total,
      };
    } catch {
      return undefined;
    }
  }

  async treeList(req: { path: string }): Promise<TreeEntry[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    const dir = req.path.replace(/^\/+|\/+$/g, "");
    const spec = dir ? `${dir}/` : "";
    try {
      const args = ["ls-tree", "--long", "-z", "HEAD", "--", ...(spec ? [spec] : [])];
      const r = await ctx.process.run(args);
      if (r.code !== 0) {
        return [];
      }
      const entries = parseLsTree(r.stdout);
      entries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "tree" ? -1 : 1; // folders first
        }
        return a.name.localeCompare(b.name);
      });
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Reads a blob's text at HEAD via `git show HEAD:<path>`. Probes the size
   * first (so huge files never hit the buffer) and flags binary content (a NUL
   * byte) — mirroring the empty-string fallbacks used by showAt elsewhere.
   */
  async fileText(req: { path: string }): Promise<RepoFile | undefined> {
    const ctx = this.ctx();
    if (!ctx) {
      return undefined;
    }
    const rel = req.path.replace(/^\/+/, "");
    if (!rel) {
      return undefined;
    }
    try {
      const probe = await ctx.process.run(["ls-tree", "--long", "-z", "HEAD", "--", rel]);
      if (probe.code !== 0 || !probe.stdout.trim()) {
        return undefined; // not a tracked path at HEAD
      }
      const probed = parseLsTree(probe.stdout)[0];
      if (probed && probed.type !== "blob") {
        return undefined; // it's a directory, not a file
      }
      if (probed && typeof probed.size === "number" && probed.size > FILE_CAP_BYTES) {
        return { path: rel, text: "", truncated: true };
      }
      const r = await ctx.process.run(["show", `HEAD:${rel}`]);
      if (r.code !== 0) {
        return undefined;
      }
      // Binary: a NUL byte, OR a high density of U+FFFD replacement chars — git's
      // stdout is decoded utf8, so a non-UTF-8 / NUL-free binary surfaces as FFFD.
      if (r.stdout.includes("\0") || replacementRatio(r.stdout) > 0.3) {
        return { path: rel, text: "", binary: true };
      }
      if (r.stdout.length > FILE_CAP_BYTES) {
        return { path: rel, text: "", truncated: true };
      }
      return { path: rel, text: r.stdout };
    } catch {
      return undefined;
    }
  }

  // ── Settings: git identity + local SSH keys ─────────────────────────────────

  /** The global git author identity (`git config --global user.name/email`). */
  async gitIdentity(): Promise<GitIdentity> {
    const ctx = this.ctx();
    if (!ctx) {
      return { name: "", email: "" };
    }
    const read = async (key: string): Promise<string> => {
      try {
        const r = await ctx.process.run(["config", "--global", key]);
        return r.code === 0 ? r.stdout.trim() : "";
      } catch {
        return "";
      }
    };
    return { name: await read("user.name"), email: await read("user.email") };
  }

  /** Set the global git author identity. */
  async setGitIdentity(req: GitIdentity): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    const name = req.name.trim();
    const email = req.email.trim();
    // A value starting with "-" would be read by `git config` as an option.
    if ((name && name.startsWith("-")) || (email && email.startsWith("-"))) {
      return { ok: false, changed: false, message: "Name and email can't start with “-”." };
    }
    try {
      if (name) {
        await ctx.process.run(["config", "--global", "user.name", name]);
      }
      if (email) {
        await ctx.process.run(["config", "--global", "user.email", email]);
      }
      return { ok: true, changed: true };
    } catch (err) {
      return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List the local SSH public keys under ~/.ssh (read-only). */
  async sshKeys(): Promise<SshKey[]> {
    try {
      const dir = join(homedir(), ".ssh");
      const files = await readdir(dir);
      const out: SshKey[] = [];
      for (const f of files) {
        if (!f.endsWith(".pub")) {
          continue;
        }
        try {
          const content = (await readFile(join(dir, f), "utf8")).trim();
          const parts = content.split(/\s+/);
          out.push({ file: f, type: parts[0] || "", comment: parts.slice(2).join(" ") });
        } catch {
          // unreadable key file — skip
        }
      }
      out.sort((a, b) => a.file.localeCompare(b.file));
      return out;
    } catch {
      return [];
    }
  }

  // ── Sync (control remote changes) ───────────────────────────────────────────

  async syncStatus(): Promise<SyncStatus> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ahead: 0, behind: 0, noUpstream: true };
    }
    let branch: string | undefined;
    try {
      const h = await ctx.refs.getHead();
      branch = h.detached ? undefined : h.branch;
    } catch {
      branch = undefined;
    }
    const upstream = (await ctx.sync.currentUpstream().catch(() => null)) ?? undefined;
    if (!upstream) {
      return { branch, ahead: 0, behind: 0, noUpstream: true };
    }
    const ab = await ctx.sync.aheadBehind().catch(() => ({ ahead: 0, behind: 0 }));
    return { branch, upstream, ahead: ab.ahead, behind: ab.behind, noUpstream: false };
  }

  async syncFetch(): Promise<CommitActionResult> {
    return this.staged((ctx) => ctx.sync.fetch());
  }
  async syncPull(): Promise<CommitActionResult> {
    return this.staged((ctx) => ctx.sync.pull());
  }
  async syncPush(opts: { setUpstream?: boolean } | undefined): Promise<CommitActionResult> {
    return this.staged((ctx) => ctx.sync.push({ setUpstream: opts?.setUpstream }));
  }

  /** Fast-forward a local branch straight from its upstream WITHOUT checking it
   *  out: `git fetch <remote> <remoteBranch>:<localBranch>`. Git itself refuses
   *  a non-fast-forward and the currently checked-out branch, so the worktree
   *  is never touched. */
  async branchPullFf(name: string): Promise<CommitActionResult> {
    return this.staged(async (ctx) => {
      const up = await ctx.process.run([
        "for-each-ref",
        "--format=%(upstream:short)",
        `refs/heads/${name}`,
      ]);
      const upstream = up.stdout.trim();
      const slash = upstream.indexOf("/");
      if (up.code !== 0 || slash <= 0) {
        return { ok: false, stderr: `'${name}' has no upstream to pull from.` };
      }
      return ctx.process.run([
        "fetch",
        upstream.slice(0, slash),
        `${upstream.slice(slash + 1)}:${name}`,
      ]);
    });
  }

  // ── Branch management ───────────────────────────────────────────────────────

  /** One `for-each-ref` gives every local branch with upstream + ahead/behind. */
  async branchesList(): Promise<BranchInfo[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    const SEP = "\x1f";
    const fmt =
      `%(refname:short)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}` +
      `%(upstream:track)${SEP}%(committerdate:unix)${SEP}%(contents:subject)`;
    let out = "";
    try {
      const r = await ctx.process.run([
        "for-each-ref",
        `--format=${fmt}`,
        "--sort=-committerdate",
        "refs/heads",
      ]);
      out = r.stdout;
    } catch {
      return [];
    }
    const branches: BranchInfo[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [name, head, upstream, track, date, subject] = line.split(SEP);
      const { ahead, behind } = parseTrack(track ?? "");
      branches.push({
        name,
        current: head === "*",
        upstream: upstream || undefined,
        ahead,
        behind,
        subject: subject ?? "",
        date: Number(date) || 0,
      });
    }
    return branches;
  }

  async branchCreate(req: { name: string; checkout?: boolean }): Promise<CommitActionResult> {
    if (!safeArg(req.name)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) =>
      req.checkout ? ctx.branches.checkoutNew(req.name) : ctx.branches.create(req.name),
    );
  }
  async branchDelete(req: { name: string; force?: boolean }): Promise<CommitActionResult> {
    if (!safeArg(req.name)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.delete(req.name, { force: req.force }));
  }

  private async revCount(ctx: GitContext, range: string): Promise<number> {
    try {
      const r = await ctx.process.run(["rev-list", "--count", range]);
      return Number(r.stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Serialize working-tree / index / ref mutations. A fast double-action (a
   * double-clicked Stage, or a checkout fired while a stage is mid-flight) would
   * otherwise run two `git` processes against the same index at once and hit
   * `index.lock`, or leave a half-applied state. Every mutation runs through this
   * single chain; reads stay concurrent.
   */
  private mutationChain: Promise<unknown> = Promise.resolve();
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(op, op);
    // Keep the chain alive whatever this op does; swallow on the chain copy so a
    // failed mutation can't surface as an unhandled rejection (the caller still
    // receives the real outcome via `result`).
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Run a working-tree mutation, mapping the git-service result to the IPC shape. */
  private async staged(
    op: (ctx: GitContext) => Promise<{ ok?: boolean; code?: number; stderr?: string }>,
  ): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    return this.serialize(async () => {
      try {
        const r = await op(ctx);
        const ok = r.ok ?? r.code === 0;
        return { ok, changed: ok, message: ok ? undefined : r.stderr?.trim() };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
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
    if (req.action !== "copy-sha" && !safeArg(req.sha)) {
      return UNSAFE_REF_RESULT;
    }
    if ((req.action === "branch" || req.action === "tag") && !safeArg(req.name)) {
      return UNSAFE_REF_RESULT;
    }
    const args = actionArgs(req);
    if (!args) {
      // copy-sha is handled entirely in the renderer; nothing to run here.
      return { ok: true, changed: false };
    }
    return this.serialize(async () => {
      try {
        const result = await ctx.process.run(args);
        if (result.code !== 0) {
          return { ok: false, changed: false, message: result.stderr.trim() };
        }
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
  }

  // ── Branch ops (merge / rebase / rename / upstream) ─────────────────────────

  async branchMerge(req: { name: string; noFf?: boolean }): Promise<CommitActionResult> {
    if (!safeArg(req.name)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.merge(req.name, { noFf: req.noFf }));
  }

  async branchRebase(req: { onto: string }): Promise<CommitActionResult> {
    if (!safeArg(req.onto)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.rebaseOnto(req.onto));
  }

  async branchRename(req: { from: string; to: string }): Promise<CommitActionResult> {
    if (!safeArg(req.from) || !safeArg(req.to)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.rename(req.from, req.to));
  }

  async branchSetUpstream(req: { name: string; upstream: string }): Promise<CommitActionResult> {
    if (!safeArg(req.name) || !safeArg(req.upstream)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.setUpstream(req.name, req.upstream));
  }

  async branchDeleteRemote(req: { remote: string; name: string }): Promise<CommitActionResult> {
    if (!safeArg(req.remote) || !safeArg(req.name)) return UNSAFE_REF_RESULT;
    return this.staged((ctx) => ctx.branches.deleteRemoteBranch(req.remote, req.name));
  }

  // ── In-progress operation state + abort/continue ────────────────────────────

  async opState(): Promise<GitOpState> {
    const ctx = this.ctx();
    const empty: GitOpState = {
      merging: false,
      rebasing: false,
      cherryPicking: false,
      reverting: false,
      conflicts: 0,
    };
    if (!ctx) return empty;
    const present = async (gitPath: string): Promise<boolean> => {
      try {
        const r = await ctx.process.run(["rev-parse", "--git-path", gitPath]);
        if (r.code !== 0) return false;
        await stat(join(ctx.root, r.stdout.trim()));
        return true;
      } catch {
        return false;
      }
    };
    let conflicts = 0;
    try {
      conflicts = (await ctx.conflict.listConflicts()).length;
    } catch {
      conflicts = 0;
    }
    const [merging, rebaseM, rebaseA, cherryPicking, reverting] = await Promise.all([
      present("MERGE_HEAD"),
      present("rebase-merge"),
      present("rebase-apply"),
      present("CHERRY_PICK_HEAD"),
      present("REVERT_HEAD"),
    ]);
    return {
      merging,
      rebasing: rebaseM || rebaseA,
      cherryPicking,
      reverting,
      conflicts,
    };
  }

  private runResult(args: string[]): Promise<CommitActionResult> {
    return this.staged(async (ctx) => {
      const r = await ctx.process.run(args);
      return { ok: r.code === 0, code: r.code, stderr: r.stderr };
    });
  }

  mergeAbort(): Promise<CommitActionResult> {
    return this.runResult(["merge", "--abort"]);
  }
  mergeContinue(): Promise<CommitActionResult> {
    return this.runResult(["commit", "--no-edit"]);
  }
  rebaseAbort(): Promise<CommitActionResult> {
    return this.runResult(["rebase", "--abort"]);
  }
  rebaseContinue(): Promise<CommitActionResult> {
    return this.runResult(["-c", "core.editor=true", "rebase", "--continue"]);
  }
  rebaseSkip(): Promise<CommitActionResult> {
    return this.runResult(["-c", "core.editor=true", "rebase", "--skip"]);
  }

  // ── Tag creation (the Branches view's "Create tag here…") ───────────────────

  tagCreate(req: { name: string; ref?: string; message?: string }): Promise<CommitActionResult> {
    if (!safeArg(req.name)) return Promise.resolve(UNSAFE_REF_RESULT);
    if (req.ref && !safeArg(req.ref)) return Promise.resolve(UNSAFE_REF_RESULT);
    return this.staged((ctx) =>
      ctx.tags.create(req.name, {
        ref: req.ref,
        message: req.message,
        annotated: req.message !== undefined && req.message.length > 0,
      }),
    );
  }

  // ── Hunk / line staging (working ⇄ index) ───────────────────────────────────

  async stageLines(req: { path: string; lines: number[]; reverse?: boolean }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) return { ok: false, changed: false, message: "No repository open." };
    return this.serialize(async () => {
      try {
        const rel = req.path;
        const ranges = linesToRanges(req.lines);
        if (!ranges.length) return { ok: false, changed: false, message: "No lines selected." };
        let original: string;
        let modified: string;
        if (req.reverse) {
          // Unstage: roll the selected index changes back to HEAD.
          original = await ctx.staging.indexContent(rel);
          modified = await ctx.staging.headContent(rel);
        } else {
          // Stage: apply the selected working-tree changes onto the index.
          original = await ctx.staging.indexContent(rel);
          modified = await readWorking(ctx, rel);
        }
        const hunks = computeHunks(original, modified);
        const selected = hunks.filter((h) => ranges.some((r) => rangesOverlap(h.modified, r)));
        if (!selected.length) return { ok: false, changed: false, message: "Nothing to apply in the selection." };
        const content = applySelectedChanges(original, modified, selected.map((h) => h.modified));
        await ctx.staging.stageContent(rel, content);
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
  }

  // ── Conflict resolution write-back ──────────────────────────────────────────

  async conflictList(): Promise<string[]> {
    const ctx = this.ctx();
    if (!ctx) return [];
    try {
      return await ctx.conflict.listConflicts();
    } catch {
      return [];
    }
  }

  async conflictResolve(req: { path: string; content: string }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) return { ok: false, changed: false, message: "No repository open." };
    if (!safeArg(req.path)) return UNSAFE_REF_RESULT;
    return this.serialize(async () => {
      try {
        await writeFile(join(ctx.root, req.path), req.content, "utf8");
        const r = await ctx.process.run(["add", "--", req.path]);
        if (r.code !== 0) return { ok: false, changed: false, message: r.stderr.trim() };
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
  }

  async conflictTakeSide(req: { path: string; side: "ours" | "theirs" }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) return { ok: false, changed: false, message: "No repository open." };
    if (!safeArg(req.path)) return UNSAFE_REF_RESULT;
    const stage = req.side === "ours" ? "2" : "3";
    return this.serialize(async () => {
      try {
        const show = await ctx.process.run(["show", `:${stage}:${req.path}`]);
        if (show.code !== 0) return { ok: false, changed: false, message: show.stderr.trim() };
        await writeFile(join(ctx.root, req.path), show.stdout, "utf8");
        const r = await ctx.process.run(["add", "--", req.path]);
        if (r.code !== 0) return { ok: false, changed: false, message: r.stderr.trim() };
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
  }
}

/** Group a sorted, de-duplicated list of 1-based line numbers into 0-based
 *  inclusive {start,end} ranges (consecutive lines merge into one range). */
function linesToRanges(lines: number[]): LineRange[] {
  const sorted = Array.from(new Set(lines.filter((n) => Number.isInteger(n) && n >= 1))).sort(
    (a, b) => a - b,
  );
  const ranges: LineRange[] = [];
  for (const n of sorted) {
    const zero = n - 1;
    const last = ranges[ranges.length - 1];
    if (last && zero === last.end + 1) last.end = zero;
    else ranges.push({ start: zero, end: zero });
  }
  return ranges;
}

/** Whether two inclusive line ranges overlap (zero-width spans treated as a point). */
function rangesOverlap(a: LineRange, b: LineRange): boolean {
  const aEnd = a.end < a.start ? a.start : a.end;
  const bEnd = b.end < b.start ? b.start : b.end;
  return a.start <= bEnd && b.start <= aEnd;
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

/**
 * Fraction of U+FFFD replacement chars in a utf8-decoded string. A non-UTF-8 or
 * NUL-free binary blob surfaces as a high density of these; legit text (even
 * Latin-1 prose with occasional accents) stays well below the 0.3 cutoff.
 */
function replacementRatio(s: string): number {
  if (!s.length) {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xfffd) {
      n++;
    }
  }
  return n / s.length;
}

/**
 * Parses `git ls-tree --long -z HEAD` output. Records are NUL-separated; each is
 *   `<mode> SP <type> SP <oid> SP+ <size|-> TAB <path>`
 * e.g. "100644 blob a1b2c3…  1234\tsrc/main.ts" or "040000 tree d4e5…  -\tsrc".
 * `--long` adds the right-aligned size column ("-" for trees). The path is
 * everything after the TAB (so spaces are preserved). Submodules (type
 * "commit") are skipped.
 */
export function parseLsTree(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const rec of stdout.split("\0")) {
    if (!rec) {
      continue;
    }
    const tab = rec.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const meta = rec.slice(0, tab).trim().split(/\s+/); // [mode, type, oid, size]
    const path = rec.slice(tab + 1);
    const rawType = meta[1];
    if (rawType !== "tree" && rawType !== "blob") {
      continue; // skip submodules / anything unexpected
    }
    const sizeField = meta[3];
    const size =
      rawType === "blob" && sizeField && sizeField !== "-" ? Number(sizeField) : undefined;
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    out.push({ name, path, type: rawType, ...(size !== undefined ? { size } : {}) });
  }
  return out;
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

/** Parses git's `%(upstream:track)` field, e.g. "[ahead 2, behind 1]" / "[gone]". */
export function parseTrack(track: string): { ahead: number; behind: number } {
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}

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
