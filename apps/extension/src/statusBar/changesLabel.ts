/**
 * The Changes segment's tooltip: "GitStudio: 4 unstaged, 3 staged".
 *
 * Separate from statusCluster.ts, which imports `vscode` and so cannot be loaded
 * by node:test. Small, but it is the one part with a decision in it — which
 * halves to name, in which order, and what to do when one of them is zero.
 */
export function changesTooltip(staged: number, unstaged: number): string {
  const parts: string[] = [];
  // Unstaged first: it is the larger number in the common case, and it is the
  // one the user is about to act on.
  if (unstaged > 0) parts.push(`${unstaged} unstaged`);
  if (staged > 0) parts.push(`${staged} staged`);
  if (parts.length === 0) return "GitStudio: no local changes";
  return `GitStudio: ${parts.join(", ")}`;
}

/** The Changes segment's label. Staged is called out because it is committable. */
export function changesLabel(staged: number, unstaged: number): string {
  const total = staged + unstaged;
  if (total === 0) return "$(check) clean";
  return staged > 0 ? `$(diff) ${total} \u00b7 ${staged} staged` : `$(diff) ${total}`;
}
