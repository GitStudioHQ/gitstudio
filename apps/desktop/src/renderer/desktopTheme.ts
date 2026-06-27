// The single most important reuse seam in the renderer.
//
// Every shared UI piece — the <gitstudio-graph> element, the Monaco theme
// bridge in @gitstudio/webview-ui/theme, the lane palette, and the diff/merge
// CSS — keys entirely off two things: the `vscode-dark` / `vscode-light` class
// on document.body, and a family of `--vscode-*` CSS custom properties. The
// extension gets those for free from the VS Code webview host. The desktop app
// supplies them itself here, so the exact same components render unmodified.
//
// We honor `prefers-color-scheme` and react to OS theme changes live.

export type AppTheme = "dark" | "light";
/** The user's choice: follow the OS, or pin light/dark. */
export type ThemeMode = "system" | "light" | "dark";

/** Apply the theme: set the body class the shared code reads and let CSS vars resolve. */
export function applyTheme(theme: AppTheme): void {
  const body = document.body;
  body.classList.remove("vscode-dark", "vscode-light");
  body.classList.add(theme === "light" ? "vscode-light" : "vscode-dark");
  body.dataset.theme = theme;
}

/** Resolve the current OS color-scheme preference. */
export function preferredTheme(): AppTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Resolve a mode to a concrete theme ("system" → the live OS preference). */
export function resolveTheme(mode: ThemeMode): AppTheme {
  return mode === "system" ? preferredTheme() : mode;
}

/** Notify on OS theme changes (does NOT auto-apply — the caller honors the mode). */
export function followSystemTheme(onChange: (osTheme: AppTheme) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!mq) {
    return () => {};
  }
  const listener = (): void => onChange(preferredTheme());
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
