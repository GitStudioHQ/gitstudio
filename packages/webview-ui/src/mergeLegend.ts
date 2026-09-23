// The merge view's colour legend, in WORDS: one chip per category — a colour
// swatch, what the category is called, and how many are still to do —
// "Conflicts 2 · Same on both sides 1 · Only in Yours 2 · Only in Theirs 2",
// and a "?" key that says what every colour and line in the panes means.
//
// No symbols of our own: the owner found invented glyphs (≠ = ‹ › ≈ ✨) not
// self-explanatory. Words carry the meaning, for everyone and for
// colour-blind users in particular; the swatch only ties a word to a colour.
//
// Built here (P1) and mounted by the shell through MergeViewApi.attachLegend:
// the shell owns WHERE it sits (a slot in its toolbar), the view owns WHAT it
// says and keeps it current on every change. No cross-import either way.
//
// Names and counts are set as text nodes only — never innerHTML with data.

import {
  MERGE_CATEGORIES,
  type MergeCategory,
  type MergeCountsView,
} from "./mergeViewApi";
import { iconElement, questionIcon } from "./icons";

interface ChipWords {
  /** The swatch: the category's tone, or all three for a one-sided change. */
  swatch: string;
  label: string;
  one: string;
  many: string;
}

const WORDS: Record<MergeCategory, ChipWords> = {
  conflict: { swatch: "conflict", label: "Conflicts", one: "conflict", many: "conflicts" },
  same: { swatch: "same", label: "Same on both sides", one: "change made the same on both sides", many: "changes made the same on both sides" },
  "yours-only": { swatch: "one-sided", label: "Only in Yours", one: "change only in Yours", many: "changes only in Yours" },
  "theirs-only": { swatch: "one-sided", label: "Only in Theirs", one: "change only in Theirs", many: "changes only in Theirs" },
};

interface Chip {
  button: HTMLButtonElement;
  count: HTMLElement;
  /** The dot before this chip (none before the first). */
  sep?: HTMLElement;
}

/** One row of the "?" key: a sample of the mark, and what it means. */
interface KeyRow {
  swatch: string;
  text: string;
}

function swatch(kind: string): HTMLElement {
  const s = document.createElement("span");
  s.className = `jb-legend-swatch jb-swatch-${kind}`;
  s.setAttribute("aria-hidden", "true");
  return s;
}

const KEY: KeyRow[] = [
  { swatch: "conflict", text: "Conflict: both sides changed these lines, differently. Accept one side, both, or edit the result." },
  { swatch: "same", text: "Same on both sides: both made this change. Accepting either side takes it." },
  { swatch: "inserted", text: "Lines added on one side only" },
  { swatch: "modified", text: "Lines changed on one side only" },
  { swatch: "deleted", text: "Lines removed on one side only" },
  { swatch: "point", text: "A line between two rows: lines were added or removed at that point" },
  { swatch: "ws", text: "Dotted left edge: only whitespace changed" },
  { swatch: "done", text: "No colour, a faint outline: already accepted or ignored" },
];

export class MergeLegend {
  public readonly element: HTMLElement;
  private readonly chips = new Map<MergeCategory, Chip>();
  private readonly helpButton: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private open = false;
  private closeListeners?: () => void;

  constructor(private readonly onJump: (category: MergeCategory) => void) {
    const root = document.createElement("div");
    root.className = "jb-legend";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Changes by kind");
    this.element = root;

    for (const cat of MERGE_CATEGORIES) {
      const words = WORDS[cat];
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
      button.className = `jb-legend-chip jb-legend-${cat}`;
      button.dataset.category = cat;
      const label = document.createElement("span");
      label.className = "jb-legend-label";
      label.textContent = words.label;
      const count = document.createElement("span");
      count.className = "jb-legend-count";
      count.textContent = "0";
      button.append(swatch(words.swatch), label, count);
      button.addEventListener("click", () => this.onJump(cat));
      this.chips.set(cat, { button, count, sep });
      root.appendChild(button);
    }

    const help = document.createElement("button");
    help.type = "button";
    help.className = "jb-legend-help";
    help.setAttribute("aria-label", "What the colours mean");
    help.title = "What the colours mean";
    help.setAttribute("aria-expanded", "false");
    help.appendChild(iconElement(questionIcon));
    this.helpButton = help;

    const pop = document.createElement("div");
    pop.className = "jb-legend-pop";
    pop.id = `jb-legend-pop-${Math.random().toString(36).slice(2)}`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "What the merge colours mean");
    pop.hidden = true;
    for (const row of KEY) {
      const line = document.createElement("div");
      line.className = "jb-legend-row";
      const text = document.createElement("span");
      text.textContent = row.text;
      line.append(swatch(row.swatch), text);
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

  /** Repaints every chip from the view's counts. */
  public update(counts: MergeCountsView): void {
    let shownBefore = false;
    for (const cat of MERGE_CATEGORIES) {
      const chip = this.chips.get(cat);
      if (!chip) {
        continue;
      }
      const { total, pending } = counts.byCategory[cat];
      const words = WORDS[cat];
      chip.count.textContent = String(pending);
      chip.button.disabled = pending === 0;
      chip.button.classList.toggle("jb-legend-none", total === 0);
      // A dot only BETWEEN two chips on screen.
      if (chip.sep) chip.sep.hidden = total === 0 || !shownBefore;
      shownBefore ||= total > 0;
      let text =
        total === 0
          ? `No ${words.many}`
          : pending === 0
            ? `${total === 1 ? `The ${words.one} is` : `All ${total} ${words.many} are`} dealt with`
            : `${pending} ${pending === 1 ? words.one : words.many} left${pending < total ? ` of ${total}` : ""}`;
      if (cat === "conflict") {
        const k = counts.resolvableConflictsPending;
        if (k > 0) {
          text += `; ${k === pending ? (k === 1 ? "it" : "all") : k} can be resolved automatically (Resolve simple conflicts)`;
        }
      }
      if (pending > 0) {
        text += ". Go to the next one.";
      }
      chip.button.title = text;
      chip.button.setAttribute("aria-label", `${words.label}: ${text}`);
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
    const place = (): void => {
      const rect = this.helpButton.getBoundingClientRect();
      this.pop.style.top = `${Math.round(rect.bottom + 4)}px`;
      const width = this.pop.offsetWidth || 320;
      this.pop.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
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
