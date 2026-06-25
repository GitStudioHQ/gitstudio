import { GitProcess } from "./GitProcess";
import { LogProvider } from "./LogProvider";
import { RefProvider } from "./RefProvider";

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
 * pool plus the streaming log and ref providers. One per open repo.
 */
export class GitContext {
  readonly root: string;
  readonly process: GitProcess;
  readonly log: LogProvider;
  readonly refs: RefProvider;

  constructor(opts: GitContextOptions) {
    this.root = opts.root;
    this.process = new GitProcess({
      cwd: opts.root,
      gitPath: opts.gitPath,
      maxConcurrent: opts.maxConcurrent,
    });
    this.log = new LogProvider(this.process);
    this.refs = new RefProvider(this.process);
  }

  dispose(): void {
    this.process.dispose();
  }
}
