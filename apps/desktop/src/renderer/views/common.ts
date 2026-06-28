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
