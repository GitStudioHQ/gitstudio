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
 * rules. NOTE: the desktop ships a CURATED codicon subset (each `.codicon-NAME`
 * codepoint is hand-defined in app.css) — a name not in that list renders BLANK,
 * so add the codepoint to app.css before using a new glyph.
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

/** Relative time from an ISO-8601 string; "" when missing or unparseable. */
export function relTimeISO(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relTime(ms / 1000);
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
export function emptyState(title: string, desc: string): HTMLElement {
  const wrap = el("div", "list-empty");
  const t = el("div", "list-empty-title");
  t.textContent = title;
  const d = el("div", "list-empty-desc");
  d.textContent = desc;
  wrap.append(t, d);
  return wrap;
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

/** The GitStudio brand mark, inline so it tracks the theme with no asset swap. */
export function brandMark(): HTMLElement {
  const s = el("span", "topbar-mark");
  s.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">' +
    '<path class="bm-cube" d="M12 2.8 L19.95 7.4 L19.95 16.6 L12 21.2 L4.05 16.6 L4.05 7.4 Z" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path class="bm-lane" d="M12 12 L4.05 7.4 M12 12 L19.95 7.4 M12 12 L12 21.2" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle class="bm-node" cx="4.05" cy="7.4" r="1.5"/>' +
    '<circle class="bm-node" cx="19.95" cy="7.4" r="1.5"/>' +
    '<circle class="bm-node" cx="12" cy="21.2" r="1.5"/>' +
    '<circle class="bm-node" cx="12" cy="12" r="2.1"/>' +
    '<circle class="bm-core" cx="12" cy="12" r="0.85"/>' +
    "</svg>";
  return s;
}

export interface MenuItem {
  label?: string;
  sub?: string;
  icon?: string;
  current?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

/** A lightweight popover menu anchored below `anchor`; full keyboard support. */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  document.querySelectorAll(".dropdown").forEach((n) => n.remove());
  const menu = el("div", "dropdown");
  menu.setAttribute("role", "menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 5)}px`;
  anchor.setAttribute("aria-haspopup", "true");
  anchor.setAttribute("aria-expanded", "true");

  const rows: HTMLElement[] = [];

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
  const focusAt = (i: number): void => {
    if (!rows.length) return;
    const idx = ((i % rows.length) + rows.length) % rows.length;
    rows[idx].focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(cur < 0 ? 0 : cur + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(cur < 0 ? rows.length - 1 : cur - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(rows.length - 1);
    } else if ((e.key === "Enter" || e.key === " ") && cur >= 0) {
      e.preventDefault();
      rows[cur].click();
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
    focusAt(Math.max(0, rows.findIndex((r) => r.classList.contains("is-current"))));
  }, 0);
}
