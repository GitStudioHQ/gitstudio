import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import type { RepoEntry, RepoManager } from "../git/repoManager";
import type { DialogChoiceButton } from "../ui/dialogs";
import { notice } from "../ui/notify";
import { EMPTY_TREE, REVISION_SCHEME, fromRevisionUri } from "./revisionContentProvider";
import { fromGitUriQuery, revOfGitRef } from "../changes/nativeDiffSides";

/**
 * "Show in Commit Graph" — finding a commit you are looking at from a file's
 * history (issue #111): a row of Open File at Revision or Line History, a
 * revision opened in an editor.
 *
 * Every one of them ends in `gitstudio.revealCommitInGraph` with a FULL sha:
 * the graph matches rows by full sha, and a short one can name a branch or a
 * tag as well. The graph does the rest — it opens if it was never shown, and
 * pages down to a commit older than what it has loaded.
 */

/** The row button that reveals the row's commit (Open File at Revision, Line History). */
export const SHOW_IN_GRAPH_BUTTON = "showInGraph";

export function showInGraphButton(): DialogChoiceButton {
  return { id: SHOW_IN_GRAPH_BUTTON, icon: "git-commit", title: l10n.t("Show in Commit Graph") };
}

/** Reveal `sha` (a full one) of `entry` in the Commit Graph — when the graph shows that repository. */
export async function revealInGraph(repos: RepoManager, entry: RepoEntry, sha: string): Promise<void> {
  if (graphShows(repos, entry)) {
    await vscode.commands.executeCommand("gitstudio.revealCommitInGraph", sha);
  }
}

/**
 * Whether the Commit Graph shows `entry`'s repository: it shows the active
 * one, and an explicit pick of another holds (repoManager.ts) — so say so
 * rather than page a whole other history for a commit it does not have.
 */
function graphShows(repos: RepoManager, entry: RepoEntry): boolean {
  const active = repos.getActive();
  if (!active || active.root === entry.root) {
    return true;
  }
  void vscode.window.showInformationMessage(
    notice(l10n.t("That commit is in {0}, and the Commit Graph is showing {1}. Switch Repository to see it there.", baseName(entry.root), baseName(active.root))),
  );
  return false;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * The commit `gitstudio.revealCommitInGraph` was asked for, as a full sha.
 *
 *  · a string: a sha, from blame, the graph's own links, a dialog row — as is;
 *  · a `gitstudio-rev` or vscode.git `git:` URI, or nothing (the palette): the
 *    revision the editor shows, resolved to its commit.
 *
 * Undefined when there is no commit to show; the user has been told why.
 */
export async function commitToReveal(repos: RepoManager, arg: unknown): Promise<string | undefined> {
  if (typeof arg === "string") {
    return arg || undefined;
  }
  const isUri = typeof (arg as { scheme?: unknown } | undefined)?.scheme === "string";
  const uri = isUri ? (arg as vscode.Uri) : vscode.window.activeTextEditor?.document.uri;
  const at = uri ? revisionAt(repos, uri) : undefined;
  const sha = at ? await commitOf(at.entry, at.rev) : undefined;
  if (!at || !sha) {
    void vscode.window.showInformationMessage(notice(l10n.t("This editor isn't showing a commit.")));
    return undefined;
  }
  return graphShows(repos, at.entry) ? sha : undefined;
}

/** The repository and revision an editor's document is read at, if it is one. */
function revisionAt(repos: RepoManager, uri: vscode.Uri): { entry: RepoEntry; rev: string } | undefined {
  if (uri.scheme === REVISION_SCHEME) {
    const { root, rev } = fromRevisionUri(uri);
    const entry = repos.getAll().find((e) => e.root === root);
    return entry ? { entry, rev } : undefined;
  }
  if (uri.scheme === "git") {
    const side = fromGitUriQuery(uri.query);
    const entry = side ? repos.findByPath(side.path) : undefined;
    return side && entry ? { entry, rev: revOfGitRef(side.ref) } : undefined;
  }
  return undefined;
}

/** `rev` as a full commit sha — never the index ("") or the empty tree. */
async function commitOf(entry: RepoEntry, rev: string): Promise<string | undefined> {
  if (!rev || rev === EMPTY_TREE || rev.startsWith("-")) {
    return undefined;
  }
  try {
    const r = await entry.ctx.process.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    const sha = r.code === 0 ? r.stdout.trim() : "";
    return FULL_SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}
