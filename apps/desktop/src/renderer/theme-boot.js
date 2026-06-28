// Pre-paint theme bootstrap. Kept as a tiny same-origin file (rather than an
// inline <script>) so the renderer's CSP can forbid inline scripts entirely.
// Picks the theme class before first paint so a light-OS launch doesn't flash
// the dark canvas; desktopTheme re-affirms this and tracks live OS theme
// changes once the renderer boots.
(function () {
  var light =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  document.body.className = light ? "vscode-light" : "vscode-dark";
})();
