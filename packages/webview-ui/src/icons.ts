// Inline SVG icons modelled on IntelliJ's diff/merge glyph set. All icons use
// currentColor so they inherit the surrounding control's foreground.

const SVG_OPEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">';

function svg(body: string): string {
  return `${SVG_OPEN}${body}</svg>`;
}

/** ≫ — apply a change from the left pane into the result. */
export const chevronDoubleRight = svg(
  '<path d="M4 4l4 4-4 4"/><path d="M9 4l4 4-4 4"/>',
);

/** ≪ — apply a change from the right pane into the result. */
export const chevronDoubleLeft = svg(
  '<path d="M12 4l-4 4 4 4"/><path d="M7 4l-4 4 4 4"/>',
);

/** ✕ — ignore a change (keep the base text). */
export const cross = svg('<path d="M4.5 4.5l7 7"/><path d="M11.5 4.5l-7 7"/>');

/** Navigation arrows (previous / next change). */
export const arrowUp = svg('<path d="M8 13V3"/><path d="M4 7l4-4 4 4"/>');
export const arrowDown = svg('<path d="M8 3v10"/><path d="M4 9l4 4 4-4"/>');

/** ≫≪ facing pair — apply all non-conflicting changes from both sides. */
export const chevronsInward = svg(
  '<path d="M3 4l3.5 4L3 12"/><path d="M13 4L9.5 8l3.5 4"/>',
);

/** Magic wand — resolve simple (identical) conflicts. */
export const magicWand = svg(
  '<path d="M3.5 12.5L9 7"/>' +
  '<path d="M11.5 2.5v3M10 4h3"/>' +
  '<path d="M13 8.5h2M14 7.5v2" stroke-width="1.1"/>' +
  '<path d="M5 2.8v2M4 3.8h2" stroke-width="1.1"/>',
);

/** Linked vertical arrows — synchronized scrolling toggle. */
export const syncScroll = svg(
  '<path d="M5 12.5v-9"/><path d="M2.8 5.5L5 3.2l2.2 2.3"/>' +
  '<path d="M11 3.5v9"/><path d="M8.8 10.5l2.2 2.3 2.2-2.3"/>',
);

/** Circular arrow — reset the merge to its initial state. */
export const resetIcon = svg(
  '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8V5h-2.2"/>',
);

/** Padlock — read-only pane marker (matches IntelliJ's header lock). */
export const lockIcon = svg(
  '<rect x="3.5" y="7" width="9" height="6" rx="1"/>' +
  '<path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
);

/** Curved arrow left — undo the last merge action. */
export const undoIcon = svg(
  '<path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H6"/><path d="M6 4L3.5 6.5 6 9"/>',
);

/** Curved arrow right — redo the last undone merge action. */
export const redoIcon = svg(
  '<path d="M12.5 6.5h-6a3.5 3.5 0 0 0 0 7H10"/><path d="M10 4l2.5 2.5L10 9"/>',
);

/** Clock — the merge action history dropdown. */
export const historyIcon = svg(
  '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2V8l2 1.6"/>',
);

/** Box with outward arrow — hand the merge to the external JetBrains IDE. */
export const openExternal = svg(
  '<path d="M6.5 3.5h-3v9h9v-3"/>' +
  '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/>',
);

/** Builds a DOM element from one of the SVG strings above. */
export function iconElement(svgMarkup: string, className = "jb-svg"): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = svgMarkup;
  return span;
}
