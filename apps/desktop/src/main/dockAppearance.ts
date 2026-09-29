/**
 * The Dock tile and the remembered appearance, for main.
 *
 * The renderer owns the choice (Settings ▸ Appearance: theme, App icon, Dark
 * style) and reports what it resolves to over `appearance:dockIcon`. This
 * puts the matching tile on the Dock, and remembers the report in userData so
 * the NEXT start can paint the right Dock tile and window ground before the
 * page has said anything. The owner watched the icon change the moment the
 * app opened; a start that guessed from the OS scheme would change it again
 * for anyone on Neon.
 *
 * Electron-free (the Dock setter is passed in) so it runs under node:test.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DARK_STYLE, dockIconFor, parseDarkStyle, type DarkStyle } from "../shared/darkStyle";

export interface DockDeps {
  /** `app.dock.setIcon` — a file path, or null for "the bundle's own icon". */
  setIcon(image: string | null): void;
  /** Where the dock*.png tiles are (dist/renderer). */
  rendererDir: string;
  /** A packaged macOS build: its bundle icon IS the Graphite tile. */
  bundleIsGraphite: boolean;
}

export class DockAppearance {
  /** The dark style the page last reported (Graphite until it says). */
  style: DarkStyle = DEFAULT_DARK_STYLE;
  /** The Dock variant the page last resolved, if it ever has. */
  variant?: "dark" | "light";
  /** Whether this process has drawn its own image on the tile. Until it has,
   *  macOS is drawing the bundle's icon, and "the bundle's icon" means: do
   *  nothing at all. */
  private imageSet = false;

  constructor(
    private readonly file: string,
    private readonly deps: DockDeps,
  ) {}

  /** Read what the last run's page reported. Missing or unreadable: defaults. */
  load(): void {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { style?: unknown; variant?: unknown };
      this.style = parseDarkStyle(saved.style);
      this.variant = saved.variant === "dark" || saved.variant === "light" ? saved.variant : undefined;
    } catch {
      /* first start */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ style: this.style, variant: this.variant }));
    } catch {
      /* best-effort: the page reports again on the next start */
    }
  }

  /**
   * Put the tile for a variant and style on the Dock (best-effort).
   *
   * Graphite in a packaged macOS build is NOT a PNG: it is the icon macOS
   * already draws from the bundle (build/AppIcon.icon on 26+, the graphite
   * icns before it) — the icon the Dock showed while the app was closed. Left
   * alone, nothing is drawn over it and opening GitStudio changes nothing.
   * Coming back to it from Neon or Light hands the tile back to the system
   * (`setIcon(null)` → AppKit's `setApplicationIconImage:nil`).
   */
  apply(variant: "dark" | "light", style: DarkStyle = this.style): void {
    const icon = dockIconFor(variant, style, this.deps.bundleIsGraphite);
    try {
      if (icon === "bundle") {
        if (!this.imageSet) return;
        this.deps.setIcon(null);
        this.imageSet = false;
        return;
      }
      this.deps.setIcon(join(this.deps.rendererDir, icon));
      this.imageSet = true;
    } catch {
      /* no Dock (Windows/Linux) or a missing file — harmless */
    }
  }

  /** The page's report: apply it, and remember it when it changed. */
  report(variant: "dark" | "light", style: unknown): void {
    const parsed = parseDarkStyle(style);
    this.apply(variant, parsed);
    if (parsed === this.style && variant === this.variant) return;
    this.style = parsed;
    this.variant = variant;
    this.save();
  }
}
