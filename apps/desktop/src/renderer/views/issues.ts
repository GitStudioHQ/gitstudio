// Issues — the repo-scoped GitHub Issues section.
//
// A two-pane view (list ⟷ detail) mirroring the Pull Requests surface: a header
// with an open/closed filter + "New Issue", a list of issue rows with label
// chips, and a rich detail pane (markdown body, comment timeline, composer, and
// the full CRUD action cluster — edit, labels, assignees, close/reopen).
//
// Self-contained: it renders into the `wrap` it's handed and re-renders by
// calling itself, so all state survives a refresh. Every mutation disables its
// trigger, toasts the result, and re-fetches so the UI stays authoritative.

import { host } from "../bridge";
import {
  avatar,
  cleanErr,
  el,
  emptyState,
  errorState,
  ghRow,
  glyph,
  labelChip,
  loadingState,
  openMenu,
  pill,
  relTimeISO,
  absTimeISO,
  skeletonList,
  span,
  statBit,
  stateLead,
} from "../ui";
import { confirmDialog, promptInline, editForm, toast } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { aiChip, openAssistantTab, streamInto, aiEnabled } from "../aiAssist";
import { ghGate, ghHeader, ghListResizer, peoplePickerModal, searchField, type SectionRender, type SectionNav, type SectionTarget } from "./common";
import type { IssueDetail, IssueInfo, MilestoneInfo, RepoCollaborator, RepoLabel } from "../../shared/ipc";

/** The Open / Closed / All filter, persisted across re-renders within the section. */
let issueState: "open" | "closed" | "all" = "open";

/**
 * Client-side facet filters applied to the already-loaded list (the API only
 * filters by state). `null` means "any". These persist across re-renders so the
 * active facet survives a refresh, mirroring `issueState`.
 */
let facetLabel: string | null = null;
let facetAssignee: string | null = null;
let facetMilestone: string | null = null;

// ── Section-scoped styles ────────────────────────────────────────────────────

/**
 * Inject the few classes this view adds (facet buttons, label swatch, avatar
 * assignee chips) once. App-wide CSS lives in app.css, but these are local to
 * Issues depth, so they ship with the view. Tokens mirror app.css exactly
 * (.mini-btn / .gh-seg-btn) so the look is indistinguishable from native rules.
 */
function ensureIssuesStyles(): void {
  if (document.getElementById("issues-depth-styles")) return;
  const s = document.createElement("style");
  s.id = "issues-depth-styles";
  s.textContent = `
.gh-issue-facets { display: inline-flex; align-items: center; gap: 8px; }
.gh-facet-btn { max-width: 220px; }
.gh-facet-btn > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-facet-btn .codicon-chevron-down { font-size: 13px; opacity: .65; margin-left: -1px; }
.gh-facet-btn.is-active {
  color: var(--gs-accent-ink, var(--gs-accent));
  border-color: var(--accent-line, var(--gs-accent));
  background: var(--app-active);
}
.gh-facet-btn.is-active .glyph { color: var(--gs-accent-ink, var(--gs-accent)); }
.gh-label-swatch {
  display: inline-block; width: 11px; height: 11px; border-radius: 50%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 22%, transparent);
  flex: 0 0 auto;
}
.gh-assignee-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 9px 0 4px; border-radius: 999px;
  border: 1px solid var(--app-border); background: var(--app-elevated);
  font-size: 12px; color: var(--vscode-foreground);
}
.gh-assignee-chip .av { flex: 0 0 auto; }
`;
  document.head.appendChild(s);
}

// ── Small DOM builders ───────────────────────────────────────────────────────

/** A tiny round color swatch for a label, tinted from its hex (menu leading el). */
function swatch(hexColor: string): HTMLElement {
  const s = el("span", "gh-label-swatch");
  s.style.background = `#${(hexColor || "888888").replace(/^#/, "")}`;
  return s;
}

/**
 * Render a facet button's label + state. Shows "<name>: <value>" with a
 * trailing caret when a value is picked (and an `is-active` accent), or just the
 * neutral "<name>" + caret when "any". Keeps the header cluster compact.
 */
function setFacetButton(
  btn: HTMLButtonElement,
  icon: string,
  name: string,
  value: string | null,
): void {
  btn.replaceChildren();
  btn.classList.toggle("is-active", value != null);
  btn.append(glyph(icon), span(value != null ? `${name}: ${value}` : name), glyph("chevron-down"));
  btn.title = value != null ? `Filtering by ${name.toLowerCase()} “${value}” — click to change` : `Filter by ${name.toLowerCase()}`;
  btn.setAttribute("aria-label", btn.title);
}

/** One timeline card: the issue body (first) or a comment. Markdown body. */
function commentCard(author: string, action: string, body: string, createdAt: string): HTMLElement {
  const card = el("div", "gh-comment");
  const hd = el("div", "gh-comment-head");
  const who = span(author, "");
  hd.append(who, span(`${action} · ${relTimeISO(createdAt)}`, "gh-comment-when"));
  card.appendChild(hd);
  const bd = el("div", "gh-body-md");
  if (body.trim()) {
    // renderMarkdown is escape-first (XSS-safe); guard anyway and fall back to
    // plain text if it ever throws — matches the Code-view README render.
    try {
      bd.innerHTML = renderMarkdown(body);
    } catch {
      bd.classList.add("code-md-plain");
      bd.textContent = body;
    }
  } else {
    bd.classList.add("gh-empty-body");
    bd.textContent = "No description provided.";
  }
  card.appendChild(bd);
  return card;
}

// ── The section view ─────────────────────────────────────────────────────────

export const renderIssues: SectionRender = (wrap, nav, target) => {
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  const refresh = (): void => renderIssues(wrap, nav);
  ensureIssuesStyles();

  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;

  // Shell: gh-view → header (+ tools) → gh-body (list | detail).
  const view = el("div", "gh-view");
  const header = ghHeader("Issues", gate.login, refresh);

  // Right-side cluster in the header: a 3-way state segmented control, the facet
  // filters (label / assignee / milestone, populated once the list loads), and
  // New Issue. The state segment re-fetches; the facets filter client-side.
  const tools = el("div", "gh-head-tools");

  const seg = el("div", "gh-seg");
  const segBtn = (label: string, value: "open" | "closed" | "all"): HTMLElement => {
    const b = el("button", "gh-seg-btn");
    b.textContent = label;
    b.classList.toggle("active", issueState === value);
    b.setAttribute("aria-pressed", String(issueState === value));
    b.addEventListener("click", () => {
      if (issueState === value) return;
      issueState = value;
      refresh();
    });
    return b;
  };
  seg.append(segBtn("Open", "open"), segBtn("Closed", "closed"), segBtn("All", "all"));

  // The facet-filter buttons live in their own slot so we can populate their
  // behavior after `issues` loads (they need the loaded set + repo metadata).
  const facets = el("div", "gh-issue-facets");

  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span("New Issue"));
  newBtn.addEventListener("click", () => void newIssue(wrap, nav));
  tools.append(seg, facets, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.appendChild(header);

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, ghListResizer(listEl), detail);
  view.appendChild(body);
  wrap.replaceChildren(view);
  const idleEmpty = (): void => {
    detail.replaceChildren(
      emptyState(
        "Issues",
        "Select an issue to read its description, comment, manage labels and assignees, or close it.",
        {
          icon: "issue-opened",
          hint: "Tip: switch Open / Closed / All, or filter by label and assignee, to focus the list.",
        },
      ),
    );
  };
  idleEmpty();

  // Load the list (the API filters by state — the Open/Closed toggle drives it).
  listEl.replaceChildren(skeletonList(5));
  let issues: IssueInfo[];
  try {
    issues = await host.invoke("issue:list", { state: issueState });
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load issues", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }

  header.setCount?.(issues.length);
  listEl.replaceChildren();
  if (issues.length === 0) {
    idleEmpty();
    const emptyCopy: Record<typeof issueState, { title: string; desc: string; icon: string }> = {
      open: {
        title: "No open issues",
        desc: "You're all caught up — there's nothing open to triage right now.",
        icon: "issue-opened",
      },
      closed: {
        title: "No closed issues",
        desc: "Closed issues will show here once you close some.",
        icon: "issue-closed",
      },
      all: {
        title: "No issues yet",
        desc: "This repo has no issues. Open the first one to start tracking work.",
        icon: "issue-opened",
      },
    };
    const c = emptyCopy[issueState];
    listEl.appendChild(
      emptyState(
        c.title,
        c.desc,
        issueState === "closed"
          ? { icon: c.icon }
          : {
              icon: c.icon,
              action: { label: "New issue", icon: "add", onClick: () => void newIssue(wrap, nav) },
            },
      ),
    );
    return;
  }

  const select = (it: IssueInfo, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    void showDetail(detail, it.number, wrap, nav);
  };

  const buildRow = (it: IssueInfo): HTMLElement => {
    const chips = it.labels.map((l) => labelChip(l.name, l.color));
    const stats: HTMLElement[] = [];
    if (it.comments > 0) stats.push(statBit("comment", it.comments));
    // A small trailing avatar cluster for up to three assignees.
    if (it.assignees.length) {
      const cluster = el("span", "gh-row-assignees");
      for (const a of it.assignees.slice(0, 3)) cluster.appendChild(avatar(a.login, a.avatarUrl, 18));
      stats.push(cluster);
    }
    const author = it.user?.login ?? "unknown";
    const row = ghRow({
      lead: stateLead(it.state === "closed" ? "closed" : "open"),
      title: it.title,
      meta: `#${it.number} · ${author} · opened ${relTimeISO(it.createdAt)}`,
      metaTitle: it.createdAt ? `Opened ${absTimeISO(it.createdAt)}` : undefined,
      chips,
      stats,
      ariaLabel: `Issue #${it.number}: ${it.title}`,
    });
    row.dataset.num = String(it.number);
    row.addEventListener("click", () => select(it, row));
    return row;
  };

  // Case-insensitive match over the fields a user would search by.
  const matches = (it: IssueInfo, q: string): boolean => {
    const hay = `${it.title} #${it.number} ${it.user?.login ?? ""} ${it.labels
      .map((l) => l.name)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  };

  // The live text query, kept alongside the persisted facets so any one of them
  // changing re-applies the whole filter pipeline against the loaded `issues`.
  let query = "";
  const passesFacets = (it: IssueInfo): boolean => {
    if (facetLabel && !it.labels.some((l) => l.name === facetLabel)) return false;
    if (facetAssignee && !it.assignees.some((a) => a.login === facetAssignee)) return false;
    return true;
  };
  const filtered = (): IssueInfo[] => {
    const q = query.toLowerCase();
    return issues.filter((it) => passesFacets(it) && (q ? matches(it, q) : true));
  };
  const facetsActive = (): boolean => facetLabel != null || facetAssignee != null;

  let autoSelected = false;
  const renderList = (): void => {
    const items = filtered();
    listEl.replaceChildren();
    if (items.length === 0) {
      // Distinguish "your text matched nothing" from "your facet filters did".
      const desc = query
        ? `Nothing matches “${query}”.`
        : "No issues match the active filters.";
      const empty = emptyState("No matching issues", desc, { icon: "search" });
      if (facetsActive()) {
        const clear = el("button", "btn btn-soft list-empty-action");
        clear.append(glyph("clear-all"), span("Clear filters"));
        clear.addEventListener("click", () => {
          facetLabel = null;
          facetAssignee = null;
          syncFacetButtons();
          renderList();
        });
        empty.appendChild(clear);
      }
      listEl.appendChild(empty);
      return;
    }
    for (const it of items) listEl.appendChild(buildRow(it));
    // Auto-select the first issue once (initial render) so the detail isn't a
    // void; don't hijack the selection on every keystroke while filtering.
    if (!autoSelected) {
      autoSelected = true;
      const first = items[0];
      const firstRow = listEl.firstElementChild as HTMLElement | null;
      if (first && firstRow) select(first, firstRow);
    }
  };

  // ── Facet filters (label / assignee) ───────────────────────────────────────
  // These filter the already-loaded set client-side. Milestone is intentionally
  // not a list facet: the wire `IssueInfo` carries no per-issue milestone, so it
  // can't be filtered here (the detail still sets/clears it). Labels come from
  // the repo; assignees are derived from whoever's actually assigned in view.
  let repoLabels: RepoLabel[] = [];
  void host
    .invoke("issue:labels", undefined)
    .then((ls) => {
      repoLabels = ls;
    })
    .catch(() => {
      /* best-effort — the label facet just falls back to in-list label names */
    });

  // Rebuilt whenever a facet changes so the active value shows on its button.
  let labelBtn: HTMLButtonElement;
  let assignBtn: HTMLButtonElement;
  const syncFacetButtons = (): void => {
    setFacetButton(labelBtn, "tag", "Label", facetLabel);
    setFacetButton(assignBtn, "person", "Assignee", facetAssignee);
  };

  const openLabelFacet = (): void => {
    // Prefer the repo's full label set (with colors); fall back to labels seen
    // in the loaded issues if the repo fetch hasn't landed / was denied.
    const fromRepo = repoLabels.map((l) => ({ name: l.name, color: l.color }));
    const seen = new Map<string, string>();
    for (const it of issues) for (const l of it.labels) seen.set(l.name, l.color);
    const all = fromRepo.length
      ? fromRepo
      : [...seen].map(([name, color]) => ({ name, color }));
    if (all.length === 0) {
      toast("This repo has no labels to filter by.", "info");
      return;
    }
    openMenu(
      labelBtn,
      [
        {
          label: "All labels",
          icon: facetLabel == null ? "check" : "dash",
          current: facetLabel == null,
          onClick: () => {
            facetLabel = null;
            syncFacetButtons();
            renderList();
          },
        },
        { separator: true },
        ...all.map((l) => ({
          label: l.name,
          iconEl: swatch(l.color),
          current: facetLabel === l.name,
          onClick: () => {
            facetLabel = l.name;
            syncFacetButtons();
            renderList();
          },
        })),
      ],
      { searchable: all.length > 8 },
    );
  };

  const openAssigneeFacet = (): void => {
    // Distinct assignees across the loaded issues (avatars in the menu).
    const seen = new Map<string, string | null>();
    for (const it of issues) for (const a of it.assignees) if (!seen.has(a.login)) seen.set(a.login, a.avatarUrl);
    const people = [...seen].map(([login, avatarUrl]) => ({ login, avatarUrl }));
    if (people.length === 0) {
      toast("No assignees on the issues in view.", "info");
      return;
    }
    openMenu(
      assignBtn,
      [
        {
          label: "Anyone",
          icon: facetAssignee == null ? "check" : "dash",
          current: facetAssignee == null,
          onClick: () => {
            facetAssignee = null;
            syncFacetButtons();
            renderList();
          },
        },
        { separator: true },
        ...people.map((p) => ({
          label: `@${p.login}`,
          iconEl: avatar(p.login, p.avatarUrl, 18),
          current: facetAssignee === p.login,
          onClick: () => {
            facetAssignee = p.login;
            syncFacetButtons();
            renderList();
          },
        })),
      ],
      { searchable: people.length > 8 },
    );
  };

  labelBtn = el("button", "mini-btn gh-facet-btn") as HTMLButtonElement;
  labelBtn.addEventListener("click", () => openLabelFacet());
  assignBtn = el("button", "mini-btn gh-facet-btn") as HTMLButtonElement;
  assignBtn.addEventListener("click", () => openAssigneeFacet());
  facets.append(labelBtn, assignBtn);
  syncFacetButtons();

  // A header search/filter — on the LEFT, next to the title (client-side, instant).
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search issues…",
      onInput: (q) => {
        query = q;
        renderList();
      },
    }),
  );

  // If another view deep-linked an issue (e.g. the project board), open it on
  // entry instead of the auto-selected first item — never bounce out to GitHub.
  if (target?.number != null) autoSelected = true;
  renderList();
  if (target?.number != null) {
    const n = target.number;
    const it = issues.find((i) => i.number === n);
    const row = listEl.querySelector(`[data-num="${n}"]`) as HTMLElement | null;
    if (it && row) {
      select(it, row);
      row.scrollIntoView({ block: "nearest" });
    } else {
      // Not in the current state filter — open its detail directly by number.
      void showDetail(detail, n, wrap, nav);
    }
  }
}

// ── Detail pane ──────────────────────────────────────────────────────────────

/**
 * Render a single issue's full detail (body, timeline, composer, action cluster)
 * into any container — used by the Projects board to peek an issue inline in a
 * slide-over drawer, so you never leave the board to read or reply to one. All
 * in-detail mutations re-render inside `container`, so the drawer is fully live.
 */
export async function renderIssueDetailInto(
  container: HTMLElement,
  number: number,
  nav: SectionNav,
): Promise<void> {
  await showDetail(container, number, container, nav);
}

async function showDetail(
  detail: HTMLElement,
  n: number,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const reload = (): void => void showDetail(detail, n, wrap, nav);

  detail.replaceChildren(loadingState());
  let d: IssueDetail | undefined;
  try {
    d = await host.invoke("issue:detail", n);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load issue", cleanErr(e) || "GitHub request failed.", reload),
    );
    return;
  }
  if (!d) {
    detail.replaceChildren(emptyState("Issue unavailable", "This issue couldn't be loaded."));
    return;
  }
  const it = d.issue;
  const assignees = d.assignees;
  detail.replaceChildren();

  // Head: title + meta + actions.
  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = it.title;

  const meta = el("div", "gh-detail-meta");
  const statePill = pill(it.state === "open" ? "Open" : "Closed");
  statePill.classList.add(it.state === "open" ? "gh-issue-open" : "gh-issue-closed");
  meta.append(
    statePill,
    document.createTextNode(
      `  #${it.number} · ${it.user?.login ?? ""} · ${it.comments} comment${
        it.comments === 1 ? "" : "s"
      } · ${relTimeISO(it.createdAt)}`,
    ),
  );

  const actions = el("div", "gh-detail-actions");

  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span("Edit"));
  editBtn.addEventListener("click", () => void editIssue(detail, it, wrap, nav));

  const labelsBtn = el("button", "mini-btn");
  labelsBtn.append(glyph("tag"), span("Labels"));
  labelsBtn.addEventListener("click", () => void labelsMenu(labelsBtn, detail, it, wrap, nav));

  const assignBtn = el("button", "mini-btn");
  assignBtn.append(glyph("organization"), span("Assignees"));
  assignBtn.addEventListener("click", () => void editAssignees(detail, it, assignees, wrap, nav));

  const milestoneBtn = el("button", "mini-btn");
  milestoneBtn.append(glyph("milestone"), span("Milestone"));
  milestoneBtn.addEventListener("click", () => void milestoneMenu(milestoneBtn, detail, it, wrap, nav));

  const closing = it.state === "open";
  const stateBtn = el("button", "mini-btn");
  stateBtn.append(glyph(closing ? "issue-closed" : "issue-opened"), span(closing ? "Close" : "Reopen"));
  stateBtn.addEventListener("click", () =>
    void changeState(detail, it.number, closing ? "closed" : "open", stateBtn, wrap, nav),
  );

  // A de-emphasized icon-only escape hatch — everything here is doable in-app, so
  // "Open on GitHub" is a secondary affordance, not a peer of the real actions.
  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = "Open this issue on GitHub";
  openBtn.setAttribute("aria-label", "Open this issue on GitHub");
  openBtn.addEventListener("click", () => window.open(it.htmlUrl, "_blank"));

  // ✨ AI: analyze the issue (problem / cause / suggested approach). The same
  // issue context powers the "Draft a reply" chip on the composer below.
  // Bound the context: issue/comment bodies are arbitrary user content, so cap how
  // much we send (keep the most-recent comments) to stay under the model's window.
  const aiCtx = (): string => {
    const MAX_COMMENTS = 20;
    const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
    const recent = d.comments.slice(-MAX_COMMENTS);
    const omitted = d.comments.length - recent.length;
    const comments = recent.map((c) => `${c.author?.login ?? "?"}: ${clip(c.body, 1500)}`).join("\n\n");
    const omittedNote = omitted > 0 ? `(${omitted} earlier comment${omitted === 1 ? "" : "s"} omitted)\n\n` : "";
    return `Issue: ${it.title}\n\n${clip(it.body ?? "", 4000)}${comments ? `\n\nComments:\n${omittedNote}${comments}` : ""}`;
  };
  const analyzeBtn = el("button", "mini-btn ai-mini");
  analyzeBtn.hidden = true;
  analyzeBtn.append(glyph("sparkle"), span("Analyze"));
  analyzeBtn.addEventListener("click", () =>
    openAssistantTab({
      title: `Analyze #${it.number}`,
      goal: `Analyze this GitHub issue. Summarize the problem, the likely root cause, and a concrete suggested approach. Be concise and use Markdown.\n\n${aiCtx()}`,
      nav,
    }),
  );
  void aiEnabled().then((ok) => (analyzeBtn.hidden = !ok));

  actions.append(editBtn, labelsBtn, assignBtn, milestoneBtn, analyzeBtn, stateBtn, openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Live label chips.
  if (it.labels.length) {
    const labelRow = el("div", "gh-detail-labels");
    for (const l of it.labels) labelRow.appendChild(labelChip(l.name, l.color));
    detail.appendChild(labelRow);
  }
  // Assignee chips — avatar + @login. Prefer the rich user objects (they carry
  // avatar URLs); fall back to the login-only list if a user object is missing.
  if (assignees.length) {
    const aRow = el("div", "gh-detail-assignees");
    aRow.appendChild(span("Assigned:", "gh-assign-label"));
    const byLogin = new Map(it.assignees.map((a) => [a.login, a]));
    for (const login of assignees) {
      const chip = el("span", "gh-assignee-chip");
      const u = byLogin.get(login);
      chip.append(avatar(login, u?.avatarUrl ?? null, 18), span(`@${login}`));
      aRow.appendChild(chip);
    }
    detail.appendChild(aRow);
  }

  // Timeline: the body as the first card, then each comment.
  const timeline = el("div", "gh-subcontent");
  timeline.appendChild(
    commentCard(it.user?.login ?? "author", "opened this issue", it.body ?? "", it.createdAt),
  );
  for (const c of d.comments) {
    timeline.appendChild(commentCard(c.author?.login ?? "unknown", "commented", c.body, c.createdAt));
  }
  detail.appendChild(timeline);

  // Comment composer.
  const composer = el("div", "gh-composer");
  const ta = document.createElement("textarea");
  ta.className = "gh-composer-input";
  ta.placeholder = "Leave a comment…";
  ta.rows = 4;
  const crow = el("div", "gh-composer-actions");
  const send = el("button", "btn btn-primary");
  send.append(glyph("comment"), span("Comment"));
  send.addEventListener("click", () => void postComment(detail, it.number, ta, send, wrap, nav));
  // ✨ Draft a reply straight into the composer.
  const draftChip = aiChip("Draft a reply", () =>
    void streamInto(
      "assist",
      { description: `Draft a concise, helpful reply comment for this GitHub issue. Output only the comment text.\n\n${aiCtx()}` },
      ta,
      draftChip as HTMLButtonElement,
    ),
  );
  draftChip.hidden = true;
  void aiEnabled().then((ok) => (draftChip.hidden = !ok));
  crow.append(draftChip, send);
  composer.append(ta, crow);
  detail.appendChild(composer);
}

// ── Mutations (disable trigger → toast → re-fetch) ───────────────────────────

async function newIssue(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const title = await promptInline("New issue", "Issue title", "", "Next");
  if (!title) return;
  // Body is optional — the user can cancel the 2nd step and still create.
  const bodyRaw = await promptInline("Issue description (optional)", "Describe the issue…", "", "Create");
  try {
    const r = await host.invoke("issue:create", { title, body: bodyRaw ?? "" });
    if (!r.ok) {
      toast(r.message ?? "Couldn't create the issue.", "error");
      return;
    }
    toast(r.number ? `Opened issue #${r.number}.` : "Issue created.", "success");
    issueState = "open";
    renderIssues(wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the issue.", "error");
  }
}

async function postComment(
  detail: HTMLElement,
  n: number,
  ta: HTMLTextAreaElement,
  btn: HTMLElement,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const body = ta.value.trim();
  if (!body) {
    toast("Write a comment first.", "info");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  ta.disabled = true;
  try {
    const r = await host.invoke("issue:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the comment.", "error");
      return;
    }
    toast("Comment posted.", "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the comment.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

async function changeState(
  detail: HTMLElement,
  n: number,
  state: "open" | "closed",
  btn: HTMLElement,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  if (state === "closed") {
    const ok = await confirmDialog({
      title: `Close issue #${n}?`,
      message: "This closes the issue on GitHub.",
      confirmLabel: "Close issue",
    });
    if (!ok) return;
  }
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("issue:setState", { number: n, state });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the issue.", "error");
      return;
    }
    toast(state === "closed" ? `Closed issue #${n}.` : `Reopened issue #${n}.`, "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the issue.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function editIssue(
  detail: HTMLElement,
  it: IssueInfo,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  // One unified form (title + body together) — not a chain of one-line prompts.
  const res = await editForm({
    title: `Edit issue #${it.number}`,
    okLabel: "Save",
    titleValue: it.title,
    titlePlaceholder: "Issue title",
    bodyValue: it.body ?? "",
    bodyPlaceholder: "Describe the issue…",
  });
  if (!res) return;
  if (res.title === it.title && res.body === (it.body ?? "")) return; // nothing changed
  try {
    const r = await host.invoke("issue:edit", {
      number: it.number,
      title: res.title,
      body: res.body,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't edit the issue.", "error");
      return;
    }
    toast("Issue updated.", "success");
    await showDetail(detail, it.number, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't edit the issue.", "error");
  }
}

async function labelsMenu(
  anchor: HTMLElement,
  detail: HTMLElement,
  it: IssueInfo,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await host.invoke("issue:labels", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load labels.", "error");
    return;
  }
  if (repoLabels.length === 0) {
    toast("This repo has no labels defined.", "info");
    return;
  }
  const current = new Set(it.labels.map((l) => l.name));
  openMenu(
    anchor,
    repoLabels.map((l) => ({
      label: l.name,
      iconEl: swatch(l.color),
      current: current.has(l.name),
      onClick: () => {
        const next = new Set(current);
        if (next.has(l.name)) next.delete(l.name);
        else next.add(l.name);
        void applyLabels(detail, it.number, [...next], wrap, nav);
      },
    })),
    { searchable: repoLabels.length > 8 },
  );
}

async function applyLabels(
  detail: HTMLElement,
  n: number,
  labels: string[],
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  try {
    const r = await host.invoke("issue:setLabels", { number: n, labels });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update labels.", "error");
      return;
    }
    toast("Labels updated.", "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update labels.", "error");
  }
}

/**
 * A picker of the repo's milestones (open milestones first, with progress as the
 * `sub` line) plus a "No milestone" choice to clear. The wire `IssueInfo` does
 * not carry the issue's current milestone, so we can't pre-check the active one;
 * the detail re-fetches after the set so the result is authoritative regardless.
 */
async function milestoneMenu(
  anchor: HTMLElement,
  detail: HTMLElement,
  it: IssueInfo,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  let ms: MilestoneInfo[] = [];
  try {
    ms = await host.invoke("issue:milestones", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load milestones.", "error");
    return;
  }
  if (ms.length === 0) {
    toast("This repo has no milestones defined.", "info");
    return;
  }
  // Open milestones first, then closed; within a group keep the API order.
  const ordered = [...ms].sort((a, b) => (a.state === b.state ? 0 : a.state === "open" ? -1 : 1));
  openMenu(
    anchor,
    [
      {
        label: "No milestone",
        icon: "circle-slash",
        onClick: () => void applyMilestone(detail, it.number, null, wrap, nav),
      },
      { separator: true },
      ...ordered.map((m) => {
        const total = m.openIssues + m.closedIssues;
        const progress = total > 0 ? `${m.closedIssues}/${total} closed` : "no issues";
        return {
          label: m.title,
          icon: "milestone",
          sub: m.state === "closed" ? `closed · ${progress}` : progress,
          onClick: () => void applyMilestone(detail, it.number, m.number, wrap, nav),
        };
      }),
    ],
    { searchable: ordered.length > 8 },
  );
}

async function applyMilestone(
  detail: HTMLElement,
  n: number,
  milestone: number | null,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  try {
    const r = await host.invoke("issue:setMilestone", { number: n, milestone });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the milestone.", "error");
      return;
    }
    toast(milestone == null ? "Milestone cleared." : "Milestone updated.", "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the milestone.", "error");
  }
}

async function editAssignees(
  detail: HTMLElement,
  it: IssueInfo,
  current: string[],
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  // A searchable, avatar-rich picker of repo collaborators (GitHub-style), with
  // the current assignees pre-checked. Falls back to a CSV prompt if the
  // collaborator list can't be fetched (e.g. limited token scope).
  let people: RepoCollaborator[] = [];
  try {
    people = await host.invoke("pr:reviewers", undefined);
  } catch {
    /* fall through to the free-text path */
  }
  let assignees: string[] | null;
  if (people.length) {
    assignees = await peoplePickerModal({ title: "Assignees", okLabel: "Save", people, selected: current });
  } else {
    const csv = await promptInline(
      "Assignees",
      "comma-separated logins, e.g. octocat, hubot",
      current.join(", "),
      "Save",
    );
    assignees = csv === null ? null : csv.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  }
  if (assignees === null) return;
  try {
    const r = await host.invoke("issue:setAssignees", { number: it.number, assignees });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update assignees.", "error");
      return;
    }
    toast("Assignees updated.", "success");
    await showDetail(detail, it.number, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update assignees.", "error");
  }
}
