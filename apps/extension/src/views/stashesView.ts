import * as vscode from "vscode";
import { describeStashScope, listForHint, type StashRequest } from "./stashScope";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import {
  isStashName,
  isStashSha,
  STASH_GONE_MESSAGE,
  stashBlockerMessage,
  stashBranchNameRefusal,
  stashTitle,
  type StashEntry,
  type StashFile,
} from "@gitstudio/git-service/StashProvider";
import { applyOrAsk, type Applied } from "../git/inTheWay";
import { promptConfirm, promptInput, promptPick, promptPickMany } from "../ui/dialogs";
import { stoppedByThisCommand, type DetectedOperation } from "../git/pausedForUser";
import { detectOperation, notifyPaused } from "../git/pauseNotice";
import { EMPTY_TREE, toRevisionUri } from "../history/revisionContentProvider";
import { relativeTime } from "../util/relativeTime";
import { failed, notice, NO_REPOSITORY } from "../ui/notify";
import * as l10n from "@vscode/l10n";

// The stash OPERATIONS — save, apply, pop, drop, create branch, copy or move
// some of a stash's files to Changes, open a file's diff — for the Stashes
// group of the Changes view (changes/commitView.ts), where the stashes are
// listed, file by file, and for the palette's stash commands. Plus the
// read-only content provider that renders a whole stash as one patch.

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
    void vscode.window.showInformationMessage(NO_REPOSITORY);
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
const STASH_GONE_SHOWN = l10n.t("That stash is no longer in the list.");

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
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", gone));
  }
  return entry;
}

/** How a stash is named to the user: its words as its row shows them (no
 *  "On main:"), never its volatile `stash@{n}`. */
function stashLabel(entry: StashEntry): string {
  return stashTitle(entry.message).text;
}

/**
 * Stashes with an operation running on them. A second Pop or Drop on the same
 * stash while the first is still going — a double-click, the row's button and
 * then its menu — is ignored: both would look the stash up before either ran,
 * and the second would then act on whatever had moved into its place.
 */
const inFlight = new Set<string>();

async function once(entry: StashEntry, run: () => Promise<StashOutcome>): Promise<StashOutcome> {
  if (inFlight.has(entry.sha)) {
    return { kind: "kept" };
  }
  inFlight.add(entry.sha);
  try {
    return await run();
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
      l10n.t("GitStudio: nothing to stash — the working tree is clean."),
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
            label: l10n.t("Keep staged changes staged"),
            icon: "check",
            detail: "--keep-index",
            description: l10n.t("The index survives, so a partly staged commit stays ready."),
          },
        ]),
    {
      id: OPT_MESSAGE,
      label: l10n.t("Add a message…"),
      icon: "pencil",
      description: l10n.t("Otherwise git labels it with the branch and its last commit."),
    },
  ];

  const picked = await promptPickMany({
    title: stagedOnly
      ? l10n.t("Stash everything staged ({0} {1})", inScope.length, inScope.length === 1 ? l10n.t("file") : l10n.t("files"))
      : l10n.t("Stash {0} {1}", inScope.length, inScope.length === 1 ? l10n.t("file") : l10n.t("files")),
    hint: stagedOnly
      // No tickable rows for this mode, so the files are named here instead.
      // `git stash push --staged` with a pathspec silently mangles files
      // OUTSIDE the pathspec and still exits 0, so StashProvider refuses the
      // combination — offering per-file ticks here would be offering a choice
      // that cannot be honoured.
      ? l10n.t("{0} — the index is stashed whole; the working tree is left alone.", listForHint(inScope.map((f) => f.path)))
      : l10n.t("Everything here is going. Untick anything you want to keep."),
    confirmLabel: l10n.t("Stash"),
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
      l10n.t("GitStudio: nothing stashed — every file was unticked."),
    );
    return;
  }

  let message = "";
  if (picked.includes(OPT_MESSAGE)) {
    const typed = await promptInput({
      title: l10n.t("Name this stash"),
      hint: l10n.t("A label to recognise it by later."),
      placeholder: l10n.t("WIP: …"),
      confirmLabel: l10n.t("Stash"),
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
    // Git can refuse without a word: with a stale .git/index.lock in place,
    // `git stash push` exits 1 having printed nothing at all, and "Stash
    // failed." on its own leaves nobody anything to look at.
    void vscode.window.showErrorMessage(
      failed(l10n.t("Stash"), result.stderr.trim() || l10n.t("git refused")),
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
      l10n.t("GitStudio: {0}", stashBlockerMessage(
        result.blocker ?? "cleanTree",
        stagedOnly ? "staged" : narrowed.length > 0 ? "selection" : "tree",
      )),
    );
    refresh();
    return;
  }
  flash(l10n.t("Stashed {0}", scope));
  refresh();
}

/**
 * What became of an action on a stash — for the Changes view, which moved
 * the row at the click (optimistic-not-reload) and now settles it: keeps it
 * gone, or puts it back.
 */
export type StashOutcome =
  /**
   * It ran. After Move to Changes of some of a stash's files, what is left of
   * the stash is `rest` — a new sha where the stash was in the list.
   */
  | { kind: "done"; rest?: string }
  /** Nothing changed: cancelled, refused, or it failed (and that was said). */
  | { kind: "kept" }
  /** The stash had left the list, so nothing ran (said). */
  | { kind: "gone" }
  /** It stopped on conflicts for the user to resolve; the stash is kept (said). */
  | { kind: "paused" };

const KEPT: StashOutcome = { kind: "kept" };
const GONE: StashOutcome = { kind: "gone" };

/** Hooks a caller that drew the row can hang its patches on. */
export interface StashActionHooks {
  /**
   * The user answered the question (Drop's confirm, Create Branch's name) and
   * git is about to run: the row can leave now, before git has answered.
   */
  onConfirmed?: () => void;
}

/**
 * Apply a stash without dropping it. `stash` is its full sha — every row
 * sends it — or a `stash@{n}`, pinned to the sha it names now.
 */
export async function applyStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  return once(entry, async () => {
    const before = await detectOperation(a.ctx);
    // Through the shared door: uncommitted work in the stash's way is said, with
    // Stash & Retry, instead of git's "would be overwritten by merge" in red.
    return settleApplied(a, before, await applyWithStaging(a, entry, false), l10n.t("Apply stash"), l10n.t("Applied stash"), refresh);
  });
}

/** Apply then drop a stash (routed through Undo). `stash` as for applyStash. */
export async function popStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  return once(entry, async () => {
    const ledger = repos.getUndoLedger();
    const before = await detectOperation(a.ctx);
    const run = () => applyWithStaging(a, entry, true);
    // Named by its message: "Pop stash@{0}" named whichever stash was on top
    // by the time the toast or Undo History was read.
    const applied = ledger
      ? await ledger.runWithUndo(a, l10n.t("Pop “{0}”", stashLabel(entry)), run)
      : await run();
    return settleApplied(a, before, applied, l10n.t("Pop stash"), l10n.t("Popped stash"), refresh);
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
  const files = (await a.ctx.stashes.files(entry.sha)) ?? [];
  if (!sameWithoutIndex(files) && !(await askWithoutStaging(entry, first.staging, pop, losesStaged(files), readdsNew(files)))) {
    return { result: first.result, cancelled: true };
  }
  if (!files.some((f) => f.onlyStaged)) {
    return applyOrAsk(a.ctx, { kind: "stash", stash: entry.sha, pop });
  }
  // A file it holds only staged has no working copy of its own to bring
  // back (see subset's `unstaged`): the whole stash goes as a part whose
  // working copy of that file is its staged version, and a pop drops the
  // stash once that applied — as git's pop keeps it after a conflict.
  const whole = await a.ctx.stashes.subset(entry.sha, files.map((f) => f.path), { unstaged: true });
  if (!whole.ok) {
    void vscode.window.showErrorMessage(l10n.t("GitStudio: {0}", whole.stderr));
    return { result: first.result, settled: true };
  }
  const applied = await applyOrAsk(a.ctx, { kind: "stash", stash: whole.sha, cutFrom: entry.sha });
  if (pop && applied.result.code === 0 && !applied.cancelled && !applied.settled && !applied.staging) {
    const dropped = await a.ctx.stashes.drop(entry.sha);
    if (!dropped.ok) {
      void vscode.window.showWarningMessage(
        l10n.t("GitStudio: its changes are back, but “{0}” couldn't be dropped — {1}", stashLabel(entry), dropped.stderr.trim() || "git refused"),
      );
    }
  }
  return applied;
}

/**
 * Would running without `--index` lose anything? Only a file staged and then
 * changed again: its working copy comes back, its staged version does not.
 * (A file staged whole has the two the same; one held only staged comes
 * back from its staged version.)
 */
function losesStaged(files: readonly StashFile[]): boolean {
  return files.some((f) => f.staged === "part" && !f.onlyStaged);
}

/**
 * What it holds that git adds back staged even without `--index`: a file it
 * added, and a rename's new name (a -u stash's untracked files stay
 * untracked) — named, so "unstaged" says where it is not. Null: nothing.
 */
function readdsNew(files: readonly StashFile[]): string | null {
  const added = files.some((f) => f.status === "A" && !!f.staged);
  const renamed = files.some((f) => f.status === "R" && !!f.staged);
  return added && renamed ? l10n.t("a new or renamed file") : added ? l10n.t("a new file") : renamed ? l10n.t("a renamed file") : null;
}

/** "…unstaged", and the exception git makes, where there is one. */
function unstagedWords(readds: string | null): string {
  return readds ? l10n.t("unstaged, but for {0}, which git adds back staged,", readds) : "unstaged";
}

/**
 * Would the question change anything? Where every change it had staged is a
 * new file staged as it is, git adds those back staged without `--index` as
 * well: the plain apply IS the apply with its staging, so nothing is asked.
 */
function sameWithoutIndex(files: readonly StashFile[]): boolean {
  const staged = files.filter((f) => f.staged);
  return staged.length > 0 && staged.every((f) => f.status === "A" && f.staged === "all" && !f.onlyStaged);
}

/**
 * Some of a stash's files, through the same door: `part` is the stash-shaped
 * commit cut from `entry` holding only them (StashProvider.subset), applied
 * by its sha while `entry` is still in the list — with their staging, Stash
 * & Retry over the user's own edits to them, and the question when git
 * cannot stage them again. Never a pop: what leaves the stash is decided
 * after, by the caller.
 */
async function applyPartWithStaging(
  a: RepoEntry,
  entry: StashEntry,
  part: string,
  move: boolean,
  picked: readonly StashFile[],
): Promise<Applied> {
  const index = await a.ctx.stashes.holdsStaged(part);
  const first = await applyOrAsk(a.ctx, { kind: "stash", stash: part, cutFrom: entry.sha, index });
  if (!first.staging) {
    return first;
  }
  if (!sameWithoutIndex(picked) && !(await askPartWithoutStaging(entry, first.staging, move, picked))) {
    return { result: first.result, cancelled: true };
  }
  // A picked file the stash holds only staged comes back from its staged
  // version (subset's `unstaged`), or nothing of it would.
  let plain = part;
  if (picked.some((f) => f.onlyStaged)) {
    const cut = await a.ctx.stashes.subset(entry.sha, picked.map((f) => f.path), { unstaged: true });
    if (!cut.ok) {
      void vscode.window.showErrorMessage(l10n.t("GitStudio: {0}", cut.stderr));
      return { result: first.result, settled: true };
    }
    plain = cut.sha;
  }
  return applyOrAsk(a.ctx, { kind: "stash", stash: plain, cutFrom: entry.sha });
}

/** Run it with everything unstaged, or not at all? */
async function askWithoutStaging(
  entry: StashEntry,
  why: "busy" | "refused",
  pop: boolean,
  lossy: boolean,
  readds: string | null,
): Promise<boolean> {
  const verb = pop ? l10n.t("Pop") : l10n.t("Apply");
  const choice = await promptPick({
    title: l10n.t("{0} the stash without its staging?", verb),
    hint:
      why === "busy"
        ? l10n.t("“{0}” has staged changes, and git can only stage them again when nothing else is staged — your own staged changes are in the way. Nothing has changed yet.", stashLabel(entry))
        : l10n.t("“{0}” has staged changes that no longer apply to what HEAD has now. Nothing has changed yet.", stashLabel(entry)),
    choices: [
      {
        id: "unstaged",
        label: l10n.t("{0} Unstaged", verb),
        icon: pop ? "git-stash-pop" : "git-stash-apply",
        description: pop
          ? l10n.t("Its changes come back {0} and the stash is dropped.{1}", unstagedWords(readds), lossy ? ` ${LOST_STAGED}` : "")
          : l10n.t("Its changes come back {0}. The stash is kept, staging and all.", unstagedWords(readds).replace(/,$/, "")),
      },
      {
        id: "cancel",
        label: l10n.t("Cancel"),
        icon: "close",
        description: pop
          ? l10n.t("Nothing runs. Apply keeps the stash, so its staged versions stay in it.")
          : l10n.t("Nothing runs."),
      },
    ],
  });
  return choice === "unstaged";
}

/** What a Pop or a Move without staging loses, said only where it loses it (losesStaged). */
const LOST_STAGED = l10n.t("Where a file was staged and then changed again, its staged version is not kept.");

/** The same question for files taken out of a stash, in the words for one file or several. */
async function askPartWithoutStaging(
  entry: StashEntry,
  why: "busy" | "refused",
  move: boolean,
  picked: readonly StashFile[],
): Promise<boolean> {
  const verb = move ? l10n.t("Move") : l10n.t("Copy");
  const one = picked.length === 1;
  const back = unstagedWords(readdsNew(picked));
  const them = one ? `“${picked[0].path.split("/").pop()}”` : l10n.t("These {0} files", picked.length);
  const was = one ? "was" : "were";
  const choice = await promptPick({
    title: one ? l10n.t("{0} the file without its staging?", verb) : l10n.t("{0} the files without their staging?", verb),
    hint:
      why === "busy"
        ? l10n.t("{0} {1} staged in “{2}”, and git can only stage {3} again when nothing else is staged — your own staged changes are in the way. Nothing has changed yet.", them, was, stashLabel(entry), one ? l10n.t("it") : l10n.t("them"))
        : l10n.t("{0} {1} staged in “{2}”, and {3} to what HEAD has now. Nothing has changed yet.", them, was, stashLabel(entry), one ? l10n.t("its staged version no longer applies") : l10n.t("their staged versions no longer apply")),
    choices: [
      {
        id: "unstaged",
        label: l10n.t("{0} Unstaged", verb),
        icon: move ? "git-stash-pop" : "git-stash-apply",
        description: move
          ? `${one ? l10n.t("Its changes come") : l10n.t("Their changes come")} back ${back} and leave the stash.${
              !losesStaged(picked) ? "" : one ? l10n.t(" It was staged and then changed again, so its staged version is not kept.") : ` ${LOST_STAGED}`
            }`
          : l10n.t("{0} back {1}. The stash keeps {2}, staging and all.", one ? l10n.t("Its changes come") : l10n.t("Their changes come"), back.replace(/,$/, ""), one ? l10n.t("it") : l10n.t("them")),
      },
      {
        id: "cancel",
        label: l10n.t("Cancel"),
        icon: "close",
        description: l10n.t("Nothing runs. {0} in the stash, staging and all.", one ? l10n.t("It stays") : l10n.t("They stay")),
      },
    ],
  });
  return choice === "unstaged";
}

/**
 * Say how a stash applied through the shared door went, and what became of
 * it. `before` is what git had stopped on before the apply ran: a failed
 * apply that LEFT git stopped on conflicts is a pause (the Conflicts
 * dashboard), not a failure.
 */
async function settleApplied(
  a: RepoEntry,
  before: DetectedOperation,
  applied: Applied,
  action: string,
  success: string | undefined,
  refresh: () => void,
): Promise<StashOutcome> {
  if (applied.cancelled) {
    return KEPT;
  }
  if (applied.settled) {
    refresh();
    return applied.gone ? GONE : KEPT;
  }
  const ok = applied.result.code === 0;
  const paused = !ok && stoppedByThisCommand(before, await detectOperation(a.ctx));
  if (success !== undefined || !ok) {
    reportStashOp({ ok, stderr: applied.result.stderr }, action, success ?? "", refresh, paused);
  }
  return ok ? { kind: "done" } : paused ? { kind: "paused" } : KEPT;
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
  hooks?: StashActionHooks,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  return once(entry, async () => {
    const files = (await a.ctx.stashes.files(entry.sha))?.length;
    const ok = await promptConfirm({
      title: l10n.t("Drop “{0}”?", stashLabel(entry)),
      message:
        (files === undefined ? l10n.t("The stash leaves") : l10n.t("Its {0} {1}", countFiles(files), files === 1 ? l10n.t("leaves") : l10n.t("leave"))) +
        l10n.t(" the stash list. Undo (Ctrl/Cmd+Alt+G Z) puts it back."),
      confirmLabel: l10n.t("Drop"),
      danger: true,
    });
    if (!ok) {
      return KEPT;
    }
    hooks?.onConfirmed?.();
    const ledger = repos.getUndoLedger();
    const run = () => a.ctx.stashes.drop(entry.sha);
    // Refs only: a drop takes a stash off the stack and never touches the tree.
    const result = ledger
      ? await ledger.runWithUndo(a, l10n.t("Drop “{0}”", stashLabel(entry)), run, { refsOnly: true })
      : await run();
    reportStashOp(result, l10n.t("Drop stash"), l10n.t("Dropped stash"), refresh);
    return result.ok ? { kind: "done" } : result.gone ? GONE : KEPT;
  });
}

/** Create a branch from a stash. `stash` as for applyStash. */
export async function branchFromStash(
  repos: RepoManager,
  stash: string,
  refresh: () => void,
  hooks?: StashActionHooks,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  return once(entry, async () => {
    const name = await promptInput({
      title: l10n.t("Create branch from “{0}”", stashLabel(entry)),
      hint: l10n.t("The stash is applied on the new branch and dropped once it applies cleanly."),
      placeholder: "feature/from-stash",
      confirmLabel: l10n.t("Create Branch"),
      validate: "refName",
    });
    if (!name) {
      return KEPT;
    }
    // A name git will not take — one a branch already has, say — is the
    // user's to change, said as that rather than as git's error.
    const refused = await stashBranchNameRefusal(a.ctx.process, name);
    if (refused) {
      void vscode.window.showWarningMessage(l10n.t("GitStudio: {0}", refused));
      return KEPT;
    }
    hooks?.onConfirmed?.();
    // Through the shared door, by sha: the branch is made from the stash the
    // user picked, and git drops THAT one, wherever the list has moved it
    // while the name was typed. `git stash branch` switches first and applies
    // after, so uncommitted work where it writes is asked about before it
    // runs (Stash & Retry) — git's refusal left the user on the new branch
    // with the stash unapplied, and said so in red.
    const before = await detectOperation(a.ctx);
    const applied = await applyOrAsk(a.ctx, { kind: "stash", stash: entry.sha, branch: name });
    return settleApplied(a, before, applied, l10n.t("Create branch from stash"), l10n.t("Created branch {0}", name), refresh);
  });
}

// ── Some of a stash's files ──────────────────────────────────────────────────

/**
 * The files of `entry` named by `paths`, with the other half of a rename:
 * the Changes view shows a rename as one row under its new name, and taking
 * only one of its names would bring the file back as a copy.
 */
function pickedFiles(files: readonly StashFile[], paths: readonly string[]): StashFile[] {
  const wanted = new Set(paths);
  return files.filter((f) => wanted.has(f.path) || (f.oldPath !== undefined && wanted.has(f.oldPath)));
}

/** "1 file", "3 files". */
function countFiles(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/**
 * Copy to Changes: some of a stash's files come back into the working tree
 * (and the index, where they were staged) as they were stashed; the stash
 * keeps them. Through the shared door, so an edit of the user's to one of
 * them is asked about (Stash & Retry), never overwritten.
 */
export async function copyStashFiles(
  repos: RepoManager,
  stash: string,
  paths: readonly string[],
  refresh: () => void,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  return once(entry, async () => {
    const files = await a.ctx.stashes.files(entry.sha);
    const picked = files ? pickedFiles(files, paths) : [];
    if (picked.length === 0) {
      void vscode.window.showInformationMessage(l10n.t("GitStudio: those files are no longer in the stash."));
      refresh();
      return KEPT;
    }
    const part = await a.ctx.stashes.subset(entry.sha, picked.map((f) => f.path));
    if (!part.ok) {
      void vscode.window.showErrorMessage(l10n.t("GitStudio: {0}", part.stderr));
      return KEPT;
    }
    const before = await detectOperation(a.ctx);
    const applied = await applyPartWithStaging(a, entry, part.sha, false, picked);
    return settleApplied(a, before, applied, l10n.t("Copy to Changes"), l10n.t("Copied {0} to Changes", countFiles(picked.length)), refresh);
  });
}

/**
 * Move to Changes: some of a stash's files come back as they were stashed and
 * LEAVE the stash — what is left of it takes its place in the list, under its
 * message (StashProvider.replace). Moving every file is a Pop. Nothing leaves
 * the stash unless the files came back: a refusal, a cancel or a conflict
 * keeps the stash whole. Undo brings the whole stash back and takes the
 * files out of the working tree again.
 */
export async function moveStashFiles(
  repos: RepoManager,
  stash: string,
  paths: readonly string[],
  refresh: () => void,
): Promise<StashOutcome> {
  const a = active(repos);
  if (!a || !stash) {
    return KEPT;
  }
  const entry = await pinStash(a, stash);
  if (!entry) {
    refresh();
    return GONE;
  }
  const files = await a.ctx.stashes.files(entry.sha);
  const picked = files ? pickedFiles(files, paths) : [];
  if (!files || picked.length === 0) {
    void vscode.window.showInformationMessage(l10n.t("GitStudio: those files are no longer in the stash."));
    refresh();
    return KEPT;
  }
  if (picked.length === files.length) {
    // Every file it holds: that is popping the stash.
    return popStash(repos, entry.sha, refresh);
  }
  return once(entry, async () => {
    const moving = new Set(picked);
    const [part, rest] = await Promise.all([
      a.ctx.stashes.subset(entry.sha, picked.map((f) => f.path)),
      a.ctx.stashes.subset(entry.sha, files.filter((f) => !moving.has(f)).map((f) => f.path)),
    ]);
    if (!part.ok || !rest.ok) {
      void vscode.window.showErrorMessage(l10n.t("GitStudio: {0}", !part.ok ? part.stderr : !rest.ok ? rest.stderr : ""));
      return KEPT;
    }
    const label = l10n.t("Move {0} out of “{1}”", countFiles(picked.length), stashLabel(entry));
    const run = async (): Promise<Applied & { outcome: StashOutcome }> => {
      const before = await detectOperation(a.ctx);
      const applied = await applyPartWithStaging(a, entry, part.sha, true, picked);
      const outcome = await settleApplied(a, before, applied, l10n.t("Move to Changes"), undefined, refresh);
      if (outcome.kind !== "done") {
        return { ...applied, outcome };
      }
      // The files are in Changes: now they leave the stash.
      const replaced = await a.ctx.stashes.replace(entry.sha, rest.sha);
      if (!replaced.ok) {
        void vscode.window.showWarningMessage(
          notice(
            replaced.gone
              ? l10n.t("the files are in Changes, but “{0}” had left the stash list meanwhile, so nothing more was changed.", stashLabel(entry))
              : l10n.t("the files are in Changes, but the stash couldn't be updated — {0}", replaced.stderr.trim()),
          ),
        );
        return { ...applied, outcome: { kind: "done" } };
      }
      return { ...applied, outcome: { kind: "done", rest: rest.sha } };
    };
    const ledger = repos.getUndoLedger();
    const out = ledger ? await ledger.runWithUndo(a, label, run) : await run();
    if (out.outcome.kind === "done") {
      flash(l10n.t("Moved {0} to Changes", countFiles(picked.length)));
      refresh();
    }
    return out.outcome;
  });
}

// ── Looking at a stash's files ───────────────────────────────────────────────

/**
 * Open one file of a stash in a diff: what the stash holds against the
 * commit it was made on. `staged`: the version the stash had staged instead
 * (base ↔ its index). Every side is read by the stash's full sha, so an open
 * diff never turns into another stash's when the list renumbers. A binary
 * file has no text to compare, and says so. False when the stash has left
 * the list (said).
 */
export async function openStashFile(
  repos: RepoManager,
  stash: string,
  path: string,
  staged = false,
): Promise<boolean> {
  const a = repos.getActive();
  if (!a || !stash || !path) {
    return true;
  }
  const entry = await pinStash(a, stash, STASH_GONE_SHOWN);
  if (!entry) {
    return false;
  }
  const file = (await a.ctx.stashes.files(entry.sha))?.find((f) => f.path === path);
  if (!file) {
    void vscode.window.showInformationMessage(l10n.t("GitStudio: “{0}” is no longer in that stash.", path));
    return false;
  }
  const name = path.split("/").pop() ?? path;
  if (file.binary) {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: “{0}” is a binary file, so there is no text to compare. Copy it to Changes to open it.", name),
    );
    return true;
  }
  const { left, right, title } = stashFileSides(entry, file, staged || file.onlyStaged === true);
  await vscode.commands.executeCommand(
    "vscode.diff",
    toRevisionUri(a.root, left.rev, path, left.path),
    toRevisionUri(a.root, right.rev, path, right.path),
    `${name} (${title})`,
    { preview: true, preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
  );
  return true;
}

/** The two sides of a stash file's diff, by sha, and the words for its tab. */
export function stashFileSides(
  entry: { sha: string; message: string },
  file: StashFile,
  staged: boolean,
): { left: { rev: string; path: string }; right: { rev: string; path: string }; title: string } {
  const { sha } = entry;
  const before =
    file.status === "A" || file.status === "U"
      ? { rev: EMPTY_TREE, path: file.path }
      : { rev: `${sha}^1`, path: file.oldPath ?? file.path };
  const holder = file.status === "U" ? `${sha}^3` : staged ? `${sha}^2` : sha;
  // Deleted in the working copy: nothing on the right. (A staged version is
  // read from the stash's index, where a file it does not hold reads empty.)
  const after =
    !staged && file.status === "D" ? { rev: EMPTY_TREE, path: file.path } : { rev: holder, path: file.path };
  const words = stashTitle(entry.message).text;
  return { left: before, right: after, title: l10n.t("before ↔ {0} “{1}”", staged ? l10n.t("staged in") : l10n.t("stashed in"), words) };
}

/**
 * The palette's way to a stash: "Which stash?", asked in the Changes view
 * (never a quick pick). The sha, or undefined when there are none or the user
 * backed out.
 */
export async function pickStash(repos: RepoManager, verb: string): Promise<string | undefined> {
  const a = active(repos);
  if (!a) {
    return undefined;
  }
  const list = await a.ctx.stashes.list();
  if (list.length === 0) {
    void vscode.window.showInformationMessage(l10n.t("GitStudio: there are no stashes."));
    return undefined;
  }
  const counts = await Promise.all(list.map((e) => a.ctx.stashes.files(e.sha)));
  const choice = await promptPick({
    title: l10n.t("{0} which stash?", verb),
    choices: list.map((e, i) => {
      const t = stashTitle(e.message);
      const n = counts[i]?.length;
      return {
        id: e.sha,
        label: t.text,
        icon: "git-stash",
        detail: [t.branch, relativeTime(e.time)].filter(Boolean).join(" · "),
        ...(n === undefined ? {} : { description: countFiles(n) }),
      };
    }),
  });
  return choice || undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `paused`: the apply stopped on conflicts (decided from what git wrote, not
 * from its prose). That is not a failure — git kept the stash and left the
 * files for the user, and the Conflicts dashboard resolves them or cancels.
 */
function reportStashOp(
  result: { ok: boolean; stderr: string; gone?: true },
  action: string,
  success: string,
  refresh: () => void,
  paused = false,
): void {
  if (result.ok) {
    if (success) {
      flash(success);
    }
    refresh();
  } else if (result.gone) {
    // Left the list between the click and git running: the user's state,
    // said as that, and the list redrawn without it.
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", STASH_GONE_MESSAGE));
    refresh();
  } else if (paused) {
    notifyPaused(l10n.t("The stash hit conflicts. Resolve them, or cancel to put the files back — the stash is kept."));
    refresh();
  } else {
    void vscode.window.showErrorMessage(failed(action, result.stderr));
    refresh();
  }
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(l10n.t("$(check) {0}", message), 2500);
}
