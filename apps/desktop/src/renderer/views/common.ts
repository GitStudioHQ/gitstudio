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
  d.textContent = "Sign in to use this section.";
  const go = el("button", "btn btn-primary list-empty-action");
  go.append(glyph("github"), span("Sign in in Settings"));
  go.addEventListener("click", () => nav("settings"));
  wrap.append(badge, t, d, go);
  return wrap;
}

/** The standard GitHub-section header: title + signed-in @login + a refresh. */
export function ghHeader(title: string, login: string | undefined, onRefresh: () => void): HTMLElement {
  const headRow = el("div", "list-head list-head-row");
  const t = el("div", "list-head-title");
  t.textContent = title;
  const right = el("div", "gh-acct");
  if (login) {
    const who = el("span", "gh-who");
    who.textContent = `@${login}`;
    right.appendChild(who);
  }
  const refresh = el("button", "topbar-icon");
  refresh.title = "Refresh";
  refresh.appendChild(glyph("refresh"));
  refresh.addEventListener("click", onRefresh);
  right.appendChild(refresh);
  headRow.append(t, right);
  return headRow;
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
