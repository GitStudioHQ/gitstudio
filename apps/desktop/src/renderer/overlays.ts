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

/** A live floating layer. `dispose` must be idempotent. */
interface Layer {
  id: number;
  dispose: () => void;
}

let nextId = 1;
let layers: Layer[] = [];

/**
 * Register an open layer. Returns a handle whose `release()` the opener calls
 * from its OWN close path, so a layer that closes normally doesn't linger in
 * the registry (and can't be disposed twice).
 */
export function registerLayer(dispose: () => void): { release: () => void } {
  const id = nextId++;
  layers.push({ id, dispose });
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
