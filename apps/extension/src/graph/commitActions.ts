import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GraphMenuItem, WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { ErrorReporter } from "../reporting/errorReporter";
import { promptConfirm, promptInput, promptPick } from "../ui/dialogs";

/** The commit actions as plain items for the IN-GRAPH popover (no vscode types
 * / codicon markup) — the webview renders these; ids match runCommitAction. */
export function commitMenuItems(): GraphMenuItem[] {
  return [
    { id: "checkout", label: "Checkout Commit", icon: "git-commit" },
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
 * render as ONE chip, and any ref past the fourth is folded into a "+N" pill, so
 * a chip-driven menu could never reach either. The name rides in the id, so this
 * needs no protocol change.
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
      // Ellipsis: both of these ask something before they act.
      items.push({
        id: `${REF_ACTION}remoteHead:${ref.name}`,
        label: `Checkout ${ref.name}…`,
        icon: "cloud",
      });
    } else {
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
    // origin/feature → local "feature" tracking origin/feature.
    const suggested = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
    const local = await promptInput({
      title: `Check out ${name}`,
      hint: `Creates a local branch tracking ${name}.`,
      value: suggested,
      confirmLabel: "Checkout",
      validate: "refName",
    });
    if (!local) {
      return false;
    }
    return withUndo(undo, `Checkout ${local}`, () =>
      runGit(ctx, ["checkout", "-b", local, name], `Checked out ${local} (tracking ${name})`),
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

async function checkout(
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
  return withUndo(undo, `Checkout ${short(commit.sha)}`, () =>
    runGit(ctx, ["checkout", commit.sha], "Checked out"),
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
    // Conflicts leave the cherry-pick in progress; tell the user how to proceed.
    const stderr = result.stderr.trim();
    if (/conflict/i.test(stderr) || /after resolving/i.test(stderr)) {
      void vscode.window.showWarningMessage(
        `Cherry-pick of ${short(commit.sha)} hit conflicts. Resolve them, ` +
          `then continue or abort the cherry-pick.`,
      );
    } else {
      showGitError("Cherry-pick failed", stderr);
    }
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
  const [first, second] = [await describe(parents[0]), await describe(parents[1])];

  const chosen = await promptPick({
    title: `Revert the merge ${short(commit.sha)}`,
    hint: "A merge has two sides, so git needs to know which one to keep.",
    choices: [
      {
        id: "1",
        label: "Keep the branch this was merged into",
        icon: "git-branch",
        detail: short(parents[0]),
        description: first || "The first parent — usually what you want.",
      },
      {
        id: "2",
        label: "Keep the branch that was merged in",
        icon: "git-merge",
        detail: short(parents[1]),
        description: second || "The second parent.",
      },
    ],
  });
  if (!chosen) {
    return null;
  }
  return chosen === "2" ? 2 : 1;
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
    if (/conflict/i.test(stderr) || /after resolving/i.test(stderr)) {
      void vscode.window.showWarningMessage(
        `Revert of ${short(commit.sha)} hit conflicts. Resolve them, then ` +
          `continue or abort the revert.`,
      );
    } else {
      showGitError("Revert failed", stderr);
    }
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
  showGitError(`git ${args[0]} failed`, result.stderr.trim());
  return true;
}

function showGitError(title: string, stderr: string): void {
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
