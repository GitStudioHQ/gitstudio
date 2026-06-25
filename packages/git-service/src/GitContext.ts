import { GitProcess } from "./GitProcess";
import { LogProvider } from "./LogProvider";
import { RefProvider } from "./RefProvider";
import { BlameProvider } from "./BlameProvider";
import { HistoryProvider } from "./HistoryProvider";
import { ConflictProvider } from "./ConflictProvider";
import { StagingProvider } from "./StagingProvider";
import { SnapshotProvider } from "./SnapshotProvider";
import { StashProvider } from "./StashProvider";
import { WorktreeProvider } from "./WorktreeProvider";
import { BranchOps } from "./BranchOps";
import { RemoteOps } from "./RemoteOps";
import { SyncOps } from "./SyncOps";
import { TagOps } from "./TagOps";

export interface GitContextOptions {
  /** Absolute path to the repo root. */
  root: string;
  /** Path to the git binary; defaults to "git". */
  gitPath?: string;
  /** Maximum number of concurrent git processes; defaults to 5. */
  maxConcurrent?: number;
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
  readonly refs: RefProvider;
  readonly blame: BlameProvider;
  readonly history: HistoryProvider;
  readonly conflict: ConflictProvider;
  readonly staging: StagingProvider;
  readonly snapshot: SnapshotProvider;
  readonly stashes: StashProvider;
  readonly worktrees: WorktreeProvider;
  readonly branches: BranchOps;
  readonly remotes: RemoteOps;
  readonly sync: SyncOps;
  readonly tags: TagOps;

  constructor(opts: GitContextOptions) {
    this.root = opts.root;
    this.process = new GitProcess({
      cwd: opts.root,
      gitPath: opts.gitPath,
      maxConcurrent: opts.maxConcurrent,
    });
    this.log = new LogProvider(this.process);
    this.refs = new RefProvider(this.process);
    this.blame = new BlameProvider(this.process);
    this.history = new HistoryProvider(this.process);
    this.conflict = new ConflictProvider(this.process);
    this.staging = new StagingProvider(this.process);
    this.snapshot = new SnapshotProvider(this.process);
    this.stashes = new StashProvider(this.process);
    this.worktrees = new WorktreeProvider(this.process);
    this.branches = new BranchOps(this.process);
    this.remotes = new RemoteOps(this.process);
    this.sync = new SyncOps(this.process);
    this.tags = new TagOps(this.process);
  }

  dispose(): void {
    this.process.dispose();
  }
}
