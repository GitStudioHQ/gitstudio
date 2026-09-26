import * as vscode from "vscode";
import type { PullRequest, PrFile } from "./githubApi";
import type { GitHubRepoContext } from "./repoContext";
import { toPrContentUri } from "./prContentProvider";

// Opens a PR's changed file as a side-by-side diff: the base blob (at
// base.sha, the previous filename for renames) on the left, the head blob (at
// head.sha) on the right. The `gitstudio-pr` content provider fetches both via
// the GitHub contents API; added/deleted files resolve to an empty pane on the
// missing side. Review mode makes both panes commentable: the right for the
// code as proposed, the left for the lines being removed (the only side a
// deleted file has).

/** The head-side URI for a PR file. */
export function prHeadUri(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  file: PrFile,
): vscode.Uri {
  return toPrContentUri({
    owner: ctx.owner,
    repo: ctx.repo,
    sha: pr.head.sha,
    path: file.filename,
  });
}

/** The base-side URI: the file as it was — under its OLD name, for a rename. */
export function prBaseUri(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  file: PrFile,
): vscode.Uri {
  return toPrContentUri({
    owner: ctx.owner,
    repo: ctx.repo,
    sha: pr.base.sha,
    path: file.previousFilename ?? file.filename,
  });
}

export async function openPrFileDiff(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  file: PrFile,
): Promise<void> {
  const title = file.previousFilename
    ? `${baseName(file.previousFilename)} → ${baseName(file.filename)} (PR #${pr.number})`
    : `${baseName(file.filename)} (PR #${pr.number})`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    prBaseUri(ctx, pr, file),
    prHeadUri(ctx, pr, file),
    title,
    {
      preview: true,
    } satisfies vscode.TextDocumentShowOptions,
  );
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}
