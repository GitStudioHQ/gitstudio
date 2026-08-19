/**
 * The maths behind multi-selecting file rows, with no DOM in sight.
 *
 * Rows are keyed "kind:path" rather than by path. In the split staging model a
 * partly staged file appears TWICE — once under Staged, once under Changes — and
 * those two rows mean different things: staging one is a no-op, stashing the
 * other is not. Keying by path alone would select both from a single click and
 * then act on whichever came first.
 */

/** A row's stable identity within one repaint. */
export type RowKey = string;

export const rowKey = (kind: string, path: string): RowKey => `${kind}:${path}`;

export interface RowRef {
  kind: string;
  path: string;
}

/** Split a key back into its parts. Paths may contain ":", the kind may not. */
export function parseRowKey(key: RowKey): RowRef {
  const cut = key.indexOf(":");
  return { kind: key.slice(0, cut), path: key.slice(cut + 1) };
}

/** Selected rows in screen order — the order the user sees, not insertion order. */
export function selectionEntries(
  order: readonly RowKey[],
  selected: ReadonlySet<RowKey>,
): RowRef[] {
  return order.filter((k) => selected.has(k)).map(parseRowKey);
}

/**
 * Distinct paths in the selection — what git actually needs.
 *
 * Deduplicated because the same file can be selected through two rows, and
 * passing a path twice to `git stash push` is at best noise.
 */
export function selectionPaths(
  order: readonly RowKey[],
  selected: ReadonlySet<RowKey>,
): string[] {
  const seen: string[] = [];
  for (const { path } of selectionEntries(order, selected)) {
    if (!seen.includes(path)) seen.push(path);
  }
  return seen;
}

/** Every key between two rows inclusive, in screen order. */
export function rangeBetween(
  order: readonly RowKey[],
  anchor: RowKey,
  target: RowKey,
): RowKey[] {
  const a = order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a === -1 || b === -1) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** What a click with these modifiers should do. */
export type ClickIntent = "range" | "toggle" | "replace";

export function clickIntent(
  ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  hasAnchor: boolean,
): ClickIntent {
  // Shift without an anchor has nothing to extend FROM, so it degrades to a
  // plain click rather than doing nothing at all.
  if (ev.shiftKey && hasAnchor) return "range";
  if (ev.ctrlKey || ev.metaKey) return "toggle";
  return "replace";
}

/**
 * Drop keys that no longer exist after a repaint.
 *
 * A file that was selected and has since been staged, committed or reverted is
 * gone from the list; a selection still counting it would offer to stash files
 * that are not there.
 */
export function reconcile(
  order: readonly RowKey[],
  selected: ReadonlySet<RowKey>,
): Set<RowKey> {
  return new Set([...selected].filter((k) => order.includes(k)));
}
