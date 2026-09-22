import { GitProcess, type GitRunHook } from "./GitProcess";
import { LogProvider } from "./LogProvider";
import { CommitDetailsProvider } from "./CommitDetailsProvider";
import { RefProvider } from "./RefProvider";
import { BlameProvider } from "./BlameProvider";
import { HistoryProvider } from "./HistoryProvider";
import { ConflictProvider } from "./ConflictProvider";
import { StagingProvider } from "./StagingProvider";
import { StatusProvider } from "./StatusProvider";
import { SnapshotProvider } from "./SnapshotProvider";
import { StashProvider } from "./StashProvider";
import { WorktreeProvider } from "./WorktreeProvider";
import { BranchOps } from "./BranchOps";
import { RemoteOps } from "./RemoteOps";
import { SyncOps } from "./SyncOps";
import { TagOps } from "./TagOps";
import { OperationProvider } from "./OperationProvider";
import { ConflictOps } from "./ConflictOps";

export interface GitContextOptions {
  /** Absolute path to the repo root. */
  root: string;
  /** Path to the git binary; defaults to "git". */
  gitPath?: string;
  /** Maximum number of concurrent git processes; defaults to 12 (see GitProcess). */
  maxConcurrent?: number;
  /** Optional observer fired once per completed git invocation (see GitProcess). */
  onRun?: GitRunHook;
}

/**
 * Wires the data-layer pieces for a single repository: a bounded GitProcess
 * pool plus the streaming log, ref, blame, and history providers. One per open
 * repo.
 */
export class GitContext {
  readonly root: string;
  readonly process: GitProcess;
  readonly log: LogProvider;
  readonly commitDetails: CommitDetailsProvider;
  readonly refs: RefProvider;
  readonly blame: BlameProvider;
  readonly history: HistoryProvider;
  readonly conflict: ConflictProvider;
  readonly staging: StagingProvider;
  readonly status: StatusProvider;
  readonly snapshot: SnapshotProvider;
  readonly stashes: StashProvider;
  readonly worktrees: WorktreeProvider;
  readonly branches: BranchOps;
  readonly remotes: RemoteOps;
  readonly sync: SyncOps;
  readonly tags: TagOps;
  /** What git is in the middle of: named (view), detected (detect) and driven (continue/skip/abort). */
  readonly operation: OperationProvider;
  /** Whole-file conflict actions + the dashboard snapshot, in role terms. */
  readonly conflictOps: ConflictOps;

  constructor(opts: GitContextOptions) {
    this.root = opts.root;
    this.process = new GitProcess({
      cwd: opts.root,
      gitPath: opts.gitPath,
      maxConcurrent: opts.maxConcurrent,
      onRun: opts.onRun,
    });
    this.log = new LogProvider(this.process);
    this.commitDetails = new CommitDetailsProvider(this.process);
    this.refs = new RefProvider(this.process);
    this.blame = new BlameProvider(this.process);
    this.history = new HistoryProvider(this.process);
    this.conflict = new ConflictProvider(this.process);
    this.staging = new StagingProvider(this.process);
    this.status = new StatusProvider(this.process);
    this.snapshot = new SnapshotProvider(this.process);
    this.stashes = new StashProvider(this.process);
    this.worktrees = new WorktreeProvider(this.process);
    this.branches = new BranchOps(this.process);
    this.remotes = new RemoteOps(this.process);
    this.sync = new SyncOps(this.process);
    this.tags = new TagOps(this.process);
    // Construction runs no git. The rebase runner spawns git itself, so it is
    // told which binary to use and where to report each command (the same
    // hook the process pool reports to); a host can still override per call.
    this.operation = new OperationProvider(this.process, opts.root, {
      gitPath: opts.gitPath,
      onRun: opts.onRun,
    });
    this.conflictOps = new ConflictOps(
      this.process,
      opts.root,
      this.conflict,
      this.operation,
    );
  }

  dispose(): void {
    this.process.dispose();
  }
}
