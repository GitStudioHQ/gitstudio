import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";

/**
 * The GitStudio status-bar cluster: small, single-purpose segments that each go
 * straight where they belong.
 *
 * Two buttons, and deliberately no counters.
 *
 * There were counters here — changed files and stashes — and they were the wrong
 * thing twice over. The file count belongs to the branch, so it lives on
 * SyncStatusItem as a dirty marker rather than as a segment of its own. The
 * stash count belongs nowhere near the status bar: there is an entire sidebar
 * view for stashes, and a number that duplicates it costs width to tell you
 * something you were not asking.
 *
 * What is left are two routes that genuinely have no other one-click home.
 */

const UPDATE_DEBOUNCE_MS = 500;

/** Each segment, its setting key, and where it sits relative to sync (-5). */
const SEGMENTS = {
  graph: { setting: "showGraph", priority: -8 },
  terminal: { setting: "showTerminal", priority: -9 },
} as const;

type SegmentId = keyof typeof SEGMENTS;

export class StatusCluster implements vscode.Disposable {
  private readonly items = new Map<SegmentId, vscode.StatusBarItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped per update. Two repos can be switched between faster than git
   * answers, and the loser must not paint — the stale-write bug this codebase
   * keeps meeting.
   */
  private token = 0;

  constructor(private readonly repos: RepoManager) {
    for (const [id, spec] of Object.entries(SEGMENTS) as [SegmentId, (typeof SEGMENTS)[SegmentId]][]) {
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        spec.priority,
      );
      this.items.set(id, item);
      this.disposables.push(item);
    }

    // The two that never change content are configured once.
    const graph = this.items.get("graph")!;
    graph.text = "$(git-merge)";
    graph.command = "gitstudio.showCommitGraph";
    graph.tooltip = "GitStudio: Commit Graph";

    const terminal = this.items.get("terminal")!;
    terminal.text = "$(terminal)";
    terminal.command = "gitstudio.openTerminal";
    terminal.tooltip = "GitStudio: Terminal at the repository root";

    this.disposables.push(
      vscode.commands.registerCommand("gitstudio.openTerminal", () =>
        this.openTerminal(),
      ),
      this.repos.onDidChange(() => this.scheduleUpdate()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("gitstudio.statusBar")) {
          this.scheduleUpdate();
        }
      }),
    );

    this.scheduleUpdate();
  }

  /** Recomputes after writes elsewhere (a commit, a stage, a stash). */
  refresh(): void {
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, UPDATE_DEBOUNCE_MS);
  }

  private enabled(id: SegmentId): boolean {
    return vscode.workspace
      .getConfiguration("gitstudio.statusBar")
      .get<boolean>(SEGMENTS[id].setting, true);
  }

  private async update(): Promise<void> {
    const token = ++this.token;
    const active = this.repos.getActive();
    if (!active) {
      for (const item of this.items.values()) item.hide();
      return;
    }

    // The two static segments depend only on there being a repo.
    for (const id of ["graph", "terminal"] as const) {
      const item = this.items.get(id)!;
      if (this.enabled(id)) item.show();
      else item.hide();
    }

    void token;
  }

  /**
   * A terminal already sitting in the active repository's root.
   *
   * The point is the `cwd`. VS Code's own terminal opens in the workspace root,
   * which is the wrong directory in any multi-root or monorepo setup — exactly
   * where someone reaches for a terminal to run git by hand. An existing
   * GitStudio terminal for that root is reused rather than stacking duplicates.
   */
  private openTerminal(): void {
    const active = this.repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage("GitStudio: no repository is open.");
      return;
    }
    const name = `GitStudio: ${active.root.split(/[\\/]/).pop() ?? "repo"}`;
    const existing = vscode.window.terminals.find((t) => t.name === name);
    const terminal = existing ?? vscode.window.createTerminal({ name, cwd: active.root });
    terminal.show();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.items.clear();
  }
}
