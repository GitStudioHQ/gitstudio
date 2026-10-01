import * as l10n from "@vscode/l10n";
// Editing an interactive-rebase plan as a LIST (issue #32: "when doing e.g. 10
// commits, I would love to select multiple and set the action at once").
//
// Three surfaces show a plan — the extension's Interactive Rebase workspace,
// its editor for a hand-run `git rebase -i` todo, and the desktop's Rebase
// view — and each used to carry its own copy of every rule here. The copies
// drifted: the squash guard was fixed in one and not the others twice. So the
// rules live ONCE, pure and DOM-free:
//
//   · what a click, a Shift/⌘-click, an arrow, Shift+arrow, Home/End, ⌘A and
//     Escape do to the selection — the conventions of VS Code's and
//     JetBrains' lists, which is where a person's hands already are;
//   · what "set these to <action>" does, including the one plan git refuses
//     outright: a squash or fixup with no kept commit before it to fold into
//     ("cannot 'squash' without a previous commit");
//   · what Alt+↑/↓ and a drag do to a selection that is more than one row.
//
// Rows are named by a stable KEY (a sha, or the todo line's id), never by
// position: the rows move under the selection, which must move with them.
//
// Two display orders exist and both are real: the workspace and the desktop
// list newest-first, as the Commits list does (issue #18); the todo editor
// shows git's file, oldest-first. A fold rests on an OLDER commit, which is
// below in one and above in the other, so every rule about folds takes the
// order it is looking at.
//
// Plain functions over plain data, with no closures over module state: the
// extension's workspace runs them in its webview from a bundle of this file.

export type PlanAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

/** Which end of the list is the newest commit. */
export type PlanOrder = "newest-first" | "oldest-first";

/**
 * The six actions, in the order every toolbar lists them, each with the
 * letter git itself uses for it in a todo file — which is also its key.
 */
export const PLAN_ACTIONS: ReadonlyArray<{
  id: PlanAction;
  label: string;
  key: string;
  /** What it does to the selected commits, for the toolbar's tooltip. */
  does: string;
}> = [
  {
    id: "pick",
    get label() {
      return l10n.t("Pick");
    },
    key: "P",
    get does() {
      return l10n.t("keep the selected commits as they are");
    },
  },
  {
    id: "reword",
    get label() {
      return l10n.t("Reword");
    },
    key: "R",
    get does() {
      return l10n.t("keep them, and rewrite their messages");
    },
  },
  {
    id: "squash",
    get label() {
      return l10n.t("Squash");
    },
    key: "S",
    get does() {
      return l10n.t("fold each into the commit before it, keeping both messages");
    },
  },
  {
    id: "fixup",
    get label() {
      return l10n.t("Fixup");
    },
    key: "F",
    get does() {
      return l10n.t("fold each into the commit before it, dropping its message");
    },
  },
  {
    id: "edit",
    get label() {
      return l10n.t("Edit");
    },
    key: "E",
    get does() {
      return l10n.t("pause at each so you can amend it");
    },
  },
  {
    id: "drop",
    get label() {
      return l10n.t("Drop");
    },
    key: "D",
    get does() {
      return l10n.t("delete the selected commits");
    },
  },
];

/** The action a key names (git's todo letter, either case), if any. */
export function actionForKey(key: string): PlanAction | undefined {
  if (key.length !== 1) return undefined;
  const k = key.toUpperCase();
  return PLAN_ACTIONS.find((a) => a.key === k)?.id;
}

/** The toolbar's tooltip for an action: what it does, and its key. */
export function actionTooltip(action: PlanAction): string {
  const a = PLAN_ACTIONS.find((x) => x.id === action);
  if (!a) return "";
  return `${a.label}: ${a.does} (${a.key})`;
}

export function isFold(action: string): boolean {
  return action === "squash" || action === "fixup";
}

function isKept(action: string): boolean {
  return action === "pick" || action === "reword" || action === "edit";
}

// ── the selection ────────────────────────────────────────────────────────────

export interface PlanSelection {
  /** The selected rows' keys (in the order they were added — use
   *  `selectedInOrder` for list order). */
  readonly selected: readonly string[];
  /** Where a Shift range starts: the row last clicked or arrowed to WITHOUT
   *  Shift. */
  readonly anchor: string | null;
  /** The row the keyboard is on — the moving end of a Shift range. */
  readonly focus: string | null;
}

export const NO_SELECTION: PlanSelection = { selected: [], anchor: null, focus: null };

/** One row, selected and focused, and the anchor of any range that follows. */
export function selectOnly(key: string): PlanSelection {
  return { selected: [key], anchor: key, focus: key };
}

/** The keys from `a` to `b` inclusive, in list order, whichever comes first. */
function span(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  const out = a.slice();
  for (const k of b) if (!out.includes(k)) out.push(k);
  return out;
}

/** The anchor a range extends from: the recorded one while it is still a row,
 *  else the focus, else the row being reached. */
function anchorOf(sel: PlanSelection, order: readonly string[], fallback: string): string {
  if (sel.anchor && order.includes(sel.anchor)) return sel.anchor;
  if (sel.focus && order.includes(sel.focus)) return sel.focus;
  return fallback;
}

export interface ClickMods {
  /** Shift: select the range from the anchor to here. */
  range?: boolean;
  /** ⌘ on a Mac, Ctrl elsewhere: add or remove this row. */
  toggle?: boolean;
}

/**
 * A click on a row.
 *
 *   plain         → this row only
 *   ⌘/Ctrl        → this row in or out, the rest kept; it becomes the anchor
 *   Shift         → anchor..this row, replacing the selection
 *   Shift+⌘/Ctrl  → anchor..this row, ADDED to the selection
 *
 * A key that is not a row changes nothing.
 */
export function clickRow(
  sel: PlanSelection,
  order: readonly string[],
  key: string,
  mods: ClickMods = {},
): PlanSelection {
  if (!order.includes(key)) return sel;
  if (mods.range) {
    const anchor = anchorOf(sel, order, key);
    const range = span(order, anchor, key);
    return { selected: mods.toggle ? union(sel.selected, range) : range, anchor, focus: key };
  }
  if (mods.toggle) {
    const has = sel.selected.includes(key);
    return {
      selected: has ? sel.selected.filter((k) => k !== key) : [...sel.selected, key],
      anchor: key,
      focus: key,
    };
  }
  return selectOnly(key);
}

/**
 * The keyboard reaching row `index` (clamped): an arrow, Home or End.
 *
 * Without Shift the selection follows the keyboard, the way a list does in
 * both VS Code and JetBrains — so a plain arrow followed by a letter still
 * sets exactly the row you are on. With Shift it grows or shrinks from the
 * anchor, which does not move.
 */
export function reachRow(
  sel: PlanSelection,
  order: readonly string[],
  index: number,
  extend = false,
): PlanSelection {
  if (!order.length) return NO_SELECTION;
  const key = order[Math.max(0, Math.min(order.length - 1, index))];
  if (!extend) return selectOnly(key);
  const anchor = anchorOf(sel, order, key);
  return { selected: span(order, anchor, key), anchor, focus: key };
}

/**
 * An arrow: one row up (-1) or down (+1) from the focus, clamped at both ends.
 * From no focus, Down lands on the first row and Up on the last.
 */
export function arrowRow(
  sel: PlanSelection,
  order: readonly string[],
  delta: -1 | 1,
  extend = false,
): PlanSelection {
  if (!order.length) return NO_SELECTION;
  const at = sel.focus ? order.indexOf(sel.focus) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : order.length - 1) : at + delta;
  return reachRow(sel, order, next, extend);
}

/**
 * Escape: back to the one row the keyboard is on. Returns the SAME object when
 * there was nothing to collapse, so a caller can tell "Escape was used" from
 * "Escape is someone else's".
 */
export function collapseSelection(sel: PlanSelection): PlanSelection {
  if (!sel.focus) return sel.selected.length ? NO_SELECTION : sel;
  if (sel.selected.length === 1 && sel.selected[0] === sel.focus) return sel;
  return selectOnly(sel.focus);
}

/** ⌘/Ctrl+A: every row, keeping the keyboard where it is. */
export function selectAll(sel: PlanSelection, order: readonly string[]): PlanSelection {
  if (!order.length) return NO_SELECTION;
  const focus = sel.focus && order.includes(sel.focus) ? sel.focus : order[0];
  return { selected: order.slice(), anchor: order[0], focus };
}

/** Drop keys that are no longer rows (a reload, a new base). */
export function pruneSelection(sel: PlanSelection, order: readonly string[]): PlanSelection {
  const selected = sel.selected.filter((k) => order.includes(k));
  const focus = sel.focus && order.includes(sel.focus) ? sel.focus : null;
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : focus;
  if (selected.length === sel.selected.length && focus === sel.focus && anchor === sel.anchor) {
    return sel;
  }
  return { selected, anchor, focus };
}

/** The selected keys in LIST order. */
export function selectedInOrder(sel: PlanSelection, order: readonly string[]): string[] {
  return order.filter((k) => sel.selected.includes(k));
}

// ── folds ───────────────────────────────────────────────────────────────────

/**
 * The row a squash/fixup at `index` folds into, or -1 when there is none.
 *
 * git melds a squash into the commit BEFORE it in the todo; a run of
 * squashes chains into the same commit, and a dropped commit is not there to
 * meld into. So it is the nearest OLDER row that is kept — pick, reword or
 * edit. Older is below in a newest-first list and above in git's own file.
 */
export function foldTargetIndex(
  actions: readonly string[],
  index: number,
  order: PlanOrder,
): number {
  const step = order === "newest-first" ? 1 : -1;
  for (let j = index + step; j >= 0 && j < actions.length; j += step) {
    if (isKept(actions[j])) return j;
  }
  return -1;
}

/** A squash/fixup that has nothing to fold into — a plan git refuses. */
export function isOrphanFold(actions: readonly string[], index: number, order: PlanOrder): boolean {
  return isFold(actions[index]) && foldTargetIndex(actions, index, order) < 0;
}

export interface SetActionsResult {
  /** Every row's action afterwards. */
  actions: PlanAction[];
  /** Rows whose action changed. */
  changed: number[];
  /** Rows asked to fold that were left as they were: nothing older is kept. */
  refused: number[];
}

/**
 * Set `action` on the rows at `indices`.
 *
 * A fold is refused, row by row, where it would have nothing to fold into —
 * git rejects the whole plan for one of those. The rows are decided OLDEST
 * first, because whether a row has anything to fold into depends on the rows
 * older than it, including rows of this same selection: select ten commits,
 * press S, and the oldest of them — if nothing older is kept — stays as it
 * was, while the nine newer ones fold into it. That is what "squash these
 * together" means, and it is the only reading git can run.
 *
 * Drops and other changes are never refused, even when they strand a fold
 * elsewhere: the plan says so on that row and Start stays closed until it is
 * fixed (a surface re-checks `isOrphanFold` on every render).
 */
export function setActions(
  actions: readonly PlanAction[],
  indices: readonly number[],
  action: PlanAction,
  order: PlanOrder,
): SetActionsResult {
  const next = actions.slice();
  const valid = [...new Set(indices)].filter((i) => i >= 0 && i < actions.length);
  const refused: number[] = [];
  if (isFold(action)) {
    const oldestFirst = valid.sort((a, b) => (order === "newest-first" ? b - a : a - b));
    for (const i of oldestFirst) {
      const was = next[i];
      next[i] = action;
      if (foldTargetIndex(next, i, order) < 0) {
        next[i] = was;
        refused.push(i);
      }
    }
  } else {
    for (const i of valid) next[i] = action;
  }
  const changed: number[] = [];
  for (let i = 0; i < next.length; i++) if (next[i] !== actions[i]) changed.push(i);
  refused.sort((a, b) => a - b);
  return { actions: next, changed, refused };
}

function label(action: string): string {
  return PLAN_ACTIONS.find((a) => a.id === action)?.label ?? action;
}

/**
 * What to say when `setActions` refused some rows — or "" when it refused
 * none. Words, in the list's own direction: "below" where older is below.
 *
 * `was` is what the refused rows were left as (one row: its action; several:
 * ignored).
 */
export function refusalText(
  action: PlanAction,
  result: Pick<SetActionsResult, "changed" | "refused">,
  order: PlanOrder,
  was?: PlanAction,
): string {
  const n = result.refused.length;
  if (!n) return "";
  const where = order === "newest-first" ? l10n.t("below") : l10n.t("above");
  const oldest = order === "newest-first" ? l10n.t("oldest") : l10n.t("first");
  const a = label(action);
  const named = /^[aeiou]/i.test(a) ? l10n.t("an {0}", a.toLowerCase()) : l10n.t("a {0}", a.toLowerCase());
  const applied = result.changed.length;
  if (!applied) {
    return n === 1
      ? l10n.t("The {0} commit you keep can't be {1} — there's nothing {2} it to fold into.", oldest, named, where)
      : l10n.t("None of these can be {0} — nothing {1} them is kept to fold into.", named, where);
  }
  const done =
    applied === 1 ? l10n.t("{0} set on 1 commit.", a) : l10n.t("{0} set on {1} commits.", a, applied);
  if (n === 1) {
    return l10n.t("{0} The {1} one stays {2} — there's nothing {3} it to fold into.", done, oldest, was ? label(was) : l10n.t("as it was"), where);
  }
  return l10n.t("{0} The {1} {2} stay as they were — nothing {3} them is kept to fold into.", done, n, oldest, where);
}

// ── moving ──────────────────────────────────────────────────────────────────

/**
 * Alt+↑ / Alt+↓: every selected row one step up (-1) or down (+1), past its
 * unselected neighbour, keeping the selection's own order — a block moves as
 * a block, and a scattered selection moves each of its rows one step. Null
 * when a selected row is already against that edge (nothing moves, the way
 * VS Code's Move Line Up treats the first line).
 */
export function moveSelected(
  order: readonly string[],
  selected: readonly string[],
  delta: -1 | 1,
): string[] | null {
  const sel = new Set(selected.filter((k) => order.includes(k)));
  if (!sel.size) return null;
  const out = order.slice();
  const swap = (i: number, j: number): void => {
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  };
  if (delta < 0) {
    if (sel.has(out[0])) return null;
    for (let i = 1; i < out.length; i++) {
      if (sel.has(out[i]) && !sel.has(out[i - 1])) swap(i, i - 1);
    }
  } else {
    if (sel.has(out[out.length - 1])) return null;
    for (let i = out.length - 2; i >= 0; i--) {
      if (sel.has(out[i]) && !sel.has(out[i + 1])) swap(i, i + 1);
    }
  }
  return out;
}

/**
 * The rows a drag carries: the whole selection (in list order) when the row
 * picked up is part of it, else that row alone — the way a file manager drags.
 */
export function dragKeys(sel: PlanSelection, order: readonly string[], key: string): string[] {
  return sel.selected.includes(key) ? selectedInOrder(sel, order) : [key];
}

/**
 * Put `moving` (in their list order) into gap `gap` of `order`.
 *
 * Gaps are numbered by the row they sit ABOVE — [A, B, C] has gap 0 above A
 * and gap 3 below C — the coordinate a drop line is drawn at, so a drop hands
 * its hit-test straight here (engine/rebase/chain's `moveToGap` for one row).
 */
export function moveKeysToGap(
  order: readonly string[],
  moving: readonly string[],
  gap: number,
): string[] {
  const set = new Set(moving);
  const g = Math.max(0, Math.min(order.length, gap));
  const rest = order.filter((k) => !set.has(k));
  const block = order.filter((k) => set.has(k));
  const before = order.slice(0, g).filter((k) => !set.has(k)).length;
  return [...rest.slice(0, before), ...block, ...rest.slice(before)];
}

/** "3 selected" — the toolbar's count, and what a screen reader hears. */
export function selectionCountText(n: number): string {
  return n === 0 ? l10n.t("None selected") : `${n} selected`;
}
