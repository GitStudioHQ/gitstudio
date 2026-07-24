import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GraphMenuItem } from "@gitstudio/host-bridge/graphProtocol";
import { ErrorReporter } from "../reporting/errorReporter";

/** The commit actions as plain items for the IN-GRAPH popover (no vscode types
 * / codicon markup) — the webview renders these; ids match runCommitAction. */
export function commitMenuItems(): GraphMenuItem[] {
  return [
    { id: "checkout", label: "Checkout Commit", icon: "git-commit" },
    { id: "branch", label: "Create Branch Here…", icon: "git-branch" },
    { id: "tag", label: "Create Tag Here…", icon: "tag" },
    { id: "cherryPick", label: "Cherry-Pick Commit", icon: "git-pull-request" },
    { id: "revert", label: "Revert Commit", icon: "history" },
    { id: "reset", label: "Reset Current Branch to Here…", icon: "discard", danger: true },
    { id: "interactiveRebase", label: "Start Interactive Rebase Here…", icon: "git-merge" },
    { id: "", label: "", sep: true },
    { id: "copySha", label: "Copy SHA", icon: "copy" },
    { id: "copyMessage", label: "Copy Message", icon: "copy" },
  ];
}

/**
 * The commit-graph context-menu actions. Each runs a real git command via the
 * GitContext process pool, confirms destructive operations clearly, and surfaces
 * git's stderr on failure. Returns true when the repo state likely changed
 * (so the caller can refresh the graph).
 *
 * The universal Undo envelope (M8) wraps the destructive actions: callers pass
 * an `undo` runner that snapshots the repo before the op and records an entry
 * for one-keystroke reversal (with a pushed-history → Revert safeguard). The
 * non-destructive actions (branch, tag, copy) run unwrapped.
 */

interface CommitContext {
  /** Full sha of the targeted commit. */
  readonly sha: string;
  /** Commit subject, for friendlier prompts/messages. */
  readonly subject: string;
}

/**
 * Wraps a destructive op so the Undo envelope can snapshot before / record
 * after. When no runner is supplied the op runs directly (so existing tests and
 * any caller without an UndoLedger keep working).
 */
export type UndoRunner = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

function withUndo<T>(
  undo: UndoRunner | undefined,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  return undo ? undo(label, fn) : fn();
}

export interface CommitActionItem extends vscode.QuickPickItem {
  id: string;
}

/** The action menu, in the order GitLens presents them. */
export function commitActionItems(): CommitActionItem[] {
  return [
    { id: "checkout", label: "$(git-commit) Checkout Commit" },
    { id: "branch", label: "$(git-branch) Create Branch Here…" },
    { id: "tag", label: "$(tag) Create Tag Here…" },
    { id: "cherryPick", label: "$(git-pull-request) Cherry-Pick Commit" },
    { id: "revert", label: "$(history) Revert Commit" },
    {
      id: "reset",
      label: "$(discard) Reset Current Branch to Here…",
    },
    {
      id: "interactiveRebase",
      label: "$(git-merge) Start Interactive Rebase Here…",
    },
    { id: "", label: "", kind: vscode.QuickPickItemKind.Separator },
    { id: "copySha", label: "$(copy) Copy SHA" },
    { id: "copyMessage", label: "$(copy) Copy Message" },
  ];
}

/**
 * Runs the chosen action. `ctx` is the active repo's GitContext; `commit`
 * carries the target sha + subject. Returns true if the graph should refresh.
 */
export async function runCommitAction(
  id: string,
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  switch (id) {
    case "checkout":
      return checkout(ctx, commit, undo);
    case "branch":
      return createBranch(ctx, commit);
    case "tag":
      return createTag(ctx, commit);
    case "cherryPick":
      return cherryPick(ctx, commit, undo);
    case "revert":
      return revert(ctx, commit, undo);
    case "reset":
      return resetTo(ctx, commit, undo);
    case "copySha":
      await vscode.env.clipboard.writeText(commit.sha);
      flash(`Copied ${short(commit.sha)}`);
      return false;
    case "copyMessage":
      await vscode.env.clipboard.writeText(commit.subject);
      flash("Copied commit message");
      return false;
    default:
      return false;
  }
}

// ── Individual actions ───────────────────────────────────────────────────────

async function checkout(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const ok = await confirm(
    `Checkout ${short(commit.sha)}? This leaves your working tree in a ` +
      `"detached HEAD" state (not on any branch).`,
    "Checkout",
  );
  if (!ok) {
    return false;
  }
  return withUndo(undo, `Checkout ${short(commit.sha)}`, () =>
    runGit(ctx, ["checkout", commit.sha], "Checked out"),
  );
}

async function createBranch(
  ctx: GitContext,
  commit: CommitContext,
): Promise<boolean> {
  const name = await vscode.window.showInputBox({
    title: `Create branch at ${short(commit.sha)}`,
    prompt: "New branch name",
    placeHolder: "feature/my-branch",
    validateInput: validateRefName,
  });
  if (!name) {
    return false;
  }
  return runGit(ctx, ["branch", name, commit.sha], `Created branch ${name}`);
}

async function createTag(
  ctx: GitContext,
  commit: CommitContext,
): Promise<boolean> {
  const name = await vscode.window.showInputBox({
    title: `Create tag at ${short(commit.sha)}`,
    prompt: "New tag name",
    placeHolder: "v1.0.0",
    validateInput: validateRefName,
  });
  if (!name) {
    return false;
  }
  return runGit(ctx, ["tag", name, commit.sha], `Created tag ${name}`);
}

async function cherryPick(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  return withUndo(undo, `Cherry-pick ${short(commit.sha)}`, async () => {
    const result = await ctx.process.run(["cherry-pick", commit.sha]);
    if (result.code === 0) {
      flash(`Cherry-picked ${short(commit.sha)}`);
      return true;
    }
    // Conflicts leave the cherry-pick in progress; tell the user how to proceed.
    const stderr = result.stderr.trim();
    if (/conflict/i.test(stderr) || /after resolving/i.test(stderr)) {
      void vscode.window.showWarningMessage(
        `Cherry-pick of ${short(commit.sha)} hit conflicts. Resolve them, ` +
          `then continue or abort the cherry-pick.`,
      );
    } else {
      showGitError("Cherry-pick failed", stderr);
    }
    return true;
  });
}

async function revert(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  return withUndo(undo, `Revert ${short(commit.sha)}`, async () => {
    const result = await ctx.process.run(["revert", "--no-edit", commit.sha]);
    if (result.code === 0) {
      flash(`Reverted ${short(commit.sha)}`);
      return true;
    }
    const stderr = result.stderr.trim();
    if (/conflict/i.test(stderr) || /after resolving/i.test(stderr)) {
      void vscode.window.showWarningMessage(
        `Revert of ${short(commit.sha)} hit conflicts. Resolve them, then ` +
          `continue or abort the revert.`,
      );
    } else {
      showGitError("Revert failed", stderr);
    }
    return true;
  });
}

async function resetTo(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "$(arrow-up) Soft",
        description: "--soft · keep working tree and index",
        value: "--soft",
      },
      {
        label: "$(list-flat) Mixed",
        description: "--mixed · keep working tree, reset index (default)",
        value: "--mixed",
      },
      {
        label: "$(warning) Hard",
        description: "--hard · DISCARD all working-tree and index changes",
        value: "--hard",
      },
    ],
    {
      title: `Reset current branch to ${short(commit.sha)}`,
      placeHolder: "Choose how much to reset",
    },
  );
  if (!mode) {
    return false;
  }

  if (mode.value === "--hard") {
    const ok = await confirmDestructive(
      `Hard reset to ${short(commit.sha)} will permanently DISCARD all ` +
        `uncommitted changes and move the current branch. This cannot be ` +
        `undone. Continue?`,
      "Reset --hard",
    );
    if (!ok) {
      return false;
    }
  } else {
    const ok = await confirm(
      `Reset current branch to ${short(commit.sha)} (${mode.value})?`,
      "Reset",
    );
    if (!ok) {
      return false;
    }
  }
  return withUndo(undo, `Reset to ${short(commit.sha)} (${mode.value})`, () =>
    runGit(
      ctx,
      ["reset", mode.value, commit.sha],
      `Reset to ${short(commit.sha)}`,
    ),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runGit(
  ctx: GitContext,
  args: string[],
  successMessage: string,
): Promise<boolean> {
  const result = await ctx.process.run(args);
  if (result.code === 0) {
    flash(successMessage);
    return true;
  }
  showGitError(`git ${args[0]} failed`, result.stderr.trim());
  return true;
}

function showGitError(title: string, stderr: string): void {
  void vscode.window.showErrorMessage(
    stderr ? `${title}: ${stderr}` : title,
  );
  // Anonymous, scrubbed crash report so we hear about failures during beta
  // (no-op if the user turned reporting off or VS Code telemetry is off).
  ErrorReporter.current?.captureGitError(title, stderr);
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}

async function confirm(message: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return choice === action;
}

/** A two-modal gate for irreversible operations. */
async function confirmDestructive(
  message: string,
  action: string,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return choice === action;
}

function validateRefName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Name cannot be empty";
  }
  // git check-ref-format rules, the common subset.
  if (
    /[ ~^:?*\[\\]/.test(name) ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  ) {
    return "Invalid character in ref name";
  }
  return undefined;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
