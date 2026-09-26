import * as vscode from "vscode";
import type { GitHubApi, PullRequest, PrFile } from "./githubApi";
import type { GitHubRepoContext } from "./repoContext";
import { toPrContentUri } from "./prContentProvider";

// Opens a PR's changed file as a side-by-side diff: the base blob on the left
// (the previous filename for renames), the head blob (at head.sha) on the
// right. The `gitstudio-pr` content provider fetches both via the GitHub
// contents API; added/deleted files resolve to an empty pane on the missing
// side. Review mode makes both panes commentable: the right for the code as
// proposed, the left for the lines being removed (the only side a deleted
// file has).
//
// THE LEFT SIDE IS THE MERGE BASE, not `base.sha`. GitHub's patch for a PR is
// the three-dot diff: its hunks — which decide where a comment can go — and a
// LEFT comment's line number count lines in the merge base of base and head.
// base.sha is the base branch's tip, which moves on as others merge: drawn
// there, the hunks sat on the wrong lines, a LEFT comment was sent with a
// number GitHub reads against other content, and the base branch's own new
// work showed as if the PR removed it.

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

/**
 * The base-side URI: the file as it was at `baseSha` (the merge base — see
 * `diffBase`) — under its OLD name, for a rename.
 */
export function prBaseUri(
  ctx: GitHubRepoContext,
  file: PrFile,
  baseSha: string,
): vscode.Uri {
  return toPrContentUri({
    owner: ctx.owner,
    repo: ctx.repo,
    sha: baseSha,
    path: file.previousFilename ?? file.filename,
  });
}

/**
 * The commit a PR's diff is drawn from: the merge base of its base and head,
 * as GitHub counts its patch. When GitHub can't say (offline, a head it no
 * longer has), `base.sha` — right until the base branch moves on.
 */
export async function diffBase(
  api: GitHubApi,
  ctx: GitHubRepoContext,
  pr: PullRequest,
): Promise<string> {
  const sha = await api
    .mergeBase(ctx.owner, ctx.repo, pr.base.sha, pr.head.sha)
    .catch(() => undefined);
  return sha ?? pr.base.sha;
}

export async function openPrFileDiff(
  ctx: GitHubRepoContext,
  pr: PullRequest,
  file: PrFile,
  baseSha: string,
): Promise<void> {
  const title = file.previousFilename
    ? `${baseName(file.previousFilename)} → ${baseName(file.filename)} (PR #${pr.number})`
    : `${baseName(file.filename)} (PR #${pr.number})`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    prBaseUri(ctx, file, baseSha),
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
