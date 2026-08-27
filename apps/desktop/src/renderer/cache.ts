// A tiny stale-while-revalidate cache over the host bridge. Read-heavy views
// (graph, code tree, branches, status, GitHub lists) re-render constantly as you
// switch tabs; without caching every switch re-hits git/GitHub and feels slow.
//
// Usage pattern in a view:
//   const cached = peek("branches:list", undefined);   // sync — instant paint
//   if (cached) renderRows(cached); else renderSkeleton();
//   renderRows(await gget("branches:list", undefined)); // fresh (cheap if warm)
//
// After any mutation (commit/stage/checkout/sync/push/PR action) call
// `bust()` (everything) or `bust("branches")` (a channel prefix) so the next
// read refetches. `prime()` seeds a value fetched elsewhere.

import type { IpcChannel, IpcRequest, IpcResponse } from "../shared/ipc";
import { host } from "./bridge";

interface Entry {
  value: unknown;
  /** epoch ms when stored. */
  at: number;
  /** in-flight fetch, so concurrent callers share one request. */
  pending?: Promise<unknown>;
}

const store = new Map<string, Entry>();

/** Default freshness window (ms) — within this, `gget` skips the network. */
const DEFAULT_TTL = 8000;

/** The active repo root. Every cache key is namespaced by it so a fast repo
 *  switch can never resolve repo A's (cached or in-flight) data into repo B's
 *  view — switching repos wipes the cache outright. */
let scope = "";

/**
 * Bumped by every `bust()` and every scope change. A request that was already
 * in flight when the cache was invalidated must NOT write its (pre-mutation)
 * answer back — doing so re-seeded stale data with a FRESH timestamp, so a
 * just-deleted branch reappeared for the whole TTL and looked like the delete
 * had failed. The epoch is captured when the request starts and re-checked
 * before the write.
 */
let epoch = 0;

/**
 * Point the cache at a repo. Changing the active repo clears all cached entries
 * (a different repo's branches/status/graph must never bleed through). Call this
 * on every `repo:changed` before re-rendering.
 */
export function setCacheScope(repoRoot: string | undefined): void {
  const next = repoRoot ?? "";
  if (next !== scope) {
    scope = next;
    store.clear();
    epoch++;
  }
}

function keyFor(channel: string, payload: unknown): string {
  return scope + " " + channel + "|" + (payload === undefined ? "" : JSON.stringify(payload));
}

/** The cached value if present and (optionally) younger than `maxAgeMs`. */
export function peek<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
  maxAgeMs = Infinity,
): IpcResponse<C> | undefined {
  const e = store.get(keyFor(channel, payload));
  if (!e) return undefined;
  if (Date.now() - e.at > maxAgeMs) return undefined;
  return e.value as IpcResponse<C>;
}

/**
 * Cached get. Returns the cached value when it's younger than `ttl`; otherwise
 * invokes the host, stores, and returns it. Concurrent calls for the same key
 * dedupe onto a single in-flight request.
 */
export async function gget<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
  ttl = DEFAULT_TTL,
): Promise<IpcResponse<C>> {
  const key = keyFor(channel, payload);
  const e = store.get(key);
  if (e) {
    if (e.pending) return e.pending as Promise<IpcResponse<C>>;
    if (Date.now() - e.at <= ttl) return e.value as IpcResponse<C>;
  }
  const startedEpoch = epoch;
  const startedScope = scope;
  /** Was the cache invalidated (or the repo switched) while we were waiting? */
  const superseded = (): boolean => epoch !== startedEpoch || scope !== startedScope;

  let pending!: Promise<unknown>;
  /**
   * Retire OUR in-flight marker when the request settles.
   *
   * Clearing the marker and PUBLISHING the answer are two different decisions,
   * and conflating them was a real bug. `gget` short-circuits on `e.pending`
   * before it ever looks at the TTL, so an entry left holding a settled promise
   * is pinned to that one answer for the rest of the session. That is what
   * happened whenever an unrelated prefix bust — staging a file fires
   * `bust("status")` and `bust("diff")` — landed while a GitHub list was
   * loading: the list froze on whatever it had, and Refresh did nothing.
   * If the request had FAILED, the entry served that rejection forever instead.
   *
   * So: always clear the marker; only publish the value when nothing has
   * invalidated the cache meanwhile.
   *
   * The identity check matters too. If a bust cleared our entry and a newer
   * request took its place — or `prime()` seeded a value from an event that is
   * newer than the read we started earlier — that entry is not ours to touch.
   */
  const settle = (next?: Entry): void => {
    const cur = store.get(key);
    if (!cur || cur.pending !== pending) return;
    if (next) {
      store.set(key, next);
    } else if (cur.value !== undefined) {
      // Keep the last-known-good readable via `peek`, with its ORIGINAL
      // timestamp so the next `gget` still treats it as stale and refetches.
      store.set(key, { value: cur.value, at: cur.at });
    } else {
      store.delete(key);
    }
  };

  pending = host.invoke(channel, payload).then(
    (value) => {
      settle(superseded() ? undefined : { value, at: Date.now() });
      return value;
    },
    (err) => {
      settle(undefined);
      throw err;
    },
  );
  store.set(key, { value: e?.value, at: e?.at ?? 0, pending });
  return pending as Promise<IpcResponse<C>>;
}

/** Force the next `gget`/`peek(maxAge)` for matching channels to refetch.
 *  No prefix → clear everything; a prefix clears the current repo's channels
 *  that start with it (keys are namespaced by repo scope, so match within it). */
export function bust(prefix?: string): void {
  epoch++;
  if (!prefix) {
    store.clear();
    return;
  }
  const scoped = scope + " " + prefix;
  for (const k of store.keys()) {
    if (k.startsWith(scoped)) store.delete(k);
  }
}

/** Seed the cache with a value obtained elsewhere (e.g. an event payload). */
export function prime<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
  value: IpcResponse<C>,
): void {
  store.set(keyFor(channel, payload), { value, at: Date.now() });
}
