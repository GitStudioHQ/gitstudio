import * as vscode from "vscode";
import * as path from "node:path";
import { homedir } from "node:os";
import { promptPick, type DialogChoice } from "../ui/dialogs";
import { isSamePathOrInside } from "../util/repoScope";
import type { RepoEntry, RepoManager } from "./repoManager";

// Switch Repository… (issue #32): a workspace that holds several repositories
// — a parent folder of checkouts, a multi-root workspace, a repo nested in
// another's folder — shows one of them in the Changes view, the commit graph,
// Worktrees and the sync status. This is how you choose which one. The header
// of the Changes view and the Command Palette both open it; both reach
// RepoManager.setActive, which owns the rule for how long a pick holds.
//
// Everything a row says comes from state the extension ALREADY holds —
// vscode.git's in-memory branch and change lists. Opening the picker spawns no
// git: a folder of thirty repositories must not mean thirty `git status` runs
// to draw a list. A repository vscode.git has not attached yet shows its name
// and path only.

/** The choice id that drops the pick (the active repo follows the editor). */
export const FOLLOW_EDITOR_ID = "gitstudio:follow-editor";

/** A workspace folder, as much of one as a display path needs. */
export interface FolderLike {
  name: string;
  fsPath: string;
}

/**
 * Where a repository is, as a person reads it: the path from the workspace
 * folder that holds it, starting with that folder's name — "code/api",
 * "gitstudio/packages/vendored". A repository outside every workspace folder
 * (vscode.git opens the repository of any file you open) shows its full path,
 * with the home directory as "~".
 */
export function repoDisplayPath(
  root: string,
  folders: readonly FolderLike[],
  home: string = homedir(),
): string {
  let holder: FolderLike | undefined;
  for (const f of folders) {
    if (isSamePathOrInside(root, f.fsPath) && (!holder || f.fsPath.length > holder.fsPath.length)) {
      holder = f;
    }
  }
  if (holder) {
    const rel = path.relative(holder.fsPath, root).split(path.sep).filter(Boolean).join("/");
    return rel ? `${holder.name}/${rel}` : holder.name;
  }
  if (home && isSamePathOrInside(root, home)) {
    const rel = path.relative(home, root).split(path.sep).filter(Boolean).join("/");
    return rel ? `~/${rel}` : "~";
  }
  return root;
}

/** The repository's folder name — what the header and the picker call it. */
export function repoName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** What vscode.git already knows about a repository, without asking git. */
export interface RepoGlance {
  /** Branch name; undefined when unknown or detached. */
  branch?: string;
  /** Short revision when HEAD is detached. */
  detachedAt?: string;
  /** Distinct changed files (merge, staged, unstaged, untracked). */
  changed?: number;
}

export function glance(entry: RepoEntry): RepoGlance {
  const state = entry.repo?.state;
  if (!state) {
    return {};
  }
  const head = state.HEAD;
  const untracked = (state as { untrackedChanges?: { uri: vscode.Uri }[] }).untrackedChanges ?? [];
  const files = new Set<string>();
  for (const list of [state.mergeChanges, state.indexChanges, state.workingTreeChanges, untracked]) {
    for (const c of list ?? []) {
      files.add(c.uri.fsPath);
    }
  }
  return {
    branch: head?.name,
    detachedAt: head?.name ? undefined : head?.commit?.slice(0, 7),
    changed: files.size,
  };
}

/** One row of the picker. */
export interface RepoRow {
  root: string;
  name: string;
  path: string;
  glance: RepoGlance;
}

/**
 * The picker's rows: every repository (name, path, branch, changed files), in
 * path order so the list reads the same every time — discovery order depends
 * on which scan finished first. The repository on screen is marked with the
 * check the branch menu uses for the current branch. When a pick is in effect,
 * a last row returns to following the editor: without it, one pick would end
 * that behaviour in this workspace for good (the pick is remembered).
 */
export function repoChoices(
  rows: readonly RepoRow[],
  activeRoot: string | undefined,
  picked: boolean,
): DialogChoice[] {
  const sorted = [...rows].sort(
    (a, b) => a.path.localeCompare(b.path) || a.root.localeCompare(b.root),
  );
  const choices: DialogChoice[] = sorted.map((r) => {
    const current = r.root === activeRoot;
    const where = r.glance.branch
      ? `on ${r.glance.branch}`
      : r.glance.detachedAt
        ? `detached at ${r.glance.detachedAt}`
        : undefined;
    const n = r.glance.changed ?? 0;
    return {
      id: r.root,
      label: r.name,
      icon: current ? "check" : "repo",
      description: where ? `${r.path} · ${where}` : r.path,
      detail: n > 0 ? `${n} changed file${n === 1 ? "" : "s"}` : undefined,
    };
  });
  if (picked) {
    choices.push({
      id: FOLLOW_EDITOR_ID,
      label: "Follow the active editor",
      icon: "go-to-file",
      description: "Show the repository of whichever file you are editing.",
    });
  }
  return choices;
}

/** The picker's one-line explanation, in the words of the rule it applies. */
export function repoPickHint(pickedName: string | undefined): string {
  return pickedName
    ? `Changes, the commit graph, worktrees and sync status stay on ${pickedName} until you pick again.`
    : "Changes, the commit graph, worktrees and sync status follow the file you are editing. Pick a repository to keep them on it.";
}

function workspaceFolders(): FolderLike[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    fsPath: f.uri.fsPath,
  }));
}

/** repoDisplayPath against this window's workspace folders. */
export function workspacePathOf(root: string): string {
  return repoDisplayPath(root, workspaceFolders());
}

/** Rows for every open repository — no git spawned (see the note at the top). */
export function repoRows(repos: RepoManager): RepoRow[] {
  return repos.getAll().map((entry) => ({
    root: entry.root,
    name: repoName(entry.root),
    path: workspacePathOf(entry.root),
    glance: glance(entry),
  }));
}

/**
 * `gitstudio.switchRepository` — the header control of the Changes view and the
 * Command Palette entry. Asks in GitStudio's own dialog (never the quick pick),
 * so arrows, Enter and Escape work as in every other GitStudio pick.
 */
export async function switchRepository(repos: RepoManager): Promise<void> {
  const rows = repoRows(repos);
  if (rows.length === 0) {
    void vscode.window.showInformationMessage("GitStudio: no repository is open.");
    return;
  }
  const picked = repos.getPicked();
  const choice = await promptPick({
    title: "Switch Repository",
    hint: repoPickHint(picked !== undefined ? repoName(picked) : undefined),
    choices: repoChoices(rows, repos.getActive()?.root, picked !== undefined),
  });
  if (choice === undefined) {
    return;
  }
  if (choice === FOLLOW_EDITOR_ID) {
    repos.setActive(undefined);
    return;
  }
  if (!repos.setActive(choice)) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${repoName(choice)} is no longer open, so it can't be shown.`,
    );
  }
}
