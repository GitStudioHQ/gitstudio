// The DesktopHostBridge: the main-process implementation of the IPC contract.
// Every handler wraps the SAME @gitstudio/git-service providers + @gitstudio/
// engine the VS Code extension uses, so the desktop app is a reuse of the proven
// core, not a rewrite. The graph handler in particular streams commits →
// computeGraphLayout → buildWireRows, the exact transformation the extension's
// graphPanel performs (now factored into @gitstudio/host-bridge/graphWire and
// shared by both hosts).

import { readFile, readdir, writeFile, stat, lstat, readlink, realpath } from "node:fs/promises";
import { continueRebase, skipRebase, abortRebase } from "@gitstudio/git-service/RebaseRunner";
import type { RebaseOutcome } from "@gitstudio/git-service/RebaseRunner";
import { ExpectedError } from "./expectedError";
import { join, resolve, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import { computeHunks, applySelectedChanges } from "@gitstudio/engine/staging/applyLineChanges";
import type { LineRange, Hunk } from "@gitstudio/engine/staging/applyLineChanges";
import { buildWireRows } from "@gitstudio/host-bridge/graphWire";
import { commitBlockerMessage } from "@gitstudio/git-service/StagingProvider";
import { stashBlockerMessage } from "@gitstudio/git-service/StashProvider";
import { planRemoteCheckout } from "@gitstudio/git-service/checkoutRemote";
import { listUnstagedHunks, stageHunks } from "@gitstudio/git-service/hunkStaging";
import { setBlockStaged } from "@gitstudio/git-service/blockStaging";
import { unresolvedConflictsMessage } from "@gitstudio/git-service/ConflictProvider";
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
  ChangeBlockWire,
  ConflictModel,
  FileDiff,
  GitIdentity,
  GitOpState,
  GraphPage,
  HeadCommit,
  HeadInfo,
  RefInfo,
  RepoFile,
  FileHunkWire,
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

/**
 * The guard for a value that reaches git as a PATHSPEC, always after `--`.
 *
 * A leading dash is legal there — git stops reading options at the separator —
 * and `safeArg` was refusing it, so a conflicted file named `-fix.patch` (or
 * anything in a `--generated/` directory) could not be resolved at all: every
 * button the conflict view offered answered "That value isn't a valid git
 * reference", about a file the same view had just listed. The real hazards for
 * a path are emptiness and a NUL, which no filename can contain.
 */
export function safePath(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("\0");
}

/** Standard rejection for an unsafe ref/name reaching a mutation. */
const UNSAFE_REF_RESULT: CommitActionResult = {
  ok: false,
  changed: false,
  message: "That value isn't a valid git reference.",
};

/** Standard rejection for an unusable path reaching a mutation. */
const UNSAFE_PATH_RESULT: CommitActionResult = {
  ok: false,
  changed: false,
  message: "That isn't a usable file path.",
};

/**
 * Resolves a renderer-supplied repo-relative path and REFUSES anything that
 * escapes the repository root ("../../…" or an absolute path). safeArg alone
 * only blocks option injection — without this containment check a hostile
 * renderer payload like `../../.zshenv` turns writeFile/readFile into an
 * arbitrary file write/read primitive outside the repo.
 */
export function containedPath(root: string, rel: string): string | undefined {
  const abs = resolve(root, rel);
  const base = resolve(root);
  if (abs === base || abs.startsWith(base + sep)) {
    return abs;
  }
  return undefined;
}

/**
 * A git command that exited non-zero did not succeed with no output.
 *
 * `GitProcess.run` RESOLVES with the exit code (the caller decides), so a read
 * whose command failed comes back as `{ stdout: "", code: 128 }` on the success
 * path — and a parser handed "" returns an empty list. That empty list then
 * rendered as "Working tree clean · No changes to commit" over a working tree
 * full of uncommitted work, and as "No branches yet" in a repo full of branches.
 * A held `index.lock`, a corrupt `.git/index` or `.git/packed-refs`, wrong
 * permissions, or the folder moving out from under the app all produce exactly
 * that. It is the single most dangerous sentence this app can print: it reads as
 * "your changes are already committed".
 *
 * The renderer already knows what to do with a failure — Changes has an
 * errorState with a Retry, and Commits shows "Couldn't load history" precisely
 * because `graph:load` never swallowed. Those paths were unreachable, not
 * missing.
 */
function mustSucceed(result: { stdout: string; stderr?: string; code?: number }, what: string): string {
  if (result.code !== undefined && result.code !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n")[0];
    // ExpectedError, not Error. Git failing here means the REPOSITORY is in a
    // state git refuses to read — a corrupt index, a held index.lock, wrong
    // permissions, the folder moved — which is a condition the user is in, not
    // a defect in this app. As a plain Error every one of those filed a crash
    // report, and the status read runs on a watcher: a single stuck lock would
    // have produced a report per tick. The renderer is unaffected; it receives
    // the same message and shows the same error state with its Retry.
    throw new ExpectedError(
      detail ? `${what}: ${detail}` : `${what} (git exited ${result.code})`,
    );
  }
  return result.stdout;
}


export class GitBridge {
  /** sha → record, accumulated as the graph pages stream in (for details). */
  private records = new Map<string, CommitRecord>();
  /** Every loaded input commit, so a page append relayouts the full DAG. */
  private loaded: GraphInputCommit[] = [];
  private refsBySha = new Map<string, GitRef[]>();
  private currentHeadSha = "";
  private loadedRoot: string | undefined;
  /** Serializes graph:load so two pages never interleave in the accumulator. */
  private graphChain: Promise<unknown> = Promise.resolve();
  /** Bumped by a fresh load so queued stale pages discard themselves. */
  private graphGen = 0;

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
  /**
   * Paging is a stateful accumulator (`loaded` / `records` / `loadedRoot`), and
   * until now nothing stopped two `graph:load` calls interleaving in it.
   *
   * That is reachable, not theoretical: the renderer's adapter clears its
   * `loading` flag on reset and immediately asks for page 0, so a refresh or a
   * repo switch fires skip:0 while a skip:N is still streaming server-side. The
   * two then interleave around the awaits below and build a gapped, out-of-order
   * list — wrong lane routing and totalColumns, and duplicate rows once paging
   * reaches a region already accumulated. The renderer's own generation guard
   * (added with the Branches push work) only protects the renderer's copy; this
   * state lives here.
   *
   * Two mechanisms, because they answer different questions:
   *   · the chain serializes calls, so no two ever interleave in the accumulator;
   *   · the generation lets a page that was already queued when a FRESH load
   *     arrived discard itself instead of appending pre-reload commits.
   */
  async graphLoad(opts: { skip?: number; maxCount?: number }): Promise<GraphPage> {
    const run = this.graphChain.then(() => this.graphLoadInner(opts));
    // Never let one failure poison the chain for every later page.
    this.graphChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async graphLoadInner(opts: { skip?: number; maxCount?: number }): Promise<GraphPage> {
    const ctx = this.ctx();
    if (!ctx) {
      return { rows: [], head: "", totalColumns: 1, hasMore: false, nextSkip: 0 };
    }

    const maxCount = opts.maxCount ?? PAGE_SIZE;
    const skip = opts.skip ?? 0;
    const fresh = skip === 0 || ctx.root !== this.loadedRoot;

    if (fresh) {
      // Supersede anything queued behind us: those pages describe the history we
      // are about to throw away.
      this.graphGen++;
      this.records.clear();
      this.loaded = [];
      this.loadedRoot = ctx.root;
      await this.loadRefs(ctx);
    }
    const gen = this.graphGen;

    const page = await this.readPage(ctx, fresh ? 0 : skip, maxCount);
    if (gen !== this.graphGen) {
      // A fresh load landed while we were streaming. Appending now would splice
      // the old history into the new one.
      return {
        rows: [],
        head: this.currentHeadSha,
        totalColumns: 1,
        hasMore: false,
        nextSkip: this.loaded.length,
      };
    }
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

  /** Branches containing `sha`. Best-effort: never throws at the renderer. */
  async refsContains(
    sha: string,
  ): Promise<{ branches: string[]; truncated: boolean }> {
    const ctx = this.ctx();
    if (!ctx) {
      return { branches: [], truncated: false };
    }
    try {
      return await ctx.refs.containingBranches(sha);
    } catch {
      return { branches: [], truncated: false };
    }
  }

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
    // The cap is a runaway guard, not a page size: the graph asks for exactly
    // the rows in view plus its overscan, and a tall window at compact row
    // height passes 60 easily. Truncating there meant the rows past it were
    // never answered — and the client marked them pending regardless, so their
    // CHANGES cells stayed blank. Sized above any real viewport.
    await Promise.all(
      shas.slice(0, 250).map(async (sha) => {
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
    // -z, always. Without it git C-QUOTES any path outside ASCII — "café.txt"
    // arrives as `"caf\303\251.txt"`, quotes and octal escapes included, and
    // that string is then what the row shows AND what every later `-- <path>`
    // is given, so the file's diff comes back empty. Verified against real git.
    // (`core.quotepath=false` fixes the escapes but not a path containing a tab
    // or a newline, which -z handles too.)
    const args =
      record.parents.length > 0
        ? ["diff", "--name-status", "-M", "-z", range]
        : ["show", "--name-status", "-M", "-z", "--format=", record.sha];
    const result = await ctx.process.run(args);
    return parseNameStatus(result.stdout);
  }

  // ── Working-tree status & diff ─────────────────────────────────────────────

  async status(): Promise<ChangedFile[]> {
    const ctx = this.ctx();
    if (!ctx) {
      return [];
    }
    // NOT wrapped in a catch that returns []. The old comment here claimed a
    // rejection "would leave the Changes view stuck on its skeleton" — that was
    // not true even when it was written: showChangesView catches a rejected
    // status and renders "Couldn't read the working tree" with a Retry. What the
    // swallow actually did was render a broken repo as a clean one.
    const result = await ctx.process.run(["status", "--porcelain=v1", "-z"]);
    return parsePorcelainStatus(mustSucceed(result, "Couldn't read the working tree"));
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
    // Under HEAD's OWN name for it — a staged rename means HEAD has only the
    // old path, and an empty left pane renders a rename as a brand-new file.
    const headName = await headSideName(ctx, rel).catch(() => rel);
    const headText = headName
      ? await ctx.staging.headContent(headName).catch(() => "")
      : "";
    // A DELETED file is not a file we failed to read. `readWorking` falls back
    // to the index and then HEAD when the path is gone — a fallback
    // conflictModel needs and this does not — so a deletion produced a right
    // pane identical to the left one: both panes the same, zero change markers,
    // the app showing a file as unchanged that is not on disk at all. Ask
    // whether it exists rather than inferring it from a failed read.
    const abs = containedPath(ctx.root, rel);
    // lstat, not stat: a DANGLING symlink exists as a link but `stat` follows it
    // and fails, so the file was reported "(deleted)" when it is right there.
    const lst = abs ? await lstat(abs).catch(() => undefined) : undefined;
    const gone = !abs || !lst;
    // A symlink's content is its TARGET. `readFile` follows the link, so the
    // right pane showed the pointed-at file's text — and a rename of the link
    // rendered as that file's whole contents appearing from nowhere.
    const isLink = !!lst?.isSymbolicLink();
    const workingText = gone
      ? ""
      : isLink
        ? await readlink(abs!).catch(() => "")
        : await readWorking(ctx, rel);
    return {
      path: rel,
      leftLabel: `HEAD ${rel}`,
      rightLabel: gone ? `(deleted) ${rel}` : `Working Tree ${rel}`,
      leftText: headText,
      rightText: workingText,
      conflicted,
      // Read alongside HEAD and the working tree so the ticks describe the same
      // revision as the panes. A conflicted file has no meaningful index entry
      // to stage against, so it gets no ticks.
      indexText: conflicted ? undefined : await ctx.staging.indexContent(rel).catch(() => ""),
    };
  }

  /** Stage or unstage exactly one change block of a working-tree file. */
  async blocksSet(req: {
    path: string;
    block: ChangeBlockWire;
    staged: boolean;
  }): Promise<CommitActionResult & { indexText?: string }> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    const abs = containedPath(ctx.root, req.path);
    if (!abs) {
      return UNSAFE_REF_RESULT;
    }
    return this.serialize(async () => {
      try {
        const working = await readFile(abs, "utf8");
        const r = await setBlockStaged(ctx, req.path, working, req.block, req.staged);
        if (!r.ok) {
          // The file moved under the tick — a user state, not a crash report.
          return { ok: false, changed: false, expected: true, message: r.stderr };
        }
        // Hand back the new index so the ticks repaint from the truth rather
        // than from an optimistic guess about what the click did.
        return {
          ok: true,
          changed: true,
          indexText: await ctx.staging.indexContent(req.path).catch(() => ""),
        };
      } catch (err) {
        return { ok: false, changed: false, message: String(err) };
      }
    });
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
    return this.staged(async (ctx) => {
      // `git checkout --` only restores TRACKED paths; an untracked file must
      // be removed via `git clean` instead (StagingProvider's own contract) —
      // otherwise Discard on a new file always fails with "pathspec did not
      // match any file(s) known to git".
      const st = await ctx.process.run(["status", "--porcelain=v1", "-z", "--", path]);
      const untracked = st.code === 0 && st.stdout.startsWith("??");
      return untracked
        ? ctx.staging.cleanFiles([path])
        : ctx.staging.discardChanges(path);
    });
  }
  /**
   * Stage everything — except a conflict you have not actually resolved.
   *
   * `git add -A` marks an unmerged path RESOLVED. It does not care whether the
   * file still contains `<<<<<<<`. So during a conflicted merge, "Stage all"
   * followed by Commit was two clicks that produced a commit with conflict
   * markers in the source — and, because staging cleared the unmerged entries,
   * the app's conflict count dropped to zero and re-enabled Continue, so nothing
   * on screen suggested anything was wrong.
   *
   * The naive guard — "exclude every unmerged path" — is worse: someone who
   * resolved a conflict properly in another editor would find that file could
   * never be staged and Continue disabled forever, with nothing explaining why.
   * So resolutions are staged and only marker-bearing files are held back, by
   * name, so the message says what to go and fix.
   */
  async stageAll(): Promise<CommitActionResult> {
    return this.staged(async (ctx) => {
      const st = await ctx.process.run(["status", "--porcelain=v1", "-z"]);
      const unmerged =
        st.code === 0 ? parsePorcelainStatus(st.stdout).filter((f) => f.conflicted) : [];
      const unresolved: string[] = [];
      const needsChoice: string[] = [];
      for (const f of unmerged) {
        // A modify/delete conflict (UD / DU) never contains markers — git leaves
        // one side's file in the tree and asks you to choose keep-or-delete. So
        // "no markers" cannot mean "resolved" here, and staging it silently
        // picks a side on the user's behalf. Those need a decision, not a bulk
        // action, and per-file staging still makes one.
        const modifyDelete = f.conflictKind === "UD" || f.conflictKind === "DU";
        if (modifyDelete) {
          unresolved.push(f.path);
          needsChoice.push(f.path);
        } else if (await this.hasConflictMarkers(ctx, f.path)) {
          unresolved.push(f.path);
        }
      }
      if (unresolved.length === 0) return ctx.process.run(["add", "-A"]);
      // An explicit ALLOW-LIST, not `:!` exclusions: verified against real git,
      // `add -A -- . ':!path'` stages the excluded path anyway, so the exclusion
      // would have been silent and this guard would have done nothing at all.
      const hold = new Set(unresolved);
      const allow = [...new Set(parsePorcelainStatus(st.stdout).map((f) => f.path))].filter(
        (p) => !hold.has(p),
      );
      if (allow.length > 0) {
        const add = await ctx.process.run(["add", "-A", "--", ...allow]);
        if (add.code !== 0) return add;
      }
      // Two different reasons to hold a file back, needing two different things
      // done to them — say which is which rather than one vague sentence.
      const marked = unresolved.filter((p) => !needsChoice.includes(p));
      const list = (paths: string[]): string => {
        const head = paths.slice(0, 3).join(", ");
        return paths.length > 3 ? `${head} and ${paths.length - 3} more` : head;
      };
      const parts: string[] = [];
      if (marked.length) {
        parts.push(
          `${marked.length} still contain${marked.length === 1 ? "s" : ""} conflict markers ` +
            `(${list(marked)}) — staging a file with markers in it tells git the conflict is settled`,
        );
      }
      if (needsChoice.length) {
        parts.push(
          `${needsChoice.length} ${needsChoice.length === 1 ? "is a" : "are"} modify/delete ` +
            `conflict${needsChoice.length === 1 ? "" : "s"} (${list(needsChoice)}) — one side edited ` +
            `the file and the other deleted it, so you have to choose keep or delete`,
        );
      }
      return {
        ok: false,
        changed: true,
        expected: true,
        message: `Staged everything else. ${parts.join(". ")}.`,
      };
    });
  }

  /** Does this working-tree file still carry `<<<<<<<` conflict markers? */
  private async hasConflictMarkers(
    ctx: { root: string },
    path: string,
  ): Promise<boolean> {
    try {
      const buf = await readFile(join(ctx.root, path), "utf8");
      return /^<{7}[ \t]/m.test(buf) && /^>{7}[ \t]/m.test(buf);
    } catch {
      // Unreadable (deleted by one side, binary, permissions) — not our call to
      // make here; let git decide when the user stages it explicitly.
      return false;
    }
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
    // A plain commit does NOT finish a `git am`, it derails it: the session
    // stays open on disk, the remaining patches are never applied, and the
    // patch's own author and message are replaced by yours. git's own answer is
    // `git am --continue`, which reuses the patch's metadata. Every other
    // mid-operation state is left alone — committing IS how you finish a merge,
    // and `commit` then `--continue` is a legitimate way through a rebase.
    const am = await this.amInProgress();
    if (am) {
      return {
        ok: false,
        changed: false,
        expected: true,
        message:
          "A patch series is part-applied (git am). Use Continue in the banner above — a plain commit " +
          "would leave the rest of the series unapplied and put your name on someone else's patch.",
      };
    }
    return this.serialize(async () => {
      const r = await ctx.staging.commit(req.message, { amend: req.amend });
      if (r.ok) {
        return { ok: true, changed: true };
      }
      // git refuses a commit with nothing staged on exit 1, explains itself on
      // STDOUT, and leaves stderr empty — so passing `r.stderr` through gave the
      // renderer an error toast with no text in it (issue #16). An empty stderr
      // is the cue to ask git what the situation is.
      const stderr = r.stderr.trim();
      const blocker = stderr
        ? undefined
        : await ctx.staging.whyNothingToCommit();
      if (blocker) {
        // `expected` matters here, and only became necessary once this path
        // started returning a message at all: the IPC wrapper crash-reports any
        // ok:false result that carries one, so giving "nothing is staged" a
        // message would otherwise have filed a report every time someone hit
        // Commit too early. See main/expectedError.ts.
        return {
          ok: false,
          changed: false,
          expected: true,
          message: commitBlockerMessage(blocker),
        };
      }
      // `expected` here too, and this one is a fix for the fix: giving this
      // branch a message at all made it crash-reportable, because the IPC
      // wrapper files any ok:false result that carries one. A pre-commit hook
      // that exits non-zero WITHOUT printing anything leaves both streams empty
      // (verified against real git), so the fallback text below would have been
      // filed as a GitStudio failure — for someone else's hook doing exactly
      // what it was written to do.
      //
      // The policy that settles it: `git commit` exiting non-zero is never our
      // defect. It means a hook rejected the commit, a signing key failed, files
      // are unmerged, or nothing was staged — every one of them a state of the
      // user's repo. Our own bugs in this path throw, and throws are still
      // reported.
      return {
        ok: false,
        changed: false,
        expected: true,
        message:
          stderr ||
          r.stdout.trim() ||
          "git refused the commit without saying why. If this repository has a pre-commit hook, check its output.",
      };
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
  /**
   * The changes inside one file that are not staged yet (#20), so the Changes
   * view can offer a tick per change rather than only per file.
   *
   * Reads the file from DISK, because that is what git would stage.
   */
  async hunksList(rel: string): Promise<FileHunkWire[]> {
    const ctx = this.ctx();
    if (!ctx || !rel) {
      return [];
    }
    const abs = containedPath(ctx.root, rel);
    if (!abs) {
      return [];
    }
    // Do not OFFER what cannot be done safely. Reading with "utf8" succeeds on a
    // PNG — it just mangles it — so the catch below never fired for the case
    // that mattered, and the row listed hunks whose staging destroyed the file.
    if (!(await lineStageable(ctx, rel)).ok) {
      return [];
    }
    try {
      const text = await readFile(abs, "utf8");
      return await listUnstagedHunks(ctx, rel, text);
    } catch {
      return []; // deleted or unreadable — the row simply offers nothing
    }
  }

  async hunksStage(req: { path: string; index: number }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    const abs = containedPath(ctx.root, req.path);
    if (!abs) {
      return UNSAFE_REF_RESULT;
    }
    return this.serialize(async () => {
      try {
        const safe = await lineStageable(ctx, req.path);
        if (!safe.ok) return { ok: false, changed: false, expected: true, message: safe.why };
        const text = await readFile(abs, "utf8");
        const r = await stageHunks(ctx, req.path, text, [req.index]);
        if (!r.ok) {
          // Positional indexes went stale — the file moved under the list.
          return { ok: false, changed: false, expected: true, message: r.stderr };
        }
        return { ok: true, changed: true };
      } catch (err) {
        return {
          ok: false,
          changed: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  async stashSave(opts: {
    message?: string;
    includeUntracked?: boolean;
    /** Repo-relative paths to stash; omitted or empty means the whole tree. */
    paths?: string[];
    /** Stash only what is staged. Cannot be combined with `paths` — see below. */
    stagedOnly?: boolean;
  }): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    // Every path is proved to be inside the repository before it reaches git,
    // like every other mutating handler here. A stash pathspec is a write.
    const paths = (opts.paths ?? []).filter((p) => p.length > 0);
    if (paths.some((p) => !containedPath(ctx.root, p))) {
      return UNSAFE_REF_RESULT;
    }
    return this.serialize(async () => {
      // NOT via `staged()`, which decides success from the exit code alone. `git
      // stash push` with nothing to save exits 0, so that would report a stash
      // that never happened — and then `changed: true` would refresh the views to
      // show the work still sitting there, contradicting its own success toast.
      const r = await ctx.stashes.save({
        message: opts.message,
        includeUntracked: opts.includeUntracked,
        paths,
        stagedOnly: opts.stagedOnly,
      });
      if (!r.ok) {
        return { ok: false, changed: false, message: r.stderr.trim() || "The stash failed." };
      }
      if (!r.created) {
        return {
          ok: false,
          changed: false,
          expected: true,
          // Scoped, so a selection that turned out to be clean does not claim
          // "the working tree is clean" over a tree full of other changes.
          message: stashBlockerMessage(
            r.blocker ?? "cleanTree",
            opts.stagedOnly ? "staged" : paths.length > 0 ? "selection" : "tree",
          ),
        };
      }
      return { ok: true, changed: true };
    });
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
    // `git worktree remove` builds its argv as ["worktree", "remove", path]
    // with no `--`, so a path beginning with "-" would reach git as an option.
    // The paths come from git's own worktree list today, but this is the same
    // guard every other ref-taking mutation on this bridge already applies.
    if (!safeArg(opts.path)) return UNSAFE_REF_RESULT;
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
      const r = await ctx.process.run(["diff", "--name-status", "-M", "-z", ...range]);
      files = parseNameStatus(r.stdout);
    } catch {
      files = [];
    }
    const behind = await this.revCount(ctx, `${head}..${base}`);
    // `commits.length` is the CAP (400), not the answer. It was reported as
    // `ahead` beside `behind`, which is a real count from rev-list — so a
    // comparison of 900 commits read "400 ahead · 12 behind", with the lie
    // wearing the same authority as the truth. Count it properly and say when
    // the list below is only the first page of it.
    const ahead = await this.revCount(ctx, `${base}..${head}`);
    return { commits, files, ahead, behind, commitsTruncated: ahead > commits.length };
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
    // The separator has TWO spellings and they are not interchangeable.
    // In the ARGUMENT it must be git's escape `%x00`: node's spawn() refuses
    // any argv entry containing a literal NUL, and it throws rather than
    // failing the command — which the catch below swallowed, so headCommit
    // returned undefined on every single call and nothing downstream knew.
    // In the OUTPUT it is a real NUL, which is what we split on.
    const SEP = "\x00";
    try {
      const r = await ctx.process.run([
        "log",
        "-1",
        "--no-color",
        // %B (whole message) LAST: it is the only field containing newlines,
        // and the fields are NUL-separated, so it cannot run into another.
        "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%B",
        "HEAD",
      ]);
      if (r.code !== 0 || !r.stdout.trim()) {
        return undefined;
      }
      const [sha, shortSha, author, authorEmail, at, subject, message] = r.stdout
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
        // git pads %B with a trailing newline, and --format adds one more.
        message: (message ?? "").replace(/\n+$/, ""),
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
    // An identity is a PAIR. git refuses to commit without both
    // ("Please tell me who you are"), so a half-filled card is not a saveable
    // state — and the code below only wrote the fields that were non-empty, so
    // clearing one and pressing Save reported "Identity updated" while leaving
    // the old value in ~/.gitconfig, untouched and unmentioned.
    if (!name && !email) {
      return { ok: false, changed: false, message: "Enter a name and an email to save." };
    }
    if (!name || !email) {
      return {
        ok: false,
        changed: false,
        message: `Git needs both a name and an email to record a commit. ${
          name ? "Add an email" : "Add a name"
        } to save, or leave the card as it is — nothing has been changed.`,
      };
    }
    try {
      const writes: Array<[string, string]> = [
        ["user.name", name],
        ["user.email", email],
      ];
      for (const [key, value] of writes) {
        const r = await ctx.process.run(["config", "--global", key, value]);
        // `git config` exits non-zero WITHOUT throwing (run() resolves with the
        // code) — e.g. a read-only or locked ~/.gitconfig, or a broken include.
        // This used to fall through to "updated ✓" while writing nothing.
        if (r.code !== 0) {
          return {
            ok: false,
            changed: false,
            message:
              r.stderr.trim() || `git config --global ${key} failed (exit ${r.code}).`,
          };
        }
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

  async syncFetch(opts?: { prune?: boolean }): Promise<CommitActionResult> {
    return this.staged((ctx) => ctx.sync.fetch({ prune: opts?.prune }));
  }
  async syncPull(): Promise<CommitActionResult> {
    return this.staged((ctx) => ctx.sync.pull());
  }
  /**
   * `force` becomes `--force-with-lease`, never a bare `--force` — the lease
   * still refuses when the remote moved since the last fetch. Required after
   * amending a commit that was already pushed, where a plain push can only ever
   * be rejected non-fast-forward.
   */
  async syncPush(
    opts: { setUpstream?: boolean; force?: boolean } | undefined,
  ): Promise<CommitActionResult> {
    return this.staged((ctx) =>
      ctx.sync.push({ setUpstream: opts?.setUpstream, force: opts?.force }),
    );
  }

  /** Fast-forward a local branch straight from its upstream WITHOUT checking it
   *  out: `git fetch <remote> <remoteBranch>:<localBranch>`. Git itself refuses
   *  a non-fast-forward and the currently checked-out branch, so the worktree
   *  is never touched. */
  async branchPullFf(name: string): Promise<CommitActionResult> {
    if (!safeArg(name)) return UNSAFE_REF_RESULT;
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

  /**
   * Push a SPECIFIC branch, publishing it when it has no upstream yet. The
   * Branches view previously had no push at all — only the top-bar widget could
   * push, and only the checked-out branch — so an ahead or unpublished branch
   * was unpushable from the list it was displayed in.
   */
  async branchPush(name: string): Promise<CommitActionResult> {
    if (!safeArg(name)) return UNSAFE_REF_RESULT;
    return this.staged(async (ctx) => {
      const up = await ctx.process.run([
        "for-each-ref",
        "--format=%(upstream:short)",
        `refs/heads/${name}`,
      ]);
      const upstream = up.code === 0 ? up.stdout.trim() : "";
      const slash = upstream.indexOf("/");
      if (slash > 0) {
        // Tracked: push it to the remote it already tracks.
        // push-force-reviewed: a named OTHER branch, not the checked-out
        // one; see the extension's branchActions for the same reasoning.
        return ctx.sync.push({ remote: upstream.slice(0, slash), branch: name });
      }
      // Unpublished: pick a remote and set upstream. Prefer origin, else the
      // only remote; with several non-origin remotes there is no safe guess.
      const remotes = await ctx.remotes.list();
      const names = remotes.map((r) => r.name);
      const remote =
        names.find((n) => n === "origin") ?? (names.length === 1 ? names[0] : undefined);
      if (!remote) {
        return {
          ok: false,
          stderr:
            names.length === 0
              ? `No remote is configured, so '${name}' can't be published.`
              : `Several remotes are configured — publish '${name}' from the branch's Set upstream… action.`,
        };
      }
      // push-force-reviewed: publish — nothing on the remote to overwrite.
      return ctx.sync.push({ remote, branch: name, setUpstream: true });
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
    // No catch-and-return-[]: `for-each-ref` exits 0 with no output in a repo
    // that genuinely has no branches, so a non-zero exit means the read FAILED
    // and "No branches yet" would be a lie about a repo full of them.
    const r = await ctx.process.run([
      "for-each-ref",
      `--format=${fmt}`,
      "--sort=-committerdate",
      "refs/heads",
    ]);
    const out = mustSucceed(r, "Couldn't list branches");
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

  /** Recent commits reachable from one ref — the browsable history a peek card
   *  shows for a branch/remote/tag without loading the whole graph. */
  async refLog(req: { ref: string; maxCount?: number }): Promise<CompareCommit[]> {
    const ctx = this.ctx();
    if (!ctx || !safeArg(req.ref)) {
      return [];
    }
    const max = Math.min(Math.max(req.maxCount ?? 25, 1), 100);
    const out: CompareCommit[] = [];
    try {
      for await (const c of ctx.log.streamCommits({ revRange: req.ref, maxCount: max })) {
        out.push({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          subject: c.subject,
          author: c.author,
          date: c.authorDate,
        });
      }
    } catch {
      // An unknown/unborn ref is a state, not an error — the peek shows empty.
      return [];
    }
    return out;
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

  /**
   * Check out a ref that sits on a commit, rather than the commit itself
   * (issues #12/#19). The extension has offered this since 1.5.0; the app only
   * ever offered a detaching checkout, so landing on a branch tip meant either a
   * detached HEAD or a trip to the Branches view.
   *
   * The remote case reuses the extension's planner from git-service verbatim, so
   * "check out origin/x" means the same thing in both products: switch to a local
   * x if it exists, otherwise create it tracking the remote.
   */
  /**
   * Was this git failure explained by the repo still having unresolved conflicts?
   *
   * Then it is a state the user is in, not a defect: the message is worth showing
   * and the crash report is not (gitstudio-reports#9). Deliberately keyed on the
   * unmerged index and NOT on the operation markers — an empty cherry-pick leaves
   * a marker with zero unmerged files, and that report is one we want.
   */
  private async conflictExplains(ctx: GitContext): Promise<string | undefined> {
    try {
      const n = await ctx.conflict.unmergedCount();
      return n > 0 ? unresolvedConflictsMessage(n) : undefined;
    } catch {
      return undefined;
    }
  }

  private async checkoutRef(
    ctx: GitContext,
    req: CommitActionRequest,
  ): Promise<CommitActionResult> {
    const name = req.name;
    if (!name || !safeArg(name)) {
      return UNSAFE_REF_RESULT;
    }
    return this.serialize(async () => {
      const args =
        req.refKind === "remote"
          ? (await planRemoteCheckout(ctx.process, name)).args
          : req.refKind === "tag"
            ? // A tag is a fixed point, so this one really does detach.
              ["checkout", "--detach", name]
            : ["checkout", name];
      const r = await ctx.process.run(args);
      if (r.code === 0) {
        return { ok: true, changed: true };
      }
      const stderr = r.stderr.trim();
      const conflicts = await this.conflictExplains(ctx);
      if (conflicts) {
        return { ok: false, changed: false, expected: true, message: conflicts };
      }
      return {
        ok: false,
        changed: false,
        message: stderr || r.stdout.trim() || "The checkout failed.",
        ...(stderr ? {} : { expected: true }),
      };
    });
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

  /**
   * Run a working-tree mutation, mapping the git-service result to the IPC shape.
   *
   * Falls back to STDOUT when stderr is empty, which is the only reason a failed
   * mutation ever reached the renderer with nothing to say. A handful of git
   * commands report a refusal on stdout — reverting something already reverted,
   * `rebase --continue` with conflicts still unresolved, `commit --no-edit`
   * finishing a merge that is not ready — and every one of those produced a blank
   * toast, because `"" ?? fallback` is `""`.
   *
   * And when the message came ONLY from stdout, it is marked `expected`. That is
   * the honest reading: git exiting non-zero while writing nothing to stderr is
   * git DECLINING to do something, not GitStudio failing at it — a state of the
   * user's repo. Without this, teaching these paths to speak would have turned
   * every "nothing to do" into a crash report, which is exactly the trap the
   * commit fix fell into first.
   */
  private async staged(
    op: (
      ctx: GitContext,
    ) => Promise<{
      ok?: boolean;
      code?: number;
      stderr?: string;
      stdout?: string;
      /** A message the OP composed. It knows more than stderr does. */
      message?: string;
      changed?: boolean;
      expected?: boolean;
    }>,
  ): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) {
      return { ok: false, changed: false, message: "No repository open." };
    }
    return this.serialize(async () => {
      try {
        const r = await op(ctx);
        const ok = r.ok ?? r.code === 0;
        if (ok) {
          return { ok, changed: true };
        }
        const stderr = r.stderr?.trim() ?? "";
        const stdout = r.stdout?.trim() ?? "";
        // An op's OWN message wins. stageAll composes one naming the files it
        // held back; replacing it with "The operation failed." threw away the
        // only part the user could act on.
        if (r.message) {
          return {
            ok: false,
            changed: r.changed ?? false,
            message: r.message,
            ...(r.expected ? { expected: true } : {}),
          };
        }
        const both = `${stdout}\n${stderr}`;
        // git explains some ordinary situations on STDERR, and the IPC wrapper
        // crash-reports any ok:false result carrying a message that is not
        // marked expected. "The previous cherry-pick is now empty" is the
        // commonest of them — picking something already on the branch — and it
        // filed a report on every press of a button the app itself had enabled.
        const ordinary = /is now empty|nothing to commit|no changes .* patch already applied/i.test(both);
        return {
          ok: false,
          changed: false,
          message: stderr || stdout || "The operation failed.",
          ...(stderr && !ordinary ? {} : { expected: true }),
        };
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
    if (req.action === "checkout-ref") {
      return this.checkoutRef(ctx, req);
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
          // Same stdout fallback and same `expected` rule as staged(): reverting
          // a commit that is already reverted exits non-zero with stderr EMPTY
          // and "nothing to commit, working tree clean" on stdout, which used to
          // arrive as a blank toast. It is git declining, not us failing.
          const stderr = result.stderr.trim();
          const stdout = result.stdout.trim();
          const conflicts = await this.conflictExplains(ctx);
          if (conflicts) {
            return { ok: false, changed: false, expected: true, message: conflicts };
          }
          return {
            ok: false,
            changed: false,
            message: stderr || stdout || "The operation failed.",
            ...(stderr ? {} : { expected: true }),
          };
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
      amApplying: false,
      conflicts: 0,
      nothingToCommit: false,
    };
    if (!ctx) return empty;
    const present = async (gitPath: string): Promise<boolean> => {
      try {
        const r = await ctx.process.run(["rev-parse", "--git-path", gitPath]);
        if (r.code !== 0) return false;
        // resolve(), NOT join(). Inside a linked worktree git answers with an
        // ABSOLUTE path (…/main-repo/.git/worktrees/<wt>/MERGE_HEAD), and
        // path.join concatenates it onto the root to produce a path that cannot
        // exist — so an in-progress merge or rebase in a worktree was never
        // detected and the Abort/Continue banner never appeared, stranding the
        // user with no in-app way out. resolve() returns an absolute second
        // argument unchanged and still joins a relative one.
        await stat(resolve(ctx.root, r.stdout.trim()));
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
    const [merging, rebaseM, rebaseA, amMarker, cherryPicking, reverting] = await Promise.all([
      present("MERGE_HEAD"),
      present("rebase-merge"),
      present("rebase-apply"),
      // `git am` uses the SAME rebase-apply directory. git tells them apart by
      // a marker inside it — `applying` for am, `rebasing` for a rebase on the
      // apply backend — and they are mutually exclusive. Without asking, a
      // conflicted `git am` beside the app showed "rebase in progress" with
      // Abort and Continue, both of which run `git rebase` and are refused, so
      // the only banner offering a way out led nowhere.
      present("rebase-apply/applying"),
      present("CHERRY_PICK_HEAD"),
      present("REVERT_HEAD"),
    ]);
    return {
      merging,
      rebasing: rebaseM || (rebaseA && !amMarker),
      amApplying: rebaseA && amMarker,
      cherryPicking,
      reverting,
      conflicts,
      // Only meaningful while something is stopped, and only when nothing is
      // conflicted: `diff --cached --quiet HEAD` exiting 0 means the index
      // matches HEAD, so there is no commit left to make.
      // A MERGE is deliberately excluded: git allows an empty merge commit, so
      // `commit --no-edit` genuinely finishes one whose result matches HEAD.
      // The verbs that refuse are the sequencer's.
      nothingToCommit:
        conflicts === 0 &&
        (rebaseM || rebaseA || cherryPicking || reverting) &&
        (await ctx.process.run(["diff", "--cached", "--quiet", "HEAD"])).code === 0,
    };
  }

  private runResult(args: string[]): Promise<CommitActionResult> {
    return this.staged(async (ctx) => {
      const r = await ctx.process.run(args);
      // stdout matters here: rebase --continue with unresolved conflicts, and
      // merge-continue's `commit --no-edit`, both explain themselves there.
      return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
    });
  }

  /** Is a `git am` stopped mid-series? The `applying` marker is git's own way
   *  of telling an am from a rebase inside the shared `rebase-apply/`. */
  private async amInProgress(): Promise<boolean> {
    const ctx = this.ctx();
    if (!ctx) return false;
    const r = await ctx.process.run(["rev-parse", "--git-path", "rebase-apply/applying"]);
    if (r.code !== 0) return false;
    try {
      // resolve(), not join() — inside a linked worktree git answers with an
      // absolute path. Same reasoning as `opState`'s own probe.
      await stat(resolve(ctx.root, r.stdout.trim()));
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Finishing, and abandoning, a part-applied patch series.
   *
   * `--continue` takes no `--no-edit`: it reuses the patch's own message and
   * author, which is the whole reason a plain commit is the wrong way out.
   *
   * `--abort` is the destructive one. It rewinds to where the series started,
   * discarding patches it already applied — and when HEAD has moved since, git
   * declines to rewind, prints "Not rewinding to ORIG_HEAD" and still exits 0.
   * Reporting that as "Done." would be a lie about the repository's state, so
   * the warning is passed back as the result's message.
   */
  amContinue(): Promise<CommitActionResult> {
    return this.runResult(["am", "--continue"]);
  }
  async amAbort(): Promise<CommitActionResult> {
    const ctx = this.ctx();
    if (!ctx) return { ok: false, changed: false, message: "No repository open." };
    const r = await ctx.process.run(["am", "--abort"]);
    if (r.code !== 0) {
      return { ok: false, changed: false, message: r.stderr.trim() || `git am --abort failed (${r.code}).` };
    }
    const warned = /not rewinding to orig_head/i.test(`${r.stdout}\n${r.stderr}`);
    return {
      ok: true,
      changed: true,
      ...(warned
        ? {
            message:
              "The patch series was abandoned, but HEAD had moved since it started, so git left it " +
              "where it is rather than rewinding. Check the log before carrying on.",
          }
        : {}),
    };
  }
  mergeAbort(): Promise<CommitActionResult> {
    return this.runResult(["merge", "--abort"]);
  }
  mergeContinue(): Promise<CommitActionResult> {
    return this.runResult(["commit", "--no-edit"]);
  }
  /**
   * Cherry-pick and revert abort and continue THEMSELVES.
   *
   * The banner names four operations and then collapsed them into two
   * channels, so a stopped cherry-pick or revert was aborted with
   * `git merge --abort` — which fails outright, because MERGE_HEAD does not
   * exist. The banner correctly said "cherry-pick in progress" and its only
   * way out did nothing.
   */
  cherryPickAbort(): Promise<CommitActionResult> {
    return this.runResult(["cherry-pick", "--abort"]);
  }
  cherryPickContinue(): Promise<CommitActionResult> {
    return this.runResult(["cherry-pick", "--continue", "--no-edit"]);
  }
  /**
   * Skipping the stopped commit. This is git's own answer to "the previous
   * cherry-pick is now empty", and it was the one way out the banner never
   * offered.
   */
  cherryPickSkip(): Promise<CommitActionResult> {
    return this.runResult(["cherry-pick", "--skip"]);
  }
  revertSkip(): Promise<CommitActionResult> {
    return this.runResult(["revert", "--skip"]);
  }
  revertAbort(): Promise<CommitActionResult> {
    return this.runResult(["revert", "--abort"]);
  }
  revertContinue(): Promise<CommitActionResult> {
    return this.runResult(["revert", "--continue", "--no-edit"]);
  }
  /**
   * Abort through the RUNNER, which also forgets the reword queue.
   *
   * `runResult(["rebase","--abort"])` left it in `.git`. Keying by sha makes a
   * stale queue inert against a FOREIGN rebase — but an abort restores the
   * ORIGINAL shas, so an abandoned draft matched perfectly the next time that
   * branch was rebased, and renamed a commit the user never asked to reword.
   * Measured: "FINAL log: ABANDONED-DRAFT | m2 | m1".
   */
  rebaseAbort(): Promise<CommitActionResult> {
    return this.resumeRebase(async (root, o) => {
      // The runner's message form: a failed abort says WHY — a locked index,
      // an unmerged path git will not discard — instead of a canned sentence.
      return await abortRebase(root, o);
    });
  }
  /**
   * Continue / skip through the RUNNER, not `-c core.editor=true`.
   *
   * A no-op editor discards every reword message queued for the commits AFTER
   * the one that stopped — the plan the user composed, applied silently and
   * only in part, reported as "Rebase continued." The runner re-installs the
   * queue (keyed by sha, so it can only ever apply to this rebase).
   */
  rebaseContinue(): Promise<CommitActionResult> {
    return this.resumeRebase((root, o) => continueRebase(root, o));
  }
  rebaseSkip(): Promise<CommitActionResult> {
    return this.resumeRebase((root, o) => skipRebase(root, o));
  }

  private async resumeRebase(
    run: (root: string, opts: ReturnType<RepoStore["runnerOptions"]>) => Promise<RebaseOutcome>,
  ): Promise<CommitActionResult> {
    const root = this.repos.current()?.root;
    if (!root) return { ok: false, changed: false, message: "No repository open." };
    return this.serialize(async () => {
      try {
        // The runner spawns git itself, so it has to be told which git and
        // where to report — otherwise these commands vanish from the Output tab
        // and fall back to a bare "git" on PATH.
        const out = await run(root, this.repos.runnerOptions());
        if (out.status === "done") return { ok: true, changed: true };
        // A stop is not a failure — the rebase is still live and the view says
        // so. `expected` keeps it out of the crash reporter.
        return {
          ok: false,
          changed: true,
          expected: out.status === "stopped",
          message: out.message ?? (out.status === "stopped" ? "Rebase paused." : "Rebase failed."),
        };
      } catch (err) {
        return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
      }
    });
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
    // Every other mutating path here proves the path stays inside the repo
    // before touching it (hunksStage, hunksList, conflictResolve). This one
    // wrote to the index from a renderer-supplied path without doing so.
    if (!containedPath(ctx.root, req.path)) {
      return UNSAFE_REF_RESULT;
    }
    return this.serialize(async () => {
      try {
        const rel = req.path;
        const ranges = linesToRanges(req.lines);
        if (!ranges.length) return { ok: false, changed: false, message: "No lines selected." };
        // Before reading anything: this path round-trips the file through a
        // string, which destroys a binary and follows a symlink.
        const safe = await lineStageable(ctx, rel);
        if (!safe.ok) return { ok: false, changed: false, expected: true, message: safe.why };
        let original: string;
        let modified: string;
        if (req.reverse) {
          // Unstage: roll the selected index changes back to HEAD — under the
          // name HEAD actually knows. See headSideName: for a staged rename the
          // new path is not in HEAD, and reading "" made the whole file look
          // like one insertion that a single-line unstage then wiped.
          const headName = await headSideName(ctx, rel);
          original = await ctx.staging.indexContent(rel);
          modified = headName ? await ctx.staging.headContent(headName) : "";
          if (!headName) {
            // HEAD has no such file under any name: this is a newly ADDED file,
            // where "roll back to HEAD" means unstage the whole thing. Doing it
            // through the file-level op keeps the add intact in the working
            // tree instead of writing an empty blob over it.
            const un = await ctx.staging.unstageFile(rel);
            return un.ok
              ? { ok: true, changed: true }
              : { ok: false, changed: false, message: un.stderr.trim() || "Couldn't unstage the file." };
          }
        } else {
          // Stage: apply the selected working-tree changes onto the index.
          original = await ctx.staging.indexContent(rel);
          modified = await readWorking(ctx, rel);
        }
        const hunks = computeHunks(original, modified);
        // WHICH coordinates the selection arrives in.
        //
        // `fileDiff` builds EVERY working-tree diff as HEAD (left) vs WORKING
        // (right), whatever the file's stage state — the index is carried only
        // as `indexText`, for the tick glyphs, and is never a pane. And
        // `getSelectedLines` reads the RIGHT editor. So the numbers the renderer
        // sends are always WORKING-tree line numbers.
        //
        // The comment that stood here said the opposite ("that pane always shows
        // `original` — the index"), and the code followed the comment. For
        // staging it did not matter: `modified` IS the working tree there. For
        // UNSTAGING, `modified` is HEAD and `original` is the index, and neither
        // is numbered like the working tree — so on a file that is staged AND
        // further modified (git's `MM`), an unstaged edit above the selection
        // shifts every later working line away from its index line, and the
        // selection matched a DIFFERENT hunk: a staged change the user never
        // clicked was rolled back to HEAD and the app said "Unstaged selected
        // lines." Or it matched nothing, and said "Nothing to apply in the
        // selection." for a line plainly on screen.
        //
        // So translate first, through the index→working diff, and match on the
        // index side.
        let selection = ranges;
        if (req.reverse) {
          selection = toOriginalRanges(ranges, computeHunks(original, await readWorking(ctx, rel)));
          if (!selection.length) {
            return { ok: false, changed: false, message: "Nothing to apply in the selection." };
          }
        }
        const sideOf = (h: (typeof hunks)[number]): LineRange => (req.reverse ? h.original : h.modified);
        const selected = hunks.filter((h) => selection.some((r) => rangesOverlap(sideOf(h), r)));
        if (!selected.length) return { ok: false, changed: false, message: "Nothing to apply in the selection." };
        const content = applySelectedChanges(original, modified, selected.map((h) => h.modified));
        // …and report what actually happened. This discarded stageContent's
        // result and answered ok:true unconditionally, so a write that failed
        // was indistinguishable from one that worked.
        const wrote = await ctx.staging.stageContent(rel, content);
        if (!wrote.ok) {
          // `stderr`, not `message`. CommitResult is `{ ok, stderr }` — it has
          // never had a `message` — so the cast always read undefined and the
          // fallback always won. Every real failure said "Couldn't update the
          // index." while git's own text was thrown away, including the one
          // that tells you exactly what to do: "Another git process seems to be
          // running in this repository… remove the file manually to continue."
          return {
            ok: false,
            changed: false,
            message: wrote.stderr.trim() || "Couldn't update the index.",
          };
        }
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
    if (!safePath(req.path)) return UNSAFE_PATH_RESULT;
    return this.serialize(async () => {
      try {
        const abs = containedPath(ctx.root, req.path);
        if (!abs) return { ok: false, changed: false, message: "Path escapes the repository." };
        // The merge view's "Mark resolved" hands back a JavaScript string, and
        // `writeFile` follows symlinks. So on a conflicted symlink this opened
        // the LINK'S TARGET — a file that may be nowhere near the repository —
        // and overwrote it, while the link git actually tracks kept its old
        // value; and on a conflicted binary it wrote back the U+FFFD wreckage
        // of a UTF-8 round trip. Both reported "Resolved and staged."
        //
        // Take ours / Take theirs is the way through both: `git checkout
        // --ours/--theirs` never decodes and never follows.
        const safe = await textWriteSafe(abs, req.path, (what) =>
          what === "symlink"
            ? `${req.path} is a symbolic link. Saving text here would overwrite whatever it points at, not the link — use Take ours or Take theirs.`
            : `${req.path} isn't UTF-8 text. Saving it as text would rewrite the bytes it can't represent — use Take ours or Take theirs.`,
        );
        if (!safe.ok) return { ok: false, changed: false, expected: true, message: safe.why };
        // A containment check that resolves SYMLINKS, not just "..". The one
        // above is purely lexical, so a repo-relative path whose PARENT is a
        // symlink pointing outside still lands outside. Both sides are
        // realpath'd — on macOS the repo root itself is usually under a
        // symlinked /tmp, so realpathing only the child refuses every
        // legitimate file.
        const realRoot = await realpath(ctx.root).catch(() => ctx.root);
        const realDir = await realpath(dirname(abs)).catch(() => undefined);
        if (!realDir || (realDir !== realRoot && !realDir.startsWith(realRoot + sep))) {
          return {
            ok: false,
            changed: false,
            expected: true,
            message: `${req.path} resolves outside the repository — nothing was written.`,
          };
        }
        await writeFile(abs, req.content, "utf8");
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
    if (!safePath(req.path)) return UNSAFE_PATH_RESULT;
    const stage = req.side === "ours" ? "2" : "3";
    return this.serialize(async () => {
      try {
        // A modify/delete conflict has only TWO stages: the base, and whichever
        // side kept the file. Asking for the missing one is not an error — that
        // side's answer IS "delete it" — but `git show :3:path` exits non-zero
        // and the user got a raw `fatal: path ... does not exist` for pressing a
        // button the app itself offered. Taking a side that deleted the file
        // means removing the file.
        // NO pathspec, and an exact path comparison below.
        //
        // This answer decides whether "Take theirs" WRITES a file or DELETES
        // one, so it must not depend on git's pathspec matching — which is
        // glob-capable, and whose literal-vs-glob precedence is steerable from
        // the environment git is spawned with (`GIT_GLOB_PATHSPECS`,
        // `GIT_LITERAL_PATHSPECS`). A filename like `[id].tsx`, ordinary in
        // every Next.js and SvelteKit app, is a character class if it is ever
        // read as a glob. Measured on git 2.49 it is matched literally in all
        // three modes, so this is not a bug being fixed — it is a dependency
        // being removed from a code path whose two outcomes are write and
        // delete.
        //
        // `:(literal)` would NOT do it: with `GIT_LITERAL_PATHSPECS=1` set the
        // magic prefix becomes part of the filename and matches nothing.
        //
        // The list is bounded by the number of conflicts, which is small.
        const unmerged = await ctx.process.run(["ls-files", "-u"]);
        if (unmerged.code === 0 && unmerged.stdout.trim()) {
          // Filter by the PATH each line names, not just by the stage number.
          // A pathspec is a glob: `[id].tsx` — an ordinary filename in every
          // Next.js and SvelteKit app — is a character class matching `i`, `d`,
          // and any sibling file whose name is one of those characters. Those
          // siblings are not conflicted, so no stage 2 or 3 line appears for
          // them; but a stage-1 line from the real file plus the union of
          // everything matched made the "which sides exist" answer wrong, and
          // Take theirs concluded "theirs deleted it" and ran `git rm` on a
          // file that was plainly there.
          //
          // Not `:(literal)`: git is spawned with the inherited environment, so
          // under `GIT_LITERAL_PATHSPECS=1` the magic prefix becomes part of
          // the filename and matches nothing at all.
          const present = new Set(
            unmerged.stdout
              .split("\n")
              .map((line) => /^\d{6} [0-9a-f]+ (\d)\t(.*)$/.exec(line))
              .filter((m): m is RegExpExecArray => !!m && m[2] === req.path)
              .map((m) => m[1]),
          );
          if (!present.has(stage)) {
            const rm = await ctx.process.run(["rm", "-f", "--", req.path]);
            if (rm.code !== 0) {
              return { ok: false, changed: false, message: rm.stderr.trim() || "Couldn't delete the file." };
            }
            return { ok: true, changed: true };
          }
        }
        // Let GIT write the bytes. This used to `git show :N:path`, take the
        // stdout as a STRING and write it back as UTF-8 — and `GitProcess.run`
        // decodes stdout with `Buffer.concat(...).toString("utf8")`, which is
        // lossy for anything that is not UTF-8 text. So resolving a conflicted
        // PNG, PDF or any binary asset wrote mangled bytes over it and STAGED
        // them, then reported success: verified on a real 512×512 PNG, whose
        // header came back `efbfbd504e470d0a` instead of `89504e470d0a1a0a`,
        // 36,078 bytes in and 67,288 bytes out. Take-ours/take-theirs is the
        // only resolution the app offers for a binary conflict, so this was the
        // only path available, and it destroyed the file.
        //
        // `checkout --ours/--theirs` never decodes anything.
        const co = await ctx.process.run([
          "checkout",
          req.side === "ours" ? "--ours" : "--theirs",
          "--",
          req.path,
        ]);
        if (co.code !== 0) {
          return {
            ok: false,
            changed: false,
            message: co.stderr.trim() || `Couldn't take the ${req.side === "ours" ? "current" : "incoming"} version.`,
          };
        }
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

/**
 * Re-expresses ranges numbered on the MODIFIED side of `hunks` in ORIGINAL-side
 * coordinates.
 *
 * Used to carry a working-tree selection back into index numbering before it is
 * matched against the index→HEAD hunks. Lines outside every hunk shift by the
 * running length difference of the hunks before them; a line inside a hunk maps
 * to that hunk's whole original span. Lines the original does not have at all —
 * a working-only insertion — map to nothing, because there is no staged change
 * under them to pick up.
 */
function toOriginalRanges(ranges: LineRange[], hunks: Hunk[]): LineRange[] {
  const len = (r: LineRange): number => (r.end < r.start ? 0 : r.end - r.start + 1);
  const mapped: LineRange[] = [];
  // The mapping is monotonic, so folding each result into the previous one keeps
  // the output the size of the selection's shape rather than its line count.
  const add = (r: LineRange): void => {
    const last = mapped[mapped.length - 1];
    if (last && r.start >= last.start && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      return;
    }
    mapped.push(r);
  };
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line++) {
      let delta = 0;
      let landed = false;
      for (const h of hunks) {
        if (len(h.modified) > 0 && line >= h.modified.start && line <= h.modified.end) {
          if (len(h.original) > 0) add({ ...h.original });
          landed = true;
          break;
        }
        if (h.modified.start > line) break;
        delta += len(h.modified) - len(h.original);
      }
      if (!landed) add({ start: line - delta, end: line - delta });
    }
  }
  return mapped;
}

/**
 * Can this path be staged CHANGE BY CHANGE without being destroyed?
 *
 * Line and hunk staging round-trips the file through a JavaScript string:
 * `indexContent`/`readWorking` decode it as UTF-8, the selected changes are
 * applied to that string, and `stageContent` hashes it back. Every byte that is
 * not valid UTF-8 becomes U+FFFD on the way through, so staging one line of a
 * PNG wrote a mangled blob into the index — 29 bytes in, 42 out, header
 * `efbfbd504e47` instead of `89504e47` — and answered ok:true.
 *
 * A symlink is worse: `readFile` FOLLOWS it, so the "content" is the pointed-at
 * file's text, and staging wrote that text as the link's new target under mode
 * 120000 — a permanently dangling link, committed and cloned that way.
 *
 * Deliberately NOT `isStageableText`, which the sibling tick path uses: its
 * invariant is "cheap enough to repaint ticks", so it passes NUL-free Latin-1
 * (still destroyed) and REFUSES a 25,000-line text file that stages correctly
 * today. This asks the exact question instead — do the bytes survive the round
 * trip this code is about to perform.
 */
/**
 * The two kinds of file that a text write-back destroys, asked once.
 *
 * A symlink, because `writeFile` FOLLOWS it: the app opens the link's target
 * and overwrites whatever is there — a file that may be nowhere near the
 * repository — while the link itself, which is what git tracks, is untouched.
 * And a non-UTF-8 file, because the content has been round-tripped through a
 * JavaScript string by the time it gets here, and every byte that is not valid
 * UTF-8 came back as U+FFFD.
 *
 * Shared because it was answered separately in two places and only one of them
 * was ever right. `conflictTakeSide` was fixed to let git move the bytes;
 * `conflictResolve`, forty lines below it, still wrote a JS string through
 * `writeFile` and reported "Resolved and staged." over a corrupted PNG and an
 * obliterated file outside the repo. `caller` supplies wording that names a
 * control the user can actually see from where they are.
 */
async function textWriteSafe(
  abs: string,
  rel: string,
  advice: (what: "symlink" | "binary") => string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const st = await lstat(abs).catch(() => undefined);
  if (st?.isSymbolicLink()) return { ok: false, why: advice("symlink") };
  if (st?.isFile()) {
    const bytes = await readFile(abs).catch(() => undefined);
    if (bytes && Buffer.compare(Buffer.from(bytes.toString("utf8"), "utf8"), bytes) !== 0) {
      return { ok: false, why: advice("binary") };
    }
  }
  return { ok: true };
}

async function lineStageable(
  ctx: GitContext,
  rel: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const abs = containedPath(ctx.root, rel);
  if (!abs) return { ok: false, why: "That path is outside the repository." };
  const safe = await textWriteSafe(abs, rel, (what) =>
    what === "symlink"
      ? `${rel} is a symbolic link — stage it whole. Staging part of one would write a file's contents into the link.`
      : `${rel} isn't UTF-8 text — stage it whole. Staging part of it would rewrite the bytes it can't represent.`,
  );
  if (!safe.ok) return safe;
  // The side already in the index can be binary even when the working file is
  // gone or readable. git answers this itself: `--numstat` prints "-" for a
  // binary blob rather than a line count.
  const ns = await ctx.process.run(["diff", "--cached", "--numstat", "--", rel]);
  if (ns.code === 0 && /^-\t-\t/m.test(ns.stdout)) {
    return {
      ok: false,
      why: `${rel} is staged as a binary file — stage or unstage it whole.`,
    };
  }
  return { ok: true };
}

/**
 * The name this path had at HEAD.
 *
 * A staged RENAME means HEAD has only the OLD name, so `git show HEAD:<new>`
 * exits non-zero and `headContent` answers "". Everything downstream then reads
 * the file as one giant insertion: the diff's left pane is empty, so a rename
 * plus a one-line edit renders as a brand-new file — and unstaging a single
 * line rolls the WHOLE file back to that empty side, putting the empty blob in
 * the index and committing a 0-byte file, reporting ok:true at every step.
 *
 * `-M` asks git which path it came from. Returns the path unchanged when it is
 * not a rename, and undefined when HEAD does not have it under any name (a
 * genuinely new file), which is a different case the caller must handle.
 */
async function headSideName(ctx: GitContext, rel: string): Promise<string | undefined> {
  // NO pathspec. Limiting the diff to the destination filters the rename's
  // SOURCE out of it, and `-M` then has nothing to pair with — git reports
  // `A helpers.ts` instead of `R077 util.ts helpers.ts`, which is exactly the
  // "brand new file" answer that made a one-line unstage wipe the whole thing.
  // Verified both ways against real git.
  const r = await ctx.process.run(["diff", "--cached", "--name-status", "-M", "-z"]);
  if (r.code === 0) {
    const tok = r.stdout.split("\0").filter((t) => t.length > 0);
    for (let i = 0; i < tok.length; ) {
      const code = tok[i];
      // R/C carry a similarity score and TWO paths: source then destination.
      const renamed = code.startsWith("R") || code.startsWith("C");
      const src = tok[i + 1];
      const dst = renamed ? tok[i + 2] : src;
      if (renamed && dst === rel && src) return src;
      i += renamed ? 3 : 2;
    }
  }
  // Not a rename. Does HEAD have it at all?
  const has = await ctx.process.run(["cat-file", "-e", `HEAD:${rel}`]);
  return has.code === 0 ? rel : undefined;
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
    case "checkout-ref":
      // copy-sha is renderer-only; checkout-ref needs an async probe and is
      // intercepted in commitAction before this is reached.
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
    const abs = containedPath(ctx.root, rel);
    if (!abs) return "";
    return await readFile(abs, "utf8");
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
/**
 * Parses `git diff/show --name-status -M -z`.
 *
 * With -z the output is a flat NUL-separated stream, NOT lines: a status record
 * followed by its path, and for R/C entries by TWO paths (source then
 * destination). Nothing is quoted or escaped, which is the whole point — the
 * previous line/tab parse handed the UI git's C-quoted form of any non-ASCII
 * name (`"caf\303\251.txt"`), and that same string was then passed back as a
 * pathspec, so the diff for it was always empty.
 */
export function parseNameStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const tok = stdout.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tok.length; i++) {
    const code = tok[i];
    const status = code.charAt(0);
    // R/C carry a similarity score and two paths; the destination is the one
    // that exists now, so it is the one to show and to diff.
    const paths = status === "R" || status === "C" ? 2 : 1;
    const path = tok[i + paths];
    i += paths;
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
    if (!path) {
      continue;
    }
    // UNMERGED paths first, because for them the two columns do NOT mean
    // index-half and worktree-half. Git's own docs list seven unmerged codes —
    // DD AU UD UA DU AA UU — and in every one the columns are the two SIDES of
    // the merge. Reading them as halves emitted TWO rows for one conflicted
    // file: a phantom "staged" copy (carrying an Unstage button that destroys
    // the merge stages) and a worktree copy whose letter contradicted git, e.g.
    // `D` on a file plainly sitting on disk. One path, one row, marked as what
    // it is.
    const unmerged =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (unmerged) {
      files.push({ path, status: "U", staged: false, conflicted: true, conflictKind: x + y });
      continue;
    }
    // A record can carry BOTH an index half (x) and a worktree half (y) —
    // e.g. "MM" = staged edit plus a newer unstaged edit. Emitting only the
    // index side hides the worktree half from the Changes view, and a commit
    // then silently excludes the newer edits.
    const hasStaged = x !== " " && x !== "?";
    const hasUnstaged = y !== " ";
    if (hasStaged) {
      files.push({ path, status: x.trim() || "?", staged: true });
    }
    if (hasUnstaged || !hasStaged) {
      files.push({ path, status: y.trim() || "?", staged: false });
    }
  }
  return files;
}
