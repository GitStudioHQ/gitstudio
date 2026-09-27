import * as vscode from "vscode";
import {
  promptConfirm,
  promptInput,
  promptPick,
  type DialogChoice,
} from "../ui/dialogs";
import { codeSpan } from "../ui/markdownCode";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { WorktreeEntry, GitRef } from "@gitstudio/git-service/index";
import { optionLikeCheckout } from "@gitstudio/git-service/checkoutRef";
import { tildify } from "./branchElsewhere";
import type { WorktreeRemoval } from "@gitstudio/git-service/WorktreeProvider";
import { folderKey, nativePath, sameFolder } from "@gitstudio/git-service/folderPath";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { worktreeChangedSinceAsked, worktreeRemovalQuestion, worktreeRemovalRefusal } from "@gitstudio/host-bridge/worktreeRemoval";
import { bareName, shortNameOf, startPointOf, worktreeRefFor } from "./worktreeRefs";

// The Worktrees pillar — also absent from free VS Code. Each row is a linked (or
// the main) worktree; actions cover open / add / remove / lock / unlock / prune.

/** Where a row stands, beyond what `git worktree list` says about it. */
export interface WorktreeRowState {
  /** Open in this window: the active repository's root, or the worktree a
   *  folder of this window's workspace lies in. Its folder is never removed
   *  from under the window. */
  current: boolean;
  /** The main worktree — git lists it first. It holds the repository itself,
   *  so git never removes (or locks) it. */
  main: boolean;
  /** Its folder is gone. A locked one never reads `prunable` in git's list,
   *  so this is the filesystem's answer. */
  missing: boolean;
}

/**
 * A worktree's folder as a person reads it: the system's spelling (git's
 * C:/Users/… is C:\Users\… on Windows), with ~ for home where that is how
 * paths are written. The entry keeps git's own spelling; paths are compared
 * as folders, never by this text.
 */
function shownPath(entry: WorktreeEntry): string {
  return tildify(nativePath(entry.path));
}

/** How a worktree is named: its branch, its detached commit, or "(bare)". */
function worktreeLabel(entry: WorktreeEntry): string {
  return entry.bare ? "(bare)" : entry.branch ?? `${entry.head.slice(0, 7)} (detached)`;
}

/** The words that say where a row stands, in the order the row shows them. */
function rowFlags(entry: WorktreeEntry, state: WorktreeRowState): string[] {
  const flags: string[] = [];
  if (state.current) flags.push("current");
  if (state.main && !entry.bare) flags.push("main worktree");
  if (entry.locked) flags.push("locked");
  if (entry.bare) flags.push("bare");
  if (state.missing) flags.push("folder missing");
  else if (entry.prunable) flags.push("prunable");
  return flags;
}

/**
 * The row's contextValue — what package.json's menus key on. Built from the
 * row's state so each menu entry can name exactly the rows it belongs to:
 * `gitstudio.worktree[.current][.main][.missing][.locked]`, or
 * `gitstudio.worktree.bare` for a bare repository's entry, which offers nothing.
 * A plain linked row stays `gitstudio.worktree` / `gitstudio.worktree.locked`.
 */
function rowContext(entry: WorktreeEntry, state: WorktreeRowState): string {
  if (entry.bare) {
    return "gitstudio.worktree.bare";
  }
  return [
    "gitstudio.worktree",
    state.current ? "current" : "",
    state.main ? "main" : "",
    state.missing ? "missing" : "",
    entry.locked ? "locked" : "",
  ]
    .filter(Boolean)
    .join(".");
}

/** One worktree row. */
export class WorktreeNode extends vscode.TreeItem {
  readonly kind = "worktree" as const;
  constructor(
    readonly entry: WorktreeEntry,
    readonly state: WorktreeRowState,
  ) {
    super(worktreeLabel(entry), vscode.TreeItemCollapsibleState.None);

    // Description leads with status flags (current first), then the path.
    const flags = rowFlags(entry, state);
    const path = shownPath(entry);
    this.description = flags.length > 0 ? `${flags.join(" · ")} · ${path}` : path;

    // Icon conveys status: current worktree gets an accent, a missing folder
    // warns, locked shows a lock, otherwise the branch, the detached commit
    // (the symbol its tooltip leads with), or the bare repository.
    if (state.current) {
      this.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
    } else if (state.missing || entry.prunable) {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.yellow"),
      );
    } else if (entry.locked) {
      this.iconPath = new vscode.ThemeIcon("lock");
    } else {
      this.iconPath = new vscode.ThemeIcon(
        entry.bare ? "archive" : entry.branch ? "git-branch" : "git-commit",
      );
    }
    this.resourceUri = vscode.Uri.file(entry.path);
    this.contextValue = rowContext(entry, state);
    this.tooltip = buildTooltip(entry, state);
    // A click opens the worktree — only one there is a folder to open, and not
    // the one this window already has open.
    if (!entry.bare && !state.current && !state.missing) {
      this.command = {
        command: "gitstudio.worktree.open",
        title: "Open Worktree",
        arguments: [this],
      };
    }
  }
}

function buildTooltip(
  entry: WorktreeEntry,
  state: WorktreeRowState,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  const headIcon = entry.bare
    ? "$(archive)"
    : entry.branch
      ? "$(git-branch)"
      : "$(git-commit)";
  md.appendMarkdown(`${headIcon} **${escapeMarkdown(worktreeLabel(entry))}**\n\n`);
  md.appendMarkdown(`$(folder) ${codeSpan(nativePath(entry.path))}`);
  if (entry.head) {
    md.appendMarkdown(`\n\n$(git-commit) ${codeSpan(entry.head.slice(0, 7))}`);
  }
  const flags = rowFlags(entry, state);
  if (flags.length > 0) {
    md.appendMarkdown(`\n\n${flags.join(" · ")}`);
  }
  if (entry.lockReason) {
    md.appendMarkdown(`\n\n$(lock) Locked: ${escapeMarkdown(entry.lockReason)}`);
  }
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
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

/** Each listed worktree's row state, for a window whose active root is `root`. */
function rowStates(list: readonly WorktreeEntry[], root: string): WorktreeRowState[] {
  const here = worktreesOpenHere(list, root);
  return list.map((e, i) => ({
    current: here.has(e.path),
    main: i === 0,
    missing: !e.bare && !existsSync(e.path),
  }));
}

/**
 * Feeds the Worktrees tree. The worktrees this window has open (the active
 * repo's root, and the workspace's folders) are flagged as current.
 * Refreshes on RepoManager.onDidChange.
 */
export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<WorktreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<WorktreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * A short-TTL cache of the worktree list. RepoManager's change event is a
   * firehose — it fires on every ref write (commits, fetches, branch updates) —
   * but worktree membership changes rarely, so serving a cached list for a few
   * seconds avoids re-spawning `git worktree list` on every unrelated git poke.
   * An explicit refresh() (a worktree add/remove, or the refresh button) busts
   * it, so real changes still show immediately.
   */
  private cache: { root: string; at: number; nodes: WorktreeNode[] } | undefined;
  private static readonly TTL_MS = 4000;
  /**
   * Set by refresh() (a worktree add/remove/lock/prune, or the refresh button)
   * so the very next getChildren skips the persisted seed and awaits a fresh
   * `git worktree list` — after a mutation the persisted list is stale by one
   * entry, and we don't want it to flash before the fresh list lands.
   */
  private forceFresh = false;
  /** In-flight `git worktree list` for a root, so prewarm() and VS Code's own
   * first render (which fire getChildren twice in quick succession) share ONE
   * spawn instead of racing two concurrent ones. */
  private inflight: { root: string; p: Promise<WorktreeEntry[]> } | undefined;

  constructor(
    private readonly repos: RepoManager,
    /** workspaceState — persists the last worktree list across window reloads
     * so the FIRST paint of a session is instant instead of paying a cold
     * `git worktree list` spawn (the in-memory cache is empty on every reload). */
    private readonly store: vscode.Memento,
  ) {
    // Passive repo changes just re-emit; getChildren serves the cache (below).
    this.disposables.push(
      this.repos.onDidChange(() => this.emitter.fire(undefined)),
    );
  }

  refresh(): void {
    this.cache = undefined;
    this.forceFresh = true;
    this.emitter.fire(undefined);
  }

  /** Warm the in-memory cache off the reveal path (called right after the view
   * is created) so a cold spawn overlaps activation instead of blocking first
   * reveal. Fire-and-forget; errors are swallowed by getChildren. */
  prewarm(): void {
    void this.getChildren();
  }

  getTreeItem(element: WorktreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorktreeNode): Promise<WorktreeNode[]> {
    if (element) {
      return [];
    }
    const a = this.repos.getActive();
    if (!a) {
      this.cache = undefined;
      return [];
    }
    const now = Date.now();
    if (
      this.cache &&
      this.cache.root === a.root &&
      now - this.cache.at < WorktreesTreeProvider.TTL_MS
    ) {
      return this.cache.nodes;
    }
    // Cross-session cold start: seed from the persisted list for an instant
    // first paint, then revalidate in the background. Skipped right after an
    // explicit refresh (forceFresh) so mutations never flash a stale entry.
    if (!this.cache && !this.forceFresh) {
      const persisted = this.store.get<WorktreeEntry[]>(this.storeKey(a.root));
      if (persisted && persisted.length) {
        const nodes = this.buildNodes(persisted, a.root);
        // Seed as a normal fresh cache entry so VS Code's own first render
        // cache-HITS this instead of falling through to a second fetch; the
        // background revalidate below is the only thing that touches git.
        this.cache = { root: a.root, at: now, nodes };
        void this.revalidate(a);
        return nodes;
      }
    }
    this.forceFresh = false;
    return this.fetch(a, now);
  }

  private storeKey(root: string): string {
    return `gitstudio.worktrees:${root}`;
  }

  private buildNodes(list: WorktreeEntry[], root: string): WorktreeNode[] {
    const states = rowStates(list, root);
    return list.map((e, i) => new WorktreeNode(e, states[i]));
  }

  /** Dedup the git spawn: concurrent callers for the same root share one list. */
  private listOnce(a: RepoEntry): Promise<WorktreeEntry[]> {
    if (this.inflight && this.inflight.root === a.root) {
      return this.inflight.p;
    }
    const p = a.ctx.worktrees.list();
    this.inflight = { root: a.root, p };
    const clear = (): void => {
      if (this.inflight && this.inflight.p === p) {
        this.inflight = undefined;
      }
    };
    p.then(clear, clear);
    return p;
  }

  /** Stable signature of a worktree list, to skip needless repaints. */
  private signature(list: WorktreeEntry[]): string {
    return list
      .map(
        (e) =>
          `${e.path}\u0000${e.head}\u0000${e.branch ?? ""}\u0000${e.lockReason ?? ""}\u0000${e.bare ? 1 : 0}${e.locked ? 1 : 0}${e.prunable ? 1 : 0}`,
      )
      .join("");
  }

  /** Awaited fetch — used for the first-ever load of a repo and after refresh. */
  private async fetch(a: RepoEntry, at: number): Promise<WorktreeNode[]> {
    try {
      const list = await this.listOnce(a);
      // An empty result means a failed read: a valid repo always lists at least
      // its own main worktree. Keep the last good list rather than blanking it
      // (and don't clobber the persisted seed with []).
      if (list.length === 0) {
        return this.cache && this.cache.root === a.root ? this.cache.nodes : [];
      }
      const nodes = this.buildNodes(list, a.root);
      this.cache = { root: a.root, at, nodes };
      void this.store.update(this.storeKey(a.root), list);
      return nodes;
    } catch {
      // Keep showing the last good list for this repo if we have one.
      return this.cache && this.cache.root === a.root ? this.cache.nodes : [];
    }
  }

  /** Background refresh behind a seeded (persisted) paint — repaints only on
   * an actual change so an unchanged list doesn't flicker the whole tree. */
  private async revalidate(a: RepoEntry): Promise<void> {
    try {
      const prevSig = this.signature(
        this.store.get<WorktreeEntry[]>(this.storeKey(a.root)) ?? [],
      );
      const list = await this.listOnce(a);
      if (list.length === 0) {
        return; // failed read — keep the seeded/last-good list
      }
      const nodes = this.buildNodes(list, a.root);
      this.cache = { root: a.root, at: Date.now(), nodes };
      void this.store.update(this.storeKey(a.root), list);
      if (this.signature(list) !== prevSig) {
        this.emitter.fire(undefined);
      }
    } catch {
      // Keep the seeded view; a later change event will retry.
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

/**
 * A window on a folder that is not there opens onto nothing. The row offers no
 * Open then; this is the door a stale row (or a keybinding) still reaches.
 * Says so — naming the folder as its row does — and answers true when the
 * folder is gone.
 */
function saidFolderGone(node: WorktreeNode): boolean {
  if (existsSync(node.entry.path)) {
    return false;
  }
  void vscode.window.showWarningMessage(
    `GitStudio: ${worktreeLabel(node.entry)}'s folder is gone — ${shownPath(node.entry)}. Use Forget Worktree on its row to clear it from the list.`,
  );
  return true;
}

/**
 * `gitstudio.worktree.openInNewWindow` / `gitstudio.worktree.openHere` — open
 * the worktree's folder where the control says, with no question first. The
 * row's inline button is Open in New Window; Open in This Window is in its
 * menu, never on the row of the worktree this window already has open.
 */
export async function openWorktreeIn(node: WorktreeNode, where: "new" | "here"): Promise<void> {
  if (!node || node.entry.bare || saidFolderGone(node)) {
    return;
  }
  if (where === "here" && node.state.current) {
    return; // it is the one open here
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(node.entry.path), {
    forceNewWindow: where === "new",
  });
}

/** `gitstudio.worktree.open` — a row's click: asks which window. */
export async function openWorktree(node: WorktreeNode): Promise<void> {
  if (!node || node.entry.bare || saidFolderGone(node)) {
    return;
  }
  const label = worktreeLabel(node.entry);
  const uri = vscode.Uri.file(node.entry.path);
  const choices: DialogChoice[] = [{ id: "new", label: "Open in New Window", icon: "window" }];
  // Not on the worktree this window already has open: "This Window" would
  // only reopen it.
  if (!node.state.current) {
    choices.push({
      id: "here",
      label: "Open in This Window",
      icon: "arrow-right",
      description: "Replaces what is currently open.",
    });
  }
  const choice = await promptPick({
    title: `Open worktree ${label}`,
    // Where it is, as its row says it; `uri` (git's spelling) is what opens.
    hint: shownPath(node.entry),
    choices,
  });
  if (choice === undefined) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: choice === "new",
  });
}

/** `gitstudio.worktree.add` — pick a ref (branch/remote/tag, or a new one) + a folder. */
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
    await pickFolderAndCreate(
      a,
      { branchName: name, folderName: name, newBranch: true },
      refresh,
    );
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

  // The branch-menu webview sends name + type only (no fullName). Re-resolve the
  // authoritative fullName from listRefs() so the start point and the direct
  // checkout are exact even when git disambiguated the short name: a genuine
  // branch named "heads/x" and a collision-prefixed name are string-identical,
  // so name-based stripping alone would mis-strip one of them.
  // The same lookup the checkout doors use (worktreeRefFor). Unresolved — the
  // ref is gone, or the listing failed — the flow STOPS. It used to keep the
  // webview's short name and let bareName/startPointOf guess from it: strip a
  // "heads/" (which a branch genuinely called heads/x also starts with) and
  // rebuild refs/heads/<rest>, i.e. invent a full name — the one thing every
  // other door has stopped doing (issue #30's follow-up).
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
    await pickFolderAndCreate(
      a,
      { branchName: directRef, folderName: label, newBranch: false },
      refresh,
    );
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
  await pickFolderAndCreate(
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
 * exists") only after the folder was picked.
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

/**
 * Pick a parent folder, then add the worktree in a subfolder named after the
 * whole branch (feature/login → feature-login, so bugfix/login beside it is
 * bugfix-login rather than a second "login") and report the outcome. Shared by
 * every create route so the folder/dir-naming logic stays in exactly one place.
 */
async function pickFolderAndCreate(
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
  // When gitstudio.worktrees.prefixWithProjectName is on, prefix it with the
  // MAIN repository's folder name — resolved from `git worktree list` (whose
  // first entry is always the main checkout), so the prefix is stable no
  // matter which (possibly linked) worktree initiated the add.
  const leaf = opts.folderName.replace(/\//g, "-");
  let dirName = leaf;
  const prefixEnabled = vscode.workspace
    .getConfiguration("gitstudio")
    .get<boolean>("worktrees.prefixWithProjectName", false);
  if (prefixEnabled) {
    const mainRoot = await a.ctx.worktrees.mainRoot();
    if (mainRoot) {
      const project = path.basename(mainRoot);
      if (project) {
        dirName = `${project}-${leaf}`;
      }
    }
  }

  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: `Create '${dirName}' Here`,
    title: `Choose the folder to create the new worktree's folder, '${dirName}', in`,
  });
  const parent = folders?.[0];
  if (!parent) {
    return;
  }
  const target = vscode.Uri.joinPath(parent, dirName);
  // git refuses a folder that has anything in it — and with -b it has made
  // the branch by then. Say it before anything runs.
  if (!folderIsFree(target.fsPath)) {
    void vscode.window.showWarningMessage(
      `GitStudio: ${target.fsPath} already exists, so nothing was created. Choose another folder for the worktree.`,
    );
    return;
  }
  // Free on disk, but still a worktree to git — the "folder missing" row this
  // view shows. git refuses it ("a missing but already registered worktree;
  // use 'add -f'", advice this view does not offer), so say whose it is.
  const holder = (await a.ctx.worktrees.list()).find((e) => sameFolder(e.path, target.fsPath));
  if (holder) {
    const gone = !existsSync(holder.path);
    void vscode.window.showWarningMessage(
      `GitStudio: git still has a worktree at ${target.fsPath} (${worktreeLabel(holder)})${gone ? ", though its folder is gone," : ","} so nothing was created. ${gone ? "Forget" : "Remove"} that worktree in Worktrees, or choose another folder.`,
    );
    return;
  }

  const result = await a.ctx.worktrees.add(target.fsPath, opts.branchName, {
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
    `Created worktree at ${target.fsPath}`,
    "Open in New Window",
  );
  if (open === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", target, {
      forceNewWindow: true,
    });
  }
}

/**
 * `gitstudio.worktree.remove` and `gitstudio.worktree.forget` — ask, then
 * remove. What removing takes is read BEFORE git runs (WorktreeProvider's
 * removal): the main worktree and the one this window has open are refused in
 * words; a missing folder is forgotten; a locked or dirty one says so — its
 * lock's reason, the files that will be lost — in the one question asked, and
 * the answer runs exactly what it said.
 */
export async function removeWorktree(
  repos: RepoManager,
  node: WorktreeNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  await askAndRemove(a, node.entry.path, worktreeLabel(node.entry), refresh);
}

async function askAndRemove(
  a: RepoEntry,
  at: string,
  label: string,
  refresh: () => void,
  plan?: WorktreeRemoval,
): Promise<void> {
  const list = await a.ctx.worktrees.list();
  const openHere = [...worktreesOpenHere(list, a.root)].some((p) => sameFolder(p, at));
  const removal = plan ?? (await a.ctx.worktrees.removal(at));
  if (removal.kind === "notListed") {
    void vscode.window.showInformationMessage(`GitStudio: ${worktreeRemovalRefusal("notListed", label)}`);
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

  const q = worktreeRemovalQuestion({
    kind: removal.kind,
    label,
    shownPath: shownPath(entry),
    branch: entry.branch,
    head: entry.head,
    locked: !!entry.locked,
    lockReason: entry.lockReason,
    changes: removal.kind === "present" ? removal.changes : [],
    operation: removal.kind === "present" ? removal.operation : undefined,
  });
  const ok = await promptConfirm({
    title: q.title,
    message: q.message,
    confirmLabel: q.confirmLabel,
    danger: q.danger,
  });
  if (!ok) {
    return;
  }

  // What the question listed is lost, as it said — and only that. A change
  // made since (an agent still at work in it) is never deleted unasked: clean
  // when asked, it goes without --force and git refuses; dirty when asked, a
  // path the question did not list runs nothing — see removeAsAgreed.
  const r = await a.ctx.worktrees.removeAsAgreed(entry.path, {
    discardChanges: q.discardChanges
      ? { listed: removal.kind === "present" ? removal.changes : undefined }
      : undefined,
    pastLock: entry.locked ? { reason: entry.lockReason } : undefined,
  });
  const verb = removal.kind === "missing" ? "forget" : "remove";
  if (r.ok) {
    reportRemoval(r, `${removal.kind === "missing" ? "Forgot" : "Removed"} worktree ${label}`, "", refresh);
    return;
  }
  // Refused: when that is because it changed since the question, ask again
  // with what it holds now — once.
  if (removal.kind === "present" && !plan && (r.changedSince || !q.discardChanges)) {
    const now = await a.ctx.worktrees.removal(entry.path);
    if (r.changedSince || (now.kind === "present" && (now.changes === undefined || now.changes.length > 0))) {
      await askAndRemove(a, entry.path, label, refresh, now);
      return;
    }
  }
  if (r.changedSince) {
    void vscode.window.showInformationMessage(`GitStudio: ${worktreeChangedSinceAsked(label)}`);
    refresh();
    return;
  }
  reportRemoval(r, "", `${verb} ${label}`, refresh);
}

function reportRemoval(
  result: { ok: boolean; stderr: string },
  success: string,
  doing: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
    return;
  }
  void vscode.window.showErrorMessage(
    `GitStudio: couldn't ${doing} — ${result.stderr.trim() || "git worktree failed."}`,
  );
  refresh();
}

/** `gitstudio.worktree.lock` / `.unlock`. Lock asks why (optional). */
export async function lockWorktree(
  repos: RepoManager,
  node: WorktreeNode,
  lock: boolean,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const label = worktreeLabel(node.entry);
  if (!lock) {
    report(await a.ctx.worktrees.unlock(node.entry.path), `Unlocked worktree ${label}`, refresh);
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
  report(await a.ctx.worktrees.lock(node.entry.path, { reason }), `Locked worktree ${label}`, refresh);
}

/**
 * `gitstudio.worktree.prune` — git forgets the worktrees whose folders are
 * gone. Says which it forgot, or that there were none: git exits 0 either way,
 * and "Pruned worktrees" over nothing pruned was a claim, not a report. A
 * LOCKED worktree is never pruned; one whose folder is gone is named, with
 * where to forget it.
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
  const result = await a.ctx.worktrees.prune();
  if (!result.ok) {
    report(result, "", refresh);
    return;
  }
  const after = await a.ctx.worktrees.list();
  const pruned = before.filter((e) => !after.some((x) => sameFolder(x.path, e.path)));
  const kept = after.filter((e, i) => i > 0 && !e.bare && e.locked && !existsSync(e.path));
  const names = (list: WorktreeEntry[]) => list.map(worktreeLabel).join(", ");
  const said =
    pruned.length > 0
      ? `Pruned ${pruned.length} worktree${pruned.length === 1 ? "" : "s"} whose folder was gone: ${names(pruned)}.`
      : "Nothing to prune: every worktree's folder is still there.";
  if (kept.length > 0) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${pruned.length > 0 ? said : "Nothing was pruned."} ${names(kept)} ${kept.length === 1 ? "is" : "are"} locked, so prune keeps ${kept.length === 1 ? "it" : "them"} though the folder is gone — use Forget Worktree on ${kept.length === 1 ? "its row" : "their rows"}.`,
    );
  } else {
    flash(said);
  }
  refresh();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function report(
  result: { ok: boolean; stderr: string },
  success: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
  } else {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: worktree operation failed.",
    );
  }
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}
