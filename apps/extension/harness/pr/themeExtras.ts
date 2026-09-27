// The --vscode-* values a sidebar or editor webview reads that the merge
// fixtures (scripts/merge-e2e/themes.ts) leave out — inputs, menus, the
// progress bar, contrast borders — per built-in theme, for the pull request
// screenshot harnesses (listShots.ts, pageShots.ts).

import type { VsCodeTheme } from "../../../../scripts/merge-e2e/themes";

/** What a sidebar reads that the merge fixtures leave out: inputs, menus, the progress bar, contrast borders. */
export const SIDEBAR_EXTRA: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-placeholderForeground": "#a6a6a6",
    "--vscode-menu-background": "#252526",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-menu-selectionBackground": "#04395e",
    "--vscode-menu-selectionForeground": "#ffffff",
    "--vscode-menu-border": "#454545",
    "--vscode-menu-separatorBackground": "#454545",
    "--vscode-progressBar-background": "#0e70c0",
  },
  light: {
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-input-border": "#cecece",
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#616161",
    "--vscode-menu-selectionBackground": "#0060c0",
    "--vscode-menu-selectionForeground": "#ffffff",
    "--vscode-menu-border": "#d4d4d4",
    "--vscode-menu-separatorBackground": "#d4d4d4",
    "--vscode-progressBar-background": "#0e70c0",
  },
  "hc-dark": {
    "--vscode-contrastBorder": "#6fc3df",
    "--vscode-contrastActiveBorder": "#f38518",
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
    "--vscode-input-border": "#6fc3df",
    "--vscode-input-placeholderForeground": "rgba(255, 255, 255, 0.7)",
    "--vscode-menu-background": "#000000",
    "--vscode-menu-foreground": "#ffffff",
    "--vscode-menu-border": "#6fc3df",
    "--vscode-menu-separatorBackground": "#6fc3df",
    "--vscode-progressBar-background": "#6fc3df",
  },
  "hc-light": {
    "--vscode-contrastBorder": "#0f4a85",
    "--vscode-contrastActiveBorder": "#006bbd",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
    "--vscode-input-border": "#0f4a85",
    "--vscode-input-placeholderForeground": "rgba(41, 41, 41, 0.7)",
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#292929",
    "--vscode-menu-border": "#0f4a85",
    "--vscode-menu-separatorBackground": "#0f4a85",
    "--vscode-progressBar-background": "#0f4a85",
  },
};
