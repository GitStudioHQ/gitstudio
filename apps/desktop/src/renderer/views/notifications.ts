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
  errorState,
  emptyState,
  cleanErr,
  openMenu,
  textBtn,
  ghRow,
} from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { ghGate, ghHeader, type SectionRender } from "./common";
import type { NotificationThread } from "../../shared/ipc";

/** Persisted across re-renders of this view: include already-read threads? */
let notifAll = false;

export const renderNotifications: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  // Gate first (NEEDS_REPO = false — the inbox is account-wide).
  const gate = await ghGate(wrap, nav, false);
  if (!gate) return;

  const refresh = (): void => renderNotifications(wrap, nav);

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
    body.appendChild(notificationRow(t, body, refresh));
  }
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

  const open = (): void => {
    if (t.htmlUrl) window.open(t.htmlUrl, "_blank", "noopener");
    else toast("This notification has no openable subject.", "info");
  };

  // Right-side action cluster (hover-revealed via .row-actions, like other rows).
  const acts = el("div", "row-actions");
  acts.appendChild(textBtn("Open", "Open the subject on GitHub", open));
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
