// The Worktrees view's wire and its words — host-agnostic and node-free.
//
// The extension host builds WorktreeRow from git-service's WorktreeSummary
// (tier 0) and WorktreeStatus (tier 1); the webview renders it. What a row
// SAYS (its one state beside the name, and every fact behind it in its
// tooltip) and what it OFFERS (its capabilities, each refusal with its
// reason) are decided here, once, by pure functions: the page paints them,
// the host refuses by them, and the state-table tests pin them without a
// browser. The desktop's Worktrees list can adopt the same functions.

import * as l10n from "@vscode/l10n";
import type { ChangeCommit, ChangeFile } from "./changeRows";
import { unlinkedWhy } from "./worktreeRemoval";

export type { ChangeCommit, ChangeFile } from "./changeRows";

/** An operation git can be stopped in (git-service's StoppedOperation). */
export type WorktreeOperationName = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

/** Tier 1: what a worktree's working tree holds, once read. */
export interface WorktreeRowStatus {
  /** Paths with any uncommitted change (a file staged and edited again counts once). */
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  operation?: WorktreeOperationName;
  /** Mid-rebase: the branch being rebased (git lists the worktree detached). */
  rebasing?: string;
  /** With no upstream: its commits no remote has (or, with no remote at all,
   *  those the default branch lacks). */
  unpublished?: number;
}

/** One worktree, as its row needs it. */
export interface WorktreeRow {
  /** Its folder, as git lists it — the row's identity in every message. */
  path: string;
  /** The folder's name. */
  name: string;
  /** The folder relative to the main worktree's parent ("app-login", "app/.claude/worktrees/x"). */
  relPath: string;
  /** The whole folder, as the host shows paths (~ for home) — the tooltip. */
  shownPath: string;
  kind: "main" | "linked" | "bare";
  /** The branch checked out, by the name under refs/heads/. */
  branch?: string;
  /** The commit checked out. */
  head: string;
  /** This window has it open. */
  current: boolean;
  locked: boolean;
  lockReason?: string;
  /** Its folder is gone. */
  missing: boolean;
  /** Its folder is there, but it is not a worktree any more (its .git is
   *  gone): git there would read the repository around it, so its tree is
   *  never read, and it can only be forgotten. */
  unlinked: boolean;
  /** What git makes of an unlinked one (its prunable reason); absent for a
   *  locked one, which git never prunes. */
  unlinkedWhy?: string;
  /** Its upstream, as it reads ("origin/feature/x"). */
  upstream?: string;
  /** Configured, but deleted on the remote and pruned here. */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  /** The repository has a remote. */
  hasRemotes: boolean;
  /** How the default branch reads ("origin/main", or "main" with no remote). */
  defaultBranch?: string;
  /** Its branch is the default branch (by its local name). */
  onDefaultBranch: boolean;
  /** Tier 1, once read for this row; absent until then. */
  status?: WorktreeRowStatus;
}

/** How much a fact matters — a CSS token, never a hard colour. */
export type FactTone = "accent" | "neutral" | "info" | "warn" | "danger";

/** One fact about a row: its name in words, how much it matters, and the
 *  sentence behind it — the sentence is what the row's tooltip says. */
export interface WorktreeFact {
  id: string;
  text: string;
  tone: FactTone;
  /** Said on hover and to a screen reader. */
  tip: string;
}

const plural = (n: number, one: string, many: string): string => l10n.t("{0} {1}", n, n === 1 ? one : many);

/** "1 commit" / "3 commits" — a whole message: "commit" alone is also a column label. */
const commits = (n: number): string => (n === 1 ? l10n.t("1 commit") : l10n.t("{0} commits", n));

/** An operation, as a row names it. */
export function operationWords(op: WorktreeOperationName): string {
  switch (op) {
    case "merge":
      return l10n.t("Merge in progress");
    case "rebase":
      return l10n.t("Rebase stopped");
    case "cherry-pick":
      return l10n.t("Cherry-pick stopped");
    case "revert":
      return l10n.t("Revert stopped");
    case "am":
      return l10n.t("Applying patches");
  }
}

/** An operation, as a sentence names it ("A merge is in progress in it."). */
function operationSentence(op: WorktreeOperationName): string {
  switch (op) {
    case "merge":
      return l10n.t("A merge is in progress in it");
    case "rebase":
      return l10n.t("A rebase is stopped in it");
    case "cherry-pick":
      return l10n.t("A cherry-pick is stopped in it");
    case "revert":
      return l10n.t("A revert is stopped in it");
    case "am":
      return l10n.t("git am is applying patches in it");
  }
}

/** How line 1 names what is checked out: the branch, or "detached at <sha>". */
export function headWords(r: WorktreeRow): string {
  if (r.kind === "bare") return l10n.t("Bare repository");
  if (r.branch) return r.branch;
  if (r.status?.rebasing) return l10n.t("{0} (rebasing)", r.status.rebasing);
  return l10n.t("detached at {0}", r.head.slice(0, 7));
}

/** Every fact about a row, in the order its tooltip says them. */
export function worktreeFacts(r: WorktreeRow): WorktreeFact[] {
  const out: WorktreeFact[] = [];
  if (r.kind === "bare") {
    return out;
  }
  if (r.current) {
    out.push({ id: "current", text: l10n.t("This window"), tone: "accent", tip: l10n.t("Current — open in this window.") });
  }
  if (r.kind === "main") {
    out.push({
      id: "main",
      text: l10n.t("Main worktree"),
      tone: "neutral",
      tip: l10n.t("Main worktree — the repository's own folder."),
    });
  }
  if (r.locked) {
    out.push({
      id: "locked",
      text: r.lockReason ? l10n.t("Locked: {0}", r.lockReason) : l10n.t("Locked"),
      tone: "warn",
      tip: r.lockReason
        ? l10n.t("Locked: “{0}”. Git won't prune, move or remove it until it is unlocked.", r.lockReason)
        : l10n.t("Locked, with no reason given. Git won't prune, move or remove it until it is unlocked."),
    });
  }
  if (r.missing) {
    out.push({
      id: "missing",
      text: l10n.t("Folder missing"),
      tone: "danger",
      tip: r.locked
        ? l10n.t("Its folder isn't there. Forget it to clear it from the list — if it is on a drive that isn't connected, connect it instead.")
        : l10n.t("Its folder isn't there. Forget it to clear it from the list."),
    });
    return out;
  }
  if (r.unlinked) {
    out.push({
      id: "unlinked",
      text: l10n.t("Not a worktree"),
      tone: "danger",
      tip: l10n.t("Its folder is there, but it isn't a worktree any more: {0}. Forget it to clear it from the list — the folder and its files stay.", unlinkedWhy(r.unlinkedWhy)),
    });
    return out;
  }
  const s = r.status;
  if (s?.operation) {
    const conflicts = s.conflicted > 0 ? ` · ${plural(s.conflicted, l10n.t("conflict"), l10n.t("conflicts"))}` : "";
    out.push({
      id: "operation",
      text: `${operationWords(s.operation)}${conflicts}`,
      tone: s.conflicted > 0 ? "danger" : "warn",
      tip:
        s.conflicted > 0
          ? l10n.t("{0}, with {1} left to resolve. Open the worktree to continue or abort it.", operationSentence(s.operation), plural(s.conflicted, l10n.t("file"), l10n.t("files")))
          : l10n.t("{0}. Open the worktree to continue or abort it.", operationSentence(s.operation)),
    });
  } else if (s && s.conflicted > 0) {
    out.push({
      id: "operation",
      text: plural(s.conflicted, l10n.t("conflict"), l10n.t("conflicts")),
      tone: "danger",
      tip:
        s.conflicted === 1
          ? l10n.t("{0} left unmerged in it. Open the worktree to resolve it.", plural(s.conflicted, l10n.t("file"), l10n.t("files")))
          : l10n.t("{0} left unmerged in it. Open the worktree to resolve them.", plural(s.conflicted, l10n.t("file"), l10n.t("files"))),
    });
  }
  if (s && s.changed > 0) {
    const parts = [
      s.staged > 0 ? l10n.t("{0} staged", s.staged) : "",
      s.unstaged > 0 ? l10n.t("{0} unstaged", s.unstaged) : "",
      s.untracked > 0 ? l10n.t("{0} untracked", s.untracked) : "",
      s.conflicted > 0 ? l10n.t("{0} conflicted", s.conflicted) : "",
    ].filter(Boolean);
    out.push({
      id: "changed",
      text: l10n.t("{0} changed", s.changed),
      tone: "info",
      tip: l10n.t("{0}: {1}.", plural(s.changed, l10n.t("uncommitted change"), l10n.t("uncommitted changes")), parts.join(", ")),
    });
  }
  if (!r.branch) {
    return out; // detached: nothing to push to, nothing to pull from
  }
  if (r.upstream && r.upstreamGone) {
    out.push({
      id: "sync",
      text: l10n.t("Upstream gone"),
      tone: "warn",
      tip: l10n.t("Its upstream, {0}, was deleted from the remote.", r.upstream),
    });
  } else if (r.upstream) {
    if (r.ahead > 0 || r.behind > 0) {
      const text = [r.ahead > 0 ? l10n.t("{0} to push", r.ahead) : "", r.behind > 0 ? l10n.t("{0} to pull", r.behind) : ""]
        .filter(Boolean)
        .join(", ");
      out.push({
        id: "sync",
        text,
        tone: r.ahead > 0 && r.behind > 0 ? "warn" : "info",
        tip:
          r.ahead > 0 && r.behind > 0
            ? l10n.t("It and {0} have diverged: {1} to push, {2} to pull.", r.upstream, commits(r.ahead), commits(r.behind))
            : r.ahead > 0
              ? l10n.t("{0} not pushed to {1}.", commits(r.ahead), r.upstream)
              : l10n.t("{0} on {1} not pulled yet.", commits(r.behind), r.upstream),
      });
    }
  } else if (r.hasRemotes) {
    // One fact, not two: "N unpublished" already says there is nowhere it
    // went. Never "not pushed": beside "N to push" (ahead of its upstream)
    // the two read as one thing said two ways.
    out.push(
      s?.unpublished
        ? {
            id: "sync",
            text: l10n.t("{0} unpublished", s.unpublished),
            tone: "info",
            tip: l10n.t("No upstream: {0} no remote has yet. Push publishes the branch.", commits(s.unpublished)),
          }
        : { id: "upstream", text: l10n.t("No upstream"), tone: "neutral", tip: l10n.t("Its branch has no upstream: Push publishes it.") },
    );
  } else if (s?.unpublished && r.defaultBranch) {
    out.push({
      id: "sync",
      text: l10n.t("{0} not on {1}", s.unpublished, r.defaultBranch),
      tone: "neutral",
      tip: l10n.t("{0} {1} doesn't have. The repository has no remote.", commits(s.unpublished), r.defaultBranch),
    });
  }
  return out;
}

/** The one state a row shows beside its name, in a few lower-case words. */
export interface WorktreeState {
  /** Which fact it is (the ids of worktreeFacts). */
  id: "missing" | "unlinked" | "operation" | "changed" | "sync" | "locked";
  text: string;
  /** "attention" when something is wrong or stopped halfway; else "muted". */
  tone: "muted" | "attention";
  /** One word for a narrow sidebar ("merging", "missing"), said instead of
   *  `text` before the folder's name gives way — the tooltip says the rest.
   *  Only a state that needs attention has one: a routine one goes whole. */
  short?: string;
}

/** An operation in one word, as git's prompt says it ("MERGING", "REBASE"). */
function operationWord(op: WorktreeOperationName): string {
  switch (op) {
    case "merge":
      return l10n.t("merging");
    case "rebase":
      return l10n.t("rebasing");
    case "cherry-pick":
      return l10n.t("cherry-picking");
    case "revert":
      return l10n.t("reverting");
    case "am":
      return l10n.t("applying");
  }
}

/**
 * The most pressing thing to say about a row, or nothing: a folder that is
 * gone first, then an operation stopped halfway (or files left unmerged),
 * then uncommitted changes, then what is to push or pull, then a lock. Its
 * other facts are in the tooltip (worktreeTip). "This window" and "Main
 * worktree" are never the state: the name says the first (it is bold), the
 * icon and the tooltip the second.
 */
export function worktreeState(r: WorktreeRow): WorktreeState | undefined {
  if (r.kind === "bare") return undefined;
  if (r.missing) return { id: "missing", text: l10n.t("folder missing"), tone: "attention", short: l10n.t("missing") };
  if (r.unlinked) return { id: "unlinked", text: l10n.t("not a worktree"), tone: "attention", short: l10n.t("unlinked") };
  const s = r.status;
  if (s?.operation) return { id: "operation", text: operationWords(s.operation).toLowerCase(), tone: "attention", short: operationWord(s.operation) };
  if (s && s.conflicted > 0) return { id: "operation", text: plural(s.conflicted, l10n.t("conflict"), l10n.t("conflicts")), tone: "attention" };
  if (s && s.changed > 0) return { id: "changed", text: l10n.t("{0} changed", s.changed), tone: "muted" };
  const sync = syncState(r);
  if (sync) return { id: "sync", text: sync, tone: "muted" };
  if (r.locked) return { id: "locked", text: l10n.t("locked"), tone: "muted" };
  return undefined;
}

/** What is to push or pull, in a few words — undefined when nothing is. */
function syncState(r: WorktreeRow): string | undefined {
  if (!r.branch) return undefined;
  if (r.upstream && r.upstreamGone) return l10n.t("upstream gone");
  if (r.upstream) {
    if (r.ahead > 0 && r.behind > 0) return l10n.t("diverged");
    if (r.ahead > 0) return l10n.t("{0} to push", r.ahead);
    if (r.behind > 0) return l10n.t("{0} to pull", r.behind);
    return undefined;
  }
  const n = r.status?.unpublished;
  if (!n) return undefined;
  if (r.hasRemotes) return l10n.t("{0} unpublished", n);
  return r.defaultBranch ? l10n.t("{0} not on {1}", n, r.defaultBranch) : undefined;
}

/**
 * A row's tooltip, one line each: where its folder is, then every fact
 * about it as a sentence — the state's too, which says more there ("3
 * uncommitted changes: 1 staged, 2 unstaged.") — and, with nothing to push
 * or pull, that it is up to date with its upstream.
 */
export function worktreeTip(r: WorktreeRow): string {
  const lines = [r.shownPath, ...worktreeFacts(r).map((f) => f.tip)];
  if (r.branch && r.upstream && !r.upstreamGone && r.ahead === 0 && r.behind === 0 && !r.missing && !r.unlinked) {
    lines.push(l10n.t("Up to date with {0}.", r.upstream));
  }
  return lines.join("\n");
}

/** An action a row can take, or why it can't — said where the action is. */
export type Gate = { ok: true } | { ok: false; why: string };

const yes: Gate = { ok: true };
const no = (why: string): Gate => ({ ok: false, why });

/** What a row offers. */
export interface WorktreeCaps {
  /** Its row opens to its changes and commits. */
  expand: boolean;
  openHere: Gate;
  openNew: Gate;
  reveal: boolean;
  terminal: boolean;
  pull: Gate;
  push: Gate;
  /** The menu shows one of the two — Unlock when it is locked, Lock… when
   *  not — and says why when that one can't run. */
  lock: Gate;
  unlock: Gate;
  /** Remove its folder; a missing one — or one not a worktree any more — is
   *  forgotten instead (`forget`). */
  remove: Gate;
  forget: boolean;
}

/** What a row offers, each refusal with its reason. */
export function worktreeCaps(r: WorktreeRow): WorktreeCaps {
  if (r.kind === "bare") {
    const bare = no(l10n.t("It is the bare repository itself, not a working tree."));
    return {
      expand: false,
      openHere: bare,
      openNew: bare,
      reveal: true,
      terminal: false,
      pull: bare,
      push: bare,
      lock: bare,
      unlock: bare,
      remove: bare,
      forget: false,
    };
  }
  if (r.missing || r.unlinked) {
    // Not a worktree any more: nothing is run in the folder, which only
    // Reveal still shows.
    const gone = no(r.missing ? l10n.t("Its folder is missing.") : l10n.t("It isn't a worktree any more — {0}.", unlinkedWhy(r.unlinkedWhy)));
    return {
      expand: false,
      openHere: gone,
      openNew: gone,
      reveal: !r.missing,
      terminal: false,
      pull: gone,
      push: gone,
      lock: r.locked ? no(l10n.t("It is locked already.")) : gone,
      unlock: r.locked ? yes : no(l10n.t("It isn't locked.")),
      remove: gone,
      forget: true,
    };
  }
  const here = no(l10n.t("This window has it open."));
  const op = r.status?.operation;
  const stopped = op ? no(l10n.t("{0} — continue or abort it first.", operationSentence(op))) : undefined;
  // What git is stopped in comes first: mid-rebase git lists the worktree
  // detached, and "no branch is checked out" would be the wrong reason.
  const pull: Gate = stopped
    ? stopped
    : !r.branch
      ? no(l10n.t("No branch is checked out in it, so there is nothing to pull into."))
      : !r.hasRemotes
        ? no(l10n.t("The repository has no remote to pull from."))
        : !r.upstream
          ? no(l10n.t("Its branch has no upstream to pull from."))
          : r.upstreamGone
            ? no(l10n.t("Its upstream, {0}, is gone from the remote.", r.upstream))
            : yes;
  const push: Gate = stopped
    ? stopped
    : !r.branch
      ? no(l10n.t("No branch is checked out in it, so there is nothing to push."))
      : !r.hasRemotes
        ? no(l10n.t("The repository has no remote to push to."))
        : r.upstream && !r.upstreamGone && r.ahead === 0
          ? no(l10n.t("Nothing to push — it is up to date with {0}.", r.upstream))
          : yes;
  return {
    expand: true,
    openHere: r.current ? here : yes,
    openNew: r.current ? here : yes,
    reveal: true,
    terminal: true,
    pull,
    push,
    lock:
      r.kind === "main"
        ? no(l10n.t("The main worktree holds the repository itself, so git can't lock it."))
        : r.locked
          ? no(l10n.t("It is locked already."))
          : yes,
    unlock: r.locked ? yes : no(l10n.t("It isn't locked.")),
    remove:
      r.kind === "main"
        ? no(l10n.t("The main worktree holds the repository itself, so git never removes it."))
        : r.current
          ? no(l10n.t("This window has it open — its folder would be deleted from under the window."))
          : yes,
    forget: false,
  };
}

/** The title of a row's "not pushed" section, by the rule that counts it. */
export function unpublishedTitle(r: WorktreeRow): string | undefined {
  if (r.kind === "bare" || r.missing || r.unlinked) return undefined;
  if (r.branch && r.upstream && !r.upstreamGone) return l10n.t("Not pushed to {0}", r.upstream);
  if (r.hasRemotes) return l10n.t("Not on any remote");
  if (r.onDefaultBranch || !r.defaultBranch) return undefined;
  return l10n.t("Not on {0}", r.defaultBranch);
}

/** The rows in the order the list shows them: this window's first, then the
 *  main worktree, then the rest by name, the missing ones last. */
export function orderWorktreeRows(rows: readonly WorktreeRow[]): WorktreeRow[] {
  const rank = (r: WorktreeRow): number =>
    r.kind === "bare" ? 0 : r.current ? 1 : r.kind === "main" ? 2 : r.missing || r.unlinked ? 4 : 3;
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path),
  );
}

/** How many worktrees `git worktree prune` would forget — git's own test:
 *  its .git is gone (the folder with it, or not) and it is not locked. */
export function prunableCount(rows: readonly WorktreeRow[]): number {
  return rows.filter((r) => (r.missing || r.unlinked) && !r.locked).length;
}

/** Past this many worktrees the list gets a filter field. */
export const WORKTREE_FILTER_AFTER = 8;

/** A row's open sections, read on expand (tier 2). */
export interface WorktreeDetails {
  /** Its uncommitted changes (at most `FILES_SHOWN`), and how many there are. */
  files: ChangeFile[];
  filesTotal: number;
  /** Its working tree could not be read: `files` is empty because nothing is
   *  known, not because nothing changed. */
  filesUnread?: true;
  /** The commits it has not pushed, by its rule (see unpublishedTitle). */
  unpushed?: { title: string; commits: ChangeCommit[]; more: boolean };
  /** The commits its upstream has that it doesn't. */
  toPull?: { title: string; commits: ChangeCommit[]; more: boolean };
}

/** How many uncommitted files an open row lists before "and N more". */
export const WORKTREE_FILES_SHOWN = 200;
/** How many commits a section lists before "and more". */
export const WORKTREE_COMMITS_SHOWN = 50;

/** What a row's More menu (and its buttons) ask the host to do. */
export type WorktreeAction =
  | "openHere"
  | "openNew"
  | "reveal"
  | "terminal"
  | "copyPath"
  | "pull"
  | "push"
  | "lock"
  | "unlock"
  | "remove"
  | "forget";

/** Page → host. Every row is named by its path, as git lists it. */
export type WorktreesToHost =
  | { type: "ready" }
  | { type: "refresh" }
  /** Rows now in view — their tier 1 is read (the host skips fresh ones). */
  | { type: "visible"; paths: string[] }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "commitFiles"; path: string; sha: string }
  /** An uncommitted file: its diff in THAT worktree. */
  | { type: "openFile"; path: string; file: ChangeFile }
  /** A committed file: what the commit did to it. */
  | { type: "openCommitFile"; path: string; sha: string; parent?: string; file: ChangeFile }
  | { type: "action"; path: string; action: WorktreeAction }
  | { type: "add" }
  | { type: "prune" };

/** Host → page. */
export type WorktreesToPage =
  | {
      type: "rows";
      rows: WorktreeRow[];
      /** No repository open, or still being looked for. */
      state: "ok" | "noRepo" | "discovering" | "failed";
    }
  | { type: "status"; path: string; status: WorktreeRowStatus | null }
  | { type: "details"; path: string; details: WorktreeDetails }
  /** A commit's own files; null when git could not read them. */
  | { type: "commitFiles"; path: string; sha: string; files: ChangeFile[] | null }
  /** An action on a row is running (or is over): the row says so and takes no second one. */
  | { type: "busy"; path: string; busy: boolean; label?: string }
  /** Change a row now, before the next list — an optimistic patch, or its rollback. */
  | { type: "patch"; path: string; row: Partial<WorktreeRow> }
  /** Take a row out now (removed, forgotten); the next list agrees. */
  | { type: "drop"; path: string };
