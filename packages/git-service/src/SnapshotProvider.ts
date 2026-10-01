import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import {
  branchShort,
  checkedOutAt,
  headBranch,
  localBranches,
  putRefBack,
  shortSha,
  type RefMove,
} from "./refRestore";
import { placeHolds, restoreStash, stashStack, type StashSlot } from "./stashRestore";
import { stashTitle } from "./StashProvider";
import * as l10n from "@vscode/l10n";

/**
 * A record of what an operation is about to change, and — once it has run and
 * `settle` has looked — what it DID change. This is the mechanics behind
 * GitStudio's Undo envelope; the extension's UndoLedger persists these.
 *
 * Undo used to restore by resetting whatever branch HEAD was on NOW to the
 * commit HEAD had been at before. That is only right for an op that moved
 * HEAD's own branch. Undoing "Checkout feature" reset FEATURE onto main's
 * commit; undoing "Delete branch" restored nothing and said it had; undoing a
 * pop threw the popped work away. So a snapshot records the op's SCOPE —
 * HEAD's branch (or detached commit), every local branch, the stash stack and
 * the uncommitted state — and `settle` keeps exactly what differs after the
 * op. `plan` then says, in words, what putting back THOSE things means, or
 * why it can't be done safely; `restore` does it and nothing else.
 *
 *   headSha  — the commit HEAD pointed at before.
 *   stashSha — a `git stash create` commit of the uncommitted index + tree
 *              before (null when clean). Captured without touching them.
 *   ref      — HEAD's branch before, short (null when detached). For words.
 *   label    — the operation (for words).
 *   scope    — what the op may change, and what it did (see SnapshotScope).
 */
export interface Snapshot {
  headSha: string;
  stashSha: string | null;
  ref: string | null;
  label: string;
  /**
   * The ONE branch the op says up front it moves ("Reset 'x' to 'origin/x'"):
   * its full name, where it was (`sha`), where the op left it (`after`, by
   * `settle`), and whether it was HEAD's branch when the op ran. Informational
   * now — the scope diff finds that branch like any other — and kept because
   * a door names it: a branch that isn't checked out takes none of the
   * working tree with it, so none is captured.
   */
  branch?: SnapshotBranch;
  /** What the op may change and — once settled — did. Absent on a snapshot
   *  recorded before scopes existed; those are refused rather than guessed. */
  scope?: SnapshotScope;
}

/** See `Snapshot.branch`. */
export interface SnapshotBranch {
  /** refs/heads/<name>. */
  ref: string;
  /** Where it pointed before the op. */
  sha: string;
  /** Where the op left it. */
  after?: string;
  /** HEAD's branch here when the op ran: the op took the working tree too. */
  checkedOut: boolean;
}

/** An operation git was stopped in: which, and enough to know it again. */
export interface OpMark {
  kind: "rebase" | "am" | "merge" | "cherry-pick" | "revert";
  /** rebase: `head-name` (refs/heads/x, or "detached HEAD"). */
  headName?: string;
  /** rebase: `orig-head`, where the branch was when it started. */
  origHead?: string;
  /** rebase: `onto`. */
  onto?: string;
  /** merge / cherry-pick / revert: the commit in MERGE_HEAD etc. */
  head?: string;
  /**
   * cherry-pick / revert of several commits in one command: git keeps the
   * rest of the run in `.git/sequencer`. `reset --hard` clears the *_HEAD
   * but not that — `git status` still says the op is in progress, and its
   * Continue replays the rest of it — so an Undo of the op ends it too.
   */
  sequence?: true;
}

/** The remote-tracking branches that contain a commit — or how many, when there are lots. */
export type Published = string[] | { count: number };

/** A local branch the op moved, created (before null) or deleted (after null). */
export interface MovedRef extends RefMove {
  /** A deleted branch's `branch.<name>.*` config, to bring back with it. */
  config?: [string, string][];
  /** The op created the branch's config section too (a checkout of origin/x). */
  configCreated?: boolean;
  /** Remote-tracking branches containing `after` when the op ended. */
  published?: Published;
}

/** A stash the op took off the stack (a pop, a drop), and where it sat. */
export interface DroppedStash extends StashSlot {
  index: number;
  /** The shas above it then, newest first. */
  above: string[];
}

export interface SnapshotScope {
  v: 2;
  /** HEAD's branch before, by full name, or null when detached. */
  headRef: string | null;
  /** When captured, epoch seconds. */
  time: number;
  /** A fingerprint of the uncommitted state before ("clean" when there is none). */
  tree: string;
  /** Whatever git was stopped in before the op. */
  op?: OpMark;
  /** Every local branch before. Only until `settle`, unless the op goes on after it. */
  branches?: Record<string, string>;
  /** `branch.<name>.*` config before. Only until `settle`. */
  config?: Record<string, [string, string][]>;
  /** The stash stack before. Only until `settle`. */
  stashes?: StashSlot[];
  /**
   * The op goes on after the call returns — an interactive rebase handed to a
   * terminal. What it changed is read at Undo time from the branches' reflogs
   * (a move by "rebase … onto <onto>").
   */
  deferred?: { onto?: string };
  /**
   * The uncommitted state before could not be copied — `git stash create`
   * refuses an index with unmerged entries (a conflict in progress) or a file
   * marked with `git add -N` — and why. Undo can't put that state back: it
   * says so, and never rewrites the tree as though it could.
   */
  uncopied?: NoCopy;
  /**
   * Only for an uncopied tree: the working-tree files that differed from
   * HEAD before, by content digest. When they are all still so, the op left
   * the files alone (a mixed reset) and moving the branch back without
   * touching them undoes it exactly.
   */
  files?: Record<string, string>;
  /**
   * The op moves only refs and stashes — Delete branch, Drop stash, a reset
   * of a branch that isn't checked out. The uncommitted state is not its to
   * change, so whatever changes it while the op runs (an edit saved while its
   * question was open) is the user's: not recorded, and never put back.
   */
  refsOnly?: true;
  /**
   * A question was open while the op ran. What it left uncommitted may hold
   * edits made meanwhile, which can't be told from its own — so an undo that
   * rewrites the tree says it takes those too.
   */
  asked?: true;
  /** What the op changed, filled in by `settle`. */
  settled?: SettledScope;
}

export interface SettledScope {
  /** HEAD after the op. */
  headRef: string | null;
  headSha: string;
  /** The uncommitted state the op left. */
  tree: string;
  moved: MovedRef[];
  stashes: DroppedStash[];
  /** An operation the op left git stopped in (one that wasn't there before). */
  op?: OpMark;
  /**
   * Stashes the op put on the stack — a Stash & Retry's, holding the work
   * that was in the command's way — newest first.
   */
  pushed?: StashSlot[];
  /**
   * Remote-tracking branches containing HEAD's commit when the op ended —
   * read only for an op that moved a detached HEAD, the one case that asks
   * (a branch's own move carries its `published`). Every settle would
   * otherwise pay a `--contains` walk for nothing.
   */
  published?: Published;
}

/** One thing `restore` does. */
export type RestoreStep =
  /** `rebase --abort`; then, onto the clean tree it leaves, the uncommitted work from before. */
  | { do: "abort-rebase"; stash?: string | null }
  | { do: "switch"; ref: string | null; sha: string }
  | { do: "reset"; to: string; mode: "hard" | "keep" | "mixed"; stash: string | null }
  | { do: "tree"; stash: string | null }
  | { do: "ref"; move: MovedRef; here: boolean }
  | { do: "stash"; entry: DroppedStash }
  /** Take a stash the op made off the stack again — its work is back in the tree. */
  | { do: "drop-stash"; entry: StashSlot }
  /** End the op's own cherry-pick / revert run (`--quit`: HEAD and the tree are already back). */
  | { do: "quit-sequence"; kind: "cherry-pick" | "revert" };

/** What undoing a snapshot means right now. */
export type RestorePlan =
  /** It can't be done safely; `reason` says why. Nothing is changed. */
  | { kind: "refuse"; reason: string }
  /** There is nothing to put back; `reason` says why. */
  | { kind: "nothing"; reason: string }
  /**
   * HEAD's branch was moved by the op and the result has been PUSHED since:
   * putting it back would rewrite published history, so the undo is a new
   * commit instead — `git revert from..to` for commits the op added, or one
   * commit restoring `from`'s files for a rewrite (an amend, a rebase).
   */
  | { kind: "revert"; mode: "range" | "tree"; from: string; to: string; branch: string | null }
  /** Put these back; `lines` say so in words. */
  | { kind: "restore"; steps: RestoreStep[]; lines: string[]; danger: boolean };

/** The fingerprint of a working tree and index with nothing uncommitted. */
export const CLEAN_TREE = "clean";

/** A refs-only op's "fingerprint": the uncommitted state is not its to change, so it isn't read. */
const NOT_THE_OPS = l10n.t("not the op's");

/** Why git won't copy the uncommitted state (`stash create` refuses it). */
export type NoCopy = "conflict" | "intent-to-add" | "other";

/** The words after "git couldn't keep a copy of them …", as things are now or were then. */
export function noCopyClause(why: NoCopy, when: "now" | "then"): string {
  const now = when === "now";
  switch (why) {
    case "conflict":
      return now ? "while a conflict is unresolved" : "while a conflict was unresolved";
    case "intent-to-add":
      return now ? l10n.t("while a file is only marked to be added (git add -N)") : l10n.t("while a file was only marked to be added (git add -N)");
    default:
      return now ? "as they are" : "as they were";
  }
}

/**
 * Whether a copy of the uncommitted state can be kept right now — the one
 * an Undo would put back — and if not, why. Undefined when it can, or when
 * there is nothing uncommitted. `stash create` writes objects only.
 */
export async function whyNoCopy(proc: GitProcess, opts?: GitRunOptions): Promise<NoCopy | undefined> {
  const st = await proc.run(["status", "--porcelain"], opts);
  if (st.code === 0 && st.stdout.trim().length === 0) return undefined;
  const made = await proc.run(["stash", "create"], opts);
  return made.code === 0 ? undefined : noCopyKind(proc, opts);
}

/** Why `stash create` just refused. */
async function noCopyKind(proc: GitProcess, opts?: GitRunOptions): Promise<NoCopy> {
  const [unmerged, st] = await Promise.all([
    proc.run(["ls-files", "-u", "-z"], opts),
    proc.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"], opts),
  ]);
  if (unmerged.code === 0 && unmerged.stdout.length > 0) return "conflict";
  // `1 .A …`: added in the working tree only — an intent-to-add entry.
  if (st.code === 0 && st.stdout.split("\0").some((r) => r.startsWith("1 .A "))) return "intent-to-add";
  return "other";
}

/** An undo that rewrites the tree after a question was open while the op ran. */
const ASKED_LINE = l10n.t("Anything you changed while its question was open is discarded too.");

/** How long after a rebase's own finish a branch it carried may be moved (the post-rewrite hook runs between). */
const CARRY_SLACK = 300;

/** A file this big is fingerprinted by size and time rather than read. */
const DIGEST_LIMIT = 16 * 1024 * 1024;

/** A rebase's own finish, in the reflog of the branch it rebased (git doesn't translate these). */
const REBASE_FINISH = /^rebase(?: -i)? \(finish\): (.+) onto ([0-9a-f]+)$|^rebase finished: (.+) onto ([0-9a-f]+)$/;

/** A branch a rebase carried with it (`--update-refs`). */
const REBASE_CARRIED = "rewritten during rebase";

/** A step of a rebase in HEAD's reflog: "rebase (start): checkout main", "rebase -i (pick): …", "rebase: …". */
const REBASE_STEP = /^rebase(?: -i)?(?: \((\w+)\))?: /;

/**
 * Captures, settles, plans and restores snapshots. Capture writes nothing a
 * user could see: `stash create` only writes objects. This package must never
 * import vscode.
 */
export class SnapshotProvider {
  constructor(private readonly process: GitProcess) {}

  /**
   * Record HEAD (its branch or detached commit), every local branch and its
   * config, the stash stack, what git is stopped in, a fingerprint of the
   * uncommitted state, and — when there is any — a `stash create` copy of it.
   */
  async capture(
    label: string,
    opts?: GitRunOptions & {
      /** The one branch the op moves, by full name — see `Snapshot.branch`. */
      branch?: string;
      /** The op goes on after it returns — see `SnapshotScope.deferred`. */
      deferred?: { onto?: string };
      /** The op moves only refs and stashes — see `SnapshotScope.refsOnly`. */
      refsOnly?: boolean;
    },
  ): Promise<Snapshot> {
    const headSha = (await this.run(["rev-parse", "HEAD"], opts)).trim();
    const headRef = await headBranch(this.process, opts);
    const ref = headRef ? branchShort(headRef) : null;

    let branch: SnapshotBranch | undefined;
    if (opts?.branch) {
      const sha = (await this.run(["rev-parse", "--verify", `${opts.branch}^{commit}`], opts)).trim();
      branch = { ref: opts.branch, sha, checkedOut: headRef === opts.branch };
    }

    // A branch that is not checked out is all such an op touches — the
    // working tree here is another branch's — so it moves refs only.
    const refsOnly = !!opts?.refsOnly || (!!branch && !branch.checkedOut);
    let stashSha: string | null = null;
    let uncopied: NoCopy | undefined;
    if (!refsOnly && (await this.isDirty(opts))) {
      const created = await this.process.run(["stash", "create", label], opts);
      if (created.code === 0) {
        // `stash create` prints nothing (empty) when there's nothing to stash.
        stashSha = created.stdout.trim() || null;
      } else {
        // A conflict in progress (or a `git add -N` file): git won't copy the
        // index. The op is still recorded — its branches and stashes can go
        // back — and the words say the tree can't.
        uncopied = await noCopyKind(this.process, opts);
      }
    }

    const [tree, branches, config, stashes, op, files] = await Promise.all([
      refsOnly ? Promise.resolve(NOT_THE_OPS) : this.fingerprint(opts),
      localBranches(this.process, opts),
      this.branchConfig(opts),
      stashStack(this.process, opts),
      this.opMark(opts),
      uncopied ? this.fileDigests("HEAD", opts) : Promise.resolve(undefined),
    ]);
    const scope: SnapshotScope = {
      v: 2,
      headRef,
      time: Math.floor(Date.now() / 1000),
      tree,
      ...(op ? { op } : {}),
      branches,
      config,
      stashes,
      ...(opts?.deferred ? { deferred: opts.deferred.onto ? { onto: opts.deferred.onto } : {} } : {}),
      ...(uncopied ? { uncopied, ...(files ? { files } : {}) } : {}),
      ...(refsOnly ? { refsOnly: true as const } : {}),
    };
    return branch ? { headSha, stashSha, ref, label, branch, scope } : { headSha, stashSha, ref, label, scope };
  }

  /**
   * Look at what the op changed and keep exactly that (`scope.settled`), once
   * the op has run. The full before-lists are dropped — except for an op that
   * goes on after this (a deferred one, or a rebase left stopped), which Undo
   * reads again from the reflogs.
   */
  async settle(snap: Snapshot, opts?: GitRunOptions): Promise<void> {
    if (snap.branch) {
      const now = await this.commitOf(snap.branch.ref, opts);
      if (now) snap.branch.after = now;
    }
    const s = snap.scope;
    if (!s) return;
    s.settled = await this.diff(snap, s, await this.observe(opts), opts);
    const goesOn = !!s.deferred || s.settled.op?.kind === "rebase";
    if (!goesOn) delete s.branches;
    delete s.config;
    delete s.stashes;
  }

  /**
   * Whether a settled op changed anything Undo would put back. False for an
   * op that was refused or cancelled before git wrote anything — recording
   * it offered an Undo toast for something that never happened. A
   * deferred op has not happened YET, so it counts.
   */
  changed(snap: Snapshot): boolean {
    const s = snap.scope;
    if (!s?.settled || s.deferred) return true;
    const t = s.settled;
    return (
      t.headRef !== s.headRef ||
      t.headSha !== snap.headSha ||
      t.moved.length > 0 ||
      t.stashes.length > 0 ||
      (t.pushed?.length ?? 0) > 0 ||
      // A tree nobody could copy can't be put back: a change to it alone is
      // nothing Undo could do (and a refs-only op's tree is never its own).
      (t.tree !== s.tree && !s.uncopied) ||
      !!t.op
    );
  }

  /**
   * Note that a question was open while the op ran (see `SnapshotScope.asked`).
   * Called by the envelope before `settle`.
   */
  markAsked(snap: Snapshot): void {
    if (snap.scope) snap.scope.asked = true;
  }

  /** Whether a copy of the uncommitted state can be kept now — see `whyNoCopy`. */
  whyNoCopy(opts?: GitRunOptions): Promise<NoCopy | undefined> {
    return whyNoCopy(this.process, opts);
  }

  /**
   * Why `snap` cannot be undone as things stand — a sentence — or undefined
   * when it can (or there is nothing to put back).
   */
  async whyNotRestorable(snap: Snapshot, opts?: GitRunOptions): Promise<string | undefined> {
    const p = await this.plan(snap, opts);
    return p.kind === "refuse" ? p.reason : p.kind === "revert" ? REVERT_NOT_RESTORE : undefined;
  }

  /**
   * What undoing `snap` means now: the steps, in words — or why it can't be
   * done, or that there is nothing to do. A snapshot nobody settled is settled
   * against the repository as it is now (everything since capture is the op).
   *
   * The rules: put back only what the op changed. HEAD switched by the op goes
   * back to the branch (or detached commit) it was on, by a checkout that
   * carries uncommitted work and refuses rather than overwrite it. A branch the
   * op moved goes back only while it is still where the op left it; one it
   * created is deleted, one it deleted is re-created at its old commit. A
   * stash it took goes back where it was. The uncommitted state comes back
   * only where the op changed it — and changes made SINCE are kept where
   * `reset --keep` can keep them, and otherwise named as discarded.
   */
  async plan(snap: Snapshot, opts?: GitRunOptions): Promise<RestorePlan> {
    const s = snap.scope;
    if (!s) {
      return refuse(l10n.t("It was recorded by an older version of GitStudio, which can't say exactly what it changed. Nothing was changed."));
    }
    const label = snap.label;
    const now = await this.observe(opts);
    let settled = s.settled ?? (await this.diff(snap, s, now, opts));
    const B = { ref: s.headRef, sha: snap.headSha };
    const lines: string[] = [];
    const steps: RestoreStep[] = [];
    let danger = false;

    // ── An operation git is stopped in ──────────────────────────────────────
    const opNow = now.op;
    const oursRebase =
      opNow?.kind === "rebase" &&
      (settled.op ? sameOp(settled.op, opNow) : !!s.deferred && !sameOp(s.op, opNow)) &&
      opNow.origHead === B.sha &&
      opNow.headName === (B.ref ?? "detached HEAD");
    if (oursRebase) {
      // Aborting ends the rebase where it began: the branch and HEAD as they
      // were, and nothing it rewrote kept. A rebase needs a clean tree, so
      // uncommitted work from before went into a stash (Stash & Retry) to
      // wait for it — that comes back too, onto the tree the abort leaves.
      const abort: RestoreStep[] = [{ do: "abort-rebase", stash: snap.stashSha }];
      const said = [
        B.ref
          ? l10n.t("Abandon the rebase in progress: '{0}' stays at {1}, as it was.", branchShort(B.ref), shortSha(B.sha))
          : l10n.t("Abandon the rebase in progress: HEAD goes back to {0}.", shortSha(B.sha)),
      ];
      if (snap.stashSha) said.push(l10n.t("Your uncommitted changes come back as they were before it."));
      await this.stashesItMade(snap, settled, now, abort, said, opts);
      return { kind: "restore", steps: abort, lines: said, danger: false };
    }
    const oursStop = !!opNow && !!settled.op && sameOp(settled.op, opNow);
    const foreignStop = !!opNow && !oursStop;

    // ── An op that went on after it was recorded ────────────────────────────
    if (s.deferred || settled.op?.kind === "rebase") {
      const r = await this.resettle(snap, s, settled, now, opts);
      if (r.kind !== "ok") return r;
      settled = r.settled;
    }

    const A = { ref: settled.headRef, sha: settled.headSha };
    const N = { ref: now.headRef, sha: now.headSha };
    const moved = settled.moved.filter((m) => (now.branches[m.ref] ?? null) !== m.before); // already back: done
    const where = await checkedOutAt(this.process, opts);
    let leaving: string | null = null;

    // ── HEAD ────────────────────────────────────────────────────────────────
    const switched = B.ref !== A.ref;
    const ownMove = B.ref ? settled.moved.find((m) => m.ref === B.ref) : undefined;
    const headMoved = !switched && (B.ref ? !!ownMove : B.sha !== A.sha);
    if (switched) {
      const there = N.ref === B.ref && (B.ref !== null || N.sha === B.sha);
      if (!there) {
        if (A.ref === null && N.ref === null && N.sha !== A.sha && !(await this.reachable(N.sha, opts))) {
          return refuse(
            l10n.t("You've made commits on the detached HEAD since (it is at {0} now), and switching back would leave them on no branch. Create a branch for them first, then undo.", shortSha(N.sha)),
          );
        }
        if (B.ref) {
          const name = branchShort(B.ref);
          if (name.startsWith("-")) {
            return refuse(l10n.t("'{0}' can't be switched to safely — git would read its name as an option. Rename it, then undo.", name));
          }
          if (!now.branches[B.ref]) {
            return refuse(l10n.t("'{0}' is not in this repository any more, so there is nothing to switch back to.", name));
          }
          const elsewhere = where.get(B.ref);
          if (elsewhere && N.ref !== B.ref) {
            return refuse(l10n.t("'{0}' is checked out in another worktree, at {1}, so this one can't switch back to it.", name, elsewhere));
          }
          lines.push(l10n.t("Switch back to '{0}'.", name));
        } else {
          lines.push(l10n.t("Go back to the detached HEAD at {0}.", shortSha(B.sha)));
        }
        if (now.tree !== CLEAN_TREE) lines.push(l10n.t("Your uncommitted changes come along."));
        steps.push({ do: "switch", ref: B.ref, sha: B.sha });
        leaving = N.ref;
      }
    } else if (headMoved) {
      const name = B.ref ? branchShort(B.ref) : "HEAD";
      // "'main' goes back…", but "HEAD goes back…": HEAD is not a branch name.
      const said = B.ref ? `'${name}'` : "HEAD";
      const after = B.ref ? ownMove!.after : A.sha;
      const to = B.ref ? ownMove!.before : B.sha;
      const cur = B.ref ? (now.branches[B.ref] ?? null) : N.sha;
      if (cur === to && N.ref === A.ref) {
        // Already back where it was.
      } else {
        if (!after || !to) {
          return refuse(l10n.t("\"{0}\" changed {1} in a way Undo can't put back. Nothing was changed.", label, said));
        }
        if (N.ref !== A.ref) {
          return refuse(
            B.ref
              ? l10n.t("'{0}' was checked out here when \"{1}\" ran, and it isn't now. Check it out again, then undo.", name, label)
              : l10n.t("HEAD was detached when \"{0}\" ran, and it isn't now. Detach it at {1} again, then undo.", label, shortSha(after)),
          );
        }
        if (cur !== after) {
          return refuse(
            l10n.t("{0} has moved since (it is at {1} now), and putting it back would throw that away.", said, cur ? shortSha(cur) : l10n.t("nothing")),
          );
        }
        const pushedSince = publishedSince(B.ref ? ownMove!.published : settled.published, await this.published(after, opts));
        if (pushedSince && !(await this.isAncestor(after, to, opts))) {
          const others = moved.filter((m) => m.ref !== B.ref).length + unrestoredStashes(settled, now).length;
          if (others > 0) {
            return refuse(
              l10n.t("{0} has been pushed since, so Undo would have to revert it — and it can't put the rest of what \"{1}\" changed back that way. Nothing was changed.", said, label),
            );
          }
          const range = (await this.isAncestor(to, after, opts)) && (await this.mergesBetween(to, after, opts)) === 0;
          return { kind: "revert", mode: range ? "range" : "tree", from: to, to: after, branch: B.ref };
        }
        // `reset --hard` writes every file `to` has over whatever is there —
        // an untracked file of the same name included, without a word.
        const inTheWay = await this.untrackedInTheWay(after, to, opts);
        if (inTheWay.length) {
          const one = inTheWay.length === 1;
          return refuse(
            `${one ? l10n.t("'{0}' is", inTheWay[0]) : l10n.t("{0} files ({1}{2}) are", inTheWay.length, inTheWay.slice(0, 3).map((p) => `'${p}'`).join(", "), inTheWay.length > 3 ? ", …" : "")} ` +
              l10n.t("untracked here, and going back to {0} would overwrite {1}. Move {2} aside, then undo.", shortSha(to), one ? l10n.t("it") : l10n.t("them"), one ? l10n.t("it") : l10n.t("them")),
          );
        }
        lines.push(`${said} goes back to ${shortSha(to)}.`);
        if (oursStop) lines.push(l10n.t("The {0} in progress is abandoned.", settled.op!.kind));
        if (!snap.stashSha && s.tree !== CLEAN_TREE) {
          // Something was uncommitted before and there is no copy of it (git
          // won't copy a conflict in progress). Nothing uncommitted now may be
          // discarded, since some of it may be that work.
          if (now.tree === CLEAN_TREE) {
            steps.push({ do: "reset", to, mode: "hard", stash: null });
          } else if (s.files && sameDigests(await this.fileDigests(to, opts), s.files)) {
            // Every file is as it was before the op (a mixed reset leaves
            // them): the branch goes back and the files stay, exactly.
            steps.push({ do: "reset", to, mode: "mixed", stash: null });
            lines.push(l10n.t("Your uncommitted changes are kept."));
          } else if (!(await this.overlaps(after, to, opts))) {
            steps.push({ do: "reset", to, mode: "keep", stash: null });
            lines.push(l10n.t("Your uncommitted changes are kept."));
          } else {
            return refuse(
              l10n.t("Putting {0} back would overwrite uncommitted changes, and some of them you had before \"{1}\" — ", said, label) +
                l10n.t("git couldn't keep a copy of those {0}. Commit or stash them, then undo.", noCopyClause(s.uncopied ?? "other", "then")),
            );
          }
          if (s.uncopied) {
            lines.push(
              l10n.t("The uncommitted changes you had before it can't come back — git couldn't keep a copy of them {0}.", noCopyClause(s.uncopied, "then")),
            );
          }
        } else if (now.tree === settled.tree || now.tree === CLEAN_TREE) {
          // Nothing uncommitted has changed since (or nothing is uncommitted
          // at all — then there is nothing to lose): the op's own changes to
          // the tree go, and what was uncommitted before comes back.
          steps.push({ do: "reset", to, mode: "hard", stash: snap.stashSha });
          if (snap.stashSha) lines.push(l10n.t("The uncommitted changes you had then come back too."));
          if (s.asked && now.tree !== CLEAN_TREE) {
            lines.push(ASKED_LINE);
            danger = true;
          }
        } else if (!snap.stashSha && settled.tree === CLEAN_TREE && !(await this.overlaps(after, to, opts))) {
          // Everything uncommitted is new since the op, and none of it is in
          // a file going back: `reset --keep` keeps it.
          steps.push({ do: "reset", to, mode: "keep", stash: null });
          lines.push(l10n.t("Your uncommitted changes are kept."));
        } else {
          steps.push({ do: "reset", to, mode: "hard", stash: snap.stashSha });
          if (snap.stashSha) lines.push(l10n.t("The uncommitted changes you had then come back too."));
          lines.push(l10n.t("Uncommitted changes you have made since are discarded."));
          danger = true;
        }
      }
    } else if (settled.tree !== s.tree || oursStop) {
      // HEAD stayed put; the op changed only the uncommitted state (a pop,
      // the merge editor's Apply, a pick or merge that stopped on a conflict).
      if (N.ref !== A.ref || N.sha !== A.sha) {
        return refuse(
          l10n.t("HEAD has moved since \"{0}\" (it is at {1} now), so the changes it made to your working tree can't be taken back safely.", label, shortSha(N.sha)),
        );
      }
      if (now.tree !== s.tree || oursStop) {
        if (!snap.stashSha && s.tree !== CLEAN_TREE) {
          // Taking the op's changes back means putting the tree back as it
          // was — and there is no copy of that to put back.
          return refuse(
            l10n.t("When \"{0}\" ran, git couldn't keep a copy of your uncommitted changes {1}, ", label, noCopyClause(s.uncopied ?? "other", "then")) +
              l10n.t("so Undo can't put them back. Nothing was changed."),
          );
        }
        if (oursStop) lines.push(l10n.t("The {0} in progress is abandoned.", settled.op!.kind));
        steps.push({ do: "tree", stash: snap.stashSha });
        lines.push(
          snap.stashSha
            ? l10n.t("Your uncommitted changes go back to how they were before it.")
            : l10n.t("The changes it made to your working tree are taken back."),
        );
        if (now.tree !== settled.tree && now.tree !== CLEAN_TREE) {
          lines.push(l10n.t("Uncommitted changes you have made since are discarded."));
          danger = true;
        } else if (s.asked && now.tree !== CLEAN_TREE) {
          lines.push(ASKED_LINE);
          danger = true;
        }
      }
    }

    // The op's own several-commit run: the reset above cleared its *_HEAD,
    // but git keeps the rest of the run queued, and would call it in progress.
    if (
      oursStop &&
      opNow?.sequence &&
      (opNow.kind === "cherry-pick" || opNow.kind === "revert") &&
      steps.some((st) => st.do === "reset" || st.do === "tree")
    ) {
      steps.push({ do: "quit-sequence", kind: opNow.kind });
    }

    // ── The other branches it moved, created or deleted ─────────────────────
    const head = N.ref;
    for (const m of moved) {
      if (headMoved && m.ref === B.ref) continue;
      const name = branchShort(m.ref);
      const cur = now.branches[m.ref] ?? null;
      if (cur !== m.after) {
        if (m.after === null) {
          return refuse(l10n.t("A branch named '{0}' exists again, so Undo won't bring back the one \"{1}\" deleted. Nothing was changed.", name, label));
        }
        if (cur === null) {
          return refuse(l10n.t("'{0}' has been deleted since \"{1}\", so there is nothing to put back.", name, label));
        }
        return refuse(l10n.t("'{0}' has moved since (it is at {1} now), and putting it back would throw that away.", name, shortSha(cur)));
      }
      const here = head === m.ref && leaving !== m.ref;
      const elsewhere = head !== m.ref ? where.get(m.ref) : undefined;
      if (elsewhere) {
        return refuse(l10n.t("'{0}' is checked out in another worktree, at {1}. Undo it there.", name, elsewhere));
      }
      if (m.after && m.published && publishedSince(m.published, await this.published(m.after, opts))) {
        if (!(m.before && (await this.isAncestor(m.after, m.before, opts)))) {
          return refuse(l10n.t("'{0}' has been pushed since, so putting it back would rewrite published history. Nothing was changed.", name));
        }
      }
      if (m.before === null) {
        if (here) return refuse(l10n.t("'{0}' is checked out. Switch to another branch, then undo.", name));
        if (!(await this.reachable(m.after!, opts, m.ref))) {
          return refuse(l10n.t("'{0}' has the only copy of its commits, so Undo won't delete it. Nothing was changed.", name));
        }
        lines.push(l10n.t("Delete branch '{0}', which \"{1}\" created.", name, label));
      } else if (m.after === null) {
        const up = trackingOf(m.config);
        lines.push(l10n.t("Bring back branch '{0}' at {1}{2}.", name, shortSha(m.before), up ? l10n.t(", tracking '{0}'", up) : ""));
      } else {
        lines.push(l10n.t("'{0}' goes back to {1}.", name, shortSha(m.before)));
        if (here) lines.push("It is checked out, so its files change with it; your uncommitted changes are kept.");
      }
      steps.push({ do: "ref", move: m, here });
    }

    // ── The stashes it took ─────────────────────────────────────────────────
    // A stash the op made that goes again goes first, so the ones it took
    // are placed in the stack as it was before the op.
    const dropping = await this.stashesItMade(snap, settled, now, steps, lines, opts);
    const stack = now.stashes.filter((x) => !dropping.has(x.sha));
    for (const d of unrestoredStashes(settled, now)) {
      const at = placeHolds(stack, d) ? d.index : 0;
      // Named as its row and the op's toast name it (stashTitle), and its
      // place in words: stash@{n} is a position the list renumbers.
      const words = d.message ? stashTitle(d.message).text : shortSha(d.sha);
      lines.push(l10n.t("Put the stash “{0}” back {1}.", words, at > 0 ? l10n.t("where it was in the stash list") : l10n.t("on top of the stash list")));
      steps.push({ do: "stash", entry: d });
    }

    if (steps.length === 0) {
      return { kind: "nothing", reason: "everything it changed is already back as it was." };
    }
    // Something git is stopped in that this op didn't start: a checkout or a
    // hard reset would end it, and that is not this undo's to do.
    if (foreignStop && steps.some((st) => st.do === "switch" || st.do === "reset" || st.do === "tree")) {
      return refuse(l10n.t("{0}. Finish or abort it first, then undo.", stopPhrase(opNow!.kind)));
    }
    return { kind: "restore", steps, lines, danger };
  }

  /**
   * Undo `snap`: put back what it changed, exactly as `plan` says. Throws with
   * a sentence when that can't be done (nothing is changed then) or when git
   * refuses a step part-way (the message says what is left).
   */
  async restore(snap: Snapshot, opts?: GitRunOptions): Promise<void> {
    const p = await this.plan(snap, opts);
    if (p.kind === "refuse") throw new Error(p.reason);
    if (p.kind === "revert") throw new Error(REVERT_NOT_RESTORE);
    if (p.kind === "nothing") return;
    await this.execute(snap, p.steps, opts);
  }

  /** Run a restore plan's steps, in order. */
  async execute(snap: Snapshot, steps: readonly RestoreStep[], opts?: GitRunOptions): Promise<void> {
    // English on purpose: git writes this into the reflog, where `git reflog`
    // shows it to whoever reads the repository, whatever their editor says.
    const message = `GitStudio undo: ${snap.label}`;
    for (const st of steps) {
      switch (st.do) {
        case "abort-rebase": {
          const r = await this.process.run(["rebase", "--abort"], opts);
          if (r.code !== 0) throw new Error(l10n.t("Undo couldn't abandon the rebase: {0}", r.stderr.trim() || "git refused"));
          // git's own autostash (rebase.autoStash) has already put the work
          // back; only onto a clean tree does the copy go.
          if (st.stash && (await this.fingerprint(opts)) === CLEAN_TREE) await this.applyStash(st.stash, opts);
          break;
        }
        case "switch": {
          // By the name under refs/heads/, ended with `--` so a file of that
          // name can't make it a path checkout (plan refused a name git would
          // read as an option). Carries uncommitted work; refuses over it.
          const args = st.ref ? ["checkout", branchShort(st.ref), "--"] : ["checkout", "--detach", st.sha];
          const r = await this.process.run(args, opts);
          if (r.code !== 0) {
            throw new Error(
              l10n.t("Undo couldn't switch back to {0}: {1}", st.ref ? `'${branchShort(st.ref)}'` : shortSha(st.sha), r.stderr.trim() || "git refused"),
            );
          }
          break;
        }
        case "reset": {
          const r = await this.process.run(["reset", `--${st.mode}`, st.to], opts);
          if (r.code !== 0) {
            throw new Error(
              st.mode === "keep"
                ? l10n.t("Undo couldn't go back to {0} without overwriting your uncommitted changes: {1}", shortSha(st.to), r.stderr.trim())
                : l10n.t("Undo failed: could not reset to {0}: {1}", st.to, r.stderr.trim()),
            );
          }
          if (st.stash) await this.applyStash(st.stash, opts);
          break;
        }
        case "tree": {
          const r = await this.process.run(["reset", "--hard", "HEAD"], opts);
          if (r.code !== 0) throw new Error(l10n.t("Undo couldn't put your working tree back: {0}", r.stderr.trim()));
          if (st.stash) await this.applyStash(st.stash, opts);
          break;
        }
        case "ref": {
          const m = st.move;
          await putRefBack(this.process, m, message, { ...opts, here: st.here });
          if (m.before === null && m.configCreated) {
            await this.process.run(["config", "--local", "--remove-section", `branch.${branchShort(m.ref)}`], opts);
          } else if (m.after === null && m.config?.length) {
            const name = branchShort(m.ref);
            const has = (await this.branchConfig(opts))[name];
            if (!has?.length) {
              for (const [key, value] of m.config) {
                await this.process.run(["config", "--local", "--add", key, value], opts);
              }
            }
          }
          break;
        }
        case "stash": {
          const r = await restoreStash(this.process, st.entry, st.entry, opts);
          if (!r.ok) throw new Error(r.message);
          break;
        }
        case "quit-sequence": {
          const r = await this.process.run([st.kind, "--quit"], opts);
          if (r.code !== 0) {
            throw new Error(l10n.t("Undo put things back, but couldn't end the {0} in progress: {1}", st.kind, r.stderr.trim() || "git refused"));
          }
          break;
        }
        case "drop-stash": {
          // By its sha, wherever it sits now; one already gone is left be.
          const at = (await stashStack(this.process, opts)).findIndex((x) => x.sha === st.entry.sha);
          if (at >= 0) {
            const r = await this.process.run(["stash", "drop", "-q", `stash@{${at}}`], opts);
            if (r.code !== 0) throw new Error(l10n.t("Undo put your changes back, but couldn't drop the stash “{0}”: {1}", st.entry.message, r.stderr.trim()));
          }
          break;
        }
      }
    }
  }

  /**
   * The published-history safeguard's undo: a new commit on top rather than a
   * rewrite. `range` reverts each commit the op added; `tree` makes ONE commit
   * whose files are `from`'s — the op's change and nothing else, which is what
   * undoing an amend or a rebase means (a range revert of an amended commit
   * reverted the whole commit, its original change too).
   */
  async revert(snap: Snapshot, p: Extract<RestorePlan, { kind: "revert" }>, opts?: GitRunOptions): Promise<{ code: number; stderr: string; stdout: string }> {
    if (p.mode === "range") {
      return this.process.run(["revert", "--no-edit", `${p.from}..${p.to}`], opts);
    }
    // English on purpose: this is a commit message, stored in the repository
    // itself and read by everyone who looks at the history.
    const msg = `Revert "${snap.label}"\n\nThis puts back the files as they were before "${snap.label}" (${shortSha(p.from)}), which had already been pushed as ${shortSha(p.to)}.\n`;
    const made = await this.process.run(["commit-tree", `${p.from}^{tree}`, "-p", p.to, "-F", "-"], { ...opts, input: msg });
    if (made.code !== 0) return made;
    // The new commit's parent is `p.to`: moving HEAD onto it from anywhere
    // else would drop whatever HEAD has gained since (a commit made while the
    // question was open) from the branch, and its files from the tree.
    const [head, ref] = await Promise.all([this.process.run(["rev-parse", "--verify", "--quiet", "HEAD"], opts), headBranch(this.process, opts)]);
    if (head.stdout.trim() !== p.to || ref !== p.branch) {
      const where = ref === p.branch ? `it is at ${shortSha(head.stdout.trim())} now` : "a different branch is checked out now";
      return {
        code: 1,
        stdout: "",
        stderr: l10n.t("{0} moved while you were being asked ({1}), so nothing was reverted. Try Undo again.", p.branch ? `'${branchShort(p.branch)}'` : l10n.t("HEAD"), where),
      };
    }
    return this.process.run(["reset", "--keep", made.stdout.trim()], opts);
  }

  /**
   * True when `sha` is contained in any remote-tracking branch — i.e. the
   * commit has been published.
   */
  async isPushed(sha: string, opts?: GitRunOptions): Promise<boolean> {
    const result = await this.process.run(["branch", "-r", "--contains", sha], opts);
    if (result.code !== 0) {
      return false;
    }
    return result.stdout.trim().length > 0;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async observe(opts?: GitRunOptions): Promise<Observed> {
    const [head, headRef, tree, branches, stashes, op] = await Promise.all([
      this.process.run(["rev-parse", "--verify", "--quiet", "HEAD"], opts),
      headBranch(this.process, opts),
      this.fingerprint(opts),
      localBranches(this.process, opts),
      stashStack(this.process, opts),
      this.opMark(opts),
    ]);
    return { headSha: head.code === 0 ? head.stdout.trim() : "", headRef, tree, branches, stashes, op };
  }

  /** What changed between the capture (`snap`, its `s`) and `now`. */
  private async diff(snap: Snapshot, s: SnapshotScope, now: Observed, opts?: GitRunOptions): Promise<SettledScope> {
    const before = s.branches ?? {};
    const cfgNow = s.config ? await this.branchConfig(opts) : {};
    const moved: MovedRef[] = [];
    for (const ref of new Set([...Object.keys(before), ...Object.keys(now.branches)])) {
      const b = before[ref] ?? null;
      const a = now.branches[ref] ?? null;
      if (b === a) continue;
      const name = branchShort(ref);
      const m: MovedRef = { ref, before: b, after: a };
      if (a === null && s.config?.[name]?.length) m.config = s.config[name];
      if (b === null && s.config && !s.config[name]?.length && cfgNow[name]?.length) m.configCreated = true;
      if (a !== null) m.published = await this.published(a, opts);
      moved.push(m);
    }
    const stack = s.stashes ?? [];
    const still = new Set(now.stashes.map((x) => x.sha));
    const stashes: DroppedStash[] = [];
    stack.forEach((x, index) => {
      if (still.has(x.sha)) return;
      stashes.push({ sha: x.sha, message: x.message, index, above: stack.slice(0, index).map((y) => y.sha) });
    });
    const had = new Set(stack.map((x) => x.sha));
    const pushed = s.stashes ? now.stashes.filter((x) => !had.has(x.sha)) : [];
    return {
      headRef: now.headRef,
      headSha: now.headSha,
      // A refs-only op never changes it: whatever did is not the op's.
      tree: s.refsOnly ? s.tree : now.tree,
      moved,
      stashes,
      ...(pushed.length ? { pushed } : {}),
      ...(now.op && !sameOp(s.op, now.op) ? { op: now.op } : {}),
      ...(s.headRef === null && now.headRef === null && now.headSha && now.headSha !== snap.headSha
        ? { published: await this.published(now.headSha, opts) }
        : {}),
    };
  }

  /**
   * An op that went on after it was recorded — an interactive rebase in a
   * terminal, or a rebase that stopped and was continued — moved its branches
   * AFTER `settle` looked. Read them from their reflogs, tied to THIS rebase:
   * HEAD's branch counts only through its own "rebase (finish): <it> onto
   * <onto>" after the capture — no finish, and the rebase changed nothing (it
   * was quit, or aborted). Another branch counts only as one this rebase
   * carried (`--update-refs`): its tip was among the commits rebased, and it
   * was "rewritten during rebase" between the capture and that finish. A
   * rebase the user ran later, of any branch, is theirs. A branch moved again
   * since is refused rather than thrown away. A rebase started on a detached
   * HEAD finishes no branch: it is followed through HEAD's own reflog.
   */
  private async resettle(
    snap: Snapshot,
    s: SnapshotScope,
    settled: SettledScope,
    now: Observed,
    opts?: GitRunOptions,
  ): Promise<{ kind: "ok"; settled: SettledScope } | Extract<RestorePlan, { kind: "refuse" | "nothing" }>> {
    if (now.op?.kind === "rebase") {
      return refuse(l10n.t("A rebase is in progress that \"{0}\" didn't start. Finish or abort it first, then undo.", snap.label));
    }
    if (!s.branches) return { kind: "ok", settled };
    const onto = s.deferred?.onto ?? settled.op?.onto;
    if (!s.headRef) return this.resettleDetached(snap, s, settled, now, onto, opts);
    const head = s.headRef;
    const headBefore = s.branches[head] ?? null;
    const headNow = now.branches[head] ?? null;
    const name = branchShort(head);
    const since = await this.reflogSince(head, headBefore, opts);
    if (!since && headBefore !== headNow) {
      return refuse(l10n.t("GitStudio can't tell what moved '{0}' since \"{1}\" (it keeps no reflog), so it won't guess. Nothing was changed.", name, snap.label));
    }
    const finish = since?.find((e) => e.time >= s.time && finishes(e.msg, head, onto));
    if (!finish) {
      return { kind: "nothing", reason: l10n.t("the rebase didn't change any branch.") };
    }
    if (since![0] !== finish) {
      return refuse(l10n.t("'{0}' has moved since the rebase (it is at {1} now), and putting it back would throw that away.", name, headNow ? shortSha(headNow) : l10n.t("nothing")));
    }
    // Published before the op can't be known from here; its commits are new.
    const moved: MovedRef[] = [{ ref: head, before: headBefore, after: headNow, published: [] }];
    const others = await this.carriedBy(snap, s, now, head, onto, finish.time, opts);
    if (typeof others === "string") return refuse(others);
    moved.push(...others);
    return {
      kind: "ok",
      settled: {
        headRef: head,
        headSha: headNow ?? snap.headSha,
        // A rebase ends with nothing uncommitted of its own; with a dirty
        // start what it left can't be known, so later changes are named.
        tree: snap.stashSha ? "?" : CLEAN_TREE,
        moved,
        stashes: [],
        ...(settled.pushed ? { pushed: settled.pushed } : {}),
        published: [],
      },
    };
  }

  /**
   * `resettle` for a rebase started on a detached HEAD. git writes its
   * "rebase (finish)" only to a branch, so this one is read from HEAD's own
   * reflog: its steps after the capture, from its "rebase (start)" (onto
   * `onto`, when known) to its last. An abort, or no start, and the rebase
   * changed nothing; anything HEAD did after its last step is the user's, and
   * putting HEAD back would throw it away.
   */
  private async resettleDetached(
    snap: Snapshot,
    s: SnapshotScope,
    settled: SettledScope,
    now: Observed,
    onto: string | undefined,
    opts?: GitRunOptions,
  ): Promise<{ kind: "ok"; settled: SettledScope } | Extract<RestorePlan, { kind: "refuse" | "nothing" }>> {
    const since = await this.reflogSince("HEAD", snap.headSha, opts);
    if (!since) {
      if (now.headRef === null && now.headSha === snap.headSha) return { kind: "nothing", reason: l10n.t("the rebase didn't change anything.") };
      return refuse(l10n.t("GitStudio can't tell what moved HEAD since \"{0}\" (it keeps no reflog), so it won't guess. Nothing was changed.", snap.label));
    }
    // Oldest first: this rebase's start is the first step after the capture.
    const after = since.filter((e) => e.time >= s.time).reverse();
    const start = after.findIndex((e) => REBASE_STEP.exec(e.msg)?.[1] === "start" && (!onto || e.sha === onto));
    if (start < 0) {
      return { kind: "nothing", reason: l10n.t("the rebase didn't change anything.") };
    }
    let end = start;
    while (end + 1 < after.length && REBASE_STEP.test(after[end + 1].msg)) end++;
    const last = after[end];
    if (REBASE_STEP.exec(last.msg)?.[1] === "abort") {
      return { kind: "nothing", reason: l10n.t("the rebase was abandoned, so it changed nothing.") };
    }
    if (end !== after.length - 1 || now.headRef !== null || now.headSha !== last.sha) {
      // The HEAD section says what moved it (a commit, a checkout of a branch).
      return {
        kind: "ok",
        settled: { headRef: null, headSha: last.sha, tree: snap.stashSha ? "?" : CLEAN_TREE, moved: [], stashes: [], published: [] },
      };
    }
    const others = await this.carriedBy(snap, s, now, null, onto, last.time, opts);
    if (typeof others === "string") return refuse(others);
    return {
      kind: "ok",
      settled: {
        headRef: null,
        headSha: last.sha,
        tree: snap.stashSha ? "?" : CLEAN_TREE,
        moved: others,
        stashes: [],
        ...(settled.pushed ? { pushed: settled.pushed } : {}),
        published: [],
      },
    };
  }

  /**
   * The branches a rebase carried with it (`--update-refs`) — each a tip among
   * the commits rebased, "rewritten during rebase" between the capture and the
   * rebase's end — or a sentence when one has moved again since.
   */
  private async carriedBy(
    snap: Snapshot,
    s: SnapshotScope,
    now: Observed,
    head: string | null,
    onto: string | undefined,
    endTime: number,
    opts?: GitRunOptions,
  ): Promise<MovedRef[] | string> {
    const out: MovedRef[] = [];
    const branches = s.branches ?? {};
    const carried = (e: { msg: string; time: number }): boolean =>
      e.msg === REBASE_CARRIED && e.time >= s.time && e.time <= endTime + CARRY_SLACK;
    for (const ref of new Set([...Object.keys(branches), ...Object.keys(now.branches)])) {
      if (ref === head) continue;
      const b = branches[ref] ?? null;
      const a = now.branches[ref] ?? null;
      if (b === a || b === null) continue;
      // Only a tip among the commits rebased can be carried with them.
      if (!(await this.isAncestor(b, snap.headSha, opts)) || (onto && (await this.isAncestor(b, onto, opts)))) continue;
      const moves = await this.reflogSince(ref, b, opts);
      if (!moves || !moves.some(carried)) continue;
      if (!carried(moves[0])) {
        return l10n.t("'{0}' has moved since the rebase (it is at {1} now), and putting it back would throw that away.", branchShort(ref), a ? shortSha(a) : l10n.t("nothing"));
      }
      out.push({ ref, before: b, after: a, published: [] });
    }
    return out;
  }

  /** `ref`'s reflog entries since it was last at `was` (newest first, with their times); undefined without a reflog. */
  private async reflogSince(
    ref: string,
    was: string | null,
    opts?: GitRunOptions,
  ): Promise<{ sha: string; msg: string; time: number }[] | undefined> {
    // `%gd` with --date=unix is "<ref>@{<seconds>}": the entry's own time.
    const r = await this.process.run(["reflog", "show", "--date=unix", "--format=%H%x1f%gd%x1f%gs", ref, "--"], opts);
    if (r.code !== 0) return undefined;
    const entries = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", selector = "", ...msg] = l.split("\x1f");
        const time = Number(/@\{(\d+)\}$/.exec(selector)?.[1] ?? NaN);
        return { sha, msg: msg.join("\x1f"), time };
      });
    if (entries.length === 0) return undefined;
    const out: { sha: string; msg: string; time: number }[] = [];
    for (const e of entries) {
      if (was !== null && e.sha === was) return out;
      out.push(e);
    }
    return was === null ? out : undefined;
  }

  /**
   * Stashes the op made (a Stash & Retry's) that are still on the stack. When
   * this undo puts the uncommitted work back from its own copy and a stash
   * holds nothing more than that copy, it goes again — the work is back in
   * the tree. One holding more (untracked files, other contents) is kept,
   * and said. Returns the shas that go.
   */
  private async stashesItMade(
    snap: Snapshot,
    settled: SettledScope,
    now: Observed,
    steps: RestoreStep[],
    lines: string[],
    opts?: GitRunOptions,
  ): Promise<Set<string>> {
    const onStack = new Set(now.stashes.map((x) => x.sha));
    const copy = snap.stashSha;
    const putsBack = !!copy && steps.some((st) => "stash" in st && st.stash === copy);
    const going = new Set<string>();
    // The stashes this undo puts back: one the op made that is only a PART of
    // one of them — what was left of a stash once some of its files were
    // moved out — goes too, or the list would hold those files twice.
    const takenBack = unrestoredStashes(settled, now);
    for (const made of settled.pushed ?? []) {
      if (!onStack.has(made.sha)) continue;
      if (
        (putsBack && (await this.stashWithin(made.sha, copy!, opts))) ||
        (await this.partOfAny(made.sha, takenBack, opts))
      ) {
        steps.push({ do: "drop-stash", entry: made });
        going.add(made.sha);
      } else {
        lines.push(l10n.t("The stash “{0}” it made is kept: it holds more than Undo puts back.", made.message));
      }
    }
    return going;
  }

  /** Is stash `sha` a part of one of `wholes` (see stashPartOf)? */
  private async partOfAny(sha: string, wholes: readonly StashSlot[], opts?: GitRunOptions): Promise<boolean> {
    for (const whole of wholes) {
      if (await this.stashPartOf(sha, whole.sha, opts)) return true;
    }
    return false;
  }

  /**
   * Is stash `part` a part of stash `whole` — the same base, and every file it
   * changes (working copy, staged version, untracked file) the same in
   * `whole`? What is left of a stash after some of its files were moved out
   * is such a part (StashProvider.subset).
   */
  private async stashPartOf(part: string, whole: string, opts?: GitRunOptions): Promise<boolean> {
    const parentsOf = async (sha: string): Promise<string[]> => {
      const r = await this.process.run(["rev-list", "--parents", "-n", "1", sha, "--"], opts);
      return r.code === 0 ? r.stdout.trim().split(/\s+/).slice(1) : [];
    };
    const [p, w] = await Promise.all([parentsOf(part), parentsOf(whole)]);
    if (p.length < 2 || w.length < 2 || p[0] !== w[0]) return false;
    if (p.length > 2 && w.length < 3) return false;
    const names = async (a: string, b: string, root = false): Promise<string[] | undefined> => {
      const args = root ? ["diff-tree", "-r", "-z", "--name-only", "--no-commit-id", "--root", a, "--"] : ["diff-tree", "-r", "-z", "--name-only", "--no-renames", a, b, "--"];
      const r = await this.process.run(args, opts);
      return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : undefined;
    };
    const sides: [string, string, string][] = [
      [p[0], part, whole],
      [p[0], p[1], w[1]],
    ];
    for (const [base, mine, theirs] of sides) {
      const [changed, differ] = await Promise.all([names(base, mine), names(mine, theirs)]);
      if (!changed || !differ) return false;
      const d = new Set(differ);
      if (changed.some((x) => d.has(x))) return false;
    }
    if (p.length > 2) {
      const [changed, differ] = await Promise.all([names(p[2], "", true), names(p[2], w[2])]);
      if (!changed || !differ) return false;
      const d = new Set(differ);
      if (changed.some((x) => d.has(x))) return false;
    }
    return true;
  }

  /**
   * Does stash `sha` hold nothing that stash-like commit `copy` doesn't —
   * no untracked part, and for every file it changes, the same content in
   * `copy`'s working tree and index?
   */
  private async stashWithin(sha: string, copy: string, opts?: GitRunOptions): Promise<boolean> {
    const parents = await this.process.run(["rev-list", "--parents", "-n", "1", sha], opts);
    const ids = parents.code === 0 ? parents.stdout.trim().split(/\s+/) : [];
    // [stash, base, index] — a fourth is its untracked files, which no copy holds.
    if (ids.length !== 3) return false;
    const names = async (a: string, b: string): Promise<string[] | undefined> => {
      const r = await this.process.run(["diff", "--name-only", "-z", "--no-renames", a, b, "--"], opts);
      return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : undefined;
    };
    const [changedTree, changedIndex, treeDiff, indexDiff] = await Promise.all([
      names(`${sha}^1`, sha),
      names(`${sha}^1`, `${sha}^2`),
      names(sha, copy),
      names(`${sha}^2`, `${copy}^2`),
    ]);
    if (!changedTree || !changedIndex || !treeDiff || !indexDiff) return false;
    const differ = new Set(treeDiff);
    const differIndex = new Set(indexDiff);
    return changedTree.every((p) => !differ.has(p)) && changedIndex.every((p) => !differIndex.has(p));
  }

  /**
   * The working-tree files that differ from `commit`, and the untracked ones
   * (ignored aside), by content digest — what a reset to `commit` that leaves
   * the files alone would leave. Untracked count because such a reset turns a
   * staged new file into an untracked one, same content, same place.
   */
  private async fileDigests(commit: string, opts?: GitRunOptions): Promise<Record<string, string> | undefined> {
    const [top, changed, untracked] = await Promise.all([
      this.process.run(["rev-parse", "--show-toplevel"], opts),
      this.process.run(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", commit, "--"], opts),
      this.process.run(["ls-files", "--others", "--exclude-standard", "-z"], opts),
    ]);
    if (changed.code !== 0 || untracked.code !== 0) return undefined;
    const root = top.code === 0 ? top.stdout.trim() : this.process.cwd;
    const out: Record<string, string> = {};
    for (const p of [...changed.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean)) {
      out[p] = fileDigest(join(root, p));
    }
    return out;
  }

  /**
   * A fingerprint of everything uncommitted — the index against HEAD, what is
   * unmerged, and the content of every tracked file that differs from HEAD —
   * so Undo can tell whether anything has changed since the op. Untracked
   * files are not in it: nothing an undo runs deletes them.
   */
  private async fingerprint(opts?: GitRunOptions): Promise<string> {
    const [top, cached, unmerged, changed] = await Promise.all([
      this.process.run(["rev-parse", "--show-toplevel"], opts),
      this.process.run(["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "HEAD", "--"], opts),
      this.process.run(["ls-files", "-u", "-s", "-z"], opts),
      this.process.run(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "HEAD", "--"], opts),
    ]);
    if (!cached.stdout && !unmerged.stdout && !changed.stdout) return CLEAN_TREE;
    const root = top.code === 0 ? top.stdout.trim() : this.process.cwd;
    const h = createHash("sha1");
    h.update(cached.stdout).update("\0\0").update(unmerged.stdout).update("\0\0");
    for (const p of changed.stdout.split("\0").filter(Boolean)) {
      h.update(p).update("\0").update(fileDigest(join(root, p))).update("\0");
    }
    return h.digest("hex");
  }

  /** What git is stopped in right now (undefined: nothing). */
  private async opMark(opts?: GitRunOptions): Promise<OpMark | undefined> {
    const at = async (p: string): Promise<string> => {
      const r = await this.process.run(["rev-parse", "--git-path", p], opts);
      return r.code === 0 ? resolve(this.process.cwd, r.stdout.trim()) : "";
    };
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const d = await at(dir);
      if (!d || !isDir(d)) continue;
      if (dir === "rebase-apply" && existsSync(join(d, "applying"))) return { kind: "am" };
      return {
        kind: "rebase",
        headName: readText(join(d, "head-name")),
        origHead: readText(join(d, "orig-head")),
        onto: readText(join(d, "onto")),
      };
    }
    for (const [file, kind] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      const f = await at(file);
      if (!f || !existsSync(f)) continue;
      if (kind === "merge") return { kind, head: readText(f) };
      // A single pick never writes sequencer/; a run of several keeps the rest there.
      const seq = await at("sequencer");
      return { kind, head: readText(f), ...(seq && isDir(seq) ? { sequence: true as const } : {}) };
    }
    return undefined;
  }

  /** `branch.<name>.*` config by branch name. */
  private async branchConfig(opts?: GitRunOptions): Promise<Record<string, [string, string][]>> {
    const r = await this.process.run(["config", "--local", "-z", "--get-regexp", "^branch\\."], opts);
    const out: Record<string, [string, string][]> = {};
    if (r.code !== 0) return out;
    for (const entry of r.stdout.split("\0")) {
      if (!entry) continue;
      const nl = entry.indexOf("\n");
      const key = nl < 0 ? entry : entry.slice(0, nl);
      const value = nl < 0 ? "" : entry.slice(nl + 1);
      const last = key.lastIndexOf(".");
      if (!key.startsWith("branch.") || last <= "branch.".length) continue;
      const name = key.slice("branch.".length, last);
      (out[name] ??= []).push([key, value]);
    }
    return out;
  }

  /** Remote-tracking branches that contain `sha`. */
  private async published(sha: string, opts?: GitRunOptions): Promise<Published> {
    const r = await this.process.run(["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/remotes/"], opts);
    if (r.code !== 0) return [];
    const refs = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith("/HEAD"))
      .sort();
    return refs.length > 64 ? { count: refs.length } : refs;
  }

  /** Is `sha` reachable from some ref (other than `except`)? */
  private async reachable(sha: string, opts?: GitRunOptions, except?: string): Promise<boolean> {
    const r = await this.process.run(["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads/", "refs/tags/", "refs/remotes/"], opts);
    if (r.code !== 0) return true; // can't tell: don't claim it's orphaned
    return r.stdout.split("\n").some((l) => l.trim() && l.trim() !== except);
  }

  /** Does any uncommitted change touch a file that differs between `a` and `b`? */
  private async overlaps(a: string, b: string, opts?: GitRunOptions): Promise<boolean> {
    const [between, dirty, untracked] = await Promise.all([
      this.process.run(["diff", "--name-only", "-z", "--no-renames", a, b, "--"], opts),
      this.process.run(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"], opts),
      this.process.run(["ls-files", "--others", "--exclude-standard", "-z"], opts),
    ]);
    if (between.code !== 0 || dirty.code !== 0) return true;
    const touched = new Set(between.stdout.split("\0").filter(Boolean));
    return [...dirty.stdout.split("\0"), ...untracked.stdout.split("\0")].some((p) => p && touched.has(p));
  }

  /**
   * Untracked files (ignored ones aside, as git itself treats them) where `to`
   * has a file `from` doesn't, holding something other than `to`'s copy: what
   * a hard reset from `from` to `to` would overwrite and lose. A mixed reset's
   * own leftovers — the files it untracked, unchanged — are `to`'s copy, and
   * not in the way.
   */
  private async untrackedInTheWay(from: string, to: string, opts?: GitRunOptions): Promise<string[]> {
    const [added, untracked] = await Promise.all([
      this.process.run(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", from, to, "--"], opts),
      this.process.run(["ls-files", "--others", "--exclude-standard", "-z"], opts),
    ]);
    if (added.code !== 0 || untracked.code !== 0) return [];
    const add = new Set(added.stdout.split("\0").filter(Boolean));
    const candidates = untracked.stdout.split("\0").filter((p) => p && add.has(p));
    if (!candidates.length) return [];
    // A name with a newline can't be hashed through --stdin-paths: in the way.
    const hashable = candidates.filter((p) => !p.includes("\n"));
    const [listed, hashed] = await Promise.all([
      this.process.run(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", to, "--", ...hashable], opts),
      hashable.length
        ? this.process.run(["hash-object", "--stdin-paths"], { ...opts, input: `${hashable.join("\n")}\n` })
        : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    ]);
    if (listed.code !== 0 || hashed.code !== 0) return candidates;
    const theirs = new Map<string, string>();
    for (const row of listed.stdout.split("\0")) {
      const tab = row.indexOf("\t");
      if (tab < 0) continue;
      theirs.set(row.slice(tab + 1), row.slice(0, tab).split(" ")[2] ?? "");
    }
    const ours = hashed.stdout.split("\n").filter(Boolean);
    if (ours.length !== hashable.length) return candidates;
    const same = new Set(hashable.filter((p, i) => theirs.get(p) === ours[i]));
    return candidates.filter((p) => !same.has(p));
  }

  private async isAncestor(a: string, b: string, opts?: GitRunOptions): Promise<boolean> {
    return (await this.process.run(["merge-base", "--is-ancestor", a, b], opts)).code === 0;
  }

  private async mergesBetween(a: string, b: string, opts?: GitRunOptions): Promise<number> {
    const r = await this.process.run(["rev-list", "--merges", "--count", `${a}..${b}`], opts);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 1;
  }

  /**
   * Re-apply the uncommitted changes captured before the op — staged ones
   * staged again (`--index`), falling back to all-unstaged only when the
   * index part can't go back as it was.
   */
  private async applyStash(sha: string, opts?: GitRunOptions): Promise<void> {
    const indexed = await this.process.run(["stash", "apply", "--index", sha], opts);
    if (indexed.code === 0) return;
    const st = await this.process.run(["status", "--porcelain", "--untracked-files=no"], opts);
    if (st.code === 0 && st.stdout.trim() === "") {
      const plain = await this.process.run(["stash", "apply", sha], opts);
      if (plain.code === 0) return;
      throw new Error(
        l10n.t("Undo restored the commit but re-applying your uncommitted changes hit a conflict: {0} ", plain.stderr.trim()) +
          l10n.t("`git stash apply {0}` brings them back.", sha),
      );
    }
    throw new Error(
      l10n.t("Undo restored the commit but re-applying your uncommitted changes hit a conflict: {0} ", indexed.stderr.trim()) +
        l10n.t("`git stash apply {0}` brings them back.", sha),
    );
  }

  /** The commit a full ref name points at ("" when there is no such ref). */
  private async commitOf(ref: string, opts?: GitRunOptions): Promise<string> {
    const result = await this.process.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts);
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private async isDirty(opts?: GitRunOptions): Promise<boolean> {
    const result = await this.process.run(["status", "--porcelain"], opts);
    return result.stdout.trim().length > 0;
  }

  private async run(args: string[], opts?: GitRunOptions): Promise<string> {
    const result = await this.process.run(args, opts);
    if (result.code !== 0) {
      throw new Error(l10n.t("git {0} failed: {1}", args.join(" "), result.stderr.trim()));
    }
    return result.stdout;
  }
}

interface Observed {
  headSha: string;
  headRef: string | null;
  tree: string;
  branches: Record<string, string>;
  stashes: StashSlot[];
  op?: OpMark;
}

const REVERT_NOT_RESTORE =
  l10n.t("It has been pushed since, so putting it back would rewrite published history — it can only be reverted.");

function refuse(reason: string): { kind: "refuse"; reason: string } {
  return { kind: "refuse", reason };
}

/** Is this reflog message `head`'s own rebase finishing (onto `onto`, when known)? */
function finishes(msg: string, head: string, onto: string | undefined): boolean {
  const m = REBASE_FINISH.exec(msg);
  if (!m) return false;
  const [branch, base] = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
  return branch === head && (!onto || base === onto);
}

/** The same files with the same contents? */
function sameDigests(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

function sameOp(a: OpMark | undefined, b: OpMark | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.headName === b.headName && a.origHead === b.origHead && a.onto === b.onto && a.head === b.head;
}

/** Were `sha`'s remote-tracking branches `now` more than `then`? Unknown `then`: no. */
function publishedSince(then: Published | undefined, now: Published): boolean {
  if (!then) return false;
  if (Array.isArray(then) && Array.isArray(now)) return now.some((r) => !then.includes(r));
  const t = Array.isArray(then) ? then.length : then.count;
  const n = Array.isArray(now) ? now.length : now.count;
  return n > t;
}

/** The stashes the op took that are not back on the stack, in the order they go back. */
function unrestoredStashes(settled: SettledScope, now: Observed): DroppedStash[] {
  const have = new Set(now.stashes.map((x) => x.sha));
  return settled.stashes.filter((d) => !have.has(d.sha)).sort((a, b) => a.index - b.index);
}

/** "origin/feature" from a branch's config lines, when it tracked a remote branch. */
function trackingOf(config: [string, string][] | undefined): string | undefined {
  if (!config) return undefined;
  const remote = config.find(([k]) => k.endsWith(".remote"))?.[1];
  const merge = config.find(([k]) => k.endsWith(".merge"))?.[1];
  if (!remote || !merge || remote === ".") return undefined;
  return `${remote}/${merge.replace(/^refs\/heads\//, "")}`;
}

/** "A merge is in progress" — the stop, in words. */
function stopPhrase(kind: OpMark["kind"]): string {
  return kind === "am" ? l10n.t("A patch series (git am) is in progress") : l10n.t("A {0} is in progress", kind);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A file's content digest for the fingerprint (a symlink by its target, a big file by size and time). */
function fileDigest(abs: string): string {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `L${readlinkSync(abs)}`;
    if (st.isDirectory()) return "D";
    if (st.size > DIGEST_LIMIT) return `S${st.size}:${st.mtimeMs}`;
    return `F${createHash("sha1").update(readFileSync(abs)).digest("hex")}`;
  } catch {
    return "-";
  }
}
