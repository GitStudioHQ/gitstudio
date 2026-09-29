"use strict";
// Ask main to show the window — as the FIRST statement of renderer.js.
//
// esbuild.js prepends this file to the bundle (its `banner`), because a module
// cannot be first: esbuild hoists hundreds of modules (Monaco's among them)
// above whatever renderer.ts imports first, and they run before it. The
// "use strict" above keeps the bundle strict now that its own directive is no
// longer the first statement of the file.
//
// WHEN the window goes up is the whole question. The launch screen (index.html)
// is painted long before this runs, so the window could be shown on that first
// frame — and it was, and in the packaged app a start with a repository tab
// paid ~25ms for it: the window going up on macOS holds the main process while
// the bundle is still streaming out of app.asar, and the bundle started that
// much later. Showing it from here instead — the bundle's bytes are all in,
// nothing is left to stall — started the bundle on time. theme-boot.js asks
// too, 150ms after the first frame, so a start whose bundle is slow to arrive
// still gets its window then. Whichever asks first wins (__gsWindowAsked), and
// main shows a hidden window only once; ready-to-show is the last resort.
(function () {
  if (window.__gsWindowAsked) return;
  window.__gsWindowAsked = true;
  try {
    performance.mark("gs:window-asked");
  } catch (e) {
    /* marks are for measuring only */
  }
  var bridge = window.gitstudio;
  if (!bridge || typeof bridge.invoke !== "function") return;
  // The launch screen's theme: theme-boot.js put it on <body> before it painted.
  var cls = (document.body && document.body.className) || "";
  var light = /(^|\s)vscode-light(\s|$)/.test(cls);
  // …and its dark style (the Neon class, or Graphite), for the window's ground.
  var style = /(^|\s)gs-neon(\s|$)/.test(cls) ? "neon" : "graphite";
  try {
    var p = bridge.invoke("window:launchPainted", { theme: light ? "light" : "dark", style: style });
    if (p && typeof p.catch === "function") p.catch(function () {});
  } catch (e) {
    /* main shows the window on ready-to-show regardless */
  }
})();
