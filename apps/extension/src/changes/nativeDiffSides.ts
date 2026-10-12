// Which diffs from the Changes list open on vscode.git's own URIs.
//
// Kept free of the vscode module so the rule can be pinned by plain tests.
//
// GitStudio reads a file's index and HEAD versions through its own
// `gitstudio-rev:` scheme, so a diff opens before vscode.git has even started.
// The cost, found in #87: VS Code's own selective staging only recognises its
// own `git:` URIs. In a diff whose index side is `gitstudio-rev:`, the
// right-click menu's "Stage Selected Ranges" silently returns (vscode.git
// looks for a `git:` original with ref "~" and finds none), and the per-change
// "+" stage button VS Code draws in the diff gutter is not offered at all
// (its menu is gated on that same URI). Those are the controls a user coming
// from VS Code reaches for — the reporter did, and got no effect.
//
// So when vscode.git already lists the change, the diff opens on vscode.git's
// URIs: the same texts, and VS Code's own staging works in it beside
// GitStudio's. Everything unusual — a merge, a rename, an added, deleted or
// untracked file, or a change vscode.git has not reported yet — keeps the
// gitstudio-rev diff, which already handles it.

import type { GroupKind } from "./changesView";

/** vscode.git's Status values this cares about (git.d.ts, API v1). */
const MODIFIED = 5;
const INDEX_MODIFIED = 0;

/** A side of a diff: vscode.git's URI of the file at `ref`, or the working file itself. */
export type NativeSide = { ref: string; original?: boolean } | "file";

/**
 * The two sides to open `kind`'s diff on with vscode.git's URIs, or undefined
 * to keep GitStudio's own. `ref` is vscode.git's: "~" is the index (HEAD while
 * nothing is staged), "" the index, "HEAD" the last commit; `original` asks for
 * the change's ORIGINAL path (a staged rename's old name).
 */
export function nativeDiffSides(
  kind: GroupKind,
  status: number | undefined,
): { left: NativeSide; right: NativeSide } | undefined {
  if (kind === "unstaged" && status === MODIFIED) {
    // Exactly what vscode.git's own "Open Changes" opens for a modified file.
    return { left: { ref: "~" }, right: "file" };
  }
  if (kind === "staged" && status === INDEX_MODIFIED) {
    return { left: { ref: "HEAD", original: true }, right: { ref: "" } };
  }
  return undefined;
}

/**
 * The file and ref a vscode.git `git:` URI names, or undefined when its query
 * is not one. vscode.git writes the query as JSON:
 * `{"path": <the file's fsPath>, "ref": "~" | "" | "HEAD" | <sha> …}`.
 *
 * GitStudio's history commands decode a diff side to find the file and the
 * revision on screen; they read only `gitstudio-rev:`, so once the Changes list
 * opened diffs on vscode.git's URIs, Open File at Revision and Previous/Next
 * Revision answered "Open a file in a Git repository first" there.
 */
export function fromGitUriQuery(query: string): { path: string; ref: string } | undefined {
  try {
    const parsed = JSON.parse(query) as { path?: unknown; ref?: unknown };
    if (typeof parsed?.path !== "string" || typeof parsed.ref !== "string") return undefined;
    return { path: parsed.path, ref: parsed.ref };
  } catch {
    return undefined;
  }
}

/**
 * vscode.git's ref as GitStudio's revision: "~" (the index, or HEAD while the
 * file has nothing staged — the same text) and "" are the index, which
 * GitStudio writes as ""; anything else ("HEAD", a sha) is itself.
 */
export function revOfGitRef(ref: string): string {
  return ref === "~" ? "" : ref;
}
