import * as vscode from "vscode";
import { failed, NO_REPOSITORY, notice, notifyInfo } from "../ui/notify";
import { promptConfirm } from "../ui/dialogs";
import { promptRevision } from "../ui/refPrompt";
import type { GitContext } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { UndoLedger } from "../undo/undoLedger";
import { operationInProgressMessage } from "../git/pausedForUser";
import { detectOperation } from "../git/pauseNotice";
import { abortRebaseLike, nothingToAbortText } from "./rebaseAbort";
import { describeRebaseBase } from "./rebaseBase";
import * as l10n from "@vscode/l10n";

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
    void vscode.window.showInformationMessage(NO_REPOSITORY);
    return;
  }

  const blocked = operationInProgressMessage(await detectOperation(active.ctx));
  if (blocked) {
    void vscode.window.showWarningMessage(notice(blocked));
    return;
  }

  if (await isDirty(active.ctx)) {
    const proceed = await promptConfirm({
      title: l10n.t("You have uncommitted changes"),
      message:
        l10n.t("Interactive rebase works best on a clean tree — commit or stash first. GitStudio snapshots your work so Undo can recover it, but git may simply refuse to start."),
      confirmLabel: l10n.t("Continue Anyway"),
      danger: true,
    });
    if (!proceed) {
      return;
    }
  }

  const base = await resolveBase(active, sha);
  if (!base) {
    return;
  }

  // Snapshot before launching so Undo can restore the pre-rebase state. The
  // terminal launch is fire-and-forget (we can't await the terminal), so the
  // entry is recorded now as DEFERRED: Undo reads what the rebase went on to
  // change from the branches' reflogs — a move "onto <base>" — so a rebase
  // the user quit changes nothing, and a commit made since is never thrown
  // away as if the rebase had made it. Paused mid-way, Undo abandons it.
  const onto =
    base.startsWith("-")
      ? undefined
      : await active.ctx.process
          .run(["rev-parse", "--verify", "--quiet", `${base}^{commit}`])
          .then((r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined))
          .catch(() => undefined);
  await undo.runWithUndo(
    active,
    l10n.t("Interactive rebase onto {0}", describeRebaseBase(base)),
    async () => {
      launchRebaseTerminal(active, base);
    },
    { deferred: onto ? { onto } : {} },
  );
}

/**
 * `gitstudio.abortRebase` — through the shared operation core (rebaseAbort.ts):
 * a rebase ends with `rebase --abort`, a `git am` stopped in the same
 * rebase-apply/ directory with `am --abort`. It ran `rebase --abort` for both,
 * which git refuses during am.
 */
export async function abortRebase(repos: RepoManager): Promise<void> {
  const active = repos.getActive();
  if (!active) {
    void vscode.window.showInformationMessage(NO_REPOSITORY);
    return;
  }
  const result = await abortRebaseLike(active.ctx.operation);
  if (!result.ran) {
    void notifyInfo(nothingToAbortText(result.kind));
    return;
  }
  if (result.outcome.ok) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(discard) {0}", result.kind === "am" ? l10n.t("Patch series abandoned") : l10n.t("Rebase aborted")),
      2500,
    );
  } else {
    void vscode.window.showErrorMessage(
      failed(result.kind === "am" ? l10n.t("Abort (git am)") : l10n.t("Abort rebase"), result.outcome.message ?? l10n.t("git refused")),
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
    return promptRevision(active, {
      title: l10n.t("Interactive rebase"),
      hint: l10n.t("Rebase onto which commit or branch? The base itself is excluded — everything after it becomes the todo."),
      placeholder: l10n.t("HEAD~5   main   origin/main"),
      confirmLabel: l10n.t("Start Rebase"),
    });
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
    name: l10n.t("GitStudio: Interactive Rebase"),
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

async function isDirty(ctx: GitContext): Promise<boolean> {
  const result = await ctx.process.run(["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}
