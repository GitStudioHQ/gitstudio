// The Notifications section view — the user's GitHub inbox. A single-pane LIST
// view (like Actions / Projects, not the two-pane gh-list/gh-detail): each row
// IS the unit of interaction (open the subject + per-row mark-read), with two
// inbox-wide actions in the header (a "Show all / Unread only" toggle and
// "Mark all read"). Notifications are ACCOUNT-scoped, so the gate does NOT
// require a github.com repo (NEEDS_REPO = false).

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  pill,
  relTimeISO,
  absTimeISO,
  skeletonList,
  loadingState,
  statePill,
  errorState,
  emptyState,
  cleanErr,
  openMenu,
  textBtn,
  ghRow,
  parseGitHubItemUrl,
} from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { ghGate, ghHeader, type SectionRender, type SectionNav } from "./common";
import type { NotificationThread } from "../../shared/ipc";

/** Persisted across re-renders of this view: include already-read threads? */
let notifAll = false;

/** The dismiss handle for the open notifications popover (so the bell toggles). */
let closePanel: (() => void) | null = null;

export const renderNotifications: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  // Gate first (NEEDS_REPO = false — the inbox is account-wide).
  const gate = await ghGate(wrap, nav, false);
  if (!gate) return;

  const refresh = (): void => renderNotifications(wrap, nav);

  // The in-app issue/PR views are scoped to the CURRENT repo, so a notification
  // can only deep-link in-app when it belongs to that repo (else it's genuinely
  // another repo and "Open" still goes to GitHub). Resolve the current slug once.
  let currentRepo: string | undefined;
  try {
    const status = await host.invoke("github:status", undefined);
    if (status.repo) currentRepo = `${status.repo.owner}/${status.repo.repo}`.toLowerCase();
  } catch {
    /* no current repo / not connected — every Open falls back to GitHub */
  }

  const view = el("div", "list-view notif-view");

  // Header: title + signed-in @login + a refresh, then splice in the inbox-wide
  // action cluster (toggle + mark-all-read) so the chrome matches the other
  // section views while exposing the actions unique to a list-of-actions view.
  const header = ghHeader("Notifications", gate.login, refresh);
  const actions = el("div", "notif-actions");

  const toggleBtn = el("button", "row-btn notif-toggle");
  toggleBtn.textContent = notifAll ? "Unread only" : "Show all";
  toggleBtn.title = notifAll ? "Show only unread threads" : "Include already-read threads";
  toggleBtn.addEventListener("click", () => {
    notifAll = !notifAll;
    refresh();
  });

  const markAllBtn = el("button", "mini-btn notif-markall");
  markAllBtn.append(glyph("check-all"), span("Mark all read"));
  markAllBtn.title = "Mark all read";
  markAllBtn.addEventListener("click", () => void markAllRead(markAllBtn, refresh));

  actions.append(toggleBtn, markAllBtn);
  // ghHeader returns a flex row: [title] [.gh-acct]. Insert the action cluster
  // just before the account block so it reads: title … [actions] @login ↻.
  const acct = header.querySelector(".gh-acct");
  if (acct) header.insertBefore(actions, acct);
  else header.appendChild(actions);

  view.appendChild(header);
  const body = el("div", "list-body notif-body");
  view.appendChild(body);
  wrap.replaceChildren(view);

  // Load.
  body.replaceChildren(skeletonList(6));
  let threads: NotificationThread[];
  try {
    threads = await host.invoke("notifications:list", { all: notifAll, participating: false });
  } catch (e) {
    // The gate already confirmed a connection; a throw here is a real API error
    // (auth / rate limit / network) — show an error state with Retry, never a
    // misleading "inbox zero".
    if (!body.isConnected) return;
    body.replaceChildren(
      errorState("Couldn't load notifications", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }
  if (!body.isConnected) return;

  // Keep the "Mark all read" affordance honest: nothing unread → nothing to do.
  const unreadCount = threads.filter((t) => t.unread).length;
  (markAllBtn as HTMLButtonElement).disabled = unreadCount === 0;
  // The header count reflects what's actionable: unread threads.
  header.setCount?.(unreadCount);

  if (threads.length === 0) {
    body.replaceChildren(
      emptyState(
        notifAll ? "Inbox zero" : "You're all caught up",
        notifAll
          ? "You have no notifications."
          : "No unread notifications right now — nothing needs your attention.",
        { icon: "bell" },
      ),
    );
    return;
  }

  body.replaceChildren();
  body.appendChild(notifSummary(threads.length, unreadCount));
  for (const t of threads) {
    body.appendChild(notificationRow(t, body, refresh, nav, currentRepo));
  }
}

// ── Top-bar notification center (the bell popover, next to the profile) ────────

/**
 * The unread-thread count for the bell badge in the top bar. Returns 0 when not
 * connected or on any error — the badge simply stays hidden, never a broken state.
 */
export async function fetchUnreadCount(): Promise<number> {
  try {
    const threads = await host.invoke("notifications:list", { all: false, participating: false });
    return threads.filter((t) => t.unread).length;
  } catch {
    return 0;
  }
}

/**
 * Open (or, if already open, close) the notifications center as a floating panel
 * anchored to the bell in the top bar. Reuses the full inbox renderer — list,
 * per-row + inbox-wide mark-read, the show-all toggle — inside a popover, so the
 * bell IS the notification center. `nav` routes the connect prompt to Settings;
 * `onClose` lets the caller refresh the bell's unread badge after a dismiss.
 */
export function openNotificationsPanel(
  anchor: HTMLElement,
  nav: SectionNav,
  onClose?: () => void,
): void {
  // Toggle: a second click on the bell (or while open) closes the panel.
  if (closePanel) {
    closePanel();
    return;
  }

  const panel = el("div", "notif-pop");
  const inner = el("div", "notif-pop-inner");
  panel.appendChild(inner);
  document.body.appendChild(panel);

  const position = (): void => {
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth || 424;
    const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
  };

  const onDoc = (e: MouseEvent): void => {
    const t = e.target as Node;
    if (!panel.contains(t) && t !== anchor && !anchor.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const close = (): void => {
    panel.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", position);
    anchor.setAttribute("aria-expanded", "false");
    closePanel = null;
    onClose?.();
  };
  closePanel = close;

  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "true");

  // Render the inbox into the panel; the connect prompt's "Sign in" closes the
  // panel before routing to Settings so we don't leave a popover floating.
  renderNotifications(inner, (v, target) => {
    close();
    nav(v, target);
  });

  position();
  setTimeout(() => {
    position();
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", position);
  }, 0);
}

/** Open a read-only, in-app viewer for an issue/PR in ANY repo (so a notification
 *  for a different repository still opens INSIDE GitStudio, not github.com). */
export function openExternalItem(o: {
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
  htmlUrl: string;
}): void {
  const overlay = el("div", "modal-overlay");
  const card = el("div", "modal-card modal-card-form ext-item");
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  card.appendChild(loadingState("Loading…"));
  void (async () => {
    let item;
    try {
      item = await host.invoke("github:externalItem", {
        owner: o.owner, repo: o.repo, number: o.number, kind: o.kind,
      });
    } catch {
      /* fall through to the unavailable state */
    }
    if (!overlay.isConnected) return;
    card.replaceChildren();
    if (!item) {
      card.appendChild(
        errorState("Couldn't load this item", `${o.owner}/${o.repo} #${o.number} couldn't be fetched.`),
      );
      const foot = el("div", "modal-actions");
      const gh = el("button", "mini-btn");
      gh.append(glyph("link-external"), span("Open on GitHub"));
      gh.addEventListener("click", () => { window.open(o.htmlUrl, "_blank", "noopener"); close(); });
      const cls = el("button", "btn btn-primary modal-ok");
      cls.appendChild(span("Close"));
      cls.addEventListener("click", close);
      foot.append(gh, cls);
      card.appendChild(foot);
      return;
    }
    // Header: state pill + repo · #number, then the title.
    const head = el("div", "ext-item-head");
    const stateKind = item.kind === "pull"
      ? item.state === "merged" ? "merged" : item.state === "draft" ? "draft" : item.state === "closed" ? "closed" : "open-pr"
      : item.state === "closed" ? "closed" : "open";
    head.appendChild(statePill(item.state === "open" ? (item.kind === "pull" ? "Open" : "Open") : item.state.charAt(0).toUpperCase() + item.state.slice(1), stateKind));
    const sub = el("span", "ext-item-sub");
    sub.textContent = `${item.repo} #${item.number}${item.author ? ` · ${item.author}` : ""}${item.createdAt ? ` · ${relTimeISO(item.createdAt)}` : ""}`;
    if (item.createdAt) sub.title = absTimeISO(item.createdAt);
    head.appendChild(sub);
    const title = el("div", "ext-item-title");
    title.textContent = item.title;
    card.append(head, title);

    // Body (markdown) + comments — read only.
    const scroll = el("div", "ext-item-scroll");
    const body = el("div", "gh-body-md");
    if (item.body && item.body.trim()) body.innerHTML = renderMarkdown(item.body);
    else { body.classList.add("gh-empty-body"); body.textContent = "No description provided."; }
    scroll.appendChild(body);
    for (const c of item.comments) {
      const cm = el("div", "gh-comment");
      const ch = el("div", "gh-comment-head");
      ch.append(span(c.author ?? "someone"), span(`commented · ${relTimeISO(c.createdAt)}`, "gh-comment-when"));
      const cb = el("div", "gh-body-md");
      cb.innerHTML = renderMarkdown(c.body || "");
      cm.append(ch, cb);
      scroll.appendChild(cm);
    }
    card.appendChild(scroll);

    const foot = el("div", "modal-actions");
    const gh = el("button", "mini-btn");
    gh.append(glyph("link-external"), span("Open on GitHub"));
    gh.addEventListener("click", () => { window.open(item!.htmlUrl, "_blank", "noopener"); });
    const cls = el("button", "btn btn-primary modal-ok");
    cls.appendChild(span("Close"));
    cls.addEventListener("click", close);
    foot.append(gh, cls);
    card.appendChild(foot);
  })();
}

/** A small count summary above the list (e.g. "12 threads · 3 unread"). */
function notifSummary(total: number, unread: number): HTMLElement {
  const row = el("div", "notif-summary");
  row.appendChild(glyph(unread > 0 ? "bell-dot" : "inbox"));
  const parts = `${total} ${total === 1 ? "thread" : "threads"}` + (unread > 0 ? ` · ${unread} unread` : "");
  row.appendChild(span(parts, "notif-summary-text"));
  return row;
}

/** One inbox row in the rich `ghRow` shape: an accent-wrapped subject-type icon
 *  (prefixed by an unread dot), a bold/muted title, a `repo · reason · time` meta
 *  line, a subject-type pill, and a hover-revealed Open / Mark-read cluster.
 *  Unread rows lead with the accent dot + a foreground title; read rows recede. */
function notificationRow(
  t: NotificationThread,
  body: HTMLElement,
  refresh: () => void,
  nav: SectionNav,
  currentRepo?: string,
): HTMLElement {
  // Leading: unread dot (when unread) + the subject-type glyph. We reuse the
  // existing .notif-lead/.notif-dot styling so unread emphasis + the read-state
  // icon dimming keep working inside the gh-row lead slot.
  const lead = el("span", "notif-lead");
  if (t.unread) lead.appendChild(el("span", "notif-dot"));
  lead.appendChild(glyph(notifIcon(t.type)));

  const when = relTimeISO(t.updatedAt);
  const meta =
    `${t.repo}` +
    (t.reason ? ` · ${notifReasonLabel(t.reason)}` : "") +
    (when ? ` · ${when}` : "");

  const row = ghRow({
    lead,
    title: t.title || "(untitled)",
    titleSuffix: t.type ? [pill(notifTypeLabel(t.type), "notif-type")] : [],
    meta,
    metaTitle: t.updatedAt ? `Updated ${absTimeISO(t.updatedAt)}` : undefined,
    ariaLabel: `${notifTypeLabel(t.type)} notification: ${t.title || "(untitled)"}${t.unread ? " (unread)" : ""}`,
  });
  // ghRow returns a <div> here (no onClick passed). Tag it as an inbox row so the
  // read/unread emphasis CSS applies, and as a .list-row so the existing
  // `.list-row:hover .row-actions` reveal lights up the Open / Mark-read cluster
  // (gh-row-rich's later layout rules still win on padding/radius/alignment).
  row.classList.add("notif-row", "list-row");
  if (!t.unread) {
    row.classList.add("notif-read");
    row.style.opacity = "0.72";
  }

  // Open the subject IN-APP. Current-repo issues/PRs deep-link into the full
  // Issues/PRs view (you can act on them); OTHER repos open a read-only in-app
  // viewer. Only genuinely non-issue/PR subjects (commits/discussions/releases)
  // fall back to github.com.
  const item = parseGitHubItemUrl(t.htmlUrl);
  const sameRepo = item && currentRepo && item.repo === currentRepo;
  const openable = !!item; // any issue/PR can be read in-app
  const open = (): void => {
    if (sameRepo && item) {
      nav(item.kind, { number: item.number });
    } else if (item) {
      const [owner, repo] = item.repo.split("/");
      openExternalItem({ owner, repo, number: item.number, kind: item.kind === "prs" ? "pull" : "issue", htmlUrl: t.htmlUrl });
    } else if (t.htmlUrl) {
      window.open(t.htmlUrl, "_blank", "noopener");
    } else {
      toast("This notification has no openable subject.", "info");
    }
  };

  // Right-side action cluster (hover-revealed via .row-actions, like other rows).
  const acts = el("div", "row-actions");
  acts.appendChild(textBtn("Open", openable ? "Open in GitStudio" : "Open the subject on GitHub", open));
  if (t.unread) {
    acts.appendChild(
      textBtn("Mark read", "Mark this thread as read", () => void markRead(t, row, body, refresh)),
    );
  }
  row.appendChild(acts);

  // Whole-row click opens the subject (matches Actions / Projects rows). The
  // action buttons stopPropagation (textBtn does), so they don't double-fire.
  row.addEventListener("click", open);

  // Right-click → a context menu mirroring the row actions.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu(row, [
      { label: "Open on GitHub", icon: "link-external", onClick: open },
      ...(t.unread
        ? [{ label: "Mark as read", icon: "mail-read", onClick: () => void markRead(t, row, body, refresh) }]
        : []),
    ]);
  });

  return row;
}

/** Mark one thread read: optimistic in place, then reconcile the empty state. */
async function markRead(
  t: NotificationThread,
  row: HTMLElement,
  body: HTMLElement,
  refresh: () => void,
): Promise<void> {
  if (row.classList.contains("is-busy")) return;
  row.classList.add("is-busy");
  try {
    const r = await host.invoke("notification:markRead", { id: t.id });
    if (!r.ok) {
      toast(r.message ?? "Couldn't mark the notification read.", "error");
      return;
    }
    t.unread = false;
    if (!notifAll) {
      // "Unread only" filter active → the row no longer belongs; drop it.
      row.remove();
      if (body.querySelectorAll(".notif-row").length === 0) refresh();
    } else {
      // "Show all" → flip the row to its read style in place: recede it, drop
      // the unread dot, and remove the now-irrelevant "Mark read" action.
      row.classList.add("notif-read");
      row.style.opacity = "0.72";
      row.querySelector(".notif-dot")?.remove();
      row.querySelectorAll<HTMLElement>(".row-actions .row-btn").forEach((b) => {
        if (b.textContent === "Mark read") b.remove();
      });
    }
    // Keep the summary + "Mark all read" in sync after the in-place change.
    const unread = body.querySelectorAll(".notif-dot").length;
    const total = body.querySelectorAll(".notif-row").length;
    const sumEl = document.querySelector(".notif-summary-text");
    if (sumEl) {
      sumEl.textContent =
        `${total} ${total === 1 ? "thread" : "threads"}` + (unread > 0 ? ` · ${unread} unread` : "");
    }
    const markAll = document.querySelector<HTMLButtonElement>(".notif-markall");
    if (markAll) markAll.disabled = unread === 0;
    // Keep the header's unread count pill honest after the in-place change.
    const countPill = document.querySelector<HTMLElement>(".gh-head-count");
    if (countPill) {
      countPill.textContent = String(unread);
      countPill.hidden = false;
    }
    toast("Marked as read.", "success");
  } catch (e) {
    toast(cleanErr(e) || "Couldn't mark the notification read.", "error");
  } finally {
    row.classList.remove("is-busy");
  }
}

/** Mark the whole inbox read (confirmed; destructive-ish). */
async function markAllRead(btn: HTMLElement, refresh: () => void): Promise<void> {
  const button = btn as HTMLButtonElement;
  if (button.disabled) return;
  const ok = await confirmDialog({
    title: "Mark all notifications as read?",
    message: "This marks every notification in your inbox as read on GitHub.",
    confirmLabel: "Mark all read",
  });
  if (!ok) return;
  button.disabled = true;
  try {
    const r = await host.invoke("notifications:markAllRead", undefined);
    if (!r.ok) {
      toast(r.message ?? "Couldn't mark all read.", "error");
      button.disabled = false;
      return;
    }
    toast("Marked all notifications as read.", "success");
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't mark all read.", "error");
    button.disabled = false;
  }
}

// ── Pure mapping helpers (subject type / reason → glyph + human label) ─────────

/** A codicon name for a notification subject type. */
function notifIcon(type: string): string {
  switch (type) {
    case "PullRequest":
      return "git-pull-request";
    case "Issue":
      return "issue-opened";
    case "Release":
      return "tag";
    case "Discussion":
      return "comment-discussion";
    case "Commit":
      return "git-commit";
    default:
      return "bell";
  }
}

/** A short human label for a subject type. */
function notifTypeLabel(type: string): string {
  switch (type) {
    case "PullRequest":
      return "PR";
    case "Issue":
      return "Issue";
    case "Release":
      return "Release";
    case "Discussion":
      return "Discussion";
    case "Commit":
      return "Commit";
    default:
      return type || "Thread";
  }
}

/** A human label for GitHub's notification `reason`. */
function notifReasonLabel(reason: string): string {
  switch (reason) {
    case "assign":
      return "assigned";
    case "author":
      return "you authored";
    case "comment":
      return "new comment";
    case "ci_activity":
      return "CI activity";
    case "invitation":
      return "invitation";
    case "manual":
      return "subscribed";
    case "mention":
      return "mentioned";
    case "review_requested":
      return "review requested";
    case "security_alert":
      return "security alert";
    case "state_change":
      return "state changed";
    case "subscribed":
      return "watching";
    case "team_mention":
      return "team mentioned";
    default:
      return reason.replace(/_/g, " ");
  }
}
