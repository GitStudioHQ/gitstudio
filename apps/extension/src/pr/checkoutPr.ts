import * as vscode from "vscode";
import type { RepoEntry } from "../git/repoManager";
import type { PullRequest } from "./githubApi";
import { applyOrAsk, checkoutOp } from "../git/inTheWay";

// Check out a pull request's branch locally. We fetch the universal
// `pull/<n>/head` ref (which works for cross-fork PRs too) into a local
// `pr/<n>` branch, then check it out. The remote here is the configured one
// (usually "origin"). Conflicts / dirty-tree errors surface as a friendly
// message; on success we offer to open the PR description.

export async function checkoutPullRequest(
  entry: RepoEntry,
  remoteName: string,
  pr: PullRequest,
  onCheckedOut?: () => void,
): Promise<void> {
  const local = `pr/${pr.number}`;
  const fetchSpec = `pull/${pr.number}/head:${local}`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking out PR #${pr.number}…`,
    },
    async (_progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const run = (args: string[]) =>
        entry.ctx.process.run(args, { signal: ac.signal });

      // Fetch the PR head into pr/<n> (force-update so a re-checkout refreshes).
      const fetch = await run([
        "fetch",
        remoteName,
        "--force",
        fetchSpec,
      ]);
      if (fetch.code !== 0) {
        void vscode.window.showErrorMessage(
          `Couldn't fetch PR #${pr.number}: ${firstLine(fetch.stderr)}`,
        );
        return;
      }

      // Check it out — through the shared door, which recognises uncommitted
      // work in the way from git's state (this used to match git's English,
      // "local changes|overwritten", which a localised git never says) and
      // offers Stash & Retry.
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      if (applied.cancelled || applied.settled) {
        return;
      }
      if (applied.result.code !== 0) {
        void vscode.window.showErrorMessage(
          `Couldn't check out PR #${pr.number}: ${firstLine(applied.result.stderr)}`,
        );
        return;
      }

      onCheckedOut?.();

      const open = await vscode.window.showInformationMessage(
        `Checked out PR #${pr.number} as ${local}.`,
        "Open Description",
      );
      if (open === "Open Description") {
        void vscode.commands.executeCommand("gitstudio.pr.openDescription", {
          pr,
        });
      }
    },
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return line.trim();
}
