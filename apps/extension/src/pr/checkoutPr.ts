import * as vscode from "vscode";
import type { RepoEntry } from "../git/repoManager";
import type { PullRequest } from "./githubApi";

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

      // Check it out.
      const checkout = await run(["checkout", local]);
      if (checkout.code !== 0) {
        const msg = firstLine(checkout.stderr);
        if (/local changes|overwritten|would be overwritten/i.test(msg)) {
          void vscode.window.showErrorMessage(
            `Can't switch to PR #${pr.number}: you have uncommitted changes. Commit or stash them first.`,
          );
        } else {
          void vscode.window.showErrorMessage(
            `Couldn't check out PR #${pr.number}: ${msg}`,
          );
        }
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
