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

function keyFor(channel: string, payload: unknown): string {
  return channel + "|" + (payload === undefined ? "" : JSON.stringify(payload));
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
  const pending = host.invoke(channel, payload).then(
    (value) => {
      store.set(key, { value, at: Date.now() });
      return value;
    },
    (err) => {
      // Drop the failed in-flight marker so a retry can re-fetch; keep any prior
      // good value in place (callers can still `peek` the last-known-good).
      const prev = store.get(key);
      if (prev && prev.pending) {
        if (prev.value !== undefined) store.set(key, { value: prev.value, at: prev.at });
        else store.delete(key);
      }
      throw err;
    },
  );
  store.set(key, { value: e?.value, at: e?.at ?? 0, pending });
  return pending as Promise<IpcResponse<C>>;
}

/** Force the next `gget`/`peek(maxAge)` for matching channels to refetch.
 *  No prefix → clear everything; a prefix clears channels that start with it. */
export function bust(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
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
