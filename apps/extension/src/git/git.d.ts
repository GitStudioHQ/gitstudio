// Trimmed subset of the built-in `vscode.git` extension API surface we use.
// Mirrors microsoft/vscode extensions/git/src/api/git.d.ts (the public API @ v1).
import { Uri, Event } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export type APIState = "uninitialized" | "initialized";

/** The discovered git binary; `git.path` is what we hand to GitContext. */
export interface Git {
  readonly path: string;
}

export interface API {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly git: Git;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
}

export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: Status;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { name: string; remote: string };
  /** Commits ahead of the upstream (provided by the built-in Git API). */
  readonly ahead?: number;
  /** Commits behind the upstream (provided by the built-in Git API). */
  readonly behind?: number;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  /** Populated instead of workingTreeChanges for new files when the user sets
   *  git.untrackedChanges = "separate" (absent on older vscode.git builds). */
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;

  /** Runs `git show <ref>:<path>`. Stage refs: `:1` base, `:2` ours, `:3` theirs. */
  show(ref: string, path: string): Promise<string>;

  /**
   * Stages paths (equivalent to `git add`), which clears merge stages 1/2/3.
   * NOTE: the real vscode.git API takes fsPath STRINGS here, not Uris —
   * passing Uris fails at runtime inside the git extension.
   */
  add(paths: string[]): Promise<void>;

  /**
   * Forces a status re-scan. Present on the real vscode.git Repository (API
   * v1); optional here so a missing implementation degrades gracefully.
   */
  status?(): Promise<void>;
}
