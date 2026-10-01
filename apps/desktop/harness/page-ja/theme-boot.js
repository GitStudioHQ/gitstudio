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
  // Settings ▸ Appearance ▸ Dark style (shared/darkStyle.ts): "neon" puts the
  // Neon token block's class on <body> beside the theme's, so the first frame
  // is painted on that ground; anything else is Graphite, the default. The
  // harness passes ?darkstyle= the way it passes ?theme=.
  var style = "graphite";
  var prefs = null;
  try {
    prefs = JSON.parse(localStorage.getItem("gitstudio.ui.prefs") || "null");
  } catch (e) {
    /* no storage, or a blob that does not parse — follow the OS */
  }
  if (forced !== "light" && forced !== "dark") {
    var mode = prefs && prefs.themeMode;
    if (mode === "light" || mode === "dark") saved = mode;
  }
  var forcedStyle = null;
  try {
    forcedStyle = new URLSearchParams(location.search).get("darkstyle");
  } catch (e) {
    /* as above */
  }
  if (forcedStyle === "neon" || (forcedStyle !== "graphite" && prefs && prefs.darkStyle === "neon")) style = "neon";
  var light =
    forced === "light" ||
    (forced !== "dark" &&
      (saved
        ? saved === "light"
        : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)));
  document.body.className = (light ? "vscode-light" : "vscode-dark") + (style === "neon" ? " gs-neon" : "");

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
  // callback follows is the branded one.
  //
  // The window starts hidden, and it is normally shown as the bundle starts
  // executing (launch-reveal.js, the bundle's first statement): showing it on
  // this frame instead held the main process while the bundle was still
  // streaming out of app.asar, and starts paid for it. This is the fallback
  // for a start whose bundle is slow to arrive: 150ms after the branded frame,
  // ask anyway. Whichever asks first wins; `ready-to-show` stays the last
  // resort. The theme travels along so the window's own background matches.
  function askForWindow() {
    if (window.__gsWindowAsked) return;
    window.__gsWindowAsked = true;
    try {
      performance.mark("gs:window-asked");
    } catch (e) {
      /* marks are for measuring only */
    }
    var bridge = window.gitstudio;
    if (bridge && typeof bridge.invoke === "function") {
      try {
        var p = bridge.invoke("window:launchPainted", { theme: light ? "light" : "dark", style: style });
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {
        /* main shows the window on ready-to-show regardless */
      }
    }
  }
  var painted = false;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (painted) return;
        painted = true;
        try {
          performance.mark("gs:launch-painted");
        } catch (e) {
          /* marks are for measuring only */
        }
        setTimeout(askForWindow, 150);
      }, 0);
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
