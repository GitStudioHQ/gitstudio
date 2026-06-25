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

/** Apply the theme: set the body class the shared code reads and let CSS vars resolve. */
export function applyTheme(theme: AppTheme): void {
  const body = document.body;
  body.classList.remove("vscode-dark", "vscode-light");
  body.classList.add(theme === "light" ? "vscode-light" : "vscode-dark");
  body.dataset.theme = theme;
}

/** Resolve the initial theme from the OS preference. */
export function preferredTheme(): AppTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Track OS theme changes and reapply; returns a disposer. */
export function followSystemTheme(onChange?: (theme: AppTheme) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!mq) {
    return () => {};
  }
  const listener = () => {
    const theme = preferredTheme();
    applyTheme(theme);
    onChange?.(theme);
  };
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
