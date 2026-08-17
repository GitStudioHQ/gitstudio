import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GitRef, GitRefType } from "@gitstudio/host-bridge/git";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { pausedForUser, type OperationMarker } from "../git/pausedForUser";
import { planRemoteCheckout } from "@gitstudio/git-service/checkoutRemote";
import {
  promptConfirm,
  promptInput,
  promptPick,
  type DialogChoice,
} from "../ui/dialogs";

// Branch / remote / tag context-menu actions for the Branches view. Each runs a
// real git op via the GitContext provider methods, confirms destructive ops, and
// routes merge / rebase / delete through the universal Undo envelope.
//
// The tree nodes carry a `ref: GitRef`; commands receive that node. A few title
// actions (new branch, fetch, manage remotes) take no node.

/** The shape branchesView's RefNode exposes (just the ref). */
interface RefNodeLike {
  readonly ref: GitRef;
}

function refOf(arg: unknown): GitRef | undefined {
  if (arg && typeof arg === "object" && "ref" in arg) {
    return (arg as RefNodeLike).ref;
  }
  return undefined;
}

/**
 * The ref a command was invoked on (from a tree/graph node), or — when the
 * command is run from the Command Palette with no node — one the user picks from
 * a GitStudio dialog. This is what gives tag / remote-branch / set-upstream
 * commands a real home in the palette instead of silently no-op'ing without a
 * node.
 */
async function refOrPick(
  a: RepoEntry,
  arg: unknown,
  type: GitRefType,
  title: string,
  icon: string,
): Promise<GitRef | undefined> {
  const direct = refOf(arg);
  if (direct) {
    return direct;
  }
  let refs: GitRef[] = [];
  try {
    refs = await a.ctx.refs.listRefs();
  } catch {
    /* ignore — handled as "none" below */
  }
  const candidates = refs.filter((r) => r.type === type);
  if (candidates.length === 0) {
    const noun =
      type === "head"
        ? "branches"
        : type === "remote"
          ? "remote branches"
          : type === "tag"
            ? "tags"
            : "stashes";
    void vscode.window.showInformationMessage(
      `GitStudio: this repository has no ${noun} to choose from.`,
    );
    return undefined;
  }
  const id = await promptPick({
    title,
    choices: candidates.map((r) => ({
      id: r.name,
      label: r.name,
      icon,
      detail: r.sha.slice(0, 7),
    })),
  });
  return candidates.find((r) => r.name === id);
}

function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

// ── Local branch actions ─────────────────────────────────────────────────────

export async function checkoutBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const result = await a.ctx.branches.checkout(ref.name);
  report(result, `Checked out ${ref.name}`, refresh);
}

export async function mergeBranchIntoCurrent(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const ok = await promptConfirm({
    title: `Merge ${ref.name} into the current branch?`,
    message:
      "Its commits join your history. If the two sides touched the same lines you'll get conflicts to resolve, and Undo can take you back either way.",
    confirmLabel: "Merge",
  });
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Merge ${ref.name}`, async () => {
    const result = await a.ctx.branches.merge(ref.name);
    await reportMergeLike(
      a.ctx,
      result,
      `Merged ${ref.name}`,
      "Merge",
      "MERGE_HEAD",
      refresh,
    );
  });
}

export async function rebaseCurrentOnto(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const ok = await promptConfirm({
    title: `Rebase the current branch onto ${ref.name}?`,
    message: `Your local commits are rewritten on top of ${ref.name}, so they get new shas. If you have already pushed them, the next push needs a force. Undo can take you back.`,
    confirmLabel: "Rebase",
  });
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Rebase onto ${ref.name}`, async () => {
    const result = await a.ctx.branches.rebaseOnto(ref.name);
    await reportMergeLike(
      a.ctx,
      result,
      `Rebased onto ${ref.name}`,
      "Rebase",
      "REBASE_HEAD",
      refresh,
    );
  });
}

export async function renameBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const neu = await promptInput({
    title: `Rename branch ${ref.name}`,
    hint: "Only the local name changes — the commits and the remote branch stay where they are.",
    value: ref.name,
    confirmLabel: "Rename",
    validate: "refName",
  });
  if (!neu || neu === ref.name) {
    return;
  }
  const result = await a.ctx.branches.rename(ref.name, neu);
  if (!result.ok) {
    report(result, `Renamed to ${neu}`, refresh);
    return;
  }
  await reconcileUpstreamAfterRename(a, ref.name, neu, refresh);
  report(result, `Renamed to ${neu}`, refresh);
}

/**
 * A rename leaves a published branch tracking its OLD name on the remote.
 *
 * `git branch -m` deliberately keeps the tracking config, because the branch on
 * the server was not renamed — so `branch.<new>.merge` still says
 * `refs/heads/<old>`. Everything downstream then quietly refers to the old
 * branch: the push modal targets it, the ↑/↓ badges count against it, and a
 * push either lands on the old name or is refused outright depending on the
 * user's `push.default`. Renaming and then pushing "into the new branch" is the
 * obvious thing to want, and it silently did not happen.
 *
 * Git can't decide this for us — tracking a differently-named branch is legal
 * and sometimes deliberate — so ask, with the overwhelmingly common intent
 * first. Only fires when the upstream actually named the OLD branch; a branch
 * that was already tracking something else is left alone.
 */
async function reconcileUpstreamAfterRename(
  a: RepoEntry,
  oldName: string,
  newName: string,
  refresh: () => void,
): Promise<void> {
  let upstream: { remote: string; branch: string } | null = null;
  try {
    upstream = await a.ctx.branches.upstreamOf(newName);
  } catch {
    return; // never let this block the rename that already succeeded
  }
  if (!upstream || upstream.branch !== oldName) {
    return; // unpublished, or deliberately tracking some other branch
  }
  const { remote } = upstream;

  const choice = await promptPick({
    title: `Rename ${oldName} on ${remote} too?`,
    hint: `This branch still tracks ${remote}/${oldName} — renaming locally doesn't rename it on the remote.`,
    choices: [
      {
        id: "rename",
        label: `Rename on ${remote}`,
        icon: "cloud-upload",
        description: `Push ${newName}, track it, and delete ${remote}/${oldName}.`,
      },
      {
        id: "publish",
        label: `Publish ${newName}, keep ${oldName}`,
        icon: "repo-forked",
        description: `Push ${newName} and track it, but leave ${remote}/${oldName} in place.`,
      },
      {
        id: "keep",
        label: `Keep tracking ${remote}/${oldName}`,
        icon: "link",
        description: "Git's default. The new name stays local-only.",
      },
    ],
  });
  if (!choice || choice === "keep") {
    return;
  }

  const pushed = await a.ctx.sync.push({
    remote,
    branch: newName,
    setUpstream: true,
  });
  if (!pushed.ok) {
    void vscode.window.showErrorMessage(
      `GitStudio: renamed locally, but publishing ${newName} failed${
        pushed.stderr ? ` — ${pushed.stderr.trim()}` : ""
      }. It still tracks ${remote}/${oldName}.`,
    );
    return;
  }
  if (choice === "publish") {
    flash(`Published ${newName} to ${remote}`);
    refresh();
    return;
  }

  // "rename": the old remote branch has served its purpose. Deleting it is the
  // destructive half, so a failure here is reported but never undoes the push.
  const removed = await a.ctx.branches.deleteRemoteBranch(remote, oldName);
  if (!removed.ok) {
    void vscode.window.showWarningMessage(
      `GitStudio: ${newName} is published and tracked, but ${remote}/${oldName} could not be deleted${
        removed.stderr ? ` — ${removed.stderr.trim()}` : ""
      }.`,
    );
  } else {
    flash(`Renamed on ${remote}: ${oldName} → ${newName}`);
  }
  refresh();
}

export async function deleteBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const ok = await confirm(
    `Delete branch ${ref.name}?`,
    "The branch label is removed. Its commits stay reachable from anywhere else that points at them, and GitStudio's Undo can put the branch back.",
    "Delete",
  );
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Delete branch ${ref.name}`, async () => {
    let result = await a.ctx.branches.delete(ref.name);
    if (!result.ok && /not fully merged/i.test(result.stderr)) {
      const force = await confirm(
        `${ref.name} is not fully merged`,
        "Some of its commits are not on any other branch, so deleting it may leave them unreachable. Undo can still recover them.",
        "Force Delete",
      );
      if (!force) {
        return;
      }
      result = await a.ctx.branches.delete(ref.name, { force: true });
    }
    report(result, `Deleted ${ref.name}`, refresh);
  });
}

export async function pushBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  // If no upstream, offer to publish (set-upstream).
  const upstream = ref.upstream;
  if (!upstream) {
    const remotes = await a.ctx.remotes.list();
    const remote = await pickRemote(remotes, "Publish to which remote?");
    if (!remote) {
      return;
    }
    const result = await a.ctx.sync.push({
      remote,
      branch: ref.name,
      setUpstream: true,
    });
    report(result, `Published ${ref.name} to ${remote}`, refresh);
    return;
  }
  // Push the ref we were invoked ON, not whatever happens to be checked out.
  // A bare push() pushes the CURRENT branch, so invoking this on any other
  // branch pushed the wrong one and then reported the right one's name.
  const slash = upstream.indexOf("/");
  const remote = slash > 0 ? upstream.slice(0, slash) : undefined;
  const result = remote
    ? await a.ctx.sync.push({ remote, branch: ref.name })
    : await a.ctx.sync.push();
  report(result, `Pushed ${ref.name}`, refresh);
}

export async function setUpstream(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(
    a,
    arg,
    "head",
    "Set the upstream for which branch?",
    "git-branch",
  );
  if (!ref) {
    return;
  }
  let refs: GitRef[] = [];
  try {
    refs = await a.ctx.refs.listRefs();
  } catch {
    /* ignore */
  }
  const remoteBranches = refs.filter((r) => r.type === "remote");
  const upstream = await promptPick({
    title: `Set upstream for ${ref.name}`,
    hint: "The remote-tracking branch this branch pushes to and compares against.",
    choices: remoteBranches.map((r) => ({
      id: r.name,
      label: r.name,
      icon: "cloud",
      detail: r.sha.slice(0, 7),
    })),
  });
  if (!upstream) {
    return;
  }
  const result = await a.ctx.branches.setUpstream(ref.name, upstream);
  report(result, `Set upstream of ${ref.name} → ${upstream}`, refresh);
}

export async function newBranchFrom(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a) {
    return;
  }
  const startPoint = ref?.name;
  const name = await promptInput({
    title: startPoint ? `New branch from ${startPoint}` : "New branch",
    hint: startPoint
      ? `The branch starts at ${startPoint}.`
      : "The branch starts at HEAD.",
    placeholder: "feature/my-branch",
    confirmLabel: "Continue",
    validate: "refName",
  });
  if (!name) {
    return;
  }
  const checkout = await promptPick({
    title: `Create ${name}`,
    hint: "Switch to the new branch after creating it?",
    choices: [
      {
        id: "switch",
        label: "Create and Switch",
        icon: "git-branch",
        description: "Create the branch and check it out.",
      },
      {
        id: "only",
        label: "Create Only",
        icon: "add",
        description: `Create the branch and stay on the current one.`,
      },
    ],
  });
  if (checkout === undefined) {
    return;
  }
  const result = checkout === "switch"
    ? await a.ctx.branches.checkoutNew(name, startPoint)
    : await a.ctx.branches.create(name, startPoint);
  report(result, `Created ${name}`, refresh);
}

/** "Create worktree for this branch" — pick a folder, add a worktree on `ref`. */
export async function createWorktreeForBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  const ref = refOf(arg);
  if (!a || !ref) {
    return;
  }
  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Create Worktree Here",
    title: `Pick a parent folder for the ${ref.name} worktree`,
  });
  const parent = folders?.[0];
  if (!parent) {
    return;
  }
  const leaf = ref.name.split("/").pop() ?? ref.name;
  const target = vscode.Uri.joinPath(parent, leaf);
  const result = await a.ctx.worktrees.add(target.fsPath, ref.name);
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: worktree add failed.",
    );
    return;
  }
  refresh();
  const open = await vscode.window.showInformationMessage(
    `Created worktree for ${ref.name} at ${target.fsPath}`,
    "Open in New Window",
  );
  if (open === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", target, {
      forceNewWindow: true,
    });
  }
}

// ── Remote branch actions ────────────────────────────────────────────────────

export async function checkoutRemoteBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(
    a,
    arg,
    "remote",
    "Check out which remote branch?",
    "cloud",
  );
  if (!ref) {
    return;
  }
  // Straight to the branch — no name prompt. Renaming is a separate thing you
  // can do afterwards, and "New Branch From Here…" already covers landing on a
  // different name in one step.
  const plan = await planRemoteCheckout(a.ctx.process, ref.name);
  const result = await a.ctx.process.run(plan.args);
  report(
    { ok: result.code === 0, stderr: result.stderr },
    plan.success,
    refresh,
  );
}

export async function deleteRemoteBranch(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(
    a,
    arg,
    "remote",
    "Delete which remote branch?",
    "cloud",
  );
  if (!ref) {
    return;
  }
  // origin/feature → remote "origin", branch "feature".
  const slash = ref.name.indexOf("/");
  if (slash < 0) {
    return;
  }
  const remote = ref.name.slice(0, slash);
  const branch = ref.name.slice(slash + 1);
  const ok = await confirm(
    `Delete ${branch} on ${remote}?`,
    `This removes the branch from the remote for everyone, not just from your copy. Your local ${branch} (if you have one) is untouched.`,
    "Delete Remote Branch",
  );
  if (!ok) {
    return;
  }
  const result = await a.ctx.branches.deleteRemoteBranch(remote, branch);
  report(result, `Deleted ${remote}/${branch}`, refresh);
}

// ── Tag actions ──────────────────────────────────────────────────────────────

export async function checkoutTag(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(a, arg, "tag", "Select a tag to check out", "tag");
  if (!ref) {
    return;
  }
  const ok = await promptConfirm({
    title: `Check out tag ${ref.name}?`,
    message:
      "You'll be on a detached HEAD — commits made here belong to no branch until you create one.",
    confirmLabel: "Checkout",
  });
  if (!ok) {
    return;
  }
  const result = await a.ctx.branches.checkout(ref.name, { detach: true });
  report(result, `Checked out ${ref.name}`, refresh);
}

export async function deleteTag(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(a, arg, "tag", "Select a tag to delete", "tag");
  if (!ref) {
    return;
  }
  const ok = await confirm(
    `Delete tag ${ref.name}?`,
    "This deletes the tag locally. If it was already pushed, it stays on the remote until you delete it there too.",
    "Delete",
  );
  if (!ok) {
    return;
  }
  const result = await a.ctx.tags.delete(ref.name);
  report(result, `Deleted tag ${ref.name}`, refresh);
}

export async function pushTag(
  repos: RepoManager,
  arg: unknown,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const ref = await refOrPick(a, arg, "tag", "Select a tag to push", "tag");
  if (!ref) {
    return;
  }
  const remotes = await a.ctx.remotes.list();
  const remote = await pickRemote(remotes, `Push ${ref.name} to which remote?`);
  if (!remote) {
    return;
  }
  const result = await a.ctx.tags.push(remote, ref.name);
  report(result, `Pushed tag ${ref.name} to ${remote}`, refresh);
}

// ── Title actions ────────────────────────────────────────────────────────────

export async function fetchAll(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const result = await a.ctx.sync.fetch({ all: true, prune: true });
  report(result, "Fetched all remotes", refresh);
}

/** `gitstudio.addRemote` — add a new remote. */
export async function addRemote(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const name = await promptInput({
    title: "Add remote",
    hint: "The short name you'll refer to it by — origin, upstream, fork.",
    placeholder: "origin",
    confirmLabel: "Continue",
    validate: "remoteName",
  });
  if (!name) {
    return;
  }
  const url = await promptInput({
    title: `Add remote ${name}`,
    hint: "An https:// URL, an ssh URL, git@host:owner/repo.git, or a local path.",
    placeholder: "https://github.com/owner/repo.git",
    confirmLabel: "Add Remote",
    validate: "url",
  });
  if (!url) {
    return;
  }
  const result = await a.ctx.remotes.add(name.trim(), url.trim());
  report(result, `Added remote ${name}`, refresh);
}

/** `gitstudio.manageRemotes` — pick a remote, then an action. */
export async function manageRemotes(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const remotes = await a.ctx.remotes.list();
  if (remotes.length === 0) {
    const add = await promptConfirm({
      title: "No remotes configured",
      message:
        "This repository has no remotes, so there is nothing to fetch from or push to.",
      confirmLabel: "Add Remote…",
    });
    if (add) {
      await addRemote(repos, refresh);
    }
    return;
  }
  // A sentinel id no remote can collide with: git forbids ":" in a remote name.
  const ADD = "gitstudio:add-remote";
  const pickedRemote = await promptPick({
    title: "Manage remotes",
    choices: [
      ...remotes.map((r) => ({
        id: r.name,
        label: r.name,
        icon: "cloud",
        description: r.fetchUrl,
      })),
      { id: ADD, label: "Add remote…", icon: "add" },
    ],
  });
  if (!pickedRemote) {
    return;
  }
  if (pickedRemote === ADD) {
    await addRemote(repos, refresh);
    return;
  }
  const remote = remotes.find((r) => r.name === pickedRemote);
  if (!remote) {
    return;
  }

  const action = await promptPick({
    title: `Remote: ${remote.name}`,
    hint: remote.fetchUrl,
    choices: [
      { id: "fetch", label: "Fetch", icon: "sync", description: "Update this remote's branches." },
      { id: "prune", label: "Prune Stale Branches", icon: "trash", description: "Drop remote-tracking branches that no longer exist on the server." },
      { id: "url", label: "Edit URL", icon: "link", description: remote.fetchUrl },
      { id: "rename", label: "Rename", icon: "edit" },
      { id: "remove", label: "Remove", icon: "trash", danger: true },
    ],
  });
  if (!action) {
    return;
  }
  switch (action) {
    case "fetch":
      report(
        await a.ctx.remotes.fetch(remote.name, { prune: true }),
        `Fetched ${remote.name}`,
        refresh,
      );
      break;
    case "prune":
      report(
        await a.ctx.remotes.prune(remote.name),
        `Pruned ${remote.name}`,
        refresh,
      );
      break;
    case "url": {
      const url = await promptInput({
        title: `Edit URL of ${remote.name}`,
        hint: "Where this remote fetches from and pushes to.",
        value: remote.fetchUrl,
        confirmLabel: "Update URL",
        validate: "url",
      });
      if (!url) {
        return;
      }
      report(
        await a.ctx.remotes.setUrl(remote.name, url.trim()),
        `Updated ${remote.name} URL`,
        refresh,
      );
      break;
    }
    case "rename": {
      const neu = await promptInput({
        title: `Rename ${remote.name}`,
        hint: "Its remote-tracking branches are renamed to match.",
        value: remote.name,
        confirmLabel: "Rename",
        validate: "remoteName",
      });
      if (!neu || neu === remote.name) {
        return;
      }
      report(
        await a.ctx.remotes.rename(remote.name, neu.trim()),
        `Renamed remote to ${neu}`,
        refresh,
      );
      break;
    }
    case "remove": {
      const ok = await confirm(
        `Remove remote ${remote.name}?`,
        "Its remote-tracking branches go with it. Nothing on the server changes.",
        "Remove",
      );
      if (!ok) {
        return;
      }
      report(
        await a.ctx.remotes.remove(remote.name),
        `Removed remote ${remote.name}`,
        refresh,
      );
      break;
    }
    default:
      break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function pickRemote(
  remotes: { name: string; fetchUrl: string }[],
  title: string,
): Promise<string | undefined> {
  if (remotes.length === 0) {
    void vscode.window.showInformationMessage("GitStudio: no remotes configured.");
    return undefined;
  }
  if (remotes.length === 1) {
    return remotes[0].name;
  }
  const choices: DialogChoice[] = remotes.map((r) => ({
    id: r.name,
    label: r.name,
    icon: "cloud",
    description: r.fetchUrl,
  }));
  return promptPick({ title, choices });
}

async function withUndo(
  repos: RepoManager,
  repo: RepoEntry,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  const ledger = repos.getUndoLedger();
  if (ledger) {
    await ledger.runWithUndo(repo, label, fn);
  } else {
    await fn();
  }
}

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
      result.stderr.trim() || "GitStudio: git operation failed.",
    );
  }
}

/**
 * Like report, but an operation that merely PAUSED for a conflict is surfaced as
 * a softer warning with a next step, not as a failure.
 *
 * This used to ask git's stderr — `/conflict/i` — which is the same defect that
 * made a routine cherry-pick read as a crash on a Russian locale (fixed in
 * 1.5.2). It asks git directly now: exit code 1 AND the operation's marker ref.
 * `MERGE_HEAD` / `REBASE_HEAD` are spelled the same in every language.
 *
 * Both halves matter here even more than they do for cherry-pick, because for
 * these two operations exit 1 is genuinely ambiguous: `git merge nosuchref` and
 * a rebase refused over a dirty tree BOTH exit 1 without pausing. The marker is
 * what keeps those on the error path.
 */
async function reportMergeLike(
  ctx: GitContext,
  result: { ok: boolean; code: number; stderr: string },
  success: string,
  verb: string,
  marker: OperationMarker,
  refresh: () => void,
): Promise<void> {
  if (result.ok) {
    flash(success);
    refresh();
    return;
  }
  if (await pausedForUser(ctx.process, result.code, marker)) {
    void vscode.window.showWarningMessage(
      `${verb} hit conflicts. Resolve them, then continue or abort.`,
    );
    refresh();
    return;
  }
  const stderr = result.stderr.trim();
  void vscode.window.showErrorMessage(
    stderr ? `${verb} failed: ${stderr}` : `${verb} failed`,
  );
}

/**
 * A destructive-action confirmation, in GitStudio's own dialog rather than an OS
 * modal sheet. `title` is the question, `action` the button.
 */
async function confirm(
  title: string,
  message: string,
  action: string,
): Promise<boolean> {
  return promptConfirm({ title, message, confirmLabel: action, danger: true });
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}
