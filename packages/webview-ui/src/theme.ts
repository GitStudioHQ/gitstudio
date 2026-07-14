// Bridges the active VS Code theme into Monaco so the panes blend with the
// host editor instead of shipping Monaco's stock palette: a custom theme is
// (re)defined from the webview's --vscode-* CSS variables, and the editor font
// settings are mirrored from the host as well.

import * as monaco from "monaco-editor";

export type ThemeKind = "light" | "dark" | "hc-dark" | "hc-light";

function currentThemeKind(): ThemeKind {
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

function baseThemeFor(kind: ThemeKind): monaco.editor.BuiltinTheme {
  switch (kind) {
    case "light":
      return "vs";
    case "hc-dark":
      return "hc-black";
    case "hc-light":
      return "hc-light";
    case "dark":
    default:
      return "vs-dark";
  }
}

/** CSS variable -> Monaco theme color key, applied when the var resolves. */
const COLOR_MAP: Array<[cssVar: string, themeKey: string]> = [
  ["--vscode-editor-background", "editor.background"],
  ["--vscode-editor-foreground", "editor.foreground"],
  ["--vscode-editorLineNumber-foreground", "editorLineNumber.foreground"],
  ["--vscode-editorLineNumber-activeForeground", "editorLineNumber.activeForeground"],
  ["--vscode-editorCursor-foreground", "editorCursor.foreground"],
  ["--vscode-editor-selectionBackground", "editor.selectionBackground"],
  ["--vscode-editor-inactiveSelectionBackground", "editor.inactiveSelectionBackground"],
  ["--vscode-editorWidget-background", "editorWidget.background"],
  ["--vscode-editorWidget-border", "editorWidget.border"],
  ["--vscode-scrollbarSlider-background", "scrollbarSlider.background"],
  ["--vscode-scrollbarSlider-hoverBackground", "scrollbarSlider.hoverBackground"],
  ["--vscode-scrollbarSlider-activeBackground", "scrollbarSlider.activeBackground"],
  ["--vscode-editorIndentGuide-background", "editorIndentGuide.background"],
];

/**
 * Defines (or redefines) the `jb-native` Monaco theme from the current VS Code
 * CSS variables and returns its name. Call again after a theme switch.
 */
export function ensureNativeTheme(): string {
  const kind = currentThemeKind();
  const styles = getComputedStyle(document.body);
  const colors: Record<string, string> = {};
  for (const [cssVar, themeKey] of COLOR_MAP) {
    const hex = cssColorToHex(styles.getPropertyValue(cssVar));
    if (hex) {
      colors[themeKey] = hex;
    }
  }
  try {
    monaco.editor.defineTheme("jb-native", {
      base: baseThemeFor(kind),
      inherit: true,
      rules: [],
      colors,
    });
    return "jb-native";
  } catch {
    return baseThemeFor(kind);
  }
}

/** Editor font options mirrored from the host's editor settings. */
export function nativeFontOptions(): monaco.editor.IEditorOptions {
  const styles = getComputedStyle(document.body);
  const options: monaco.editor.IEditorOptions = {};
  const family = styles.getPropertyValue("--vscode-editor-font-family").trim();
  if (family) {
    options.fontFamily = family;
  }
  const size = parseFloat(styles.getPropertyValue("--vscode-editor-font-size"));
  if (Number.isFinite(size) && size > 0) {
    options.fontSize = size;
  }
  const weight = styles.getPropertyValue("--vscode-editor-font-weight").trim();
  if (weight) {
    options.fontWeight = weight;
  }
  return options;
}

/**
 * Normalizes a CSS color (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`)
 * to the hex form Monaco accepts; returns undefined for anything else.
 */
function cssColorToHex(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) {
    return value;
  }
  const match = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (!match) {
    return undefined;
  }
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const [, r, g, b, a] = match;
  let hex = `#${toHex(Number(r))}${toHex(Number(g))}${toHex(Number(b))}`;
  if (a !== undefined) {
    hex += toHex(Number(a) * 255);
  }
  return hex;
}
