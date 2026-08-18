// Staging individual hunks of a file, without an editor open.
//
// Line staging already exists, but it is driven from the ACTIVE EDITOR: it reads
// the document you are looking at and the lines your cursors are on. That is the
// wrong shape for the Changes view, where the user is picking from a list of
// files and never opens one — which is exactly the gap the checkbox staging model
// left behind (issue #16/#20): file-level ticks only, so anyone using partial
// staging today would be losing something.
//
// This is the same engine (computeHunks / applySelectedChanges) driven from a
// path instead, so both products can offer a tick per hunk from the file list.
//
// The baseline is the INDEX, not HEAD — which is what makes the model honest: a
// hunk computed against the index is by definition NOT staged yet, so "the hunks
// you can still tick" and "what git would show as unstaged" are the same set. Tick
// one and it disappears, because the index now contains it.

import { computeHunks, applySelectedChanges } from "@gitstudio/engine/staging/applyLineChanges";
import type { StagingProvider } from "./StagingProvider";

/** One tickable change within a file. */
export interface FileHunk {
  /** Stable within a single listing — the index into the returned array. */
  index: number;
  /** 0-based line range in the WORKING-TREE version. */
  start: number;
  end: number;
  /** First changed line, trimmed — enough to recognise the hunk in a list. */
  preview: string;
  /** How many working-tree lines the hunk spans. */
  lineCount: number;
}

/** The minimum this needs from a GitContext. */
export interface HunkStagingHost {
  staging: Pick<StagingProvider, "indexContent" | "headContent" | "stageContent">;
}

/** The index version of a file, falling back to HEAD for a file not yet staged. */
async function baseline(host: HunkStagingHost, rel: string): Promise<string> {
  const indexed = await host.staging.indexContent(rel);
  return indexed !== "" ? indexed : host.staging.headContent(rel);
}

/**
 * The hunks of `rel` that are not yet staged, in file order.
 *
 * `modified` is the working-tree text, supplied by the caller because each host
 * already has it (an open document in the editor, a read file in the app) and
 * re-reading it here would risk showing hunks from a different revision of the
 * file than the one the user is looking at.
 */
export async function listUnstagedHunks(
  host: HunkStagingHost,
  rel: string,
  modified: string,
): Promise<FileHunk[]> {
  const original = await baseline(host, rel);
  const lines = modified.split("\n");
  return computeHunks(original, modified).map((h, index) => {
    const start = h.modified.start;
    const end = h.modified.end;
    const firstChanged = lines.slice(start, end + 1).find((l) => l.trim().length > 0);
    return {
      index,
      start,
      end,
      preview: (firstChanged ?? "").trim().slice(0, 120),
      // A pure deletion collapses to a zero-length range in the modified file;
      // report it as one line so the UI never shows "0 lines".
      lineCount: Math.max(1, end - start + 1),
    };
  });
}

/**
 * Stage the hunks at `indexes` (as returned by `listUnstagedHunks`) and leave the
 * rest unstaged.
 *
 * Reconstructs the file as "index version, plus exactly these changes" and writes
 * that blob into the index — the working tree is never touched, so an unticked
 * hunk stays exactly as the user left it.
 */
export async function stageHunks(
  host: HunkStagingHost,
  rel: string,
  modified: string,
  indexes: readonly number[],
): Promise<{ ok: boolean; staged: number; stderr: string }> {
  if (indexes.length === 0) {
    return { ok: true, staged: 0, stderr: "" };
  }
  const original = await baseline(host, rel);
  const hunks = computeHunks(original, modified);
  const wanted = new Set(indexes);
  const picked = hunks.filter((_, i) => wanted.has(i)).map((h) => h.modified);
  if (picked.length === 0) {
    // The file moved under us between listing and staging: the indexes no longer
    // name the same changes. Refusing beats staging the wrong lines.
    return { ok: false, staged: 0, stderr: "Those changes are no longer there — refresh and try again." };
  }
  const content = applySelectedChanges(original, modified, picked);
  const r = await host.staging.stageContent(rel, content);
  return { ok: r.ok, staged: picked.length, stderr: r.stderr };
}
