import * as vscode from "vscode";
import type { GitHubApi } from "./githubApi";

// Serves the content of a file at a given commit SHA from a GitHub repo, so
// `vscode.diff` can render base-vs-head for a PR's changed files without first
// fetching the refs locally. Backed by the GitHub "contents" API
// (`GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`, via GitHubApi.fileAt).
//
// Only a path that does not EXIST at that commit (the added / deleted side)
// is an empty document. Any other failure — signed out, a rate limit, offline,
// GitHub down — throws, so VS Code says the file couldn't be opened and why:
// an empty pane there read as "this file was added" (or deleted), which it
// wasn't. A binary or very large file is a one-line note naming its size, not
// its bytes decoded as text.

export const PR_SCHEME = "gitstudio-pr";

interface PrContentRef {
  owner: string;
  repo: string;
  sha: string;
  path: string;
  /** The pull request whose diff the file is shown in (a review's comments are its). */
  pr?: number;
}

/** Encodes (owner, repo, sha, path) into a `gitstudio-pr` URI. */
export function toPrContentUri(ref: PrContentRef): vscode.Uri {
  const normalized = ref.path.replace(/\\/g, "/").replace(/^\/+/, "");
  return vscode.Uri.from({
    scheme: PR_SCHEME,
    path: `/${normalized}`,
    query:
      `owner=${encodeURIComponent(ref.owner)}` +
      `&repo=${encodeURIComponent(ref.repo)}` +
      `&sha=${encodeURIComponent(ref.sha)}` +
      (ref.pr ? `&pr=${ref.pr}` : ""),
  });
}

export function fromPrContentUri(uri: vscode.Uri): PrContentRef {
  const params = new URLSearchParams(uri.query);
  const pr = Number(params.get("pr"));
  return {
    owner: params.get("owner") ?? "",
    repo: params.get("repo") ?? "",
    sha: params.get("sha") ?? "",
    path: uri.path.replace(/^\/+/, ""),
    ...(Number.isSafeInteger(pr) && pr > 0 ? { pr } : {}),
  };
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;
}

export class PrContentProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(private readonly api: GitHubApi) {}

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { owner, repo, sha, path } = fromPrContentUri(uri);
    if (!owner || !repo || !sha || !path) {
      return "";
    }
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    // Throws GitHubApiError (with the sentence to show) on anything but a
    // missing path.
    const content = await this.api.fileAt(owner, repo, path, sha, { signal: ac.signal });
    switch (content.kind) {
      case "text":
        return content.text;
      case "missing":
        return "";
      case "binary":
        return `Binary file (${size(content.bytes)}) at ${sha.slice(0, 7)} — its content isn't shown.`;
      case "too-large":
        return `File too large to show (${size(content.bytes)}) at ${sha.slice(0, 7)}.`;
    }
  }
}
