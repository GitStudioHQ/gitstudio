// Shared scaffolding for the per-section GitHub view modules (releases,
// notifications, orgs, projects, gists, …). Each module exports a `SectionRender`
// and renders into the container it's handed; these helpers give every section
// the same gate, header, two-pane layout, and not-connected prompt so the whole
// app feels like one product.

import { host } from "../bridge";
import { gget } from "../cache";
import { openModal } from "../dialogs";
import {
  cleanErr,
  el,
  errorState,
  glyph,
  span,
  emptyState,
  avatar,
  openMenu,
  type MenuItem,
} from "../ui";
import type { ReactionSummary } from "../../shared/ipc";
import {
  facetActiveCount,
  facetPasses,
  facetServerValues,
  harvestValues,
} from "../facetModel";
import type { FacetOption, FacetSpec, FacetState } from "../facetModel";

// The pure facet rules live in ../facetModel (node-testable); views import
// everything from here so there is still one facet import site.
export { harvestValues };
export type { FacetOption, FacetSpec, FacetState };

/** An item another view asked this section to open on entry (e.g. the project
 *  board opening an issue/PR by number, or a tag detail revealing its commit in
 *  the graph — keeps everything in-app, never GitHub). */
export interface SectionTarget {
  /** The issue / PR number to auto-open in the destination section. */
  number?: number;
  /** A string-keyed item to open (gist id, project id) — the string-shaped
   *  sibling of `number` for sections whose items aren't numbered. */
  id?: string;
  /** A workflow JOB to reveal + expand on the Actions run page (rides along
   *  with `number` = the run id — how PR checks land on their logs). */
  jobId?: number;
  /** A commit to reveal on entry (the Commits view scrolls to + selects it). */
  sha?: string;
  /** A folder for the Code view to open ("" = repo root). Routing every folder
   *  hop through this puts the browser's history behind ⌘[/⌘] too. */
  path?: string;
  /** A ref (branch / remote / tag / stash selector) for the Branches view to
   *  scroll to and flash on entry. */
  ref?: string;
  /** Explicitly route to the section's ROOT (its list page). This is how a
   *  detail page's ← / Esc gets back: routeView's "already showing this view"
   *  no-op would otherwise swallow a target-less same-view navigation. */
  list?: boolean;
}

/** Routes to another sidebar view; pass a target to deep-link a specific item
 *  (e.g. `nav("issues", { number: 142 })` opens issue #142 in the Issues view). */
export type SectionNav = (view: string, target?: SectionTarget) => void;

/**
 * The signature every section view module implements. `wrap` is the section's
 * own container (already mounted); `nav(viewId, target?)` routes to another
 * sidebar view (optionally deep-linking an item). `target` is what THIS section
 * was asked to open on entry. Re-render by clearing `wrap` and rebuilding.
 */
export type SectionRender = (wrap: HTMLElement, nav: SectionNav, target?: SectionTarget) => void;

/** Resolved GitHub connection for a section view. */
export interface GhGate {
  login?: string;
  repo?: { owner: string; repo: string };
}

/**
 * Gate a GitHub section: resolve `github:status`. If not connected, render a
 * "Connect GitHub" prompt (→ Settings) into `wrap` and return null; otherwise
 * return the login + repo. `needsRepo` views (PR/issue scoped) also gate on a
 * github.com origin.
 */
export async function ghGate(
  wrap: HTMLElement,
  nav: (view: string) => void,
  needsRepo = false,
  retry?: () => void,
): Promise<GhGate | null> {
  let status: { connected: boolean; login?: string; repo?: { owner: string; repo: string } };
  try {
    // Cached (12s TTL): a detail-page → list-page hop re-gates the section, and
    // that round trip must never make Back feel like a page load.
    status = await gget("github:status", undefined, 12000);
  } catch (e) {
    // A failed/timed-out status check is an ERROR with a Retry — it used to
    // masquerade as "not connected" (misleading) or, before the client got
    // request timeouts, hang the section on its skeleton forever.
    wrap.replaceChildren(
      errorState("Couldn't reach GitHub", cleanErr(e) || "The request timed out.", retry),
    );
    return null;
  }
  if (!status.connected) {
    wrap.replaceChildren(connectPrompt(nav));
    return null;
  }
  if (needsRepo && !status.repo) {
    // A wall with a WHY and a way out — not a dead end. (This used to say
    // "Not a GitHub repository" even for forks with only an `upstream`
    // remote and for SSH-alias remotes; both resolve now, so reaching this
    // genuinely means no remote points at github.com.)
    wrap.replaceChildren(
      emptyState(
        "No GitHub remote found",
        "None of this repository's remotes point at github.com, so pull requests, issues, and CI can't attach here. Add one (git remote add origin …) and this section lights up on the next visit.",
        { icon: "github", hint: "origin, upstream, and SSH aliases like git@github.com-work:… are all recognized." },
      ),
    );
    return null;
  }
  return { login: status.login, repo: status.repo };
}

/** A centered "sign in from Settings" prompt for the disconnected state. */
export function connectPrompt(nav: (view: string) => void): HTMLElement {
  const wrap = el("div", "list-empty");
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph("github"));
  const t = el("div", "list-empty-title");
  t.textContent = "Connect GitHub";
  const d = el("div", "list-empty-desc");
  d.textContent =
    "Sign in to review and manage pull requests, issues, releases and Actions — without leaving GitStudio.";
  const go = el("button", "btn btn-primary list-empty-action");
  go.append(glyph("github"), span("Sign in with GitHub"));
  go.addEventListener("click", () => nav("settings"));
  wrap.append(badge, t, d, go);
  return wrap;
}

/** The standard GitHub-section header: a title (with an optional live count) on
 *  the left; the signed-in @login + a refresh on the right. Views still insert
 *  their action cluster before `.gh-acct`. `setCount` lets the view update the
 *  pill once its list resolves. */
export function ghHeader(
  title: string,
  login: string | undefined,
  onRefresh: () => void,
  count?: number,
): HTMLElement & { setCount?: (shown: number, total?: number) => void } {
  const headRow = el("div", "list-head list-head-row gh-head") as HTMLElement & {
    setCount?: (shown: number, total?: number) => void;
  };
  const left = el("div", "gh-head-titlewrap");
  const t = el("div", "list-head-title");
  t.textContent = title;
  const countPill = el("span", "gh-head-count");
  if (typeof count === "number") countPill.textContent = String(count);
  else countPill.hidden = true;
  left.append(t, countPill);
  // The badge reports what is ON SCREEN. It used to report the fetched page
  // size and never move, so filtering to two rows still read "8" — and an
  // empty result still read "8" above an empty state. When a filter is
  // narrowing the list, say so: "2 of 8".
  headRow.setCount = (shown: number, total?: number): void => {
    const narrowed = typeof total === "number" && total !== shown;
    countPill.textContent = narrowed ? `${shown} of ${total}` : String(shown);
    countPill.title = narrowed
      ? `${shown} shown of ${total} loaded`
      : `${shown} ${shown === 1 ? "item" : "items"}`;
    countPill.classList.toggle("is-narrowed", narrowed);
    countPill.hidden = false;
  };

  // The account chip lives once in the top bar; `.gh-acct` is the right-side
  // anchor each view inserts its own action cluster (New PR / New Issue / …)
  // before. It carries ONE shared control: a quiet refresh button — with the
  // SWR caches making section data sticky, an explicit "get me fresh data now"
  // affordance is honesty, not clutter.
  void login;
  const right = el("div", "gh-acct");
  const refreshBtn = el("button", "icon-btn gh-refresh");
  refreshBtn.title = "Refresh";
  refreshBtn.setAttribute("aria-label", "Refresh this view");
  refreshBtn.appendChild(glyph("refresh"));
  refreshBtn.addEventListener("click", () => onRefresh());
  right.appendChild(refreshBtn);
  headRow.append(left, right);
  return headRow;
}

/**
 * A header "selector" chip — the bar-level picker the Projects/Orgs views use to
 * choose which project/org fills the pane below. Shows a leading element (icon or
 * avatar), the current selection's name, and a chevron; clicking calls `onOpen`
 * with the button as the anchor (the view opens an `openMenu` of choices there).
 * `set(lead, name)` swaps the displayed lead + label when the selection changes.
 */
export function headerPicker(opts: {
  onOpen: (anchor: HTMLElement) => void;
}): { el: HTMLElement; set: (lead: HTMLElement, name: string) => void } {
  const btn = el("button", "gh-picker");
  btn.setAttribute("aria-haspopup", "menu");
  const leadSlot = el("span", "gh-picker-lead");
  const nameEl = el("span", "gh-picker-name");
  const chev = glyph("chevron-down");
  chev.classList.add("gh-picker-chev");
  btn.append(leadSlot, nameEl, chev);
  btn.addEventListener("click", () => opts.onOpen(btn));
  return {
    el: btn,
    set: (lead: HTMLElement, name: string): void => {
      leadSlot.replaceChildren(lead);
      nameEl.textContent = name;
      btn.title = name;
    },
  };
}

/**
 * A compact header search/filter field: a leading magnifier, a text input, and
 * a clear (×) button that appears once there's text. Input is debounced and
 * trimmed before `onInput` fires; Escape clears. Views own the actual filtering
 * (they know their fields) — this primitive just owns the consistent UI. Drop it
 * into a section header's action cluster.
 */
export function searchField(opts: {
  placeholder: string;
  onInput: (query: string) => void;
  initial?: string;
  /** Debounce for onInput, ms (default 110). Explore's code tab sets a large
   *  value and relies on `onEnter` instead — each code search costs 1/10th of
   *  a minute's budget, so it must be deliberate. */
  debounceMs?: number;
  /** Fired on Enter with the current value. */
  onEnter?: (query: string) => void;
  /** Focus the input as soon as it mounts (search-first pages). */
  autofocus?: boolean;
}): HTMLElement {
  const wrap = el("div", "gh-search");
  const icon = glyph("search");
  icon.classList.add("gh-search-icon");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "gh-search-input";
  input.placeholder = opts.placeholder;
  input.setAttribute("aria-label", opts.placeholder);
  input.spellcheck = false;
  if (opts.initial) input.value = opts.initial;
  const clear = el("button", "gh-search-clear");
  clear.setAttribute("aria-label", "Clear search");
  clear.appendChild(glyph("close"));
  clear.hidden = !input.value;
  let timer = 0;
  const fire = (): void => {
    clear.hidden = !input.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => opts.onInput(input.value.trim()), opts.debounceMs ?? 110);
  };
  input.addEventListener("input", fire);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      fire();
      return;
    }
    if (e.key === "Enter" && opts.onEnter) {
      e.preventDefault();
      window.clearTimeout(timer);
      opts.onEnter(input.value.trim());
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    fire();
    input.focus();
  });
  wrap.append(icon, input, clear);
  if (opts.autofocus) setTimeout(() => input.focus(), 0);
  return wrap;
}

/**
 * A labeled combobox: a free-text input backed by a searchable dropdown of
 * suggestions that filters as you type (↑/↓ to move, Enter to pick, Esc to
 * close, click to pick). The user can still type any value — the list is just
 * an autocomplete. Returns the same `{ row, input }` shape as a plain field so
 * callers read `input.value`.
 */
export function comboField(opts: {
  label: string;
  placeholder: string;
  value?: string;
  options: string[];
  labelClass?: string;
  inputClass?: string;
  rowClass?: string;
}): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", opts.rowClass ?? "gh-dispatch-row");
  const lab = el("label", opts.labelClass ?? "gh-dispatch-label");
  lab.textContent = opts.label;

  const combo = el("div", "gh-combo");
  const input = document.createElement("input");
  input.className = `${opts.inputClass ?? "gh-dispatch-input"} gh-combo-input`;
  input.placeholder = opts.placeholder;
  input.value = opts.value ?? "";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");

  row.append(lab, combo);
  combo.appendChild(input);

  // The dropdown is appended to <body> as a fixed-position popover (NOT nested in
  // the field) so it floats above everything and is never clipped by a scrolling
  // container — and it flips above the input when there's no room below.
  const menu = el("div", "gh-combo-menu");
  menu.setAttribute("role", "listbox");

  let shown: string[] = [];
  let active = -1;
  let isOpen = false;

  const position = (): void => {
    const r = input.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.width = `${Math.round(r.width)}px`;
    const wanted = Math.min(menu.scrollHeight, 244);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    if (below < wanted && above > below) {
      const h = Math.min(wanted, above);
      menu.style.top = `${Math.round(r.top - h - 4)}px`;
      menu.style.maxHeight = `${Math.round(h)}px`;
    } else {
      menu.style.top = `${Math.round(r.bottom + 4)}px`;
      menu.style.maxHeight = `${Math.round(Math.min(244, Math.max(96, below)))}px`;
    }
  };

  const onDoc = (e: MouseEvent): void => {
    if (e.target !== input && !menu.contains(e.target as Node)) close();
  };
  const onScroll = (e: Event): void => {
    if (!menu.contains(e.target as Node)) position(); // ignore the menu's own scroll
  };
  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const setActive = (i: number): void => {
    active = i;
    const items = Array.from(menu.children) as HTMLElement[];
    items.forEach((it, idx) => it.classList.toggle("active", idx === i));
    items[i]?.scrollIntoView({ block: "nearest" });
  };
  const choose = (v: string): void => {
    input.value = v;
    close();
    input.dispatchEvent(new Event("change"));
  };
  const open = (): void => {
    const needle = input.value.trim().toLowerCase();
    shown = (needle
      ? opts.options.filter((o) => o.toLowerCase().includes(needle))
      : opts.options
    ).slice(0, 60);
    menu.replaceChildren();
    if (!shown.length) {
      close();
      return;
    }
    for (const o of shown) {
      const item = el("button", "gh-combo-item");
      (item as HTMLButtonElement).type = "button";
      item.textContent = o;
      item.setAttribute("role", "option");
      // mousedown (not click) + preventDefault so the input doesn't blur first.
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(o);
      });
      menu.appendChild(item);
    }
    if (!isOpen) {
      document.body.appendChild(menu);
      isOpen = true;
      document.addEventListener("mousedown", onDoc, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    }
    input.setAttribute("aria-expanded", "true");
    position();
    setActive(0);
  };

  // Open on click / type / ArrowDown — NOT on focus, so programmatic focus
  // (the form auto-focuses this field) doesn't pop the menu over the form.
  input.addEventListener("click", open);
  input.addEventListener("input", open);
  input.addEventListener("keydown", (e) => {
    if (!isOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(active + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener("blur", () => window.setTimeout(close, 120));

  return { row, input };
}

/**
 * Keep keyboard focus inside a modal `card` while it's open. Call from the
 * dialog's keydown handler on a Tab press; wraps focus from the last focusable
 * element back to the first (and vice-versa with Shift). A no-op for other keys.
 */
export function trapTab(e: KeyboardEvent, card: HTMLElement): void {
  if (e.key !== "Tab") return;
  const focusables = Array.from(
    card.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** A searchable, avatar-rich multi-select people picker (GitHub-style) — shared by
 *  PR reviewers and issue assignees. Returns the chosen logins, or null on cancel. */
export function peoplePickerModal(opts: {
  title: string;
  okLabel: string;
  people: { login: string; avatarUrl?: string | null }[];
  selected?: string[];
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const pre = new Set(opts.selected ?? []);
    openModal((close) => {
      const card = el("div", "modal-card modal-card-form people-picker");
      const h = el("div", "modal-title");
      h.textContent = opts.title;

      const search = document.createElement("input");
      search.className = "modal-input";
      search.placeholder = "Filter people…";
      search.setAttribute("aria-label", "Filter people");

      const list = el("div", "people-list");
      const boxes: { login: string; cb: HTMLInputElement; row: HTMLElement }[] = [];
      for (const p of opts.people) {
        const row = el("label", "people-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = pre.has(p.login);
        row.append(cb, avatar(p.login, p.avatarUrl ?? null, 22), span(p.login, "people-login"));
        list.appendChild(row);
        boxes.push({ login: p.login, cb, row });
      }
      const empty = el("div", "people-empty");
      empty.textContent = "No people match.";
      empty.hidden = true;
      list.appendChild(empty);
      const filter = (): void => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const b of boxes) {
          const ok = !q || b.login.toLowerCase().includes(q);
          b.row.hidden = !ok;
          if (ok) shown++;
        }
        empty.hidden = shown > 0;
      };
      search.addEventListener("input", filter);

      const actions = el("div", "modal-actions");
      const cancel = el("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = el("button", "btn btn-primary modal-ok");
      ok.append(span(opts.okLabel));
      actions.append(cancel, ok);
      card.append(h, search, list, actions);

      cancel.addEventListener("click", close);
      ok.addEventListener("click", () => {
        settled = true;
        resolve(boxes.filter((b) => b.cb.checked).map((b) => b.login));
        close();
      });
      return {
        card,
        focusEl: search,
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}

// ── SECTION PAGES — the list ⇄ detail system (docs/desktop-redesign.md) ──────
// (ghTwoPane / ghListResizer — the old master/detail split — lived here until
// every section converted; the last user disappeared with the Gists rewrite.)
// Full-width list pages and full-page details, replacing the ghTwoPane split
// view by view. `sec-*` classes are the list page, `det-*` the detail page.

/** The full-width list page shell: the caller appends its own header (ghHeader
 *  + toolbar cluster) and then fills `listEl` with `secRow`s. */
export function sectionList(): { view: HTMLElement; listEl: HTMLElement } {
  const view = el("div", "gh-view");
  const listEl = el("div", "sec-list");
  wireListNav(listEl, ".sec-row");
  return { view, listEl };
}

/** One single-line row on a section list page: state icon, muted #number,
 *  strong truncating title, inline label chips, then a right-aligned meta
 *  cluster and a relative time. Fixed height — the density that lets a list
 *  read like a tracker instead of a stack of cards. */
export interface SecRowOpts {
  lead?: HTMLElement;
  /** The muted leading id, e.g. "#31". */
  num?: string;
  title: string;
  /** Pills rendered right after the title (Draft, prerelease…). */
  titleSuffix?: HTMLElement[];
  /** Inline chips after the title (labels). Clipped, never wrapped. */
  chips?: HTMLElement[];
  /** Right-aligned cluster (avatars, stats). */
  meta?: HTMLElement[];
  /** Right-edge relative time (tabular figures, fixed slot). */
  time?: string;
  timeTitle?: string;
  onOpen: () => void;
  ariaLabel?: string;
}
export function secRow(o: SecRowOpts): HTMLElement {
  const row = el("button", "sec-row");
  if (o.ariaLabel) row.setAttribute("aria-label", o.ariaLabel);
  if (o.lead) {
    const lead = el("span", "sec-row-lead");
    lead.appendChild(o.lead);
    row.appendChild(lead);
  }
  if (o.num) {
    const num = el("span", "sec-row-num");
    num.textContent = o.num;
    row.appendChild(num);
  }
  const title = el("span", "sec-row-title");
  title.textContent = o.title;
  title.title = o.title;
  row.appendChild(title);
  for (const s of o.titleSuffix ?? []) row.appendChild(s);
  if (o.chips?.length) {
    const chips = el("span", "sec-row-chips");
    for (const c of o.chips) chips.appendChild(c);
    row.appendChild(chips);
  }
  row.appendChild(el("span", "sec-row-spring"));
  if (o.meta?.length) {
    const meta = el("span", "sec-row-meta");
    for (const m of o.meta) meta.appendChild(m);
    row.appendChild(meta);
  }
  if (o.time !== undefined) {
    const t = el("span", "sec-row-time");
    t.textContent = o.time;
    if (o.timeTitle) t.title = o.timeTitle;
    row.appendChild(t);
  }
  row.addEventListener("click", o.onOpen);
  return row;
}

/** An overlapping avatar stack for a row's meta cluster (up to `max`). */
export function avatarStack(
  people: Array<{ login: string; avatarUrl?: string | null }>,
  max = 3,
  size = 18,
  /** What these people ARE — "Assignee", "Author". Rendered into each avatar's
   *  tooltip and the stack's own label, because the same circle in the same
   *  slot used to mean assignees on Issues and the author on PRs, unlabelled. */
  role?: string,
): HTMLElement {
  const wrap = el("span", "sec-avs");
  for (const p of people.slice(0, max)) {
    wrap.appendChild(avatar(p.login, p.avatarUrl ?? null, size, role));
  }
  if (people.length > max) {
    const rest = people.slice(max);
    const more = el("span", "sec-avs-more");
    more.textContent = `+${rest.length}`;
    // The overflow chip used to hide who it stood for.
    more.title = rest.map((p) => `@${p.login}`).join(", ");
    wrap.appendChild(more);
  }
  if (role) {
    wrap.setAttribute(
      "aria-label",
      `${role}${people.length === 1 ? "" : "s"}: ${people.map((p) => p.login).join(", ")}`,
    );
  }
  return wrap;
}

/** Esc on a detail page = back to the list. Stands down whenever another layer
 *  consumed the key (peek/modal/palette/menu all preventDefault their Esc) or
 *  the focus is in a text surface; self-unhooks once the page leaves the DOM. */
function wireDetailEsc(view: HTMLElement, onBack: () => void): void {
  const onKey = (e: KeyboardEvent): void => {
    if (!view.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector(".peek-overlay, .modal-overlay, .cmdk-overlay, .dropdown")) return;
    e.preventDefault();
    document.removeEventListener("keydown", onKey);
    onBack();
  };
  document.addEventListener("keydown", onKey);
}

export interface DetailPageOpts {
  /** The ← button's label — the section name ("Issues", "Pull Requests"). */
  backLabel: string;
  /** Muted crumb after the back button, e.g. "#31". */
  crumb?: string;
  onBack: () => void;
  /** The top-bar action cluster (rightmost); one primary action at most. */
  actions?: HTMLElement[];
}

/** The full-page detail shell: a slim top bar (← back · crumb · actions) over
 *  a scrolling body of `main` (measure-capped content column) + `rail` (the
 *  sticky properties column). Esc goes back (see wireDetailEsc). */
export function detailPage(o: DetailPageOpts): {
  view: HTMLElement;
  main: HTMLElement;
  rail: HTMLElement;
  topActions: HTMLElement;
} {
  const view = el("div", "det-view");
  const bar = el("div", "det-topbar");
  const back = el("button", "det-back");
  back.append(glyph("arrow-left"), span(o.backLabel));
  back.title = `Back to ${o.backLabel}  (Esc)`;
  back.setAttribute("aria-label", back.title);
  back.addEventListener("click", o.onBack);
  bar.appendChild(back);
  if (o.crumb) {
    const crumb = el("span", "det-crumb");
    crumb.textContent = o.crumb;
    bar.appendChild(crumb);
  }
  const topActions = el("div", "det-tb-actions");
  for (const a of o.actions ?? []) topActions.appendChild(a);
  bar.appendChild(topActions);
  const scroll = el("div", "det-scroll");
  const body = el("div", "det-body");
  const main = el("div", "det-main");
  const rail = el("div", "det-rail");
  body.append(main, rail);
  scroll.appendChild(body);
  view.append(bar, scroll);
  wireDetailEsc(view, o.onBack);
  return { view, main, rail, topActions };
}

/** One property in the detail rail: an uppercase label (with a hover-revealed
 *  edit affordance when `onEdit` is given) over a small value body. */
export function propSection(
  label: string,
  opts: { onEdit?: (anchor: HTMLElement) => void; editTitle?: string } = {},
): { root: HTMLElement; body: HTMLElement } {
  const root = el("div", "det-prop");
  const head = el("div", "det-prop-label");
  head.appendChild(span(label));
  if (opts.onEdit) {
    const b = el("button", "det-prop-edit");
    b.appendChild(glyph("edit"));
    b.title = opts.editTitle ?? `Edit ${label.toLowerCase()}`;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onEdit!(b);
    });
    head.appendChild(b);
  }
  const body = el("div", "det-prop-body");
  root.append(head, body);
  return { root, body };
}

/** A person chip for the rail (avatar + login); clickable when given onClick. */
export function personChip(
  login: string,
  avatarUrl: string | null | undefined,
  onClick?: () => void,
): HTMLElement {
  const chip = el(onClick ? "button" : "span", "det-person");
  chip.append(avatar(login, avatarUrl ?? null, 20), span(login));
  if (onClick) {
    chip.title = `View @${login}'s profile`;
    chip.addEventListener("click", onClick);
  }
  return chip;
}

// ── Author association + reactions ───────────────────────────────────────────

/** GitHub's SCREAMING_CASE association, in words a person would use.
 *  "OWNER" tells you the repo owner is talking; "FIRST_TIME_CONTRIBUTOR" tells
 *  you to be welcoming. Both are signal the app used to throw away. */
export function associationLabel(a: string): string {
  switch (a) {
    case "OWNER": return "Owner";
    case "MEMBER": return "Member";
    case "COLLABORATOR": return "Collaborator";
    case "CONTRIBUTOR": return "Contributor";
    case "FIRST_TIME_CONTRIBUTOR": return "First-time contributor";
    case "FIRST_TIMER": return "First-time on GitHub";
    case "MANNEQUIN": return "Mannequin";
    default: return a.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/** The small badge GitHub puts beside a commenter's name. Only for
 *  associations that actually MEAN something — a plain "NONE"/"CONTRIBUTOR"
 *  badge on every comment is noise, not information. */
export function associationBadge(a: string | undefined): HTMLElement | undefined {
  if (!a || a === "NONE" || a === "CONTRIBUTOR") return undefined;
  const b = span(associationLabel(a), "gh-assoc-badge");
  b.title = `This person is a repository ${associationLabel(a).toLowerCase()}`;
  return b;
}

const REACTION_EMOJI: Array<[keyof ReactionSummary, string, string]> = [
  ["plusOne", "👍", "+1"],
  ["minusOne", "👎", "-1"],
  ["laugh", "😄", "laugh"],
  ["hooray", "🎉", "hooray"],
  ["confused", "😕", "confused"],
  ["heart", "❤️", "heart"],
  ["rocket", "🚀", "rocket"],
  ["eyes", "👀", "eyes"],
];

/** A read-only reaction strip — only the buckets someone actually used.
 *  Undefined when nobody reacted, so callers append conditionally. */
export function reactionRow(r: ReactionSummary | undefined): HTMLElement | undefined {
  if (!r || r.total <= 0) return undefined;
  const row = el("div", "gh-reactions");
  for (const [key, emoji, name] of REACTION_EMOJI) {
    const n = r[key] as number;
    if (!n) continue;
    const chip = span("", "gh-reaction");
    chip.append(span(emoji, "gh-reaction-emoji"), span(String(n), "gh-reaction-n"));
    chip.title = `${n} ${name}`;
    row.appendChild(chip);
  }
  return row.childElementCount ? row : undefined;
}

/** The dashed "add / set" affordance used by empty rail properties. */
export function propAddBtn(label: string, onClick: () => void): HTMLElement {
  const b = el("button", "det-prop-add");
  b.append(glyph("add"), span(label));
  b.addEventListener("click", onClick);
  return b;
}

/** A muted placeholder value for an empty rail property ("None"). */
export function propNone(text = "None"): HTMLElement {
  return span(text, "det-prop-none");
}

/**
 * The list caps the paged fetches stop at (mirrors main/githubPaging PAGE_CAPS
 * × per_page). When a list arrives at exactly its cap it PROBABLY has more —
 * append `capNotice` so the UI says "first N" instead of lying by omission.
 */
export const LIST_CAPS = {
  issues: 300,
  prs: 300,
  runs: 200,
  notifications: 150,
} as const;

/** A quiet end-of-list note for a capped list; null when under the cap.
 *
 *  `mode` keeps the wording HONEST. When the narrowing happens on GitHub's
 *  side ("server"), "search to narrow" is a lie — the list you're looking at
 *  is already the server's answer, and the fix is a filter, not a search box. */
export function capNotice(
  shown: number,
  cap: number,
  mode: "client" | "server" = "client",
): HTMLElement | null {
  if (shown < cap) return null;
  const note = el("div", "sec-cap-note");
  note.append(
    glyph("info"),
    span(
      mode === "server"
        ? `Showing the ${cap} most recent from GitHub — narrow with the filters above to see further back.`
        : `Showing the ${cap} most recently updated — search to narrow the list.`,
    ),
  );
  return note;
}

// ── Facets: one filter vocabulary for every section ──────────────────────────

/** A tiny round color swatch for a label (menu leading element). */
export function swatch(hexColor: string): HTMLElement {
  const sw = el("span", "gh-label-swatch");
  sw.style.background = `#${(hexColor || "888888").replace(/^#/, "")}`;
  return sw;
}


export interface FacetBar<T> {
  el: HTMLElement;
  /** True when `item` survives every ACTIVE client-side facet. */
  passes: (item: T) => boolean;
  /** Active values for server-side facets (those with no predicate). */
  serverValues: () => Record<string, string>;
  /** How many facets are currently narrowing the list. */
  activeCount: () => number;
  /** Clear every facet (fires onChange once). */
  clear: () => void;
  /** Re-render the buttons — call after the item list changes so harvested
   *  options reflect what's actually loaded. */
  sync: (items: T[]) => void;
}

/**
 * Build a facet bar. The bar owns its buttons and menus; the VIEW owns the
 * state object and decides what a change means (re-filter locally, or re-fetch
 * with `serverValues()`).
 */
export function facetBar<T>(o: {
  specs: FacetSpec<T>[];
  /** Mutated in place, so a view can seed it from a route target. */
  state: FacetState;
  items: T[];
  onChange: () => void;
}): FacetBar<T> {
  const bar = el("div", "gh-facets");
  let items = o.items;
  const loaded = new Map<string, FacetOption[]>();

  const optionsFor = (spec: FacetSpec<T>): FacetOption[] => {
    if (spec.options) return spec.options;
    if (spec.harvest) return spec.harvest(items);
    return loaded.get(spec.key) ?? [];
  };

  const openFacetMenu = (spec: FacetSpec<T>, btn: HTMLElement): void => {
    const build = (opts: FacetOption[]): void => {
      const current = o.state[spec.key];
      const items_: MenuItem[] = [
        {
          label: spec.anyLabel ?? `Any ${spec.label.toLowerCase()}`,
          icon: current == null ? "check" : undefined,
          onClick: () => {
            delete o.state[spec.key];
            render();
            o.onChange();
          },
        },
      ];
      if (opts.length) items_.push({ separator: true });
      for (const opt of opts) {
        const selected = current === opt.value;
        items_.push({
          label: opt.label ?? opt.value,
          icon: selected ? "check" : opt.iconEl ? undefined : opt.icon,
          iconEl: selected ? undefined : opt.iconEl?.(),
          current: selected,
          onClick: () => {
            o.state[spec.key] = opt.value;
            render();
            o.onChange();
          },
        });
      }
      if (!opts.length) {
        items_.push({ label: `No ${spec.label.toLowerCase()} to filter by`, disabled: true });
      }
      // Long option lists get the menu's own filter box — scrolling 40 branches
      // to find one is not filtering, it's searching by hand.
      openMenu(btn, items_, { searchable: opts.length > 8 });
    };

    if (spec.load && !loaded.has(spec.key)) {
      // Show something immediately; replace it when the load lands. A menu
      // that opens empty and never updates is worse than a slow one.
      void spec
        .load()
        .then((opts) => {
          loaded.set(spec.key, opts);
          build(opts);
        })
        .catch(() => {
          loaded.set(spec.key, []);
          build([]);
        });
      return;
    }
    build(optionsFor(spec));
  };

  const render = (): void => {
    bar.replaceChildren();
    for (const spec of o.specs) {
      const value = o.state[spec.key];
      const btn = el("button", "mini-btn gh-facet-btn") as HTMLButtonElement;
      const shown =
        value == null
          ? undefined
          : optionsFor(spec).find((x) => x.value === value)?.label ?? value;
      btn.classList.toggle("is-active", value != null);
      btn.append(
        glyph(spec.icon),
        span(shown != null ? `${spec.label}: ${shown}` : spec.label),
        glyph("chevron-down"),
      );
      btn.title =
        shown != null
          ? `Filtering by ${spec.label.toLowerCase()} “${shown}” — click to change`
          : `Filter by ${spec.label.toLowerCase()}`;
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("click", () => openFacetMenu(spec, btn));
      bar.appendChild(btn);
    }
    if (activeCount() > 0) {
      const clearBtn = el("button", "mini-btn gh-facet-clear") as HTMLButtonElement;
      clearBtn.append(glyph("clear-all"), span("Clear"));
      clearBtn.title = "Clear every filter";
      clearBtn.addEventListener("click", () => api.clear());
      bar.appendChild(clearBtn);
    }
  };

  const activeCount = (): number => facetActiveCount(o.specs, o.state);

  const api: FacetBar<T> = {
    el: bar,
    passes: (item: T) => facetPasses(o.specs, o.state, item),
    serverValues: () => facetServerValues(o.specs, o.state),
    activeCount,
    clear: () => {
      for (const spec of o.specs) delete o.state[spec.key];
      render();
      o.onChange();
    },
    sync: (next: T[]) => {
      items = next;
      render();
    },
  };

  render();
  return api;
}


/** The segmented control (Open / Closed / All), extracted from the two views
 *  that each had their own copy. Returns the element; the caller owns state. */
export function segmented<V extends string>(o: {
  options: Array<{ value: V; label: string; icon?: string }>;
  value: V;
  ariaLabel: string;
  onChange: (value: V) => void;
}): HTMLElement {
  const seg = el("div", "gh-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", o.ariaLabel);
  for (const opt of o.options) {
    const b = el("button", "gh-seg-btn" + (opt.value === o.value ? " active" : ""));
    if (opt.icon) b.appendChild(glyph(opt.icon));
    b.appendChild(span(opt.label));
    b.setAttribute("aria-pressed", String(opt.value === o.value));
    b.addEventListener("click", () => {
      if (opt.value === o.value) return;
      o.onChange(opt.value);
    });
    seg.appendChild(b);
  }
  return seg;
}

/**
 * Arrow-key traversal for a list of row buttons: ↑/↓ move focus between the
 * visible rows, Home/End jump to the edges, and Enter activates (native, since
 * rows are buttons). Delegated on the container so re-rendered rows need no
 * re-wiring. Typing surfaces (a filter input inside the container) are left
 * alone. Every browsable list wires this — it's what makes the sections feel
 * keyboard-first instead of Tab-only.
 */
export function wireListNav(container: HTMLElement, selector = ".gh-row"): void {
  container.addEventListener("keydown", (e) => {
    // j/k are first-class aliases for ↓/↑ — the muscle memory every
    // Linear/Vim/Gmail hand brings to a list.
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    const isNav = down || up || e.key === "Home" || e.key === "End";
    if (!isNav && e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
      (r) => r.offsetParent !== null,
    );
    if (!rows.length) return;
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Enter") {
      // Rows are mostly plain <div>s with click listeners — Enter must mean
      // "activate this row" for them too, not just for real <button>s (whose
      // native Enter→click still works and is de-duplicated by this guard).
      if (cur >= 0 && !(rows[cur] instanceof HTMLButtonElement)) {
        e.preventDefault();
        rows[cur].click();
      }
      return;
    }
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (cur === -1) next = down ? 0 : rows.length - 1;
    else if (down) next = Math.min(cur + 1, rows.length - 1);
    else next = Math.max(cur - 1, 0);
    e.preventDefault();
    const target = rows[next];
    // ghRow builds non-focusable <div>s (no caller passes onClick) — .focus()
    // was a silent no-op and arrow navigation was DEAD on every gh-row list.
    if (target.tabIndex < 0 && !(target instanceof HTMLButtonElement)) target.tabIndex = -1;
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  });
}
