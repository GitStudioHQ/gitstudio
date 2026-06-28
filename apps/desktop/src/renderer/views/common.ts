// Shared scaffolding for the per-section GitHub view modules (releases,
// notifications, orgs, projects, gists, …). Each module exports a `SectionRender`
// and renders into the container it's handed; these helpers give every section
// the same gate, header, two-pane layout, and not-connected prompt so the whole
// app feels like one product.

import { host } from "../bridge";
import { el, glyph, span, emptyState } from "../ui";

/**
 * The signature every section view module implements. `wrap` is the section's
 * own container (already mounted); `nav(viewId)` routes to another sidebar view
 * (e.g. "settings" to sign in). Re-render by clearing `wrap` and rebuilding.
 */
export type SectionRender = (wrap: HTMLElement, nav: (view: string) => void) => void;

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
): Promise<GhGate | null> {
  let status: { connected: boolean; login?: string; repo?: { owner: string; repo: string } };
  try {
    status = await host.invoke("github:status", undefined);
  } catch {
    status = { connected: false };
  }
  if (!status.connected) {
    wrap.replaceChildren(connectPrompt(nav));
    return null;
  }
  if (needsRepo && !status.repo) {
    wrap.replaceChildren(
      emptyState("Not a GitHub repository", "This repo's origin remote isn't on github.com."),
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
): HTMLElement & { setCount?: (n: number) => void } {
  const headRow = el("div", "list-head list-head-row gh-head") as HTMLElement & {
    setCount?: (n: number) => void;
  };
  const left = el("div", "gh-head-titlewrap");
  const t = el("div", "list-head-title");
  t.textContent = title;
  const countPill = el("span", "gh-head-count");
  if (typeof count === "number") countPill.textContent = String(count);
  else countPill.hidden = true;
  left.append(t, countPill);
  headRow.setCount = (n: number): void => {
    countPill.textContent = String(n);
    countPill.hidden = false;
  };

  // The account + refresh that used to live here are gone — the account now sits
  // once in the top bar, and refresh is handled by view-switch/mutation reloads.
  // `.gh-acct` stays as the (empty) right-side anchor each view inserts its own
  // action cluster (New PR / New Issue / …) before. `login`/`onRefresh` are kept
  // in the signature because views still use them internally.
  void login;
  void onRefresh;
  const right = el("div", "gh-acct");
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
    timer = window.setTimeout(() => opts.onInput(input.value.trim()), 110);
  };
  input.addEventListener("input", fire);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      fire();
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    fire();
    input.focus();
  });
  wrap.append(icon, input, clear);
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

/** A list-left / detail-right scaffold matching the PR & Issue views. */
export function ghTwoPane(): { view: HTMLElement; listEl: HTMLElement; detailEl: HTMLElement } {
  const view = el("div", "gh-view");
  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detailEl = el("div", "gh-detail");
  body.append(listEl, detailEl);
  view.appendChild(body);
  return { view, listEl, detailEl };
}
