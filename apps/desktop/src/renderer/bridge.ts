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

import type { GitStudioBridge, GraphRefFilter, InTheWayInfo, InvokeScope } from "../shared/ipc";
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
 *
 * A `stashNote` on the answer the door gets is said here too, whether or not
 * a question was asked: a stash applied without the staging git could not
 * restore carries one on its first answer.
 */
async function invokeAsking(channel: string, payload: unknown): Promise<unknown> {
  // The tab this call belongs to is decided NOW, at the call, and both of its
  // round trips go to that tab's repository — the question in between is a
  // modal, and no tab switch happens under a modal.
  const owner = activeSession;
  const send = (p: unknown): Promise<unknown> => owned(channel, owner, sendRaw(channel, p, owner));
  const first = await send(payload);
  const way = (first as { inTheWay?: InTheWayInfo } | undefined)?.inTheWay;
  const retry = Object.hasOwn(STASH_AND_RETRY, channel) ? STASH_AND_RETRY[channel] : undefined;
  if (!way || !askInTheWay || !retry) return noted(first);
  const again = retry(payload, way.root);
  if (again === undefined) return first;
  if (!(await askInTheWay(way, (first as { message?: string }).message))) {
    return { ok: false, changed: false, expected: true, cancelled: true };
  }
  return noted(await send(again));
}

/** Say an answer's `stashNote`, and hand the answer on. */
function noted(answer: unknown): unknown {
  const note = (answer as { stashNote?: unknown } | undefined)?.stashNote;
  if (typeof note === "string" && note) sayStashNote?.(note);
  return answer;
}

// ── Which tab a call belongs to (issue #32) ────────────────────────────────
//
// Every open repository is a tab with its own App, and only one is in front.
// A call is stamped with the tab that was in front when it was MADE — main
// runs it against that tab's repository (the preload's third argument) — and
// its answer is delivered only while that tab is in front again. An answer for
// a tab in the background waits at the door; one for a tab that has been
// closed is dropped. So a slow read started in A can never paint into B, a
// push that finishes in A says so when you are back in A, and a flow with two
// steps can never make its second call against B.
// docs/desktop-repo-tabs.md has the whole table.

/** One tab's lifetime. A repository closed and opened again is a NEW session. */
export interface TabSession {
  readonly id: number;
  readonly root: string | undefined;
}

let activeSession: TabSession | undefined;
/** Answers that landed while their tab was in the background, in order. */
const waiting = new Map<number, Array<() => void>>();
/** Sessions whose tab is gone — their answers are dropped, never delivered. */
const ended = new Set<number>();

/**
 * The calls that CHANGE the tabs. Their answers are never held: they are about
 * the tab row, not about the tab that asked, and holding "you opened X" until
 * you come back to the tab you opened it FROM would land you nowhere.
 */
const TAB_CHANNELS = new Set([
  "repo:open",
  "repo:openPath",
  "repo:close",
  "repo:tabs",
  "repo:activate",
  "repo:closeTab",
  "repo:moveTab",
  "ghrepo:open",
  "clone:start",
  // main's openRepoPath, like repo:openPath: another worktree opens as a tab.
  "worktree:open",
]);
/** Of those, the ones that OPEN a repository — see inOpenLanding. */
const OPENING = new Set(["repo:open", "repo:openPath", "ghrepo:open", "clone:start", "worktree:open"]);

/**
 * The operations a tab shows as running (its spinner) and a close asks about,
 * with the words the question uses. Reads are not here: a slow read is not
 * something closing a tab could lose.
 */
const OPERATIONS: Readonly<Record<string, string>> = {
  "sync:fetch": "a fetch",
  "sync:pull": "a pull",
  "sync:push": "a push",
  "branch:push": "a push",
  "branch:publish": "a publish",
  "branch:pullFf": "a pull",
  "branch:merge": "a merge",
  "branch:rebase": "a rebase",
  "branch:resetToUpstream": "a reset",
  "branch:deleteRemote": "a remote branch deletion",
  "rebase:apply": "a rebase",
  "rebase:continue": "a rebase",
  "rebase:skip": "a rebase",
  "op:continue": "a continue",
  "op:skip": "a skip",
  "op:abort": "an abort",
  commit: "a commit",
  "commit:action": "a git operation",
  "commit:drop": "a commit drop",
  // Drop N / Squash N (#32): the same rebase as a drop, of several commits.
  "commits:rewrite": "a rewrite of several commits",
  "pr:checkout": "a pull request checkout",
  "stash:apply": "a stash apply",
  "stash:pop": "a stash pop",
  "stash:save": "a stash",
  "tag:push": "a tag push",
  "worktree:add": "a worktree add",
  "worktree:remove": "a worktree removal",
  "ai:agentRun": "an Assistant run",
};

/** Operation calls still in flight, per session → their channels. */
const running = new Map<number, string[]>();
const runningListeners = new Set<() => void>();

function sendRaw(channel: string, payload: unknown, owner: TabSession | undefined): Promise<unknown> {
  const invoke = raw.invoke as (c: string, p: unknown, s?: InvokeScope) => Promise<unknown>;
  const scope: InvokeScope = { root: owner?.root };
  const p = invoke(channel, payload, scope);
  const op = owner && Object.hasOwn(OPERATIONS, channel);
  if (op && owner) {
    const list = running.get(owner.id) ?? [];
    list.push(channel);
    running.set(owner.id, list);
    notifyRunning();
    const done = (): void => {
      const now = running.get(owner.id);
      if (!now) return;
      const i = now.indexOf(channel);
      if (i >= 0) now.splice(i, 1);
      if (!now.length) running.delete(owner.id);
      notifyRunning();
    };
    p.then(done, done);
  }
  return p;
}

function notifyRunning(): void {
  for (const fn of runningListeners) {
    try {
      fn();
    } catch {
      /* a listener's fault is its own */
    }
  }
}

/** Opening landed: true only while the continuations of an OPEN's answer run. */
let landing = false;

/** Deliver `p`'s answer to its tab — now, later, or never. */
function owned<T>(channel: string, owner: TabSession | undefined, p: Promise<T>): Promise<T> {
  if (TAB_CHANNELS.has(channel)) {
    if (!OPENING.has(channel)) return p;
    // Mark the continuations of an open's answer — they run as microtasks
    // before the next task — so a route they ask of the tab they were started
    // from goes to the tab that was just opened (see inOpenLanding).
    return p.then(
      (v) => {
        landing = true;
        setTimeout(() => (landing = false), 0);
        return v;
      },
      (e) => {
        throw e;
      },
    );
  }
  if (!owner) return p;
  return new Promise<T>((resolve, reject) => {
    const deliver = (fn: () => void): void => {
      if (ended.has(owner.id)) return; // the tab is gone: nobody to tell
      if (activeSession?.id === owner.id) {
        fn();
        return;
      }
      let q = waiting.get(owner.id);
      if (!q) {
        q = [];
        waiting.set(owner.id, q);
      }
      q.push(fn);
    };
    p.then(
      (v) => deliver(() => resolve(v)),
      (e) => deliver(() => reject(e)),
    );
  });
}

/**
 * The tab in front changed. Called by the tab shell AFTER that tab's screen is
 * attached, so every held answer it now delivers lands in the screen it was
 * asked for, in the order the answers arrived.
 */
export function setActiveSession(s: TabSession | undefined): void {
  activeSession = s;
  if (!s) return;
  const q = waiting.get(s.id);
  if (!q) return;
  waiting.delete(s.id);
  for (const fn of q) fn();
}

/** The tab in front, or undefined when no repository is open. */
export function currentSession(): TabSession | undefined {
  return activeSession;
}

/** A tab closed: drop every answer still owed to it, now and later. */
export function endSession(id: number): void {
  ended.add(id);
  waiting.delete(id);
  if (running.delete(id)) notifyRunning();
}

/** How many answers are waiting for a background tab (for its checks). */
export function heldFor(id: number): number {
  return waiting.get(id)?.length ?? 0;
}

/** The operation still running in a tab, in words ("a push"), or undefined. */
export function runningOperation(id: number): string | undefined {
  const list = running.get(id);
  return list && list.length ? OPERATIONS[list[0]] : undefined;
}

/** Subscribe to operations starting and ending in any tab (the spinners). */
export function onRunningChange(fn: () => void): () => void {
  runningListeners.add(fn);
  return () => runningListeners.delete(fn);
}

/**
 * Is this the answer to an OPEN landing right now?
 *
 * `await openPath(root); nav("code")` means "land in the repository I just
 * opened" — and by the time the answer arrives that repository is the tab in
 * front, while `nav` belongs to the tab the open was started from. The tab
 * shell sends such a route to the tab in front; any other route asked of a
 * background tab is dropped.
 */
export function inOpenLanding(): boolean {
  return landing;
}

export const host: GitStudioBridge = {
  invoke: invokeAsking as GitStudioBridge["invoke"],
  on: (event, listener) => raw.on(event, listener),
};

/**
 * Calls that belong to no tab — the tab row's own questions (which tabs have
 * changes). Never held, and stamped "the tab in front" by main's default.
 */
export const shellHost: Pick<GitStudioBridge, "invoke"> = {
  invoke: ((channel: string, payload: unknown) =>
    (raw.invoke as (c: string, p: unknown) => Promise<unknown>)(channel, payload)) as GitStudioBridge["invoke"],
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
