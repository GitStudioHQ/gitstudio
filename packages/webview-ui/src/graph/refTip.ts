// The hover card behind a row's "+N" ref pill.
//
// Both commit surfaces used the native `title` attribute for this, and the
// native tooltip is the wrong tool twice over:
//
//   · It is SLOW. The browser's hover delay is around a second, and it restarts
//     whenever the pointer moves a pixel — so landing on a 20px pill and holding
//     still enough to earn the tooltip took several seconds in practice. The
//     pill is the only route to the hidden refs, which made it feel broken.
//   · In the sidebar rail it did not appear AT ALL, because the whole row also
//     carries a `title` (sha, subject, author, date). The row's tooltip is what
//     you get for hovering anywhere in it, pill included.
//
// So the pill renders its own card instead: no delay worth noticing, styled
// like the chips it stands for, and one line per ref naming its kind — a bare
// comma list left you guessing whether "1.1.0" was a tag or a branch, which is
// the thing people open it for.
//
// The pill keeps `title=""`. That is not a leftover: an EMPTY title is the only
// way to stop an ancestor's tooltip from applying to a descendant, and without
// it the rail's row tooltip still surfaces over this card a second later.

import { css } from "lit";
import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { esc as escapeTip } from "./format";

/** A ref folded into the "+N" pill. `remotes` mirrors the chip's cloud tail. */
export interface TipRef {
  name: string;
  kind: WireRef["kind"];
  remotes?: string[];
}

/** How each ref kind reads in the card (and in the pill's aria-label). */
export const REF_KIND_LABEL: Record<WireRef["kind"], string> = {
  currentHead: "current HEAD",
  head: "local branch",
  remoteHead: "remote branch",
  tag: "tag",
};

const KIND_ICON: Record<WireRef["kind"], string> = {
  currentHead: "git-branch",
  head: "git-branch",
  remoteHead: "cloud",
  tag: "tag",
};

/**
 * Long enough that sweeping the pointer across a column of pills doesn't strobe
 * cards, short enough to read as instant. The native tooltip this replaces was
 * ~10× slower and reset on every pointer move.
 */
const OPEN_DELAY_MS = 90;
/** Long enough to cross the gap between the pill and the card below it. */
const LEAVE_GRACE_MS = 140;
/** Gap between the pill and the card, and the minimum margin to the viewport. */
const GAP = 6;

/** Serialize the hidden refs for the pill's `data-more` attribute. */
export function tipData(refs: TipRef[]): string {
  return JSON.stringify(
    refs.map((r) => (r.remotes?.length ? { n: r.name, k: r.kind, r: r.remotes } : { n: r.name, k: r.kind })),
  );
}

/** The pill's screen-reader text — the card is pointer-only. */
export function tipAriaLabel(refs: TipRef[]): string {
  return `${refs.length} more: ${refs
    .map((r) => `${r.name} (${REF_KIND_LABEL[r.kind]})`)
    .join(", ")}`;
}

interface WireTipRef {
  n: string;
  k: WireRef["kind"];
  r?: string[];
}

/**
 * Owns one card for a host component. The host wires three things: pointerover
 * / pointerout on its scroller, and `hide()` wherever the anchor can go away
 * underneath the pointer (scroll, re-render, selection change).
 */
export class RefTip {
  private timer = 0;
  private anchor: HTMLElement | null = null;

  /** `find` re-queries every time: Lit rebuilds the card element whenever the
   *  host switches templates (loading / empty / error), so a cached node goes
   *  stale exactly when the list repopulates. */
  constructor(private readonly find: () => HTMLElement | null) {}

  /**
   * Pointer entered something. Opens for a "+N" pill (always — its whole job is
   * standing in for refs you cannot see), and for any element carrying
   * `data-more` / `data-text` whose text is actually CLIPPED. The clipping test
   * is what keeps this from firing on every chip and every commit message you
   * merely sweep the pointer across.
   */
  handleOver(e: Event): void {
    // A PINNED card was opened by a click and is dismissed by one — not by the
    // pointer wandering off. Without this guard, moving towards the card (which
    // means leaving the pill) closed the very card you were reaching into, so
    // its rows could never be clicked with a real mouse. The headless click in
    // the check never moved a pointer, so it passed regardless.
    if (this.pinned) return;
    const pill = pillOf(e);
    if (pill && !shouldOpen(pill)) {
      if (this.anchor) this.hide();
      return;
    }
    if (!pill) {
      // Moving OFF a pill onto anything else closes: pointerout alone misses
      // the case where the pill is removed from under the pointer mid-scroll.
      // Not when the pointer is inside the card itself — that is not "off".
      if (this.anchor && !this.overCard) {
        this.hide();
      }
      return;
    }
    if (pill === this.anchor) {
      return;
    }
    this.hide();
    this.anchor = pill;
    this.timer = window.setTimeout(() => this.paint(pill), OPEN_DELAY_MS);
  }

  /**
   * Pointer left something. Closes only when it actually left the pill — and
   * then not immediately, because the card's rows are links and the pointer
   * has to cross the gap between pill and card to reach them. A card that
   * vanishes as you reach for it is a card you cannot click.
   */
  handleOut(e: Event): void {
    if (this.pinned) return;
    if (this.anchor && pillOf(e) === this.anchor) {
      window.setTimeout(() => {
        if (!this.overCard && !this.pinned) this.hide();
      }, LEAVE_GRACE_MS);
    }
  }

  /** True while the pointer is inside the card itself. */
  private overCard = false;
  /** Set by a CLICK on the pill: the card stays until dismissed. */
  private pinned = false;

  /** Open now, with no hover delay, and keep it open. */
  pin(pill: HTMLElement): void {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    if (this.anchor === pill && this.pinned) {
      this.dismiss();
      return;
    }
    this.pinned = false;
    this.hide();
    this.anchor = pill;
    this.paint(pill);
    this.pinned = true;
  }

  /** Close a pinned card (an outside click, Escape, or a row being taken). */
  dismiss(): void {
    this.pinned = false;
    this.overCard = false;
    this.hide();
  }

  /** True while a pinned card is on screen, so the host can route Escape. */
  get isPinned(): boolean {
    return this.pinned;
  }

  /** The commit the open card belongs to, for the action a row click emits. */
  get sha(): string | undefined {
    return this.anchorSha;
  }

  private anchorSha?: string;

  /**
   * The card carries interactive rows, so it needs its own pointer tracking.
   * Bound once per element — `find()` returns the same node for the life of
   * the component.
   */
  private bindCard(el: HTMLElement): void {
    if (el.dataset.gsTipBound) return;
    el.dataset.gsTipBound = "1";
    el.addEventListener("pointerenter", () => {
      this.overCard = true;
    });
    el.addEventListener("pointerleave", () => {
      this.overCard = false;
      if (!this.pinned) this.hide();
    });
  }

  hide(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.anchor = null;
    this.anchorSha = undefined;
    const el = this.find();
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  }

  private paint(pill: HTMLElement): void {
    this.timer = 0;
    const el = this.find();
    if (el) this.bindCard(el);
    this.anchorSha = (pill.closest("[data-sha]") as HTMLElement | null)?.dataset.sha;
    // The pill can be recycled out of the DOM during the open delay — the rows
    // are virtualized and repaint on every scroll tick.
    if (!el || !pill.isConnected) {
      return;
    }
    const text = pill.dataset.text;
    if (text !== undefined) {
      el.innerHTML = `<div class="tip-text">${escapeTip(text)}</div>`;
    } else {
      const refs = parse(pill.dataset.more);
      if (!refs.length) {
        return;
      }
      el.innerHTML = refs.map(rowHtml).join("");
    }
    el.hidden = false;
    placeCard(el, pill);
  }
}

/** The "+N" pill under an event, if any (works through shadow boundaries). */
function pillOf(e: Event): HTMLElement | null {
  const target = e.composedPath()[0] as HTMLElement | null;
  return (
    (target?.closest?.("[data-more],[data-text]") as HTMLElement | null) ?? null
  );
}

/**
 * Whether this anchor has anything worth revealing.
 *
 * The "+N" pill always does. Everything else earns a card only when its text is
 * genuinely cut off — otherwise the card just restates what is already legible,
 * and pops up every time the pointer crosses the column.
 */
function shouldOpen(el: HTMLElement): boolean {
  // The "+N" pill always opens — standing in for refs you cannot see IS its job.
  // Two surfaces spell it differently: the graph's chip-overflow, the rail's
  // "more".
  if (el.classList.contains("chip-overflow") || el.classList.contains("more")) {
    return true;
  }
  // Otherwise: is anything here actually cut off? The clipped node is the
  // anchor itself for a commit subject, but a NESTED label span for a chip —
  // and the two surfaces name that span differently (.nm in the graph, .name in
  // the rail). Walking the subtree avoids hardcoding either, which is what made
  // the rail's chips silently never open: the probe measured the chip box,
  // which is not the element that clips.
  if (isClipped(el)) {
    return true;
  }
  for (const child of el.querySelectorAll<HTMLElement>("*")) {
    if (isClipped(child)) {
      return true;
    }
  }
  return false;
}

function isClipped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1;
}

function parse(raw: string | undefined): TipRef[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as WireTipRef[];
    return parsed.map((r) => ({ name: r.n, kind: r.k, remotes: r.r }));
  } catch {
    return [];
  }
}

function rowHtml(ref: TipRef): string {
  const also = ref.remotes?.length
    ? `<span class="tip-also">· also on ${escapeTip(ref.remotes.join(", "))}</span>`
    : "";
  // A LINK, like the chips it stands in for. A ref folded behind "+N" used to
  // be the one ref on the row you could read but not open — and on a busy row
  // that is most of them.
  return (
    `<div class="tip-row tip-${ref.kind}" role="link" tabindex="0"` +
    ` data-ref="${escapeTip(ref.name)}" data-kind="${escapeTip(ref.kind)}">` +
    `<span class="codicon codicon-${KIND_ICON[ref.kind]}" aria-hidden="true"></span>` +
    `<span class="tip-name">${escapeTip(ref.name)}</span>` +
    `<span class="tip-kind">${REF_KIND_LABEL[ref.kind]}</span>` +
    `${also}</div>`
  );
}

/**
 * Below the pill, left-aligned, flipped above when the bottom of the viewport
 * is closer than the card is tall. Measured AFTER the content is in, because a
 * card listing eight refs and a card listing one differ by 150px.
 */
export function placeCard(el: HTMLElement, pill: HTMLElement): void {
  // Neutralize any previous placement before measuring, or the second open
  // measures a card still clamped by the first one's position.
  el.style.left = "0px";
  el.style.top = "0px";
  const anchor = pill.getBoundingClientRect();
  const card = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const left = Math.max(GAP, Math.min(anchor.left, vw - card.width - GAP));
  const below = anchor.bottom + GAP;
  const top = below + card.height > vh - GAP ? anchor.top - card.height - GAP : below;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(GAP, top))}px`;
}

/** The package's one HTML escaper (graph/format.ts), under the name the
 * tip surfaces have always used for it. */
export { escapeTip };

/** Card styling. Add to a host's `static styles` alongside its own block. */
export const refTipStyles = css`
  .reftip {
    position: fixed;
    z-index: 40;
    left: 0;
    top: 0;
    max-width: 440px;
    padding: 5px 0;
    border: 1px solid var(--gs-border, var(--vscode-widget-border, transparent));
    border-radius: 6px;
    background: var(--vscode-editorHoverWidget-background, var(--gs-bg));
    color: var(--vscode-editorHoverWidget-foreground, var(--gs-fg));
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.34);
    font-size: 11.5px;
    line-height: 1.5;
    /* The pointer must never land ON the card: it sits directly under the pill,
       so a hoverable card would fight the pointerout that closes it. */
    pointer-events: none;
  }
  .reftip[hidden] {
    display: none;
  }
  .tip-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 5px;
    padding: 1px 9px;
    white-space: nowrap;
  }
  /* The rows are links, so they have to look like it — a card that opens a
     branch while reading like a read-only legend is a control nobody finds. */
  .tip-row[data-ref] {
    cursor: pointer;
    border-radius: 4px;
  }
  .tip-row[data-ref]:hover,
  .tip-row[data-ref]:focus-visible {
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.18));
    outline: none;
  }
  .tip-row .codicon {
    font-size: 11px;
    flex: 0 0 auto;
    opacity: 0.9;
  }
  /* WRAPS, never ellipsizes. This card exists to show what the row could not
     fit; truncating here reproduces the exact problem it was opened to solve —
     a 40-character branch name came out as "aksdjlaksjdlkasjdlakjwdlkajdsl…"
     in the row AND in the card. overflow-wrap:anywhere because a long ref has
     no spaces to break at. */
  .tip-name {
    font-weight: 600;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  /* Plain-text card (a clipped commit subject) — same chrome, no ref furniture. */
  .tip-text {
    padding: 1px 10px;
    max-width: 420px;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .tip-kind,
  .tip-also {
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }
  .tip-currentHead .codicon,
  .tip-head .codicon {
    color: var(--gs-accent, var(--vscode-gitDecoration-modifiedResourceForeground));
  }
  .tip-remoteHead .codicon {
    color: var(--vscode-descriptionForeground);
  }
  .tip-tag .codicon {
    color: var(--gs-amber, var(--vscode-gitDecoration-untrackedResourceForeground));
  }
`;
