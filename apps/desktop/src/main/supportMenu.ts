// Help ▸ Sponsor GitStudio on GitHub… and Buy Me a Coffee…: the menu's half
// of shared/support.ts. Kept out of main.ts (which needs Electron to load) so
// the items — their words, their order, and the page each one opens — are
// unit-tested; main.ts hands in its openExternalSafely.

import type { MenuItemConstructorOptions } from "electron";
import { SUPPORT_LINKS } from "../shared/support";

export function supportMenuItems(open: (url: string) => void): MenuItemConstructorOptions[] {
  return SUPPORT_LINKS.map((link) => ({
    label: link.menuLabel,
    click: () => open(link.url),
  }));
}
