// My Work — the workday-first page (docs/desktop-redesign.md): everything in
// the current repo that involves YOU, grouped by what it needs from you —
// reviews you were asked for, items assigned to you, your own PRs, mentions.
// Rows navigate straight into the full PR / issue pages. This is the answer to
// "where do I start?" that a pile of GitHub tabs never gives.

import * as l10n from "@vscode/l10n";
import {
  cleanErr,
  el,
  span,
  glyph,
  relTimeISO,
  absTimeISO,
  skeletonList,
  errorState,
  emptyState,
  statBit,
  stateLead,
  statePill,
} from "../ui";
import { peek as cachePeek, gget, bust } from "../cache";
import {
  avatarStack,
  blankable,
  facetBar,
  type FacetState,
  ghGate,
  ghHeader,
  searchField,
  secRow,
  sectionList,
  segmented,
  type SectionNav,
  type SectionRender,
} from "./common";
import type { MyWorkItem } from "../../shared/ipc";
import { openExternalItem } from "./notifications";
import { perTab } from "../tabState";

/** What My Work remembers, for ONE tab (issue #32; tabState.ts): every tab
 *  keeps its own My Work page, and a shared filter was what another tab's page
 *  rebuilt with. */
interface MyWorkTabState {
  /** The live filter — survives re-renders like every section's query does. */
  query: string;
  /**
   * Where to look. "all" is the default on purpose: the Home door that leads
   * here shows work from every repository, and a page that silently narrows to
   * the one open repo answers the door's number with a shorter list — the same
   * item count disagreement the Inbox bell was fixed for. "repo" is the narrow
   * lens, one click away and remembered for the session.
   */
  scope: "all" | "repo";
  /** My Work facets (kind / type), kept across refreshes. */
  myWorkFacets: FacetState;
}
const myWorkTab = perTab<MyWorkTabState>(() => ({ query: "", scope: "all", myWorkFacets: {} }));

const GROUPS: ReadonlyArray<{ kind: MyWorkItem["kind"]; label: string; icon: string }> = [
  { kind: "review-requested", label: l10n.t("Review requested"), icon: "eye" },
  { kind: "assigned", label: l10n.t("Assigned to you"), icon: "person" },
  { kind: "my-prs", label: l10n.t("Your pull requests"), icon: "git-pull-request" },
  { kind: "mentions", label: l10n.t("Mentions"), icon: "mention" },
];

export const renderMyWork: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const S = myWorkTab();
  const payload = (): { scope: "all" } | undefined =>
    S.scope === "all" ? { scope: "all" } : undefined;
  const refresh = (): void => {
    bust("github:myWork");
    renderMyWork(wrap, nav);
  };
  // Everywhere needs only a signed-in account — it queries by user, not by
  // repo, so walling it behind "this repo must have a GitHub remote" (or any
  // repo at all) turned Home's My Work door into a dead click on a fresh
  // launch. Only the narrow scope needs the repo.
  const gate = await ghGate(wrap, nav, S.scope === "repo", refresh);
  if (!gate) return;
  const { view, listEl } = sectionList();
  const header = ghHeader(l10n.t("My Work"), gate.login, refresh);
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: l10n.t("Filter my work…"),
      initial: S.query,
      onInput: (q) => {
        S.query = q;
        renderList();
      },
    }),
  );
  const tools = el("div", "gh-head-tools");
  tools.appendChild(
    segmented<"all" | "repo">({
      options: [
        { value: "all", label: l10n.t("Everywhere"), icon: "globe" },
        { value: "repo", label: l10n.t("This repository"), icon: "repo" },
      ],
      value: S.scope,
      ariaLabel: l10n.t("Where to look for your work"),
      onChange: (v) => {
        S.scope = v;
        renderMyWork(wrap, nav);
      },
    }),
  );
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  let items: MyWorkItem[] | undefined = cachePeek("github:myWork", payload());

  // "Just the review requests" is the most common thing to want here; the
  // group headings already exist, so the facet just narrows to one of them.
  const facets = facetBar<MyWorkItem>({
    specs: [
      {
        key: "kind",
        label: l10n.t("Why it's here"),
        icon: "list-filter",
        anyLabel: l10n.t("Any reason"),
        options: GROUPS.map((g) => ({ value: g.kind, label: g.label, icon: g.icon })),
        predicate: (it, v) => it.kind === v,
      },
      {
        key: "type",
        label: l10n.t("Kind"),
        icon: "git-pull-request",
        anyLabel: l10n.t("Issues and PRs"),
        options: [
          { value: "pr", label: l10n.t("Pull requests"), icon: "git-pull-request" },
          { value: "issue", label: l10n.t("Issues"), icon: "issues" },
        ],
        predicate: (it, v) => it.type === v,
      },
    ],
    state: S.myWorkFacets,
    items: items ?? [],
    onChange: () => renderList(),
  });
  tools.appendChild(facets.el);
  if (!items) listEl.replaceChildren(skeletonList(6));

  const buildRow = (it: MyWorkItem): HTMLElement => {
    const kind =
      it.type === "pr" ? (it.draft ? "draft" : it.state === "closed" ? "closed" : "open-pr")
      : it.state === "closed" ? "completed" : "open";
    // Same meta contract as Issues and PRs — this list showed the author as
    // bare text while its siblings showed an avatar in the same slot.
    const meta: HTMLElement[] = [];
    if (it.author) meta.push(avatarStack([{ login: it.author }], 1, 18, l10n.t("Author")));
    // The assignee slot Issues and PRs reserve — blank here, but reserved, so
    // the author avatar lands in the AUTHOR column rather than one slot right.
    meta.push(blankable(avatarStack([], 3, 18, l10n.t("Assignee")), false));
    meta.push(blankable(statBit("comment", it.comments), it.comments > 0));
    // Owner AND name — the gate knows which GitHub repo is open. A fork or a
    // same-named repo under another owner must never open the local page
    // wearing a foreign number. No repo identity known → nothing is "here".
    const here =
      !it.repo ||
      (gate.repo && it.repo.owner === gate.repo.owner && it.repo.name === gate.repo.repo);
    const row = secRow({
      lead: stateLead(kind),
      num: `#${it.number}`,
      title: it.title,
      titleSuffix: it.draft ? [statePill(l10n.t("Draft"), "draft")] : [],
      meta,
      time: relTimeISO(it.updatedAt),
      timeTitle: it.updatedAt ? l10n.t("Updated {0}", absTimeISO(it.updatedAt)) : undefined,
      ariaLabel:
        it.type === "pr"
          ? l10n.t("Pull request #{0}: {1}", it.number, it.title)
          : l10n.t("Issue #{0}: {1}", it.number, it.title),
      // `from` so the detail's back button and Escape return to My Work rather
      // than dumping you in the Issues or Pull Requests list, which is a
      // grouped view you were never in.
      // An item from ANOTHER repo must not open the current repo's page for
      // the same number — that is a different issue wearing it. Same rule as
      // the Home door's rows.
      onOpen: () => {
        if (here) {
          nav(it.type === "pr" ? "prs" : "issues", {
            number: it.number,
            from: { view: "mywork", label: l10n.t("My Work") },
          });
        } else if (it.repo) {
          openExternalItem({
            owner: it.repo.owner,
            repo: it.repo.name,
            number: it.number,
            kind: it.type === "pr" ? "pull" : "issue",
            htmlUrl: `https://github.com/${it.repo.owner}/${it.repo.name}/${it.type === "pr" ? "pull" : "issues"}/${it.number}`,
          });
        }
      },
    });
    // WHERE, when the list spans repositories — the title alone cannot say.
    if (S.scope === "all" && it.repo) {
      const t = row.querySelector(".sec-row-title");
      if (t) {
        const from = span(it.repo.name, "mywork-repo-chip sec-mono");
        from.title = `${it.repo.owner}/${it.repo.name}`;
        t.after(from);
      }
    }
    // Unique across repositories — two #31s from different repos must not
    // share a focus-return identity (an opaque string to focusReturn). The
    // CURRENT repo's rows keep the bare number: the harness driver and every
    // "find row #N" convention address them that way.
    row.dataset.num = here
      ? String(it.number)
      : it.repo
        ? `${it.repo.owner}/${it.repo.name}#${it.number}`
        : String(it.number);
    return row;
  };

  const renderList = (): void => {
    if (!items) return;
    const q = S.query.trim().toLowerCase();
    const shown = items.filter(
      (it) =>
        facets.passes(it) &&
        (q ? `${it.title} #${it.number} ${it.author ?? ""}`.toLowerCase().includes(q) : true),
    );
    facets.sync(items);
    header.setCount?.(shown.length, items.length);
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.appendChild(
        emptyState(
          l10n.t("All clear"),
          S.scope === "all"
            ? l10n.t("Nothing anywhere needs you right now — no review requests, assignments, or mentions.")
            : l10n.t("Nothing in this repository needs you right now — no review requests, assignments, or mentions."),
          { icon: "pass" },
        ),
      );
      return;
    }
    if (shown.length === 0) {
      listEl.appendChild(
        emptyState(
          l10n.t("No matches"),
          S.query.trim() ? l10n.t("Nothing matches “{0}”.", S.query.trim()) : l10n.t("Nothing matches these filters."),
          {
            icon: "search",
          anchor: "inline",
          secondary: facets.activeCount() > 0
            ? { label: l10n.t("Clear filters"), icon: "clear-all", onClick: () => facets.clear() }
            : undefined,
          },
        ),
      );
      return;
    }
    for (const g of GROUPS) {
      const group = shown.filter((it) => it.kind === g.kind);
      if (!group.length) continue;
      const head = el("div", "mywork-group");
      head.append(glyph(g.icon), span(g.label), span(String(group.length), "mywork-group-count"));
      listEl.appendChild(head);
      for (const it of group) listEl.appendChild(buildRow(it));
    }
  };

  if (items) renderList();

  try {
    const fresh = await gget("github:myWork", payload(), 30000);
    if (!view.isConnected) return;
    items = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!items) {
      listEl.replaceChildren(
        errorState(l10n.t("Couldn't load your work"), cleanErr(e) || l10n.t("GitHub request failed."), refresh),
      );
    }
  }
}
