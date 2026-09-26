import * as vscode from "vscode";
import { describeStashScope, listForHint, type StashRequest } from "./stashScope";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import {
  isStashName,
  isStashSha,
  STASH_GONE_MESSAGE,
  stashBlockerMessage,
  stashBranchNameRefusal,
  type StashEntry,
} from "@gitstudio/git-service/StashProvider";
import { applyOrAsk, type Applied } from "../git/inTheWay";
import { promptConfirm, promptInput, promptPick, promptPickMany } from "../ui/dialogs";
import { stoppedByThisCommand, type DetectedOperation } from "../git/pausedForUser";
import { detectOperation, notifyPaused } from "../git/pauseNotice";

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
    // uri.path is "/<encoded ref>.diff", a name for the tab; the repo root and
    // the stash's full sha ride in the query. The content is read by SHA when
    // there is one: the ref is a position that later names another stash.
    const ref = decodeURIComponent(
      uri.path.replace(/^\//, "").replace(/\.diff$/, ""),
    );
    const query = new URLSearchParams(uri.query);
    const root = query.get("root") ?? "";
    const sha = query.get("sha") ?? "";
    const entry = this.repos.getAll().find((e) => e.root === root);
    if (!entry) {
      return "";
    }
    return entry.ctx.stashes.show(isStashSha(sha) ? sha : ref);
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

/**
 * Open a stash's diff in a read-only editor. `stash` is its full sha (a
 * `stash@{n}` is pinned to the sha it names now).
 *
 * `focus`: move the keyboard into the editor. A click in the list previews
 * without it, so the list keeps the keyboard — and a double-click's menu is
 * not left with its focus in the editor, out of reach of Escape.
 *
 * False when the stash has left the list (said to the user), for the caller
 * to redraw the list without it.
 */
export async function showStash(
  repos: RepoManager,
  stash: string,
  focus = false,
): Promise<boolean> {
  const a = repos.getActive();
  if (!a || !stash) {
    return true;
  }
  // Only looked at: nothing was going to change, so "so nothing was
  // changed" would answer a question nobody asked.
  const entry = await pinStash(a, stash, STASH_GONE_SHOWN);
  if (!entry) {
    return false;
  }
  const uri = stashDiffUri(a.root, entry.ref, entry.sha);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: !focus });
  return true;
}

/** A stash clicked to look at has left the list. */
const STASH_GONE_SHOWN = "That stash is no longer in the list.";

/**
 * The stash the user acted on, as the list holds it NOW — found by its sha,
 * because `stash@{n}` is a position that every push, pop and drop renumbers.
 * A `stash@{n}` handed in is pinned to the sha it names at this moment.
 * Undefined (and said, as `gone`) when it has left the list.
 */
async function pinStash(
  a: RepoEntry,
  stash: string,
  gone: string = STASH_GONE_MESSAGE,
): Promise<StashEntry | undefined> {
  const list = isStashName(stash) ? await a.ctx.stashes.list() : [];
  const entry = isStashSha(stash)
    ? list.find((e) => e.sha === stash)
    : list.find((e) => e.ref === stash);
  if (!entry) {
    void vscode.window.showInformationMessage(`GitStudio: ${gone}`);
  }
  return entry;
}

/** How a stash is named to the user: its message, which is what they see in
 *  the list — never its volatile `stash@{n}`. */
function stashLabel(entry: StashEntry): string {
  return entry.message || entry.ref;
}

/**
 * Stashes with an operation running on them. A second Pop or Drop on the same
 * stash while the first is still going — a double-click, the row's button and
 * then its menu — is ignored: both would look the stash up before either ran,
 * and the second would then act on whatever had moved into its place.
 */
const inFlight = new Set<string>();

async function once(entry: StashEntry, run: () => Promise<void>): Promise<void> {
  if (inFlight.has(entry.sha)) {
    return;
  }
  inFlight.add(entry.sha);
  try {
    await run();
  } finally {
    inFlight.delete(entry.sha);
  }
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
  // One row per FILE. A partly staged file (`MM`) is in both the staged and
  // the unstaged list; listed twice, unticking one of its rows still stashed
  // it (the other row's tick carried the path), and the title counted it
  // twice.
  const inScope = stagedOnly
    ? status.staged
    : [...new Map([...status.staged, ...status.unstaged].map((f) => [f.path, f] as const)).values()]
        .filter((f) => requested.length === 0 || requested.includes(f.path));

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

/**
 * Apply a stash without dropping it. `stash` is its full sha — every row
 * sends it — or a `stash@{n}`, pinned to the sha it names now.
 */
export async function applyStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !stash) {
    return;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return;
  }
  await once(entry, async () => {
    const before = await detectOperation(a.ctx);
    // Through the shared door: uncommitted work in the stash's way is said, with
    // Stash & Retry, instead of git's "would be overwritten by merge" in red.
    await reportStashApplied(a, before, await applyWithStaging(a, entry, false), "Applied stash", refresh);
  });
}

/** Apply then drop a stash (routed through Undo). `stash` as for applyStash. */
export async function popStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !stash) {
    return;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return;
  }
  await once(entry, async () => {
    const ledger = repos.getUndoLedger();
    const before = await detectOperation(a.ctx);
    const run = () => applyWithStaging(a, entry, true);
    const applied = ledger
      ? await ledger.runWithUndo(a, `Pop ${entry.ref}`, run)
      : await run();
    await reportStashApplied(a, before, applied, "Popped stash", refresh);
  });
}

/**
 * The stash through the shared door, by sha, with its staging.
 *
 * A stash that holds staged changes is applied with `--index`, so they come
 * back staged — a plain apply brought them back unstaged, and a pop then
 * dropped the only copy of a staged version that differed from the working
 * copy. Where git cannot stage them again (the user's own staged changes are
 * in the way, or the staged half no longer applies at HEAD) nothing has run,
 * and the user is asked before it runs without.
 */
async function applyWithStaging(a: RepoEntry, entry: StashEntry, pop: boolean): Promise<Applied> {
  const index = await a.ctx.stashes.holdsStaged(entry.sha);
  const first = await applyOrAsk(a.ctx, { kind: "stash", stash: entry.sha, pop, index });
  if (!first.staging) {
    return first;
  }
  if (!(await askWithoutStaging(entry, first.staging, pop))) {
    return { result: first.result, cancelled: true };
  }
  return applyOrAsk(a.ctx, { kind: "stash", stash: entry.sha, pop });
}

/** Run it with everything unstaged, or not at all? */
async function askWithoutStaging(entry: StashEntry, why: "busy" | "refused", pop: boolean): Promise<boolean> {
  const verb = pop ? "Pop" : "Apply";
  const choice = await promptPick({
    title: `${verb} the stash without its staging?`,
    hint:
      why === "busy"
        ? `“${stashLabel(entry)}” has staged changes, and git can only stage them again when nothing else is staged — your own staged changes are in the way. Nothing has changed yet.`
        : `“${stashLabel(entry)}” has staged changes that no longer apply to what HEAD has now. Nothing has changed yet.`,
    choices: [
      {
        id: "unstaged",
        label: `${verb} Unstaged`,
        icon: pop ? "git-stash-pop" : "git-stash-apply",
        description: pop
          ? "Its changes come back unstaged and the stash is dropped. Where a file's staged version differed from its working copy, the staged version is not kept."
          : "Its changes come back unstaged. The stash is kept, staging and all.",
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: "close",
        description: pop
          ? "Nothing runs. Apply keeps the stash, so its staged versions stay in it."
          : "Nothing runs.",
      },
    ],
  });
  return choice === "unstaged";
}

/**
 * reportStashOp for a stash applied through the shared door. `before` is what
 * git had stopped on before the apply ran: a failed apply that LEFT git stopped
 * on conflicts is a pause (the Conflicts dashboard), not a failure.
 */
async function reportStashApplied(
  a: RepoEntry,
  before: DetectedOperation,
  applied: Applied,
  success: string,
  refresh: () => void,
): Promise<void> {
  if (applied.cancelled) {
    return;
  }
  if (applied.settled) {
    refresh();
    return;
  }
  const ok = applied.result.code === 0;
  reportStashOp(
    { ok, stderr: applied.result.stderr },
    success,
    refresh,
    !ok && stoppedByThisCommand(before, await detectOperation(a.ctx)),
  );
}

/**
 * Confirm + drop a stash (routed through Undo). `stash` as for applyStash.
 *
 * The question names the stash by its message, and the drop finds it by sha
 * AFTER the answer: the question has no time limit, and a stash pushed
 * meanwhile (a pull's autostash, Stash & Retry, a terminal) renumbers the
 * list — dropping the old number then dropped somebody else's stash.
 */
export async function dropStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !stash) {
    return;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return;
  }
  await once(entry, async () => {
    const ok = await promptConfirm({
      title: `Drop “${stashLabel(entry)}”?`,
      message:
        "The stashed changes are discarded. GitStudio's Undo can bring the stash back.",
      confirmLabel: "Drop",
      danger: true,
    });
    if (!ok) {
      return;
    }
    const ledger = repos.getUndoLedger();
    const run = () => a.ctx.stashes.drop(entry.sha);
    // Refs only: a drop takes a stash off the stack and never touches the tree.
    const result = ledger
      ? await ledger.runWithUndo(a, `Drop ${entry.ref}`, run, { refsOnly: true })
      : await run();
    reportStashOp(result, "Dropped stash", refresh);
  });
}

/** Create a branch from a stash. `stash` as for applyStash. */
export async function branchFromStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !stash) {
    return;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return;
  }
  await once(entry, async () => {
    const name = await promptInput({
      title: `Create branch from “${stashLabel(entry)}”`,
      hint: "The stash is applied on the new branch and dropped once it applies cleanly.",
      placeholder: "feature/from-stash",
      confirmLabel: "Create Branch",
      validate: "refName",
    });
    if (!name) {
      return;
    }
    // A name git will not take — one a branch already has, say — is the
    // user's to change, said as that rather than as git's error.
    const refused = await stashBranchNameRefusal(a.ctx.process, name);
    if (refused) {
      void vscode.window.showWarningMessage(`GitStudio: ${refused}`);
      return;
    }
    // Through the shared door, by sha: the branch is made from the stash the
    // user picked, and git drops THAT one, wherever the list has moved it
    // while the name was typed. `git stash branch` switches first and applies
    // after, so uncommitted work where it writes is asked about before it
    // runs (Stash & Retry) — git's refusal left the user on the new branch
    // with the stash unapplied, and said so in red.
    const before = await detectOperation(a.ctx);
    const applied = await applyOrAsk(a.ctx, { kind: "stash", stash: entry.sha, branch: name });
    await reportStashApplied(a, before, applied, `Created branch ${name}`, refresh);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `paused`: the apply stopped on conflicts (decided from what git wrote, not
 * from its prose). That is not a failure — git kept the stash and left the
 * files for the user, and the Conflicts dashboard resolves them or cancels.
 */
function reportStashOp(
  result: { ok: boolean; stderr: string; gone?: true },
  success: string,
  refresh: () => void,
  paused = false,
): void {
  if (result.ok) {
    flash(success);
    refresh();
  } else if (result.gone) {
    // Left the list between the click and git running: the user's state,
    // said as that, and the list redrawn without it.
    void vscode.window.showInformationMessage(`GitStudio: ${STASH_GONE_MESSAGE}`);
    refresh();
  } else if (paused) {
    notifyPaused("The stash hit conflicts. Resolve them, or cancel to put the files back — the stash is kept.");
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
