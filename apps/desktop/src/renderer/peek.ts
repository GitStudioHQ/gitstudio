// The "peek" — a Linear-style drill-in popup used across every browsable list.
// One overlay hosts a STACK of cards: clicking a branch opens its card, clicking
// a commit inside pushes the commit's card on top, and the header's ← walks
// back — so inspecting never loses your place in the list behind it.
//
// Self-contained like dialogs.ts (no App/renderer imports) so any view module
// can open a peek. Cards render lazily and may be async; the body shows a
// skeleton until the renderer resolves.

import { registerLayer, ownsEscape, holdBackground } from "./overlays";

function mk(tag: string, cls = ""): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function gl(name: string): HTMLElement {
  const s = mk("span", `glyph codicon codicon-${name}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** A header action button on a peek card. */
export interface PeekAction {
  label: string;
  icon?: string;
  /** Accent-filled (at most one per card reads well). */
  primary?: boolean;
  danger?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
  onClick: (ctx: PeekContext, buttonEl: HTMLElement) => void;
}

/** One drillable card in the peek stack. */
export interface PeekCard {
  /** Codicon shown in the header badge. */
  icon: string;
  /** A concrete element for the badge instead of the codicon (e.g. an avatar). */
  iconEl?: HTMLElement;
  title: string;
  /** Small chips rendered after the title (e.g. "current", "↑2"). */
  chips?: HTMLElement[];
  /** Muted line under the title (upstream, author · date, …). */
  subtitle?: string;
  /** Content-heavy cards (repo browsing, file views) get the wide shell. */
  wide?: boolean;
  actions?: PeekAction[];
  /** Fill `body`; async renderers get a skeleton until they resolve. */
  render: (body: HTMLElement, ctx: PeekContext) => void | Promise<void>;
}

/** Handed to card renderers + actions: drives the stack it lives in. */
export interface PeekContext {
  /** Drill into a deeper card (the header grows a ← back button). */
  push(card: PeekCard): void;
  /** Pop back one card; closes the peek when at the root. */
  back(): void;
  /** Close the whole peek (all cards). */
  close(): void;
  /** Re-run the current card's renderer (after a mutation). */
  refresh(): void;
  /** Update the current card's header in place — for cards whose real title
   *  only exists once their async body resolves (e.g. a commit's subject). */
  retitle(title: string, subtitle?: string): void;
}

/** The singleton open peek, so a second openPeek replaces the first. */
let live: { overlay: HTMLElement; dispose: () => void } | null = null;

export function closePeek(): void {
  live?.dispose();
}

/** True while a peek is open — lets global key handlers stand down. */
export function peekIsOpen(): boolean {
  return live !== null;
}

/**
 * Open a peek rooted at `card`. Esc pops one level (closing at the root),
 * clicking the dim backdrop closes outright, and focus is trapped inside —
 * the same contract as the modal dialogs, plus the drill-in stack.
 */
export function openPeek(card: PeekCard): void {
  closePeek();
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = mk("div", "peek-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const shell = mk("div", "peek-card");
  overlay.appendChild(shell);

  const stack: PeekCard[] = [];
  /** Bumped per render; an async renderer landing late writes into a detached body. */
  let renderGen = 0;

  /** Set once the overlay is mounted — see the holdBackground call below. */
  let releaseBackground: (() => void) | undefined;
  const dispose = (): void => {
    if (live?.overlay !== overlay) return;
    live = null;
    layer.release();
    renderGen++;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    // BEFORE restoring focus: focus cannot land inside an inert subtree.
    releaseBackground?.();
    prevFocus?.focus?.();
  };
  const layer = registerLayer(dispose);

  const ctx: PeekContext = {
    push(next) {
      stack.push(next);
      renderTop();
    },
    back() {
      if (stack.length <= 1) {
        dispose();
        return;
      }
      stack.pop();
      renderTop();
    },
    close: dispose,
    refresh: () => renderTop(),
    retitle(title, subtitle) {
      const top = stack[stack.length - 1];
      if (!top) return;
      top.title = title;
      if (subtitle !== undefined) top.subtitle = subtitle;
      const t = shell.querySelector<HTMLElement>(".peek-title");
      if (t) {
        t.textContent = title;
        t.title = title;
      }
      if (subtitle !== undefined) {
        const s = shell.querySelector<HTMLElement>(".peek-subtitle");
        if (s) {
          s.textContent = subtitle;
          s.title = subtitle;
        }
      }
      overlay.setAttribute("aria-label", title);
    },
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // Whatever sits ABOVE this peek owns Esc: the command palette, a menu, or
      // a dialog opened from inside the peek itself. Without standing down, one
      // Esc closed both layers — you dismissed the thing you aimed at and the
      // card under it went too, taking anything you had typed into its filter.
      if (!ownsEscape()) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.back();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(
      shell.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]:not([tabindex='-1'])"),
    ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const renderTop = (): void => {
    const top = stack[stack.length - 1];
    if (!top) return;
    const gen = ++renderGen;
    shell.replaceChildren();
    shell.classList.toggle("peek-card-wide", !!top.wide);

    // ── header ──
    const head = mk("div", "peek-head");
    if (stack.length > 1) {
      const back = mk("button", "peek-nav-btn");
      back.setAttribute("aria-label", "Back");
      back.title = "Back (Esc)";
      back.appendChild(gl("arrow-left"));
      back.addEventListener("click", () => ctx.back());
      head.appendChild(back);
    }
    const badge = mk("div", "peek-badge");
    badge.appendChild(top.iconEl ?? gl(top.icon));
    head.appendChild(badge);

    const titleWrap = mk("div", "peek-titlewrap");
    const titleRow = mk("div", "peek-titlerow");
    const t = mk("div", "peek-title");
    t.textContent = top.title;
    t.title = top.title;
    titleRow.appendChild(t);
    for (const chip of top.chips ?? []) titleRow.appendChild(chip);
    titleWrap.appendChild(titleRow);
    if (top.subtitle) {
      const sub = mk("div", "peek-subtitle");
      sub.textContent = top.subtitle;
      sub.title = top.subtitle;
      titleWrap.appendChild(sub);
    }
    head.appendChild(titleWrap);

    const acts = mk("div", "peek-actions");
    for (const a of top.actions ?? []) {
      const b = mk(
        "button",
        a.primary ? "btn btn-primary peek-act" : a.danger ? "mini-btn peek-act peek-act-danger" : "mini-btn peek-act",
      );
      if (a.icon) b.appendChild(gl(a.icon));
      const lbl = mk("span");
      lbl.textContent = a.label;
      b.appendChild(lbl);
      b.title = a.title ?? a.label;
      b.addEventListener("click", () => a.onClick(ctx, b));
      acts.appendChild(b);
    }
    const closeBtn = mk("button", "peek-nav-btn peek-close");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.title = "Close";
    closeBtn.appendChild(gl("close"));
    closeBtn.addEventListener("click", dispose);
    acts.appendChild(closeBtn);
    head.appendChild(acts);
    shell.appendChild(head);

    // ── body ──
    const body = mk("div", "peek-body");
    shell.appendChild(body);
    overlay.setAttribute("aria-label", top.title);

    const out = top.render(body, ctx);
    if (out instanceof Promise) {
      if (!body.childElementCount) body.appendChild(peekSkeleton());
      out
        .then(() => {
          if (gen !== renderGen) return;
          body.querySelector(".peek-skel")?.remove();
        })
        .catch(() => {
          if (gen !== renderGen) return;
          body.replaceChildren(peekError());
        });
    }
    // Focus lands on the card so Esc/Tab work immediately without stealing
    // focus into the first action (which reads as an accidental highlight).
    shell.tabIndex = -1;
    setTimeout(() => {
      if (gen === renderGen && overlay.isConnected) shell.focus();
    }, 0);
  };

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dispose();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  /**
   * Hold the page behind the card. `aria-modal="true"` above is a claim; this
   * is the mechanism.
   *
   * A peek was the worse case of the two: its card is focused on open with
   * `tabindex="-1"`, and the Tab wrap's own selector excludes `[tabindex='-1']`
   * — so the very first Tab, from the state the peek opens in, walked straight
   * out into the view behind the scrim.
   */
  releaseBackground = holdBackground(overlay);
  live = { overlay, dispose };
  stack.push(card);
  renderTop();
}

/** The shimmering placeholder shown while an async card body loads — built
 *  from the same .sk-* classes as the list-view skeletons so loading looks
 *  identical everywhere. */
function peekSkeleton(): HTMLElement {
  const wrap = mk("div", "peek-skel");
  for (let i = 0; i < 4; i++) {
    const row = mk("div", "sk-row");
    row.appendChild(mk("div", "sk sk-dot"));
    const lines = mk("div", "sk-lines");
    lines.append(mk("div", "sk sk-line mid"), mk("div", "sk sk-line short"));
    row.appendChild(lines);
    wrap.appendChild(row);
  }
  return wrap;
}

function peekError(): HTMLElement {
  const wrap = mk("div", "peek-empty");
  wrap.appendChild(gl("warning"));
  const t = mk("div");
  t.textContent = "Couldn't load this — try again.";
  wrap.appendChild(t);
  return wrap;
}

/** A small titled section inside a peek body (e.g. "Commits", "Changed files"). */
export function peekSection(label: string, count?: number): { root: HTMLElement; body: HTMLElement } {
  const root = mk("div", "peek-section");
  const head = mk("div", "peek-section-head");
  const l = mk("span", "peek-section-label");
  l.textContent = label;
  head.appendChild(l);
  if (typeof count === "number") {
    const c = mk("span", "peek-section-count");
    c.textContent = String(count);
    head.appendChild(c);
  }
  const body = mk("div", "peek-section-body");
  root.append(head, body);
  return { root, body };
}

/** A key→value metadata grid row block (sha, author, dates …). */
export function peekMetaGrid(rows: Array<[string, string | HTMLElement]>): HTMLElement {
  const grid = mk("div", "peek-meta");
  for (const [k, v] of rows) {
    if (typeof v === "string" && !v) continue;
    const key = mk("div", "peek-meta-key");
    key.textContent = k;
    const val = mk("div", "peek-meta-val");
    if (typeof v === "string") val.textContent = v;
    else val.appendChild(v);
    grid.append(key, val);
  }
  return grid;
}

/** A small chip for the peek title row ("current", "↑ 2", "detached"…). */
export function peekChip(text: string, kind: "accent" | "ok" | "warn" | "muted" = "muted"): HTMLElement {
  const c = mk("span", `peek-chip peek-chip-${kind}`);
  c.textContent = text;
  return c;
}
