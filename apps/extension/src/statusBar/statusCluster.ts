import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { terminalIcon, terminalLabel, terminalTooltip } from "./terminalBadge";

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
    // The same glyph gitstudio.showCommitGraph already declares. It was
    // $(git-merge), which is both inconsistent with that command and simply
    // wrong: a merge arrow means merging, not history.
    graph.text = "$(git-commit)";
    graph.command = "gitstudio.showCommitGraph";
    graph.tooltip = "GitStudio: Commit Graph";

    const terminal = this.items.get("terminal")!;
    terminal.command = "gitstudio.openTerminal";
    this.paintTerminal();

    this.disposables.push(
      vscode.commands.registerCommand("gitstudio.openTerminal", () =>
        this.openTerminal(),
      ),
      this.repos.onDidChange(() => this.scheduleUpdate()),
      // The count has to follow the terminals themselves, not the repo — opening
      // or closing one is exactly when the button is wrong.
      vscode.window.onDidOpenTerminal(() => this.paintTerminal()),
      vscode.window.onDidCloseTerminal(() => this.paintTerminal()),
      vscode.window.onDidChangeActiveTerminal(() => this.paintTerminal()),
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

    // The two segments depend only on there being a repo.
    for (const id of ["graph", "terminal"] as const) {
      const item = this.items.get(id)!;
      if (this.enabled(id)) item.show();
      else item.hide();
    }
    this.paintTerminal();

    void token;
  }

  /** Whether a click would HIDE rather than show — our terminal is the focused one. */
  private wouldHide(): boolean {
    const active = vscode.window.activeTerminal;
    return !!active && active.name === this.terminalName();
  }

  /** The name of this repository's GitStudio terminal. */
  private terminalName(): string {
    const active = this.repos.getActive();
    const leaf = active?.root.split(/[\\/]/).pop() ?? "repo";
    return `GitStudio: ${leaf}`;
  }

  /** Repaints the terminal button's icon, count and hover. */
  private paintTerminal(): void {
    const item = this.items.get("terminal");
    if (!item) return;
    const terminals = vscode.window.terminals;
    item.text = terminalLabel(terminalIcon(), terminals.length);
    item.tooltip = terminalTooltip(
      terminals.map((t) => t.name),
      this.wouldHide(),
    );
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
    const name = this.terminalName();
    const existing = vscode.window.terminals.find((t) => t.name === name);

    // A real toggle, and the reason it works: the ambiguous case is "is the
    // panel visible?", which no extension API answers — the extension this is
    // modelled on documents that limitation and tells you to click twice. But
    // the question that actually matters is answerable: is OUR terminal the
    // focused one? If it is, the user is looking at it and means "put it away",
    // which the built-in toggle does correctly. Any other state means "bring it
    // here", which is unambiguous.
    if (existing && this.wouldHide()) {
      // Guarded: executeCommand REJECTS for an unknown command, and an
      // unhandled rejection here would be filed as a crash report for what is
      // just a host that names this differently. The panel toggle is the
      // fallback and does the same job one level up.
      void vscode.commands
        .executeCommand("workbench.action.terminal.toggleTerminal")
        .then(undefined, () =>
          vscode.commands.executeCommand("workbench.action.togglePanel"),
        );
      return;
    }

    const terminal =
      existing ?? vscode.window.createTerminal({ name, cwd: active.root });
    terminal.show();
    this.paintTerminal();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.items.clear();
  }
}
