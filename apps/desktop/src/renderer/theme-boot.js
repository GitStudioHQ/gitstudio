// Pre-paint theme bootstrap. Kept as a tiny same-origin file (rather than an
// inline <script>) so the renderer's CSP can forbid inline scripts entirely.
// Picks the theme class before first paint so a light-OS launch doesn't flash
// the dark canvas; desktopTheme re-affirms this and tracks live OS theme
// changes once the renderer boots.
(function () {
  // An explicit ?theme= override wins over the OS query, so the PRE-PAINT
  // class matches whatever theme is about to be applied. In the real app the
  // URL carries no theme param and this falls through to the OS media query
  // unchanged; the headless harness passes ?theme=light|dark, and without
  // this its "light" screenshots captured the dark first frame before the
  // renderer corrected the class — so light mode went un-eyeballed.
  var forced = null;
  try {
    forced = new URLSearchParams(location.search).get("theme");
  } catch (e) {
    /* no parseable search — fall through to the OS query */
  }
  var light =
    forced === "light" ||
    (forced !== "dark" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.className = light ? "vscode-light" : "vscode-dark";

  // Tag the OS on <html> so the topbar can reserve room for the macOS traffic
  // lights ONLY on macOS (Windows/Linux draw their window controls elsewhere).
  // Kept on documentElement so the renderer's body theme-class swaps never clobber it.
  var ua = navigator.userAgent || "";
  var plat =
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform ||
    "";
  var isMac = /Mac/i.test(plat) || /Mac OS X/i.test(ua);
  var isWin = /Win/i.test(plat) || /Windows/i.test(ua);
  document.documentElement.classList.add(
    isMac ? "is-mac" : isWin ? "is-win" : "is-linux",
  );
})();
