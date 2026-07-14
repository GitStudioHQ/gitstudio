// Curated 8-lane color palettes for the commit graph, tuned to read as a
// harmonious family (not a neon rainbow) while keeping AA-ish contrast against
// the editor background in each theme. The dark set is the project's house
// palette; the light set deepens each hue so the thin 1.5px lanes still carry
// against a near-white canvas; the high-contrast sets push to pure, fully
// saturated primaries since HC themes expect bold, unambiguous color.

export type GraphThemeKind = "dark" | "light" | "hc-dark" | "hc-light";

/** Dark base palette (the spec's house colors).
 * Tuned for max lane separation at a 1.6–1.8px stroke: each hue is pushed a
 * little brighter/more saturated than a pure house tint so thin lanes carry
 * against the editor bg and adjacent lanes never read as the same color. */
export const LANE_PALETTE_DARK: readonly string[] = [
  "#52a8ff", // blue   — trunk, the most legible/forward hue
  "#3ad17f", // green
  "#cf7ae6", // magenta
  "#edb14a", // amber
  "#f56a9b", // pink
  "#2dccca", // teal
  "#b29bff", // violet
  "#e0935a", // orange
];

/** Light palette: the same hues, darkened/desaturated for contrast on white.
 * Slightly deeper than the dark set so a 1.6px lane stays readable on a
 * near-white canvas without going muddy. */
export const LANE_PALETTE_LIGHT: readonly string[] = [
  "#1773cc", // blue
  "#198a52", // green
  "#9442b3", // magenta
  "#a86c14", // amber
  "#c93567", // pink
  "#0d8c91", // teal
  "#6f4fe8", // violet
  "#b0601f", // orange
];

/** High-contrast dark: vivid, fully separated primaries on black. */
export const LANE_PALETTE_HC_DARK: readonly string[] = [
  "#3794ff",
  "#23d18b",
  "#d670d6",
  "#f5d76e",
  "#ff6e9a",
  "#29e0e0",
  "#b18cff",
  "#ff9e4f",
];

/** High-contrast light: deep, fully separated primaries on white. */
export const LANE_PALETTE_HC_LIGHT: readonly string[] = [
  "#0050b3",
  "#0a7d3f",
  "#8e24aa",
  "#9a6a00",
  "#c2185b",
  "#00838f",
  "#5a2fd6",
  "#a04a00",
];

/** Reads the active VS Code theme kind off `document.body`'s classes. */
export function currentGraphThemeKind(): GraphThemeKind {
  const classes = document.body.classList;
  if (classes.contains("vscode-high-contrast-light")) {
    return "hc-light";
  }
  if (classes.contains("vscode-high-contrast")) {
    return "hc-dark";
  }
  if (classes.contains("vscode-light")) {
    return "light";
  }
  return "dark";
}

/** The lane palette matching the current theme. */
export function paletteForTheme(
  kind: GraphThemeKind = currentGraphThemeKind(),
): readonly string[] {
  switch (kind) {
    case "light":
      return LANE_PALETTE_LIGHT;
    case "hc-dark":
      return LANE_PALETTE_HC_DARK;
    case "hc-light":
      return LANE_PALETTE_HC_LIGHT;
    case "dark":
    default:
      return LANE_PALETTE_DARK;
  }
}

/**
 * Subscribes to VS Code theme changes (it swaps the `vscode-*` class on
 * `document.body`) and invokes `onChange` with the new palette. Returns a
 * disposer. Mirrors the MutationObserver approach in theme.ts.
 */
export function observeGraphTheme(
  onChange: (palette: readonly string[], kind: GraphThemeKind) => void,
): () => void {
  let last = currentGraphThemeKind();
  const observer = new MutationObserver(() => {
    const next = currentGraphThemeKind();
    if (next !== last) {
      last = next;
      onChange(paletteForTheme(next), next);
    }
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
