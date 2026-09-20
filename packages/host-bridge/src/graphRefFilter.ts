// The graph's branch filter (issue #30), host side — shared by the extension's
// graph panel and the desktop main process so the two cannot drift on what a
// stored selection means, which refs the picker lists, or which chips a
// filtered row keeps.
//
// IMPORTANT: pure. No `vscode`/`node`/`fs` imports — the purity guard depends
// on it, and the webview imports `fullRefName` for the chip shortcut.

import type { GraphRefEntry, GraphRefFilter, WireRef } from "./graphProtocol";
import type { RefLike } from "./graphWire";

/** What the picker needs from a host's ref, beyond what a chip needs. */
export interface PickerRefLike extends RefLike {
  /** Fully-qualified name, e.g. "refs/heads/main". */
  fullName: string;
  /** Short upstream name ("origin/main"), when the branch tracks one. */
  upstream?: string;
}

/** The fully-qualified name behind a chip — a chip carries only the short
 *  name and its kind, and the filter stores nothing else. */
export function fullRefName(name: string, kind: WireRef["kind"]): string {
  switch (kind) {
    case "tag":
      return `refs/tags/${name}`;
    case "remoteHead":
      return `refs/remotes/${name}`;
    default:
      return `refs/heads/${name}`;
  }
}

/**
 * The full names behind a chip and the remote twins folded into it — what
 * the chip's "Show only this branch" / "Add to filter" shortcut selects.
 *
 * A chip's name is `%(refname:short)`, and short is only SHORTEST UNAMBIGUOUS:
 * the moment a tag and a branch share "release", git hands out
 * "heads/release" and "tags/release", and rebuilding "refs/heads/heads/release"
 * from that names a ref that does not exist. Both hosts prune it, so the
 * shortcut silently showed every branch under a trigger saying "All branches".
 * The picker's list carries the full name git gave each ref, so the chip is
 * resolved through it by name AND kind; fullRefName is the fallback for a
 * chip the list has no entry for.
 */
export function chipRefs(
  refList: readonly GraphRefEntry[],
  name: string,
  kind: WireRef["kind"],
  remotes: readonly string[] = [],
): string[] {
  const resolve = (n: string, k: GraphRefEntry["kind"]): string =>
    refList.find((r) => r.name === n && r.kind === k)?.fullName ?? fullRefName(n, k);
  return [
    resolve(name, kind === "currentHead" ? "head" : kind),
    ...remotes.map((r) => resolve(`${r}/${name}`, "remoteHead")),
  ];
}

/**
 * The picker's list: every branch and tag, the stash and a remote's HEAD
 * pointer left out (neither is a thing you tick — the pointer is a copy of the
 * default branch that already sits beside it). A local branch's upstream is
 * resolved to the listed remote ref's full name, so the "Current + upstream"
 * preset ticks a ref that exists rather than a name that may not.
 */
export function refEntries(refs: readonly PickerRefLike[]): GraphRefEntry[] {
  const byShort = new Map<string, string>();
  for (const r of refs) {
    if (r.type === "remote" && !r.symref) byShort.set(r.name, r.fullName);
  }
  const out: GraphRefEntry[] = [];
  for (const r of refs) {
    if (r.type === "stash" || (r.type === "remote" && r.symref)) continue;
    const entry: GraphRefEntry = {
      fullName: r.fullName,
      name: r.name,
      kind: r.type === "tag" ? "tag" : r.type === "remote" ? "remoteHead" : "head",
    };
    if (r.type === "head" && r.isCurrent) entry.isCurrent = true;
    if (r.type === "head" && r.upstream) {
      // A tracked LOCAL branch is legal too; the remote of that name wins,
      // which is the common case by a mile.
      const up = byShort.get(r.upstream) ?? refs.find((x) => x.type === "head" && x.name === r.upstream)?.fullName;
      if (up) entry.upstream = up;
    }
    out.push(entry);
  }
  return out;
}

/**
 * A stored selection, made safe against the refs that exist NOW.
 *
 * Storage is plain JSON that outlives the branches in it: anything that is not
 * a string, or names a ref the repository no longer has, is dropped silently
 * — a ghost entry would count in the trigger ("3 branches") and could never be
 * unticked. Duplicates collapse. An empty result is `null`: every branch, not
 * a graph of nothing.
 */
export function normalizeRefFilter(
  filter: unknown,
  refs: readonly { fullName: string }[],
): GraphRefFilter {
  if (!Array.isArray(filter)) return null;
  const exists = new Set(refs.map((r) => r.fullName));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of filter) {
    if (typeof f !== "string" || seen.has(f) || !exists.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out.length > 0 ? out : null;
}

/**
 * The chips a filtered graph keeps: the ticked refs, plus the branch HEAD is
 * on — it is in the walk whatever the filter says, so it keeps its chip. With
 * no filter the map is returned as it is.
 */
export function chipRefsUnderFilter<R extends RefLike & { fullName: string }>(
  refsBySha: ReadonlyMap<string, R[]>,
  filter: GraphRefFilter,
): ReadonlyMap<string, R[]> {
  if (!filter) return refsBySha;
  const keep = new Set(filter);
  const out = new Map<string, R[]>();
  for (const [sha, refs] of refsBySha) {
    const kept = refs.filter((r) => keep.has(r.fullName) || (r.type === "head" && r.isCurrent));
    if (kept.length > 0) out.set(sha, kept);
  }
  return out;
}

/** Two filters that select the same refs, order aside. */
export function sameRefFilter(a: GraphRefFilter, b: GraphRefFilter): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((r) => set.has(r));
}
