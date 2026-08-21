import * as vscode from "vscode";
import { describeStashScope, listForHint, type StashRequest } from "./stashScope";
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

/**
 * `gitstudio.stash.save` — confirm the files, then stash.
 *
 * This used to be two dialogs before anything happened: type a message, then
 * pick options. Three interactions to put work aside, and neither screen ever
 * showed WHICH files were about to move. Now that a stash can be narrowed to a
 * selection, the list IS the confirmation: one dialog, everything ticked, press
 * Stash. Untick a row and it stays in the working tree, so adjusting the scope
 * costs nothing extra.
 *
 * Nothing was removed. A message is one opt-in tick away, and `--keep-index`
 * appears only when there is an index for it to keep.
 */
export async function saveStash(
  repos: RepoManager,
  refresh: () => void,
  request?: StashRequest,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const requested = (request?.paths ?? []).filter((p) => p.length > 0);
  const stagedOnly = request?.stagedOnly === true;

  // What this stash would take, so the dialog can show it rather than describe
  // it. `stagedOnly` is its own git mode and cannot be narrowed per path, so it
  // is confirmed by count instead of by list.
  const status = await a.ctx.status.read();
  const inScope = stagedOnly
    ? status.staged
    : [...status.staged, ...status.unstaged].filter(
        (f) => requested.length === 0 || requested.includes(f.path),
      );

  if (inScope.length === 0) {
    void vscode.window.showInformationMessage(
      "GitStudio: nothing to stash — the working tree is clean.",
    );
    return;
  }

  // Ids are PREFIXED rather than sentinel-valued. A bare sentinel has to be a
  // string no path can equal, and every candidate for that is either a legal
  // path on some platform or a control character — and a NUL in an id travels
  // through JSON into a DOM attribute, which is its own quiet trap. A prefix
  // makes the collision structurally impossible instead of merely unlikely.
  const FILE = "f:";
  const OPT_MESSAGE = "o:message";
  const OPT_KEEP = "o:keep";
  // Untracked files are the ones people lose to a stash: plain `git stash`
  // leaves them behind. Listing them means the tick decides, so nobody has to
  // know that --include-untracked exists.
  const untracked = new Set(
    status.unstaged.filter((f) => f.status === "?" || f.status === "U").map((f) => f.path),
  );

  const fileChoices = stagedOnly
    ? []
    : inScope.map((f) => ({
        id: FILE + f.path,
        label: f.path,
        icon: untracked.has(f.path) ? "new-file" : "file",
        detail: untracked.has(f.path) ? "new" : undefined,
        picked: true,
      }));

  const extras = [
    ...(stagedOnly || status.staged.length === 0
      ? []
      : [
          {
            id: OPT_KEEP,
            label: "Keep staged changes staged",
            icon: "check",
            detail: "--keep-index",
            description: "The index survives, so a partly staged commit stays ready.",
          },
        ]),
    {
      id: OPT_MESSAGE,
      label: "Add a message\u2026",
      icon: "pencil",
      description: "Otherwise git labels it with the branch and its last commit.",
    },
  ];

  const picked = await promptPickMany({
    title: stagedOnly
      ? `Stash everything staged (${inScope.length} ${inScope.length === 1 ? "file" : "files"})`
      : `Stash ${inScope.length} ${inScope.length === 1 ? "file" : "files"}`,
    hint: stagedOnly
      // No tickable rows for this mode, so the files are named here instead.
      // `git stash push --staged` with a pathspec silently mangles files
      // OUTSIDE the pathspec and still exits 0, so StashProvider refuses the
      // combination — offering per-file ticks here would be offering a choice
      // that cannot be honoured.
      ? `${listForHint(inScope.map((f) => f.path))} — the index is stashed whole; `
        + "the working tree is left alone."
      : "Everything here is going. Untick anything you want to keep.",
    confirmLabel: "Stash",
    choices: [...fileChoices, ...extras],
  });
  if (picked === undefined) {
    return; // cancelled
  }

  const chosenPaths = picked
    .filter((id) => id.startsWith(FILE))
    .map((id) => id.slice(FILE.length));
  if (!stagedOnly && chosenPaths.length === 0) {
    void vscode.window.showInformationMessage(
      "GitStudio: nothing stashed — every file was unticked.",
    );
    return;
  }

  let message = "";
  if (picked.includes(OPT_MESSAGE)) {
    const typed = await promptInput({
      title: "Name this stash",
      hint: "A label to recognise it by later.",
      placeholder: "WIP: \u2026",
      confirmLabel: "Stash",
    });
    if (typed === undefined) {
      return; // cancelled
    }
    message = typed;
  }

  // Narrow only when the user actually narrowed it. Passing every path
  // explicitly would turn a whole-tree stash into a pathspec one, which behaves
  // differently for untracked files and for anything git considers unchanged.
  const narrowed =
    !stagedOnly && chosenPaths.length < inScope.length ? chosenPaths : requested;
  const scope = describeStashScope({ paths: narrowed, stagedOnly });

  const result = await a.ctx.stashes.save({
    message: message || undefined,
    // Derived from the list rather than asked as a separate question: if an
    // untracked file is ticked, the user means to stash it.
    includeUntracked: chosenPaths.some((p) => untracked.has(p)),
    keepIndex: picked.includes(OPT_KEEP),
    paths: narrowed,
    stagedOnly,
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
      `GitStudio: ${stashBlockerMessage(
        result.blocker ?? "cleanTree",
        stagedOnly ? "staged" : narrowed.length > 0 ? "selection" : "tree",
      )}`,
    );
    refresh();
    return;
  }
  flash(`Stashed ${scope}`);
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
