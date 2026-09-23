// The merge editor's init payload (host → webview), built ONE way for both
// extensions (PLAN §3.1, D1/D2).
//
// The contents come from `ConflictOps.readSides`, which has already mapped git's
// stages to ROLES through the operation (`byRole`): during a rebase or a stash
// re-apply, Yours is stage 3 — the user's own commit — and it is drawn on the
// LEFT. This module never looks at a stage number. It copies Yours into
// `ours` (left) and Theirs into `theirs` (right), and the pane titles from
// `op.yours.paneTitle` / `op.theirs.paneTitle`. The webview never swaps.
//
// Before this, both extensions read `git show :2:` into the left pane under a
// fixed "Current change" title, so during a rebase "Accept Yours" took the
// upstream branch — merge-studio#12, and the case that silently dropped the
// reporter's only commit on `rebase --continue`.
//
// vscode-free, so it is unit-tested against real git under plain node.

import { conflictTypeFor } from "@gitstudio/engine/conflict/conflictType";
import { parseConflictMarkers } from "@gitstudio/engine/conflict/markers";
import type { MergeSides, ReadSidesOptions } from "@gitstudio/git-service/ConflictOps";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import type { ConflictType, MergeInitPayload } from "@gitstudio/host-bridge/protocol";

/** The one read the payload is built from (ConflictOps in production, a fake in tests). */
export interface SidesReader {
  readSides(path: string, opts?: ReadSidesOptions): Promise<MergeSides>;
}

export interface PayloadInput {
  /** Absolute file path — the webview's language detection and title. */
  fileName: string;
  /** The live document text (still carrying markers until resolved). */
  workingText: string;
  /** Installed JetBrains IDE's display name, when one can take the merge. */
  jetbrainsName?: string;
  /** The product's autoApplyNonConflicting setting (default off). */
  autoApplyNonConflicting: boolean;
}

/** Labels used when there is no operation to name the sides. */
export const GENERIC_LABELS = { yours: "Yours", theirs: "Theirs" } as const;

/**
 * Builds the payload from the role-mapped sides. `op` is included when an
 * operation is stopped, or when the file really is unmerged (git stages were
 * read); a file opened with "Reopen With" that has nothing to resolve gets no
 * operation strip, no Continue and no "Cancel <operation>".
 */
export function buildMergePayload(sides: MergeSides, input: PayloadInput): MergeInitPayload {
  const op: OperationView | undefined =
    sides.op.kind !== "none" || sides.source === "git-stages" ? sides.op : undefined;
  const payload: MergeInitPayload = {
    fileName: input.fileName,
    conflictType: conflictTypeOf(sides),
    source: sides.source,
    hasBase: sides.hasBase,
    oursLabel: sides.op.yours.paneTitle || GENERIC_LABELS.yours,
    theirsLabel: sides.op.theirs.paneTitle || GENERIC_LABELS.theirs,
    base: sides.base,
    ours: sides.yours,
    theirs: sides.theirs,
    // The result starts from the working text (still carrying markers until
    // resolved); an empty working file starts from the base instead.
    result: input.workingText !== "" ? input.workingText : sides.base,
    autoApplyNonConflicting: input.autoApplyNonConflicting,
    shape: sides.shape,
  };
  if (op) {
    payload.op = op;
  }
  if (sides.missingRole) {
    payload.missingRole = sides.missingRole;
  }
  if (input.jetbrainsName) {
    payload.jetbrainsName = input.jetbrainsName;
  }
  return payload;
}

/**
 * The payload for a file in a git repository: ONE role-mapped read, then the
 * pure mapping above. `op` saves a re-read when the caller already has it.
 */
export async function readMergePayload(
  reader: SidesReader,
  rel: string,
  input: PayloadInput,
  opts: { op?: OperationView; signal?: AbortSignal } = {},
): Promise<MergeInitPayload> {
  const sides = await reader.readSides(rel, {
    workingText: input.workingText,
    op: opts.op,
    signal: opts.signal,
  });
  return buildMergePayload(sides, input);
}

/**
 * A file outside any repository (the walkthrough's sample merge, a file with
 * markers pasted in): the sides come from the markers alone, and there is no
 * operation — markers carry no roles, so they keep git's own left/right.
 */
export function markersOnlyPayload(input: PayloadInput): MergeInitPayload {
  const parsed = parseConflictMarkers(input.workingText);
  const source = parsed.hasConflicts ? "markers" : "none";
  const base = parsed.hasConflicts && parsed.isDiff3 ? parsed.base : "";
  return {
    fileName: input.fileName,
    conflictType: conflictTypeFor({ shape: "text", hasBase: parsed.isDiff3, source }),
    source,
    hasBase: parsed.hasConflicts && parsed.isDiff3,
    oursLabel: GENERIC_LABELS.yours,
    theirsLabel: GENERIC_LABELS.theirs,
    base,
    ours: parsed.hasConflicts ? parsed.ours : "",
    theirs: parsed.hasConflicts ? parsed.theirs : "",
    result: input.workingText !== "" ? input.workingText : base,
    autoApplyNonConflicting: input.autoApplyNonConflicting,
    shape: "text",
    ...(input.jetbrainsName ? { jetbrainsName: input.jetbrainsName } : {}),
  };
}

/**
 * The legacy conflict-type note, stated in ROLE terms: "deleted-by-us" means
 * Yours has no version of the file (whichever stage that is). The engine's
 * one mapping, which the desktop uses too — from the shape git's stages
 * decided, never from which texts happen to be empty (an emptied file is
 * not a deleted one).
 */
export function conflictTypeOf(sides: MergeSides): ConflictType {
  return conflictTypeFor(sides);
}
