import * as vscode from "vscode";
import {
  promptChoose,
  promptConfirm,
  promptInput,
  promptPick,
  type DialogChoice,
} from "../ui/dialogs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { WorktreeEntry, GitRef } from "@gitstudio/git-service/index";
import { optionLikeCheckout } from "@gitstudio/git-service/checkoutRef";
import { pullDetachedMessage, pullPauseMessage } from "@gitstudio/git-service/SyncOps";
import { tildify } from "./branchElsewhere";
import type { WorktreeRemoval } from "@gitstudio/git-service/WorktreeProvider";
import { folderKey, nativePath, sameFolder } from "@gitstudio/git-service/folderPath";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import {
  worktreeChangedSinceAsked,
  worktreeRemovalAsk,
  worktreeRemovalRefusal,
  worktreeStashMessage,
} from "@gitstudio/host-bridge/worktreeRemoval";
import type { WorktreeRow } from "@gitstudio/host-bridge/worktreesProtocol";
import { bareName, shortNameOf, startPointOf, worktreeRefFor } from "./worktreeRefs";
import { worktreeEntry } from "../git/worktreeContext";
import { pullOrAsk } from "../git/inTheWay";
import { askPullMode } from "../git/pullMode";
import { notice, NO_REPOSITORY } from "../ui/notify";

// The Worktrees pillar's commands — also absent from free VS Code. The view
// (worktreesWebview.ts) calls them with a worktree's folder; the palette with
// nothing, and then they ask which worktree. Every door reads the worktree
// list fresh before it acts: a row can be stale, git's list never is.

/** A worktree a command acts on: its folder (as the view names it), or an
 *  older caller's `{ entry: { path } }`. Nothing: the command asks. */
export type WorktreeTarget = string | { path?: string; entry?: { path: string } } | undefined;

/**
 * A worktree's folder as a person reads it: the system's spelling (git's
 * C:/Users/… is C:\Users\… on Windows), with ~ for home where that is how
 * paths are written. The entry keeps git's own spelling; paths are compared
 * as folders, never by this text.
 */
function shownPath(entry: WorktreeEntry): string {
  return tildify(nativePath(entry.path));
}

/**
 * What the view is told while an action runs, so a one-click change paints at
 * once and a long one says what it is doing — and both are put right if git
 * says no. All optional: the palette has no view to tell.
 */
export interface WorktreeUi {
  busy?(path: string, label: string | undefined): void;
  patch?(path: string, row: Partial<WorktreeRow>): void;
  drop?(path: string): void;
}

/**
 * How a worktree is named in words: by its folder, as every row of the list
 * and its More menu name it — one vocabulary across the view, its questions
 * and its reports. What it has checked out is said beside it where it
 * matters (the removal question's "The branch … stays").
 */
export function worktreeLabel(entry: WorktreeEntry): string {
  const folder = path.basename(entry.path);
  return entry.bare ? `${folder} (bare)` : folder;
}

/**
 * The worktrees this window has open, by their listed path: the one the active
 * repository's root is, and the one each workspace folder lies in — the
 * DEEPEST that holds it, since a linked worktree can live inside the main one
 * (…/app/.claude/worktrees/x). Compared by folderKey, so a window opened
 * through a symlink still finds the worktree git lists by its real path.
 */
export function worktreesOpenHere(
  list: readonly WorktreeEntry[],
  activeRoot: string | undefined,
): Set<string> {
  const keyed = list.filter((e) => !e.bare).map((e) => ({ path: e.path, key: folderKey(e.path) }));
  const open = new Set<string>();
  const claim = (folder: string): void => {
    const f = folderKey(folder);
    let best: { path: string; key: string } | undefined;
    for (const k of keyed) {
      if ((f === k.key || f.startsWith(k.key + "/")) && (!best || k.key.length > best.key.length)) {
        best = k;
      }
    }
    if (best) {
      open.add(best.path);
    }
  };
  if (activeRoot) {
    claim(activeRoot);
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    claim(f.uri.fsPath);
  }
  return open;
}

// ── Finding the worktree a command is about ──────────────────────────────────

function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage(NO_REPOSITORY);
  }
  return a;
}

function targetPath(t: WorktreeTarget): string | undefined {
  if (typeof t === "string") return t || undefined;
  return t?.path ?? t?.entry?.path;
}

interface Resolved {
  a: RepoEntry;
  list: WorktreeEntry[];
  entry: WorktreeEntry;
  /** It is the main worktree (git lists it first). */
  main: boolean;
  /** This window has it open. */
  here: boolean;
}

/**
 * The worktree `t` names, from git's list read now — or, with nothing named
 * (the palette), the one the person picks from those `offer` allows.
 */
async function resolveTarget(
  repos: RepoManager,
  t: WorktreeTarget,
  pickTitle: string,
  offer: (e: WorktreeEntry, main: boolean, here: boolean) => boolean,
): Promise<Resolved | undefined> {
  const a = active(repos);
  if (!a) {
    return undefined;
  }
  const list = await a.ctx.worktrees.list();
  const here = worktreesOpenHere(list, a.root);
  let at = targetPath(t);
  if (at === undefined) {
    const choices: DialogChoice[] = list
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => offer(e, i === 0, here.has(e.path)))
      .map(({ e }) => ({
        id: e.path,
        label: path.basename(e.path),
        icon: "worktree",
        description: `${e.branch ?? `detached at ${e.head.slice(0, 7)}`} — ${shownPath(e)}`,
      }));
    if (choices.length === 0) {
      void vscode.window.showInformationMessage("GitStudio: no worktree this can be done to.");
      return undefined;
    }
    at = await promptPick({ title: pickTitle, choices });
    if (at === undefined) {
      return undefined;
    }
  }
  const index = list.findIndex((e) => sameFolder(e.path, at!));
  if (index < 0) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${worktreeRemovalRefusal("notListed", path.basename(at))}`,
    );
    return undefined;
  }
  const entry = list[index];
  return { a, list, entry, main: index === 0, here: here.has(entry.path) };
}

/**
 * A worktree git still lists whose folder is there but is not a worktree any
 * more: its .git is gone (git calls it prunable — or, locked, which git never
 * prunes, the folder says so). git in that folder reads the repository AROUND
 * it — the main worktree, for one nested in it — so nothing is opened, pulled
 * or pushed there; it can only be forgotten.
 */
export function isUnlinked(e: WorktreeEntry): boolean {
  return !e.bare && existsSync(e.path) && (!!e.prunable || !existsSync(path.join(e.path, ".git")));
}

/**
 * A window on a folder that is not there opens onto nothing: says so and
 * answers true when the folder is gone.
 */
function saidFolderGone(entry: WorktreeEntry): boolean {
  if (existsSync(entry.path)) {
    return false;
  }
  void vscode.window.showWarningMessage(
    `GitStudio: ${worktreeLabel(entry)}'s folder is gone — ${shownPath(entry)}. Forget the worktree in Worktrees to clear it from the list.`,
  );
  return true;
}

/**
 * Nothing runs IN a folder that is not this worktree: gone, or not a worktree
 * any more (git there would be the repository around it). Says which and
 * answers true.
 */
function saidNotAWorktree(entry: WorktreeEntry): boolean {
  if (saidFolderGone(entry)) {
    return true;
  }
  if (!isUnlinked(entry)) {
    return false;
  }
  void vscode.window.showWarningMessage(
    `GitStudio: ${worktreeLabel(entry)}'s folder isn't a worktree any more — ${shownPath(entry)}. Forget the worktree in Worktrees to clear it from the list.`,
  );
  return true;
}

// ── Open, reveal, terminal, copy ─────────────────────────────────────────────

/**
 * Open the worktree's folder where the control says, with no question first.
 * Never the worktree this window already has open ("This Window" would only
 * reopen it; "New Window" would open it twice).
 */
export async function openWorktreeIn(
  repos: RepoManager,
  t: WorktreeTarget,
  where: "new" | "here",
): Promise<void> {
  const r = await resolveTarget(
    repos,
    t,
    where === "new" ? "Open a worktree in a new window" : "Open a worktree in this window",
    (e, _m, here) => !e.bare && !here && existsSync(e.path) && !isUnlinked(e),
  );
  if (!r || r.entry.bare || saidNotAWorktree(r.entry) || r.here) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.entry.path), {
    forceNewWindow: where === "new",
  });
}

/** Show the worktree's folder in the system's file manager. */
export async function revealWorktree(repos: RepoManager, t: WorktreeTarget): Promise<void> {
  const r = await resolveTarget(repos, t, "Reveal a worktree", (e) => existsSync(e.path));
  if (!r || saidFolderGone(r.entry)) {
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(r.entry.path));
}

/** A terminal in the worktree's folder, named for it. */
export async function openWorktreeTerminal(repos: RepoManager, t: WorktreeTarget): Promise<void> {
  const r = await resolveTarget(repos, t, "Open a terminal in a worktree", (e) => !e.bare && existsSync(e.path) && !isUnlinked(e));
  if (!r || r.entry.bare || saidNotAWorktree(r.entry)) {
    return;
  }
  const term = vscode.window.createTerminal({ name: path.basename(r.entry.path), cwd: r.entry.path });
  term.show();
}

/** Copy the worktree's folder, whole. */
export async function copyWorktreePath(repos: RepoManager, t: WorktreeTarget): Promise<void> {
  const r = await resolveTarget(repos, t, "Copy a worktree's path", () => true);
  if (!r) {
    return;
  }
  await vscode.env.clipboard.writeText(nativePath(r.entry.path));
  flash(`Copied ${shownPath(r.entry)}`);
}

// ── New worktree ─────────────────────────────────────────────────────────────

/** `gitstudio.worktree.add` — pick a ref (branch/remote/tag, or a new one), a name, a folder. */
export async function addWorktree(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }

  let refs: GitRef[] = [];
  try {
    refs = await a.ctx.refs.listRefs();
  } catch {
    // proceed with new-branch only
  }

  // A sentinel id no ref can collide with: git forbids ":" in a ref name.
  const NEW = "gitstudio:new-branch";

  // Local branches, remote branches, and tags — so you can base a worktree on
  // origin/main without first checking it out anywhere. Keyed by the FULL ref:
  // a local branch and a tag can legally share a short name (git warns "refname
  // 'v1.2' is ambiguous"), and keying by the short name would silently resolve
  // the picked row to whichever ref git listed last. Labels stay short.
  const byId = new Map<string, GitRef>();
  const choices: DialogChoice[] = [
    {
      id: NEW,
      label: "New branch…",
      icon: "add",
      description: "Create a new branch from the current HEAD.",
    },
  ];
  for (const r of refs) {
    // stash is not a worktree ref; "/HEAD" (origin/HEAD) is a symbolic pointer
    // to the remote's default branch and checking it out detaches at whatever
    // it points to — never offer it.
    if (r.type === "stash" || r.name.endsWith("/HEAD")) {
      continue;
    }
    const key = r.fullName ?? r.name;
    byId.set(key, r);
    choices.push({
      id: key,
      label: r.name,
      icon: r.type === "head" ? "git-branch" : r.type === "remote" ? "cloud" : "tag",
      detail: r.sha.slice(0, 7),
    });
  }

  const picked = await promptPick({
    title: "New worktree — pick a ref",
    hint: "What should the new worktree be based on?",
    choices,
  });
  if (!picked) {
    return;
  }

  if (picked === NEW) {
    const name = await askNewBranchName(
      a,
      "The branch is created at the current HEAD and checked out in the new worktree.",
    );
    if (!name) {
      return;
    }
    await askFolderAndCreate(a, { branchName: name, folderName: name, newBranch: true }, refresh);
    return;
  }

  const ref = byId.get(picked);
  if (!ref) {
    return;
  }
  await worktreeFromRef(repos, ref, refresh);
}

/**
 * Shared "create a worktree from an existing ref" flow — used by the Worktrees
 * view's "New Worktree" (after picking a ref) and by the branch menu's
 * "New Worktree from '…'". Works for local branches, remote branches, and tags,
 * and never requires switching off the current branch.
 */
export async function worktreeFromRef(
  repos: RepoManager,
  ref: GitRef,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }

  // The branch-menu webview sends name + type only (no fullName). Re-resolve
  // the authoritative fullName from listRefs() — the same lookup the checkout
  // doors use (worktreeRefFor). Unresolved, the flow STOPS rather than guess a
  // full name from a short one (issue #30's follow-up).
  const resolved = await worktreeRefFor(a.ctx, ref);
  if (!resolved) {
    void vscode.window.showErrorMessage(
      `GitStudio: couldn't find ${ref.name} in this repository's refs — refresh and try again.`,
    );
    return;
  }

  const isLocal = resolved.type === "head";
  // Named as a person names it — "release", not git's "heads/release".
  const label = bareName(resolved);
  // A branch is checked out in one worktree at a time: git refuses a second
  // ("already used by worktree at …"). When another worktree has it, the only
  // worktree to make from it is a new branch — so that is the one offered.
  const holder = isLocal
    ? (await a.ctx.worktrees.list()).find((e) => e.branch === label)
    : undefined;
  // A branch named like an option ("-x"): git would read it as one, and past
  // the `--` it takes it for a revision and DETACHES instead of checking the
  // branch out. A new branch from it (by its full name) is the one to make.
  const optionLike = isLocal ? optionLikeCheckout(resolved.fullName ?? "") : undefined;
  const mode = holder || optionLike
    ? "new"
    : await promptPick({
        title: `Worktree from '${label}'`,
        hint: "Check it out directly, or as a new named branch?",
        choices: [
          {
            id: "direct",
            label: isLocal ? label : `${label} (detached)`,
            icon: isLocal ? "git-branch" : "git-commit",
            description: isLocal
              ? `Check out the existing local branch ${label}.`
              : `Check out ${label} as a detached HEAD.`,
          },
          {
            id: "new",
            label: "New branch…",
            icon: "add",
            description: `Create a new local branch starting from ${label}.`,
          },
        ],
      });
  if (!mode) {
    return;
  }

  if (mode === "direct") {
    // Local branches attach via the name under refs/heads/; a full
    // refs/heads/… would silently detach. Remote/tag refs must detach and need
    // the full ref so a tag sharing a branch's short name can't resolve
    // ambiguously. Both come from the listed full name (worktreeRefFor).
    const directRef =
      resolved.type === "head"
        ? bareName(resolved)
        : (startPointOf(resolved) ?? bareName(resolved));
    await askFolderAndCreate(a, { branchName: directRef, folderName: label, newBranch: false }, refresh);
    return;
  }

  const created = `A new local branch is created from ${label} and checked out in the new worktree.`;
  const name = await askNewBranchName(
    a,
    holder
      ? `${label} is checked out in the worktree at ${shownPath(holder)}, and a branch can be checked out in only one worktree at a time. ${created}`
      : optionLike
        ? `${optionLike.message} ${created}`
        : created,
  );
  if (!name) {
    return;
  }

  const startPoint = startPointOf(resolved);
  // simple upstream semantics: track only when the new branch's name matches
  // the start point's short name. A differently-named branch would otherwise
  // auto-track the remote under git's default branch.autoSetupMerge, and
  // GitStudio's push then targets that remote branch.
  const short = startPoint ? shortNameOf(startPoint) : undefined;
  await askFolderAndCreate(
    a,
    {
      branchName: name,
      folderName: name,
      newBranch: true,
      startPoint,
      noTrack: !!startPoint && short !== undefined && name !== short,
    },
    refresh,
  );
}

/**
 * Ask for the new branch's name — again, saying why, while the name is one
 * refs/heads/ already has: git would refuse it ("a branch named … already
 * exists") only after the folder was chosen.
 */
async function askNewBranchName(a: RepoEntry, hint: string): Promise<string | undefined> {
  let why = hint;
  let value: string | undefined;
  for (;;) {
    const name = await promptInput({
      title: "New worktree branch",
      hint: why,
      placeholder: "feature/worktree",
      value,
      confirmLabel: "Continue",
      validate: "refName",
    });
    if (!name) {
      return undefined;
    }
    const taken = await a.ctx.process.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (taken.code !== 0) {
      return name;
    }
    why = `A branch named ${name} already exists — choose another name. ${hint}`;
    value = name;
  }
}

/** A folder `git worktree add` can create the worktree in: absent, or empty. */
function folderIsFree(p: string): boolean {
  if (!existsSync(p)) {
    return true;
  }
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false; // a file, or unreadable
  }
}

/** The project's name: the main worktree's folder, a bare repository's without ".git". */
export function projectName(mainPath: string): string {
  const base = path.basename(mainPath);
  return base.endsWith(".git") && base.length > 4 ? base.slice(0, -4) : base;
}

/**
 * The bare-repository layout: the repository in a hidden folder inside the
 * project (project/.bare, or project/.git), and its worktrees beside it in the
 * project's folder (project/main, project/feature-x).
 */
function bareInsideProject(mainPath: string, bare: boolean): boolean {
  return bare && path.basename(mainPath).startsWith(".");
}

/**
 * Where a new worktree's folder is suggested: beside the main worktree, named
 * "<project>-<branch>" with the branch's slashes as dashes (feature/login →
 * app-feature-login, so bugfix/login beside it is app-bugfix-login rather than
 * a second "login"). The first of name, name-2, name-3… that is free. In the
 * bare-repository layout (`bare`, the repository in project/.bare) the
 * worktrees live in the project's folder: project/feature-login — never a
 * hidden ".bare-feature-login".
 */
export function suggestWorktreeFolder(
  mainPath: string,
  folderName: string,
  isFree: (p: string) => boolean = folderIsFree,
  bare = false,
): string {
  const parent = path.dirname(mainPath);
  const branch = folderName.replace(/[\\/]+/g, "-");
  const leaf = bareInsideProject(mainPath, bare) ? branch : `${projectName(mainPath)}-${branch}`;
  for (let i = 1; i < 100; i++) {
    const p = path.join(parent, i === 1 ? leaf : `${leaf}-${i}`);
    if (isFree(p)) return p;
  }
  return path.join(parent, leaf);
}

/** A typed folder: ~ is home, and a relative one is beside the main worktree. */
function resolveTyped(typed: string, mainPath: string): string {
  const t = typed.trim();
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) {
    return path.join(homedir(), t.slice(1));
  }
  return path.isAbsolute(t) ? path.normalize(t) : path.resolve(path.dirname(mainPath), t);
}

/**
 * Ask where the new worktree's folder goes — the suggested sibling folder,
 * pre-filled and editable — and create it there. A folder that is taken, or
 * that git still keeps for a worktree whose folder is gone, is refused before
 * git runs and asked again with why.
 */
async function askFolderAndCreate(
  a: RepoEntry,
  opts: {
    branchName: string;
    /** What the folder is named for: the branch, or the ref checked out. */
    folderName: string;
    newBranch: boolean;
    startPoint?: string;
    noTrack?: boolean;
  },
  refresh: () => void,
): Promise<void> {
  const list = await a.ctx.worktrees.list();
  const mainPath = list[0]?.path ?? a.root;
  const bare = !!list[0]?.bare;
  const suggested = suggestWorktreeFolder(mainPath, opts.folderName, folderIsFree, bare);
  const intro = `The new worktree's folder. Suggested ${bareInsideProject(mainPath, bare) ? "in the project's folder" : "beside the main worktree"}, as ${path.basename(suggested)}; change it if you like — it must not exist yet, or be empty.`;
  let hint = intro;
  let value = suggested;
  let target: string;
  for (;;) {
    const typed = await promptInput({
      title: `New worktree for ${opts.branchName}`,
      hint,
      value,
      placeholder: suggested,
      confirmLabel: "Create Worktree",
      validate: "nonEmpty",
    });
    if (typed === undefined) {
      return;
    }
    target = resolveTyped(typed, mainPath);
    value = typed;
    // git refuses a folder that has anything in it — and with -b it has made
    // the branch by then. Said before anything runs.
    if (!folderIsFree(target)) {
      hint = `${tildify(target)} already exists and isn't empty — choose another folder. ${intro}`;
      continue;
    }
    // Free on disk, but still a worktree to git — the "folder missing" row
    // the view shows. git refuses it ("a missing but already registered
    // worktree; use 'add -f'", advice this view does not offer).
    const holder = (await a.ctx.worktrees.list()).find((e) => sameFolder(e.path, target));
    if (holder) {
      const gone = !existsSync(holder.path);
      hint = `git still has a worktree at ${tildify(target)} (${holder.branch ?? `detached at ${holder.head.slice(0, 7)}`})${gone ? ", though its folder is gone" : ""} — ${gone ? "forget" : "remove"} that worktree in Worktrees, or choose another folder. ${intro}`;
      continue;
    }
    break;
  }

  const result = await a.ctx.worktrees.add(target, opts.branchName, {
    newBranch: opts.newBranch,
    startPoint: opts.startPoint,
    noTrack: opts.noTrack,
  });
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `GitStudio: couldn't create the worktree — ${result.stderr.trim() || "git worktree add failed."}`,
    );
    return;
  }
  refresh();
  const open = await vscode.window.showInformationMessage(
    notice(`Created the worktree ${path.basename(target)} at ${tildify(target)}`),
    "Open in New Window",
  );
  if (open === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
      forceNewWindow: true,
    });
  }
}

// ── Remove / Forget ──────────────────────────────────────────────────────────

/**
 * `gitstudio.worktree.remove` and `gitstudio.worktree.forget` — ask, then
 * remove. What removing takes is read BEFORE git runs (WorktreeProvider's
 * removal): the main worktree and the one this window has open are refused in
 * words; a missing folder is forgotten; a dirty one offers Stash & Remove
 * (first — its changes go into the repository's stash) beside Discard Changes
 * and Remove; a branch merged into the default branch can go too ("Also
 * delete the branch", unchecked). The answer runs exactly what it said.
 */
export async function removeWorktree(
  repos: RepoManager,
  t: WorktreeTarget,
  refresh: () => void,
  ui: WorktreeUi = {},
): Promise<void> {
  const r = await resolveTarget(repos, t, "Remove a worktree", (e, main, here) => !e.bare && !main && !here);
  if (!r) {
    refresh();
    return;
  }
  await askAndRemove(repos, r.a, r.entry.path, worktreeLabel(r.entry), refresh, ui);
}

/** The default branch a branch is fully merged into: how it reads, and its full ref. */
interface MergedInto {
  name: string;
  ref: string;
}

/**
 * `gitstudio.worktree.forget` — forget git's record of a worktree whose folder
 * is gone, or is there but isn't a worktree any more. Nothing on disk
 * changes. From the palette it offers only those; handed one whose folder is
 * a worktree, it refuses in words — Remove Worktree… is the door that deletes
 * a folder, and a command named Forget never leads to one.
 */
export async function forgetWorktree(
  repos: RepoManager,
  t: WorktreeTarget,
  refresh: () => void,
  ui: WorktreeUi = {},
): Promise<void> {
  const r = await resolveTarget(
    repos,
    t,
    "Forget a worktree",
    (e, main) => !e.bare && !main && (!existsSync(e.path) || isUnlinked(e)),
  );
  if (!r) {
    refresh();
    return;
  }
  const removal = await r.a.ctx.worktrees.removal(r.entry.path);
  if (removal.kind === "present") {
    void vscode.window.showInformationMessage(
      `GitStudio: ${worktreeLabel(r.entry)}'s folder is there, so there's nothing to forget. Remove Worktree… removes it, folder and all.`,
    );
    return;
  }
  await askAndRemove(repos, r.a, r.entry.path, worktreeLabel(r.entry), refresh, ui, removal);
}

/** Whether the branch is merged into the default branch — and which that is. */
async function mergedInto(a: RepoEntry, branch: string | undefined): Promise<MergedInto | undefined> {
  if (!branch) {
    return undefined;
  }
  try {
    const snap = await a.ctx.worktrees.snapshot();
    const d = snap.defaultBranch;
    // The default branch is merged into itself: never offered for deletion.
    if (!d || d.local === branch || d.ref === `refs/heads/${branch}`) {
      return undefined;
    }
    const r = await a.ctx.process.run(["merge-base", "--is-ancestor", `refs/heads/${branch}`, d.ref]);
    return r.code === 0 ? { name: d.name, ref: d.ref } : undefined;
  } catch {
    return undefined;
  }
}

async function askAndRemove(
  repos: RepoManager,
  a: RepoEntry,
  at: string,
  label: string,
  refresh: () => void,
  ui: WorktreeUi,
  plan?: WorktreeRemoval,
): Promise<void> {
  const list = await a.ctx.worktrees.list();
  const openHere = [...worktreesOpenHere(list, a.root)].some((p) => sameFolder(p, at));
  const removal = plan ?? (await a.ctx.worktrees.removal(at));
  if (removal.kind === "notListed") {
    void vscode.window.showInformationMessage(`GitStudio: ${worktreeRemovalRefusal("notListed", label)}`);
    ui.drop?.(at);
    refresh();
    return;
  }
  const entry = removal.entry;
  label = worktreeLabel(entry);
  if (removal.kind === "main" || openHere) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${worktreeRemovalRefusal(removal.kind === "main" ? "main" : "current", label)}`,
    );
    return;
  }

  const merged = await mergedInto(a, entry.branch);
  const ask = worktreeRemovalAsk({
    kind: removal.kind,
    label,
    shownPath: shownPath(entry),
    branch: entry.branch,
    head: entry.head,
    locked: !!entry.locked,
    lockReason: entry.lockReason,
    changes: removal.kind === "present" ? removal.changes : [],
    ...(removal.kind === "stale" && entry.prunableReason ? { staleWhy: entry.prunableReason } : {}),
    operation: removal.kind === "present" ? removal.operation : undefined,
    unmerged: removal.kind === "present" ? removal.unmerged : undefined,
    mergedInto: merged?.name,
  });
  const answer = await promptChoose({
    title: ask.title,
    message: ask.message,
    choices: ask.choices.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      icon: c.id === "stash" ? "git-stash" : c.id === "forget" ? "close" : "trash",
      danger: c.danger,
    })),
    options: ask.deleteBranch
      ? [{ id: "deleteBranch", label: ask.deleteBranch.label, description: ask.deleteBranch.description, checked: false }]
      : undefined,
  });
  if (!answer) {
    return;
  }
  const deleteBranch = !!ask.deleteBranch && !!merged && answer.options.includes("deleteBranch");

  // What the question listed goes as it said — and only that. A change made
  // since (an agent still at work in it) is never deleted or stashed unasked:
  // a path the question did not list runs nothing — see removeAsAgreed.
  const listed = removal.kind === "present" ? removal.changes : undefined;
  const pastLock = entry.locked ? { reason: entry.lockReason } : undefined;
  ui.busy?.(entry.path, removal.kind === "present" ? "Removing…" : "Forgetting…");
  let res;
  try {
    res = await a.ctx.worktrees.removeAsAgreed(entry.path, {
      ...(answer.id === "stash"
        ? { stashChanges: { listed, message: worktreeStashMessage(label, shownPath(entry)) } }
        : answer.id === "discard"
          ? { discardChanges: { listed } }
          : {}),
      pastLock,
    });
  } finally {
    ui.busy?.(entry.path, undefined);
  }
  if (res.ok) {
    ui.drop?.(entry.path);
    let said = `${removal.kind === "present" ? "Removed" : "Forgot"} the worktree ${label}`;
    if (res.stashed) {
      said += ` — its changes are in the stash “${worktreeStashMessage(label, shownPath(entry))}”`;
    }
    if (deleteBranch && merged && entry.branch) {
      said += await deleteMergedBranch(repos, a, entry.branch, merged);
    }
    if (res.stashed) {
      void vscode.window.showInformationMessage(`GitStudio: ${said}.`);
    } else {
      flash(said);
    }
    refresh();
    return;
  }
  // Refused: when that is because it changed since the question, ask again
  // with what it holds now — once.
  const discarding = answer.id === "discard" || answer.id === "stash";
  if (removal.kind === "present" && !plan && !res.stashed && (res.changedSince || !discarding)) {
    const now = await a.ctx.worktrees.removal(entry.path);
    if (res.changedSince || (now.kind === "present" && (now.changes === undefined || now.changes.length > 0))) {
      await askAndRemove(repos, a, entry.path, label, refresh, ui, now);
      return;
    }
  }
  if (res.changedSince) {
    void vscode.window.showInformationMessage(`GitStudio: ${worktreeChangedSinceAsked(label)}`);
    refresh();
    return;
  }
  const verb = removal.kind === "present" ? "remove" : "forget";
  void vscode.window.showErrorMessage(
    `GitStudio: couldn't ${verb} the worktree ${label}${res.stashed ? " — its changes were stashed first, and are in the stash list" : ""} — ${res.stderr.trim() || "git worktree failed."}`,
  );
  refresh();
}

/**
 * Delete the branch a removed worktree had, after it was agreed ("Also delete
 * the branch" — offered only for one merged into the default branch). Through
 * the Undo envelope, so it can be put back. Answers what to add to the report.
 *
 * "Fully merged, so no commit is lost" was true when the question opened; it
 * is asked of git again now. A commit made on the branch while the question
 * was open (an agent at work in the worktree) leaves the tree clean, so
 * nothing else notices it — and `branch -D` would leave it dangling.
 */
async function deleteMergedBranch(repos: RepoManager, a: RepoEntry, branch: string, into: MergedInto): Promise<string> {
  const still = await a.ctx.process.run(["merge-base", "--is-ancestor", `refs/heads/${branch}`, into.ref]);
  if (still.code === 1) {
    return `; the branch ${branch} was kept — a commit was made on it while you were asked, and ${into.name} doesn't have it`;
  }
  if (still.code !== 0) {
    return `; the branch ${branch} was kept — git couldn't tell whether it is still merged into ${into.name}`;
  }
  const run = async () => a.ctx.process.run(["branch", "-D", "--", branch]);
  const ledger = repos.getUndoLedger?.();
  const r = ledger
    ? await ledger.runWithUndo(a, `Delete branch ${branch}`, run, { refsOnly: true })
    : await run();
  return r.code === 0
    ? ` and deleted the branch ${branch}`
    : `; the branch ${branch} was kept — ${r.stderr.trim() || "git couldn't delete it"}`;
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/** `gitstudio.worktree.lock` / `.unlock`. Lock asks why (optional). */
export async function lockWorktree(
  repos: RepoManager,
  t: WorktreeTarget,
  lock: boolean,
  refresh: () => void,
  ui: WorktreeUi = {},
): Promise<void> {
  const r = await resolveTarget(
    repos,
    t,
    lock ? "Lock a worktree" : "Unlock a worktree",
    (e, main) => !e.bare && !main && (lock ? !e.locked : !!e.locked),
  );
  if (!r) {
    return;
  }
  const { a, entry } = r;
  const label = worktreeLabel(entry);
  if (!lock) {
    // The view has already painted it unlocked; git's no puts the lock back.
    const res = await a.ctx.worktrees.unlock(entry.path);
    if (res.ok) {
      flash(`Unlocked the worktree ${label}`);
    } else {
      ui.patch?.(entry.path, { locked: true, lockReason: entry.lockReason });
      void vscode.window.showErrorMessage(`GitStudio: couldn't unlock the worktree ${label} — ${res.stderr.trim()}`);
    }
    refresh();
    return;
  }
  if (r.main) {
    void vscode.window.showInformationMessage(`GitStudio: ${label} is the main worktree, which git can't lock.`);
    return;
  }
  const reason = await promptInput({
    title: `Lock worktree ${label}`,
    hint: "Git won't prune, move or remove it until it is unlocked. Say why, so whoever sees the lock knows — or leave it empty.",
    placeholder: "Reason (optional)",
    confirmLabel: "Lock",
  });
  if (reason === undefined) {
    return;
  }
  const said = reason.trim() || undefined;
  ui.patch?.(entry.path, { locked: true, lockReason: said });
  const res = await a.ctx.worktrees.lock(entry.path, { reason });
  if (res.ok) {
    flash(`Locked the worktree ${label}`);
  } else {
    ui.patch?.(entry.path, { locked: false, lockReason: undefined });
    void vscode.window.showErrorMessage(`GitStudio: couldn't lock the worktree ${label} — ${res.stderr.trim()}`);
  }
  refresh();
}

// ── Prune ────────────────────────────────────────────────────────────────────

/**
 * `gitstudio.worktree.prune` — git forgets the worktrees whose folders are
 * gone. Asks first, naming them and how many; says what it forgot, or that
 * there were none. A LOCKED worktree is never pruned: one whose folder is
 * gone is named, with where to forget it.
 */
export async function pruneWorktrees(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const before = await a.ctx.worktrees.list();
  const names = (list: WorktreeEntry[]) =>
    list
      .map((e) => path.basename(e.path))
      .sort((x, y) => x.localeCompare(y))
      .join(", ");
  // git's own verdict — what `git worktree prune` forgets: its .git is gone
  // (with its folder, or from a folder still there) and it is not locked. The
  // same test is applied here for a git too old to say "prunable".
  const noGit = (e: WorktreeEntry, i: number) => i > 0 && !e.bare && (!existsSync(e.path) || isUnlinked(e));
  const prunable = before.filter((e, i) => e.prunable || (noGit(e, i) && !e.locked));
  const locked = before.filter((e, i) => noGit(e, i) && e.locked);
  const allGone = prunable.every((e) => !existsSync(e.path));
  const lockedNote =
    locked.length > 0
      ? ` ${names(locked)} ${locked.length === 1 ? "is" : "are"} locked, so prune keeps ${locked.length === 1 ? "it" : "them"} though ${locked.every((e) => !existsSync(e.path)) ? "the folder is gone" : locked.length === 1 ? "it isn't a worktree any more" : "they aren't worktrees any more"} — forget ${locked.length === 1 ? "it" : "them"} in Worktrees.`
      : "";
  if (prunable.length === 0) {
    void vscode.window.showInformationMessage(
      `GitStudio: Nothing to prune: ${locked.length > 0 ? "the only worktrees git could prune are locked." : "every worktree's folder is still there."}${lockedNote}`,
    );
    return;
  }
  const n = prunable.length;
  const ok = await promptConfirm({
    // The words of the view's link and its title menu ("Prune Missing
    // Worktrees…"); the message says which are gone and which aren't worktrees.
    title: `Prune ${n} missing worktree${n === 1 ? "" : "s"}?`,
    message:
      (allGone
        ? `Git forgets ${n === 1 ? "the worktree whose folder is gone" : `the ${n} worktrees whose folders are gone`}:\n`
        : `Git forgets ${n === 1 ? "the worktree whose folder is gone or isn't a worktree any more" : `the ${n} worktrees whose folders are gone or aren't worktrees any more`}:\n`) +
      prunable
        .slice(0, 8)
        .map((e) => `  ${path.basename(e.path)} — ${shownPath(e)}${allGone ? "" : existsSync(e.path) ? " (not a worktree any more)" : " (folder gone)"}`)
        .join("\n") +
      (n > 8 ? `\n  and ${n - 8} more` : "") +
      "\n\nNothing on disk changes, and their branches stay." +
      (locked.length > 0 ? `\n\n${lockedNote.trim()}` : ""),
    confirmLabel: `Prune ${n}`,
  });
  if (!ok) {
    return;
  }
  const result = await a.ctx.worktrees.prune();
  if (!result.ok) {
    void vscode.window.showErrorMessage(`GitStudio: couldn't prune — ${result.stderr.trim()}`);
    refresh();
    return;
  }
  const after = await a.ctx.worktrees.list();
  const pruned = before.filter((e) => !after.some((x) => sameFolder(x.path, e.path)));
  flash(
    pruned.length > 0
      ? `Pruned ${pruned.length} worktree${pruned.length === 1 ? "" : "s"}${allGone ? " whose folder was gone" : ""}: ${names(pruned)}`
      : "Nothing was pruned",
  );
  refresh();
}

// ── Pull, in its own folder ──────────────────────────────────────────────────

/**
 * Pull into a worktree, in ITS folder — the same flow as every pull door:
 * refused over an operation still paused there or a detached HEAD, asked
 * Stash & Retry over uncommitted work in the way, asked Merge or Rebase when
 * both sides moved. The worktree this window has open pulls through the
 * status bar's Pull, which is that flow for the active repository.
 *
 * pause-notice-reviewed: a stop here is in ANOTHER worktree. notifyPaused's
 * Resolve Conflicts… opens this window's dashboard, for this window's
 * repository — so the stop is said in the engine's words (pullPauseMessage)
 * with Open in New Window, where that worktree's conflicts are resolved.
 */
export async function pullWorktree(
  repos: RepoManager,
  t: WorktreeTarget,
  refresh: () => void,
  ui: WorktreeUi = {},
): Promise<void> {
  const r = await resolveTarget(repos, t, "Pull into a worktree", (e) => !e.bare && !!e.branch && existsSync(e.path) && !isUnlinked(e));
  if (!r || saidNotAWorktree(r.entry)) {
    return;
  }
  if (sameFolder(r.a.root, r.entry.path)) {
    await vscode.commands.executeCommand("gitstudio.sync.pull");
    refresh();
    return;
  }
  const name = path.basename(r.entry.path);
  const w = worktreeEntry(repos, r.entry.path);
  if (!w) {
    return;
  }
  const inIt = `in the worktree ${name}`;
  const open = "Open in New Window";
  const sayThere = (text: string, level: "warning" | "error" = "warning"): void => {
    const show = level === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    void show(`GitStudio: ${text}`, open).then((pick) => {
      if (pick === open) {
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.entry.path), { forceNewWindow: true });
      }
    });
  };
  ui.busy?.(r.entry.path, "Pulling…");
  try {
    const ctx = w.entry.ctx;
    const paused = await ctx.sync.pausedOperation();
    if (paused) {
      sayThere(`Pull ${inIt} didn't run: ${pullPauseMessage({ blocked: paused })}`);
      return;
    }
    const head = await ctx.refs.getHead();
    if (head.detached) {
      sayThere(`Pull ${inIt} didn't run: ${pullDetachedMessage()}`);
      return;
    }
    // pull-stop-reviewed: pull-detached-reviewed: in another worktree — a
    // stop, a block or work in the way is said below through the engine's
    // pullPauseMessage, and a detached HEAD through pullDetachedMessage, each
    // naming the worktree with Open in New Window (see the note above).
    let pulled = await pullOrAsk(ctx);
    if (pulled?.diverged) {
      const mode = await askPullMode(pulled.diverged);
      if (mode === undefined) {
        return;
      }
      // pull-stop-reviewed: pull-detached-reviewed: as above.
      pulled = await pullOrAsk(ctx, mode);
    }
    if (pulled === undefined) {
      return;
    }
    const paused2 = pullPauseMessage(pulled);
    if (paused2) {
      sayThere(`Pull ${inIt}: ${paused2}`);
      return;
    }
    if (pulled.detached) {
      sayThere(`Pull ${inIt} didn't run: ${pullDetachedMessage()}`);
      return;
    }
    if (!pulled.ok) {
      sayThere(`Pull ${inIt} failed — ${pulled.stderr.trim() || "git pull failed."}`, "error");
      return;
    }
    flash(`Pulled the worktree ${name}`);
  } finally {
    ui.busy?.(r.entry.path, undefined);
    w.release();
    refresh();
  }
}

/** The worktree a Push… is for, as the push review needs it — the window's own
 *  repository when that is it. */
export async function pushTargetFor(
  repos: RepoManager,
  t: WorktreeTarget,
): Promise<{ entry: RepoEntry; name: string; shownPath: string; release(): void } | "active" | undefined> {
  const r = await resolveTarget(repos, t, "Push from a worktree", (e) => !e.bare && !!e.branch && existsSync(e.path) && !isUnlinked(e));
  if (!r || saidNotAWorktree(r.entry)) {
    return undefined;
  }
  if (sameFolder(r.a.root, r.entry.path)) {
    return "active";
  }
  const w = worktreeEntry(repos, r.entry.path);
  if (!w) {
    return undefined;
  }
  return { entry: w.entry, name: path.basename(r.entry.path), shownPath: shownPath(r.entry), release: () => w.release() };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000);
}
