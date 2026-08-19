/**
 * What a stash was asked to cover, and how to say it.
 *
 * Separate from stashesView.ts, which imports `vscode` and so cannot be loaded
 * by node:test. The string matters more than its size suggests: the stash button
 * never said what it would take, because there was only ever one answer —
 * everything. Now that a stash can be narrowed, this is what tells the user
 * which files are about to move BEFORE they commit to it.
 */
export interface StashRequest {
  /** Repo-relative paths. Empty or absent means the whole working tree. */
  paths?: readonly string[];
  /** Stash only the index. Mutually exclusive with `paths` — git mangles both. */
  stagedOnly?: boolean;
}

/** "3 selected files", "everything staged", "all changes" — completes "Stash …". */
export function describeStashScope(request?: StashRequest): string {
  // Checked first: the combination is refused downstream, so the description
  // must not imply the paths were honoured.
  if (request?.stagedOnly) return "everything staged";
  const count = request?.paths?.filter((p) => p.length > 0).length ?? 0;
  if (count === 1) return "1 selected file";
  if (count > 1) return `${count} selected files`;
  return "all changes";
}

/** Up to three names, then "and N more" — enough to recognise, short enough to read. */
export function listForHint(paths: readonly string[]): string {
  const names = paths.map((p) => p.split("/").pop() ?? p);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}
