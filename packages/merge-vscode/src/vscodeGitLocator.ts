// A RepoLocator over VS Code's built-in git extension (vscode.git API v1),
// for a product with no repository manager of its own (Merge Studio).
// GitStudio adapts its RepoManager instead.
//
// One git-service GitContext per open repository (the same data layer
// GitStudio and the desktop use), a debounced change event fed by vscode.git's
// state events AND by watchers on git's own operation files — resolved with
// `rev-parse --git-path`, so they work in a linked worktree (gitWatch.ts).

import * as vscode from "vscode";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { gitWatchTargets } from "./gitWatch";
import type { MergeRepo, RepoLocator } from "./product";

/** The slice of vscode.git's API this needs (typed structurally; no git.d.ts copy). */
interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  readonly state: { onDidChange: vscode.Event<void> };
  status?(): Promise<void>;
}
interface GitApiLike {
  readonly repositories: GitRepositoryLike[];
  readonly git: { path: string };
  onDidOpenRepository: vscode.Event<GitRepositoryLike>;
  onDidCloseRepository: vscode.Event<GitRepositoryLike>;
}
interface GitExtensionLike {
  readonly enabled: boolean;
  getAPI(version: 1): GitApiLike;
}

const DEBOUNCE_MS = 300;

interface Binding {
  repo: MergeRepo;
  disposables: vscode.Disposable[];
}

export class VscodeGitLocator implements RepoLocator, vscode.Disposable {
  /** Activate vscode.git and bind its repositories. Undefined when git is unavailable or disabled. */
  static async create(): Promise<VscodeGitLocator | undefined> {
    try {
      const ext = vscode.extensions.getExtension<GitExtensionLike>("vscode.git");
      if (!ext) {
        return undefined;
      }
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports.enabled) {
        return undefined;
      }
      return new VscodeGitLocator(exports.getAPI(1));
    } catch {
      return undefined;
    }
  }

  private readonly bindings = new Map<string, Binding>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(private readonly api: GitApiLike) {
    for (const repo of api.repositories) {
      this.add(repo);
    }
    this.disposables.push(
      api.onDidOpenRepository((repo) => this.add(repo)),
      api.onDidCloseRepository((repo) => this.remove(repo)),
      vscode.window.onDidChangeActiveTextEditor(() => this.fire()),
    );
  }

  all(): readonly MergeRepo[] {
    return Array.from(this.bindings.values(), (b) => b.repo);
  }

  forPath(fsPath: string): MergeRepo | undefined {
    return longestRootMatch(this.all(), fsPath);
  }

  active(): MergeRepo | undefined {
    const path = vscode.window.activeTextEditor?.document.uri.fsPath;
    return (path ? this.forPath(path) : undefined) ?? this.all()[0];
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.emitter.event(listener);
  }

  private add(gitRepo: GitRepositoryLike): void {
    const root = gitRepo.rootUri.fsPath;
    if (this.bindings.has(root)) {
      return;
    }
    const ctx = new GitContext({ root, gitPath: this.api.git.path || undefined });
    const repo: MergeRepo = {
      root,
      ctx,
      poke: () => gitRepo.status?.(),
    };
    const disposables: vscode.Disposable[] = [gitRepo.state.onDidChange(() => this.fire())];
    this.bindings.set(root, { repo, disposables });
    void this.watch(repo, disposables);
    this.fire();
  }

  private async watch(repo: MergeRepo, into: vscode.Disposable[]): Promise<void> {
    try {
      const t = await gitWatchTargets(repo.ctx.operation);
      const poke = () => {
        void repo.poke?.();
        this.fire();
      };
      for (const [dir, glob] of [
        [t.gitDir, t.opStateGlob],
        [t.commonDir, t.refsGlob],
      ] as const) {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), glob),
        );
        w.onDidCreate(poke);
        w.onDidChange(poke);
        w.onDidDelete(poke);
        into.push(w);
      }
    } catch {
      // Not a repository any more, or git is gone: vscode.git's events still fire.
    }
  }

  private remove(gitRepo: GitRepositoryLike): void {
    const root = gitRepo.rootUri.fsPath;
    const b = this.bindings.get(root);
    if (!b) {
      return;
    }
    this.bindings.delete(root);
    for (const d of b.disposables) {
      d.dispose();
    }
    b.repo.ctx.dispose();
    this.fire();
  }

  private fire(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire();
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const b of this.bindings.values()) {
      for (const d of b.disposables) {
        d.dispose();
      }
      b.repo.ctx.dispose();
    }
    this.bindings.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

/**
 * The repository whose root contains `fsPath` (longest root wins), comparing
 * on path boundaries, separator- and (on Windows / macOS) case-tolerantly.
 */
export function longestRootMatch<R extends { root: string }>(
  repos: readonly R[],
  fsPath: string,
  caseInsensitive = process.platform === "win32" || process.platform === "darwin",
): R | undefined {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? s.toLowerCase() : s;
  };
  const file = norm(fsPath);
  let best: R | undefined;
  for (const repo of repos) {
    const root = norm(repo.root);
    if (file === root || file.startsWith(`${root}/`)) {
      if (!best || repo.root.length > best.root.length) {
        best = repo;
      }
    }
  }
  return best;
}
