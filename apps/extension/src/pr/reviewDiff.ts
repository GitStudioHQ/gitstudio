import * as vscode from "vscode";
import type { PullRequest, PrFile } from "./githubApi";
import type { GitHubRepoContext } from "./repoContext";
import { toPrContentUri } from "./prContentProvider";

// Opens a PR's changed file as a side-by-side diff: the base blob (at
// base.sha, the previous filename for renames) on the left, the head blob (at
// head.sha) on the right. The `gitstudio-pr` content provider fetches both via
// the GitHub contents API; added/deleted files resolve to an empty pane on the
// missing side. The right-hand head URI is what the review-mode commenting
// range provider attaches to, so comments map to RIGHT-side lines.

/** The head-side URI for a PR file (where inline review comments live). */
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

export async function openPrFileDiff(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  file: PrFile,
): Promise<void> {
  const basePath = file.previousFilename ?? file.filename;
  const left = toPrContentUri({
    owner: ctx.owner,
    repo: ctx.repo,
    sha: pr.base.sha,
    path: basePath,
  });
  const right = prHeadUri(ctx, pr, file);
  const title = `${baseName(file.filename)} (PR #${pr.number})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  } satisfies vscode.TextDocumentShowOptions);
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}
