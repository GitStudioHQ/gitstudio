import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { UndoLedger } from "../undo/undoLedger";

// Launching & aborting interactive rebases.
//
// Launch mechanism (the GitLens-style approach, simplified for M8):
//   We spawn the rebase in an integrated terminal with
//   GIT_SEQUENCE_EDITOR='code --wait' so git opens the generated
//   `git-rebase-todo` in this VS Code window. Our CustomTextEditorProvider
//   (priority "default", filenamePattern "**/git-rebase-todo") then renders it
//   as the interactive-rebase webview. When the user presses Start, the editor
//   writes the reordered todo and saves; `code --wait` returns and git replays
//   the plan. We wrap the launch in runWithUndo so the pre-rebase HEAD is one
//   keystroke from restorable, and surface conflicts (the existing auto-open
//   routes conflicted files into the merge editor).
//
// We use a terminal rather than a spawned child because `code --wait` must be
// able to talk back to *this* window, and a terminal inherits the user's PATH
// where the `code` CLI lives.

/**
 * `gitstudio.startInteractiveRebase` — start `git rebase -i <base>` where the
 * base defaults to the parent of `sha` (rebase the commit and everything after
 * it). When called without a sha (palette), prompt for an upstream ref.
 */
export async function startInteractiveRebase(
  repos: RepoManager,
  undo: UndoLedger,
  sha?: string,
): Promise<void> {
  const active = repos.getActive();
  if (!active) {
    void vscode.window.showInformationMessage("No active repository.");
    return;
  }

  if (await isRebaseInProgress(active.ctx)) {
    void vscode.window.showWarningMessage(
      "A rebase is already in progress. Continue or abort it first.",
    );
    return;
  }

  if (await isDirty(active.ctx)) {
    const proceed = await vscode.window.showWarningMessage(
      "You have uncommitted changes. Interactive rebase works best on a clean " +
        "tree — commit or stash first. GitStudio will snapshot your work so you " +
        "can Undo, but git may refuse to start.",
      { modal: true },
      "Continue Anyway",
    );
    if (proceed !== "Continue Anyway") {
      return;
    }
  }

  const base = await resolveBase(active, sha);
  if (!base) {
    return;
  }

  // Snapshot before launching so Undo can restore the pre-rebase state. The
  // terminal launch is fire-and-forget (we can't await the terminal), so we
  // record the snapshot immediately; the user's Undo resets HEAD to it.
  await undo.runWithUndo(active, `Interactive rebase onto ${short(base)}`, async () => {
    launchRebaseTerminal(active, base);
  });
}

/** `gitstudio.abortRebase` — `git rebase --abort`. */
export async function abortRebase(repos: RepoManager): Promise<void> {
  const active = repos.getActive();
  if (!active) {
    void vscode.window.showInformationMessage("No active repository.");
    return;
  }
  const result = await active.ctx.process.run(["rebase", "--abort"]);
  if (result.code === 0) {
    void vscode.window.setStatusBarMessage(
      "$(discard) Rebase aborted",
      2500,
    );
  } else {
    const stderr = result.stderr.trim();
    void vscode.window.showErrorMessage(
      stderr ? `Abort rebase failed: ${stderr}` : "No rebase in progress.",
    );
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Resolve the rebase base. With a sha, default to `<sha>^` (its parent) so the
 * commit itself is included in the todo; for a root commit (no parent) use
 * `--root`. Without a sha, prompt for an upstream ref.
 */
async function resolveBase(
  active: RepoEntry,
  sha?: string,
): Promise<string | undefined> {
  if (!sha) {
    const ref = await vscode.window.showInputBox({
      title: "Interactive rebase",
      prompt: "Rebase onto which commit/branch? (the base, exclusive)",
      placeHolder: "e.g. HEAD~5, main, origin/main",
    });
    return ref?.trim() || undefined;
  }
  // Does the commit have a parent?
  const parent = await active.ctx.process.run([
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^`,
  ]);
  if (parent.code === 0) {
    return `${sha}^`;
  }
  // Root commit — rebase --root rewrites the whole history including it.
  return "--root";
}

function launchRebaseTerminal(active: RepoEntry, base: string): void {
  const terminal = vscode.window.createTerminal({
    name: "GitStudio: Interactive Rebase",
    cwd: active.root,
    env: {
      // `code --wait` opens the todo in this window and blocks until it's
      // closed; our customEditor (priority default) renders it.
      GIT_SEQUENCE_EDITOR: "code --wait",
      // Keep the commit-message editor sane too (reword/squash), so it doesn't
      // fall back to vi inside the terminal.
      GIT_EDITOR: "code --wait",
    },
  });
  const baseArg = base === "--root" ? "--root" : base;
  terminal.show(true);
  // -i forces the sequence editor; the trailing message nudges the user.
  terminal.sendText(`git rebase -i ${baseArg}`, true);
}

async function isRebaseInProgress(ctx: GitContext): Promise<boolean> {
  // rebase-merge (interactive) or rebase-apply (am) dir present under .git.
  const result = await ctx.process.run([
    "rev-parse",
    "--git-path",
    "rebase-merge",
  ]);
  if (result.code !== 0) {
    return false;
  }
  // `git rev-parse --git-path` prints the path whether or not it exists; test
  // existence via `status` instead (cheap and robust).
  const status = await ctx.process.run(["status"]);
  return /rebase in progress|interactive rebase in progress/i.test(
    status.stdout,
  );
}

async function isDirty(ctx: GitContext): Promise<boolean> {
  const result = await ctx.process.run(["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

function short(ref: string): string {
  return ref.length === 40 ? ref.slice(0, 7) : ref;
}
