// The first screen — what is going on, and what to do about it.
//
// The app used to open on Changes, which answers exactly one question ("what
// have I edited") and answers it with an empty list most of the time. It is
// the right screen once you are working; it is a strange thing to be greeted
// by, and it says nothing about the four other repositories you have on the
// go or the review that has been waiting since yesterday.
//
// So this page answers three questions, in the order people ask them:
//
//   1. WHERE AM I — the open repository, its branch, whether it is ahead or
//      behind, and whether there is anything uncommitted. One click to act.
//   2. WHAT NEEDS ME — reviews requested of you, things assigned to you,
//      mentions. The same data My Work shows, cut to what is actually waiting.
//   3. WHERE ELSE — the other repositories on this machine, one click away.
//
// Every card is a door: nothing here is a read-only summary you then have to
// go and find somewhere else. A dashboard you cannot act from is a poster.

import { el, span, glyph, emptyState } from "../ui";
import { host } from "../bridge";
import { gget } from "../cache";
import type { SectionRender, SectionNav } from "./common";
import type { ChangedFile, LocalCopy, MyWorkItem, RepoInfo, SyncStatus } from "../../shared/ipc";

export const renderDashboard: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const view = el("div", "dash");
  const head = el("div", "dash-head");
  const title = el("h1", "dash-title");
  title.textContent = greeting();
  head.appendChild(title);
  view.appendChild(head);

  const grid = el("div", "dash-grid");
  view.appendChild(grid);
  wrap.replaceChildren(view);

  // Each card fills itself. One slow read — GitHub is behind the network —
  // must not hold up the two that answer from disk, so they are not awaited
  // together.
  const repoCard = card("This repository", "repo");
  const workCard = card("Needs you", "bell");
  const reposCard = card("Other repositories", "folder-library");
  grid.append(repoCard.root, workCard.root, reposCard.root);

  void fillRepo(repoCard, nav);
  void fillWork(workCard, nav);
  void fillRepos(reposCard, nav);
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

interface Card {
  root: HTMLElement;
  body: HTMLElement;
  setAction(label: string, onClick: () => void): void;
  loading(): void;
}

function card(titleText: string, icon: string): Card {
  const root = el("section", "dash-card");
  const head = el("div", "dash-card-head");
  head.append(glyph(icon), span(titleText, "dash-card-title"));
  const spring = el("span", "dash-card-spring");
  head.appendChild(spring);
  const body = el("div", "dash-card-body");
  root.append(head, body);
  body.appendChild(el("div", "skeleton"));
  return {
    root,
    body,
    setAction(label, onClick) {
      const b = el("button", "mini-btn");
      b.textContent = label;
      b.addEventListener("click", onClick);
      head.appendChild(b);
    },
    loading() {
      body.replaceChildren(el("div", "skeleton"));
    },
  };
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

// ── 1. where am I ──────────────────────────────────────────────────────────

async function fillRepo(c: Card, nav: SectionNav): Promise<void> {
  let repo: RepoInfo | undefined;
  let sync: SyncStatus | undefined;
  let changed: ChangedFile[] = [];
  try {
    [repo, sync, changed] = await Promise.all([
      gget("repo:current", undefined, 4000),
      gget("sync:status", undefined, 4000),
      gget("status", undefined, 4000),
    ]);
  } catch {
    /* fall through to the no-repo state */
  }

  if (!repo) {
    c.body.replaceChildren(
      emptyState("No repository open", "Open one you already have, or clone one from GitHub.", {
        action: { label: "Open a repository", icon: "folder-opened", onClick: () => void openDialog(nav) },
        secondary: { label: "Browse repositories", onClick: () => nav("repositories") },
      }),
    );
    return;
  }

  const rows: HTMLElement[] = [];
  rows.push(
    line({
      icon: "repo",
      text: repo.name,
      hint: sync?.branch ?? "",
      onClick: () => nav("repositories"),
    }),
  );

  // Uncommitted work, said as a number of files rather than a status letter
  // soup — the detail is one click away and this is the glance.
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
        hint: "Review",
        onClick: () => nav("changes"),
      }),
    );
  } else {
    rows.push(line({ icon: "check", tone: "ok", text: "Nothing uncommitted" }));
  }

  if (sync) {
    if (sync.noUpstream) {
      rows.push(
        line({ icon: "cloud-upload", tone: "warn", text: "This branch has never been pushed", hint: "Branches", onClick: () => nav("branches") }),
      );
    } else if (sync.ahead && sync.behind) {
      rows.push(
        line({ icon: "git-compare", tone: "warn", text: `${sync.ahead} to push, ${sync.behind} to pull`, hint: "Branches", onClick: () => nav("branches") }),
      );
    } else if (sync.ahead) {
      rows.push(line({ icon: "cloud-upload", text: `${sync.ahead} ${sync.ahead === 1 ? "commit" : "commits"} to push`, hint: "Branches", onClick: () => nav("branches") }));
    } else if (sync.behind) {
      rows.push(line({ icon: "cloud-download", text: `${sync.behind} ${sync.behind === 1 ? "commit" : "commits"} to pull`, hint: "Branches", onClick: () => nav("branches") }));
    } else {
      rows.push(line({ icon: "check", tone: "ok", text: "Up to date with the remote" }));
    }
  }

  c.setAction("Open Changes", () => nav("changes"));
  c.body.replaceChildren(...rows);
}

async function openDialog(nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:open", undefined);
  if (info) nav("changes");
}

// ── 2. what needs me ───────────────────────────────────────────────────────

async function fillWork(c: Card, nav: SectionNav): Promise<void> {
  let items: MyWorkItem[] = [];
  try {
    items = await gget("github:myWork", undefined, 30_000);
  } catch {
    c.body.replaceChildren(
      emptyState("Couldn’t reach GitHub", "Your work will appear here once it answers.", {
        icon: "warning",
      }),
    );
    return;
  }

  // What is WAITING, not everything of yours. Your own open PRs are work in
  // progress; a review requested of you is a person blocked on you.
  const waiting = items.filter((i) => i.kind === "review-requested" || i.kind === "assigned" || i.kind === "mentions");
  if (!waiting.length) {
    c.body.replaceChildren(
      emptyState("Nothing waiting on you", "No reviews requested, nothing assigned, no mentions.", {
        icon: "check-all",
      }),
    );
    return;
  }

  // Short, because this column is a hint beside a title, not a sentence. The
  // long forms truncated to "Review reque…" and "Assigned t…", which is worse
  // than the short word it was trying to be more precise than.
  const label: Record<string, string> = {
    "review-requested": "Review",
    assigned: "Assigned",
    mentions: "Mentioned",
  };
  const rows = waiting.slice(0, 6).map((i) =>
    line({
      icon: i.type === "pr" ? "git-pull-request" : "issue-opened",
      tone: i.kind === "review-requested" ? "warn" : undefined,
      text: `#${i.number} ${i.title}`,
      hint: label[i.kind] ?? "",
      onClick: () => nav(i.type === "pr" ? "prs" : "issues", { number: i.number }),
    }),
  );
  if (waiting.length > rows.length) {
    rows.push(
      line({
        icon: "ellipsis",
        tone: "muted",
        text: `${waiting.length - rows.length} more`,
        onClick: () => nav("mywork"),
      }),
    );
  }
  c.setAction("My Work", () => nav("mywork"));
  c.body.replaceChildren(...rows);
}

// ── 3. where else ──────────────────────────────────────────────────────────

async function fillRepos(c: Card, nav: SectionNav): Promise<void> {
  let copies: LocalCopy[] = [];
  try {
    copies = await gget("repos:local", undefined, 5000);
  } catch {
    copies = [];
  }
  // Not the one you already have open, and not one that has been deleted from
  // under the app — offering to open either is a dead click.
  const others = copies.filter((r) => !r.current && !r.missing).slice(0, 6);
  if (!others.length) {
    c.body.replaceChildren(
      emptyState("No other repositories", "Add a folder you keep repositories in.", {
        action: { label: "Repositories", icon: "repo", onClick: () => nav("repositories") },
      }),
    );
    return;
  }
  c.setAction("All repositories", () => nav("repositories"));
  c.body.replaceChildren(
    ...others.map((r) =>
      line({
        icon: "repo",
        text: r.name,
        hint: r.origin ?? "",
        onClick: () => void openPath(r.root, nav),
      }),
    ),
  );
}

async function openPath(root: string, nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:openPath", root);
  if (info) nav("changes");
}

/** Exported for the harness: the greeting is the one time-dependent string on
 *  the page, and a check that asserted a fixed one would fail every evening. */
export const __dashGreeting = greeting;
