import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { stashBlockerMessage } from "@gitstudio/git-service/StashProvider";
import { promptConfirm, promptInput, promptPickMany } from "../ui/dialogs";

// The Stashes pillar — genuinely absent from free VS Code, so GitStudio makes it
// first-class. The list + row actions live in a branded webview
// (StashesWebviewViewProvider); this module owns the stash OPERATIONS
// (save / apply / pop / drop / branch / show) those actions invoke, plus the
// read-only content provider that renders a stash's diff.

const STASH_DIFF_SCHEME = "gitstudio-stash";

/**
 * Read-only content provider for stash diffs, so `showStash` opens the patch in
 * a regular (diff-highlighted) read-only editor. The uri encodes the repo root +
 * stash ref; content is resolved lazily via the StashProvider.
 */
export class StashDiffContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  static readonly scheme = STASH_DIFF_SCHEME;

  constructor(private readonly repos: RepoManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // uri.path is "/<encoded ref>.diff"; the repo root (+ a cache-busting sha)
    // ride in the query.
    const ref = decodeURIComponent(
      uri.path.replace(/^\//, "").replace(/\.diff$/, ""),
    );
    const root = new URLSearchParams(uri.query).get("root") ?? "";
    const entry = this.repos.getAll().find((e) => e.root === root);
    if (!entry) {
      return "";
    }
    return entry.ctx.stashes.show(ref);
  }

  dispose(): void {
    // no-op
  }
}

/** Build the read-only uri a stash diff renders from. Keyed on the stash sha
 * too: a stash mutation reindexes stash@{n}, so without the sha an already-open
 * diff would be served stale from VS Code's per-uri content cache. */
export function stashDiffUri(
  root: string,
  ref: string,
  sha?: string,
): vscode.Uri {
  const query = new URLSearchParams({ root });
  if (sha) {
    query.set("sha", sha);
  }
  return vscode.Uri.from({
    scheme: STASH_DIFF_SCHEME,
    path: `/${encodeURIComponent(ref)}.diff`,
    query: query.toString(),
  });
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Resolve the active repo, or surface a hint. */
function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

/** Open a stash's diff in a read-only editor. */
export async function showStash(
  repos: RepoManager,
  ref: string,
  sha?: string,
): Promise<void> {
  const a = repos.getActive();
  if (!a || !ref) {
    return;
  }
  const uri = stashDiffUri(a.root, ref, sha);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** `gitstudio.stash.save` — name the stash, choose options, then stash. */
export async function saveStash(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const message = await promptInput({
    title: "Stash changes",
    hint: "A label to recognise this stash by later. Optional — press Enter to skip.",
    placeholder: "WIP: …",
    confirmLabel: "Continue",
    // No validator: a stash message is free text, and an empty one is fine.
  });
  if (message === undefined) {
    return; // cancelled
  }

  const options = await promptPickMany({
    title: "Stash options",
    hint: "Neither is required — plain `git stash` is the common case.",
    confirmLabel: "Stash",
    choices: [
      {
        id: "untracked",
        label: "Include untracked files",
        icon: "file",
        detail: "--include-untracked",
        description: "Brand-new files are stashed too, instead of being left behind.",
      },
      {
        id: "keep",
        label: "Keep staged changes staged",
        icon: "check",
        detail: "--keep-index",
        description: "The index survives the stash, so a partially staged commit stays ready.",
      },
    ],
  });
  if (options === undefined) {
    return; // cancelled
  }

  const result = await a.ctx.stashes.save({
    message: message || undefined,
    includeUntracked: options.includes("untracked"),
    keepIndex: options.includes("keep"),
  });
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: stash failed.",
    );
    return;
  }
  // A zero exit is not proof anything was stashed: `git stash push` with nothing
  // to save exits 0 and says so on stdout. Flashing "Stashed changes" there told
  // people their work was safely put away while it sat untouched in the working
  // tree — and the untracked-only case is the one that bites, because they DO
  // have changes, just not ones git was asked to take.
  if (!result.created) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${stashBlockerMessage(result.blocker ?? "cleanTree")}`,
    );
    refresh();
    return;
  }
  flash("Stashed changes");
  refresh();
}

/** Apply a stash without dropping it. */
export async function applyStash(
  repos: RepoManager,
  ref: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !ref) {
    return;
  }
  const result = await a.ctx.stashes.apply(ref);
  reportStashOp(result, "Applied stash", refresh);
}

/** Apply then drop a stash (routed through Undo). */
export async function popStash(
  repos: RepoManager,
  ref: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !ref) {
    return;
  }
  const ledger = repos.getUndoLedger();
  const run = () => a.ctx.stashes.pop(ref);
  const result = ledger
    ? await ledger.runWithUndo(a, `Pop ${ref}`, run)
    : await run();
  reportStashOp(result, "Popped stash", refresh);
}

/** Confirm + drop a stash (routed through Undo). */
export async function dropStash(
  repos: RepoManager,
  ref: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !ref) {
    return;
  }
  const ok = await promptConfirm({
    title: `Drop ${ref}?`,
    message:
      "The stashed changes are discarded. GitStudio's Undo can bring the stash back.",
    confirmLabel: "Drop",
    danger: true,
  });
  if (!ok) {
    return;
  }
  const ledger = repos.getUndoLedger();
  const run = () => a.ctx.stashes.drop(ref);
  const result = ledger
    ? await ledger.runWithUndo(a, `Drop ${ref}`, run)
    : await run();
  reportStashOp(result, "Dropped stash", refresh);
}

/** Create a branch from a stash. */
export async function branchFromStash(
  repos: RepoManager,
  ref: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !ref) {
    return;
  }
  const name = await promptInput({
    title: `Create branch from ${ref}`,
    hint: "The stash is applied on the new branch and dropped once it applies cleanly.",
    placeholder: "feature/from-stash",
    confirmLabel: "Create Branch",
    validate: "refName",
  });
  if (!name) {
    return;
  }
  const result = await a.ctx.stashes.branch(ref, name);
  reportStashOp(result, `Created branch ${name}`, refresh);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function reportStashOp(
  result: { ok: boolean; stderr: string },
  success: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
  } else {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: stash operation failed.",
    );
  }
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}
