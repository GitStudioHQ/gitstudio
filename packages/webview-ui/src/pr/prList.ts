// The Pull Requests list: a repository's pull requests, a segment at a time,
// searchable and filterable, one row per PR with everything the desktop's row
// says — its state, title and number, who wrote it, head into base, how long
// since it last changed, its checks, its reviews, its comments, draft and
// fork, and whether it is the branch checked out here.
//
// A typed DOM component, host-agnostic: the extension mounts it in its
// sidebar webview view (list-main.ts), and the desktop can mount the same
// class in its own section. It holds no GitHub state: the host sends a full
// PrListViewState (host-bridge/prProtocol) after every change and hears back
// PrListMessageToHost. What the component owns is only what is on screen —
// an open menu, the search box's words, which row has the keyboard.
//
// A state is PAINTED IN PLACE (conflicts/patch.ts): the view is built from
// the state into a detached copy and only what differs is written, so a row
// that changed is the only row touched — no flash, and the hover, the focus
// and the scroll position stay where they were. Rows are keyed by number.
//
// Every control says what it does: a word on it, or — for an icon button — a
// title and an accessible name in words. The glyphs are codicons (the shared
// vocabulary in @gitstudio/engine/forge/pullRequests), never invented marks.
// Colours are set through the CSSOM (element.style), which a webview's CSP
// allows; a style ATTRIBUTE it would drop.

import type {
  PrFacet,
  PrListAction,
  PrListButton,
  PrListFilters,
  PrListMessage,
  PrListMessageToHost,
  PrListState,
  PrListViewState,
  PrPerson,
  PrRowView,
} from "@gitstudio/host-bridge/prProtocol";
import { CI_STATES, PR_ACTIONS, PR_STATES, REVIEW_DECISIONS, ciWords } from "@gitstudio/engine/forge/pullRequests";
import { NO_ONE, PR_FACETS, PR_FACET_WORDS, PR_LIST_STATES, PR_LIST_STATE_WORDS, countFor } from "@gitstudio/engine/forge/prList";
import { patchChildren } from "../conflicts/patch";
import { avatarSrc } from "./avatarSrc";

export interface PrListTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface PullRequestListOptions {
  /** Deliver a message to the host. */
  post(message: PrListMessageToHost): void;
  /** How long the search box waits for typing to pause (tests pass 0). */
  searchDelayMs?: number;
  timers?: PrListTimers;
}

// ── Small DOM helpers ────────────────────────────────────────────────────────

/** The search box's placeholders, longest first: the one that fits whole is shown. */
const SEARCH_PLACEHOLDERS = ["Search pull requests", "Search"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function codicon(name: string, extra = ""): HTMLElement {
  const s = el("span", `codicon codicon-${name}${extra ? ` ${extra}` : ""}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

function button(cls: string, key: string, act: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.dataset.key = key;
  b.dataset.act = act;
  return b;
}

/** "1.2k" for a count too wide for a segment; the exact number rides in the title. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

/** How long ago, in the fewest characters a row can spare: "now", "5m", "3h", "2d", "4mo", "2y". */
export function shortAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365.25)}y`;
}

/** The same age as words, for a screen reader and a title. */
export function ageWords(iso: string, now: number): string {
  const a = shortAge(iso, now);
  if (!a) return "";
  if (a === "now") return "just now";
  const m = /^(\d+)(mo|m|h|d|y)$/.exec(a);
  if (!m) return a;
  const n = Number(m[1]);
  const unit = { m: "minute", h: "hour", d: "day", mo: "month", y: "year" }[m[2] as "m" | "h" | "d" | "mo" | "y"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * A button's action, kept with the button — never written into the page and
 * parsed back out of it, where anything that can touch the DOM could change it.
 */
const BUTTON_ACTIONS = new WeakMap<Element, PrListAction>();


/** A hue for a login's initials disc — the same for the same person, everywhere. */
function hueOf(login: string): number {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360;
  return h;
}

function avatar(p: PrPerson | null, size: number): HTMLElement {
  const wrap = el("span", "prl-avatar");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.setProperty("--prl-avatar", `${size}px`);
  const login = p?.login ?? "ghost";
  const initial = el("span", "prl-avatar-initial", (login.replace(/^\W+/, "")[0] ?? "?").toUpperCase());
  initial.style.setProperty("--prl-hue", String(hueOf(login)));
  wrap.appendChild(initial);
  const src = avatarSrc(p?.avatarUrl);
  if (src) {
    const img = el("img", "prl-avatar-img");
    img.alt = "";
    img.src = src;
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.dataset.key = `img-${src}`;
    wrap.appendChild(img);
  }
  return wrap;
}

/** "you" for the signed-in person, "@login" for anyone else. */
function whoWord(value: string, viewer: string | undefined): string {
  if (value === "@me") return "you";
  if (value === NO_ONE) return "no one";
  const login = value.replace(/^@/, "");
  return viewer && login.toLowerCase() === viewer.toLowerCase() ? "you" : `@${login}`;
}

function filterWord(facet: PrFacet, value: string, viewer: string | undefined): string {
  return facet === "label" ? value : whoWord(value, viewer);
}

function activeFacets(f: PrListFilters): PrFacet[] {
  return PR_FACETS.filter((k) => typeof f[k] === "string" && (f[k] as string).length > 0);
}

// ── Menus ────────────────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  icon?: string;
  /** A person's avatar or a label's swatch, in place of an icon. */
  lead?: HTMLElement;
  detail?: string;
  /** The detail on a line of its own, under the label (a long name and why it is offered). */
  stacked?: boolean;
  /** Opens a submenu (drawn with a chevron). */
  drill?: boolean;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

interface MenuSpec {
  /** Read out as the menu's name. */
  label: string;
  items: MenuItem[];
  /** A back row at the top, for a submenu. */
  back?: { label: string; run: () => void };
  /** The submenu's name, under its back row. */
  heading?: string;
  /** A filter box over the items, for a long list. */
  filter?: { placeholder: string; onInput: (text: string) => void; value: string; onEnter?: (text: string) => void };
  /** Said when there are no items. */
  empty?: string;
}

// ── The component ────────────────────────────────────────────────────────────

export class PullRequestList {
  private state: PrListViewState | undefined;
  private readonly view: HTMLElement;
  private readonly layer: HTMLElement;
  /** The row that holds the keyboard (roving tabindex), by number. */
  private active: number | undefined;
  private searchTimer: number | undefined;
  /** The search box's words while typing outruns the host. */
  private typed: string | undefined;
  /** The search box's placeholder, as last fitted to its width. */
  private placeholder = SEARCH_PLACEHOLDERS[0];
  private measure: CanvasRenderingContext2D | null | undefined;
  private menu: { anchor: HTMLElement; spec: () => MenuSpec; el: HTMLElement; at?: { x: number; y: number } } | undefined;
  private readonly timers: PrListTimers;
  private moreObserver: IntersectionObserver | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: PullRequestListOptions,
  ) {
    this.timers = opts.timers ?? {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (id) => window.clearTimeout(id),
    };
    this.view = el("div", "prl");
    this.view.setAttribute("role", "region");
    this.view.setAttribute("aria-label", "Pull requests");
    this.layer = el("div", "prl-layer");
    this.root.append(this.view, this.layer);
    this.view.addEventListener("click", (e) => this.onClick(e));
    this.view.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.view.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.view.addEventListener("input", (e) => this.onInput(e));
    this.view.addEventListener("focusin", (e) => this.onFocusIn(e));
    // A broken avatar gives way to the initials beneath it.
    this.view.addEventListener(
      "error",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLImageElement && t.classList.contains("prl-avatar-img")) t.closest(".prl-avatar")?.classList.add("is-broken");
      },
      true,
    );
    this.layer.addEventListener("keydown", (e) => this.onMenuKey(e));
    document.addEventListener("mousedown", (e) => {
      if (this.menu && !this.menu.el.contains(e.target as Node) && !this.menu.anchor.contains(e.target as Node)) this.closeMenu(false);
    });
    window.addEventListener("blur", () => this.closeMenu(false));
    window.addEventListener("resize", () => {
      this.closeMenu(false);
      this.fitSearch();
    });
    // The sidebar (a webview: its window) or the desktop's panel narrowed or
    // widened: the search box's words, fitted again.
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.fitSearch()).observe(this.view);
    // The list scrolled from under an open menu: its anchor has moved away.
    // (A long menu scrolling its own items is not that.)
    window.addEventListener(
      "scroll",
      (e) => {
        if (this.menu && !this.menu.el.contains(e.target as Node)) this.closeMenu(false);
      },
      true,
    );
    opts.post({ type: "ready" });
  }

  /** Paint a state from the host. An older one than on screen is ignored. */
  render(state: PrListViewState): void {
    if (this.state && state.seq < this.state.seq) return;
    const prev = this.state;
    this.state = state;
    if (this.typed !== undefined && (state.filters.text ?? "") === this.typed) this.typed = undefined;
    if (this.active !== undefined && !state.rows.some((r) => r.number === this.active)) this.active = undefined;
    const fresh = el("div");
    this.build(fresh, state);
    patchChildren(this.view, fresh);
    this.syncSearchBox(prev);
    this.fitSearch();
    this.watchMore();
    if (this.menu) {
      // The patch keeps the anchor's node but not an attribute the build
      // didn't write.
      this.menu.anchor.setAttribute("aria-expanded", "true");
      this.redrawMenu();
    }
  }

  // ── Building ───────────────────────────────────────────────────────────────

  private build(into: HTMLElement, s: PrListViewState): void {
    const progress = el("div", `prl-progress${s.refreshing || (s.status === "list" && s.loadingMore) ? " is-on" : ""}`);
    progress.setAttribute("aria-hidden", "true");
    progress.appendChild(el("span", "prl-progress-bar"));
    into.appendChild(progress);

    if (s.status === "message" && s.message) {
      // Nothing to list: no header to operate, just why and what to do.
      if (s.targets.length > 1) into.appendChild(this.buildHead(s, true));
      into.appendChild(this.buildMessage(s.message, "prl-message", "message"));
      return;
    }
    into.appendChild(this.buildHead(s, false));
    if (s.notice) into.appendChild(this.buildMessage(s.notice, "prl-notice", "notice"));
    if (s.status === "loading") {
      into.appendChild(this.buildSkeleton());
      return;
    }
    if (s.rows.length === 0) {
      into.appendChild(this.buildEmpty(s));
      return;
    }
    const list = el("ul", "prl-list");
    list.setAttribute("aria-label", `${PR_LIST_STATE_WORDS[s.segment]} pull requests`);
    const activeNumber = this.active ?? s.rows[0]?.number;
    for (const row of s.rows) list.appendChild(this.buildRow(row, s, row.number === activeNumber));
    into.appendChild(list);
    into.appendChild(this.buildMore(s));
  }

  private buildHead(s: PrListViewState, targetOnly: boolean): HTMLElement {
    const head = el("div", "prl-head");
    if (s.targets.length > 1) {
      const t = s.targets.find((x) => x.id === s.target) ?? s.targets[0];
      const b = button("prl-target", "target", "target");
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-label", `Showing the pull requests of ${t.id}. Choose another repository`);
      b.title = `Showing ${t.id} (${t.detail}). Choose another repository`;
      b.append(codicon("repo"), el("span", "prl-target-name", t.id), el("span", "prl-target-detail", t.detail), codicon("chevron-down", "prl-target-chevron"));
      head.appendChild(b);
    }
    if (targetOnly) return head;

    const seg = el("div", "prl-seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Which pull requests");
    for (const st of PR_LIST_STATES) {
      const on = st === s.segment;
      const b = button("prl-seg-btn", `seg-${st}`, "segment");
      b.dataset.value = st;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      const word = PR_LIST_STATE_WORDS[st];
      b.appendChild(el("span", "prl-seg-word", word));
      const count = el("span", "prl-seg-count");
      if (s.counts) {
        const n = countFor(s.counts, st);
        // All is the other three together: its count is said, not drawn.
        if (st !== "all") count.textContent = compactCount(n);
        const filtered = activeFacets(s.filters).length > 0 || !!s.filters.text?.trim();
        b.title = `${n.toLocaleString("en-US")} ${word.toLowerCase()} pull request${n === 1 ? "" : "s"}${filtered ? " matching the filters" : ""}`;
        b.setAttribute("aria-label", `${word}, ${n.toLocaleString("en-US")}`);
      } else {
        b.title = `${word} pull requests`;
        b.setAttribute("aria-label", word);
      }
      count.setAttribute("aria-hidden", "true");
      b.appendChild(count);
      seg.appendChild(b);
    }
    head.appendChild(seg);

    const tools = el("div", "prl-tools");
    const search = el("div", "prl-search");
    search.appendChild(codicon("search", "prl-search-icon"));
    const input = el("input", "prl-search-input");
    input.type = "search";
    input.dataset.key = "search";
    input.placeholder = this.placeholder;
    input.setAttribute("aria-label", "Search pull requests");
    input.spellcheck = false;
    search.appendChild(input);
    const text = this.typed ?? s.filters.text ?? "";
    const clear = button("prl-icon-btn prl-search-clear", "search-clear", "search-clear");
    clear.title = "Clear the search";
    clear.setAttribute("aria-label", "Clear the search");
    clear.hidden = text.length === 0;
    clear.appendChild(codicon("close"));
    search.appendChild(clear);
    tools.appendChild(search);

    const n = activeFacets(s.filters).length;
    const filter = button(`prl-filter-btn${n > 0 ? " is-active" : ""}`, "filter", "filter");
    filter.setAttribute("aria-haspopup", "menu");
    filter.title = n > 0 ? `Filter by author, review requested, assignee or label (${n} on)` : "Filter by author, review requested, assignee or label";
    filter.setAttribute("aria-label", n > 0 ? `Filter, ${n} on` : "Filter");
    filter.append(codicon("filter"), el("span", "prl-filter-word", "Filter"));
    if (n > 0) filter.appendChild(el("span", "prl-badge", String(n)));
    tools.appendChild(filter);
    head.appendChild(tools);

    const facets = activeFacets(s.filters);
    if (facets.length > 0) {
      const chips = el("div", "prl-chips");
      chips.setAttribute("aria-label", "Filters on");
      for (const k of facets) {
        const value = s.filters[k] as string;
        const chip = el("span", "prl-chip");
        chip.dataset.key = `chip-${k}`;
        const words = `${PR_FACET_WORDS[k]}: ${filterWord(k, value, s.viewer?.login)}`;
        chip.appendChild(el("span", "prl-chip-text", words));
        chip.title = words;
        const x = button("prl-icon-btn prl-chip-x", `chip-x-${k}`, "remove-filter");
        x.dataset.value = k;
        x.title = `Remove the ${PR_FACET_WORDS[k]} filter`;
        x.setAttribute("aria-label", `Remove the ${PR_FACET_WORDS[k]} filter (${filterWord(k, value, s.viewer?.login)})`);
        x.appendChild(codicon("close"));
        chip.appendChild(x);
        chips.appendChild(chip);
      }
      const all = button("prl-link", "clear-filters", "clear-filters");
      all.textContent = "Clear filters";
      all.title = "Remove every filter";
      chips.appendChild(all);
      head.appendChild(chips);
    }
    return head;
  }

  private buildMessage(m: PrListMessage, cls: string, key: string): HTMLElement {
    const box = el("div", `${cls} tone-${m.tone}`);
    box.dataset.key = `${key}-${m.title}`;
    box.setAttribute("role", m.tone === "error" ? "alert" : "status");
    const icon = el("span", `${cls}-icon`);
    icon.appendChild(codicon(m.icon));
    box.appendChild(icon);
    const body = el("div", `${cls}-body`);
    body.appendChild(el("div", `${cls}-title`, m.title));
    if (m.detail) body.appendChild(el("div", `${cls}-detail`, m.detail));
    if (m.buttons.length > 0) {
      const row = el("div", `${cls}-buttons`);
      m.buttons.forEach((b, i) => row.appendChild(this.actionButton(b, `${key}-btn-${i}`)));
      body.appendChild(row);
    }
    box.appendChild(body);
    return box;
  }

  private actionButton(b: PrListButton, key: string): HTMLButtonElement {
    const btn = button(`gs-btn prl-btn${b.primary ? " gs-btn--primary" : ""}`, key, "action");
    BUTTON_ACTIONS.set(btn, b.action);
    if (b.icon) btn.appendChild(codicon(b.icon));
    btn.appendChild(el("span", "", b.label));
    if (b.title) btn.title = b.title;
    return btn;
  }

  private buildSkeleton(): HTMLElement {
    const list = el("ul", "prl-list prl-skeleton");
    list.setAttribute("aria-busy", "true");
    list.setAttribute("aria-label", "Loading pull requests");
    for (let i = 0; i < 5; i++) {
      const li = el("li", "prl-row prl-row-skeleton");
      li.dataset.key = `skeleton-${i}`;
      const main = el("div", "prl-row-main");
      main.append(el("span", "prl-sk prl-sk-lead"), el("span", "prl-sk prl-sk-title"), el("span", "prl-sk prl-sk-age"));
      main.append(el("span", "prl-sk prl-sk-meta"), el("span", "prl-sk prl-sk-status"));
      li.appendChild(main);
      list.appendChild(li);
    }
    return list;
  }

  private buildEmpty(s: PrListViewState): HTMLElement {
    const filtered = activeFacets(s.filters).length > 0 || !!(s.filters.text ?? "").trim();
    const copy: Record<PrListState, { title: string; detail: string; icon: string }> = {
      open: { title: "No open pull requests", detail: "Nothing is waiting to be reviewed or merged.", icon: PR_STATES.open.codicon },
      merged: { title: "No merged pull requests", detail: "Merged pull requests show here once some land.", icon: PR_STATES.merged.codicon },
      closed: { title: "No closed pull requests", detail: "Pull requests closed without merging show here.", icon: PR_STATES.closed.codicon },
      all: { title: "No pull requests yet", detail: "Open the first one to propose a change.", icon: PR_STATES.open.codicon },
    };
    const c = copy[s.segment];
    const buttons: PrListButton[] = [];
    if (filtered) {
      buttons.push({ label: "Clear filters", icon: "clear-all", action: { kind: "clearFilters" }, title: "Remove the search and every filter" });
    } else if (s.segment === "open" || s.segment === "all") {
      buttons.push({ label: PR_ACTIONS.newPullRequest.label, icon: PR_ACTIONS.newPullRequest.icon, action: { kind: "createPr" }, title: "Open a pull request — from the branch checked out, or any other" });
    }
    return this.buildMessage(
      filtered
        ? {
            icon: "search",
            tone: "info",
            title: `No ${s.segment === "all" ? "" : `${PR_LIST_STATE_WORDS[s.segment].toLowerCase()} `}pull requests match`,
            detail: (s.filters.text ?? "").trim() ? `Nothing matches “${(s.filters.text ?? "").trim()}” with these filters.` : "Nothing matches these filters.",
            buttons,
          }
        : { icon: c.icon, tone: "info", title: c.title, detail: c.detail, buttons },
      "prl-empty",
      `empty-${s.segment}`,
    );
  }

  private buildRow(r: PrRowView, s: PrListViewState, active: boolean): HTMLElement {
    const li = el("li", `prl-row${r.checkedOut ? " is-checked-out" : ""}`);
    li.dataset.key = `pr-${r.number}`;
    li.dataset.number = String(r.number);

    const kind = PR_STATES[r.kind];
    const main = button("prl-row-main", `open-${r.number}`, "open");
    main.dataset.number = String(r.number);
    main.tabIndex = active ? 0 : -1;
    // A title the row cut short is read whole on hover.
    main.title = `#${r.number} ${r.title}`;

    // Line 1: the state's glyph, the title, how long since it changed.
    const lead = el("span", `prl-lead tone-${kind.tone}`);
    lead.appendChild(codicon(kind.codicon));
    lead.title = kind.word;
    main.appendChild(lead);
    main.appendChild(el("span", "prl-title", r.title));
    const updated = ageWords(r.updatedAt, s.now);
    const words: string[] = [];
    if (r.checkedOut) {
      // The branch checked out here: said where the eye starts, in place of
      // the age (which its title keeps).
      const c = el("span", "prl-pill is-current prl-corner", "Checked out");
      c.title = `This pull request's branch is the one checked out here. Updated ${updated}`;
      main.appendChild(c);
      words.push("checked out here");
    } else {
      const age = el("span", "prl-age prl-corner", shortAge(r.updatedAt, s.now));
      age.title = `Updated ${updated}`;
      main.appendChild(age);
    }

    // Line 2: which one, whose, and from where into where.
    const meta = el("span", "prl-meta");
    meta.appendChild(el("span", "prl-num", `#${r.number}`));
    meta.appendChild(el("span", "prl-dot", "·"));
    const who = el("span", "prl-who");
    who.appendChild(avatar(r.author, 14));
    who.appendChild(el("span", "prl-author", r.author?.login ?? "ghost"));
    meta.appendChild(who);
    meta.appendChild(el("span", "prl-dot", "·"));
    const branch = el("span", "prl-branch");
    const head = r.isFork && r.headOwner ? `${r.headOwner}:${r.headRef}` : r.headRef;
    // A fork's branch says so: someone else's code through your CI.
    if (r.isFork) branch.appendChild(codicon("repo-forked", "prl-branch-fork"));
    branch.append(el("span", "prl-branch-head", head), codicon("arrow-small-right", "prl-branch-arrow"), el("span", "prl-branch-base", r.baseRef));
    branch.title = r.isFork
      ? `Merges ${r.headRef} from ${r.headRepo ?? "a fork that was deleted"} into ${r.baseRef}`
      : `Merges ${head} into ${r.baseRef}`;
    meta.appendChild(branch);
    main.appendChild(meta);

    // Line 3: what it is waiting on — draft, checks, reviews, talk — then
    // its labels. One line: whatever does not fit is left out whole (the
    // row's accessible name still says it), never cut in half.
    const chips = el("span", "prl-status");
    if (r.draft && r.kind !== "closed" && r.kind !== "merged") {
      const d = el("span", "prl-pill is-draft", "Draft");
      d.title = "A draft: not ready for review, and GitHub won't merge it yet";
      chips.appendChild(d);
    }
    if (r.ci.state !== "none") {
      const ci = CI_STATES[r.ci.state];
      const c = el("span", `prl-stat is-ci tone-${ci.tone}`);
      c.append(codicon(ci.codicon, "prl-stat-icon"), el("span", "prl-stat-word", ci.short));
      c.title = ciWords(r.ci);
      chips.appendChild(c);
      words.push(ciWords(r.ci).toLowerCase());
    }
    if (r.reviewDecision && r.kind !== "merged" && r.kind !== "closed") {
      const d = REVIEW_DECISIONS[r.reviewDecision];
      const c = el("span", `prl-stat tone-${d.tone}`);
      c.append(codicon(d.codicon, "prl-stat-icon"), el("span", "prl-stat-word", d.word));
      c.title = `Reviews: ${d.word.toLowerCase()}`;
      chips.appendChild(c);
      words.push(d.word.toLowerCase());
    }
    if (r.comments > 0) {
      const c = el("span", "prl-stat tone-muted");
      c.append(codicon("comment", "prl-stat-icon"), el("span", "prl-stat-word", String(r.comments)));
      c.title = `${r.comments} comment${r.comments === 1 ? "" : "s"}`;
      chips.appendChild(c);
      words.push(c.title);
    }
    if (r.isFork) words.push(r.headRepo ? `from the fork ${r.headRepo}` : "from a deleted fork");
    for (const l of r.labels) {
      const c = el("span", "prl-label", l.name);
      c.style.setProperty("--prl-label", `#${l.color}`);
      c.title = `Label: ${l.name}`;
      chips.appendChild(c);
    }
    if (r.labels.length > 0) words.push(`labels ${r.labels.map((l) => l.name).join(", ")}`);
    if (chips.childNodes.length > 0) main.appendChild(chips);

    main.setAttribute(
      "aria-label",
      [
        `Pull request #${r.number}: ${r.title}`,
        kind.word.toLowerCase(),
        `by ${r.author?.login ?? "a deleted account"}`,
        `${head} into ${r.baseRef}`,
        ...words,
        `updated ${updated}`,
      ].join(", "),
    );
    li.appendChild(main);

    // The row's own actions: on hover and on focus, over the row's right end.
    const actions = el("span", "prl-row-actions");
    const co = button("prl-icon-btn", `checkout-${r.number}`, "checkout");
    co.dataset.number = String(r.number);
    co.tabIndex = active ? 0 : -1;
    co.title = r.checkedOut ? `${PR_ACTIONS.checkout.label} — update it to the pull request's latest` : `${PR_ACTIONS.checkout.label} — ${PR_ACTIONS.checkout.title.charAt(0).toLowerCase()}${PR_ACTIONS.checkout.title.slice(1)}`;
    co.setAttribute("aria-label", `Checkout pull request #${r.number}`);
    co.appendChild(codicon(PR_ACTIONS.checkout.icon));
    const gh = button("prl-icon-btn", `github-${r.number}`, "github");
    gh.dataset.number = String(r.number);
    gh.tabIndex = active ? 0 : -1;
    gh.title = PR_ACTIONS.openOnGitHub.label;
    gh.setAttribute("aria-label", `Open pull request #${r.number} on GitHub`);
    gh.appendChild(codicon("link-external"));
    const more = button("prl-icon-btn", `more-${r.number}`, "more");
    more.dataset.number = String(r.number);
    more.tabIndex = active ? 0 : -1;
    more.title = PR_ACTIONS.more.label;
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", `More actions for pull request #${r.number}`);
    more.appendChild(codicon("ellipsis"));
    actions.append(co, gh, more);
    li.appendChild(actions);
    return li;
  }

  private buildMore(s: PrListViewState): HTMLElement {
    const box = el("div", "prl-more");
    box.dataset.key = "more";
    const shown = s.rows.length;
    const said = el("span", "prl-more-count", s.hasMore ? `${shown.toLocaleString("en-US")} of ${s.total.toLocaleString("en-US")}` : `${shown.toLocaleString("en-US")} pull request${shown === 1 ? "" : "s"}`);
    box.appendChild(said);
    if (s.hasMore) {
      const b = button("gs-btn prl-btn prl-more-btn", "load-more", "load-more");
      b.disabled = s.loadingMore;
      b.appendChild(el("span", "", s.loadingMore ? "Loading…" : "Load more"));
      b.title = `Show the next pull requests (${shown.toLocaleString("en-US")} of ${s.total.toLocaleString("en-US")} shown)`;
      box.appendChild(b);
    }
    return box;
  }

  // ── The search box ─────────────────────────────────────────────────────────

  private searchInput(): HTMLInputElement | null {
    return this.view.querySelector<HTMLInputElement>(".prl-search-input");
  }

  /** The box shows the host's words unless the user is typing ahead of them. */
  /**
   * The longest placeholder the search box shows whole: "Search pull
   * requests", "Search" in a narrow sidebar — never words cut mid-way (its
   * accessible name keeps them all). Measured in the box's own font.
   */
  private fitSearch(): void {
    const input = this.searchInput();
    if (!input) return;
    const room = input.clientWidth;
    if (room <= 0) return; // not laid out: kept as it is
    this.measure ??= document.createElement("canvas").getContext("2d");
    const ctx = this.measure;
    if (!ctx) return;
    ctx.font = getComputedStyle(input).font;
    const want = SEARCH_PLACEHOLDERS.find((p) => ctx.measureText(p).width <= room) ?? "";
    this.placeholder = want;
    if (input.placeholder !== want) input.placeholder = want;
  }

  private syncSearchBox(prev: PrListViewState | undefined): void {
    const input = this.searchInput();
    if (!input || !this.state) return;
    const want = this.typed ?? this.state.filters.text ?? "";
    if (input.value !== want && (document.activeElement !== input || prev?.filters.text !== this.state.filters.text)) {
      input.value = want;
    }
    const clear = this.view.querySelector<HTMLElement>(".prl-search-clear");
    if (clear) clear.hidden = input.value.length === 0;
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains("prl-search-input")) return;
    this.typed = t.value;
    const clear = this.view.querySelector<HTMLElement>(".prl-search-clear");
    if (clear) clear.hidden = t.value.length === 0;
    this.fitSearch();
    if (this.searchTimer !== undefined) this.timers.clear(this.searchTimer);
    const send = () => {
      this.searchTimer = undefined;
      this.sendFilters({ ...(this.state?.filters ?? {}), text: this.typed ?? "" });
    };
    const delay = this.opts.searchDelayMs ?? 300;
    if (delay <= 0) send();
    else this.searchTimer = this.timers.set(send, delay);
  }

  private sendFilters(filters: PrListFilters): void {
    const clean: PrListFilters = {};
    for (const [k, v] of Object.entries(filters) as [keyof PrListFilters, string | undefined][]) {
      if (typeof v === "string" && v.length > 0) clean[k] = v;
    }
    this.opts.post({ type: "filters", filters: clean });
  }

  private setFacet(facet: PrFacet, value: string | undefined): void {
    const next: PrListFilters = { ...(this.state?.filters ?? {}), text: this.typed ?? this.state?.filters.text };
    if (value) next[facet] = value;
    else delete next[facet];
    this.sendFilters(next);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private numberOf(t: HTMLElement): number | undefined {
    const n = Number(t.closest<HTMLElement>("[data-number]")?.dataset.number);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t || !this.view.contains(t)) return;
    const act = t.dataset.act;
    const n = this.numberOf(t);
    // A menu's own button closes it again.
    if (this.menu?.anchor === t && (act === "more" || act === "filter" || act === "target")) {
      this.closeMenu(true);
      return;
    }
    switch (act) {
      case "open":
        if (n !== undefined) this.opts.post({ type: "open", number: n });
        return;
      case "checkout":
        if (n !== undefined) this.opts.post({ type: "checkout", number: n });
        return;
      case "github":
        if (n !== undefined) this.opts.post({ type: "openOnGitHub", number: n });
        return;
      case "more":
        if (n !== undefined) this.openRowMenu(n, t);
        return;
      case "segment": {
        const v = t.dataset.value as PrListState;
        if (v && v !== this.state?.segment) this.opts.post({ type: "segment", segment: v });
        return;
      }
      case "search-clear": {
        const input = this.searchInput();
        if (input) input.value = "";
        this.typed = "";
        if (this.searchTimer !== undefined) this.timers.clear(this.searchTimer);
        this.searchTimer = undefined;
        this.sendFilters({ ...(this.state?.filters ?? {}), text: "" });
        input?.focus();
        return;
      }
      case "filter":
        this.openFilterMenu(t);
        return;
      case "remove-filter":
        this.setFacet(t.dataset.value as PrFacet, undefined);
        return;
      case "clear-filters":
        this.clearAll();
        return;
      case "target":
        this.openTargetMenu(t);
        return;
      case "load-more":
        if (this.state?.hasMore && !this.state.loadingMore) this.opts.post({ type: "loadMore" });
        return;
      case "action": {
        const action = BUTTON_ACTIONS.get(t);
        if (!action) return;
        if (action.kind === "clearFilters") this.clearAll();
        else this.opts.post({ type: "action", action });
        return;
      }
    }
  }

  private clearAll(): void {
    this.typed = "";
    const input = this.searchInput();
    if (input) input.value = "";
    this.sendFilters({});
  }

  private rowMains(): HTMLElement[] {
    return [...this.view.querySelectorAll<HTMLElement>(".prl-row-main")];
  }

  private focusRow(n: number): void {
    this.active = n;
    for (const row of this.view.querySelectorAll<HTMLElement>(".prl-row")) {
      const on = Number(row.dataset.number) === n;
      for (const b of row.querySelectorAll<HTMLElement>("button")) b.tabIndex = on ? 0 : -1;
    }
    const main = this.view.querySelector<HTMLElement>(`.prl-row[data-number="${n}"] .prl-row-main`);
    main?.focus();
    main?.scrollIntoView({ block: "nearest" });
  }

  private onFocusIn(e: FocusEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".prl-row");
    const n = Number(row?.dataset.number);
    if (row && Number.isSafeInteger(n) && n > 0 && n !== this.active) {
      this.active = n;
      for (const r of this.view.querySelectorAll<HTMLElement>(".prl-row")) {
        const on = r === row;
        for (const b of r.querySelectorAll<HTMLElement>("button")) b.tabIndex = on ? 0 : -1;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    // The segments: arrows move the choice, as a radio group does.
    if (t.classList.contains("prl-seg-btn") && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const all = [...this.view.querySelectorAll<HTMLElement>(".prl-seg-btn")];
      const i = all.indexOf(t);
      const j = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
      all[j]?.focus();
      all[j]?.click();
      return;
    }
    if (t.classList.contains("prl-search-input")) {
      if (e.key === "ArrowDown") {
        const first = this.state?.rows[0]?.number;
        if (first !== undefined) {
          e.preventDefault();
          this.focusRow(this.active ?? first);
        }
      } else if (e.key === "Escape" && t instanceof HTMLInputElement && t.value) {
        e.preventDefault();
        (this.view.querySelector(".prl-search-clear") as HTMLElement | null)?.click();
      }
      return;
    }
    const row = t.closest<HTMLElement>(".prl-row");
    if (!row || !this.state) return;
    const n = Number(row.dataset.number);
    const numbers = this.state.rows.map((r) => r.number);
    const i = numbers.indexOf(n);
    if (i < 0) return;
    const go = (j: number) => {
      e.preventDefault();
      this.focusRow(numbers[Math.max(0, Math.min(numbers.length - 1, j))]);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        if (i === 0) {
          e.preventDefault();
          this.searchInput()?.focus();
          return;
        }
        return go(i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(numbers.length - 1);
      case "PageDown":
        return go(i + 10);
      case "PageUp":
        return go(i - 10);
      case "ContextMenu":
        e.preventDefault();
        this.openRowMenu(n, row.querySelector<HTMLElement>(".prl-row-main") ?? row);
        return;
      case "F10":
        if (e.shiftKey) {
          e.preventDefault();
          this.openRowMenu(n, row.querySelector<HTMLElement>(".prl-row-main") ?? row);
        }
        return;
    }
  }

  private onContextMenu(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".prl-row");
    const n = Number(row?.dataset.number);
    if (!row || !Number.isSafeInteger(n) || row.classList.contains("prl-row-skeleton")) return;
    e.preventDefault();
    this.openRowMenu(n, row.querySelector<HTMLElement>(".prl-row-main") ?? row, { x: e.clientX, y: e.clientY });
  }

  // ── Menus ──────────────────────────────────────────────────────────────────

  private openRowMenu(n: number, anchor: HTMLElement, at?: { x: number; y: number }): void {
    const row = this.state?.rows.find((r) => r.number === n);
    if (!row) return;
    const open = row.kind === "open" || row.kind === "draft";
    this.openMenu(anchor, () => ({
      label: `Pull request #${n}`,
      items: [
        { label: "Open", icon: PR_STATES[row.kind].codicon, detail: "The pull request's page", run: () => this.opts.post({ type: "open", number: n }) },
        {
          label: PR_ACTIONS.checkout.label,
          icon: PR_ACTIONS.checkout.icon,
          detail: row.checkedOut ? "Update it to the latest" : `${row.isFork && row.headOwner ? `${row.headOwner}:` : ""}${row.headRef}`,
          run: () => this.opts.post({ type: "checkout", number: n }),
        },
        // Only what can apply: a closed pull request takes no review, and
        // GitHub merges neither a closed one nor a draft.
        ...(open ? [{ label: PR_ACTIONS.review.label, icon: PR_ACTIONS.review.icon, detail: "Start your review", run: () => this.opts.post({ type: "startReview", number: n }) }] : []),
        ...(row.kind === "open" ? [{ label: PR_ACTIONS.merge.label, icon: PR_ACTIONS.merge.icon, detail: `Into ${row.baseRef}`, run: () => this.opts.post({ type: "merge", number: n }) }] : []),
        { label: PR_ACTIONS.openOnGitHub.label, icon: PR_ACTIONS.openOnGitHub.icon, run: () => this.opts.post({ type: "openOnGitHub", number: n }) },
        { label: PR_ACTIONS.copyLink.label, icon: PR_ACTIONS.copyLink.icon, run: () => this.opts.post({ type: "copyLink", number: n }) },
      ],
    }), at);
  }

  private openTargetMenu(anchor: HTMLElement): void {
    this.openMenu(anchor, () => {
      const s = this.state;
      return {
        label: "Show the pull requests of",
        items: (s?.targets ?? []).map((t) => ({
          label: t.id,
          icon: "repo",
          detail: t.detail,
          stacked: true,
          checked: t.id === s?.target,
          run: () => {
            if (t.id !== s?.target) this.opts.post({ type: "target", id: t.id });
          },
        })),
      };
    });
  }

  /** The filter menu drills into each facet, the way the branch menu drills into a branch. */
  private openFilterMenu(anchor: HTMLElement, facet?: PrFacet): void {
    let query = "";
    const top = (): MenuSpec => {
      const f = this.state?.filters ?? {};
      return {
        label: "Filter pull requests",
        items: PR_FACETS.map((k) => ({
          label: PR_FACET_WORDS[k],
          icon: { author: "account", reviewRequested: "eye", assignee: "person", label: "tag" }[k],
          detail: f[k] ? filterWord(k, f[k] as string, this.state?.viewer?.login) : k === "label" ? "Any" : "Anyone",
          drill: true,
          run: () => {
            query = "";
            this.swapMenu(() => sub(k));
          },
        })),
      };
    };
    const sub = (k: PrFacet): MenuSpec => {
      const s = this.state;
      const current = s?.filters[k];
      const viewer = s?.viewer?.login;
      const items: MenuItem[] = [];
      const pick = (value: string | undefined) => () => {
        this.closeMenu(true);
        this.setFacet(k, value);
      };
      const q = query.trim().toLowerCase();
      if (!q) items.push({ label: k === "label" ? "Any label" : "Anyone", icon: "circle-slash", checked: !current, run: pick(undefined) });
      if (k === "label") {
        if (!s?.facetOptions && !s?.facetOptionsLoading) this.opts.post({ type: "facetOptions" });
        for (const l of s?.facetOptions?.labels ?? []) {
          if (q && !l.name.toLowerCase().includes(q)) continue;
          const sw = el("span", "prl-swatch");
          sw.style.setProperty("--prl-label", `#${l.color}`);
          items.push({ label: l.name, lead: sw, checked: current === l.name, run: pick(l.name) });
        }
      } else {
        if (!q || "you".includes(q) || (viewer ?? "").toLowerCase().includes(q)) {
          items.push({ label: viewer ? `You (@${viewer})` : "You", lead: avatar(s?.viewer ?? null, 16), checked: current === "@me", run: pick("@me") });
        }
        if (k === "assignee" && (!q || "no one".includes(q))) {
          items.push({ label: "No one", icon: "circle-slash", detail: "Not assigned", checked: current === NO_ONE, run: pick(NO_ONE) });
        }
        if (!s?.facetOptions && !s?.facetOptionsLoading) this.opts.post({ type: "facetOptions" });
        for (const p of this.peopleFor(k)) {
          if (viewer && p.login.toLowerCase() === viewer.toLowerCase()) continue;
          if (q && !p.login.toLowerCase().includes(q)) continue;
          items.push({ label: `@${p.login}`, lead: avatar(p, 16), checked: current === p.login, run: pick(p.login) });
        }
        const typedLogin = query.trim().replace(/^@/, "");
        if (typedLogin && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(typedLogin) && !items.some((i) => i.label === `@${typedLogin}`)) {
          items.push({ label: `@${typedLogin}`, icon: "account", detail: "Someone not listed", run: pick(typedLogin) });
        }
      }
      return {
        label: PR_FACET_WORDS[k],
        back: { label: "All filters", run: () => this.swapMenu(top) },
        heading: PR_FACET_WORDS[k],
        filter: {
          placeholder: k === "label" ? "Find a label" : "Find someone, or type a login",
          value: query,
          onInput: (text) => {
            query = text;
            this.redrawMenu();
          },
          onEnter: () => {
            const first = this.menu?.el.querySelector<HTMLElement>(".prl-menu-item:not([disabled])");
            first?.click();
          },
        },
        items,
        empty: s?.facetOptionsLoading ? "Loading…" : k === "label" ? "No labels match" : "No one matches",
      };
    };
    this.openMenu(anchor, facet ? () => sub(facet) : top);
  }

  /** Who the person facets offer: the repository's people, then anyone on the rows. */
  private peopleFor(k: PrFacet): PrPerson[] {
    const s = this.state;
    const seen = new Map<string, PrPerson>();
    const add = (p: PrPerson | null | undefined) => {
      if (p && !seen.has(p.login.toLowerCase())) seen.set(p.login.toLowerCase(), p);
    };
    for (const r of s?.rows ?? []) {
      if (k === "author") add(r.author);
      else if (k === "assignee") r.assignees.forEach(add);
      else for (const q of r.reviewRequests) if (q.login) add({ login: q.login, avatarUrl: q.avatarUrl ?? null });
    }
    for (const p of s?.facetOptions?.people ?? []) add(p);
    return [...seen.values()].sort((a, b) => a.login.localeCompare(b.login));
  }

  private openMenu(anchor: HTMLElement, spec: () => MenuSpec, at?: { x: number; y: number }): void {
    this.closeMenu(false);
    const m = el("div", "prl-menu");
    this.menu = { anchor, spec, el: m, at };
    anchor.setAttribute("aria-expanded", "true");
    this.layer.appendChild(m);
    this.drawMenu(true);
  }

  private swapMenu(spec: () => MenuSpec): void {
    if (!this.menu) return;
    this.menu.spec = spec;
    this.drawMenu(true);
  }

  private redrawMenu(): void {
    if (this.menu) this.drawMenu(false);
  }

  private drawMenu(focusFirst: boolean): void {
    const menu = this.menu;
    if (!menu) return;
    const spec = menu.spec();
    const m = menu.el;
    const hadFocus = m.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focusedFilter = hadFocus?.classList.contains("prl-menu-filter") ? (hadFocus as HTMLInputElement) : null;
    const focusedLabel = hadFocus?.dataset.label;
    m.replaceChildren();
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", spec.label);
    if (spec.back) {
      const back = el("button", "prl-menu-item prl-menu-back");
      back.type = "button";
      back.setAttribute("role", "menuitem");
      back.dataset.label = `back:${spec.back.label}`;
      back.append(codicon("chevron-left", "prl-menu-icon"), el("span", "prl-menu-label", spec.back.label));
      back.setAttribute("aria-label", `Back to ${spec.back.label}`);
      const run = spec.back.run;
      back.addEventListener("click", () => run());
      m.appendChild(back);
      m.appendChild(el("div", "prl-menu-sep"));
    }
    if (spec.heading) {
      const h = el("div", "prl-menu-heading", spec.heading);
      h.setAttribute("aria-hidden", "true");
      m.appendChild(h);
    }
    let filterInput: HTMLInputElement | undefined;
    if (spec.filter) {
      const f = spec.filter;
      const input = focusedFilter ?? el("input", "prl-menu-filter");
      input.type = "text";
      input.placeholder = f.placeholder;
      input.setAttribute("aria-label", f.placeholder);
      input.spellcheck = false;
      if (input.value !== f.value) input.value = f.value;
      input.oninput = () => f.onInput(input.value);
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          f.onEnter?.(input.value);
        }
      };
      m.appendChild(input);
      filterInput = input;
    }
    const list = el("div", "prl-menu-items");
    for (const it of spec.items) {
      const b = el("button", `prl-menu-item${it.checked ? " is-checked" : ""}`);
      b.type = "button";
      b.setAttribute("role", it.checked !== undefined ? "menuitemradio" : "menuitem");
      if (it.checked !== undefined) b.setAttribute("aria-checked", it.checked ? "true" : "false");
      b.dataset.label = it.label;
      b.disabled = !!it.disabled;
      const lead = el("span", "prl-menu-icon");
      if (it.lead) lead.appendChild(it.lead);
      else if (it.icon) lead.appendChild(codicon(it.icon));
      b.appendChild(lead);
      if (it.stacked) {
        b.classList.add("is-stacked");
        const text = el("span", "prl-menu-text");
        text.appendChild(el("span", "prl-menu-label", it.label));
        if (it.detail) text.appendChild(el("span", "prl-menu-detail", it.detail));
        b.appendChild(text);
      } else {
        b.appendChild(el("span", "prl-menu-label", it.label));
        if (it.detail) b.appendChild(el("span", "prl-menu-detail", it.detail));
      }
      if (it.drill) b.appendChild(codicon("chevron-right", "prl-menu-chevron"));
      else if (it.checked) b.appendChild(codicon("check", "prl-menu-check"));
      if (it.drill) b.setAttribute("aria-haspopup", "menu");
      const run = it.run;
      b.addEventListener("click", () => {
        if (it.drill) run();
        else {
          this.closeMenu(true);
          run();
        }
      });
      list.appendChild(b);
    }
    if (spec.items.length === 0) list.appendChild(el("div", "prl-menu-empty", spec.empty ?? "Nothing here"));
    m.appendChild(list);
    this.placeMenu();
    if (focusedFilter) focusedFilter.focus();
    else if (focusedLabel) (m.querySelector<HTMLElement>(`[data-label="${CSS.escape(focusedLabel)}"]`) ?? filterInput)?.focus();
    else if (focusFirst) (filterInput ?? m.querySelector<HTMLElement>(".prl-menu-item:not([disabled])"))?.focus();
  }

  private placeMenu(): void {
    const menu = this.menu;
    if (!menu) return;
    const m = menu.el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(280, vw - 16);
    m.style.width = `${width}px`;
    m.style.maxHeight = `${Math.max(120, vh - 16)}px`;
    const r = menu.anchor.getBoundingClientRect();
    let x = menu.at ? menu.at.x : r.left;
    let y = menu.at ? menu.at.y : r.bottom + 4;
    x = Math.max(8, Math.min(x, vw - width - 8));
    const h = m.offsetHeight;
    if (y + h > vh - 8) y = menu.at ? Math.max(8, y - h) : Math.max(8, r.top - h - 4);
    if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
  }

  private closeMenu(returnFocus: boolean): void {
    const menu = this.menu;
    if (!menu) return;
    this.menu = undefined;
    menu.anchor.removeAttribute("aria-expanded");
    menu.el.remove();
    if (returnFocus && menu.anchor.isConnected) menu.anchor.focus();
  }

  private onMenuKey(e: KeyboardEvent): void {
    const menu = this.menu;
    if (!menu) return;
    const items = [...menu.el.querySelectorAll<HTMLElement>(".prl-menu-item:not([disabled])")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const inFilter = (document.activeElement as HTMLElement | null)?.classList.contains("prl-menu-filter");
    const move = (j: number) => {
      e.preventDefault();
      items[(j + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu(true);
        return;
      case "Tab":
        this.closeMenu(true);
        return;
      case "ArrowDown":
        return move(inFilter ? 0 : at + 1);
      case "ArrowUp":
        return move(inFilter ? items.length - 1 : at - 1);
      case "Home":
        if (!inFilter) move(0);
        return;
      case "End":
        if (!inFilter) move(items.length - 1);
        return;
      case "ArrowRight": {
        const cur = document.activeElement as HTMLElement | null;
        if (!inFilter && cur?.getAttribute("aria-haspopup") === "menu") {
          e.preventDefault();
          cur.click();
        }
        return;
      }
      case "ArrowLeft": {
        const back = menu.el.querySelector<HTMLElement>(".prl-menu-back");
        if (!inFilter && back) {
          e.preventDefault();
          back.click();
        }
        return;
      }
    }
  }

  // ── Paging ─────────────────────────────────────────────────────────────────

  /**
   * The next page loads by itself once the end of the list scrolls into
   * sight — once per length of the list: a page that failed to come leaves
   * the button to be pressed, rather than asking GitHub again and again.
   */
  private watchMore(): void {
    if (typeof IntersectionObserver === "undefined") return;
    const more = this.view.querySelector<HTMLElement>(".prl-more-btn");
    this.moreObserver?.disconnect();
    const s = this.state;
    if (!more || !s?.hasMore || s.loadingMore || this.autoAskedAt === s.rows.length) return;
    // The end already in sight as the state is painted: asked now. An
    // observer reports it only on a painted frame, and a view that paints
    // none soon (a busy machine, a throttled webview) left the next page
    // waiting — the observer is for the end scrolling into sight later.
    const r = more.getBoundingClientRect();
    if (r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
      this.autoAskedAt = s.rows.length;
      this.opts.post({ type: "loadMore" });
      return;
    }
    this.moreObserver = new IntersectionObserver((entries) => {
      const now = this.state;
      if (entries.some((x) => x.isIntersecting) && now?.hasMore && !now.loadingMore && this.autoAskedAt !== now.rows.length) {
        this.moreObserver?.disconnect();
        this.autoAskedAt = now.rows.length;
        this.opts.post({ type: "loadMore" });
      }
    });
    this.moreObserver.observe(more);
  }

  /** How long the list was when the end last asked for more by itself. */
  private autoAskedAt: number | undefined;
}
