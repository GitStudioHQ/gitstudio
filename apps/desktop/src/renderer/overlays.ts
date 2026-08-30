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
): { release: () => void } {
  const id = nextId++;
  layers.push({ id, kind, dispose });
  return {
    release: () => {
      layers = layers.filter((l) => l.id !== id);
    },
  };
}

/**
 * Close every open layer. Called on route changes; safe to call when nothing
 * is open.
 *
 * Iterates a COPY and clears first: a dispose() will call its own release(),
 * which mutates `layers` — walking the live array would skip entries.
 */
export function dismissLayers(): void {
  const open = layers;
  layers = [];
  // Newest first, so a modal opened from a menu closes before the menu.
  for (const l of [...open].reverse()) {
    try {
      l.dispose();
    } catch {
      /* one broken layer must not strand the rest open */
    }
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
    if (el === keep || el.contains(keep) || el.hasAttribute("inert")) continue;
    // Never a LIVE REGION. Toasts live in a persistent `#toast-stack` on the
    // body, and inerting it made a toast raised over an open palette or dialog
    // unclickable — aiming at its Dismiss ✕ dismissed the layer instead and
    // threw away what had been typed — and, worse, silent: an `aria-live` host
    // inside an inert subtree announces nothing, so an error toast raised while
    // a dialog was open was never read out at all. A live region is not part of
    // the page being held back; it is how the app speaks.
    if (isLiveRegion(el)) continue;
    el.setAttribute("inert", "");
    held.push(el);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const el of held) el.removeAttribute("inert");
  };
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
