// Selecting several commits in the graph and the Commits list (issue #32) —
// the state machine, with no DOM in sight, shared by <gitstudio-graph> and
// <gitstudio-commit-rail>.
//
// The conventions are the ones every list the user already knows follows
// (VS Code's lists, JetBrains' log, Finder), and the desktop's Changes rows
// (apps/desktop/src/renderer/selection.ts) follow them too:
//
//   click               select just that row; it becomes the anchor
//   Cmd/Ctrl+click      add or remove that row; it becomes the anchor
//   Shift+click         select everything from the anchor to that row
//   Cmd/Ctrl+Shift+click   add that range to what is selected
//   ↑/↓ (Home/End)      move to the next row, selecting just it
//   Shift+↑/↓ (Home/End)   extend the range from the anchor
//   right-click         inside the selection: keep it; outside: select just that row
//   Escape              several selected: keep only the focused row
//
// Three things are tracked apart, because they are different things: WHICH
// rows are selected, the ANCHOR a Shift-range grows from, and the FOCUSED row —
// the one the keyboard is on, which a Cmd-click can leave unselected.

/** One list's selection. Row identity is the commit sha. */
export interface Selection {
  readonly selected: ReadonlySet<string>;
  /** Where a Shift-range is measured from. */
  readonly anchor?: string;
  /** The row with the keyboard cursor; what Enter opens and Escape keeps. */
  readonly focus?: string;
}

export const NO_SELECTION: Selection = { selected: new Set() };

/** The modifier keys of a click or a keypress. */
export interface Mods {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Whether a row may be part of a selection of SEVERAL. The graph's
 * uncommitted-changes row may not: no action takes it with commits. It can
 * still be selected on its own.
 */
export type CanJoin = (sha: string) => boolean;

const anyRow: CanJoin = () => true;

/** Just this row, anchored and focused on it. */
export function only(sha: string): Selection {
  return { selected: new Set([sha]), anchor: sha, focus: sha };
}

/** Every row between two rows, inclusive, in list order; [] when either is absent. */
export function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Drop the rows that cannot share a selection, once it holds more than one. */
function joinable(rows: Iterable<string>, canJoin: CanJoin): Set<string> {
  const all = [...rows];
  return new Set(all.length > 1 ? all.filter(canJoin) : all);
}

/** A click on `sha` with these modifiers. */
export function clickSelect(
  s: Selection,
  order: readonly string[],
  sha: string,
  mods: Mods,
  canJoin: CanJoin = anyRow,
): Selection {
  const add = !!(mods.ctrlKey || mods.metaKey);
  // Shift without an anchor has nothing to extend FROM, so it is a plain click.
  if (mods.shiftKey && s.anchor !== undefined && order.includes(s.anchor)) {
    const range = rangeBetween(order, s.anchor, sha);
    const base = add ? [...s.selected] : [];
    const selected = joinable([...base, ...range], canJoin);
    return selected.size === 0 ? only(sha) : { selected, anchor: s.anchor, focus: sha };
  }
  if (add) {
    if (!canJoin(sha)) return only(sha);
    const next = new Set([...s.selected].filter(canJoin));
    if (next.has(sha)) next.delete(sha);
    else next.add(sha);
    return { selected: next, anchor: sha, focus: sha };
  }
  return only(sha);
}

/**
 * The keyboard moved the cursor to `to` (↑/↓/Home/End/PageUp/PageDown).
 * With Shift the range grows or shrinks from the anchor; without, just `to`.
 */
export function moveTo(
  s: Selection,
  order: readonly string[],
  to: string,
  extend: boolean,
  canJoin: CanJoin = anyRow,
): Selection {
  if (!extend) return only(to);
  const anchor = s.anchor !== undefined && order.includes(s.anchor) ? s.anchor : (s.focus ?? to);
  const selected = joinable(rangeBetween(order, anchor, to), canJoin);
  return selected.size === 0 ? only(to) : { selected, anchor, focus: to };
}

/**
 * A right-click on `sha`: inside a selection of several, the selection stays
 * (the menu is for all of it) and the cursor moves there; anywhere else it is
 * just that row — VS Code's and JetBrains' behaviour.
 */
export function contextSelect(s: Selection, sha: string): Selection {
  if (s.selected.has(sha) && s.selected.size > 1) {
    return { selected: s.selected, anchor: s.anchor, focus: sha };
  }
  return only(sha);
}

/** Escape: several selected → just the focused row. Otherwise unchanged. */
export function collapse(s: Selection): Selection {
  if (s.selected.size <= 1 || s.focus === undefined) return s;
  return only(s.focus);
}

/** Is more than one row selected? */
export function isMany(s: Selection): boolean {
  return s.selected.size > 1;
}

/** The selected rows in list order (newest first, as the list reads). */
export function inOrder(s: Selection, order: readonly string[]): string[] {
  if (s.selected.size === 0) return [];
  return order.filter((sha) => s.selected.has(sha));
}

/**
 * The rows changed (a refresh, a filter, a rewrite that gave commits new
 * shas): forget what is no longer there. A cursor that went goes to the first
 * selected row left, and an anchor that went to the cursor.
 */
export function reconcile(s: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  const selected = new Set([...s.selected].filter((sha) => present.has(sha)));
  const focus =
    s.focus !== undefined && present.has(s.focus) ? s.focus : order.find((sha) => selected.has(sha));
  const anchor = s.anchor !== undefined && present.has(s.anchor) ? s.anchor : focus;
  if (
    selected.size === s.selected.size &&
    focus === s.focus &&
    anchor === s.anchor
  ) {
    return s;
  }
  return { selected, anchor, focus };
}

/** Same rows selected (the cursor aside)? */
export function sameRows(a: Selection, b: Selection): boolean {
  if (a.selected.size !== b.selected.size) return false;
  for (const sha of a.selected) if (!b.selected.has(sha)) return false;
  return true;
}
