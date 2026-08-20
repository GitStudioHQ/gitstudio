import { css } from "lit";
import { gravatarUrl, avatarHue, authorInitials } from "./avatar";
import { escapeTip, placeCard } from "./refTip";

/**
 * The hover card for the AUTHOR column.
 *
 * The cell shows a truncated display name and nothing else, which answers
 * "who touched this" but not "who IS that" — two contributors called "Alex", a
 * name that ellipsizes to "Alexandr…", a bot address, or a commit authored by
 * one person and committed by another all read identically. The card carries
 * the identity: the full name, the address it is keyed on, and how much of the
 * loaded history belongs to them.
 *
 * It deliberately mirrors RefTip — same open delay, same placement, same card
 * chrome — so the graph has ONE hover-card idiom rather than two that behave
 * almost alike.
 */

/** Matches RefTip, so the two cards feel like one mechanism. */
const OPEN_DELAY_MS = 260;

export interface AuthorFacts {
  name: string;
  email: string;
  /** Commits by this author among the rows currently loaded. */
  commits: number;
  /** Epoch seconds of their oldest and newest loaded commit. */
  firstSeen: number;
  lastSeen: number;
  /** True when the loaded rows are only a page of a longer history. */
  partial: boolean;
}

/** Serialised onto the author cell as `data-author`. */
export function authorTipData(facts: AuthorFacts): string {
  return JSON.stringify({
    n: facts.name,
    e: facts.email,
    c: facts.commits,
    f: facts.firstSeen,
    l: facts.lastSeen,
    p: facts.partial ? 1 : 0,
  });
}

export class AuthorTip {
  private timer = 0;
  private anchor: HTMLElement | null = null;

  /** Re-queried every time — Lit swaps the subtree on a status change. */
  constructor(private readonly find: () => HTMLElement | null) {}

  handleOver(e: Event): void {
    const cell = cellOf(e);
    if (!cell) {
      if (this.anchor) this.hide();
      return;
    }
    if (cell === this.anchor) return;
    this.hide();
    this.anchor = cell;
    this.timer = window.setTimeout(() => this.paint(cell), OPEN_DELAY_MS);
  }

  handleOut(e: Event): void {
    if (this.anchor && cellOf(e) === this.anchor) this.hide();
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

  private paint(cell: HTMLElement): void {
    this.timer = 0;
    const el = this.find();
    // Rows are virtualized: the cell can be recycled out during the delay.
    if (!el || !cell.isConnected) return;
    const facts = parse(cell.dataset.author);
    if (!facts) return;
    el.innerHTML = cardHtml(facts);
    // Reveal the photo only once it genuinely loads (see cardHtml).
    const img = el.querySelector(".atip-img");
    img?.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    el.hidden = false;
    placeCard(el, cell);
  }
}

function cellOf(e: Event): HTMLElement | null {
  const target = e.composedPath()[0] as HTMLElement | null;
  return (target?.closest?.("[data-author]") as HTMLElement | null) ?? null;
}

function parse(raw: string | undefined): AuthorFacts | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as {
      n: string; e: string; c: number; f: number; l: number; p: number;
    };
    return {
      name: p.n, email: p.e, commits: p.c,
      firstSeen: p.f, lastSeen: p.l, partial: p.p === 1,
    };
  } catch {
    return undefined;
  }
}

function cardHtml(f: AuthorFacts): string {
  const hue = avatarHue(f.email);
  const initials = authorInitials(f.name, f.email);
  // The gravatar is best-effort: no network in some hosts, and an unknown
  // address has no image. The tinted initials sit UNDER it, so a failed or
  // absent load degrades to exactly what the graph's own node avatars show.
  // NO inline onerror. The graph webview's CSP is `script-src 'nonce-…'` with
  // no 'unsafe-inline', so an on* attribute is refused outright and logs a
  // violation on every card. The img instead starts hidden and is revealed by a
  // load listener (see AuthorTip.paint) — the same reveal-on-load the row
  // avatars use, which also means a 404 or blocked host silently leaves the
  // initials disc rather than a broken-image glyph.
  const face =
    `<span class="atip-face" style="--atip-hue:${hue}">` +
    `<span class="atip-initials">${escapeTip(initials)}</span>` +
    `<img class="atip-img" alt="" loading="lazy" src="${escapeTip(gravatarUrl(f.email, 96))}">` +
    `</span>`;

  const span =
    f.commits > 0 && f.firstSeen > 0
      ? `<div class="atip-row"><span class="codicon codicon-git-commit" aria-hidden="true"></span>` +
        `<span>${f.commits} commit${f.commits === 1 ? "" : "s"} in view${f.partial ? "+" : ""}</span></div>` +
        `<div class="atip-row"><span class="codicon codicon-history" aria-hidden="true"></span>` +
        `<span>${escapeTip(dayLabel(f.firstSeen))} — ${escapeTip(dayLabel(f.lastSeen))}</span></div>`
      : "";

  return (
    `<div class="atip">` +
    `<div class="atip-head">${face}` +
    `<div class="atip-id"><div class="atip-name">${escapeTip(f.name)}</div>` +
    `<div class="atip-mail">${escapeTip(f.email || "no email recorded")}</div></div></div>` +
    span +
    `</div>`
  );
}

function dayLabel(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** Card styling. Add to a host's `static styles` alongside refTipStyles. */
export const authorTipStyles = css`
  .atip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 190px;
    max-width: 300px;
    /* .reftip supplies vertical padding only (its rows are full-bleed hover
       targets); this card's content needs its own horizontal inset. */
    padding: 1px 11px 3px;
  }
  .atip-head {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .atip-face {
    position: relative;
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: hsl(var(--atip-hue) 55% 82%);
    color: hsl(var(--atip-hue) 60% 24%);
    font-size: 12px;
    font-weight: 650;
  }
  .atip-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Hidden until it loads — the initials disc underneath is the real base. */
    opacity: 0;
  }
  .atip-img.is-loaded { opacity: 1; }
  .atip-id { min-width: 0; }
  .atip-name {
    font-weight: 650;
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .atip-mail {
    font-size: 11px;
    opacity: 0.72;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .atip-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    opacity: 0.85;
  }
  .atip-row .codicon { font-size: 12px; opacity: 0.7; }
`;
