/**
 * Settings ▸ Appearance ▸ Dark style — which of the two dark looks GitStudio
 * wears, in the window AND in the Dock.
 *
 *   graphite  the grey tile macOS draws for the app while it is CLOSED (the
 *             Icon Composer icon, build/AppIcon.icon, on its #2B2B30 ground)
 *             and the app's slate dark palette. The default, because it is the
 *             only dark look the Dock can show both before and after the app
 *             opens: the owner saw the icon change the moment GitStudio started.
 *   neon      the near-black tile with the violet cube (brand/gitstudio-icon.svg)
 *             and a deeper, more violet dark palette.
 *
 * Pure data, shared by main (window background, Dock tile), the renderer
 * (body class, Settings) and the tests that hold the three in step with
 * app.css and index.html. theme-boot.js cannot import it (it runs before the
 * bundle) and repeats the pref key and class; test/darkStyle.test.ts keeps
 * the copies equal.
 */

export type DarkStyle = "graphite" | "neon";

export const DARK_STYLES: readonly DarkStyle[] = ["graphite", "neon"];

/** What a person who never chose gets: the look the closed app already has. */
export const DEFAULT_DARK_STYLE: DarkStyle = "graphite";

/** The body class that switches app.css to the Neon token block. Graphite is
 *  the plain `body.vscode-dark` block and needs no class. */
export const NEON_CLASS = "gs-neon";

/** The field in the renderer's prefs blob (localStorage gitstudio.ui.prefs). */
export const DARK_STYLE_PREF = "darkStyle";

/** Anything read from storage or IPC → a style; unknown values are the default. */
export function parseDarkStyle(v: unknown): DarkStyle {
  return v === "neon" || v === "graphite" ? v : DEFAULT_DARK_STYLE;
}

/**
 * The window's own background for a theme: the renderer's `--app-bg`, which
 * is also the launch screen's ground (test/launchScreen.test.ts). Shown for
 * the frames before the page paints, so it must be the ground that page
 * paints — per dark style.
 */
export const WINDOW_BACKGROUND = {
  light: "#eef1f5",
  graphite: "#0d1016",
  neon: "#09090e",
} as const;

export function windowBackgroundFor(theme: "dark" | "light", style: DarkStyle): string {
  return theme === "light" ? WINDOW_BACKGROUND.light : WINDOW_BACKGROUND[style];
}

/**
 * What the Dock should show while the app runs.
 *
 *   "bundle"  nothing — the icon macOS already draws from the app bundle.
 *             That IS the closed icon (Graphite), so there is nothing to
 *             change and nothing to get subtly wrong: not re-drawing it is the
 *             only way the running icon is guaranteed identical.
 *   a file    one of the margined PNGs esbuild copies into dist/renderer.
 *
 * `bundleIsGraphite` is true in a packaged macOS build (the bundle carries
 * AppIcon.icon / the graphite icns). A dev build's bundle is Electron's own,
 * so it paints the graphite tile from its PNG instead.
 */
export type DockIcon = "bundle" | "dock.png" | "dock-light.png" | "dock-graphite.png";

export function dockIconFor(variant: "dark" | "light", style: DarkStyle, bundleIsGraphite: boolean): DockIcon {
  if (variant === "light") return "dock-light.png";
  if (style === "neon") return "dock.png";
  return bundleIsGraphite ? "bundle" : "dock-graphite.png";
}

/** The full-bleed tile Settings previews each style with (dist/renderer). */
export function previewIconFor(style: DarkStyle): string {
  return style === "neon" ? "./icon.png" : "./icon-graphite.png";
}
