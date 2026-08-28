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
  subLink,
  parseGitHubItemUrl,
} from "../ui";
import { toast, confirmDialog, openModal } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { registerLayer } from "../overlays";
import { openRemoteRepoBrowser } from "../repoBrowser";
import {
  facetBar,
  blankable,
  ghGate,
  segmented,
  ghHeader,
  harvestValues,
  searchField,
  wireListNav,
  type FacetState,
  type SectionRender,
  type SectionNav,
} from "./common";
import type { NotificationThread } from "../../shared/ipc";

/** Persisted across re-renders of this view: include already-read threads? */
let notifAll = false;
/** Inbox text query — the only one of the four lists that had no search. */
let notifQuery = "";
/** Inbox facets (type / reason / repo), kept across refreshes. */
const notifFacets: FacetState = {};

/** The dismiss handle for the open notifications popover (so the bell toggles). */
let closePanel: ((restoreFocus?: boolean) => void) | null = null;

export const renderNotifications: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const refresh = (): void => renderNotifications(wrap, nav);
  // Gate first (NEEDS_REPO = false — the inbox is account-wide).
  const gate = await ghGate(wrap, nav, false, refresh);
  if (!gate) return;

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
  const header = ghHeader("Inbox", gate.login, refresh);
  const actions = el("div", "notif-actions");

  // A segment shows which mode you are IN. The old button was labelled with the
  // action it would perform ("Show all"), styled identically in both states, so
  // nothing on screen said whether you were looking at everything or not.
  const toggleBtn = segmented<"unread" | "all">({
    options: [
      { value: "unread", label: "Unread" },
      { value: "all", label: "All" },
    ],
    value: notifAll ? "all" : "unread",
    ariaLabel: "Which notifications to show",
    onChange: (v) => {
      notifAll = v === "all";
      refresh();
    },
  });

  const markAllBtn = el("button", "mini-btn notif-markall");
  markAllBtn.append(glyph("check-all"), span("Mark all read"));
  markAllBtn.title = "Mark all read";
  markAllBtn.addEventListener("click", () => void markAllRead(markAllBtn, refresh));

  // Type / reason facets over the fetched inbox — triage is exactly "show me
  // only the review requests", and scrolling for them is not triage.
  const facets = facetBar<NotificationThread>({
    specs: [
      {
        key: "type",
        label: "Type",
        icon: "inbox",
        anyLabel: "Anything",
        harvest: harvestValues<NotificationThread>((t) => t.type, notifTypeLabel),
        predicate: (t, v) => t.type === v,
      },
      {
        key: "reason",
        label: "Reason",
        icon: "question",
        anyLabel: "Any reason",
        harvest: harvestValues<NotificationThread>((t) => t.reason, notifReasonLabel),
        predicate: (t, v) => t.reason === v,
      },
      {
        key: "repo",
        label: "Repo",
        icon: "repo",
        anyLabel: "All repos",
        harvest: harvestValues<NotificationThread>((t) => t.repo),
        predicate: (t, v) => t.repo === v,
      },
    ],
    state: notifFacets,
    items: [],
    onChange: () => renderThreads(),
  });

  // The facet bar belongs to the full Inbox page. In the 520px bell popover it
  // pushed the refresh button onto a second line, leaving a 40px band that was
  // 90% empty — and filtering is not what a glance at the bell is for.
  const inPopover = !!wrap.closest(".notif-pop");
  // Every sibling list has a search field; the Inbox's header was a title on
  // the far left and a control cluster on the far right with a gap between.
  if (!inPopover) {
    header.querySelector(".gh-head-titlewrap")?.appendChild(
      searchField({
        placeholder: "Search notifications…",
        initial: notifQuery,
        onInput: (q) => {
          notifQuery = q;
          renderThreads();
        },
      }),
    );
  }
  if (!inPopover) actions.appendChild(facets.el);
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

  // Keyboard triage: ↑/↓ move, Enter opens (wireListNav), and `e` archives —
  // marks the focused row's thread read, the way every inbox does it.
  wireListNav(body, ".notif-row");
  const rowThreads = new Map<HTMLElement, NotificationThread>();
  body.addEventListener("keydown", (ev) => {
    if (ev.key !== "e" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const row = (document.activeElement as HTMLElement | null)?.closest?.(".notif-row") as HTMLElement | null;
    const t = row ? rowThreads.get(row) : undefined;
    if (!row || !t || !t.unread) return;
    ev.preventDefault();
    void markRead(t, row, body, refresh);
  });

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
  // Keep the top-bar bell in step with what the Inbox actually loaded — the
  // badge said 3 while the panel header said 4, 200px apart.
  window.dispatchEvent(new CustomEvent("gs:unread", { detail: unreadCount }));
  facets.sync(threads);

  const renderThreads = (): void => {
    const q = notifQuery.trim().toLowerCase();
    const shown = threads.filter(
      (t) =>
        facets.passes(t) &&
        (q
          ? `${t.title} ${t.repo} ${notifReasonLabel(t.reason)} ${notifTypeLabel(t.type)}`
              .toLowerCase()
              .includes(q)
          : true),
    );
    // Same contract as every other list: the badge counts what's on screen.
    header.setCount?.(shown.length, threads.length);
    body.replaceChildren();
    if (shown.length === 0) {
      const filtered = facets.activeCount() > 0 || !!q;
      body.appendChild(
        emptyState(
          filtered ? "No matching notifications" : notifAll ? "Inbox zero" : "You're all caught up",
          filtered
            ? q
              ? `Nothing in your inbox matches “${notifQuery.trim()}”.`
              : "Nothing in your inbox matches these filters."
            : notifAll
              ? "You have no notifications."
              : "No unread notifications right now — nothing needs your attention.",
          {
            icon: filtered ? "filter" : "bell",
            // A filtered-empty inbox answers a question you asked in the
            // toolbar; an unfiltered-empty one is the whole view's state.
            anchor: filtered ? "inline" : "hero",
          secondary: facets.activeCount() > 0
            ? { label: "Clear filters", icon: "clear-all", onClick: () => facets.clear() }
            : undefined,
          },
        ),
      );
      return;
    }
    // (The "N threads · M unread" summary line used to live here; the header
    // badge already says how many are shown, so it was the same fact twice.)
    for (const t of shown) {
      const row = notificationRow(t, body, refresh, nav, currentRepo);
      rowThreads.set(row, t);
      // Rows are plain divs — focusable so ↑/↓ traversal and `e` work on them.
      row.tabIndex = -1;
      body.appendChild(row);
    }
  };

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

  renderThreads();
}

// ── Top-bar notification center (the bell popover, next to the profile) ────────

/**
 * The unread-thread count for the bell badge in the top bar. Returns 0 when not
 * connected or on any error — the badge simply stays hidden, never a broken state.
 */
export async function fetchUnreadCount(): Promise<number> {
  try {
    // The AMBIENT channel: it never unlocks the stored token, so the badge
    // refreshing on launch cannot raise a keychain prompt. It reports 0 until
    // something the user actually asked for has unlocked the token.
    return await host.invoke("notifications:unreadCount", undefined);
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
    closePanel(true);
    return;
  }

  const panel = el("div", "notif-pop");
  // A floating panel of interactive rows that announced itself as a plain div:
  // no role, no name, and focus left behind on the bell, so a keyboard user
  // could open it and then Tab through the whole page before reaching it.
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Notifications");
  panel.tabIndex = -1;
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
      close(true);
    }
  };
  let closed = false;
  const close = (restoreFocus = false): void => {
    if (closed) return;
    closed = true;
    layer.release();
    panel.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", position);
    anchor.setAttribute("aria-expanded", "false");
    closePanel = null;
    if (restoreFocus && anchor.isConnected) anchor.focus();
    onClose?.();
  };
  closePanel = close;
  const layer = registerLayer(close);

  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "true");

  // Render the inbox into the panel; the connect prompt's "Sign in" closes the
  // panel before routing to Settings so we don't leave a popover floating.
  renderNotifications(inner, (v, target) => {
    close();
    nav(v, target);
  });

  position();
  // Move into the panel so the keyboard is where the eye is; Escape hands focus
  // straight back to the bell.
  (panel.querySelector<HTMLElement>("button, [tabindex='0'], a[href]") ?? panel).focus();
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
  const card = el("div", "modal-card modal-card-form ext-item");
  card.tabIndex = -1;
  let close = (): void => {};
  openModal((c) => {
    close = c;
    return {
      card,
      focusEl: card,
      label: `${o.owner}/${o.repo} #${o.number}`,
      onClose: () => {},
    };
  });

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
    if (!card.isConnected) return;
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
  // The unread dot ALWAYS takes its space — hidden, not absent, on read rows.
  // Omitting it shifted every read row 14px left of its unread neighbours, so
  // the list had two different left edges.
  const dot = el("span", "notif-dot");
  if (!t.unread) dot.classList.add("is-read");
  lead.appendChild(dot);
  lead.appendChild(glyph(notifIcon(t.type)));

  const when = relTimeISO(t.updatedAt);
  const aria = `${notifTypeLabel(t.type)} notification: ${t.title || "(untitled)"}${t.unread ? " (unread)" : ""}`;
  // The repo name is a door, not a label: browse that repo in-app.
  const repoLink = (): HTMLElement =>
    // The full Explore page, not the peek stack: from an inbox row, "what IS
    // this repo?" deserves breadcrumbs, a README and a way to open it.
    subLink(t.repo, `Explore ${t.repo} in GitStudio`, () =>
      nav ? nav("explore", { id: `repo/${t.repo}` }) : openRemoteRepoBrowser(t.repo),
    );

  // Two shapes, one behavior: the FULL inbox page gets a dense single line
  // (title · type ······ repo · reason · time); the 424px bell POPOVER keeps
  // the two-line card, which reads better at that width.
  const compact = !!body.closest(".notif-pop");
  let row: HTMLElement;
  if (compact) {
    const segments: Array<string | HTMLElement> = [repoLink()];
    if (t.reason) segments.push(notifReasonLabel(t.reason));
    if (when) segments.push(when);
    row = ghRow({
      lead,
      title: t.title || "(untitled)",
      titleSuffix: t.type ? [pill(notifTypeLabel(t.type), "notif-type")] : [],
      metaSegments: segments,
      metaTitle: t.updatedAt ? `Updated ${absTimeISO(t.updatedAt)}` : undefined,
      ariaLabel: aria,
    });
  } else {
    row = el("div", "notif-line");
    row.setAttribute("aria-label", aria);
    row.appendChild(lead);
    const title = el("span", "notif-line-title");
    title.textContent = t.title || "(untitled)";
    title.title = t.title;
    row.appendChild(title);
    // The leading glyph already encodes the type; a pill repeating it made
    // every row say "Issue" twice. The glyph carries the word on hover.
    lead.title = notifTypeLabel(t.type);
    lead.setAttribute("aria-label", notifTypeLabel(t.type));
    row.appendChild(el("span", "sec-row-spring"));
    const meta = el("span", "sec-row-meta");
    const repo = repoLink();
    repo.classList.add("notif-repo");
    meta.appendChild(repo);
    // The reason keeps its column even when absent, or a thread without one
    // slid its repo name out of line with the rows around it.
    meta.appendChild(
      blankable(span(t.reason ? notifReasonLabel(t.reason) : "", "notif-reason"), !!t.reason),
    );
    row.appendChild(meta);
    const time = el("span", "sec-row-time");
    time.textContent = when;
    if (t.updatedAt) time.title = `Updated ${absTimeISO(t.updatedAt)}`;
    row.appendChild(time);
  }
  // .notif-row = the inbox read/unread emphasis; .list-row = the shared
  // `.list-row:hover .row-actions` reveal for the Open / Mark-read cluster.
  row.classList.add("notif-row", "list-row");
  if (!t.unread) row.classList.add("notif-read");

  // Open the subject IN-APP.
  //
  // The thread now carries what it's ABOUT (subjectKind + subjectNumber/Sha,
  // parsed from the API subject url in github/maps.ts), so Releases and
  // Commits — which used to bounce to github.com because their web urls don't
  // look like issue links — route in-app too:
  //   issue / pull   → this repo's Issues|PRs page, or the read-only viewer
  //                    for another repo
  //   release        → the Releases detail page (subjectNumber IS the id)
  //   commit         → reveal in the graph
  // Anything genuinely unsupported (Discussions) still opens on GitHub, and
  // the row SAYS so rather than promising an in-app open.
  const item = parseGitHubItemUrl(t.htmlUrl);
  const threadRepo = (t.repo || "").toLowerCase();
  const sameRepo = !!currentRepo && threadRepo === currentRepo;
  const kind = t.subjectKind;
  const inAppRelease = sameRepo && kind === "release" && t.subjectNumber != null;
  const inAppCommit = sameRepo && kind === "commit" && !!t.subjectSha;
  const openable = !!item || inAppRelease || inAppCommit;
  const open = (): void => {
    if (inAppRelease) {
      nav("releases", { number: t.subjectNumber });
    } else if (inAppCommit) {
      nav("graph", { sha: t.subjectSha });
    } else if (item && sameRepo) {
      // Same as My Work: back and Escape belong to the Inbox, not to whichever
      // section happens to own the thread's subject.
      nav(item.kind, { number: item.number, from: { view: "notifications", label: "Inbox" } });
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
      openable
        ? { label: "Open in GitStudio", icon: "arrow-right", onClick: open }
        : { label: "Open on GitHub", icon: "link-external", onClick: open },
      ...(openable && t.htmlUrl
        ? [
            {
              label: "Open on GitHub",
              icon: "link-external",
              onClick: () => window.open(t.htmlUrl, "_blank", "noopener"),
            },
          ]
        : []),
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
    // Whichever filter is on, the row stays where it is and simply changes
    // style. Under "Unread only" it used to be REMOVED on the spot: the list
    // collapsed under the pointer, and the next row's own Mark-read button slid
    // into the exact pixel you had just clicked — so a second click marked a
    // thread you never chose. It leaves on the next refresh instead, which is
    // when you are looking at the list rather than at one row in it.
    row.classList.add("notif-read");
    row.querySelector(".notif-dot")?.remove();
    row.querySelectorAll<HTMLElement>(".row-actions .row-btn").forEach((b) => {
      if (b.textContent === "Mark read") b.setAttribute("hidden", "");
    });
    if (!notifAll) {
      row.classList.add("notif-leaving");
      row.title = "Marked read — leaves this list on the next refresh";
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
export function notifTypeLabel(type: string): string {
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
export function notifReasonLabel(reason: string): string {
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
