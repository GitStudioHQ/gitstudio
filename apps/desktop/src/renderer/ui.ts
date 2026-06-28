// Shared, framework-free DOM + UI helpers used across every renderer view —
// including the per-section view modules under ./views. Pure functions (plus a
// clipboard helper that toasts); no App state, so any module can import them.

import { toast } from "./dialogs";

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

export function el(tagName: string, className = ""): HTMLElement {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}

export function span(textContent: string, className = ""): HTMLElement {
  const s = el("span", className);
  s.textContent = textContent;
  return s;
}

/**
 * Glyphs — the real VS Code codicon font. The imported graph.css registers the
 * `codicon` @font-face at document scope; `.glyph` carries the box + color
 * rules. The COMPLETE @vscode/codicons codepoint map ships in
 * styles/codicons-full.css (generated verbatim from the library), so any real
 * codicon name resolves — pass the exact name from the codicon gallery.
 */
export function glyph(name: string): HTMLElement {
  const s = el("span", `glyph codicon codicon-${name}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** A compact relative-time string from an epoch-seconds timestamp. */
export function relTime(epochSec: number): string {
  if (!Number.isFinite(epochSec)) return "";
  const d = Math.max(0, Date.now() / 1000 - epochSec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo ago`;
  return `${Math.floor(d / 86400 / 365)}y ago`;
}

/** A codicon name for a file/folder, picked from the curated desktop subset by
 *  extension so the repo browser + changes lists read like a real file tree. */
export function fileIcon(name: string, isDir = false): string {
  if (isDir) return "folder";
  const n = name.toLowerCase();
  if (/^(readme|changelog|contributing|authors|notice)\b/.test(n) || /\.(md|markdown|mdx)$/.test(n)) return "markdown";
  if (/^license/.test(n)) return "book";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|less|html|htm|vue|svelte|py|go|rs|rb|java|kt|swift|c|h|cpp|cc|cs|php|sh|bash|zsh|yml|yaml|toml|sql|graphql|lua|dart)$/.test(n)) return "file-code";
  return "file";
}

/** Human-readable byte size, e.g. 2480 → "2.4 KB". */
export function formatBytes(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Up to two uppercase initials from a display name, for avatar fallbacks. */
export function initials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable, pleasant avatar hue from a seed (email/name) — `hsl(...)` string.
 *  Deterministic so the same author always gets the same colour. */
export function avatarHue(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 52%)`;
}

/** Relative time from an ISO-8601 string; "" when missing or unparseable. */
export function relTimeISO(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relTime(ms / 1000);
}

/** The full, localized absolute date+time for a unix-seconds timestamp — used as
 *  a `title` tooltip alongside a relative time (what JetBrains/GitKraken show). */
export function absTime(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return "";
  return new Date(epochSec * 1000).toLocaleString();
}

/** As {@link absTime}, from an ISO-8601 string. "" when missing/unparseable. */
export function absTimeISO(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString();
}

/** A small inline text-button used in list-row action clusters. */
export function textBtn(
  label: string,
  title: string,
  onClick: () => void,
  danger = false,
): HTMLElement {
  const b = el("button", "row-btn" + (danger ? " danger" : ""));
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** An uppercase muted group label used inside list/compare/changes views. */
export function groupLabel(text: string): HTMLElement {
  const d = el("div", "group-label");
  d.textContent = text;
  return d;
}

/** A small rounded pill (draft / checks / label). */
export function pill(text: string, className = ""): HTMLElement {
  const p = el("span", "gh-pill" + (className ? " " + className : ""));
  p.textContent = text;
  return p;
}

/** A centered title + description empty state for list views. */
export interface EmptyOpts {
  /** Codicon name for the badge (defaults to a neutral inbox). */
  icon?: string;
  /** A primary call-to-action button. */
  action?: { label: string; icon?: string; onClick: () => void };
  /** A muted hint line under the action (e.g. a keyboard shortcut). */
  hint?: string;
}

/** A composed, premium empty state: an accent-tinted icon badge, a title, a
 *  description, and an optional CTA + hint. Used for empty lists AND for the
 *  detail pane when nothing is selected, so no surface is ever a bare void. */
export function emptyState(title: string, desc: string, opts: EmptyOpts = {}): HTMLElement {
  const wrap = el("div", "list-empty");
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph(opts.icon ?? "inbox"));
  const t = el("div", "list-empty-title");
  t.textContent = title;
  const d = el("div", "list-empty-desc");
  d.textContent = desc;
  wrap.append(badge, t, d);
  if (opts.action) {
    const btn = el("button", "btn btn-primary list-empty-action");
    if (opts.action.icon) btn.appendChild(glyph(opts.action.icon));
    btn.appendChild(span(opts.action.label));
    btn.addEventListener("click", opts.action.onClick);
    wrap.appendChild(btn);
  }
  if (opts.hint) {
    const h = el("div", "list-empty-hint");
    h.textContent = opts.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/** An avatar: the real image when available, else a deterministic initials tile.
 *  Works fully offline (the stub/real null avatars fall back gracefully). */
export function avatar(login: string, url: string | null | undefined, size = 22): HTMLElement {
  const fallback = (): HTMLElement => {
    const s = el("span", "av av-fallback");
    s.textContent = initials(login || "?");
    s.style.setProperty("--av", avatarHue(login || "?"));
    s.style.width = s.style.height = `${size}px`;
    s.style.fontSize = `${Math.round(size * 0.42)}px`;
    return s;
  };
  if (url) {
    const img = document.createElement("img");
    img.className = "av av-img";
    img.src = url;
    img.alt = login;
    img.referrerPolicy = "no-referrer";
    img.style.width = img.style.height = `${size}px`;
    // If the avatar can't load (offline / 404), swap in the initials tile so the
    // chip never shows a broken-image glyph.
    img.addEventListener("error", () => img.replaceWith(fallback()));
    return img;
  }
  return fallback();
}

/** A GitHub label chip tinted from its hex color (works on both themes). */
export function labelChip(name: string, hexColor: string): HTMLElement {
  const chip = el("span", "gh-label-chip");
  const hex = (hexColor || "888888").replace(/^#/, "");
  chip.style.setProperty("--chip", `#${hex}`);
  chip.textContent = name;
  return chip;
}

/** A small trailing-stat bit: an optional icon + a number/label (comments,
 *  files, +/- lines). Pass an empty icon to render text-only (e.g. "+612"). */
export function statBit(icon: string, text: string | number, cls = ""): HTMLElement {
  const s = el("span", `gh-stat ${cls}`.trim());
  if (icon) s.appendChild(glyph(icon));
  s.appendChild(span(String(text)));
  return s;
}

/** A colored state pill (open / closed / merged / draft) for list rows + meta. */
export function statePill(label: string, kind: string): HTMLElement {
  const p = el("span", `gh-state-pill gh-state-${kind}`);
  p.append(glyph(stateIconName(kind)), span(label));
  return p;
}

/** A colored leading state icon for a list row (open=green, closed=red, …). */
export function stateLead(kind: string): HTMLElement {
  const s = el("span", `gh-lead-icon gh-lead-${kind}`);
  s.appendChild(glyph(stateIconName(kind)));
  return s;
}

/** Codicon name for a PR/issue state. */
export function stateIconName(kind: string): string {
  switch (kind) {
    case "merged": return "git-merge";
    case "closed": return "issue-closed";
    case "draft": return "git-pull-request-draft";
    case "open-pr": return "git-pull-request";
    default: return "issue-opened";
  }
}

/** A structured GitHub list row: leading icon/avatar, title (+ inline suffix),
 *  a muted meta line, label chips, and a trailing stat cluster. One consistent,
 *  rich row shape across PRs / Issues / Releases / Notifications / Gists / Orgs. */
export interface GhRowOpts {
  lead?: HTMLElement;
  title: string;
  titleSuffix?: HTMLElement[];
  meta?: string;
  /** Tooltip for the meta line (e.g. an absolute date behind a relative time). */
  metaTitle?: string;
  chips?: HTMLElement[];
  stats?: HTMLElement[];
  onClick?: () => void;
  ariaLabel?: string;
}
export function ghRow(o: GhRowOpts): HTMLElement {
  const row = el(o.onClick ? "button" : "div", "gh-row gh-row-rich");
  if (o.ariaLabel) row.setAttribute("aria-label", o.ariaLabel);
  if (o.lead) {
    const lead = el("span", "gh-row-lead");
    lead.appendChild(o.lead);
    row.appendChild(lead);
  }
  const body = el("div", "gh-row-body");
  const head = el("div", "gh-row-head");
  const title = el("span", "gh-row-title");
  title.textContent = o.title;
  head.appendChild(title);
  for (const s of o.titleSuffix ?? []) head.appendChild(s);
  body.appendChild(head);
  if (o.meta) {
    const sub = el("div", "gh-row-sub");
    sub.textContent = o.meta;
    if (o.metaTitle) sub.title = o.metaTitle;
    body.appendChild(sub);
  }
  if (o.chips && o.chips.length) {
    const chips = el("div", "gh-row-chips");
    for (const c of o.chips) chips.appendChild(c);
    body.appendChild(chips);
  }
  row.appendChild(body);
  if (o.stats && o.stats.length) {
    const stats = el("div", "gh-row-stats");
    for (const s of o.stats) stats.appendChild(s);
    row.appendChild(stats);
  }
  if (o.onClick) row.addEventListener("click", o.onClick);
  return row;
}

/** A centered spinner + label, shown while a view's data is in flight. */
export function loadingState(text = "Loading…"): HTMLElement {
  const wrap = el("div", "list-loading");
  wrap.append(el("div", "spinner"));
  const t = el("div", "list-loading-label");
  t.textContent = text;
  wrap.appendChild(t);
  return wrap;
}

/** A content-shaped skeleton for a list view — N shimmering rows (an avatar dot
 *  + two text lines). Reads as the real content while data loads, which feels
 *  far faster than a centered spinner. `avatar=false` drops the leading dot. */
export function skeletonList(rows = 7, avatar = true): HTMLElement {
  const wrap = el("div", "sk-list");
  wrap.setAttribute("aria-hidden", "true");
  for (let i = 0; i < rows; i++) {
    const row = el("div", "sk-row");
    if (avatar) row.append(el("div", "sk sk-dot"));
    const lines = el("div", "sk-lines");
    lines.append(el("div", "sk sk-line mid"), el("div", "sk sk-line short"));
    row.appendChild(lines);
    wrap.appendChild(row);
  }
  return wrap;
}

/** A centered error state with an icon and an optional Retry button. */
export function errorState(title: string, desc: string, onRetry?: () => void): HTMLElement {
  const wrap = el("div", "list-empty list-error");
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph("warning"));
  const t = el("div", "list-empty-title");
  t.textContent = title;
  const d = el("div", "list-empty-desc");
  d.textContent = desc;
  wrap.append(badge, t, d);
  if (onRetry) {
    const retry = el("button", "mini-btn list-empty-action");
    retry.append(glyph("refresh"), span("Retry"));
    retry.addEventListener("click", onRetry);
    wrap.appendChild(retry);
  }
  return wrap;
}

/** A titled card (Settings + section views); returns its body to fill. */
export function settingsCard(title: string, icon: string): { card: HTMLElement; body: HTMLElement } {
  const card = el("div", "settings-card");
  const head = el("div", "settings-card-head");
  const t = el("span", "settings-card-title");
  t.textContent = title;
  head.append(glyph(icon), t);
  const body = el("div", "settings-card-body");
  card.append(head, body);
  return { card, body };
}

/** A labeled text field (Settings + composers). */
export function settingsField(
  label: string,
  value: string,
  placeholder: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", "settings-field");
  const l = el("label", "settings-field-label");
  l.textContent = label;
  const input = document.createElement("input");
  input.className = "settings-input";
  input.value = value ?? "";
  input.placeholder = placeholder;
  row.append(l, input);
  return { row, input };
}

/** Copy text to the clipboard with toast feedback. */
export async function copyText(text: string, successMsg = "Copied."): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg, "success");
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
  }
}

/** Clean a user-facing message from an error / rejection (unwraps the IPC prefix). */
export function cleanErr(e: unknown): string {
  let m = e instanceof Error ? e.message : typeof e === "string" ? e : String(e ?? "");
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, "");
  m = m.replace(/^(Uncaught\s+)?(Error|UnhandledPromiseRejection):\s*/i, "");
  return m.trim();
}

/**
 * True for noise the global error boundary should swallow: Monaco's language
 * worker rejecting unimplemented TS/JS service methods (we bundle only the base
 * editor worker, not the language workers) + ResizeObserver loop warnings.
 */
export function isBenignError(message: string, source?: string): boolean {
  const m = message || "";
  if (/Missing requestHandler or method/i.test(m)) return true;
  if (/ResizeObserver loop/i.test(m)) return true;
  if (/Canceled|Canceled: Canceled/i.test(m)) return true;
  if (source && /editor\.worker(\.[a-z0-9]+)?\.js/i.test(source)) return true;
  return false;
}

/** The GitStudio brand mark, inline so it tracks the theme with no asset swap.
 *  The merge-Y lanes terminate in ringed nodes: each node — the three ends and
 *  the centre — is punched with a real hole (an SVG mask cuts through both the
 *  node and the lane beneath, so the bar background shows through on any theme),
 *  giving the lines that "open eyelet" look at every tip, not just the centre. */
export function brandMark(): HTMLElement {
  const s = el("span", "topbar-mark");
  s.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">' +
    "<defs><mask id=\"bm-holes\">" +
    '<rect x="0" y="0" width="24" height="24" fill="#fff"/>' +
    '<circle cx="4.05" cy="7.4" r="0.88" fill="#000"/>' +
    '<circle cx="19.95" cy="7.4" r="0.88" fill="#000"/>' +
    '<circle cx="12" cy="21.2" r="0.88" fill="#000"/>' +
    '<circle cx="12" cy="12" r="1" fill="#000"/>' +
    "</mask></defs>" +
    '<g mask="url(#bm-holes)">' +
    '<path class="bm-cube" d="M12 2.8 L19.95 7.4 L19.95 16.6 L12 21.2 L4.05 16.6 L4.05 7.4 Z" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path class="bm-lane" d="M12 12 L4.05 7.4 M12 12 L19.95 7.4 M12 12 L12 21.2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle class="bm-node" cx="4.05" cy="7.4" r="2.2"/>' +
    '<circle class="bm-node" cx="19.95" cy="7.4" r="2.2"/>' +
    '<circle class="bm-node" cx="12" cy="21.2" r="2.2"/>' +
    '<circle class="bm-node" cx="12" cy="12" r="2.5"/>' +
    "</g>" +
    "</svg>";
  return s;
}

export interface MenuItem {
  label?: string;
  sub?: string;
  icon?: string;
  /** A pre-built leading element (e.g. an avatar) used when `icon` is absent. */
  iconEl?: HTMLElement;
  current?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

/** Tuning for `openMenu`. `searchable` forces the type-to-filter field on (it
 *  otherwise appears only for long menus). */
export interface MenuOpts {
  searchable?: boolean;
}

/** A lightweight popover menu anchored below `anchor`; full keyboard support. */
export function openMenu(anchor: HTMLElement, items: MenuItem[], opts: MenuOpts = {}): void {
  document.querySelectorAll(".dropdown").forEach((n) => n.remove());
  const menu = el("div", "dropdown");
  menu.setAttribute("role", "menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 5)}px`;
  anchor.setAttribute("aria-haspopup", "true");
  anchor.setAttribute("aria-expanded", "true");

  const rows: HTMLElement[] = [];
  const seps: HTMLElement[] = [];

  const close = (restoreFocus = true): void => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus) anchor.focus();
  };
  const onDoc = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  /** Currently visible (not filtered-out) menuitem rows. */
  const visible = (): HTMLElement[] => rows.filter((r) => !r.hidden);
  const focusAt = (i: number): void => {
    const vis = visible();
    if (!vis.length) return;
    const idx = ((i % vis.length) + vis.length) % vis.length;
    vis[idx].focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    const vis = visible();
    const cur = vis.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(cur < 0 ? 0 : cur + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(cur < 0 ? vis.length - 1 : cur - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(vis.length - 1);
    } else if ((e.key === "Enter" || (e.key === " " && cur >= 0))) {
      // Enter from the search field activates the first match.
      if (cur >= 0) {
        e.preventDefault();
        vis[cur].click();
      } else if (e.key === "Enter" && vis.length) {
        e.preventDefault();
        vis[0].click();
      }
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  for (const it of items) {
    if (it.separator) {
      const sep = el("div", "dropdown-sep");
      sep.setAttribute("role", "separator");
      if (it.label) sep.textContent = it.label;
      menu.appendChild(sep);
      seps.push(sep);
      continue;
    }
    const row = el(
      "button",
      "dropdown-item" + (it.current ? " is-current" : "") + (it.disabled ? " is-disabled" : ""),
    );
    row.setAttribute("role", "menuitem");
    row.tabIndex = -1;
    if (it.disabled) row.setAttribute("aria-disabled", "true");
    if (it.current) row.setAttribute("aria-current", "true");
    if (it.icon) row.appendChild(glyph(it.icon));
    else if (it.iconEl) row.appendChild(it.iconEl);
    const label = el("span", "dropdown-label");
    label.textContent = it.label ?? "";
    row.appendChild(label);
    if (it.sub) {
      const sub = el("span", "dropdown-sub");
      sub.textContent = it.sub;
      row.appendChild(sub);
    }
    if (it.current) row.appendChild(glyph("check"));
    if (!it.disabled && it.onClick) {
      row.addEventListener("click", () => {
        close(false);
        it.onClick!();
      });
      rows.push(row);
    }
    menu.appendChild(row);
  }

  // For long menus (e.g. the branch switcher), add a live filter at the top so
  // the user can type to narrow instead of scrolling a wall of branches. Callers
  // (the Projects/Orgs header pickers) can force it on for any length.
  const searchable = opts.searchable ?? rows.length > 9;
  let search: HTMLInputElement | undefined;
  if (searchable) {
    const wrap = el("div", "dropdown-search-wrap");
    search = document.createElement("input");
    search.className = "dropdown-search";
    search.type = "text";
    search.placeholder = "Filter…";
    search.setAttribute("aria-label", "Filter menu");
    search.spellcheck = false;
    const labelOf = (r: HTMLElement): string =>
      (r.querySelector(".dropdown-label")?.textContent ?? "").toLowerCase();
    search.addEventListener("input", () => {
      const q = search!.value.trim().toLowerCase();
      for (const r of rows) r.hidden = !!q && !labelOf(r).includes(q);
      // Hide section separators while filtering (they'd float without context).
      for (const s of seps) s.hidden = !!q;
    });
    wrap.appendChild(search);
    menu.insertBefore(wrap, menu.firstChild);
  }

  document.body.appendChild(menu);
  const mr = menu.getBoundingClientRect();
  if (mr.right > window.innerWidth - 8) {
    menu.style.left = `${Math.round(window.innerWidth - mr.width - 8)}px`;
  }
  if (mr.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.round(Math.max(8, rect.top - mr.height - 5))}px`;
  }
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    // Searchable menus focus the filter (type-to-narrow); others land on current.
    if (search) search.focus();
    else focusAt(Math.max(0, rows.findIndex((r) => r.classList.contains("is-current"))));
  }, 0);
}

/**
 * Make a drag-to-resize divider operable by keyboard and legible to assistive
 * tech. Adds role="separator", the orientation, an accessible label, and a live
 * aria-valuenow, and wires arrow keys (Home/End jump to the min/max) to nudge
 * the size. The element keeps its existing pointer-drag behaviour; this only
 * adds the keyboard + ARIA layer.
 *
 * `orientation` is the orientation of the divider line itself: "vertical" for a
 * left/right splitter (Right grows the left pane), "horizontal" for a bottom-
 * anchored top/bottom splitter (Up grows the lower pane). Shift = larger step;
 * Home/End jump to the min/max.
 */
export function wireResizerKeys(
  handle: HTMLElement,
  opts: {
    orientation: "vertical" | "horizontal";
    label: string;
    min: number;
    max: () => number;
    get: () => number;
    set: (v: number) => void;
    step?: number;
    onCommit?: () => void;
    disabled?: () => boolean;
  },
): void {
  const step = opts.step ?? 16;
  handle.removeAttribute("aria-hidden");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", opts.orientation);
  handle.setAttribute("aria-label", opts.label);
  handle.tabIndex = 0;
  const sync = (): void => {
    handle.setAttribute("aria-valuemin", String(Math.round(opts.min)));
    handle.setAttribute("aria-valuemax", String(Math.round(opts.max())));
    handle.setAttribute("aria-valuenow", String(Math.round(opts.get())));
  };
  sync();
  handle.addEventListener("keydown", (e: KeyboardEvent) => {
    if (opts.disabled?.()) return;
    // vertical divider: Right grows the left pane. horizontal divider (bottom-
    // anchored): Up grows the lower pane.
    const dec = opts.orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
    const inc = opts.orientation === "vertical" ? "ArrowRight" : "ArrowUp";
    let next: number | undefined;
    if (e.key === dec) next = opts.get() - (e.shiftKey ? step * 3 : step);
    else if (e.key === inc) next = opts.get() + (e.shiftKey ? step * 3 : step);
    else if (e.key === "Home") next = opts.min;
    else if (e.key === "End") next = opts.max();
    if (next === undefined) return;
    e.preventDefault();
    opts.set(Math.max(opts.min, Math.min(opts.max(), next)));
    sync();
    opts.onCommit?.();
  });
  // Keep aria-valuenow honest after a pointer drag, too.
  handle.addEventListener("pointerup", () => sync());
}
