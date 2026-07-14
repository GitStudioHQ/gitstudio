import * as vscode from "vscode";
import type { GitRef, GitRefType } from "@gitstudio/host-bridge/git";
import type { RepoManager, RepoEntry } from "../git/repoManager";

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
 * a quick pick. This is what gives tag / remote-branch / set-upstream commands a
 * real home in the palette instead of silently no-op'ing without a node.
 */
async function refOrPick(
  a: RepoEntry,
  arg: unknown,
  type: GitRefType,
  placeHolder: string,
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
  const picked = await vscode.window.showQuickPick(
    candidates.map((r) => ({ label: `$(${icon}) ${r.name}`, ref: r })),
    { placeHolder },
  );
  return picked?.ref;
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
  const ok = await confirm(
    `Merge ${ref.name} into the current branch?`,
    "Merge",
  );
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Merge ${ref.name}`, async () => {
    const result = await a.ctx.branches.merge(ref.name);
    reportMergeLike(result, `Merged ${ref.name}`, "Merge", refresh);
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
  const ok = await confirm(
    `Rebase the current branch onto ${ref.name}? This rewrites your local ` +
      `commits on top of ${ref.name}.`,
    "Rebase",
  );
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Rebase onto ${ref.name}`, async () => {
    const result = await a.ctx.branches.rebaseOnto(ref.name);
    reportMergeLike(result, `Rebased onto ${ref.name}`, "Rebase", refresh);
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
  const neu = await vscode.window.showInputBox({
    title: `Rename branch ${ref.name}`,
    prompt: "New branch name",
    value: ref.name,
    validateInput: validateRefName,
  });
  if (!neu || neu === ref.name) {
    return;
  }
  const result = await a.ctx.branches.rename(ref.name, neu);
  report(result, `Renamed to ${neu}`, refresh);
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
  const ok = await confirm(`Delete branch ${ref.name}?`, "Delete");
  if (!ok) {
    return;
  }
  await withUndo(repos, a, `Delete branch ${ref.name}`, async () => {
    let result = await a.ctx.branches.delete(ref.name);
    if (!result.ok && /not fully merged/i.test(result.stderr)) {
      const force = await confirm(
        `${ref.name} is not fully merged. Force delete (its unmerged commits ` +
          `may become unreachable)?`,
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
  const result = await a.ctx.sync.push();
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
  const picked = await vscode.window.showQuickPick(
    remoteBranches.map((r) => ({ label: `$(cloud) ${r.name}`, ref: r })),
    {
      title: `Set upstream for ${ref.name}`,
      placeHolder: "Pick the remote-tracking branch",
    },
  );
  if (!picked) {
    return;
  }
  const result = await a.ctx.branches.setUpstream(ref.name, picked.ref.name);
  report(result, `Set upstream of ${ref.name} → ${picked.ref.name}`, refresh);
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
  const name = await vscode.window.showInputBox({
    title: startPoint ? `New branch from ${startPoint}` : "New branch",
    prompt: "New branch name",
    placeHolder: "feature/my-branch",
    validateInput: validateRefName,
  });
  if (!name) {
    return;
  }
  const checkout = await vscode.window.showQuickPick(
    [
      { label: "$(check) Create and switch", value: true },
      { label: "$(git-branch) Create only", value: false },
    ],
    { title: `Create ${name}`, placeHolder: "Switch to the new branch?" },
  );
  if (checkout === undefined) {
    return;
  }
  const result = checkout.value
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
  // origin/feature → local "feature" tracking origin/feature.
  const local = ref.name.includes("/")
    ? ref.name.slice(ref.name.indexOf("/") + 1)
    : ref.name;
  const name = await vscode.window.showInputBox({
    title: `Check out ${ref.name}`,
    prompt: "Local branch name (tracks the remote branch)",
    value: local,
    validateInput: validateRefName,
  });
  if (!name) {
    return;
  }
  const result = await a.ctx.branches.checkoutNew(name, ref.name);
  report(result, `Checked out ${name} (tracking ${ref.name})`, refresh);
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
    `Delete ${branch} on ${remote}? This removes the branch from the remote.`,
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
  const ok = await confirm(
    `Checkout tag ${ref.name}? This leaves a detached HEAD.`,
    "Checkout",
  );
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
  const ok = await confirm(`Delete tag ${ref.name}?`, "Delete");
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
  const name = await vscode.window.showInputBox({
    title: "Add remote",
    prompt: "Remote name",
    placeHolder: "origin",
    validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
  });
  if (!name) {
    return;
  }
  const url = await vscode.window.showInputBox({
    title: `Add remote ${name}`,
    prompt: "Remote URL",
    placeHolder: "https://github.com/owner/repo.git",
    validateInput: (v) => (v.trim() ? undefined : "URL cannot be empty"),
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
    const add = await vscode.window.showInformationMessage(
      "No remotes configured.",
      "Add Remote",
    );
    if (add === "Add Remote") {
      await addRemote(repos, refresh);
    }
    return;
  }
  const ADD = "$(add) Add remote…";
  const remote = await vscode.window.showQuickPick(
    [
      ...remotes.map((r) => ({
        label: `$(cloud) ${r.name}`,
        description: r.fetchUrl,
        name: r.name,
      })),
      { label: ADD, description: "", name: "" },
    ],
    { title: "Manage remotes", placeHolder: "Pick a remote" },
  );
  if (!remote) {
    return;
  }
  if (remote.label === ADD) {
    await addRemote(repos, refresh);
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(sync) Fetch", id: "fetch" },
      { label: "$(trash) Prune stale branches", id: "prune" },
      { label: "$(edit) Edit URL", id: "url" },
      { label: "$(symbol-string) Rename", id: "rename" },
      { label: "$(close) Remove", id: "remove" },
    ],
    { title: `Remote: ${remote.name}`, placeHolder: "Pick an action" },
  );
  if (!action) {
    return;
  }
  switch (action.id) {
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
      const url = await vscode.window.showInputBox({
        title: `Edit URL of ${remote.name}`,
        prompt: "New remote URL",
        validateInput: (v) => (v.trim() ? undefined : "URL cannot be empty"),
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
      const neu = await vscode.window.showInputBox({
        title: `Rename ${remote.name}`,
        prompt: "New remote name",
        value: remote.name,
        validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
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
      const ok = await confirm(`Remove remote ${remote.name}?`, "Remove");
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
  const picked = await vscode.window.showQuickPick(
    remotes.map((r) => ({ label: `$(cloud) ${r.name}`, description: r.fetchUrl, name: r.name })),
    { title, placeHolder: "Pick a remote" },
  );
  return picked?.name;
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

/** Like report, but a conflict in stderr is surfaced as a softer warning. */
function reportMergeLike(
  result: { ok: boolean; stderr: string },
  success: string,
  verb: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
    return;
  }
  const stderr = result.stderr.trim();
  if (/conflict/i.test(stderr) || /after resolving/i.test(stderr)) {
    void vscode.window.showWarningMessage(
      `${verb} hit conflicts. Resolve them, then continue or abort.`,
    );
    refresh();
  } else {
    void vscode.window.showErrorMessage(
      stderr ? `${verb} failed: ${stderr}` : `${verb} failed`,
    );
  }
}

async function confirm(message: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return choice === action;
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}

function validateRefName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Name cannot be empty";
  }
  if (
    /[ ~^:?*\[\\]/.test(name) ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  ) {
    return "Invalid character in ref name";
  }
  return undefined;
}
