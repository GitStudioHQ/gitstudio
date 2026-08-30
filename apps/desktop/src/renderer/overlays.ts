// The registry of open floating layers — menus, modals, peeks, the palette,
// the notifications popover, context menus, drawers.
//
// Every one of these appends to `document.body`, which is what makes them float
// above a view — and also what stops a view swap from taking them with it. The
// symptom was an Inbox facet menu still hovering over the Releases page after
// navigating, filtering a list that was no longer on screen.
//
// Rather than have `routeView` know about eight different closers (several of
// which were module-private and never exported), each opener registers how to
// dispose itself and gets a token back. One `dismissLayers()` at the route
// change closes whatever happens to be open.
//
// Deliberately tiny and dependency-free: layers register from modules that this
// one must never import back.

/** What kind of layer this is. Only "menu" is distinguished, and only because
 *  Escape precedence needs it — see `isMenuOpen`. */
export type LayerKind = "menu" | "modal" | "surface";

/** A live floating layer. `dispose` must be idempotent. */
interface Layer {
  id: number;
  kind: LayerKind;
  dispose: () => void;
  /** Optional: "am I still on screen?", asked after a dispose that may have
   *  been declined. A layer that cannot answer is assumed to have closed. */
  stillOpen?: () => boolean;
}

let nextId = 1;
let layers: Layer[] = [];

/**
 * Register an open layer. Returns a handle whose `release()` the opener calls
 * from its OWN close path, so a layer that closes normally doesn't linger in
 * the registry (and can't be disposed twice).
 */
export function registerLayer(
  dispose: () => void,
  kind: LayerKind = "surface",
  stillOpen?: () => boolean,
): LayerHandle {
  const id = nextId++;
  layers.push({ id, kind, dispose, stillOpen });
  return {
    release: () => {
      layers = layers.filter((l) => l.id !== id);
    },
    // "Is anything still open that opened AFTER me?" — the question every
    // surface with a keyboard handler is actually asking, and the registry is
    // the only thing that can answer it. See `ownsEscape` for what happened
    // while they each asked something else.
    isTop: () => layers.length > 0 && layers[layers.length - 1].id === id,
  };
}

/** What `registerLayer` hands back. */
export interface LayerHandle {
  release: () => void;
  /** True while no layer registered after this one is still open. */
  isTop: () => boolean;
}

/**
 * Close every open layer. Called on route changes; safe to call when nothing
 * is open.
 *
 * Iterates a COPY and clears first: a dispose() will call its own release(),
 * which mutates `layers` — walking the live array would skip entries.
 *
 * A layer that DECLINES to close is put back. Not every dispose closes: a
 * dialog with unsaved work vetoes (`hasUnsavedWork`), and one that throws has
 * not closed either. Clearing the array regardless left those surfaces on
 * screen and absent from the registry, and from that point every predicate
 * built on the registry lied about them — `isTop()` false forever for a dialog
 * that IS the top layer, so its Escape was dead; `openLayerCount()` zero with a
 * dialog open, so the page's own ← navigated out from under it. The registry
 * has to describe what is on screen, not what this function intended.
 */
export function dismissLayers(): void {
  const open = layers;
  layers = [];
  const survived: Layer[] = [];
  // Newest first, so a modal opened from a menu closes before the menu.
  for (const l of [...open].reverse()) {
    try {
      l.dispose();
    } catch {
      /* one broken layer must not strand the rest open */
    }
    // A dispose that closed calls its own `release()`, which is a no-op now
    // that `layers` is cleared — so "still here" is decided by asking the layer
    // itself, through the same predicate everything else uses.
    if (l.stillOpen?.()) survived.push(l);
  }
  // In ORIGINAL order, ahead of anything registered DURING the sweep (a
  // dispose can open something). Plain assignment would drop those; reversed
  // order would make `isTop()` name the wrong survivor.
  if (survived.length) {
    survived.sort((a, b) => a.id - b.id);
    layers = [...survived, ...layers];
  }
}

/** How many layers are open — for tests and for handlers that stand down. */
export function openLayerCount(): number {
  return layers.length;
}

/**
 * Hold the page behind a modal surface: everything outside `keep` becomes
 * `inert`, so Tab, the pointer, and assistive tech all stop at the surface.
 *
 * `aria-modal="true"` is a CLAIM, not a mechanism — the Projects drawer set it
 * and every card on the board behind it stayed in the tab order, so Tab walked
 * straight out of the dialog and into a board the user could not see.
 * Returns the release function; call it once, when the surface goes away.
 */
export function holdBackground(keep: HTMLElement): () => void {
  const held: HTMLElement[] = [];
  for (const node of Array.from(document.body.children)) {
    const el = node as HTMLElement;
    if (el === keep || el.contains(keep)) continue;
    // Never a LIVE REGION. Toasts live in a persistent `#toast-stack` on the
    // body, and inerting it made a toast raised over an open palette or dialog
    // unclickable — aiming at its Dismiss ✕ dismissed the layer instead and
    // threw away what had been typed — and, worse, silent: an `aria-live` host
    // inside an inert subtree announces nothing, so an error toast raised while
    // a dialog was open was never read out at all. A live region is not part of
    // the page being held back; it is how the app speaks.
    if (isLiveRegion(el)) continue;
    hold(el);
    held.push(el);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const el of held) drop(el);
  };
}

/**
 * How many open surfaces are holding each element back.
 *
 * A plain boolean attribute cannot answer that, and two surfaces holding the
 * same shell is the ordinary case: a peek or a drawer opens a dialog, so both
 * are up at once. `holdBackground` used to SKIP anything already `inert`, which
 * is right only when the inner surface closes first. It does not always: a
 * route change disposes layers newest-first, the dialog vetoes (that is what
 * `hasUnsavedWork` is for), the drawer beneath it does not — and the drawer's
 * release then stripped `inert` off the shell the surviving dialog still
 * needed. The result was a dialog claiming `aria-modal="true"` over an app that
 * was fully tab-reachable, and activating anything back there routed the whole
 * window behind a dialog the user could still see.
 *
 * A WeakMap, not a Map: the counted elements include a scrim that is removed
 * from the DOM when its surface closes, and a strong Map would pin every one of
 * them for the life of the session.
 *
 * The invariant this rests on: `inert` on a body child is set ONLY here. Verify
 * with `rg 'setAttribute\("inert"' src/renderer/` before adding another.
 */
const holds = new WeakMap<HTMLElement, number>();

function hold(el: HTMLElement): void {
  const n = (holds.get(el) ?? 0) + 1;
  holds.set(el, n);
  if (n === 1) el.setAttribute("inert", "");
}

function drop(el: HTMLElement): void {
  const n = (holds.get(el) ?? 1) - 1;
  if (n <= 0) {
    holds.delete(el);
    el.removeAttribute("inert");
  } else {
    holds.set(el, n);
  }
}

/** A host whose whole job is to announce things. Inerting one silences it. */
function isLiveRegion(el: HTMLElement): boolean {
  return (
    el.id === "toast-stack" ||
    el.matches('[aria-live], [role="status"], [role="alert"], [role="log"]')
  );
}

/**
 * Is a dropdown or context menu open right now?
 *
 * Escape precedence is the problem this answers. Every floating layer attaches
 * its own capture-phase `keydown` to `document`, so which one hears the key
 * first is REGISTRATION ORDER, not stacking order — and `stopPropagation` is no
 * help, because listeners on the same node still all run (only
 * `stopImmediatePropagation` would, and that makes precedence depend on
 * registration order too, which is exactly the thing that is wrong).
 *
 * So one Escape closed both a menu and the peek or dialog it was opened from:
 * you dismissed a menu on top of a surface, and the surface went with it,
 * taking whatever you had typed into it. The palette had a hand-carved
 * exception for this (`body.cmdk-open`); menus never did.
 *
 * A menu is always the topmost thing when it is open — it is opened FROM the
 * surface beneath it — so surfaces stand down while one is up. This is a
 * predicate rather than routing Escape through the registry on purpose: a peek
 * registers a full `dispose` while its Escape means `back()` (one step up its
 * own history), and a dialog deliberately registers `close` rather than
 * `dismiss` so an in-flight clone can veto being dismissed. Those differences
 * are load-bearing.
 */
export function isMenuOpen(): boolean {
  return layers.some((l) => l.kind === "menu");
}

/**
 * Is a modal dialog on screen?
 *
 * A peek and a dialog opened from inside it both listen for Escape on
 * `document`, in the capture phase. `stopPropagation()` does not stop a sibling
 * listener on the SAME node — only `stopImmediatePropagation()` would — and the
 * peek registered first, so it ran first: one Escape dismissed the dialog AND
 * the card that opened it, discarding whatever was behind it. The peek already
 * stands down for the palette and for a menu; a dialog is the third layer that
 * can sit above it.
 */
export function isModalOpen(): boolean {
  return layers.some((l) => l.kind === "modal");
}

/**
 * Does a surface own the Escape key right now, or is something ABOVE it up?
 *
 * The command palette, a menu, and a dialog all sit over whatever opened them,
 * and all of them listen on `document`. `stopPropagation()` does not stop a
 * sibling listener on the same node, and the surface underneath usually
 * registered FIRST, so it runs first: one Escape dismissed the thing you aimed
 * at AND the thing underneath, along with whatever you had typed into it.
 *
 * One helper because three surfaces have now independently forgotten some of
 * these checks — the peek, the Projects drawer, and the notifications popover —
 * each in its own copy of the same three lines. A fourth copy is not the answer.
 */
export function ownsEscape(): boolean {
  return !document.body.classList.contains("cmdk-open") && !isMenuOpen() && !isModalOpen();
}

/**
 * The rule for a PAGE-LEVEL key handler — one that belongs to the view itself
 * rather than to a floating surface. It sits underneath every layer, so ANY
 * open layer outranks it, not only the ones that outrank a peek.
 *
 * `wireDetailEsc` (which answers ← as well as Escape) used a whitelist of four
 * CSS selectors and was moved to `ownsEscape()`, which cannot see a peek — a
 * peek registers as a "surface". So ← started routing the page out from under
 * an open peek and throwing the peek away with it. A page-level handler should
 * never have been asking the peek's question.
 */
export function pageOwnsKeys(): boolean {
  return openLayerCount() === 0 && ownsEscape();
}
