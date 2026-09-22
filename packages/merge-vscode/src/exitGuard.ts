// Files whose merge viewer the user explicitly exited ("get me out, I'll
// resolve this later"). Automatic routing — the active-editor route AND the
// built-in merge tab reroute — must not send them straight back into the merge
// editor. The suppression lifts once the file is no longer conflicted.
//
// Ported from Merge Studio (src/conflict/exitGuard.ts), where only the
// active-editor route consulted it: taking over VS Code's built-in merge tab
// ignored it, so choosing the built-in editor after exiting ours was undone
// the moment its tab opened (PLAN matrix row 3). Here both routes ask.
//
// Keyed by the document URI's string form. vscode-free, so the routing
// decision table is testable under plain node.

export class ExitGuard {
  private readonly exited = new Set<string>();

  /** The user left the viewer for this file; keep automatic routing away from it. */
  suppress(key: string): void {
    this.exited.add(key);
  }

  /** The conflict is gone (or the user explicitly reopened it): route normally again. */
  clear(key: string): void {
    this.exited.delete(key);
  }

  isSuppressed(key: string): boolean {
    return this.exited.has(key);
  }

  /** How many files are suppressed (for tests and diagnostics). */
  get size(): number {
    return this.exited.size;
  }
}
