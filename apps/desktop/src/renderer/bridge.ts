// Renderer-side access to the host. `window.gitstudio` is the typed surface the
// preload exposed over the contextBridge; this module gives the rest of the
// renderer a single import for it plus the graph-protocol adapter that lets the
// UNCHANGED `<gitstudio-graph>` element speak to the desktop host.
//
// The shared graph element was written for a VS Code webview: it expects to
// receive `graphInit` / `graphAppend` messages and to post `selectCommit` /
// `openCommit` / `contextMenu` / `loadMore` back. The desktop host instead
// answers a single `graph:load` IPC call returning a page. `GraphHostAdapter`
// bridges the two — it pages via IPC and feeds the element host messages — so
// the component itself needs no desktop-specific code.

import type { GitStudioBridge, GraphRefFilter, InTheWayInfo } from "../shared/ipc";
import type { GraphInitMessage, GraphAppendMessage } from "@gitstudio/host-bridge/graphProtocol";
import { nextGraphMessage } from "../shared/graphAdapterCore";

declare global {
  interface Window {
    gitstudio: GitStudioBridge;
  }
}

const raw: GitStudioBridge = window.gitstudio;

/**
 * Asks the user about uncommitted work in a command's way; true for Stash &
 * Retry. Installed at boot (inTheWayAsk.ts) rather than imported, because the
 * dialogs module already imports this one through ui.ts.
 */
type InTheWayAsker = (way: InTheWayInfo, message: string | undefined) => Promise<boolean>;
let askInTheWay: InTheWayAsker | undefined;
let sayStashNote: ((note: string) => void) | undefined;

export function answerInTheWayWith(ask: InTheWayAsker, note: (note: string) => void): void {
  askInTheWay = ask;
  sayStashNote = note;
}

/** An object request, again, carrying `stashFirst`. */
const withStashFirst = (payload: unknown, root: string): unknown =>
  payload && typeof payload === "object" ? { ...(payload as object), stashFirst: root } : undefined;

/**
 * The channels whose answer can carry `inTheWay` — every bridge method that
 * runs its command through main/inTheWay.ts — and how each request is sent
 * again with `stashFirst`. Two take a bare value, and a pull may take nothing.
 * test/inTheWayCensus.test.ts holds this list and main's doors to each other.
 */
export const STASH_AND_RETRY: Readonly<Record<string, (payload: unknown, root: string) => unknown>> = {
  "commit:action": withStashFirst,
  "branch:create": withStashFirst,
  "branch:merge": withStashFirst,
  "branch:rebase": withStashFirst,
  "stash:apply": (p, root) => (typeof p === "string" ? { ref: p, stashFirst: root } : withStashFirst(p, root)),
  "stash:pop": (p, root) => (typeof p === "string" ? { ref: p, stashFirst: root } : withStashFirst(p, root)),
  "pr:checkout": (p, root) => (typeof p === "number" ? { number: p, stashFirst: root } : withStashFirst(p, root)),
  "sync:pull": (p, root) => (p === undefined || p === null ? { stashFirst: root } : withStashFirst(p, root)),
};

/**
 * Every door that applies commits — a checkout, a revert, a cherry-pick, a
 * merge, a rebase, a stash applied or popped, a branch created and switched
 * to, a pull request checked out, a pull — answers `inTheWay` when git refuses
 * it over the user's uncommitted work (main/inTheWay.ts). The question is
 * asked HERE, once, for all of them: a door cannot forget it, and a new door
 * gets it for free. Stash & Retry sends the SAME request again with
 * `stashFirst` — the repository the refusal came from, which main checks —
 * and hands the door that answer instead; Cancel hands it `cancelled`, which
 * every door takes as "nothing ran, say nothing".
 *
 * Asked once per request: an answer to the retry that is STILL in the way
 * (something the stash could not cover) goes to the door as it is, to be said.
 */
async function invokeAsking(channel: string, payload: unknown): Promise<unknown> {
  const invoke = raw.invoke as (c: string, p: unknown) => Promise<unknown>;
  const first = await invoke(channel, payload);
  const way = (first as { inTheWay?: InTheWayInfo } | undefined)?.inTheWay;
  const retry = Object.hasOwn(STASH_AND_RETRY, channel) ? STASH_AND_RETRY[channel] : undefined;
  if (!way || !askInTheWay || !retry) return first;
  const again = retry(payload, way.root);
  if (again === undefined) return first;
  if (!(await askInTheWay(way, (first as { message?: string }).message))) {
    return { ok: false, changed: false, expected: true, cancelled: true };
  }
  const second = await invoke(channel, again);
  const note = (second as { stashNote?: string } | undefined)?.stashNote;
  if (note) sayStashNote?.(note);
  return second;
}

export const host: GitStudioBridge = {
  invoke: invokeAsking as GitStudioBridge["invoke"],
  on: (event, listener) => raw.on(event, listener),
};

/**
 * Drives the `<gitstudio-graph>` element off the desktop `graph:load` IPC.
 * Owns the paging cursor and translates each page into the host message the
 * element expects; the pure page→message translation lives in graphAdapterCore
 * so it can be unit-tested without a browser.
 */
export class GraphHostAdapter {
  private skip = 0;
  private loading = false;
  private exhausted = false;
  /**
   * Bumped on every reset. A page request that was in flight when the graph was
   * reset (repo switch, refresh) must not apply its result: it would splice a
   * page of the OLD history onto the freshly-reset list and set `skip` from a
   * cursor that no longer means anything, so subsequent paging skipped or
   * duplicated commits.
   */
  private gen = 0;
  /**
   * The signature of the ref list this adapter last HANDED the element — what
   * each request tells the main process it holds, so an unchanged list (every
   * branch and tag; a megabyte with ten thousand tags) stays on that side of
   * IPC. Recorded only on delivery: a page dropped as stale delivered
   * nothing, so the next request still says the old list, and gets the new.
   * The element and this adapter are made together (GraphMount), so it starts
   * empty exactly when the element does.
   */
  private refListSig: string | undefined;

  constructor(
    private readonly onMessage: (msg: GraphInitMessage | GraphAppendMessage) => void,
  ) {}

  /** Resets to the first page (e.g. after the active repo changes). */
  reset(): void {
    this.gen++;
    this.skip = 0;
    this.loading = false;
    this.exhausted = false;
  }

  /** Loads the first page and feeds a `graphInit` to the element. */
  async loadInitial(): Promise<void> {
    this.reset();
    await this.page(true);
  }

  /**
   * The Branches picker changed the filter (issue #30). The host remembers it
   * per repository and rebuilds from page 0; every page loaded so far was
   * walked under the old filter, so the cursor resets with it.
   */
  async setRefFilter(refs: GraphRefFilter): Promise<void> {
    this.reset();
    await this.page(true, refs);
  }

  /** Loads the next page (called when the element nears its bottom). */
  async loadMore(): Promise<void> {
    if (this.exhausted) {
      return;
    }
    await this.page(false);
  }

  private async page(initial: boolean, refs?: GraphRefFilter): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    const myGen = this.gen;
    try {
      const result = await host.invoke("graph:load", {
        skip: this.skip,
        refs,
        ...(this.refListSig !== undefined ? { refListSig: this.refListSig } : {}),
      });
      if (myGen !== this.gen) {
        return; // reset while we waited — this page belongs to a dead view
      }
      this.skip = result.nextSkip;
      this.exhausted = !result.hasMore;
      this.onMessage(nextGraphMessage(result, initial));
      // Only a graphInit carries the list to the element.
      if (initial && result.refList) this.refListSig = result.refListSig;
    } finally {
      // Only clear the flag we set. A superseded request must not unblock a
      // newer one that is legitimately in flight.
      if (myGen === this.gen) {
        this.loading = false;
      }
    }
  }
}
