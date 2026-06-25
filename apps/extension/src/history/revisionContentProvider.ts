import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";

/** The URI scheme our historical file contents are served under. */
export const REVISION_SCHEME = "gitstudio-rev";

/**
 * Encodes a (repoRoot, rev, relPath) triple into a `gitstudio-rev` URI.
 *
 * The URI path is the real relative filename (so VS Code infers the language
 * from the extension), the rev and repo root ride in the query string. Example:
 *   gitstudio-rev:/src/app.ts?rev=<sha>&root=<encoded-root>
 */
export function toRevisionUri(
  root: string,
  rev: string,
  relPath: string,
): vscode.Uri {
  // Normalise to forward slashes and a leading slash for a clean URI path.
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${normalized}`,
    query: `rev=${encodeURIComponent(rev)}&root=${encodeURIComponent(root)}`,
  });
}

/** Decodes a `gitstudio-rev` URI back into its parts. */
export function fromRevisionUri(uri: vscode.Uri): {
  root: string;
  rev: string;
  relPath: string;
} {
  const params = new URLSearchParams(uri.query);
  return {
    root: params.get("root") ?? "",
    rev: params.get("rev") ?? "",
    relPath: uri.path.replace(/^\/+/, ""),
  };
}

/**
 * Serves the read-only content of a file at a specific revision via
 * `git show <rev>:<path>`, so `vscode.diff` can render historical versions.
 */
export class RevisionContentProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(private readonly repos: RepoManager) {}

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { root, rev, relPath } = fromRevisionUri(uri);
    const entry = this.repos
      .getAll()
      .find((e) => e.root === root) ?? this.repos.getActive();
    if (!entry) {
      return "";
    }

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    try {
      return await entry.ctx.history.fileAtRevision(rev, relPath, {
        signal: ac.signal,
      });
    } catch {
      // A cancelled or failed read yields an empty document rather than an
      // error toast — the diff just shows nothing on that side.
      return "";
    }
  }
}

/**
 * Opens a diff for `rel` in repo `root`: the left side is `rev`, the right side
 * is either `againstRev` (another revision) or the live working-tree file when
 * omitted. Title defaults to "<file> (<shortRev>)".
 */
export async function openRevisionDiff(
  root: string,
  rel: string,
  rev: string,
  againstRev?: string,
  title?: string,
): Promise<void> {
  const leftUri = toRevisionUri(root, rev, rel);
  const rightUri =
    againstRev === undefined
      ? vscode.Uri.file(joinPath(root, rel))
      : toRevisionUri(root, againstRev, rel);

  const fileName = baseName(rel);
  const rightLabel = againstRev === undefined ? "Working Tree" : shortRev(againstRev);
  const computedTitle =
    title ?? `${fileName} (${shortRev(rev)} ↔ ${rightLabel})`;

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    computedTitle,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
}

function shortRev(rev: string): string {
  // Strip a "~1" suffix for display and shorten full shas.
  const clean = rev.replace(/~\d+$/, "");
  return /^[0-9a-f]{40}$/i.test(clean) ? clean.slice(0, 7) : rev;
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}

function joinPath(root: string, rel: string): string {
  const sep = root.endsWith("/") ? "" : "/";
  return `${root}${sep}${rel}`;
}
