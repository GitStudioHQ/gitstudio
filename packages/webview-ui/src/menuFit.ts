// Where a popup menu goes, and when it goes away — one rule for every menu
// these webviews draw themselves (issue #103).
//
// A webview is a box inside the editor: the Commit Graph panel under the
// editor is often 250px tall, a sidebar view less. A menu that always opened
// down from the pointer ran out of the box there, and the box clips: the last
// items were cut off with no way to scroll to them. And a click anywhere
// outside the box — another editor, the Explorer, the terminal — never
// reaches the page at all, so a menu that only listened for clicks stayed
// pinned until you came back and clicked inside.

/** What a menu opens from: a row, a button, or the pointer (a point). */
export interface MenuAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The pointer as an anchor: a menu opens down-right from it, or flips. */
export const atPoint = (x: number, y: number): MenuAnchor => ({ left: x, top: y, right: x, bottom: y });

export interface FitOptions {
  /** Room kept clear at every edge of the view. */
  pad?: number;
  /** Space between the anchor and the menu. */
  gap?: number;
  /** "start" (default): the menu's left edge on the anchor's left, flipping
   *  to end there when the right has no room. "end": its right edge on the
   *  anchor's right first (a menu under a button at a row's end). */
  align?: "start" | "end";
  /** Height at the foot of the view that something else covers — the
   *  desktop's terminal dock (`--dock-reserve`). */
  bottomReserve?: number;
}

/** The max-height each menu's last fit set, told apart from one of its own. */
const fitted = new WeakMap<HTMLElement, string>();

/**
 * Place a `position: fixed` menu that is already in the page beside `anchor`,
 * wholly inside the view: below the anchor when it fits there, else above it
 * (flipped — its bottom edge on the anchor's top), else as low as it can sit
 * and still end inside; to the right, else to the left, else against the
 * right edge. A menu taller than the view is capped at the view's height and
 * scrolls, so its last item is always one scroll away — and an item the
 * keyboard focuses scrolls into view on its own (focus() does that).
 *
 * The size is measured, never guessed: offsetWidth/offsetHeight, the LAYOUT
 * size, because a menu mid-way through its entrance animation is transformed
 * and its bounding rect reads small. Idempotent: calling it again on the same
 * menu and anchor gives the same place, so a host may call it on every render.
 */
export function fitMenu(menu: HTMLElement, anchor: MenuAnchor, opts: FitOptions = {}): void {
  const pad = opts.pad ?? 6;
  const gap = opts.gap ?? 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight - Math.max(0, opts.bottomReserve ?? 0);
  // Never taller than the view; past that, it scrolls. The menu's own cap
  // stands when it is the smaller one — read with the last fit's taken off,
  // so a view that grew is not held to it. The view's height is the border
  // box's, so a content-box shell gives its padding and border back first.
  // A shell that clips (overflow hidden, for its rounded corners) scrolls.
  if (menu.style.maxHeight && menu.style.maxHeight === fitted.get(menu)) menu.style.maxHeight = "";
  const cs = getComputedStyle(menu);
  const own = cs.maxHeight.endsWith("px") ? parseFloat(cs.maxHeight) : Infinity;
  const frame =
    cs.boxSizing === "border-box"
      ? 0
      : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const room = Math.max(0, Math.floor(vh - 2 * pad - frame));
  menu.style.maxHeight = `${Math.min(own, room)}px`;
  fitted.set(menu, menu.style.maxHeight);
  if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") menu.style.overflowY = "auto";
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;

  let top: number;
  if (anchor.bottom + gap + h <= vh - pad) top = anchor.bottom + gap;
  else if (anchor.top - gap - h >= pad) top = anchor.top - gap - h;
  else top = Math.max(pad, vh - pad - h);

  const toRight = anchor.left; // opens rightwards from the anchor's left
  const toLeft = anchor.right - w; // opens leftwards from the anchor's right
  const fitsRight = toRight + w <= vw - pad;
  const fitsLeft = toLeft >= pad;
  let left: number;
  if (opts.align === "end") left = fitsLeft ? toLeft : fitsRight ? toRight : vw - pad - w;
  else left = fitsRight ? toRight : fitsLeft ? toLeft : vw - pad - w;
  left = Math.max(pad, left);

  menu.style.left = `${Math.floor(left)}px`;
  menu.style.top = `${Math.floor(top)}px`;
}

/**
 * Call `close` when focus leaves the page — the only sign a webview gets of a
 * click in another editor, the Explorer, the terminal or another app — and
 * when the page is hidden (its panel or tab put away). A focus move INSIDE
 * the page is not that: `blur` on the window is checked against
 * document.hasFocus() once the move has settled, so focus going from the list
 * to the menu, or into a frame of the page's own, keeps the menu open.
 *
 * For menus and popovers only. A dialog that holds typed text (a branch name)
 * must survive switching apps, which blurs the window just the same.
 *
 * Returns the function that stops listening.
 */
export function closeOnFocusLeave(close: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onBlur = (e: Event): void => {
    // The window's own blur. Element blurs do not bubble, but a listener in
    // the capture phase would see them all.
    if (e.target !== window) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.hasFocus()) close();
    }, 0);
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") close();
  };
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
