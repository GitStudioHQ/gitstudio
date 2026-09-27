import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { RepoManager } from "../git/repoManager";
import type { BlameCommit } from "@gitstudio/host-bridge/blame";
import type { FileHistoryEntry } from "@gitstudio/git-service/index";
import { HistoryProvider } from "@gitstudio/git-service/HistoryProvider";
import { sameFolder } from "@gitstudio/git-service/WorktreeProvider";

/** The URI scheme our historical file contents are served under. */
export const REVISION_SCHEME = "gitstudio-rev";

/**
 * Git's empty tree: a revision in which no path exists, so a side read at it
 * is empty. The "before" of an added file and the "after" of a deleted one.
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Encodes a (repoRoot, rev, relPath) triple into a `gitstudio-rev` URI.
 *
 * The URI path is the real relative filename (so VS Code infers the language
 * from the extension), the rev and repo root ride in the query string. Example:
 *   gitstudio-rev:/src/app.ts?rev=<sha>&root=<encoded-root>
 *
 * `readPath` is the path git reads at `rev` when it is not `relPath` — the
 * file's name in a commit older than a rename. The URI keeps today's name, so
 * the tab, the language and Back/Forward through the file's history all stay
 * on one file, while the content comes from where the file really was.
 */
export function toRevisionUri(
  root: string,
  rev: string,
  relPath: string,
  readPath?: string,
): vscode.Uri {
  // Normalise to forward slashes and a leading slash for a clean URI path.
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const at =
    readPath !== undefined && readPath !== relPath ? `&at=${encodeURIComponent(readPath)}` : "";
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${normalized}`,
    query: `rev=${encodeURIComponent(rev)}&root=${encodeURIComponent(root)}${at}`,
  });
}

/** Decodes a `gitstudio-rev` URI back into its parts. */
export function fromRevisionUri(uri: vscode.Uri): {
  root: string;
  rev: string;
  /** The file's name — today's. */
  relPath: string;
  /** The path git reads at `rev` (the name the file had there). */
  readPath: string;
} {
  const params = new URLSearchParams(uri.query);
  const relPath = uri.path.replace(/^\/+/, "");
  return {
    root: params.get("root") ?? "",
    rev: params.get("rev") ?? "",
    relPath,
    readPath: params.get("at") ?? relPath,
  };
}

/**
 * One side of a diff: a revision and the path the file had there, or the
 * working-tree file (`rev` undefined).
 */
export interface RevisionSide {
  /** A sha, "HEAD", "<sha>~1", "" for the index, EMPTY_TREE for nothing. */
  rev: string | undefined;
  /** The path git reads at `rev`; the diff's own name when omitted. */
  path?: string;
}

/** The URI for one side of a diff of `rel` (today's name). */
export function revisionSideUri(root: string, rel: string, side: RevisionSide): vscode.Uri {
  if (side.rev === undefined) {
    return vscode.Uri.file(joinPath(root, side.path ?? rel));
  }
  return toRevisionUri(root, side.rev, rel, side.path);
}

/**
 * What one commit did to a file — both sides under the names the file had
 * THERE. Every "diff this commit's change" surface builds its sides here, so
 * none of them reads a renamed file under today's name (which finds nothing
 * and shows an empty diff, or the whole file as added).
 */
export function commitChangeSides(change: {
  sha: string;
  /** The parent to diff against: `<sha>~1`, a parent sha, or EMPTY_TREE. */
  parent: string;
  /** The file's path in the commit. */
  path: string;
  /** Its path in the parent, when the commit renamed it. */
  oldPath?: string;
  /** git's letter: an added file has no parent side, a deleted one no commit side. */
  status?: string;
}): { left: RevisionSide; right: RevisionSide } {
  return {
    left:
      change.status === "A"
        ? { rev: EMPTY_TREE, path: change.path }
        : { rev: change.parent, path: change.oldPath || change.path },
    right: change.status === "D" ? { rev: EMPTY_TREE, path: change.path } : { rev: change.sha, path: change.path },
  };
}

/** A file-history entry's change (FileHistoryEntry carries the path at each commit). */
export function historyChangeSides(e: Pick<FileHistoryEntry, "sha" | "path" | "oldPath">): {
  left: RevisionSide;
  right: RevisionSide;
} {
  return commitChangeSides({ sha: e.sha, parent: `${e.sha}~1`, path: e.path, oldPath: e.oldPath });
}

/**
 * A blamed line's commit, as it changed this file: the commit's own name for
 * the file (blame follows renames), against `previous` — the parent blame
 * followed and the name the file had there. No `previous` means the commit
 * added the file.
 */
export function blameChangeSides(
  commit: Pick<BlameCommit, "sha" | "filename" | "previous">,
  rel: string,
): { left: RevisionSide; right: RevisionSide } {
  const path = commit.filename || rel;
  return {
    left: commit.previous
      ? { rev: commit.previous.sha, path: commit.previous.filename }
      : { rev: EMPTY_TREE, path },
    right: { rev: commit.sha, path },
  };
}

/** Open a diff of `rel` between two sides. */
export async function openSidesDiff(
  root: string,
  rel: string,
  sides: { left: RevisionSide; right: RevisionSide },
  title: string,
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    revisionSideUri(root, rel, sides.left),
    revisionSideUri(root, rel, sides.right),
    title,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
}

/**
 * Serves the read-only content of a file at a specific revision via
 * `git show <rev>:<path>`, so `vscode.diff` can render historical versions.
 */
export class RevisionContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  // Most revisions (a commit sha) are immutable, but the index (rev "") and
  // HEAD shift as the user stages/unstages/commits. Firing this event tells
  // VS Code to re-read those diff sides after a staging op.
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly repos: RepoManager) {}

  /**
   * Invalidates every cached mutable revision (the index and HEAD) so open
   * diffs against them re-render. Called after a stage/unstage/discard/commit.
   */
  notifyChanged(): void {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    // VS Code only re-reads URIs it currently has open; firing for each open
    // document's URI is the documented way to invalidate. Since we can't
    // enumerate them cheaply, fire a wildcard by re-emitting for tracked docs.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === REVISION_SCHEME) {
        const { rev } = fromRevisionUri(doc.uri);
        if (rev === "" || rev === "HEAD") {
          this.changeEmitter.fire(doc.uri);
        }
      }
    }
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { root, rev, readPath } = fromRevisionUri(uri);
    const open = this.repos.getAll().find((e) => e.root === root || (root !== "" && sameFolder(e.root, root)));
    const active = this.repos.getActive();
    // A root no open repository has — another worktree's, from the Worktrees
    // view — is read IN that folder. Falling back to the active repository
    // was harmless for a commit (the objects are shared) and wrong for HEAD
    // and the index (rev "HEAD" / ""), which are each worktree's own: the
    // diff showed THIS window's staged file as the other worktree's.
    const history = open
      ? open.ctx.history
      : active && root && existsSync(root)
        ? new HistoryProvider(active.ctx.process.at(root))
        : active?.ctx.history;
    if (!history) {
      return "";
    }

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    try {
      return await history.fileAtRevision(rev, readPath, {
        signal: ac.signal,
      });
    } catch {
      // A cancelled or failed read yields an empty document rather than an
      // error toast — the diff just shows nothing on that side.
      return "";
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
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
