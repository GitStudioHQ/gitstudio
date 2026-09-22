// The graph's branch filter (issue #30), host side — shared by the extension's
// graph panel and the desktop main process so the two cannot drift on what a
// stored selection means, which refs the picker lists, or which chips a
// filtered row keeps.
//
// IMPORTANT: pure. No `vscode`/`node`/`fs` imports — the purity guard depends
// on it, and the webview imports `chipRefs` for the chip shortcut.

import type { GraphRefEntry, GraphRefFilter, RefPreset, WireRef } from "./graphProtocol";
import type { RefLike } from "./graphWire";

/** What the picker needs from a host's ref, beyond what a chip needs. */
export interface PickerRefLike extends RefLike {
  /** Fully-qualified name, e.g. "refs/heads/main". */
  fullName: string;
  /** Short upstream name ("origin/main"), when the branch tracks one. */
  upstream?: string;
}

/**
 * The full names behind a chip and the remote twins folded into it — what
 * the chip's "Show only this branch" / "Add to filter" shortcut selects, and
 * `[0]` is what its "Checkout" checks out. Every chip surface resolves through
 * here: the graph's rows, the rail's, and the commit-details pane's.
 *
 * A chip's name is `%(refname:short)`, and short is only SHORTEST UNAMBIGUOUS:
 * the moment a tag and a branch share "release", git hands out
 * "heads/release" and "tags/release". So a full name is never REBUILT from a
 * chip — "refs/heads/heads/release" names nothing, the hosts pruned it, and
 * the shortcut silently showed every branch under a trigger saying "All
 * branches". The picker's list carries the full name git gave each ref; the
 * chip is looked up there by name AND kind.
 *
 * A chip the list has no entry for resolves to NOTHING (`[]`), and its menu
 * offers no action: guessing a namespace for it is the bug above. The list
 * and the chips come from the same ref listing, so this is only ever a
 * moment's disagreement (a details pane read just before a refresh landed);
 * a twin that is not listed is left out rather than guessed.
 */
export function chipRefs(
  refList: readonly GraphRefEntry[],
  name: string,
  kind: WireRef["kind"],
  remotes: readonly string[] = [],
): string[] {
  const resolve = (n: string, k: GraphRefEntry["kind"]): string | undefined =>
    refList.find((r) => r.name === n && r.kind === k)?.fullName;
  const own = resolve(name, kind === "currentHead" ? "head" : kind);
  if (!own) return [];
  const twins = remotes
    .map((r) => resolve(`${r}/${name}`, "remoteHead"))
    .filter((f): f is string => f !== undefined);
  return [own, ...twins];
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

// ── Presets that follow the repository (issue #30) ──────────────────────────
//
// "Current branch" used to be stored as the branch it resolved to when it was
// clicked. Switch branches and the filter still named the old one, no preset
// was highlighted, and the graph went on showing a branch you had left. The
// presets are stored as what they MEAN instead — these entries — and every
// load resolves them against the refs that exist then. A stored filter may mix
// them with full names; the picker only ever sends a preset alone.

/** The branch HEAD is on (nothing while HEAD is detached — HEAD itself is
 *  walked then, which is what "current" means with no branch). */
export const CURRENT_BRANCH = "@current";
/** That branch's upstream, when it tracks one that exists. */
export const CURRENT_UPSTREAM = "@upstream";
/** Every local branch — including the ones made after the preset was picked. */
export const LOCAL_BRANCHES = "@local";

const SYMBOLIC = new Set([CURRENT_BRANCH, CURRENT_UPSTREAM, LOCAL_BRANCHES]);

export type { RefPreset };

/** What a preset is STORED as — the symbolic filter the picker sends. */
export function presetRefs(id: RefPreset): GraphRefFilter {
  switch (id) {
    case "current":
      return [CURRENT_BRANCH];
    case "currentUpstream":
      return [CURRENT_BRANCH, CURRENT_UPSTREAM];
    case "local":
      return [LOCAL_BRANCHES];
    case "all":
      return null;
  }
}

/** The preset a stored filter IS, if it is exactly one; "all" for none. */
export function filterPreset(filter: GraphRefFilter): RefPreset | undefined {
  if (filter === null) return "all";
  for (const id of ["current", "currentUpstream", "local"] as const) {
    if (sameRefFilter(filter, presetRefs(id))) return id;
  }
  return undefined;
}

/**
 * The full names a stored filter stands for NOW: each symbolic entry resolved
 * against `list` (the picker's entries — they carry the current flag and the
 * upstream's full name), each full name kept as it is, duplicates collapsed.
 * `null` stays null (every branch). The result can be EMPTY — "Current branch"
 * on a detached HEAD — which walks HEAD alone, or nothing when HEAD is attached.
 */
export function resolveRefFilter(
  filter: GraphRefFilter,
  list: readonly GraphRefEntry[],
): string[] | null {
  if (filter === null) return null;
  const current = list.find((r) => r.kind === "head" && r.isCurrent);
  const out: string[] = [];
  const add = (f: string | undefined): void => {
    if (f && !out.includes(f)) out.push(f);
  };
  for (const f of filter) {
    if (f === CURRENT_BRANCH) {
      add(current?.fullName);
    } else if (f === CURRENT_UPSTREAM) {
      add(current?.upstream);
    } else if (f === LOCAL_BRANCHES) {
      for (const r of list) {
        if (r.kind === "head") add(r.fullName);
      }
    } else {
      add(f);
    }
  }
  return out;
}

/**
 * Whether HEAD is detached, as far as a ref listing can tell: no local branch
 * in it is current. A walk under a filter adds HEAD only then (see
 * LogProvider's `head`). A listing that failed says nothing, and answers
 * true — keeping HEAD in the walk is the safe mistake.
 */
export function headIsDetached(refs: readonly RefLike[]): boolean {
  return !refs.some((r) => r.type === "head" && r.isCurrent);
}

/** What one load of a filtered graph walks, and what it tells the webview. */
export interface FilterWalk {
  /** The full names to walk (LogProvider's `refs`); null for every branch. */
  refs: string[] | null;
  /** Walk HEAD beside them (LogProvider's `head`): only when detached. */
  head: boolean;
  /** The preset the stored filter is, when it is one (graphInit's `refPreset`). */
  preset?: RefPreset;
}

/**
 * The walk for a stored (normalized) filter, from the SAME listing both hosts
 * decorate the rows with — so the rows, the chips, the picker's ticks and a
 * reveal's "is it in the graph?" all describe one walk. One function, because
 * the extension and the desktop each had their own copy of this step and it
 * is how two products drift.
 */
export function filterWalk(
  stored: GraphRefFilter,
  list: readonly GraphRefEntry[],
  refs: readonly RefLike[],
): FilterWalk {
  const walked = resolveRefFilter(stored, list);
  const preset = filterPreset(stored);
  return {
    refs: walked,
    head: headIsDetached(refs),
    ...(preset && preset !== "all" ? { preset } : {}),
  };
}

/**
 * Whether the commit HEAD is on is part of a walk — for what hangs off it
 * (the extension's "Uncommitted changes" row is parented on HEAD, and a row
 * parented on a commit the graph does not have is a lane to nowhere). True
 * with no filter, when HEAD is walked itself, when the current branch is
 * ticked, or when another ticked ref happens to reach it on a loaded row.
 */
export function headInWalk(
  walk: FilterWalk,
  list: readonly GraphRefEntry[],
  loaded: { has(sha: string): boolean },
  headSha: string,
): boolean {
  if (!walk.refs || walk.head) return true;
  const current = list.find((r) => r.kind === "head" && r.isCurrent);
  if (current && walk.refs.includes(current.fullName)) return true;
  return !!headSha && loaded.has(headSha);
}

/**
 * A stored selection, made safe against the refs that exist NOW.
 *
 * Storage is plain JSON that outlives the branches in it: anything that is not
 * a string, or names a ref the repository no longer has, is dropped silently
 * — a ghost entry would count in the trigger ("3 branches") and could never be
 * unticked. The preset entries (CURRENT_BRANCH …) are kept: they name no ref,
 * they are resolved per load. Duplicates collapse. An empty result is `null`:
 * every branch, not a graph of nothing.
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
    if (typeof f !== "string" || seen.has(f) || !(exists.has(f) || SYMBOLIC.has(f))) continue;
    seen.add(f);
    out.push(f);
  }
  return out.length > 0 ? out : null;
}

/**
 * The chips a filtered graph keeps: exactly the refs it was walked from
 * (`walked`, the RESOLVED filter). The current branch no longer keeps one
 * regardless — it is no longer walked regardless (see headIsDetached); when it
 * is ticked, or a preset stands for it, it is in `walked` like any other. With
 * no filter the map is returned as it is.
 */
export function chipRefsUnderFilter<R extends RefLike & { fullName: string }>(
  refsBySha: ReadonlyMap<string, R[]>,
  walked: readonly string[] | null,
): ReadonlyMap<string, R[]> {
  if (!walked) return refsBySha;
  const keep = new Set(walked);
  const out = new Map<string, R[]>();
  for (const [sha, refs] of refsBySha) {
    const kept = refs.filter((r) => keep.has(r.fullName));
    if (kept.length > 0) out.set(sha, kept);
  }
  return out;
}

/**
 * A fingerprint of the picker's list, for "has it changed since I last sent
 * it?" (issue #30).
 *
 * The list is every branch and tag, and a graphInit carried the whole of it on
 * every load — about 1 MB on a repository with ten thousand tags, again on
 * every debounced refresh, almost always identical to the last one. A host
 * sends it only when this moves. Every field the webview reads goes in, in
 * order; a reorder is a change like any other.
 *
 * A 53-bit hash rather than the joined string, because the desktop sends it
 * back across IPC on every page request, and a megabyte of key there would
 * cost what the whole exercise saves. Computed in one pass with no string
 * built, so it is cheap next to the for-each-ref that produced the list.
 */
export function refListSignature(list: readonly GraphRefEntry[]): string {
  // cyrb53 (public domain), fed field by field.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    // A separator no ref name can contain, so "ab"+"c" never hashes as "a"+"bc".
    h1 = Math.imul(h1 ^ 0x1f, 2654435761);
    h2 = Math.imul(h2 ^ 0x1f, 1597334677);
  };
  for (const r of list) {
    feed(r.fullName);
    feed(r.name);
    feed(r.kind);
    feed(r.isCurrent ? "*" : "");
    feed(r.upstream ?? "");
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${list.length}:${hash.toString(36)}`;
}

/**
 * What a host puts in a graphInit's `refList`: the list when the webview does
 * not have it yet, nothing when it does. One per webview — `forget()` when
 * that webview (re)loads, because a fresh page has no list whatever was sent
 * to the one before it.
 */
export class RefListCourier {
  private sent: string | undefined;

  /** The list to send with this graphInit, or undefined to leave it out. */
  take(list: GraphRefEntry[]): GraphRefEntry[] | undefined {
    const sig = refListSignature(list);
    if (sig === this.sent) return undefined;
    this.sent = sig;
    return list;
  }

  /** The webview lost what it had (it reloaded): send the next list whole. */
  forget(): void {
    this.sent = undefined;
  }
}

/** Two filters that select the same refs, order aside. */
export function sameRefFilter(a: GraphRefFilter, b: GraphRefFilter): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((r) => set.has(r));
}
