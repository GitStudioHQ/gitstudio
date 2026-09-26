// Which commits a graph message is about (issue #32).
//
// The wire protocol kept its single-commit messages — `contextMenu` and
// `commitMenuAction` carry one `sha` exactly as before — and gained an
// optional `shas` for a selection of several. A host reads every such message
// through `menuTarget`, so "one" and "several" are decided in ONE place and a
// selection the webview sent with junk in it (a stale row, the uncommitted-
// changes node, anything that is not a sha) cannot turn into a several-commit
// action. Pure; no git.

/**
 * An object name: hex, 4 to 64 characters — a full sha-1 or sha-256, or an
 * abbreviation git resolves. Never a ref name, never an option: nothing that
 * is not hex can join, so nothing that joins can be read as `--all`.
 */
const SHA = /^[0-9a-f]{4,64}$/i;
/** The graph's synthetic "uncommitted changes" row. */
const ZERO_SHA = /^0+$/;

/** A commit's sha — nothing else may join a several-commit action. */
export function isCommitSha(s: unknown): s is string {
  return typeof s === "string" && SHA.test(s) && !ZERO_SHA.test(s);
}

/** One commit (the classic messages), or several. */
export type MenuTarget = { kind: "one"; sha: string } | { kind: "many"; shas: string[] };

/**
 * What a `contextMenu` / `commitMenuAction` (or a desktop GraphAction of the
 * same shape) is about: SEVERAL commits when `shas` names two or more real,
 * distinct ones — in the order sent, newest first — otherwise the one `sha`,
 * as before `shas` existed.
 */
export function menuTarget(msg: { sha: string; shas?: readonly unknown[] }): MenuTarget {
  const shas = [...new Set((Array.isArray(msg.shas) ? msg.shas : []).filter(isCommitSha))];
  return shas.length >= 2 ? { kind: "many", shas } : { kind: "one", sha: msg.sha };
}

/** A `selectCommits` payload, cleaned the same way: real, distinct shas, in order. */
export function selectedCommits(shas: readonly unknown[] | undefined): string[] {
  return [...new Set((Array.isArray(shas) ? shas : []).filter(isCommitSha))];
}
