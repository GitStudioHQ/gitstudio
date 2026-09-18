// Home — the workbench. What is going on, and one click to act on any of it.
//
// The first cut of this page was three thin cards on an empty field. The shape
// it kept — every fact is a BUTTON, a door to the place you act on it — was
// right; what it lacked was substance: no search, no sense of the machine's
// other repositories beyond a name list, nothing about the branches you have
// in flight or the CI run you are waiting on. This is the GitKraken-launchpad
// idea rebuilt on this app's own furniture:
//
//   · a search box that is a door into the one search system (⌘K's sibling)
//   · a HERO for the open repository — branch, sync, uncommitted work,
//     branches finished and ready to sweep, stashes, the tip commit —
//     with Push/Fetch right there
//   · your REPOSITORIES, recency-ranked, each one click from open
//   · what NEEDS YOU across every repository you touch — not just this one —
//     plus the Inbox door and this branch's CI
//
// Boot-cheap by rule: disk-priced reads fill immediately and independently;
// GitHub-priced reads are one search call at a 60s TTL and one runs read
// filtered to the current branch. Nothing polls. Nothing waits on anything
// else. A fill that resolves after the page has been left paints nothing.

import { el, span, glyph, emptyState } from "../ui";
import { host } from "../bridge";
import { openInButton } from "../openIn";
import { gget, peek } from "../cache";
import { openExternalItem } from "./notifications";
import type { SectionRender, SectionNav } from "./common";
import type {
  BranchInfo,
  ChangedFile,
  LocalCopy,
  MyWorkItem,
  RepoInfo,
  SyncStatus,
  WorkflowRun,
} from "../../shared/ipc";

/**
 * The search draft, kept OUTSIDE the DOM. The file watcher re-routes this view
 * on every .git change (a commit, a fetch, an index write), which rebuilds it
 * from scratch — and a rebuild that eats the sentence someone is mid-way
 * through typing is the page stealing from its user. The draft and its focus
 * survive here; the rebuild puts both back.
 */
let searchDraft = "";
let searchHadFocus = false;

/** Bumped per mount, so a slow fill from the previous repo paints nothing. */
let gen = 0;

export const renderDashboard: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const g = ++gen;
  const live = (): boolean => g === gen && wrap.isConnected;

  const view = el("div", "dash");
  const head = el("div", "dash-head");
  const title = el("h1", "dash-title");
  title.textContent = greeting();
  head.appendChild(title);
  head.appendChild(searchBox(nav));
  view.appendChild(head);

  // Three regions, all carrying .dash-card: the hero and the two columns.
  const hero = el("section", "dash-card dash-hero");
  hero.appendChild(el("div", "skeleton"));
  view.appendChild(hero);

  const grid = el("div", "dash-grid");
  const reposCol = column("Repositories", "repo", "All repositories", () => nav("repositories"));
  const workCol = column("Needs you", "bell", "My Work", () => nav("mywork"));
  grid.append(reposCol.root, workCol.root);
  view.appendChild(grid);
  wrap.replaceChildren(view);

  // Independent fills: disk never waits on GitHub, and either column arriving
  // late finds the page either still here (paint) or gone (skip).
  void fillHero(hero, nav, live);
  void fillRepos(reposCol.body, nav, live);
  void fillWork(workCol.body, nav, live);
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── the search box ─────────────────────────────────────────────────────────

/** A door into the one search system — never a fourth engine. Enter routes to
 *  the Search page's free local scope, one click from flipping to GitHub. */
function searchBox(nav: SectionNav): HTMLElement {
  const wrap = el("div", "dash-search");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search your repositories — or GitHub  (⌘K for everything)";
  input.setAttribute("aria-label", "Search repositories");
  input.value = searchDraft;
  input.addEventListener("input", () => (searchDraft = input.value));
  input.addEventListener("focus", () => (searchHadFocus = true));
  input.addEventListener("blur", () => (searchHadFocus = false));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = input.value.trim();
    if (!q) return;
    searchDraft = "";
    nav("explore", { id: `q/local/${q}` });
  });
  wrap.append(glyph("search"), input);
  if (searchHadFocus) {
    // After the watcher-triggered rebuild, the keyboard goes back where the
    // user had it. rAF because focus before layout is a silent no-op.
    requestAnimationFrame(() => input.focus());
  }
  return wrap;
}

// ── shared shapes ──────────────────────────────────────────────────────────

interface Column {
  root: HTMLElement;
  body: HTMLElement;
}

function column(titleText: string, icon: string, actionLabel: string, onAction: () => void): Column {
  const root = el("section", "dash-card dash-col");
  const head = el("div", "dash-card-head");
  head.append(glyph(icon), span(titleText, "dash-card-title"), el("span", "dash-card-spring"));
  const act = el("button", "mini-btn");
  act.textContent = actionLabel;
  act.addEventListener("click", onAction);
  head.appendChild(act);
  const body = el("div", "dash-card-body");
  body.appendChild(el("div", "skeleton"));
  root.append(head, body);
  return { root, body };
}

/** A line in a card: an icon, a label, and something to click. */
function line(opts: {
  icon: string;
  tone?: "ok" | "warn" | "muted";
  text: string;
  hint?: string;
  onClick?: () => void;
}): HTMLElement {
  const row = el(opts.onClick ? "button" : "div", "dash-line" + (opts.onClick ? " is-clickable" : ""));
  const g = glyph(opts.icon);
  g.classList.add("dash-line-icon");
  if (opts.tone) g.classList.add(`is-${opts.tone}`);
  row.append(g, span(opts.text, "dash-line-text"));
  if (opts.hint) row.appendChild(span(opts.hint, "dash-line-hint"));
  if (opts.onClick) row.addEventListener("click", opts.onClick);
  return row;
}

// ── 1. the hero: the open repository ───────────────────────────────────────

async function fillHero(hero: HTMLElement, nav: SectionNav, live: () => boolean): Promise<void> {
  let repo: RepoInfo | undefined;
  try {
    repo = await gget("repo:current", undefined, 4000);
  } catch {
    repo = undefined;
  }
  if (!live()) return;

  if (!repo) {
    // No repository: the hero is the three doors that get one open. The page
    // is DESIGNED for this state, not degraded by it — it is the first thing
    // a new install ever shows.
    hero.replaceChildren(
      emptyState("No repository open", "Open one you already have, or clone one from GitHub.", {
        action: { label: "Open a repository", icon: "folder-opened", onClick: () => void openDialog(nav) },
        secondary: { label: "Browse repositories", onClick: () => nav("repositories") },
      }),
    );
    return;
  }

  // The disk-priced facts, in parallel; each optional so one failing read
  // costs one line, never the card.
  const [sync, changed, stashes, branches, headCommit] = await Promise.all([
    gget("sync:status", undefined, 4000).catch(() => undefined),
    gget("status", undefined, 4000).catch(() => [] as ChangedFile[]),
    gget("stash:list", undefined, 8000).catch(() => []),
    gget("branches:list", undefined, 8000).catch(() => [] as BranchInfo[]),
    gget("repo:headCommit", undefined, 8000).catch(() => undefined),
  ]);
  if (!live()) return;

  const top = el("div", "dash-hero-top");
  const identity = el("button", "dash-hero-name");
  identity.append(glyph("repo"), span(repo.name, "dash-hero-repo"));
  if (sync?.branch) identity.append(span("·", "dash-hero-dot"), span(sync.branch, "dash-hero-branch"));
  identity.title = "All repositories";
  identity.addEventListener("click", () => nav("repositories"));
  top.appendChild(identity);
  top.appendChild(el("span", "dash-card-spring"));

  // Push/Fetch ride the same flow as the topbar widget — one implementation,
  // one toast vocabulary, one busy state. The event is handled by the app
  // shell, which owns that flow.
  if (sync && !sync.noUpstream && sync.ahead > 0) {
    const push = el("button", "mini-btn");
    push.append(glyph("cloud-upload"), span(`Push ${sync.ahead}`));
    push.addEventListener("click", () =>
      window.dispatchEvent(new CustomEvent("gs:sync", { detail: { action: "push" } })),
    );
    top.appendChild(push);
  }
  const fetchBtn = el("button", "mini-btn");
  fetchBtn.append(glyph("sync"), span("Fetch"));
  fetchBtn.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("gs:sync", { detail: { action: "fetch" } })),
  );
  top.appendChild(fetchBtn);
  // The same control the Code page carries — the repository you are looking at,
  // in the editor you work in, one click from the first screen.
  top.appendChild(openInButton({ root: () => repo.root, nav: (v) => nav(v) }));
  const openChanges = el("button", "btn btn-primary dash-hero-cta");
  openChanges.textContent = "Open Changes";
  openChanges.addEventListener("click", () => nav("changes"));
  top.appendChild(openChanges);

  const rows: HTMLElement[] = [];

  // Uncommitted work, as a number of files rather than a status letter soup.
  const staged = changed.filter((f) => f.staged).length;
  const unstaged = changed.length - staged;
  if (changed.length) {
    rows.push(
      line({
        icon: "edit",
        tone: "warn",
        text:
          staged && unstaged
            ? `${staged} staged, ${unstaged} to stage`
            : staged
              ? `${staged} staged and ready to commit`
              : `${unstaged} ${unstaged === 1 ? "file" : "files"} changed`,
        hint: "Changes",
        onClick: () => nav("changes"),
      }),
    );
  } else {
    rows.push(line({ icon: "check", tone: "ok", text: "Nothing uncommitted" }));
  }

  if (sync) {
    if (sync.noUpstream) {
      rows.push(line({ icon: "cloud-upload", tone: "warn", text: "This branch has never been pushed", hint: "Branches", onClick: () => nav("branches") }));
    } else if (sync.ahead && sync.behind) {
      rows.push(line({ icon: "git-compare", tone: "warn", text: `${sync.ahead} to push, ${sync.behind} to pull`, hint: "Branches", onClick: () => nav("branches") }));
    } else if (sync.ahead) {
      rows.push(line({ icon: "cloud-upload", text: `${sync.ahead} ${sync.ahead === 1 ? "commit" : "commits"} to push`, hint: "Branches", onClick: () => nav("branches") }));
    } else if (sync.behind) {
      rows.push(line({ icon: "cloud-download", text: `${sync.behind} ${sync.behind === 1 ? "commit" : "commits"} to pull`, hint: "Branches", onClick: () => nav("branches") }));
    } else {
      rows.push(line({ icon: "check", tone: "ok", text: "Up to date with the remote" }));
    }
  }

  // Branches whose work is DONE — merged into the default branch — and ready
  // to sweep. Not the default branch itself: `merged` is true on it by
  // definition (it is merged into itself), and a cleanup line that counts it
  // would offer to tidy away main, forever, on every repository.
  // Exactly the branches the "merged" standing lens will show on arrival —
  // a gone-upstream branch reads "Upstream gone" there (first match wins), so
  // counting it here would promise 2 and land on 1.
  const swept = branches.filter((b) => b.merged && !b.gone && !b.current && !b.isDefault);
  if (swept.length) {
    rows.push(
      line({
        icon: "git-branch",
        text: `${swept.length} ${swept.length === 1 ? "branch" : "branches"} merged — clean up?`,
        hint: "Branches",
        // The lens, not just the page: land on the branches this line COUNTED.
        onClick: () => nav("branches", { lens: "merged" }),
      }),
    );
  }

  if (stashes.length) {
    rows.push(
      line({
        icon: "archive",
        text: `${stashes.length} ${stashes.length === 1 ? "stash" : "stashes"}`,
        hint: "Branches",
        onClick: () => nav("branches"),
      }),
    );
  }

  if (headCommit) {
    rows.push(
      line({
        icon: "git-commit",
        tone: "muted",
        text: `${headCommit.shortSha ?? ""} ${headCommit.subject ?? ""}`.trim(),
        hint: "Commits",
        onClick: () => nav("graph"),
      }),
    );
  }

  const body = el("div", "dash-hero-body");
  body.append(...rows);
  hero.replaceChildren(top, body);
}

async function openDialog(nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:open", undefined);
  if (info) nav("code");
}

// ── 2. your repositories, most recent first ────────────────────────────────

async function fillRepos(body: HTMLElement, nav: SectionNav, live: () => boolean): Promise<void> {
  let copies: LocalCopy[] = [];
  let recents: RepoInfo[] = [];
  try {
    [copies, recents] = await Promise.all([
      gget("repos:local", undefined, 5000),
      gget("repo:recent", undefined, 5000).catch(() => [] as RepoInfo[]),
    ]);
  } catch {
    copies = [];
  }
  if (!live()) return;

  const alive = copies.filter((c) => !c.current && !c.missing);
  if (!alive.length) {
    body.replaceChildren(
      emptyState("No other repositories", "Add a folder you keep repositories in.", {
        action: { label: "Repositories", icon: "repo", onClick: () => nav("repositories") },
      }),
    );
    return;
  }

  // Recency first — the recents list carries the order you actually worked in
  // — then everything the scan discovered, alphabetically. A repo you have
  // never opened here still shows: knowing about it without being told is the
  // whole point of tracked folders.
  const rank = new Map(recents.map((r, i) => [r.root, i]));
  const ordered = [...alive].sort((a, b) => {
    const ra = rank.get(a.root);
    const rb = rank.get(b.root);
    if (ra !== undefined || rb !== undefined) {
      return (ra ?? Number.MAX_SAFE_INTEGER) - (rb ?? Number.MAX_SAFE_INTEGER);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const CAP = 8;
  const shown = ordered.slice(0, CAP);
  const rows = shown.map((r) =>
    line({
      icon: "repo",
      text: r.name,
      // WHERE it is — the project folder when there is one, else the band —
      // and WHAT it is when it is not a repository of its own.
      hint: (r.worktreeOf ? "worktree · " : "") + (r.group || bandName(r.band)),
      onClick: () => void openPath(r.root, nav),
    }),
  );
  const rest = ordered.length - shown.length;
  if (rest > 0) {
    const folders = new Set(ordered.slice(CAP).map((r) => r.group || r.band || "elsewhere"));
    rows.push(
      line({
        icon: "ellipsis",
        tone: "muted",
        text: `${rest} more in ${folders.size} ${folders.size === 1 ? "folder" : "folders"}`,
        onClick: () => nav("repositories"),
      }),
    );
  }
  body.replaceChildren(...rows);

  // The signals, filled IN PLACE after paint — "which of these has unpushed
  // work" is the question this card exists to answer, and it must not hold
  // the whole page for eight git processes. A repo with nothing to say gets
  // nothing: a row of zeros is noise wearing precision.
  try {
    const status = await gget("repos:localStatus", shown.map((r) => r.root), 10000);
    if (!live()) return;
    shown.forEach((r, i) => {
      const st = status[r.root];
      if (!st || (st.dirty === 0 && st.ahead === 0 && st.behind === 0)) return;
      const cluster = el("span", "dash-repo-state");
      if (st.dirty > 0) {
        const d = span(`●${st.dirty}`, "dash-state-bit is-dirty");
        d.title = `${st.dirty} changed ${st.dirty === 1 ? "file" : "files"} in the working tree`;
        cluster.appendChild(d);
      }
      if (st.ahead > 0) {
        const a = span(`↑${st.ahead}`, "dash-state-bit is-ahead");
        a.title = `${st.ahead} ${st.ahead === 1 ? "commit" : "commits"} not pushed${st.branch ? ` on ${st.branch}` : ""}`;
        cluster.appendChild(a);
      }
      if (st.behind > 0) {
        const b = span(`↓${st.behind}`, "dash-state-bit is-behind");
        b.title = `${st.behind} ${st.behind === 1 ? "commit" : "commits"} behind the remote`;
        cluster.appendChild(b);
      }
      const hint = rows[i].querySelector(".dash-line-hint");
      if (hint) hint.before(cluster);
      else rows[i].appendChild(cluster);
    });
  } catch {
    /* signals are a bonus — the rows already answer "what do I have" */
  }
}

function bandName(band: string | undefined): string {
  if (!band) return "";
  const parts = band.split("/");
  return `~/${parts[parts.length - 1]}`;
}

async function openPath(root: string, nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:openPath", root);
  if (info) nav("code");
}

// ── 3. what needs you, across every repository ─────────────────────────────

async function fillWork(body: HTMLElement, nav: SectionNav, live: () => boolean): Promise<void> {
  // Signed OUT is not "unreachable" — it is a door. The column used to catch
  // the not-connected rejection and shrug "couldn't reach GitHub" at someone
  // who had simply never signed in, hiding the one action that would fill it.
  const status = await gget("github:status", undefined, 12000).catch(() => undefined);
  if (!live()) return;
  if (status && !status.connected) {
    const connect = line({
      icon: "github",
      text: "Sign in to see reviews, assignments and mentions",
      hint: "Settings",
      onClick: () => nav("settings"),
    });
    body.replaceChildren(connect);
    return;
  }

  let items: MyWorkItem[] = [];
  let reachable = true;
  try {
    // Cross-repo on purpose: the review that has been waiting since yesterday
    // is rarely in the repository you happen to have open. 60s TTL — one
    // search call a minute at most, however often this page repaints.
    items = await gget("github:myWork", { scope: "all" }, 60_000);
  } catch {
    reachable = false;
  }
  if (!live()) return;

  const rows: HTMLElement[] = [];
  if (!reachable) {
    rows.push(line({ icon: "warning", tone: "muted", text: "Couldn't reach GitHub — your work will appear when it answers" }));
  } else {
    // What is WAITING, not everything of yours: your own open PRs are work in
    // progress; a review requested of you is a person blocked on you.
    const waiting = items.filter(
      (i) => i.kind === "review-requested" || i.kind === "assigned" || i.kind === "mentions",
    );
    if (!waiting.length) {
      rows.push(line({ icon: "check-all", tone: "ok", text: "Nothing waiting on you" }));
    }
    const label: Record<string, string> = {
      "review-requested": "Review",
      assigned: "Assigned",
      mentions: "Mentioned",
    };
    const current = peek("repo:current", undefined);
    for (const i of waiting.slice(0, 6)) {
      const here = !i.repo || (current && i.repo.name === current.name);
      rows.push(
        line({
          icon: i.type === "pr" ? "git-pull-request" : "issue-opened",
          tone: i.kind === "review-requested" ? "warn" : undefined,
          text: `${i.repo ? `${i.repo.name} ` : ""}#${i.number} ${i.title}`,
          hint: label[i.kind] ?? "",
          onClick: () => {
            // An item from ANOTHER repo must not open the current repo's page
            // for the same number — that is a different issue wearing it.
            if (here) nav(i.type === "pr" ? "prs" : "issues", { number: i.number });
            else if (i.repo) {
              openExternalItem({
                owner: i.repo.owner,
                repo: i.repo.name,
                number: i.number,
                kind: i.type === "pr" ? "pull" : "issue",
                htmlUrl: `https://github.com/${i.repo.owner}/${i.repo.name}/${i.type === "pr" ? "pull" : "issues"}/${i.number}`,
              });
            }
          },
        }),
      );
    }
    if (waiting.length > 6) {
      rows.push(line({ icon: "ellipsis", tone: "muted", text: `${waiting.length - 6} more`, onClick: () => nav("mywork") }));
    }
  }

  // The Inbox door. No count at zero: the unread number is deliberately 0
  // until something unlocks the token, and "Inbox · 0 unread" on launch would
  // assert a fact the app does not know yet. The bell hides its badge for the
  // same reason.
  let unread = currentUnread;
  if (!unread) {
    // The same cheap ambient read the bell uses (0 until the token unlocks),
    // so the door and the badge cannot disagree on a fresh launch.
    unread = await gget("notifications:unreadCount", undefined, 60_000).catch(() => 0);
    if (!live()) return;
  }
  rows.push(
    line({
      icon: "inbox",
      text: unread > 0 ? `Inbox · ${unread} unread` : "Inbox",
      onClick: () => nav("notifications"),
    }),
  );

  // CI for THIS branch, asked with the branch filter — never the unfiltered
  // run list, which is every branch's history and a much bigger answer.
  const sync = peek("sync:status", undefined);
  if (sync?.branch) {
    try {
      const runs: WorkflowRun[] = await gget("actions:runs", { branch: sync.branch }, 60_000);
      if (!live()) return;
      const latest = runs[0];
      if (latest) {
        const raw = latest.status === "completed" ? (latest.conclusion ?? "finished") : latest.status;
        // Human words, not API enum spellings — the run page one click away
        // says "in progress", and this line saying "in_progress" beside it
        // read as two different apps.
        const SAY: Record<string, string> = {
          in_progress: "in progress",
          queued: "queued",
          requested: "queued",
          waiting: "waiting",
          success: "passed",
          failure: "failed",
          cancelled: "cancelled",
          skipped: "skipped",
          timed_out: "timed out",
          action_required: "needs approval",
          neutral: "finished",
          stale: "stale",
        };
        const state = raw;
        rows.push(
          line({
            icon: state === "success" ? "check" : state === "failure" ? "close" : "play-circle",
            tone: state === "success" ? "ok" : state === "failure" ? "warn" : "muted",
            text: `CI · ${sync.branch}: ${SAY[raw] ?? raw.replace(/_/g, " ")}`,
            onClick: () => nav("actions", { number: latest.id }),
          }),
        );
      }
    } catch {
      /* CI is a bonus line, never a failure state */
    }
  }
  if (!live()) return;
  body.replaceChildren(...rows);
}

/** The unread count the bell last broadcast — shared, so the two can never
 *  disagree. Zero until the Inbox actually loads. */
let currentUnread = 0;
window.addEventListener("gs:unread", (e) => {
  const n = (e as CustomEvent<number>).detail;
  if (typeof n === "number") currentUnread = n;
});

/** Exported for the harness: the greeting is the one time-dependent string on
 *  the page, and a check that asserted a fixed one would fail every evening. */
export const __dashGreeting = greeting;
