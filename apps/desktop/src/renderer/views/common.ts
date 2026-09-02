// Shared scaffolding for the per-section GitHub view modules (releases,
// notifications, orgs, projects, gists, …). Each module exports a `SectionRender`
// and renders into the container it's handed; these helpers give every section
// the same gate, header, two-pane layout, and not-connected prompt so the whole
// app feels like one product.

import { host } from "../bridge";
import { gget } from "../cache";
import { openModal } from "../dialogs";
import { focusNewPage } from "../focusReturn";
import { pageOwnsKeys } from "../overlays";
import { navPrev, navPop, entryLabel, setPageLabel } from "../navStack";
import {
  cleanErr,
  el,
  errorState,
  glyph,
  span,
  emptyState,
  avatar,
  openMenu,
  relTime,
  absTime,
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
  /**
   * A FILE for the Code view to open, with `path` naming its folder.
   *
   * Opening a file used to replace the view host directly without routing, so
   * as far as the app was concerned you were still standing in the folder: any
   * forced re-route — a window focus after you edited that very file in your
   * editor, a Pull, a branch switch — rebuilt the listing on top of it and
   * ejected you from what you were reading. Back landed on the wrong folder and
   * Forward could not return to the file, because neither ever knew about it.
   */
  file?: string;
  /** A ref (branch / remote / tag / stash selector) for the Branches view to
   *  scroll to and flash on entry. */
  ref?: string;
  /**
   * Which section the user came FROM, when it is not the one that owns the
   * item.
   *
   * Inbox and My Work both open issues and pull requests, which routes into
   * those sections — so the detail page believed it belonged to Issues, its
   * back button said "← Issues", the rail silently switched, and Escape landed
   * you in a list you had never been in. The originating section rides along so
   * back and Escape return where you actually were.
   */
  from?: { view: string; label: string };
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
  onRefresh: () => void | Promise<void>,
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
  const refreshBtn = el("button", "icon-btn gh-refresh") as HTMLButtonElement;
  refreshBtn.title = "Refresh";
  refreshBtn.setAttribute("aria-label", "Refresh this view");
  refreshBtn.appendChild(glyph("refresh"));
  // Say that it is working. This was `() => onRefresh()` — fire and forget, no
  // feedback of any kind — in twelve views. Clicking it looked like nothing had
  // happened, so people clicked it again. The local views (Code, Changes) grew a
  // busy state of their own; these never did.
  // `aria-disabled`, never `disabled`. A disabled control cannot hold focus and
  // leaves the tab order, so the focus rescue that puts the keyboard back after
  // a rebuild had nothing to put it back ON — pressing Refresh dropped focus to
  // <body>, which is the exact bug the rescue exists to prevent. The re-entry
  // guard is the deadline below, not the DOM.
  const setBusy = (btn: HTMLButtonElement, on: boolean): void => {
    btn.setAttribute("aria-disabled", String(on));
    btn.setAttribute("aria-busy", String(on));
    btn.classList.toggle("is-busy", on);
    btn.querySelector(".codicon")?.classList.toggle("spin", on);
  };
  // A refresh REBUILDS the view, which replaces this whole header — so the
  // button that was spinning is detached the instant the answer lands, and the
  // new one is built with no busy state at all. The floor below was protecting
  // an element nobody could see any more. Carrying the deadline across the
  // rebuild lets the freshly-built button pick the spin back up.
  if (Date.now() < refreshBusyUntil) setBusy(refreshBtn, true);
  refreshBtn.addEventListener("click", () => {
    if (Date.now() < refreshBusyUntil) return; // still working on the last one
    // A refresh answered from cache finishes in a millisecond, and a spinner
    // that appears and vanishes within one frame reads as "nothing happened".
    // Hold it long enough to be seen — the honest signal is "I did the thing",
    // not "here is precisely how long it took".
    refreshBusyUntil = Date.now() + 350;
    setBusy(refreshBtn, true);
    const done = (): void => {
      refreshBusyUntil = 0;
      if (refreshBtn.isConnected) setBusy(refreshBtn, false);
      // …and whichever button the rebuild put in its place.
      for (const b of document.querySelectorAll<HTMLButtonElement>(".gh-refresh.is-busy")) {
        setBusy(b, false);
      }
    };

    const floor = new Promise<void>((r) => setTimeout(r, 350));
    void Promise.all([Promise.resolve(onRefresh()).catch(() => {}), floor]).then(done);
  });
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
  /**
   * `now` skips the debounce.
   *
   * CLEARING is not typing. A field with a long debounce — Explore's code
   * search waits for Enter with `debounceMs: 100_000`, because every keystroke
   * there costs a rate-limited request — left the ✕ and Escape queued a hundred
   * seconds out, so the box emptied and the results below it did not. The box
   * said one thing and the list another, and there was no way to make them
   * agree short of pressing Enter on an empty query.
   */
  const fire = (now = false): void => {
    clear.hidden = !input.value;
    window.clearTimeout(timer);
    if (now) {
      opts.onInput(input.value.trim());
      return;
    }
    timer = window.setTimeout(() => opts.onInput(input.value.trim()), opts.debounceMs ?? 110);
  };
  // NOT `fire` directly — it now takes a `now` flag, and the InputEvent would
  // arrive as a truthy first argument, making every keystroke skip the debounce.
  input.addEventListener("input", () => fire());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      fire(true);
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
    fire(true);
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
  /**
   * Row verbs, rendered AFTER the time — at rest, not on hover.
   *
   * Deliberately its own slot rather than more `meta`: meta sits LEFT of the
   * time column, and "the time is the last thing on the far right" is a rule
   * every list in the app depends on to stay scannable.
   *
   * At rest is the point. The Branches view hid its whole action surface behind
   * `opacity: 0` until hover, which is why every deeper verb had to be exiled
   * into a menu, and why nothing in that view could be reached by keyboard or
   * touch at all. These render muted and gain contrast on hover or focus.
   */
  actions?: HTMLElement[];
  onOpen: () => void;
  ariaLabel?: string;
}
/**
 * Mark a label strip that has run out of room, so it can fade its last chip
 * instead of guillotining it.
 *
 * Chips are `flex: 0 0 auto` inside an `overflow: hidden` strip, so when the
 * window is narrow the last one is sliced by a hard vertical edge partway
 * through a word: a rounded pill with a flat cut side, which reads as a
 * half-drawn element rather than as "there is more". CSS cannot ask "am I
 * overflowing", so one shared observer answers it.
 *
 * Shared deliberately — a list can hold hundreds of rows, and an observer each
 * would cost more than the thing it is styling.
 */
let chipOverflowObserver: ResizeObserver | undefined;
function watchChipOverflow(chips: HTMLElement): void {
  const sync = (el_: Element): void => {
    const n = el_ as HTMLElement;
    n.classList.toggle("is-clipped", n.scrollWidth > n.clientWidth + 1);
  };
  if (typeof ResizeObserver === "undefined") {
    // No observer (older host): fall back to a one-shot measure after layout.
    requestAnimationFrame(() => sync(chips));
    return;
  }
  if (!chipOverflowObserver) {
    chipOverflowObserver = new ResizeObserver((entries) => {
      for (const e of entries) sync(e.target);
    });
  }
  chipOverflowObserver.observe(chips);
  requestAnimationFrame(() => sync(chips));
}

export function secRow(o: SecRowOpts): HTMLElement {
  const row = el("button", "sec-row");
  if (o.ariaLabel) row.setAttribute("aria-label", o.ariaLabel);
  // Rows built from `meta` fragments can end up carrying their own controls —
  // an Actions run row puts a branch sub-link in its meta cluster — and a
  // control inside a <button> is invalid: the outer button's accessible name
  // swallows the inner one, assistive tech cannot reach it, and Space activates
  // the row rather than the thing you are actually on. When that happens the row
  // becomes the app's documented div[role="button"] shape instead, which is what
  // the branch rows already use for exactly this reason. See `promoteToDivRow`.
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
    watchChipOverflow(chips);
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
  if (o.actions?.length) {
    const acts = el("span", "sec-row-actions");
    for (const a of o.actions) acts.appendChild(a);
    // A click on a verb is not a click on the row. Without this, pressing
    // Checkout would ALSO open the ref's page underneath it.
    acts.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(acts);
  }
  row.addEventListener("click", o.onOpen);
  return promoteToDivRow(row, o.onOpen);
}

/**
 * If a row ended up containing its own interactive children, re-shape it from a
 * `<button>` into a `div[role="button"]` carrying the same contract: clickable,
 * one tab stop, Enter and Space activate — but only when the key event started
 * on the ROW, so a control inside it keeps its own keys.
 */
function promoteToDivRow(row: HTMLElement, onOpen: () => void): HTMLElement {
  const inner = row.querySelector('button, a[href], [role="button"], input, select, textarea');
  if (!inner) return row;
  const div = el("div", `${row.className} is-clickable`);
  for (const { name, value } of [...row.attributes]) {
    if (name !== "class") div.setAttribute(name, value);
  }
  while (row.firstChild) div.appendChild(row.firstChild);
  div.setAttribute("role", "button");
  div.tabIndex = 0;
  div.addEventListener("click", onOpen);
  div.addEventListener("keydown", (e) => {
    if (e.target !== div) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpen();
  });
  return div;
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
/**
 * ONE listener for every detail page, and it answers "←" as well as Escape.
 *
 * Two things were wrong with a listener per page. It only handled Escape, while
 * the app's own shortcut sheet advertises "Esc or ←" — the arrow was documented
 * and implemented nowhere. And it unhooked itself on the next KEYDOWN after the
 * view had detached, not when the view detached: so open a detail, switch
 * section (the view is stashed, not destroyed), type anything at all, and the
 * handler removed itself for good. Come back to that page and Escape was dead,
 * with the page's closure pinned in memory until some later keystroke happened
 * to evict it.
 *
 * A registry keyed by the view element fixes both. It survives the
 * detach/re-attach that keep-alive does, it needs no teardown from callers that
 * have none to give, and the entries are pruned whenever a new page is wired.
 */
const detailBacks = new WeakMap<HTMLElement, () => void>();
let detailStack: HTMLElement[] = [];
let detailKeysWired = false;

/** Until when a header refresh should read as busy. A refresh rebuilds the
 *  header it lives in, so the state has to survive the element. */
let refreshBusyUntil = 0;

function wireDetailEsc(view: HTMLElement, onBack: () => void): void {
  detailBacks.set(view, onBack);
  // Most recent last. Deliberately NOT filtered on `isConnected`: a kept-alive
  // section is stashed OUT of the DOM while you are elsewhere, so pruning
  // detached views here dropped a page that was merely put away — and a
  // restore replays the cached DOM without rebuilding it, so nothing ever
  // re-registered. Escape and ← were dead on every detail page you came back
  // to. Dispatch already skips disconnected views, which is the right place to
  // ask, because by then the answer is current.
  detailStack = detailStack.filter((v) => v !== view);
  detailStack.push(view);
  // Bounded, since entries can now outlive their time on screen. Far more than
  // any real navigation depth; the oldest is also the least likely to return.
  if (detailStack.length > 64) detailStack = detailStack.slice(-64);
  if (detailKeysWired) return;
  detailKeysWired = true;
  // CAPTURE. A modal's own Escape handler is capture-phase too, and it releases
  // its layer as it closes — so a bubble-phase page handler asked
  // "is a layer open?" AFTER the answer had already changed, and was left
  // relying on `defaultPrevented` alone to stop it navigating out from under
  // the dialog that had just closed. Registered first, in the same phase, the
  // page asks while the layer is still there and stands down properly.
  document.addEventListener("keydown", (e) => {
    const esc = e.key === "Escape";
    const left = e.key === "ArrowLeft";
    if ((!esc && !left) || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // ← is Back only when the keyboard is on the PAGE. Inside a control that
    // uses arrows — a tablist, a toolbar, a resizer, a list — the arrow belongs
    // to that control, and stealing it would be worse than not offering it.
    if (left && t && t !== document.body && t.closest('[role="tablist"], [role="toolbar"], [role="separator"], [role="listbox"], [role="menu"], .gh-seg, .settings-seg, .cmp-seg')) {
      return;
    }
    // ANY floating layer above the page owns these keys — this handler belongs
    // to the page, so everything outranks it. `ownsEscape()` is the wrong
    // question here: it cannot see a peek (a "surface"), so ← started routing
    // the page out from under an open peek and throwing the peek away. The
    // whitelist of four CSS selectors this replaced did happen to match
    // `.peek-overlay`; the registry matches every layer, present and future.
    if (!pageOwnsKeys()) return;
    for (let i = detailStack.length - 1; i >= 0; i--) {
      const v = detailStack[i];
      if (!v.isConnected) continue;
      const back = detailBacks.get(v);
      if (!back) continue;
      e.preventDefault();
      back();
      return;
    }
  }, true);
}

export interface DetailPageOpts {
  /**
   * Where Back goes when there is NO history behind this page — a deep link, a
   * fresh launch, a restored session. Otherwise the button pops, and its label
   * names wherever that lands.
   */
  backLabel: string;
  /** Muted crumb after the back button, e.g. "#31". */
  crumb?: string;
  /** The cold-start fallback, used only when the history is empty. */
  onBack: () => void;
  /** The top-bar action cluster (rightmost); one primary action at most. */
  actions?: HTMLElement[];
  /**
   * What to call THIS page in the next page's back button — "Pull Request
   * #106", "Run #411". Without it the button falls back to the view's name, so
   * leaving a PR for a pipeline and pressing back reads "← Pull requests" and
   * lands on the list rather than the PR you were reading.
   */
  pageLabel?: string;
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

  // POP, not push.
  //
  // Every caller used to pass `nav(view, {list:true})`, which APPENDS a history
  // entry — so the button that should restore your place destroyed it, and the
  // top bar's Forward went dead the moment you used it. It also meant Back
  // could only ever name a list: leaving a pull request for a pipeline and
  // pressing back landed in the Actions list rather than the pull request,
  // because `from` had no way to say "Pull Request #106".
  //
  // The history already knows where you were. The label is read from it, so the
  // button always names its real destination; `o.onBack` survives only as the
  // cold-start fallback for a page nothing led to.
  if (o.pageLabel) setPageLabel(o.pageLabel);
  const prev = navPrev();
  const label = entryLabel(prev, o.backLabel);
  const goBack = (): void => {
    if (!navPop()) o.onBack();
  };
  back.append(glyph("arrow-left"), span(label));
  back.title = `Back to ${label}  (Esc)`;
  back.setAttribute("aria-label", back.title);
  back.addEventListener("click", goBack);
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
  // The IDENTICAL function, so Escape, ← and the button can never disagree
  // about where back is.
  wireDetailEsc(view, goBack);
  // The page that just replaced a list takes the keyboard with it. Without
  // this, pressing Enter on a row left focus on <body>, so the next Tab
  // started at the top of the window — past the entire nav rail — rather than
  // in the thing you had just opened.
  focusNewPage(view, back);
  return { view, main, rail, topActions };
}

/**
 * One commit in a list of them — the shape github.com/…/pull/N/commits uses.
 *
 * "the bare commits view in compare and pr are not improved as i requested, you
 * can take example of how they look in github and follow similar ui".
 *
 * They WERE bare: a subject and one grey line reading "author · sha · 3h ago",
 * with no face, no date grouping, no way to read a commit's body, no way to
 * copy a sha, and nothing marking a merge. Everything below except the avatar
 * was already in the response and thrown away one layer down.
 */
export interface CommitListItem {
  sha: string;
  shortSha: string;
  subject: string;
  /** The rest of the message; the row grows a disclosure when there is one. */
  body?: string;
  /** The name git recorded. */
  author: string;
  /** The GitHub account, when the commit matched one. */
  login?: string;
  avatarUrl?: string;
  /** Epoch SECONDS. */
  date: number;
  verified?: boolean;
  isMerge?: boolean;
}

/** "Commits on 25 Aug 2026" — the day a commit was authored, in local time. */
function dayKey(epochSec: number): string {
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(epochSec: number): string {
  if (!epochSec) return "Undated";
  return new Date(epochSec * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * A list of commits, grouped by the day they were authored.
 *
 * ONE renderer for both surfaces. The pull request's Commits tab and Compare
 * built their own rows, from the same five fields, and had drifted: opposite
 * sort orders, and Compare's rows still announcing "reveal in the graph" to
 * assistive tech long after the click had been changed to open the commit.
 */
export function commitList(
  items: CommitListItem[],
  o: {
    onOpen: (sha: string) => void;
    onCopy?: (sha: string) => void;
    /**
     * "oldest" (the default) reads the work in the order it was done — how
     * github.com renders a pull request's commits and a compare, and the only
     * order that makes a narrative.
     *
     * "newest" is for a list that is a WINDOW on an ongoing history rather than
     * a complete set: a branch's recent commits, capped at N. Oldest-first
     * there opens on an arbitrary window edge — the 30th-newest commit — and
     * buries the tip, the one commit every reader came to see, at the bottom.
     */
    order?: "oldest" | "newest";
  },
): HTMLElement {
  const root = el("div", "clist");
  // The callers took their order from their sources and disagreed:
  // `pr:commits` comes back chronological, `git log base..head` comes back
  // newest-first, so the same branch read forwards on one screen and backwards
  // on the other. Sorting here makes that impossible rather than merely fixed.
  const dir = o.order === "newest" ? -1 : 1;
  const sorted = [...items].sort((a, b) => dir * ((a.date || 0) - (b.date || 0)));
  let openDay = "\u0000";
  let group: HTMLElement | undefined;

  for (const c of sorted) {
    const key = dayKey(c.date);
    if (key !== openDay) {
      openDay = key;
      const head = el("div", "clist-day");
      head.append(glyph("git-commit"), span(`Commits on ${dayLabel(c.date)}`));
      root.appendChild(head);
      group = el("div", "clist-group");
      root.appendChild(group);
    }

    const row = el("div", "clist-row");
    row.appendChild(avatar(c.login || c.author, c.avatarUrl, 20, "Author"));

    const main = el("div", "clist-main");
    // The SUBJECT is the link. A whole row that is one button cannot also hold
    // a copy button and a disclosure — a control inside a control has no
    // accessible name of its own and Space activates the wrong one.
    const subject = el("button", "clist-subject") as HTMLButtonElement;
    subject.textContent = c.subject;
    subject.title = `Open commit ${c.shortSha}`;
    subject.addEventListener("click", () => o.onOpen(c.sha));
    const subjRow = el("div", "clist-subjrow");
    subjRow.appendChild(subject);
    if (c.isMerge) {
      const chip = span("Merge", "clist-chip");
      chip.title = "This commit has more than one parent";
      subjRow.appendChild(chip);
    }

    // A body hides behind a disclosure rather than making every row three lines
    // tall — most commits have none, and the ones that do are the long ones.
    let bodyEl: HTMLElement | undefined;
    if (c.body && c.body.trim()) {
      const more = el("button", "clist-more") as HTMLButtonElement;
      more.append(glyph("ellipsis"));
      more.title = "Show this commit's full message";
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-expanded", "false");
      bodyEl = el("pre", "clist-body");
      bodyEl.textContent = c.body.trim();
      bodyEl.hidden = true;
      more.addEventListener("click", () => {
        const showing = bodyEl!.hidden;
        bodyEl!.hidden = !showing;
        more.setAttribute("aria-expanded", String(showing));
        more.title = showing ? "Hide the full message" : "Show this commit's full message";
        more.setAttribute("aria-label", more.title);
      });
      subjRow.appendChild(more);
    }
    main.appendChild(subjRow);

    const meta = el("div", "clist-meta");
    meta.appendChild(span(c.author, "clist-author"));
    const when = c.date ? relTime(c.date) : "";
    if (when) {
      const t = span(`committed ${when}`, "clist-when");
      t.title = absTime(c.date);
      meta.appendChild(t);
    }
    main.appendChild(meta);
    if (bodyEl) main.appendChild(bodyEl);

    const right = el("div", "clist-right");
    if (c.verified) {
      const v = span("Verified", "clist-verified");
      v.title = "GitHub verified this commit's signature";
      right.appendChild(v);
    }
    const sha = el("button", "clist-sha") as HTMLButtonElement;
    sha.textContent = c.shortSha;
    sha.title = `${c.sha}\nCopy the full SHA`;
    sha.setAttribute("aria-label", `Copy the full SHA ${c.sha}`);
    sha.addEventListener("click", () => o.onCopy?.(c.sha));
    right.appendChild(sha);
    const openBtn = el("button", "clist-open") as HTMLButtonElement;
    openBtn.append(glyph("diff"));
    openBtn.title = `Open ${c.shortSha} and what it changed`;
    openBtn.setAttribute("aria-label", openBtn.title);
    openBtn.addEventListener("click", () => o.onOpen(c.sha));
    right.appendChild(openBtn);

    row.append(main, right);
    (group ?? root).appendChild(row);
  }
  return root;
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

/** Keep an element's SPACE while hiding its ink. Row meta packs right-to-left,
 *  so omitting an optional slot shifts everything left of it into a different
 *  column and the eye can no longer scan down the list. */
export function blankable(el_: HTMLElement, show: boolean): HTMLElement {
  if (!show) {
    el_.style.visibility = "hidden";
    el_.setAttribute("aria-hidden", "true");
  }
  return el_;
}

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
    // An EXPLICIT list keeps its order: a state facet reads Open / Closed /
    // Merged because that is the sequence a pull request moves through, and
    // alphabetising it would be worse than useless.
    if (spec.options) return spec.options;
    // Everything harvested is sorted, wherever it was harvested. `harvestValues`
    // sorts internally and the five hand-rolled harvests do not — so within one
    // bar, Milestone and Base came out alphabetical while Author, Assignee and
    // Label came out in list order, i.e. ordered by whichever item happened to
    // be updated most recently. Those three are exactly the long menus where
    // finding a name matters.
    const byLabel = (a: FacetOption, b: FacetOption): number =>
      (a.label ?? a.value).localeCompare(b.label ?? b.value, undefined, { numeric: true });
    if (spec.harvest) return [...spec.harvest(items)].sort(byLabel);
    return [...(loaded.get(spec.key) ?? [])].sort(byLabel);
  };

  /** The facet whose menu is open, so `sync` can refill it in place when the
   *  list finally lands. Opening a menu before the data arrives used to leave
   *  it saying "No assignee to filter by" for as long as it stayed open — a
   *  statement about the repo, made from an empty array. */
  let openSpecKey: string | undefined;

  const openFacetMenu = (spec: FacetSpec<T>, btn: HTMLElement): void => {
    openSpecKey = spec.key;
    const build = (opts: FacetOption[]): void => {
      const current = o.state[spec.key];
      const items_: MenuItem[] = [
        {
          label: spec.anyLabel ?? `Any ${spec.label.toLowerCase()}`,
          icon: current == null ? "check" : "blank",
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
          // "blank" is a zero-ink glyph that still occupies the icon slot: with
          // only the selected row getting a check and nothing reserving the
          // gutter for the rest, the label column jumped 25px depending on
          // what was selected.
          icon: selected ? "check" : opt.iconEl ? undefined : (opt.icon ?? "blank"),
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
    // Where the keyboard is, before this destroys the button it is on.
    //
    // `openMenu` deliberately restores focus to the trigger BEFORE running the
    // item's action, so at this moment the facet button IS `activeElement` —
    // and `replaceChildren` then removes it, dropping focus to <body> and
    // restarting the next Tab at the top of the window, past the whole nav
    // rail. Every keyboard user who filtered a list was thrown out of the page.
    //
    // `focusReturn`'s generic rescue cannot save this one: it matches a
    // replacement by title, aria-label or text, and picking a value changes ALL
    // THREE at once ("Filter by label" → "Filtering by label “bug”…", "Label" →
    // "Label1"). Same failure already documented in views/rebase.ts. So the bar
    // puts the keyboard back itself, by slot.
    const held = document.activeElement as HTMLElement | null;
    const keep = held && bar.contains(held) ? [...bar.children].indexOf(held) : -1;
    bar.replaceChildren();
    for (const spec of o.specs) {
      const value = o.state[spec.key];
      const btn = el("button", "mini-btn gh-facet-btn") as HTMLButtonElement;
      const shown =
        value == null
          ? undefined
          : optionsFor(spec).find((x) => x.value === value)?.label ?? value;
      btn.classList.toggle("is-active", value != null);
      // The pill keeps its own name; the tick beside it says a value is set,
      // and the tooltip (plus the menu itself) says which. Putting the value in
      // the label is what made the pill grow and shove its neighbours.
      const mark = el("span", "gh-facet-value");
      mark.textContent = value != null ? "1" : "";
      btn.append(glyph(spec.icon), span(spec.label), mark, glyph("chevron-down"));
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
    // Put the keyboard back on the button in the same slot. The clamp covers
    // Clear, which sits last and disappears once it has done its job — focus
    // then lands on the final facet rather than on <body>. `keep === -1` when
    // focus was never in the bar (the initial build, or a `sync()` rebuild
    // while the dropdown itself has focus), so this never steals it.
    if (keep >= 0 && bar.children.length) {
      (bar.children[Math.min(keep, bar.children.length - 1)] as HTMLElement).focus({
        preventScroll: true,
      });
    }
  };

  const activeCount = (): number => facetActiveCount(o.specs, o.state);

  const api: FacetBar<T> = {
    el: bar,
    passes: (item: T) => facetPasses(o.specs, o.state, item),
    serverValues: () => facetServerValues(o.specs, o.state),
    activeCount,
    clear: () => {
      // EVERY key in the state, not just the specs currently in the bar.
      //
      // A view may drop a spec on some segments — Issues hides "Closed as" on
      // Open, because a closed reason can only match a closed issue. Clearing
      // only the listed specs left that value set, invisible and unclearable,
      // and it silently narrowed the list again the moment you switched back to
      // Closed. The button's own tooltip is "Clear every filter"; this makes
      // that true.
      for (const key of Object.keys(o.state)) delete o.state[key];
      render();
      o.onChange();
    },
    sync: (next: T[]) => {
      const had = items.length;
      // Ask BEFORE the rebuild: `render()` replaces every button, so the
      // aria-expanded that identifies the open menu lives on the button that is
      // about to be discarded. Checking afterwards always answers "no".
      const specIndex = o.specs.findIndex((sp) => sp.key === openSpecKey);
      const wasOpen =
        openSpecKey !== undefined &&
        specIndex >= 0 &&
        (bar.children[specIndex] as HTMLElement | undefined)?.getAttribute("aria-expanded") ===
          "true";
      items = next;
      render();
      // A menu opened over a still-loading list is anchored to a button that
      // `render()` has just replaced, and holds options harvested from nothing.
      // Re-open it against the live button so it fills in; `openMenu` replaces
      // any menu already up, so this is a refill rather than a second menu.
      // Refill ONLY the menu that was open on THIS facet's own button. Testing
      // for any `.dropdown` in the document was wrong twice over: a menu the
      // user had dismissed before the data landed would pop itself back open,
      // and a menu they had since opened somewhere else — a row's ⋯, the sort
      // picker — would be replaced by this one.
      if (!wasOpen) {
        openSpecKey = undefined;
        return;
      }
      if (!had && !next.length) return; // still nothing to put in it
      const btn = bar.children[specIndex] as HTMLElement | undefined;
      if (btn) openFacetMenu(o.specs[specIndex], btn);
    },
  };

  render();
  return api;
}


/** The segmented control (Open / Closed / All), extracted from the two views
 *  that each had their own copy. Returns the element; the caller owns state. */
/**
 * The `.gh-subtabs` bar with real tab semantics. Three detail pages hand-rolled
 * this as plain buttons carrying an `active` CLASS and nothing else: a screen
 * reader heard four unrelated buttons and could not tell which page you were
 * on, and ←/→ did nothing. One tablist, one roving tab stop, one selected tab.
 *
 * Returns the bar plus a `select(id)` the caller drives; the caller still owns
 * what each tab renders.
 */
export function subTabs<I extends string>(o: {
  tabs: ReadonlyArray<{ id: I; label: string; icon?: string }>;
  ariaLabel: string;
  panel?: HTMLElement;
  onSelect: (id: I) => void;
}): { el: HTMLElement; select: (id: I) => void; current: () => I } {
  const bar = el("div", "gh-subtabs");
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", o.ariaLabel);
  const btns: HTMLElement[] = [];
  let active = o.tabs[0]?.id as I;

  const paint = (id: I): void => {
    active = id;
    for (const b of btns) {
      const on = b.dataset.sub === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      // One tab stop for the whole bar: Tab reaches the selected tab, arrows
      // move between them. That is what a tablist is.
      b.tabIndex = on ? 0 : -1;
    }
  };
  const select = (id: I): void => {
    paint(id);
    o.onSelect(id);
  };

  for (const t of o.tabs) {
    const b = el("button", "gh-subtab");
    b.setAttribute("role", "tab");
    b.dataset.sub = t.id;
    if (o.panel?.id) b.setAttribute("aria-controls", o.panel.id);
    if (t.icon) b.appendChild(glyph(t.icon));
    b.appendChild(span(t.label));
    b.addEventListener("click", () => select(t.id));
    btns.push(b);
    bar.appendChild(b);
  }
  bar.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = btns.findIndex((b) => b.dataset.sub === active);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : (i + step + btns.length) % btns.length;
    const id = btns[next]?.dataset.sub as I | undefined;
    if (id == null) return;
    select(id);
    btns[next].focus();
  });
  if (o.panel) o.panel.setAttribute("role", "tabpanel");
  paint(active);
  return { el: bar, select, current: () => active };
}

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

/**
 * GitHub's CI status/conclusion enums, in English.
 *
 * These arrive as `in_progress`, `action_required`, `timed_out` and were
 * printed raw beside rows the rest of the app humanises — the one place in
 * GitStudio where the API's vocabulary leaked onto the screen.
 */
export function checkStateLabel(state: string): string {
  const map: Record<string, string> = {
    success: "Passed",
    failure: "Failed",
    neutral: "Neutral",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    skipped: "Skipped",
    stale: "Stale",
    timed_out: "Timed out",
    action_required: "Action required",
    startup_failure: "Startup failure",
    queued: "Queued",
    waiting: "Waiting",
    pending: "Pending",
    requested: "Requested",
    in_progress: "Running",
    completed: "Completed",
  };
  return map[state] ?? state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
