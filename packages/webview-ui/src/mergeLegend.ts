// The merge view's colour legend: it explains the COLOURS the panes show, in
// words, each beside a solid dot of that colour and the count still to do —
//
//   ● Conflict — you choose 6 · ● Same on both sides — either arrow takes it 1
//   · ● One side only — safe to take 5   (?)
//
// — and a "?" key for the MARKS (a point line, word highlights, a dotted
// edge, a taken side's muted band, a discarded side's outline). Clicking an
// item goes to the next change of that kind.
//
// The colours are the DECISION a change needs (paint.ts): red, you choose;
// green, the same change on both sides, whatever it did; blue, one side only,
// whatever it did. One colour, one question answered — the owner's rule
// (24 Sep 2026), after the per-type paint made a same-on-both change blue one
// time and green the next. Yours-only and Theirs-only are one item; the
// tooltip says how many of each, and the toolbar's "Apply non-conflicting
// changes: Yours / Theirs" already speaks per side.
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
import { iconElement, questionIcon } from "./icons";

/** One legend item: a decision, its colour (paint.ts's tone of the same name), and the categories it counts. */
export type LegendItem = "conflict" | "same" | "one-sided";

export const LEGEND_ITEMS: readonly LegendItem[] = ["conflict", "same", "one-sided"];

/** The categories a legend item counts (and jumps between). */
export const LEGEND_CATEGORIES: Record<LegendItem, readonly MergeCategory[]> = {
  conflict: ["conflict"],
  same: ["same"],
  "one-sided": ["yours-only", "theirs-only"],
};

/**
 * What the view knows beyond the counts: the conflicts with one side in and
 * the other still to decide (JetBrains: that side is resolved, the change is
 * not). Said in words on the conflict item — "Yours taken, Theirs to decide".
 */
export interface LegendDetail {
  halfDone: Array<{ done: "yours" | "theirs"; taken: boolean }>;
}

interface ItemWords {
  /** What the colour is. */
  label: string;
  /** What the colour asks of you ("Conflict — you choose"). */
  note: string;
  /** Why, in the tooltip (after the count). */
  why: string;
  one: string;
  many: string;
}

/** The owner's words, one per colour: "Conflict — you choose", "Same on both sides — either arrow takes it", "One side only — safe to take". */
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
    why: "Both sides made this change the same way, whether they added, changed or removed lines: nothing to choose",
    one: "change made the same on both sides",
    many: "changes made the same on both sides",
  },
  "one-sided": {
    label: "One side only",
    note: "safe to take",
    why: "Only one side changed these lines, whether it added, changed or removed them",
    one: "change made on one side only",
    many: "changes made on one side only",
  },
};

/** An item's name as a tooltip and a screen reader say it: "Conflict — you choose". */
export function legendName(item: LegendItem): string {
  return `${LEGEND_WORDS[item].label} — ${LEGEND_WORDS[item].note}`;
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
  { dots: ["conflict"], text: "Conflict — you choose (red): both sides changed these lines, differently. Accept one side, both, or edit the result." },
  { dots: ["same"], text: "Same on both sides — either arrow takes it (green): both sides made this change the same way, whether they added, changed or removed lines. Nothing to choose." },
  { dots: ["one-sided"], text: "One side only — safe to take (blue): only one side changed these lines, whether it added, changed or removed them." },
  { sample: "point", text: "A band that meets a line between two rows on the other side: lines added there, or removed." },
  { sample: "word", text: "A stronger tint on some words: exactly what changed within the line." },
  { sample: "ws", text: "A dotted left edge: only whitespace changed." },
  { sample: "half", text: "A paler band between two faint lines, in the Result: a conflict with one side in, the other still to decide." },
  { sample: "trace", text: "A paler band, linked to the Result: the side you took. A settled Result keeps it too." },
  { sample: "done", text: "An outline with no link: the side you discarded." },
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

  constructor(private readonly onJump: (categories: readonly MergeCategory[]) => void) {
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
      // is, what it asks of you, and how many are left.
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
      button.addEventListener("click", () => this.onJump(LEGEND_CATEGORIES[item]));
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
      let total = 0;
      let pending = 0;
      for (const cat of LEGEND_CATEGORIES[item]) {
        total += counts.byCategory[cat].total;
        pending += counts.byCategory[cat].pending;
      }
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
      chip.note.hidden = pending === 0;
      chip.dash.hidden = pending === 0;

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
        const y = counts.byCategory["yours-only"].pending;
        const t = counts.byCategory["theirs-only"].pending;
        text += ` (${y} in Yours, ${t} in Theirs)`;
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
