// My Work — the workday-first page (docs/desktop-redesign.md): everything in
// the current repo that involves YOU, grouped by what it needs from you —
// reviews you were asked for, items assigned to you, your own PRs, mentions.
// Rows navigate straight into the full PR / issue pages. This is the answer to
// "where do I start?" that a pile of GitHub tabs never gives.

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
  type SectionNav,
  type SectionRender,
} from "./common";
import type { MyWorkItem } from "../../shared/ipc";

/** The live filter — survives re-renders like every section's query does. */
let query = "";
/** My Work facets (kind / type), kept across refreshes. */
const myWorkFacets: FacetState = {};

const GROUPS: ReadonlyArray<{ kind: MyWorkItem["kind"]; label: string; icon: string }> = [
  { kind: "review-requested", label: "Review requested", icon: "eye" },
  { kind: "assigned", label: "Assigned to you", icon: "person" },
  { kind: "my-prs", label: "Your pull requests", icon: "git-pull-request" },
  { kind: "mentions", label: "Mentions", icon: "mention" },
];

export const renderMyWork: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const refresh = (): void => {
    bust("github:myWork");
    renderMyWork(wrap, nav);
  };
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  const { view, listEl } = sectionList();
  const header = ghHeader("My Work", gate.login, refresh);
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Filter my work…",
      initial: query,
      onInput: (q) => {
        query = q;
        renderList();
      },
    }),
  );
  const tools = el("div", "gh-head-tools");
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  let items: MyWorkItem[] | undefined = cachePeek("github:myWork", undefined);

  // "Just the review requests" is the most common thing to want here; the
  // group headings already exist, so the facet just narrows to one of them.
  const facets = facetBar<MyWorkItem>({
    specs: [
      {
        key: "kind",
        label: "Why it's here",
        icon: "list-filter",
        anyLabel: "Any reason",
        options: GROUPS.map((g) => ({ value: g.kind, label: g.label, icon: g.icon })),
        predicate: (it, v) => it.kind === v,
      },
      {
        key: "type",
        label: "Kind",
        icon: "git-pull-request",
        anyLabel: "Issues and PRs",
        options: [
          { value: "pr", label: "Pull requests", icon: "git-pull-request" },
          { value: "issue", label: "Issues", icon: "issues" },
        ],
        predicate: (it, v) => it.type === v,
      },
    ],
    state: myWorkFacets,
    items: items ?? [],
    onChange: () => renderList(),
  });
  tools.appendChild(facets.el);
  if (!items) listEl.replaceChildren(skeletonList(6));

  const buildRow = (it: MyWorkItem): HTMLElement => {
    const kind =
      it.type === "pr" ? (it.draft ? "draft" : it.state === "closed" ? "closed" : "open-pr")
      : it.state === "closed" ? "closed" : "open";
    // Same meta contract as Issues and PRs — this list showed the author as
    // bare text while its siblings showed an avatar in the same slot.
    const meta: HTMLElement[] = [];
    if (it.author) meta.push(avatarStack([{ login: it.author }], 1, 18, "Author"));
    meta.push(blankable(statBit("comment", it.comments), it.comments > 0));
    const row = secRow({
      lead: stateLead(kind),
      num: `#${it.number}`,
      title: it.title,
      titleSuffix: it.draft ? [statePill("Draft", "draft")] : [],
      meta,
      time: relTimeISO(it.updatedAt),
      timeTitle: it.updatedAt ? `Updated ${absTimeISO(it.updatedAt)}` : undefined,
      ariaLabel: `${it.type === "pr" ? "Pull request" : "Issue"} #${it.number}: ${it.title}`,
      onOpen: () => nav(it.type === "pr" ? "prs" : "issues", { number: it.number }),
    });
    row.dataset.num = String(it.number);
    return row;
  };

  const renderList = (): void => {
    if (!items) return;
    const q = query.trim().toLowerCase();
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
          "All clear",
          "Nothing in this repository needs you right now — no review requests, assignments, or mentions.",
          { icon: "pass" },
        ),
      );
      return;
    }
    if (shown.length === 0) {
      listEl.appendChild(
        emptyState(
          "No matches",
          query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing matches these filters.",
          {
            icon: "search",
          anchor: "inline",
          secondary: facets.activeCount() > 0
            ? { label: "Clear filters", icon: "clear-all", onClick: () => facets.clear() }
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
    const fresh = await gget("github:myWork", undefined, 30000);
    if (!view.isConnected) return;
    items = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!items) {
      listEl.replaceChildren(
        errorState("Couldn't load your work", cleanErr(e) || "GitHub request failed.", refresh),
      );
    }
  }
}
