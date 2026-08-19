import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { changesLabel, changesTooltip } from "./changesLabel";

/**
 * The GitStudio status-bar cluster: small, single-purpose segments that each go
 * straight where they belong.
 *
 * SyncStatusItem next door owns branch and ahead/behind, because that is one
 * thought — "where am I relative to the remote". These are the other things a
 * git client should be able to tell you at a glance without opening anything:
 * how much is changed, how much is stashed, and one-click routes to the graph
 * and a terminal already sitting in the repository.
 *
 * Separate items rather than one rich one, deliberately. A single segment can
 * only have one click target, so every extra thing it reports becomes a thing
 * you must hover to reach. Segments cost a little width and buy a direct route
 * to each destination — and each can be switched off by anyone who disagrees.
 */

const UPDATE_DEBOUNCE_MS = 500;

/** Each segment, its setting key, and where it sits relative to sync (-5). */
const SEGMENTS = {
  changes: { setting: "showChanges", priority: -6 },
  stashes: { setting: "showStashes", priority: -7 },
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

    const [status, stashes] = await Promise.all([
      active.ctx.status.read().catch(() => undefined),
      active.ctx.stashes.list().catch(() => []),
    ]);
    if (token !== this.token) return; // a newer update won

    const changes = this.items.get("changes")!;
    if (status && this.enabled("changes")) {
      const staged = status.staged.length;
      const unstaged = status.unstaged.length;
      // A clean tree is worth saying, briefly — an empty segment would read as
      // "this is broken" rather than "there is nothing to report".
      changes.text = changesLabel(staged, unstaged);
      changes.tooltip = changesTooltip(staged, unstaged);
      changes.command = "gitstudio.commit.focus";
      changes.show();
    } else {
      changes.hide();
    }

    const stash = this.items.get("stashes")!;
    // Hidden at zero on purpose: an empty stash list is the normal state, and a
    // permanent "0" is noise in a bar where width is the scarce resource.
    if (stashes.length > 0 && this.enabled("stashes")) {
      stash.text = `$(archive) ${stashes.length}`;
      stash.tooltip = `GitStudio: ${stashes.length} stash${stashes.length === 1 ? "" : "es"}`;
      stash.command = "gitstudio.stashes.focus";
      stash.show();
    } else {
      stash.hide();
    }
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
