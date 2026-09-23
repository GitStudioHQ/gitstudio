// What the merge editor writes into the conflicted file's TextDocument before
// Apply, and when it must not write at all. vscode-free, so it is unit-tested
// under plain node; mergeEditorProvider.ts owns the document itself.
//
// Three rules (POLISH A1.1–A1.3):
//
// 1. A conflict the Result has not settled stays MARKED in the document. The
//    Result pane holds such a conflict as base text, and VS Code's autosave
//    (or ⌘S, or Save on close) wrote the mirrored Result to disk: one accept
//    plus an autosave put base over every other conflict, with no markers, so
//    `git add` or a later Continue staged half a merge. The engine's
//    markUnsettled writes the open ones as diff3 markers instead.
// 2. A file that was already resolved when the editor opened — by hand, or by
//    git rerere, so no markers are left — is not overwritten before Apply.
//    The Result starts from that resolution (the view seeds it), and only an
//    Apply that changes it asks first.
// 3. An edit made outside the merge editor (a text tab on the same file, a
//    formatter, a checkout in the terminal) is not written over silently: the
//    editor asks, inline, and writes nothing until it is answered.

import {
  hasConflictMarkers,
  markUnsettled,
  prepareMerge,
  resolvedOutsideMerge,
  seedFromWorking,
  type KeptRegion,
  type MarkerLabels,
  type PreparedMerge,
} from "@gitstudio/engine/conflict/documentText";
import { normalizeEol } from "@gitstudio/engine/lineDiff";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";

/**
 * How the markers name the sides. The first section is git's stage 2 — Yours
 * in a merge, Theirs during a rebase — so a later read of the markers maps it
 * through the operation the way ConflictOps does.
 */
export function markerLabelsFor(payload: Pick<MergeInitPayload, "op">): MarkerLabels {
  const op = payload.op;
  if (!op) return { firstIsYours: true, first: "Yours", second: "Theirs" };
  const named = (word: string, name: string): string => (name ? `${word} (${name})` : word);
  const yours = named("Yours", op.yours.name);
  const theirs = named("Theirs", op.theirs.name);
  return op.yours.stage === 2
    ? { firstIsYours: true, first: yours, second: theirs }
    : { firstIsYours: false, first: theirs, second: yours };
}

/** Whether a shape is merged line by line (the others never post a Result). */
function textual(payload: MergeInitPayload): boolean {
  return !payload.shape || payload.shape === "text" || payload.shape === "added-both";
}

/** One merge editor's Result → document rules (1 and 2 above). */
export class ResultMirror {
  private payload?: MergeInitPayload;
  private prepared?: PreparedMerge;
  private written = false;
  private preserve = false;
  private settled = false;
  /** Regions settled outside the markers at open (seedFromWorking); null when the file could not be read. */
  private keep?: KeptRegion[] | null;

  /** A fresh `init` went to the view: new sides, nothing written for them yet. */
  init(payload: MergeInitPayload): void {
    this.payload = payload;
    this.prepared = undefined;
    this.keep = undefined;
    this.written = false;
    this.settled = false;
    // Rule 2: git's stages say the file is conflicted, yet no markers are left
    // in it and it is not simply base — someone resolved it already.
    this.preserve =
      textual(payload) && payload.source === "git-stages" && resolvedOutsideMerge(payload.result, payload.base);
  }

  /** The file was already resolved when the editor opened (rule 2). */
  get preserved(): boolean {
    return this.preserve;
  }

  /**
   * The text to put in the document for this Result, or undefined to leave the
   * document as it is: nothing is known yet, the file keeps a resolution made
   * outside (rule 2), the Result could not be mapped, or it says nothing the
   * file git left does not already say.
   */
  documentText(result: string): string | undefined {
    const payload = this.payload;
    if (!payload || this.preserve) return undefined;
    if (!textual(payload)) return undefined;
    // Applied and staged: the conflict is over in git's eyes, and the Result —
    // any block left open included, by the user's own "Apply with N
    // unresolved" — is the file. A resultChanged that lands after the Apply
    // (the shell's debounce) or an edit made after it must not put markers
    // back over what was staged.
    if (this.settled) return result;
    this.prepared ??= prepareMerge(payload);
    // Rule 2, in part: regions the file had already settled outside its
    // markers when the editor opened (a conflict resolved by hand in a text
    // editor, by rerere, or by git's own merge) stay as the file had them
    // until the Result settles them itself. A file that cannot be read
    // against the merge at all is not written.
    if (this.keep === undefined) {
      const seed = hasConflictMarkers(payload.result) ? seedFromWorking(this.prepared, payload.result) : undefined;
      this.keep = seed?.kind === "ask" ? null : seed?.kind === "markers" ? seed.keep : [];
    }
    if (this.keep === null) return undefined;
    const out = markUnsettled(this.prepared, result, markerLabelsFor(payload), this.keep);
    if (!out) return undefined;
    if (!this.written && out.changes === 0) return undefined;
    this.written = true;
    return out.text;
  }

  /**
   * An Apply is about to write `text` over a file that was already resolved
   * when the editor opened (rule 2 asks first). The Result starts FROM that
   * resolution (the view seeds it, POLISH A1.2), so an Apply that writes it
   * back unchanged replaces nothing and asks nothing.
   */
  appliedOverResolution(text?: string): boolean {
    if (!this.preserve) return false;
    const was = this.payload?.result;
    return text === undefined || was === undefined || normalizeEol(text) !== normalizeEol(was);
  }

  /**
   * An Apply wrote the Result and git staged it. Until the next `init`, the
   * document follows the Result as it is: the merge is no longer unfinished,
   * and a resolution the file had before was replaced with the user's yes.
   */
  applied(): void {
    this.settled = true;
    this.preserve = false;
  }
}

/**
 * Edits the merge editor did not make (rule 3). The provider reports every
 * text the document takes; anything it did not write itself, and that is not
 * a text it already knew, is foreign. Line endings are not an edit.
 */
export class ForeignEdits {
  private known = new Set<string>();
  private foreign = false;
  private kept = false;

  constructor(initial: string) {
    this.reset(initial);
  }

  /** A fresh init: whatever the document and the file hold now is the starting point. */
  reset(...texts: Array<string | undefined>): void {
    this.known.clear();
    for (const t of texts) if (t !== undefined) this.known.add(normalizeEol(t));
    this.foreign = false;
    this.kept = false;
  }

  /** The merge editor is about to write `text`. */
  expect(text: string): void {
    this.known.add(normalizeEol(text));
  }

  /** The document now holds `text`. */
  observe(text: string): void {
    if (!this.known.has(normalizeEol(text))) this.foreign = true;
  }

  /** Something else changed the file since the merge editor last wrote it. */
  get changed(): boolean {
    return this.foreign;
  }

  /** The user chose to keep the other edit: stop mirroring until they Apply. */
  get keeping(): boolean {
    return this.kept;
  }

  keep(): void {
    this.kept = true;
  }

  /** The user chose to replace the other edit with the merge. */
  replace(current: string): void {
    this.foreign = false;
    this.kept = false;
    this.known.add(normalizeEol(current));
  }
}

/** The file name as a sentence names it. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Re-exported for the provider's "is this file still conflicted text" checks. */
export { hasConflictMarkers };
