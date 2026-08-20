import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GraphMenuItem, WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { ErrorReporter } from "../reporting/errorReporter";
import { pausedForUser } from "../git/pausedForUser";
import { unresolvedConflictsMessage } from "@gitstudio/git-service/ConflictProvider";
import { planRemoteCheckout } from "@gitstudio/git-service/checkoutRemote";
import { promptConfirm, promptInput, promptPick } from "../ui/dialogs";
import { ellipsizeMiddle, resolveCheckoutTarget } from "./checkoutTarget";

/** The commit actions as plain items for the IN-GRAPH popover (no vscode types
 * / codicon markup) — the webview renders these; ids match runCommitAction. */
export function commitMenuItems(): GraphMenuItem[] {
  return [
    { id: "checkout", label: "Checkout Commit", icon: "git-commit" },
    // Detaching stays a FIRST-CLASS action. "Checkout Commit" prefers the
    // branch a commit sits on (see checkout()), which is right for the common
    // case but silently removed the ability to detach at a commit that has one
    // — the old behaviour, and the whole point of checking a commit out for
    // some workflows. Making it a separate item keeps both reachable.
    { id: "detach", label: "Detach HEAD Here…", icon: "git-commit" },
    { id: "branch", label: "Create Branch Here…", icon: "git-branch" },
    { id: "tag", label: "Create Tag Here…", icon: "tag" },
    { id: "cherryPick", label: "Cherry-Pick Commit", icon: "git-pull-request" },
    { id: "revert", label: "Revert Commit", icon: "history" },
    { id: "reset", label: "Reset Current Branch to Here…", icon: "discard", danger: true },
    { id: "interactiveRebase", label: "Start Interactive Rebase Here…", icon: "git-merge" },
    { id: "", label: "", sep: true },
    { id: "copySha", label: "Copy SHA", icon: "copy" },
    { id: "copyMessage", label: "Copy Message", icon: "copy" },
  ];
}

/** Namespace for the per-ref items, so they cannot collide with a commit id. */
const REF_ACTION = "ref:";

/**
 * "Checkout <branch>" entries for the refs sitting on a commit, shown above the
 * commit actions.
 *
 * The menu used to be purely commit-scoped, so right-clicking a row whose tip is
 * `main` offered only "Checkout Commit" — which detaches HEAD. Landing on a
 * detached HEAD when you meant "switch to main" is the wrong outcome, and the
 * branch name was right there on the row.
 *
 * Built host-side from the refs the panel already holds rather than from the
 * clicked chip, which is deliberate: a row's local branch and its remote twin
 * render as ONE chip, and any ref that does not fit the column is folded into a
 * "+N" pill, so a chip-driven menu could never reach either. The name rides in
 * the id, so this needs no protocol change.
 */
export function refMenuItems(refs: readonly WireRef[]): GraphMenuItem[] {
  const items: GraphMenuItem[] = [];
  for (const ref of refs) {
    // Already on it — offering to switch to where you are is noise.
    if (ref.kind === "currentHead") {
      continue;
    }
    if (ref.kind === "head") {
      items.push({
        id: `${REF_ACTION}head:${ref.name}`,
        label: `Checkout ${ref.name}`,
        icon: "git-branch",
      });
    } else if (ref.kind === "remoteHead") {
      // No ellipsis: as of 1.6.0 this acts immediately, landing you on a local
      // branch that tracks the remote one. It used to open a rename prompt and
      // was labelled "…" accordingly; leaving the ellipsis behind would promise
      // a dialog that no longer exists, which is exactly the thing an ellipsis
      // is for. The tag arm below keeps its ellipsis because it still asks.
      items.push({
        id: `${REF_ACTION}remoteHead:${ref.name}`,
        label: `Checkout ${ref.name}`,
        icon: "cloud",
      });
    } else {
      // Ellipsis: checking out a tag confirms first, because it detaches HEAD.
      items.push({
        id: `${REF_ACTION}tag:${ref.name}`,
        label: `Checkout ${ref.name}…`,
        icon: "tag",
      });
    }
  }
  if (items.length) {
    items.push({ id: "", label: "", sep: true });
  }
  return items;
}

/**
 * The commit-graph context-menu actions. Each runs a real git command via the
 * GitContext process pool, confirms destructive operations clearly, and surfaces
 * git's stderr on failure. Returns true when the repo state likely changed
 * (so the caller can refresh the graph).
 *
 * The universal Undo envelope (M8) wraps the destructive actions: callers pass
 * an `undo` runner that snapshots the repo before the op and records an entry
 * for one-keystroke reversal (with a pushed-history → Revert safeguard). The
 * non-destructive actions (branch, tag, copy) run unwrapped.
 */

interface CommitContext {
  /** Full sha of the targeted commit. */
  readonly sha: string;
  /** Commit subject, for friendlier prompts/messages. */
  readonly subject: string;
  /**
   * The refs sitting on this commit, when the caller knows them. Checkout uses
   * them to land you on a BRANCH rather than a detached HEAD — see checkout().
   */
  readonly refs?: readonly WireRef[];
}

/**
 * Wraps a destructive op so the Undo envelope can snapshot before / record
 * after. When no runner is supplied the op runs directly (so existing tests and
 * any caller without an UndoLedger keep working).
 */
export type UndoRunner = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

function withUndo<T>(
  undo: UndoRunner | undefined,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  return undo ? undo(label, fn) : fn();
}

export interface CommitActionItem extends vscode.QuickPickItem {
  id: string;
}

/** The action menu, in the order GitLens presents them. */
export function commitActionItems(): CommitActionItem[] {
  return [
    { id: "checkout", label: "$(git-commit) Checkout Commit" },
    { id: "detach", label: "$(git-commit) Detach HEAD Here…" },
    { id: "branch", label: "$(git-branch) Create Branch Here…" },
    { id: "tag", label: "$(tag) Create Tag Here…" },
    { id: "cherryPick", label: "$(git-pull-request) Cherry-Pick Commit" },
    { id: "revert", label: "$(history) Revert Commit" },
    {
      id: "reset",
      label: "$(discard) Reset Current Branch to Here…",
    },
    {
      id: "interactiveRebase",
      label: "$(git-merge) Start Interactive Rebase Here…",
    },
    { id: "", label: "", kind: vscode.QuickPickItemKind.Separator },
    { id: "copySha", label: "$(copy) Copy SHA" },
    { id: "copyMessage", label: "$(copy) Copy Message" },
  ];
}

/**
 * Runs the chosen action. `ctx` is the active repo's GitContext; `commit`
 * carries the target sha + subject. Returns true if the graph should refresh.
 */
export async function runCommitAction(
  id: string,
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  switch (id) {
    case "checkout":
      return checkout(ctx, commit, undo);
    case "detach":
      return detachHere(ctx, commit, undo);
    case "branch":
      return createBranch(ctx, commit);
    case "tag":
      return createTag(ctx, commit);
    case "cherryPick":
      return cherryPick(ctx, commit, undo);
    case "revert":
      return revert(ctx, commit, undo);
    case "reset":
      return resetTo(ctx, commit, undo);
    case "copySha":
      await vscode.env.clipboard.writeText(commit.sha);
      flash(`Copied ${short(commit.sha)}`);
      return false;
    case "copyMessage":
      await vscode.env.clipboard.writeText(commit.subject);
      flash("Copied commit message");
      return false;
    default:
      // The per-ref checkout items carry their ref name in the id.
      if (id.startsWith(REF_ACTION)) {
        return checkoutRef(id.slice(REF_ACTION.length), ctx, undo);
      }
      return false;
  }
}

// ── Individual actions ───────────────────────────────────────────────────────

/**
 * Check out one of the refs on the row. `rest` is "<kind>:<name>"; a ref name may
 * itself contain ":" only in forms git rejects, but split on the FIRST colon
 * anyway so a odd name can never be silently truncated.
 *
 * Each arm mirrors the Branches view (views/branchActions.ts) exactly, so the
 * same operation asks the same question wherever you start it.
 */
async function checkoutRef(
  rest: string,
  ctx: GitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const sep = rest.indexOf(":");
  const kind = sep < 0 ? "" : rest.slice(0, sep);
  const name = sep < 0 ? "" : rest.slice(sep + 1);
  if (!name) {
    return false;
  }

  if (kind === "head") {
    return withUndo(undo, `Checkout ${name}`, () =>
      runGit(ctx, ["checkout", name], `Switched to ${name}`),
    );
  }

  if (kind === "remoteHead") {
    // Straight to the branch — no name prompt. "Checkout origin/x" now does what
    // it says, the same as clicking a local branch does.
    const plan = await planRemoteCheckout(ctx.process, name);
    return withUndo(undo, plan.undoLabel, () =>
      runGit(ctx, plan.args, plan.success),
    );
  }

  if (kind === "tag") {
    const ok = await promptConfirm({
      title: `Check out tag ${name}?`,
      message:
        "A tag is a fixed point, so you'll be on a detached HEAD — not on any branch. Commits made here belong to nothing until you create a branch for them.",
      confirmLabel: "Checkout",
    });
    if (!ok) {
      return false;
    }
    return withUndo(undo, `Checkout ${name}`, () =>
      runGit(ctx, ["checkout", "--detach", name], `Checked out ${name}`),
    );
  }

  return false;
}

/**
 * Check out a commit — as a BRANCH whenever this commit is one.
 *
 * Checking out the tip of `main` by sha lands you on a detached HEAD at a
 * commit that git would happily have called `main`. It is technically what was
 * asked for and almost never what was meant: the next commit belongs to no
 * branch, and the UI has to start explaining detached HEAD for a click that
 * looked routine. So when the commit carries local branches:
 *
 *  - exactly one, and it is not already current → switch to it, no warning
 *    needed, because nothing surprising happens;
 *  - more than one → ask WHICH, since the sha alone cannot say;
 *  - already the current branch → say so instead of re-running a no-op.
 *
 * Detaching stays available in the "more than one" picker and remains the
 * behaviour for a commit with no local branch on it, which is the only case
 * where detaching is what the user actually asked for.
 */
async function checkout(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const target = resolveCheckoutTarget(commit.refs);

  if (target.kind === "already") {
    flash(`Already on ${target.name}`);
    return false;
  }

  // ONE short dialog that offers both outcomes, rather than a wall of prose
  // asking yes/no to just one of them. The previous version named the branch
  // twice — once in the title, once in the body — which on a long ref filled
  // the dialog with the same string wrapped over six lines and still did not
  // let you pick the other option.
  if (target.kind === "branch" || target.kind === "choose") {
    const branches = target.kind === "branch" ? [target.name] : target.branches;
    const picked = await promptPick({
      title: `Check out ${short(commit.sha)}`,
      choices: [
        ...branches.map((name) => ({
          id: name,
          label: `Switch to ${ellipsizeMiddle(name)}`,
          icon: "git-branch",
        })),
        {
          id: DETACH_CHOICE,
          label: "Detach HEAD here",
          icon: "git-commit",
          description: "Not on any branch",
        },
      ],
    });
    if (!picked) {
      return false;
    }
    if (picked === DETACH_CHOICE) {
      return detachAt(ctx, commit, undo);
    }
    // Choosing a name IS the confirmation — do not ask twice.
    return withUndo(undo, `Checkout ${picked}`, () =>
      runGit(ctx, ["checkout", picked], `Switched to ${picked}`),
    );
  }

  return detachHere(ctx, commit, undo);
}

/**
 * Sentinel for the "detach" row, safe to sit in the same id space as ref names:
 * git forbids ".." anywhere in a ref name, and unlike a NUL it survives JSON and
 * a DOM attribute without surprises.
 */
const DETACH_CHOICE = "..detach";

/** Detach HEAD at this commit, confirming first. Its own menu action. */
async function detachHere(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const ok = await promptConfirm({
    title: `Check out ${short(commit.sha)}?`,
    message:
      "You'll be on a detached HEAD — not on any branch. Commits made here belong to nothing until you create a branch for them.",
    confirmLabel: "Checkout",
  });
  if (!ok) {
    return false;
  }
  return detachAt(ctx, commit, undo);
}

/**
 * Explicitly `--detach`. The bare `git checkout <sha>` this used to run detaches
 * too, but only because a sha is not a branch name — say it outright so the
 * command cannot be re-read as an ordinary checkout.
 */
function detachAt(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  return withUndo(undo, `Checkout ${short(commit.sha)}`, () =>
    runGit(ctx, ["checkout", "--detach", commit.sha], "Checked out"),
  );
}

async function createBranch(
  ctx: GitContext,
  commit: CommitContext,
): Promise<boolean> {
  const name = await promptInput({
    title: `Create branch at ${short(commit.sha)}`,
    hint: `${commit.subject} — the branch starts here. You stay on the current branch.`,
    placeholder: "feature/my-branch",
    confirmLabel: "Create Branch",
    validate: "refName",
  });
  if (!name) {
    return false;
  }
  return runGit(ctx, ["branch", name, commit.sha], `Created branch ${name}`);
}

async function createTag(
  ctx: GitContext,
  commit: CommitContext,
): Promise<boolean> {
  const name = await promptInput({
    title: `Create tag at ${short(commit.sha)}`,
    hint: `${commit.subject} — a lightweight tag, local until you push it.`,
    placeholder: "v1.0.0",
    confirmLabel: "Create Tag",
    validate: "refName",
  });
  if (!name) {
    return false;
  }
  return runGit(ctx, ["tag", name, commit.sha], `Created tag ${name}`);
}

async function cherryPick(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  return withUndo(undo, `Cherry-pick ${short(commit.sha)}`, async () => {
    const result = await ctx.process.run(["cherry-pick", commit.sha]);
    if (result.code === 0) {
      flash(`Cherry-picked ${short(commit.sha)}`);
      return true;
    }
    const stderr = result.stderr.trim();
    // Paused, not failed. Git leaves CHERRY_PICK_HEAD behind whenever it stops
    // to ask you something — a conflict, or a pick that turned out to be empty
    // because the change is already on this branch.
    //
    // Matching git's English prose is what got this wrong: a user on a Russian
    // locale hit the empty-pick case, the /conflict/i test did not fire, and a
    // routine "this is already applied" was shown as a failure AND filed as a
    // crash report. The marker file says the same thing in every language.
    if (await pausedForUser(ctx.process, result.code, "CHERRY_PICK_HEAD")) {
      void vscode.window.showWarningMessage(
        `Cherry-pick of ${short(commit.sha)} needs a decision — resolve any ` +
          `conflicts and continue, skip this commit, or abort.`,
      );
      return true;
    }
    await showGitError(ctx, "Cherry-pick failed", stderr);
    return true;
  });
}

/**
 * Reverting a MERGE needs to know which side to keep.
 *
 * A merge has two parents, so "undo this commit" is ambiguous — git refuses with
 * *"commit X is a merge but no -m option was given"* and stops. We used to hand
 * that sentence straight to the user, which reads as a defect in GitStudio and
 * offers nothing to do about it.
 *
 * Ask instead. `-m 1` keeps the branch the merge was made ON — the common intent
 * ("undo this merge, put my branch back") — and `-m 2` keeps the branch that was
 * merged in. Returns the mainline number, `undefined` for an ordinary commit, or
 * `null` if the user cancelled.
 */
async function mainlineFor(
  ctx: GitContext,
  commit: CommitContext,
): Promise<number | undefined | null> {
  const r = await ctx.process.run(["rev-list", "--parents", "-n", "1", commit.sha]);
  if (r.code !== 0) {
    return undefined; // let the revert itself report the real problem
  }
  const parents = r.stdout.trim().split(/\s+/).slice(1);
  if (parents.length < 2) {
    return undefined;
  }

  const describe = async (sha: string): Promise<string> => {
    const s = await ctx.process.run(["log", "-1", "--format=%s", sha]);
    return s.code === 0 ? s.stdout.trim() : "";
  };
  const subjects = await Promise.all(parents.map(describe));

  // Every parent, not just the first two — an octopus merge has three or more,
  // and offering a subset would silently make the others unrevertable.
  const pair = parents.length === 2;
  const chosen = await promptPick({
    title: `Revert the merge ${short(commit.sha)}`,
    hint: pair
      ? "A merge has two sides, so git needs to know which one to keep."
      : `This merge has ${parents.length} parents. Which one should be kept as the mainline?`,
    choices: parents.map((sha, i) => ({
      id: String(i + 1),
      label: pair
        ? i === 0
          ? "Keep the branch this was merged into"
          : "Keep the branch that was merged in"
        : `Keep parent ${i + 1}`,
      icon: i === 0 ? "git-branch" : "git-merge",
      detail: short(sha),
      description:
        subjects[i] || (i === 0 ? "The first parent — usually what you want." : ""),
    })),
  });
  if (!chosen) {
    return null;
  }
  const picked = Number(chosen);
  // git counts parents from 1. An id outside that range cannot happen — they are
  // generated just above — but falling back to 1 would silently revert against
  // the WRONG parent, so treat it as a cancel instead.
  return Number.isInteger(picked) && picked >= 1 && picked <= parents.length ? picked : null;
}

async function revert(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  const mainline = await mainlineFor(ctx, commit);
  if (mainline === null) {
    return false;
  }
  return withUndo(undo, `Revert ${short(commit.sha)}`, async () => {
    const args = ["revert", "--no-edit"];
    if (mainline !== undefined) {
      args.push("-m", String(mainline));
    }
    args.push(commit.sha);
    const result = await ctx.process.run(args);
    if (result.code === 0) {
      flash(`Reverted ${short(commit.sha)}`);
      return true;
    }
    const stderr = result.stderr.trim();
    // Same locale-independent test as cherryPick: REVERT_HEAD means git stopped
    // to ask, not that the revert failed.
    if (await pausedForUser(ctx.process, result.code, "REVERT_HEAD")) {
      void vscode.window.showWarningMessage(
        `Revert of ${short(commit.sha)} needs a decision — resolve any ` +
          `conflicts and continue, or abort the revert.`,
      );
      return true;
    }
    // Nothing left to undo. Reverting an already-reverted change exits non-zero
    // with an EMPTY stderr — git puts "nothing to commit, working tree clean" on
    // stdout — so reading stderr alone produced a modal saying only "Revert
    // failed", with no reason, for a case where git did exactly the right thing.
    // Reverting a merge twice is an easy thing to do now that it works at all.
    if (!stderr) {
      void vscode.window.showInformationMessage(
        `Nothing to revert — ${short(commit.sha)} is already undone on this branch.`,
      );
      return true;
    }
    await showGitError(ctx, "Revert failed", stderr);
    return true;
  });
}

async function resetTo(
  ctx: GitContext,
  commit: CommitContext,
  undo?: UndoRunner,
): Promise<boolean> {
  // Three named outcomes with real consequences — a dialog, not the search bar.
  const chosen = await promptPick({
    title: `Reset current branch to ${short(commit.sha)}`,
    hint: commit.subject,
    choices: [
      {
        id: "--soft",
        label: "Soft",
        icon: "history",
        detail: "--soft",
        description: "Move the branch. Keep your working tree AND everything staged.",
      },
      {
        id: "--mixed",
        label: "Mixed",
        icon: "list-flat",
        detail: "--mixed",
        description: "Move the branch, keep the working tree, unstage everything. Git's default.",
      },
      {
        id: "--hard",
        label: "Hard",
        icon: "trash",
        detail: "--hard",
        danger: true,
        description: "Move the branch and DISCARD every working-tree and staged change.",
      },
    ],
  });
  if (!chosen) {
    return false;
  }
  const mode = { value: chosen };

  if (mode.value === "--hard") {
    // A second gate, because this is the one reset that destroys work git has
    // never seen — the reflog can restore the commits, but not your edits.
    const ok = await promptConfirm({
      title: `Discard all uncommitted changes?`,
      message: `Hard-resetting to ${short(commit.sha)} throws away every uncommitted edit in the working tree and the index. Undo can move the branch back, but it cannot bring those edits back — git never recorded them.`,
      confirmLabel: "Reset --hard",
      danger: true,
    });
    if (!ok) {
      return false;
    }
  }
  return withUndo(undo, `Reset to ${short(commit.sha)} (${mode.value})`, () =>
    runGit(
      ctx,
      ["reset", mode.value, commit.sha],
      `Reset to ${short(commit.sha)}`,
    ),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runGit(
  ctx: GitContext,
  args: string[],
  successMessage: string,
): Promise<boolean> {
  const result = await ctx.process.run(args);
  if (result.code === 0) {
    flash(successMessage);
    return true;
  }
  await showGitError(ctx, `git ${args[0]} failed`, result.stderr.trim());
  return true;
}

/**
 * Tell the user a git command failed — and decide whether it is worth reporting.
 *
 * Those were the same thing until crash report #9 arrived: "git checkout failed",
 * stderr "error: you need to resolve your current index first". Nothing was
 * broken. The user was mid-conflict, and git declined to move HEAD over an
 * unmerged index, which is exactly what it should do. It was shown as a red error
 * AND filed as a crash.
 *
 * So the question "is this OUR bug?" is asked separately now, with a
 * locale-independent probe: does the index still have unmerged files? If so this
 * is the repo's state, not a defect — say so as a warning, and file nothing.
 *
 * Deliberately NOT the operation markers (MERGE_HEAD and friends). A cherry-pick
 * that turns out empty leaves CHERRY_PICK_HEAD behind with ZERO unmerged files,
 * and that is the report that found the locale bug fixed in 1.5.2 — a
 * marker-based test would have silenced the most valuable report we have had.
 */
async function showGitError(
  ctx: GitContext,
  title: string,
  stderr: string,
): Promise<void> {
  let unmerged = 0;
  try {
    unmerged = await ctx.conflict.unmergedCount();
  } catch {
    unmerged = 0; // never let the probe turn a failure into a silent one
  }
  if (unmerged > 0) {
    void vscode.window.showWarningMessage(
      `${title} — ${unresolvedConflictsMessage(unmerged)}`,
    );
    return;
  }
  void vscode.window.showErrorMessage(
    stderr ? `${title}: ${stderr}` : title,
  );
  // Anonymous, scrubbed crash report so we hear about failures during beta
  // (no-op if the user turned reporting off or VS Code telemetry is off).
  ErrorReporter.current?.captureGitError(title, stderr);
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
