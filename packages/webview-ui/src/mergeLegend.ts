// The merge view's colour legend: it explains the COLOURS the panes show, in
// words, each beside a solid dot of that colour and the count still to do —
//
//   ● Conflict — you choose 6 · ● Same on both sides — either arrow takes it 1
//   · ● One side only — safe to take 5 · ● Removed lines 2   (?)
//
// — and a "?" key for the MARKS (a point line, word highlights, a taken
// side's muted band, a discarded side's outline, a half-decided Result).
// Clicking an item goes to the next change of that colour.
//
// The colours are JetBrains' dark merge colours, which the owner picked (24
// Sep 2026), by the DECISION a change needs (paint.ts): orange, you choose;
// green, the same change on both sides; blue, one side only — and grey for
// lines removed without a conflict, on one side or the same on both. One
// colour, one answer — the owner's rule, after the per-type paint made a
// same-on-both change blue one time and green the next. Yours-only and
// Theirs-only are one item; the tooltip says how many of each, and the
// toolbar's "Apply non-conflicting changes: Yours / Theirs" already speaks
// per side.
//
// No symbols of our own: the owner found invented glyphs (≠ = ‹ › ≈ ✨) not
// self-explanatory, and small bordered squares read as unticked checkboxes.
// Words carry the meaning, for everyone and for colour-blind users in
// particular; a dot only ties a word to a colour, and the count is the plain
// number badge VS Code puts beside a tab's name.
//
// Built here and mounted by the shell through MergeViewApi.attachLegend: the
// shell owns WHERE it sits, the view owns WHAT it says and keeps it current on
// every change. Names and counts are set as text nodes only — never innerHTML
// with data.

import type { MergeCategory, MergeCountsView } from "./mergeViewApi";
import type { PaintTone } from "./paint";
import { iconElement, questionIcon } from "./icons";

/** One legend item: a colour the merge paints with (paint.ts's tone of the same name). */
export type LegendItem = PaintTone;

export const LEGEND_ITEMS: readonly LegendItem[] = ["conflict", "same", "one-sided", "removed"];

/**
 * The categories a legend item's changes can be in. A removal is no category
 * of its own — it is a same or a one-sided change that only removes lines —
 * so the view counts and finds the items by their paint (LegendDetail.tones).
 */
export const LEGEND_CATEGORIES: Record<LegendItem, readonly MergeCategory[]> = {
  conflict: ["conflict"],
  same: ["same"],
  "one-sided": ["yours-only", "theirs-only"],
  removed: ["same", "yours-only", "theirs-only"],
};

/** How many changes wear one colour, and how many of them are still to do (the pending ones per side). */
export interface ToneCount {
  total: number;
  pending: number;
  /** Pending, made in Yours only. */
  yours: number;
  /** Pending, made in Theirs only. */
  theirs: number;
  /** Pending, made the same on both sides. */
  both: number;
}

/**
 * What the view knows beyond the counts:
 * - the conflicts with one side in and the other still to decide (JetBrains:
 *   that side is resolved, the change is not) — said in words on the conflict
 *   item, "Yours taken, Theirs to decide";
 * - each colour's count, by the paint the view gives each change (paint.ts).
 *   Without it an item counts its categories, and nothing is grey.
 */
export interface LegendDetail {
  halfDone: Array<{ done: "yours" | "theirs"; taken: boolean }>;
  tones?: Record<LegendItem, ToneCount>;
}

interface ItemWords {
  /** What the colour is. */
  label: string;
  /** What the colour asks of you ("Conflict — you choose"); empty when the name says it all. */
  note: string;
  /** Why, in the tooltip (after the count). */
  why: string;
  one: string;
  many: string;
}

/**
 * The owner's words, one per colour: "Conflict — you choose", "Same on both
 * sides — either arrow takes it", "One side only — safe to take", "Removed
 * lines".
 */
export const LEGEND_WORDS: Record<LegendItem, ItemWords> = {
  conflict: {
    label: "Conflict",
    note: "you choose",
    why: "Both sides changed these lines, differently",
    one: "conflict",
    many: "conflicts",
  },
  same: {
    label: "Same on both sides",
    note: "either arrow takes it",
    why: "Both sides added or changed these lines the same way: nothing to choose",
    one: "change made the same on both sides",
    many: "changes made the same on both sides",
  },
  "one-sided": {
    label: "One side only",
    note: "safe to take",
    why: "Only one side added or changed these lines",
    one: "change made on one side only",
    many: "changes made on one side only",
  },
  removed: {
    label: "Removed lines",
    note: "",
    why: "Lines removed on one side only, or the same lines removed on both: no conflict, safe to take",
    one: "removal",
    many: "removals",
  },
};

/** An item's name as a tooltip and a screen reader say it: "Conflict — you choose", "Removed lines". */
export function legendName(item: LegendItem): string {
  const { label, note } = LEGEND_WORDS[item];
  return note ? `${label} — ${note}` : label;
}

interface Chip {
  button: HTMLButtonElement;
  count: HTMLElement;
  note: HTMLElement;
  dash: HTMLElement;
  /** The dot before this item (none before the first). */
  sep?: HTMLElement;
}

/** One row of the "?" key: a sample (dots or a mark), and what it means. */
interface KeyRow {
  dots?: string[];
  sample?: string;
  text: string;
}

const KEY: KeyRow[] = [
  { dots: ["conflict"], text: "Conflict — you choose (orange): both sides changed these lines, differently — even when one of them removed lines. Accept one side, both, or edit the result." },
  { dots: ["same"], text: "Same on both sides — either arrow takes it (green): both sides added or changed these lines the same way. Nothing to choose." },
  { dots: ["one-sided"], text: "One side only — safe to take (blue): only one side added or changed these lines." },
  { dots: ["removed"], text: "Removed lines (grey): lines removed on one side only, or the same lines removed on both. No conflict: safe to take." },
  { sample: "column", text: "A change still to decide: its line numbers and its link to the Result in the full colour, its lines lighter with the words that changed in the full colour — or all of it in the full colour when it is all new, or all gone." },
  { sample: "point", text: "A band that meets a line between two rows on the other side: lines added there, or removed." },
  { sample: "word", text: "A stronger tint on some words: exactly what changed within the line. A change of whitespace only has none; its tooltip says so." },
  { sample: "half", text: "A lighter band in the Result, line numbers too: a conflict with one side in, the other still to decide." },
  { sample: "trace", text: "A lighter band, line numbers too, linked to the Result: the side you took. A settled Result keeps it too." },
  { sample: "done", text: "A thin outline with no link: the side you discarded." },
];

function dot(tone: string): HTMLElement {
  const d = document.createElement("span");
  d.className = `jb-legend-dot jb-dot-${tone}`;
  d.setAttribute("aria-hidden", "true");
  return d;
}

function sample(kind: string): HTMLElement {
  const s = document.createElement("span");
  s.className = `jb-legend-sample jb-sample-${kind}`;
  s.setAttribute("aria-hidden", "true");
  return s;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Yours taken, Theirs to decide", or "2 with one side taken" — undefined when none. */
export function halfDoneWords(detail: LegendDetail | undefined, pendingConflicts: number): string | undefined {
  const half = detail?.halfDone ?? [];
  if (half.length === 0) return undefined;
  if (half.length === 1 && pendingConflicts === 1) {
    const [{ done, taken }] = half;
    const doneWord = done === "yours" ? "Yours" : "Theirs";
    const otherWord = done === "yours" ? "Theirs" : "Yours";
    return `${doneWord} ${taken ? "taken" : "ignored"}, ${otherWord} to decide`;
  }
  return `${half.length} with one side in, the other to decide`;
}

export class MergeLegend {
  public readonly element: HTMLElement;
  private readonly chips = new Map<LegendItem, Chip>();
  private readonly helpButton: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private open = false;
  private closeListeners?: () => void;

  /**
   * `onJump` goes to the next pending change of an item's colour: its
   * categories, and the item itself (the paint) — a removal is a same or a
   * one-sided change, so only the paint tells it apart.
   */
  constructor(private readonly onJump: (categories: readonly MergeCategory[], item: LegendItem) => void) {
    const root = document.createElement("div");
    root.className = "jb-legend";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "What the colours mean");
    this.element = root;

    for (const item of LEGEND_ITEMS) {
      const words = LEGEND_WORDS[item];
      let sep: HTMLElement | undefined;
      if (this.chips.size > 0) {
        sep = document.createElement("span");
        sep.className = "jb-legend-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "·";
        root.appendChild(sep);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `jb-legend-chip jb-legend-${item}`;
      button.dataset.category = item;
      // ● Conflict — you choose [6]: the dot of its colour, what the colour
      // is, what it asks of you (when its name does not say it all: "Removed
      // lines" asks nothing more), and how many are left.
      const label = document.createElement("span");
      label.className = "jb-legend-label";
      label.textContent = words.label;
      const dash = document.createElement("span");
      dash.className = "jb-legend-dash";
      dash.setAttribute("aria-hidden", "true");
      dash.textContent = "—";
      const note = document.createElement("span");
      note.className = "jb-legend-note";
      note.textContent = words.note;
      const count = document.createElement("span");
      count.className = "jb-legend-count";
      count.textContent = "0";
      button.append(dot(item), label, dash, note, count);
      button.addEventListener("click", () => this.onJump(LEGEND_CATEGORIES[item], item));
      this.chips.set(item, { button, count, note, dash, sep });
      root.appendChild(button);
    }

    const help = document.createElement("button");
    help.type = "button";
    help.className = "jb-legend-help";
    help.setAttribute("aria-label", "What the colours and lines mean");
    help.title = "What the colours and lines mean";
    help.setAttribute("aria-expanded", "false");
    help.appendChild(iconElement(questionIcon));
    this.helpButton = help;

    const pop = document.createElement("div");
    pop.className = "jb-legend-pop";
    pop.id = `jb-legend-pop-${Math.random().toString(36).slice(2)}`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "What the merge colours and lines mean");
    pop.hidden = true;
    for (const row of KEY) {
      const line = document.createElement("div");
      line.className = "jb-legend-row";
      const lead = document.createElement("span");
      lead.setAttribute("aria-hidden", "true");
      for (const tone of row.dots ?? []) lead.appendChild(dot(tone));
      if (row.sample) lead.appendChild(sample(row.sample));
      const text = document.createElement("span");
      text.textContent = row.text;
      line.append(lead, text);
      pop.appendChild(line);
    }
    help.setAttribute("aria-controls", pop.id);
    this.pop = pop;
    help.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setOpen(!this.open);
    });
    root.append(help, pop);
  }

  /** Repaints every item from the view's counts (and what it knows of half-done conflicts). */
  public update(counts: MergeCountsView, detail?: LegendDetail): void {
    let shownBefore = false;
    for (const item of LEGEND_ITEMS) {
      const chip = this.chips.get(item);
      if (!chip) {
        continue;
      }
      // By paint when the view says (a removal is grey whatever its
      // category); else by category, and nothing is grey.
      const byCategory = (cats: readonly MergeCategory[], key: "total" | "pending"): number =>
        cats.reduce((n, cat) => n + counts.byCategory[cat][key], 0);
      const fallback: ToneCount =
        item === "removed"
          ? { total: 0, pending: 0, yours: 0, theirs: 0, both: 0 }
          : {
              total: byCategory(LEGEND_CATEGORIES[item], "total"),
              pending: byCategory(LEGEND_CATEGORIES[item], "pending"),
              yours: item === "one-sided" ? counts.byCategory["yours-only"].pending : 0,
              theirs: item === "one-sided" ? counts.byCategory["theirs-only"].pending : 0,
              both: item === "same" ? counts.byCategory.same.pending : 0,
            };
      const tally = detail?.tones?.[item] ?? fallback;
      const { total, pending } = tally;
      const words = LEGEND_WORDS[item];
      chip.count.textContent = String(pending);
      chip.button.disabled = pending === 0;
      chip.button.classList.toggle("jb-legend-none", total === 0);
      // A dot only BETWEEN two items on screen.
      if (chip.sep) chip.sep.hidden = total === 0 || !shownBefore;
      shownBefore ||= total > 0;

      const half = item === "conflict" ? halfDoneWords(detail, pending) : undefined;
      // How many of the open conflicts the wand can settle: said ON SCREEN
      // (the critic, r0923: a conflict the wand resolves looked exactly like a
      // hard one, and only a tooltip said otherwise).
      const resolvable = item === "conflict" ? Math.min(counts.resolvableConflictsPending, pending) : 0;
      // Nothing left of this colour: its count says 0, and it asks nothing.
      chip.note.textContent =
        pending === 0
          ? ""
          : half ?? (resolvable > 0 ? `${words.note} · ${resolvable} can be merged automatically` : words.note);
      chip.note.hidden = chip.note.textContent === "";
      chip.dash.hidden = chip.note.textContent === "";

      let text =
        total === 0
          ? `No ${words.many}`
          : pending === 0
            ? `${total === 1 ? `The ${words.one} is` : `All ${total} ${words.many} are`} dealt with`
            : `${plural(pending, words.one, words.many)} left${pending < total ? ` of ${total}` : ""}`;
      if (item === "conflict") {
        if (half) text += ` (${half})`;
        // Only ever said when there is something for the wand to do: never
        // "0 can be resolved", nor any count of nothing.
        const k = Math.min(counts.resolvableConflictsPending, pending);
        if (k > 0) {
          text += `; ${k === pending ? (k === 1 ? "it" : "all") : k} can be resolved automatically (Resolve simple conflicts)`;
        }
      } else if (item === "one-sided" && pending > 0) {
        text += ` (${tally.yours} in Yours, ${tally.theirs} in Theirs)`;
      } else if (item === "removed" && pending > 0) {
        const where = [
          tally.yours > 0 ? `${tally.yours} in Yours` : "",
          tally.theirs > 0 ? `${tally.theirs} in Theirs` : "",
          tally.both > 0 ? `${tally.both} the same on both sides` : "",
        ].filter(Boolean);
        text += ` (${where.join(", ")})`;
      }
      if (pending > 0) {
        text += `. ${words.why}. Go to the next one.`;
      }
      const name = legendName(item);
      chip.button.title = `${name}\n${text}`;
      chip.button.setAttribute("aria-label", `${name}: ${text}`);
    }
  }

  public dispose(): void {
    this.setOpen(false);
    this.element.remove();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.pop.hidden = !open;
    this.helpButton.setAttribute("aria-expanded", String(open));
    this.closeListeners?.();
    this.closeListeners = undefined;
    if (!open) {
      return;
    }
    // Fixed, not absolute: the legend lives in a toolbar that scrolls
    // sideways, which would clip an absolutely positioned popover. And
    // because it is fixed, it is placed again whenever the window resizes or
    // anything scrolls while it is open — placed once, it floated away from
    // the button it belongs to.
    // Against the viewport, vertically too: below the button when it fits,
    // else above it when there is more room there, and never taller than the
    // room it has (it scrolls then). In a short window it ran off the bottom
    // and cut the last two rows — the two that explain the resolved look.
    const place = (): void => {
      const rect = this.helpButton.getBoundingClientRect();
      const margin = 8;
      this.pop.style.maxHeight = "";
      const natural = this.pop.offsetHeight || 0;
      const below = window.innerHeight - rect.bottom - 4 - margin;
      const above = rect.top - 4 - margin;
      const upward = natural > below && above > below;
      const room = Math.max(80, upward ? above : below);
      this.pop.style.maxHeight = `${Math.floor(room)}px`;
      const height = Math.min(natural, room);
      this.pop.style.top = `${Math.round(upward ? rect.top - 4 - height : rect.bottom + 4)}px`;
      const width = this.pop.offsetWidth || 320;
      this.pop.style.left = `${Math.round(Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)))}px`;
    };
    place();
    const onDown = (event: MouseEvent) => {
      if (!this.element.contains(event.target as Node)) {
        this.setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.setOpen(false);
        this.helpButton.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    // Capture: a scroll of ANY ancestor (the toolbar's own overflow) moves the button.
    document.addEventListener("scroll", place, true);
    this.closeListeners = () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }
}
