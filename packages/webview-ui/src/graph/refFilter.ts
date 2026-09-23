// The Branches picker's arithmetic (issue #30), shared by the editor-area graph
// and the sidebar rail so the two agree on what a preset ticks, what the
// trigger says, and what a tick does to the selection. No Lit, no DOM.
//
// The model: a filter of null is "every branch, tag and remote", and the list
// shows NO ticks for it — ticking a ref narrows the graph to that ref alone,
// the way Git Graph's "Show All" gives way to the first branch you pick. From
// there ticks add and remove; unticking the last one is All again, because a
// graph of nothing is not a graph.

import type { GraphRefEntry, GraphRefFilter, RefPreset, WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { refLabel } from "@gitstudio/host-bridge/graphRefFilter";

export type { RefPreset };

export const REF_PRESETS: ReadonlyArray<{ id: RefPreset; label: string }> = [
  { id: "current", label: "Current branch" },
  { id: "currentUpstream", label: "Current + upstream" },
  { id: "local", label: "Local only" },
  { id: "all", label: "All" },
];

/**
 * The refs a preset ticks TODAY, or undefined when the repository has nothing
 * for it: a detached HEAD has no current branch, a branch with no upstream has
 * nothing to add, a repo of only remotes has no locals.
 *
 * This is what the picker shows at once, under the pointer. What it SENDS is
 * the preset itself (presetRefs, host-bridge), which the host stores and
 * resolves again on every load — so "Current branch" follows a checkout.
 */
export function presetFilter(
  id: RefPreset,
  refs: readonly GraphRefEntry[],
): GraphRefFilter | undefined {
  const current = refs.find((r) => r.kind === "head" && r.isCurrent);
  switch (id) {
    case "all":
      return null;
    case "current":
      return current ? [current.fullName] : undefined;
    case "currentUpstream":
      return current?.upstream ? [current.fullName, current.upstream] : undefined;
    case "local": {
      const locals = refs.filter((r) => r.kind === "head").map((r) => r.fullName);
      return locals.length > 0 ? locals : undefined;
    }
  }
}

/** Why a preset is unavailable, for its tooltip; empty when it is available. */
export function presetUnavailable(id: RefPreset, refs: readonly GraphRefEntry[]): string {
  if (presetFilter(id, refs) !== undefined) return "";
  const current = refs.find((r) => r.kind === "head" && r.isCurrent);
  switch (id) {
    case "current":
      return "HEAD is detached — there is no current branch";
    case "currentUpstream":
      return current ? `${current.name} has no upstream` : "HEAD is detached — there is no current branch";
    case "local":
      return "No local branches";
    default:
      return "";
  }
}

/**
 * The preset the filter IS, so the row can show it: the one the host says the
 * stored filter is (`preset`, a graphInit's refPreset), or All for no filter.
 *
 * Not worked out by comparing ticks. "Current branch" used to be recognised
 * as "the ticks equal the current branch" — which a hand-picked [main] also
 * is, while on main, and which stopped being true of the preset itself the
 * moment the branch changed. The preset is a fact about what was stored.
 */
export function activePreset(filter: GraphRefFilter, preset?: RefPreset): RefPreset | undefined {
  if (preset && preset !== "all") return preset;
  return filter === null ? "all" : undefined;
}

/**
 * A ref's display name: its full name shorn of the namespace — "main",
 * "origin/main", "v1.2.0". Not the listed short name: that is git's
 * shortest UNAMBIGUOUS form, and a branch that shares its name with a tag is
 * listed as "heads/release" — under a heading that already says Local.
 */
export function refDisplayName(fullName: string): string {
  // One rule for every surface that names a ref — the chips, the picker, the
  // trigger — so they cannot drift: host-bridge's refLabel.
  return refLabel(fullName);
}

/**
 * What the trigger says: "All branches"; a preset as what it stands for now,
 * the branch first so a narrow trigger still shows it ("main (current)",
 * "main + upstream", "Local branches"); the names when there are one or two,
 * else a count — "3 branches", or "3 refs" once a tag is among them, because
 * a tag is not a branch and the label should not say it is.
 */
export function refFilterLabel(
  filter: GraphRefFilter,
  refs: readonly GraphRefEntry[],
  preset?: RefPreset,
): string {
  if (preset === "current" || preset === "currentUpstream") {
    const cur = refs.find((r) => r.kind === "head" && r.isCurrent);
    if (!cur) return "Detached HEAD";
    const on = refDisplayName(cur.fullName);
    return preset === "current" ? `${on} (current)` : `${on} + upstream`;
  }
  if (preset === "local") return "Local branches";
  if (!filter || filter.length === 0) return "All branches";
  if (filter.length <= 2) return filter.map((f) => refDisplayName(f)).join(", ");
  const anyTag = filter.some((f) => f.startsWith("refs/tags/"));
  return `${filter.length} ${anyTag ? "refs" : "branches"}`;
}

/**
 * Whether two row sets are the same history for scrolling (see the lists'
 * `updated`): the same filter, the same preset. A refresh keeps both; a new
 * tick, a preset, or a checkout under "Current branch" (the ticks move) is a
 * different history, and opens at its top.
 */
export function scrollKey(filter: GraphRefFilter, preset?: RefPreset): string {
  return JSON.stringify([preset ?? "", filter === null ? null : [...filter].sort()]);
}

/** The picker's footnote: what the selection is, and the way back to All. */
export function refFilterHint(
  filter: GraphRefFilter,
  refs: readonly GraphRefEntry[],
  preset?: RefPreset,
): string {
  if (preset === "current" || preset === "currentUpstream") return "Follows the branch you are on · All for every branch";
  if (preset === "local") return "Follows your local branches · All for every branch";
  if (filter) return `${filter.length} of ${refs.length} ticked · untick the last for all`;
  return refs.length ? "Showing every branch and tag · tick one to narrow" : "No branches or tags";
}

/** The selection after ticking `fullName`: null narrows to it alone; a list
 *  adds or removes it; removing the last one is All. */
export function toggleRef(filter: GraphRefFilter, fullName: string): GraphRefFilter {
  if (!filter) return [fullName];
  if (filter.includes(fullName)) {
    const rest = filter.filter((f) => f !== fullName);
    return rest.length > 0 ? rest : null;
  }
  return [...filter, fullName];
}

/** The selection with several refs added at once (a chip and its folded remotes). */
export function addRefs(filter: GraphRefFilter, fullNames: readonly string[]): GraphRefFilter {
  const out = [...(filter ?? [])];
  for (const f of fullNames) if (!out.includes(f)) out.push(f);
  return out.length > 0 ? out : null;
}

/** The selection with several refs removed; empty is All. */
export function removeRefs(filter: GraphRefFilter, fullNames: readonly string[]): GraphRefFilter {
  if (!filter) return null;
  const drop = new Set(fullNames);
  const rest = filter.filter((f) => !drop.has(f));
  return rest.length > 0 ? rest : null;
}

export interface RefGroup {
  id: "local" | "remote" | "tag";
  label: string;
  refs: GraphRefEntry[];
  /** How many matches the cap left out — the list says so instead of lying. */
  hidden: number;
}

/** Rows per group before the list asks for a narrower query. A repository
 *  with two thousand tags should not render two thousand buttons a keystroke. */
export const REF_GROUP_CAP = 200;

/**
 * The picker's rows: grouped Local / Remote / Tags, the current branch pinned
 * to the top of Local, narrowed by a case-insensitive substring of the name.
 * Groups with nothing to show are left out; a group past the cap says how
 * many it dropped.
 */
export function groupRefs(
  refs: readonly GraphRefEntry[],
  query: string,
  cap: number = REF_GROUP_CAP,
): RefGroup[] {
  const q = query.trim().toLowerCase();
  const matches = q ? refs.filter((r) => r.name.toLowerCase().includes(q)) : [...refs];
  const spec: Array<[RefGroup["id"], string, GraphRefEntry["kind"]]> = [
    ["local", "Local", "head"],
    ["remote", "Remote", "remoteHead"],
    ["tag", "Tags", "tag"],
  ];
  const out: RefGroup[] = [];
  for (const [id, label, kind] of spec) {
    let list = matches.filter((r) => r.kind === kind);
    if (id === "local") {
      const cur = list.find((r) => r.isCurrent);
      if (cur) list = [cur, ...list.filter((r) => r !== cur)];
    }
    if (list.length === 0) continue;
    out.push({ id, label, refs: list.slice(0, cap), hidden: Math.max(0, list.length - cap) });
  }
  return out;
}

/**
 * The "Checkout <ref>" a chip's own menu offers — right-clicking a chip used
 * to open the row's commit menu, whose first items check out the refs on that
 * row, and the chip's filter menu took that click. Undefined when there is
 * nothing to check out: the branch HEAD is on (you are there), and a remote's
 * HEAD pointer (a copy of its default branch; checking it out detaches, which
 * is never what anyone means). A tag's label ends in an ellipsis because the
 * host asks first — a tag detaches too, and that is the one case where it is
 * what was meant.
 */
export function chipCheckout(chip: {
  name: string;
  kind: WireRef["kind"];
  sha: string;
}): { label: string; icon: string } | undefined {
  if (!chip.sha || chip.kind === "currentHead" || chip.name.endsWith("/HEAD")) return undefined;
  if (chip.kind === "tag") return { label: `Checkout ${chip.name}…`, icon: "tag" };
  if (chip.kind === "remoteHead") return { label: `Checkout ${chip.name}`, icon: "cloud" };
  return { label: `Checkout ${chip.name}`, icon: "git-branch" };
}
