// The two ways to support GitStudio, and every word the app says about them.
//
// One list for each place that offers them — Help ▸ Sponsor GitStudio on
// GitHub… / Buy Me a Coffee… (main), Settings ▸ About, the quiet line at the
// foot of Home and ⌘K (renderer) — so no two of them can name a different
// page. The owner's rule: visible, not annoying. They are only ever places
// you go looking, or one muted line on a page you already see; nothing here
// opens by itself (no toast, no timer, no count).
//
// Both open in the browser through main's openExternalSafely (http/https
// only): the menu calls it directly, the renderer with window.open, which the
// window's open handler routes to it.

import * as l10n from "@vscode/l10n";

export interface SupportLink {
  id: "sponsor" | "coffee";
  /** The page. The READMEs, the extensions and .github/FUNDING.yml carry the same two. */
  url: string;
  /** A codicon from the set the app ships (styles/codicons-full.css). */
  icon: string;
  /** A button's words (Settings ▸ About, Home): the READMEs'. */
  label: string;
  /** What kind of support it is, as the READMEs say it. */
  blurb: string;
  /** Help menu item (a macOS menu item's title case). */
  menuLabel: string;
  /** ⌘K row. */
  paletteLabel: string;
  /** Extra words ⌘K matches. */
  keywords: string;
}

// Every label/blurb below is a GETTER, not a plain string property: this array
// is a module-level constant, built once at import time — before boot()
// configures the l10n bundle (main/language.ts) for main, or before the
// renderer's own l10nBoot runs. A plain string here would freeze to English
// forever; a getter defers l10n.t() to the moment something actually reads
// `.label` etc., which is always after the bundle is ready. Property access
// (`link.label`) is unchanged for every caller.
export const SUPPORT_LINKS: readonly SupportLink[] = [
  {
    id: "sponsor",
    url: "https://github.com/sponsors/antonarnaudov",
    icon: "heart",
    get label() {
      return l10n.t("Sponsor on GitHub");
    },
    get blurb() {
      return l10n.t("recurring support");
    },
    get menuLabel() {
      return l10n.t("Sponsor GitStudio on GitHub…");
    },
    get paletteLabel() {
      return l10n.t("Sponsor GitStudio on GitHub");
    },
    keywords: "support sponsor donate fund github sponsors",
  },
  {
    id: "coffee",
    url: "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d",
    icon: "coffee",
    get label() {
      return l10n.t("Buy me a coffee");
    },
    get blurb() {
      return l10n.t("a one-off tip");
    },
    get menuLabel() {
      return l10n.t("Buy Me a Coffee…");
    },
    get paletteLabel() {
      return l10n.t("Buy me a coffee");
    },
    keywords: "support donate tip coffee one-off",
  },
];

/**
 * Settings ▸ About's one sentence, and Home's foot line.
 *
 * NOT wrapped in l10n.t() here: both are plain exported constants read
 * directly by the renderer (renderer.ts, views/dashboard.ts) as string values,
 * not through a function call or a property access — unlike SUPPORT_LINKS
 * above, turning them into a lazy getter would mean every READER changing how
 * it reads them, and those readers are outside this file's scope. Left as
 * English constants; the renderer-side l10n pass is the right place to either
 * wrap these at their point of use or change this export's shape.
 */
export const SUPPORT_SENTENCE = "GitStudio is free and open source. If it saves you time, you can support it.";

/** Home's foot line, before its two links. */
export const SUPPORT_LEAD = "GitStudio is free and open source.";
