import * as vscode from "vscode";
import type { GitHubApi, PullRequest, PrFile } from "./githubApi";
import { toPrContentUri } from "./prContentProvider";

// Opens a PR's changed file as a side-by-side diff: the base blob on the left
// (the previous filename for renames), the head blob (at the head sha) on the
// right. The `gitstudio-pr` content provider fetches both via the GitHub
// contents API; added/deleted files resolve to an empty pane on the missing
// side. Review (reviewMode.ts) makes both panes commentable: the right for
// the code as proposed, the left for the lines being removed (the only side a
// deleted file has). Both URIs name their pull request (`pr=<n>`), so a
// comment on one is that pull request's, whatever else shares the commit.
//
// THE LEFT SIDE IS THE MERGE BASE, not `base.sha`. GitHub's patch for a PR is
// the three-dot diff: its hunks — which decide where a comment can go — and a
// LEFT comment's line number count lines in the merge base of base and head.
// base.sha is the base branch's tip, which moves on as others merge: drawn
// there, the hunks sat on the wrong lines, a LEFT comment was sent with a
// number GitHub reads against other content, and the base branch's own new
// work showed as if the PR removed it.

/** Where a pull request lives: its repository. */
export interface PrRepoRef {
  owner: string;
  repo: string;
}

/** The head-side URI for a PR file. */
export function prHeadUri(ref: PrRepoRef, pr: { number?: number; headSha: string }, path: string): vscode.Uri {
  return toPrContentUri({ owner: ref.owner, repo: ref.repo, sha: pr.headSha, path, ...(pr.number ? { pr: pr.number } : {}) });
}

/**
 * The base-side URI: the file as it was at `baseSha` (the merge base — see
 * `diffBase`) — under its OLD name, for a rename.
 */
export function prBaseUri(ref: PrRepoRef, pr: { number?: number }, path: string, baseSha: string): vscode.Uri {
  return toPrContentUri({ owner: ref.owner, repo: ref.repo, sha: baseSha, path, ...(pr.number ? { pr: pr.number } : {}) });
}

/**
 * The commit a PR's diff is drawn from: the merge base of its base and head,
 * as GitHub counts its patch. When GitHub can't say (offline, a head it no
 * longer has), `base.sha` — right until the base branch moves on.
 */
export async function diffBase(api: GitHubApi, ref: PrRepoRef, pr: { base: { sha: string }; head: { sha: string } } | PullRequest): Promise<string> {
  const sha = await api.mergeBase(ref.owner, ref.repo, pr.base.sha, pr.head.sha).catch(() => undefined);
  return sha ?? pr.base.sha;
}

/** A changed file's diff, at `line` of its head side when given. */
export async function openPrFileDiff(
  ref: PrRepoRef,
  pr: { number: number; headSha: string },
  file: PrFile,
  baseSha: string,
  line?: number,
): Promise<void> {
  const title = file.previousFilename
    ? `${baseName(file.previousFilename)} → ${baseName(file.filename)} (#${pr.number})`
    : `${baseName(file.filename)} (#${pr.number})`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    prBaseUri(ref, pr, file.previousFilename ?? file.filename, baseSha),
    prHeadUri(ref, pr, file.filename),
    title,
    {
      preview: true,
      ...(line && line > 0 ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {}),
    } satisfies vscode.TextDocumentShowOptions,
  );
}

/** A commit's changed file: its first parent against it. Not a review's: it names no pull request. */
export async function openCommitFileDiff(ref: PrRepoRef, commit: { sha: string; short: string }, parent: string | undefined, file: PrFile): Promise<void> {
  const title = `${baseName(file.filename)} (${commit.short})`;
  const left = toPrContentUri({ owner: ref.owner, repo: ref.repo, sha: parent ?? commit.sha, path: file.previousFilename ?? file.filename });
  const right = toPrContentUri({ owner: ref.owner, repo: ref.repo, sha: commit.sha, path: file.filename });
  await vscode.commands.executeCommand("vscode.diff", parent ? left : right, right, title, { preview: true } satisfies vscode.TextDocumentShowOptions);
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}
