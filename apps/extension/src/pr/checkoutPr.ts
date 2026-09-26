import * as vscode from "vscode";
import {
  divergedMessage,
  fetchPrHead,
  movePrBranch,
  planPrHead,
  type PrHeadPlan,
} from "@gitstudio/git-service/prCheckout";
import type { RepoEntry } from "../git/repoManager";
import type { PullRequest } from "./githubApi";
import type { GitHubRepoContext } from "./repoContext";
import { applyOrAsk, checkoutOp, type Applied } from "../git/inTheWay";
import { promptPick } from "../ui/dialogs";
import { saidCheckedOutElsewhere } from "../views/branchElsewhere";

// Check out a pull request's branch locally, as `pr/<n>`. The PR's head is
// fetched from the base repository's `refs/pull/<n>/head` (which works for
// cross-fork PRs too) WITHOUT writing any branch; git-service's planPrHead
// then decides what that means for the pr/<n> already there (see
// packages/git-service/src/prCheckout.ts): create it, fast-forward it — with a
// merge when it is the checked-out branch, which git's fetch refused — or, when
// it has commits the PR doesn't, ask before anything is moved. `--force` used
// to throw those commits away without a word.
//
// Every step that touches the working tree goes through the in-the-way door
// (Stash & Retry). The "Checked out" toast comes after the progress has
// ended: awaited inside it, the spinner ran until the toast was dismissed.

export async function checkoutPullRequest(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  onCheckedOut?: () => void,
): Promise<void> {
  const { entry, remoteName } = ctx;
  // The PR's own branch is already here: moving to a pr/<n> copy of it would
  // take the user off the branch they work on. Same repository only — a fork's
  // branch of the same name is a different branch.
  const current = await entry.ctx.process.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const sameRepo = pr.head.repoFullName !== null && pr.head.repoFullName === pr.base.repoFullName;
  if (sameRepo && current.code === 0 && current.stdout.trim() === pr.head.ref) {
    void vscode.window.showInformationMessage(
      `You're already on ${pr.head.ref}, the branch of PR #${pr.number}.`,
    );
    return;
  }

  // pr/<n> is checked out in another worktree: git refuses to move or check
  // it out there. Said where, before anything runs (no fetch).
  if (await saidCheckedOutElsewhere(entry.ctx, `refs/heads/pr/${pr.number}`, "checkout")) {
    return;
  }

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking out PR #${pr.number}…`,
      cancellable: true,
    },
    async (_progress, token): Promise<Outcome> => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const fetched = await fetchPrHead(entry.ctx.process, remoteName, pr.number, { signal: ac.signal });
      if ("error" in fetched) {
        return { kind: "error", message: `Couldn't fetch PR #${pr.number}: ${fetched.error}` };
      }
      return { kind: "planned", plan: await planPrHead(entry.ctx.process, pr.number, fetched.sha) };
    },
  );
  if (outcome.kind === "error") {
    void vscode.window.showErrorMessage(outcome.message);
    return;
  }

  const done = await apply(entry, pr, outcome.plan);
  if (!done) {
    return;
  }
  onCheckedOut?.();
  const open = await vscode.window.showInformationMessage(done, "Open Description");
  if (open === "Open Description") {
    // With its repository: the toast waits until clicked, and a number alone
    // is resolved against the repository active THEN — #7 of another one.
    void vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr, ctx });
  }
}

type Outcome = { kind: "error"; message: string } | { kind: "planned"; plan: PrHeadPlan };

/**
 * Bring pr/<n> to the plan and check it out. Returns the sentence to tell the
 * user, or undefined when there is nothing more to say (cancelled, or already
 * said).
 */
async function apply(entry: RepoEntry, pr: PullRequest, plan: PrHeadPlan): Promise<string | undefined> {
  const n = pr.number;
  const { local } = plan;
  switch (plan.kind) {
    case "elsewhere":
      // Checked out elsewhere since the look before the fetch: the same words
      // (and Open Worktree), or these if that worktree let it go meanwhile.
      if (!(await saidCheckedOutElsewhere(entry.ctx, `refs/heads/${local}`, "checkout"))) {
        void vscode.window.showWarningMessage(
          `${local} is checked out in another worktree (${plan.worktree}). Switch to it there, or check out a different branch in that worktree first.`,
        );
      }
      return undefined;

    case "create": {
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", "-b", local, plan.sha]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}.`;
    }

    case "current": {
      if (plan.checkedOut) {
        return `${local} is checked out and already matches PR #${n}.`;
      }
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}.`;
    }

    case "fast-forward": {
      if (plan.checkedOut) {
        // The branch is HEAD: its working tree moves with it, so this is a
        // fast-forward merge, through the door like any other.
        const applied = await applyOrAsk(entry.ctx, {
          kind: "merge",
          target: plan.sha,
          args: ["merge", "--ff-only", plan.sha],
        });
        return settled(applied, n) ? undefined : `Updated ${local} to the latest of PR #${n}.`;
      }
      const moved = await movePrBranch(entry.ctx.process, plan);
      if (moved.code !== 0) {
        void vscode.window.showErrorMessage(`Couldn't update ${local}: ${firstLine(moved.stderr)}`);
        return undefined;
      }
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}, updated to its latest.`;
    }

    case "diverged": {
      const choices = [
        {
          id: "keep",
          label: `Check Out ${local} As It Is`,
          icon: "git-branch",
          description: "Your commits stay. The PR's newer commits aren't brought in.",
        },
        ...(plan.checkedOut
          ? []
          : [
              {
                id: "replace",
                label: `Move ${local} to the PR's Version`,
                icon: "warning",
                danger: true,
                description: `${local}'s own commits stay only in the reflog.`,
              },
            ]),
        { id: "cancel", label: "Cancel", icon: "close", description: "Nothing changes." },
      ];
      const choice = await promptPick({
        title: `${local} has commits that PR #${n} doesn't`,
        hint: divergedMessage(n, plan),
        choices,
      });
      if (choice === "keep") {
        if (plan.checkedOut) {
          return undefined;
        }
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        return settled(applied, n) ? undefined : `Checked out ${local} as it was (not updated to PR #${n}).`;
      }
      if (choice === "replace") {
        const moved = await movePrBranch(entry.ctx.process, plan);
        if (moved.code !== 0) {
          void vscode.window.showErrorMessage(`Couldn't move ${local}: ${firstLine(moved.stderr)}`);
          return undefined;
        }
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}.`;
      }
      return undefined;
    }
  }
}

/** True when the door already said everything (cancelled, refused, failed). */
function settled(applied: Applied, n: number): boolean {
  if (applied.cancelled || applied.settled) {
    return true;
  }
  if (applied.result.code !== 0) {
    void vscode.window.showErrorMessage(
      `Couldn't check out PR #${n}: ${firstLine(applied.result.stderr)}`,
    );
    return true;
  }
  return false;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return line.trim();
}
