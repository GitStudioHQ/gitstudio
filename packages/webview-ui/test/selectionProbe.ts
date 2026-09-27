// The owner's rule for selection, as a check a headless page can run:
// selectionProbe.js (plain browser JavaScript, injected as it is) plus the
// themes to run it in. The rule, and what the probe counts as a line, are
// described at the top of selectionProbe.js.
//
// The shared components' sweep is test/selectionIsLit.test.ts. The
// extension's webviews use the same probe in
// apps/extension/test/selectionIsLit.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

/** The probe's source. Evaluated in a page, it defines window.gsSelectionProbe(opts). */
export const SELECTION_PROBE = readFileSync(fileURLToPath(new URL("./selectionProbe.js", import.meta.url)), "utf8");

export interface ProbeOptions {
  /** A high-contrast theme: a whole ring is VS Code's selection mark there. */
  hc?: boolean;
  /** Selectors whose fill must plainly differ from their unselected sibling's. */
  targets?: string[];
  /** State elements to leave out (a selector). */
  skip?: string;
  /** Measure text on the tints (default true). */
  contrast?: boolean;
  /** Every state element's fill must plainly differ from its sibling's (but fillSkip's). */
  fillAll?: boolean;
  fillSkip?: string;
  /** [selector, sibling selector]: a chosen thing with no state class, and what to judge it by. */
  also?: [string, string][];
}

export interface ProbeResult {
  lines: string[];
  fills: string[];
  contrast: string[];
  seen: string[];
}

export type SweepTheme = Extract<VsCodeTheme, "dark" | "light" | "hc-dark" | "hc-light">;

/**
 * The list, menu and contrast tokens the swept surfaces read that the merge
 * themes (scripts/merge-e2e/themes.ts) leave out. These are VS Code's
 * defaults for Dark+, Light+ and the two High Contrast themes. The HC themes
 * define no selection background at all: a selection there is its outline.
 */
export const LIST_TOKENS: Record<SweepTheme, Record<string, string>> = {
  dark: {
    "--vscode-menu-background": "#252526",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-list-focusOutline": "#007fd4",
    "--vscode-list-inactiveSelectionBackground": "#37373d",
    "--vscode-list-highlightForeground": "#2aaaff",
    "--vscode-list-focusHighlightForeground": "#2aaaff",
  },
  light: {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#616161",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-list-focusOutline": "#0090f1",
    "--vscode-list-inactiveSelectionBackground": "#e4e6f1",
    "--vscode-list-highlightForeground": "#0066bf",
    "--vscode-list-focusHighlightForeground": "#bbe7ff",
  },
  "hc-dark": {
    "--vscode-menu-background": "#000000",
    "--vscode-menu-foreground": "#ffffff",
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
    "--vscode-input-border": "#6fc3df",
    "--vscode-list-focusOutline": "#f38518",
    "--vscode-contrastActiveBorder": "#f38518",
    "--vscode-contrastBorder": "#6fc3df",
    "--vscode-list-highlightForeground": "#f38518",
    "--vscode-list-focusHighlightForeground": "#f38518",
  },
  "hc-light": {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#292929",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
    "--vscode-input-border": "#0f4a85",
    "--vscode-list-focusOutline": "#006bbd",
    "--vscode-contrastActiveBorder": "#006bbd",
    "--vscode-contrastBorder": "#0f4a85",
    "--vscode-list-highlightForeground": "#006bbd",
    "--vscode-list-focusHighlightForeground": "#006bbd",
  },
};

/** Every --vscode-* a webview in `theme` is given. */
export function themeVars(theme: SweepTheme): Record<string, string> {
  return { ...VSCODE_THEMES[theme], ...LIST_TOKENS[theme] };
}

/** A script line that puts `theme` on the page as VS Code does: the variables on <html>, the kind on <body>. */
export function applyThemeScript(theme: SweepTheme): string {
  return `
    for (const [k, v] of Object.entries(${JSON.stringify(themeVars(theme))})) document.documentElement.style.setProperty(k, v);
    document.body.className = ${JSON.stringify(BODY_CLASS[theme])};
    document.body.style.background = ${JSON.stringify(themeVars(theme)["--vscode-sideBar-background"] ?? "")};
  `;
}

/**
 * Script text for a runInChrome page: `sweep(label, opts)` runs the probe
 * and turns every line, every flat fill and every short contrast into a
 * failure named by `label`. Outside High Contrast every state element's
 * fill is judged, not only the named targets. It needs the page's `fails` and `notes` (as
 * runInChrome provides them).
 */
export function sweepScript(theme: SweepTheme): string {
  return `
    ${SELECTION_PROBE}
    const HC = ${JSON.stringify(theme.startsWith("hc"))};
    const sweep = (label, opts = {}) => {
      const r = window.gsSelectionProbe({ hc: HC, fillAll: !HC, ...opts });
      for (const l of r.lines) fails.push(label + ": " + l);
      for (const f of r.fills) fails.push(label + ": " + f);
      for (const c of r.contrast) fails.push(label + ": text on the tint " + c);
      notes[label] = r.seen;
      return r;
    };
  `;
}
