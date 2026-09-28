// Pre-paint theme bootstrap. Kept as a tiny same-origin file (rather than an
// inline <script>) so the renderer's CSP can forbid inline scripts entirely.
// Picks the theme class before first paint so a light-OS launch doesn't flash
// the dark canvas; desktopTheme re-affirms this and tracks live OS theme
// changes once the renderer boots.
(function () {
  // An explicit ?theme= override wins over everything, so the PRE-PAINT class
  // matches whatever theme is about to be applied. In the real app the URL
  // carries no theme param; the headless harness passes ?theme=light|dark,
  // and without this its "light" screenshots captured the dark first frame
  // before the renderer corrected the class — so light mode went un-eyeballed.
  var forced = null;
  try {
    forced = new URLSearchParams(location.search).get("theme");
  } catch (e) {
    /* no parseable search — fall through */
  }
  // Then the theme picked in Settings ▸ Appearance. The renderer keeps it in
  // this localStorage blob (renderer.ts PREFS_KEY), and reading it here is
  // what stops a window pinned to Light from opening on a dark frame when the
  // OS is dark — the launch screen below is the first thing anyone sees.
  var saved = null;
  if (forced !== "light" && forced !== "dark") {
    try {
      var prefs = JSON.parse(localStorage.getItem("gitstudio.ui.prefs") || "null");
      var mode = prefs && prefs.themeMode;
      if (mode === "light" || mode === "dark") saved = mode;
    } catch (e) {
      /* no storage, or a blob that does not parse — follow the OS */
    }
  }
  var light =
    forced === "light" ||
    (forced !== "dark" &&
      (saved
        ? saved === "light"
        : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)));
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

  // The launch screen's first frame. The markup right after this script is
  // parsed before the page's first rendering opportunity, so the frame this
  // callback follows is the branded one; once it exists, main shows the
  // window (it starts hidden, and `ready-to-show` alone waited for the whole
  // bundle). The theme travels along so the window's own background matches
  // the frame when it is revealed. `ready-to-show` stays the fallback.
  var told = false;
  function painted() {
    if (told) return;
    told = true;
    try {
      performance.mark("gs:launch-painted");
    } catch (e) {
      /* marks are for measuring only */
    }
    var bridge = window.gitstudio;
    if (bridge && typeof bridge.invoke === "function") {
      try {
        var p = bridge.invoke("window:launchPainted", { theme: light ? "light" : "dark" });
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {
        /* main shows the window on ready-to-show regardless */
      }
    }
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () {
      setTimeout(painted, 0);
    });
  }

  // A failsafe, not a feature: if the bundle never hands off (it failed to
  // load or threw before the shell started), the screen must not sit there
  // forever hiding whatever the page could still say.
  setTimeout(function () {
    var el = document.getElementById("launch");
    if (el && !el.classList.contains("is-leaving")) el.remove();
  }, 20000);
})();
