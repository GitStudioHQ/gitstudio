// The merge view's colour legend: one chip per category with what is still to
// do, and a "?" key that explains every colour and mark the panes use.
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
import { iconElement, questionIcon, sparkleIcon } from "./icons";

interface ChipWords {
  /** The non-colour cue the panes use for this category. */
  glyph: string;
  label: string;
  one: string;
  many: string;
}

const WORDS: Record<MergeCategory, ChipWords> = {
  conflict: { glyph: "≠", label: "Conflicts", one: "conflict", many: "conflicts" },
  same: { glyph: "=", label: "Identical", one: "identical change", many: "identical changes" },
  "yours-only": { glyph: "‹", label: "Yours only", one: "change only in yours", many: "changes only in yours" },
  "theirs-only": { glyph: "›", label: "Theirs only", one: "change only in theirs", many: "changes only in theirs" },
};

interface Chip {
  button: HTMLButtonElement;
  count: HTMLElement;
  extra?: HTMLElement;
  extraCount?: HTMLElement;
}

/** One row of the "?" key: a sample of the mark, and what it means. */
interface KeyRow {
  sample: () => HTMLElement;
  text: string;
}

function swatch(tone: string, extra = ""): () => HTMLElement {
  return () => {
    const s = document.createElement("span");
    s.className = `jb-legend-swatch jb-swatch-${tone}${extra ? ` ${extra}` : ""}`;
    s.setAttribute("aria-hidden", "true");
    return s;
  };
}

function glyphSample(text: string): () => HTMLElement {
  return () => {
    const s = document.createElement("span");
    s.className = "jb-legend-glyph";
    s.setAttribute("aria-hidden", "true");
    s.textContent = text;
    return s;
  };
}

const KEY: KeyRow[] = [
  { sample: swatch("conflict", "jb-swatch-framed"), text: "≠ Conflict: both sides changed these lines differently (framed)" },
  { sample: () => iconElement(sparkleIcon, "jb-svg jb-legend-glyph"), text: "Conflict the wand can resolve: the two edits don't overlap, so both apply" },
  { sample: swatch("same"), text: "= Identical: both sides made the same change" },
  { sample: glyphSample("≈"), text: "Identical except whitespace: pick whose whitespace to keep" },
  { sample: swatch("inserted"), text: "Added lines, on one side only" },
  { sample: swatch("modified"), text: "Changed lines, on one side only" },
  { sample: swatch("deleted"), text: "Removed lines, on one side only" },
  { sample: glyphSample("‹ ›"), text: "The change came from yours (‹) or theirs (›)" },
  { sample: swatch("applied"), text: "Dashed outline: already applied or ignored" },
  { sample: swatch("ws"), text: "Dotted edge: only whitespace changed" },
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = `jb-legend-chip jb-legend-${cat}`;
      button.dataset.category = cat;
      if (cat === "conflict" || cat === "same") {
        button.appendChild(swatch(cat === "conflict" ? "conflict" : "same")());
      }
      const glyph = document.createElement("span");
      glyph.className = "jb-legend-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = words.glyph;
      const label = document.createElement("span");
      label.className = "jb-legend-label";
      label.textContent = words.label;
      const count = document.createElement("span");
      count.className = "jb-legend-count";
      count.textContent = "0";
      button.append(glyph, label, count);
      const chip: Chip = { button, count };
      if (cat === "conflict") {
        // "(✨ k resolvable)" — only while the wand has something to do.
        const extra = document.createElement("span");
        extra.className = "jb-legend-extra";
        extra.hidden = true;
        const extraCount = document.createElement("span");
        extra.append("(", iconElement(sparkleIcon, "jb-svg"), " ");
        extra.append(extraCount, " resolvable)");
        button.appendChild(extra);
        chip.extra = extra;
        chip.extraCount = extraCount;
      }
      button.addEventListener("click", () => this.onJump(cat));
      this.chips.set(cat, chip);
      root.appendChild(button);
    }

    const help = document.createElement("button");
    help.type = "button";
    help.className = "jb-legend-help";
    help.setAttribute("aria-label", "What the colours and marks mean");
    help.title = "What the colours and marks mean";
    help.setAttribute("aria-expanded", "false");
    help.appendChild(iconElement(questionIcon));
    this.helpButton = help;

    const pop = document.createElement("div");
    pop.className = "jb-legend-pop";
    pop.id = `jb-legend-pop-${Math.random().toString(36).slice(2)}`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Merge colours and marks");
    pop.hidden = true;
    for (const row of KEY) {
      const line = document.createElement("div");
      line.className = "jb-legend-row";
      const text = document.createElement("span");
      text.textContent = row.text;
      line.append(row.sample(), text);
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
      let text =
        total === 0
          ? `No ${words.many}`
          : pending === 0
            ? `${total === 1 ? `The ${words.one} is` : `All ${total} ${words.many} are`} dealt with`
            : `${pending} ${pending === 1 ? words.one : words.many} left${pending < total ? ` of ${total}` : ""}`;
      if (cat === "conflict" && chip.extra && chip.extraCount) {
        const k = counts.resolvableConflictsPending;
        chip.extra.hidden = k === 0;
        chip.extraCount.textContent = String(k);
        if (k > 0) {
          text += `, ${k} the wand can resolve`;
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
