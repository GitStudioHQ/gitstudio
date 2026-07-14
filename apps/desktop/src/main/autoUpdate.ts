// Minimal auto-update stub. Wires electron-updater's GitHub provider when the
// app is packaged; in dev (or when no releases exist) it is a no-op rather than
// an error, so the app runs identically with or without a release feed.

export interface AutoUpdateOptions {
  isDev: boolean;
}

export function initAutoUpdate(opts: AutoUpdateOptions): void {
  if (opts.isDev) {
    return;
  }
  if (process.platform === "darwin") {
    // No macOS update channel yet: the release ships per-arch dmg/zip from two
    // runners whose latest-mac.yml feeds would clobber each other, so the feed
    // is deliberately not uploaded (see release-desktop.yml) — and unsigned
    // builds couldn't apply a Squirrel.Mac update anyway. Skip the check
    // instead of 404ing on every launch; mac users update via the website.
    return;
  }
  // Imported lazily so a missing electron-updater (e.g. a `--dir` smoke build
  // that skips optional deps) never crashes startup.
  void import("electron-updater")
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = false;
      autoUpdater.on("error", () => {
        // Swallow: a repo with no published releases yields a 404 here, which
        // is expected until the first `app-v*` tag ships installers.
      });
      autoUpdater.checkForUpdates().catch(() => {
        // No release feed yet — stay silent.
      });
    })
    .catch(() => {
      // electron-updater not installed in this build; updates are disabled.
    });
}
