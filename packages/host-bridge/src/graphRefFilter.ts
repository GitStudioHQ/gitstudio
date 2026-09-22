// The graph's branch filter (issue #30), host side — shared by the extension's
// graph panel and the desktop main process so the two cannot drift on what a
// stored selection means, which refs the picker lists, or which chips a
// filtered row keeps.
//
// IMPORTANT: pure. No `vscode`/`node`/`fs` imports — the purity guard depends
// on it, and the webview imports `chipRefs` for the chip shortcut.

import type { GraphRefEntry, GraphRefFilter, WireRef } from "./graphProtocol";
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
