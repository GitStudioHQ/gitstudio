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
import * as l10n from "@vscode/l10n";

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
  return entry.bare ? l10n.t("{0} (bare)", folder) : folder;
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
      void vscode.window.showInformationMessage(l10n.t("GitStudio: no worktree this can be done to."));
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
      l10n.t("GitStudio: {0}", worktreeRemovalRefusal("notListed", path.basename(at))),
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
    l10n.t("GitStudio: {0}'s folder is gone — {1}. Forget the worktree in Worktrees to clear it from the list.", worktreeLabel(entry), shownPath(entry)),
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
    l10n.t("GitStudio: {0}'s folder isn't a worktree any more — {1}. Forget the worktree in Worktrees to clear it from the list.", worktreeLabel(entry), shownPath(entry)),
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
    where === "new" ? l10n.t("Open a worktree in a new window") : l10n.t("Open a worktree in this window"),
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
  const r = await resolveTarget(repos, t, l10n.t("Reveal a worktree"), (e) => existsSync(e.path));
  if (!r || saidFolderGone(r.entry)) {
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(r.entry.path));
}

/** A terminal in the worktree's folder, named for it. */
export async function openWorktreeTerminal(repos: RepoManager, t: WorktreeTarget): Promise<void> {
  const r = await resolveTarget(repos, t, l10n.t("Open a terminal in a worktree"), (e) => !e.bare && existsSync(e.path) && !isUnlinked(e));
  if (!r || r.entry.bare || saidNotAWorktree(r.entry)) {
    return;
  }
  const term = vscode.window.createTerminal({ name: path.basename(r.entry.path), cwd: r.entry.path });
  term.show();
}

/** Copy the worktree's folder, whole. */
export async function copyWorktreePath(repos: RepoManager, t: WorktreeTarget): Promise<void> {
  const r = await resolveTarget(repos, t, l10n.t("Copy a worktree's path"), () => true);
  if (!r) {
    return;
  }
  await vscode.env.clipboard.writeText(nativePath(r.entry.path));
  flash(l10n.t("Copied {0}", shownPath(r.entry)));
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
      label: l10n.t("New branch…"),
      icon: "add",
      description: l10n.t("Create a new branch from the current HEAD."),
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
    title: l10n.t("New worktree — pick a ref"),
    hint: l10n.t("What should the new worktree be based on?"),
    choices,
  });
  if (!picked) {
    return;
  }

  if (picked === NEW) {
    const name = await askNewBranchName(
      a,
      l10n.t("The branch is created at the current HEAD and checked out in the new worktree."),
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
      l10n.t("GitStudio: couldn't find {0} in this repository's refs — refresh and try again.", ref.name),
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
        title: l10n.t("Worktree from '{0}'", label),
        hint: l10n.t("Check it out directly, or as a new named branch?"),
        choices: [
          {
            id: "direct",
            label: isLocal ? label : l10n.t("{0} (detached)", label),
            icon: isLocal ? "git-branch" : "git-commit",
            description: isLocal
              ? l10n.t("Check out the existing local branch {0}.", label)
              : l10n.t("Check out {0} as a detached HEAD.", label),
          },
          {
            id: "new",
            label: l10n.t("New branch…"),
            icon: "add",
            description: l10n.t("Create a new local branch starting from {0}.", label),
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

  const created = l10n.t("A new local branch is created from {0} and checked out in the new worktree.", label);
  const name = await askNewBranchName(
    a,
    holder
      ? l10n.t("{0} is checked out in the worktree at {1}, and a branch can be checked out in only one worktree at a time. {2}", label, shownPath(holder), created)
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
      title: l10n.t("New worktree branch"),
      hint: why,
      placeholder: "feature/worktree",
      value,
      confirmLabel: l10n.t("Continue"),
      validate: "refName",
    });
    if (!name) {
      return undefined;
    }
    const taken = await a.ctx.process.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (taken.code !== 0) {
      return name;
    }
    why = l10n.t("A branch named {0} already exists — choose another name. {1}", name, hint);
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
  const intro = l10n.t("The new worktree's folder. Suggested {0}, as {1}; change it if you like — it must not exist yet, or be empty.", bareInsideProject(mainPath, bare) ? l10n.t("in the project's folder") : l10n.t("beside the main worktree"), path.basename(suggested));
  let hint = intro;
  let value = suggested;
  let target: string;
  for (;;) {
    const typed = await promptInput({
      title: l10n.t("New worktree for {0}", opts.branchName),
      hint,
      value,
      placeholder: suggested,
      confirmLabel: l10n.t("Create Worktree"),
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
      hint = l10n.t("{0} already exists and isn't empty — choose another folder. {1}", tildify(target), intro);
      continue;
    }
    // Free on disk, but still a worktree to git — the "folder missing" row
    // the view shows. git refuses it ("a missing but already registered
    // worktree; use 'add -f'", advice this view does not offer).
    const holder = (await a.ctx.worktrees.list()).find((e) => sameFolder(e.path, target));
    if (holder) {
      const gone = !existsSync(holder.path);
      const where = holder.branch ?? l10n.t("detached at {0}", holder.head.slice(0, 7));
      // Whole messages: the clause sits mid-sentence, where a spliced fragment
      // reads wrong once the sentence is Chinese (see the i18n notes).
      hint = gone
        ? l10n.t("git still has a worktree at {0} ({1}), though its folder is gone — {2} that worktree in Worktrees, or choose another folder. {3}", tildify(target), where, l10n.t("forget"), intro)
        : l10n.t("git still has a worktree at {0} ({1}) — {2} that worktree in Worktrees, or choose another folder. {3}", tildify(target), where, l10n.t("remove"), intro);
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
      l10n.t("GitStudio: couldn't create the worktree — {0}", result.stderr.trim() || l10n.t("git worktree add failed.")),
    );
    return;
  }
  refresh();
  const openLabel = l10n.t("Open in New Window");
  const open = await vscode.window.showInformationMessage(
    notice(l10n.t("Created the worktree {0} at {1}", path.basename(target), tildify(target))),
    openLabel,
  );
  if (open === openLabel) {
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
  const r = await resolveTarget(repos, t, l10n.t("Remove a worktree"), (e, main, here) => !e.bare && !main && !here);
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
    l10n.t("Forget a worktree"),
    (e, main) => !e.bare && !main && (!existsSync(e.path) || isUnlinked(e)),
  );
  if (!r) {
    refresh();
    return;
  }
  const removal = await r.a.ctx.worktrees.removal(r.entry.path);
  if (removal.kind === "present") {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: {0}'s folder is there, so there's nothing to forget. Remove Worktree… removes it, folder and all.", worktreeLabel(r.entry)),
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
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", worktreeRemovalRefusal("notListed", label)));
    ui.drop?.(at);
    refresh();
    return;
  }
  const entry = removal.entry;
  label = worktreeLabel(entry);
  if (removal.kind === "main" || openHere) {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: {0}", worktreeRemovalRefusal(removal.kind === "main" ? "main" : "current", label)),
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
  ui.busy?.(entry.path, removal.kind === "present" ? l10n.t("Removing…") : l10n.t("Forgetting…"));
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
    let said = l10n.t("{0} the worktree {1}", removal.kind === "present" ? l10n.t("Removed") : l10n.t("Forgot"), label);
    if (res.stashed) {
      said += l10n.t(" — its changes are in the stash “{0}”", worktreeStashMessage(label, shownPath(entry)));
    }
    if (deleteBranch && merged && entry.branch) {
      said += await deleteMergedBranch(repos, a, entry.branch, merged);
    }
    if (res.stashed) {
      void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}.", said));
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
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", worktreeChangedSinceAsked(label)));
    refresh();
    return;
  }
  const verb = removal.kind === "present" ? "remove" : "forget";
  const why = res.stderr.trim() || "git worktree failed.";
  void vscode.window.showErrorMessage(
    res.stashed
      ? l10n.t("GitStudio: couldn't {0} the worktree {1} — its changes were stashed first, and are in the stash list — {2}", verb, label, why)
      : l10n.t("GitStudio: couldn't {0} the worktree {1} — {2}", verb, label, why),
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
    return l10n.t("; the branch {0} was kept — a commit was made on it while you were asked, and {1} doesn't have it", branch, into.name);
  }
  if (still.code !== 0) {
    return l10n.t("; the branch {0} was kept — git couldn't tell whether it is still merged into {1}", branch, into.name);
  }
  const run = async () => a.ctx.process.run(["branch", "-D", "--", branch]);
  const ledger = repos.getUndoLedger?.();
  const r = ledger
    ? await ledger.runWithUndo(a, l10n.t("Delete branch {0}", branch), run, { refsOnly: true })
    : await run();
  return r.code === 0
    ? l10n.t(" and deleted the branch {0}", branch)
    : `; the branch ${branch} was kept — ${r.stderr.trim() || l10n.t("git couldn't delete it")}`;
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
    lock ? l10n.t("Lock a worktree") : l10n.t("Unlock a worktree"),
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
      flash(l10n.t("Unlocked the worktree {0}", label));
    } else {
      ui.patch?.(entry.path, { locked: true, lockReason: entry.lockReason });
      void vscode.window.showErrorMessage(l10n.t("GitStudio: couldn't unlock the worktree {0} — {1}", label, res.stderr.trim()));
    }
    refresh();
    return;
  }
  if (r.main) {
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0} is the main worktree, which git can't lock.", label));
    return;
  }
  const reason = await promptInput({
    title: l10n.t("Lock worktree {0}", label),
    hint: l10n.t("Git won't prune, move or remove it until it is unlocked. Say why, so whoever sees the lock knows — or leave it empty."),
    placeholder: l10n.t("Reason (optional)"),
    confirmLabel: l10n.t("Lock"),
  });
  if (reason === undefined) {
    return;
  }
  const said = reason.trim() || undefined;
  ui.patch?.(entry.path, { locked: true, lockReason: said });
  const res = await a.ctx.worktrees.lock(entry.path, { reason });
  if (res.ok) {
    flash(l10n.t("Locked the worktree {0}", label));
  } else {
    ui.patch?.(entry.path, { locked: false, lockReason: undefined });
    void vscode.window.showErrorMessage(l10n.t("GitStudio: couldn't lock the worktree {0} — {1}", label, res.stderr.trim()));
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
      ? l10n.t(" {0} {1} locked, so prune keeps {2} though {3} — forget {4} in Worktrees.", names(locked), locked.length === 1 ? l10n.t("is") : l10n.t("are"), locked.length === 1 ? l10n.t("it") : l10n.t("them"), locked.every((e) => !existsSync(e.path)) ? l10n.t("the folder is gone") : locked.length === 1 ? l10n.t("it isn't a worktree any more") : l10n.t("they aren't worktrees any more"), locked.length === 1 ? l10n.t("it") : l10n.t("them"))
      : "";
  if (prunable.length === 0) {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: Nothing to prune: {0}{1}", locked.length > 0 ? l10n.t("the only worktrees git could prune are locked.") : l10n.t("every worktree's folder is still there."), lockedNote),
    );
    return;
  }
  const n = prunable.length;
  const ok = await promptConfirm({
    // The words of the view's link and its title menu ("Prune Missing
    // Worktrees…"); the message says which are gone and which aren't worktrees.
    title: n === 1 ? l10n.t("Prune 1 missing worktree?") : l10n.t("Prune {0} missing worktrees?", n),
    message:
      (allGone
        ? l10n.t("Git forgets {0}:\n", n === 1 ? l10n.t("the worktree whose folder is gone") : l10n.t("the {0} worktrees whose folders are gone", n))
        : l10n.t("Git forgets {0}:\n", n === 1 ? l10n.t("the worktree whose folder is gone or isn't a worktree any more") : l10n.t("the {0} worktrees whose folders are gone or aren't worktrees any more", n))) +
      prunable
        .slice(0, 8)
        .map((e) => `  ${path.basename(e.path)} — ${shownPath(e)}${allGone ? "" : existsSync(e.path) ? l10n.t(" (not a worktree any more)") : l10n.t(" (folder gone)")}`)
        .join("\n") +
      (n > 8 ? `\n  and ${n - 8} more` : "") +
      l10n.t("\n\nNothing on disk changes, and their branches stay.") +
      (locked.length > 0 ? `\n\n${lockedNote.trim()}` : ""),
    confirmLabel: l10n.t("Prune {0}", n),
  });
  if (!ok) {
    return;
  }
  const result = await a.ctx.worktrees.prune();
  if (!result.ok) {
    void vscode.window.showErrorMessage(l10n.t("GitStudio: couldn't prune — {0}", result.stderr.trim()));
    refresh();
    return;
  }
  const after = await a.ctx.worktrees.list();
  const pruned = before.filter((e) => !after.some((x) => sameFolder(x.path, e.path)));
  flash(
    pruned.length > 0
      ? pruned.length === 1
        ? allGone
          ? l10n.t("Pruned 1 worktree whose folder was gone: {0}", names(pruned))
          : l10n.t("Pruned 1 worktree: {0}", names(pruned))
        : allGone
          ? l10n.t("Pruned {0} worktrees whose folder was gone: {1}", pruned.length, names(pruned))
          : l10n.t("Pruned {0} worktrees: {1}", pruned.length, names(pruned))
      : l10n.t("Nothing was pruned"),
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
  const r = await resolveTarget(repos, t, l10n.t("Pull into a worktree"), (e) => !e.bare && !!e.branch && existsSync(e.path) && !isUnlinked(e));
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
  const inIt = l10n.t("in the worktree {0}", name);
  const open = l10n.t("Open in New Window");
  const sayThere = (text: string, level: "warning" | "error" = "warning"): void => {
    const show = level === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    void show(l10n.t("GitStudio: {0}", text), open).then((pick) => {
      if (pick === open) {
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.entry.path), { forceNewWindow: true });
      }
    });
  };
  ui.busy?.(r.entry.path, l10n.t("Pulling…"));
  try {
    const ctx = w.entry.ctx;
    const paused = await ctx.sync.pausedOperation();
    if (paused) {
      sayThere(l10n.t("Pull {0} didn't run: {1}", inIt, pullPauseMessage({ blocked: paused }) ?? ""));
      return;
    }
    const head = await ctx.refs.getHead();
    if (head.detached) {
      sayThere(l10n.t("Pull {0} didn't run: {1}", inIt, pullDetachedMessage()));
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
      sayThere(l10n.t("Pull {0}: {1}", inIt, paused2));
      return;
    }
    if (pulled.detached) {
      sayThere(l10n.t("Pull {0} didn't run: {1}", inIt, pullDetachedMessage()));
      return;
    }
    if (!pulled.ok) {
      sayThere(l10n.t("Pull {0} failed — {1}", inIt, pulled.stderr.trim() || "git pull failed."), "error");
      return;
    }
    flash(l10n.t("Pulled the worktree {0}", name));
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
  const r = await resolveTarget(repos, t, l10n.t("Push from a worktree"), (e) => !e.bare && !!e.branch && existsSync(e.path) && !isUnlinked(e));
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
  void vscode.window.setStatusBarMessage(l10n.t("$(check) {0}", message), 3000);
}
