// Tri-state block staging — the git side of a tick beside each change in a diff.
//
// hunkStaging.ts answers "what can I still stage?" by diffing the INDEX against
// the working tree, which is the right question for a list of files you never
// open. A diff view asks a different one. It shows HEAD against the working
// tree — every change since the last commit — and the tick beside each change
// has to say whether that change is already staged, not merely whether it
// exists. Diffed against the index, a visible change is unstaged by definition,
// so a tick there could never be anything but empty.
//
// So this module reads three texts (HEAD, index, working), hands them to the
// engine, and writes back through the same stageContent primitive.

import {
  computeChangeBlocks,
  rangesToStage,
  rangesToUnstage,
  sameBlock,
  type ChangeBlock,
} from "@gitstudio/engine/staging/blockStaging";
import { computeHunks, applySelectedChanges } from "@gitstudio/engine/staging/applyLineChanges";
import type { StagingProvider } from "./StagingProvider";

export type { ChangeBlock, BlockState } from "@gitstudio/engine/staging/blockStaging";

/** The minimum this needs from a GitContext. */
export interface BlockStagingHost {
  staging: Pick<
    StagingProvider,
    "indexContent" | "headContent" | "stageContent" | "unstageFile"
  >;
}

/**
 * Above this, a file gets no ticks.
 *
 * The tick model diffs three texts on every paint. That is cheap for source
 * files and not cheap for a 200k-line generated bundle, and nobody stages a
 * minified artefact one change at a time. Matches the webview's own large-file
 * cutoff in spirit: degrade to no ticks rather than to a frozen editor.
 */
const MAX_STAGEABLE_LINES = 20_000;

/**
 * Whether per-change staging can be offered for this content at all.
 *
 * A NUL byte means git treats the file as binary, and a line-based diff of
 * binary content produces changes that are not meaningful to stage — the ticks
 * would be real controls over nonsense. Refusing is the honest answer, and the
 * whole-file staging path still works.
 */
export function isStageableText(text: string): boolean {
  if (text.includes("\u0000")) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > MAX_STAGEABLE_LINES) return false;
  }
  return true;
}

/** What the two sides of the tick model are computed from. */
interface Baselines {
  head: string;
  index: string;
}

/**
 * HEAD and index text for `rel`.
 *
 * A path with no index entry reads as "" — which is correct for a brand-new
 * file, where the whole thing is one unstaged block against an empty baseline.
 */
async function baselines(host: BlockStagingHost, rel: string): Promise<Baselines> {
  const [head, index] = await Promise.all([
    host.staging.headContent(rel),
    host.staging.indexContent(rel),
  ]);
  return { head, index };
}

/**
 * Every change in `rel` since HEAD, each labelled staged / unstaged / partial.
 *
 * `workingText` is supplied by the caller because each host already holds it —
 * the open document in the editor, the read file in the app. Re-reading it here
 * would risk labelling ticks against a different revision of the file than the
 * one on screen.
 */
export async function listChangeBlocks(
  host: BlockStagingHost,
  rel: string,
  workingText: string,
): Promise<ChangeBlock[]> {
  if (!isStageableText(workingText)) {
    return [];
  }
  const { head, index } = await baselines(host, rel);
  if (!isStageableText(head) || !isStageableText(index)) {
    return [];
  }
  return computeChangeBlocks(head, index, workingText);
}

/** What a refused write says, and why the caller should not treat it as failure. */
const GONE =
  "That change is no longer there — the file moved underneath. Refresh and try again.";

/** What a file that cannot be staged change-by-change says. */
const NOT_STAGEABLE =
  "This file can only be staged whole — it is binary or too large to stage change by change.";

export interface SetBlockResult {
  ok: boolean;
  /** True when the refusal is a user-state, not a bug — keeps it out of crash reports. */
  expected?: boolean;
  stderr: string;
}

/**
 * Stage or unstage exactly `block`, leaving every other change alone.
 *
 * Both directions re-derive the blocks from freshly read HEAD/index text and
 * refuse unless a block with the same content-derived ranges is still there.
 * That is what makes the tick safe to click against a file being edited in
 * another window: a block that merely shifted because something above it changed
 * still matches, and only one that genuinely no longer exists is refused.
 */
export async function setBlockStaged(
  host: BlockStagingHost,
  rel: string,
  workingText: string,
  block: ChangeBlock,
  staged: boolean,
): Promise<SetBlockResult> {
  if (!isStageableText(workingText)) {
    return { ok: false, expected: true, stderr: NOT_STAGEABLE };
  }
  const { head, index } = await baselines(host, rel);
  if (!isStageableText(head) || !isStageableText(index)) {
    return { ok: false, expected: true, stderr: NOT_STAGEABLE };
  }
  const current = computeChangeBlocks(head, index, workingText);
  const match = current.find((b) => sameBlock(b, block));
  if (!match) {
    return { ok: false, expected: true, stderr: GONE };
  }

  if (staged) {
    const ranges = rangesToStage(match, computeHunks(index, workingText));
    if (ranges.length === 0) {
      // Already fully staged — the tick and the index agree, so there is
      // nothing to do and nothing to report.
      return { ok: true, stderr: "" };
    }
    const content = applySelectedChanges(index, workingText, ranges);
    const r = await host.staging.stageContent(rel, content);
    return { ok: r.ok, stderr: r.stderr };
  }

  const ranges = rangesToUnstage(match, computeHunks(index, head));
  if (ranges.length === 0) {
    return { ok: true, stderr: "" };
  }
  const content = applySelectedChanges(index, head, ranges);

  // Rolling the last staged block of an ADDED file back to HEAD leaves ""
  // content — but writing an empty blob would leave a zero-length file staged
  // for addition rather than removing the entry, so the file would still be
  // committed, empty. Dropping the entry is what `git reset` does here.
  if (content === "" && head === "") {
    const r = await host.staging.unstageFile(rel);
    return { ok: r.ok, stderr: r.stderr };
  }

  const r = await host.staging.stageContent(rel, content);
  return { ok: r.ok, stderr: r.stderr };
}
