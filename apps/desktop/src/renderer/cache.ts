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
  const pending = host.invoke(channel, payload).then(
    (value) => {
      // Only publish if nothing invalidated the cache meanwhile — otherwise this
      // answer predates the mutation that busted it.
      if (!superseded()) {
        store.set(key, { value, at: Date.now() });
      }
      return value;
    },
    (err) => {
      // Drop the failed in-flight marker so a retry can re-fetch; keep any prior
      // good value in place (callers can still `peek` the last-known-good).
      if (!superseded()) {
        const prev = store.get(key);
        if (prev && prev.pending) {
          if (prev.value !== undefined) store.set(key, { value: prev.value, at: prev.at });
          else store.delete(key);
        }
      }
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
