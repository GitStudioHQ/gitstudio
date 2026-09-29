// The hand-off from the launch screen to the app.
//
// index.html paints #launch before any of this bundle runs (inline CSS and
// SVG; theme-boot.js picks its theme and tells main to show the window). Once
// the shell is up — the tab row and the tab in front are on the page beneath
// it — the screen dissolves and is removed.
//
// It is never held for show. From the first frame of the dissolve, clicks,
// drags and the pointer belong to the app, so the launch screen costs the app
// no time at all. That is why the mark is whole from its first frame
// (index.html): it used to assemble — graph onto cube, then the wordmark — and a
// warm start dissolved it half-drawn, a cube with no graph. (Holding the app
// back to let an animation land was tried and measured: it added a quarter of
// a second to half the starts.)

/** The dissolve: #launch's opacity transition in index.html (a test keeps the two equal). */
export const LAUNCH_FADE_MS = 220;

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* marks are for measuring only */
  }
}

let dismissed = false;

/** The app is up: fade the launch screen out and remove it. Safe to call twice. */
export function dismissLaunchScreen(): void {
  if (dismissed) return;
  dismissed = true;
  mark("gs:app-ready");
  const el = document.getElementById("launch");
  if (!el) return;
  mark("gs:launch-handoff");
  // index.html: .is-leaving drops pointer events and the drag region, and
  // starts the dissolve.
  el.classList.add("is-leaving");
  // A timer, not transitionend: a transition that never runs (a hidden
  // window, a headless clock) must not leave the screen behind.
  setTimeout(() => {
    el.remove();
    mark("gs:launch-gone");
  }, LAUNCH_FADE_MS + 40);
}
