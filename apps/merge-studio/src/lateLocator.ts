// A RepoLocator that exists before the real one does.
//
// Merge Studio finds repositories through VS Code's built-in git extension,
// which has to activate first. Waiting for it inside activate() would leave
// every command unregistered ("command not found") for as long as vscode.git
// takes, and nothing at all if git is unavailable. So the experience is
// registered at once over this locator — empty, but live — and the real
// locator is bound when it is ready; binding fires a change, which makes the
// experience scan.
//
// vscode-free (RepoLocator is plain data + a listener), so it is unit-tested.

import type { MergeRepo, RepoLocator } from "@gitstudio/merge-vscode/product";

export class LateLocator implements RepoLocator {
  private inner: RepoLocator | undefined;
  private innerSubscription: { dispose(): void } | undefined;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  /** Whether the real locator is bound yet. */
  get bound(): boolean {
    return this.inner !== undefined;
  }

  /** Bind the real locator (once); listeners hear about it straight away. */
  bind(inner: RepoLocator): void {
    if (this.disposed || this.inner) {
      return;
    }
    this.inner = inner;
    this.innerSubscription = inner.onDidChange(() => this.fire());
    this.fire();
  }

  all(): readonly MergeRepo[] {
    return this.inner?.all() ?? [];
  }

  forPath(fsPath: string): MergeRepo | undefined {
    return this.inner?.forPath(fsPath);
  }

  active(): MergeRepo | undefined {
    return this.inner?.active();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    this.innerSubscription?.dispose();
    this.innerSubscription = undefined;
    this.inner = undefined;
    this.listeners.clear();
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One listener's failure never starves the others.
      }
    }
  }
}
