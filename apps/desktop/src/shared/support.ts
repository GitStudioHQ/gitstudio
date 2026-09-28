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

export const SUPPORT_LINKS: readonly SupportLink[] = [
  {
    id: "sponsor",
    url: "https://github.com/sponsors/antonarnaudov",
    icon: "heart",
    label: "Sponsor on GitHub",
    blurb: "recurring support",
    menuLabel: "Sponsor GitStudio on GitHub…",
    paletteLabel: "Sponsor GitStudio on GitHub",
    keywords: "support sponsor donate fund github sponsors",
  },
  {
    id: "coffee",
    url: "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d",
    icon: "coffee",
    label: "Buy me a coffee",
    blurb: "a one-off tip",
    menuLabel: "Buy Me a Coffee…",
    paletteLabel: "Buy me a coffee",
    keywords: "support donate tip coffee one-off",
  },
];

/** Settings ▸ About's one sentence. */
export const SUPPORT_SENTENCE = "GitStudio is free and open source. If it saves you time, you can support it.";

/** Home's foot line, before its two links. */
export const SUPPORT_LEAD = "GitStudio is free and open source.";
