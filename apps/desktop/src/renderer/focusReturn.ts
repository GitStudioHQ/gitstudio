// Where the keyboard goes when a page changes.
//
// The app's primary gesture is: arrow to a row, press Enter, read the thing,
// press Escape. Both halves used to drop `document.activeElement` on <body>.
// After Enter your next Tab started at the top of the window — past the whole
// nav rail — instead of in the page you had just opened. After Escape the list
// came back with nothing focused at all, so arrowing had to begin again from
// the first row rather than the one you were reading.
//
// Two rules, and they are symmetric:
//
//   leaving a list  → remember which row you were on
//   arriving back   → put focus on that row again
//
// This is deliberately a listener rather than a call at every navigation site.
// Rows are opened from a dozen places (click, Enter, the palette, a deep link,
// a peek's "open full page"), and a mechanism that only works when a caller
// remembers to invoke it is a mechanism that works most of the time. A focusin
// listener sees them all.
//
// The restore is armed rather than immediate because a list's rows arrive
// asynchronously: the view is built, then its data resolves, then rows render.
// So arriving at a view with a remembered row starts a short watch that focuses
// the row the moment it exists, and gives up quietly if it never does (the item
// was deleted, the filter changed, the list is empty now).

/** How long to wait for an asynchronous list to produce the row we want. */
const ARM_MS = 2500;

/** Rows carry `data-num`; that is the identity we remember. */
const ROW_SELECTOR = "[data-num]";

/** view id → the `data-num` of the row focus was last on in that view. */
const lastRow = new Map<string, string>();

let scope = "";
let armed: { view: string; num: string; until: number } | undefined;
let timer = 0;

/**
 * Polling uses a TIMER, not requestAnimationFrame.
 *
 * rAF only runs when the page produces a frame, which is not guaranteed when
 * the window is occluded or minimised — and not guaranteed at all under the
 * headless harness, where a run of short timers can be serviced without a
 * single frame in between. Focus that lands "only when the compositor feels
 * like it" is exactly the kind of intermittent hiccup this module exists to
 * remove.
 */
const POLL_MS = 32;

/**
 * Record focus as it moves. Only rows in the CURRENT view are remembered, so a
 * row focused inside a peek or a modal never becomes the thing we return to.
 */
function onFocusIn(e: FocusEvent): void {
  if (!scope) return;
  const t = e.target as HTMLElement | null;
  const row = t?.closest?.(ROW_SELECTOR) as HTMLElement | null;
  const num = row?.dataset.num;
  if (num) lastRow.set(scope, num);
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
}

/** Poll for the remembered row until it appears or the arm window expires. */
function tick(): void {
  timer = 0;
  if (!armed) return;
  if (armed.view !== scope) {
    armed = undefined;
    return;
  }
  const row = document.querySelector<HTMLElement>(
    `${ROW_SELECTOR}[data-num="${CSS.escape(armed.num)}"]`,
  );
  if (row && row.offsetParent !== null) {
    armed = undefined;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
    return;
  }
  if (Date.now() > armed.until) {
    armed = undefined;
    return;
  }
  timer = window.setTimeout(tick, POLL_MS);
}

/**
 * Tell the module which view is on screen. Called from `routeView` on every
 * navigation — including back/forward and a re-entry into the same section.
 *
 * Arriving at a view we have a remembered row for arms the restore. Arriving
 * anywhere else simply changes the scope, so the next row focused is recorded
 * against the right view.
 */
export function setFocusScope(view: string): void {
  wire();
  scope = view;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  const num = lastRow.get(view);
  armed = num ? { view, num, until: Date.now() + ARM_MS } : undefined;
  if (armed) timer = window.setTimeout(tick, 0);
}

/**
 * Move focus into a page that has just replaced another one.
 *
 * Prefers the page's own heading — a screen reader then announces what you
 * arrived at, which "the back button" does not — and falls back to the first
 * control. `tabindex="-1"` makes a heading programmatically focusable without
 * adding it to the Tab order.
 *
 * Deferred by a frame because a detail page's title is appended by its caller
 * after the shell is built.
 */
export function focusNewPage(view: HTMLElement, fallback?: HTMLElement | null): void {
  // Wait for the page to be BOTH attached and titled before moving focus.
  //
  // A single frame is not enough. `detailPage()` returns its shell to a caller
  // that may await data before attaching it, and the caller appends the <h1>
  // afterwards — so one frame later the view can be unconnected, or connected
  // but headless. The first version bailed out in exactly those cases and left
  // focus on <body>, which is the bug this function exists to fix: it worked
  // for issues and silently did nothing for pull requests.
  let frames = 0;
  const attempt = (): void => {
    // The view was replaced again (a fast second navigation) — let that one win.
    if (frames > 60) return;
    const active = document.activeElement as HTMLElement | null;
    // Never steal focus from something the user is already using: a page that
    // finishes loading while you type in its comment box must not yank the
    // caret away.
    if (active && active !== document.body && view.contains(active)) return;
    const heading = view.isConnected ? view.querySelector<HTMLElement>(".det-title, h1") : null;
    const target = heading ?? (view.isConnected ? fallback ?? null : null);
    if (!target) {
      if (frames++ < 60) window.setTimeout(attempt, POLL_MS);
      return;
    }
    if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus({ preventScroll: true });
  };
  window.setTimeout(attempt, 0);
}

/**
 * When the app destroys the control you were using, put focus on its
 * replacement.
 *
 * Most surfaces here rebuild a whole subtree in response to a click — staging a
 * file, refreshing a list, flipping a sub-tab, changing a rebase action, hiding
 * a column. The node you clicked is detached in the process, focus falls to
 * <body>, and the next Tab starts at the top of the window. That is a different
 * bug from "the page changed" (which `focusNewPage` handles): here you have not
 * gone anywhere, and the thing you were operating still exists — as a new
 * element with the same identity.
 *
 * One listener catches all of it. The rule is deliberately narrow, so it can
 * never steal focus from a person: it acts only when focus landed on <body>
 * AND the element that lost it is no longer in the document. Clicking blank
 * space, closing a menu, or moving focus anywhere real all fail that test.
 */
function sameThing(a: HTMLElement, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;
  const bh = b as HTMLElement;
  const num = a.dataset.num;
  if (num) return bh.dataset?.num === num;
  if (a.title) return bh.title === a.title;
  const label = a.getAttribute("aria-label");
  if (label) return bh.getAttribute("aria-label") === label;
  const t = (a.textContent ?? "").trim();
  if (!t) return false;
  // The BASE class only. A rebuilt control usually differs by exactly the
  // state class the click just changed — flipping Releases to Tags rebuilds
  // the segment and moves `active` onto the button you pressed, so comparing
  // the whole className would fail on precisely the elements this exists for.
  const base = (n: Element): string => (n.className || "").split(" ")[0] ?? "";
  return base(a) === base(bh) && (bh.textContent ?? "").trim() === t;
}

function restoreEquivalent(lost: HTMLElement): boolean {
  // Search only among things that can actually take focus.
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, [role="button"], [role="option"], [role="tab"], a[href], input, select, textarea, [tabindex]',
  );
  for (const el of candidates) {
    // Identity BEFORE visibility, deliberately. Both tests must pass, so the
    // order cannot change which element is chosen — but `offsetParent` is a
    // layout read and `sameThing` is two string comparisons, and this runs
    // over every focusable element in the document, on a poll, during a
    // rebuild. Asking the expensive question first cost 1,758 layout reads on
    // a lap of the app; asking it only of the one candidate that matches costs
    // one.
    if (!sameThing(lost, el)) continue;
    if (el.offsetParent === null && el.tagName !== "INPUT") continue;
    el.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function onFocusOut(e: FocusEvent): void {
  const lost = e.target as HTMLElement | null;
  if (!lost || !lost.tagName) return;
  // Poll briefly rather than checking once. A rebuild is usually asynchronous —
  // the view is torn down, data is awaited, rows arrive — so a single timeout
  // lands in the gap where the old control is gone and the new one does not
  // exist yet, and the rescue quietly finds nothing.
  let tries = 0;
  const attempt = (): void => {
    if (document.activeElement !== document.body) return; // something took it
    if (lost.isConnected) return; // still there — the user simply clicked away
    if (restoreEquivalent(lost)) return;
    if (++tries < 25) window.setTimeout(attempt, POLL_MS);
  };
  window.setTimeout(attempt, POLL_MS);
}

/** Forget everything — a repo switch makes every remembered row meaningless. */
export function clearFocusReturn(): void {
  lastRow.clear();
  armed = undefined;
}
