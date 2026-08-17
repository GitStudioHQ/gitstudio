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

  /** Pointer entered something. Opens only for a "+N" pill; ignores the rest. */
  handleOver(e: Event): void {
    const pill = pillOf(e);
    if (!pill) {
      // Moving OFF a pill onto anything else closes: pointerout alone misses
      // the case where the pill is removed from under the pointer mid-scroll.
      if (this.anchor) {
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

  /** Pointer left something. Closes only when it actually left the pill. */
  handleOut(e: Event): void {
    if (this.anchor && pillOf(e) === this.anchor) {
      this.hide();
    }
  }

  hide(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.anchor = null;
    const el = this.find();
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  }

  private paint(pill: HTMLElement): void {
    this.timer = 0;
    const el = this.find();
    // The pill can be recycled out of the DOM during the open delay — the rows
    // are virtualized and repaint on every scroll tick.
    if (!el || !pill.isConnected) {
      return;
    }
    const refs = parse(pill.dataset.more);
    if (!refs.length) {
      return;
    }
    el.innerHTML = refs.map(rowHtml).join("");
    el.hidden = false;
    place(el, pill);
  }
}

/** The "+N" pill under an event, if any (works through shadow boundaries). */
function pillOf(e: Event): HTMLElement | null {
  const target = e.composedPath()[0] as HTMLElement | null;
  return (target?.closest?.("[data-more]") as HTMLElement | null) ?? null;
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
    ? `<span class="tip-also">· also on ${escape(ref.remotes.join(", "))}</span>`
    : "";
  return (
    `<div class="tip-row tip-${ref.kind}">` +
    `<span class="codicon codicon-${KIND_ICON[ref.kind]}" aria-hidden="true"></span>` +
    `<span class="tip-name">${escape(ref.name)}</span>` +
    `<span class="tip-kind">${REF_KIND_LABEL[ref.kind]}</span>` +
    `${also}</div>`
  );
}

/**
 * Below the pill, left-aligned, flipped above when the bottom of the viewport
 * is closer than the card is tall. Measured AFTER the content is in, because a
 * card listing eight refs and a card listing one differ by 150px.
 */
function place(el: HTMLElement, pill: HTMLElement): void {
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

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Card styling. Add to a host's `static styles` alongside its own block. */
export const refTipStyles = css`
  .reftip {
    position: fixed;
    z-index: 40;
    left: 0;
    top: 0;
    max-width: 320px;
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
    align-items: center;
    gap: 5px;
    padding: 1px 9px;
    white-space: nowrap;
  }
  .tip-row .codicon {
    font-size: 11px;
    flex: 0 0 auto;
    opacity: 0.9;
  }
  .tip-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
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
