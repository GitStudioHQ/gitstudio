import * as vscode from "vscode";
import type { GitHubAuth } from "./githubAuth";

// Serves the content of a file at a given commit SHA from a GitHub repo, so
// `vscode.diff` can render base-vs-head for a PR's changed files without first
// fetching the refs locally. Backed by the GitHub "contents" API
// (`GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`), returning the decoded
// blob. A missing file (added/deleted side) yields an empty document rather than
// an error, so the diff just shows an empty pane.

export const PR_SCHEME = "gitstudio-pr";

interface PrContentRef {
  owner: string;
  repo: string;
  sha: string;
  path: string;
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
      `&sha=${encodeURIComponent(ref.sha)}`,
  });
}

function fromPrContentUri(uri: vscode.Uri): PrContentRef {
  const params = new URLSearchParams(uri.query);
  return {
    owner: params.get("owner") ?? "",
    repo: params.get("repo") ?? "",
    sha: params.get("sha") ?? "",
    path: uri.path.replace(/^\/+/, ""),
  };
}

export class PrContentProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(private readonly auth: GitHubAuth) {}

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { owner, repo, sha, path } = fromPrContentUri(uri);
    if (!owner || !repo || !sha || !path) {
      return "";
    }
    const accessToken = await this.auth.getToken({ interactive: false });
    if (!accessToken) {
      return "";
    }
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    try {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(sha)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            // Raw media type returns the file bytes directly.
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "GitStudio",
          },
          signal: ac.signal,
        },
      );
      if (!res.ok) {
        // 404 → the file doesn't exist on that side (added/deleted). Empty pane.
        return "";
      }
      return await res.text();
    } catch {
      return "";
    }
  }
}
