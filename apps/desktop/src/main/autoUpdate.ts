// Update handling. Two mechanisms, because the platforms genuinely differ:
//
//   Windows / Linux(AppImage) — electron-updater downloads in the background
//     and installs on quit. It now TELLS the user when an update is staged,
//     instead of replacing the app under them with no indication at all.
//
//   macOS — Squirrel.Mac cannot apply an update to an unsigned build, and both
//     arch runners emit an identically-named latest-mac.yml, so the release
//     deliberately ships no mac feed (see release-desktop.yml). Rather than
//     stay silent — which left mac users on an old build forever with no hint
//     a newer one existed — ask GitHub what the latest desktop release is and
//     post one notification pointing at the download.
//
// Everything here is best-effort: no network, no releases, or no
// electron-updater must never affect startup.

import { app, Notification, shell } from "electron";

export interface AutoUpdateOptions {
  isDev: boolean;
}

/** Where a mac user goes to get the new build. */
const RELEASES_PAGE = "https://github.com/GitStudioHQ/gitstudio/releases/latest";
const RELEASES_API = "https://api.github.com/repos/GitStudioHQ/gitstudio/releases";

/** Compare dotted numeric versions. > 0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** The newest non-draft desktop release tag in a GitHub releases payload. */
export function latestDesktopVersion(
  releases: Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>,
): string | undefined {
  if (!Array.isArray(releases)) {
    return undefined;
  }
  // The repo also tags the VS Code extension (`ext-v*`) — only `app-v*` is us.
  const tags = releases
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string")
    .map((r) => r.tag_name as string)
    .filter((t) => t.startsWith("app-v"))
    .map((t) => t.replace(/^app-v/, ""));
  if (tags.length === 0) {
    return undefined;
  }
  return tags.reduce((best, t) => (compareVersions(t, best) > 0 ? t : best));
}

function notify(title: string, body: string, onClick?: () => void): void {
  try {
    if (!Notification.isSupported()) {
      return;
    }
    const n = new Notification({ title, body });
    if (onClick) {
      n.on("click", onClick);
    }
    n.show();
  } catch {
    // A notification must never be the reason the app misbehaves.
  }
}

async function checkMacUpdate(): Promise<void> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return;
    }
    const payload = (await res.json()) as Array<{
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    const version = latestDesktopVersion(payload);
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      return;
    }
    notify(
      `GitStudio ${version} is available`,
      `You're on ${app.getVersion()}. Click to open the download page.`,
      () => void shell.openExternal(RELEASES_PAGE),
    );
  } catch {
    // Offline, rate-limited, or no releases yet — stay quiet.
  }
}

export function initAutoUpdate(opts: AutoUpdateOptions): void {
  if (opts.isDev) {
    return;
  }

  if (process.platform === "darwin") {
    void checkMacUpdate();
    return;
  }

  // Imported lazily so a missing electron-updater (e.g. a `--dir` smoke build
  // that skips optional deps) never crashes startup.
  void import("electron-updater")
    .then(({ autoUpdater }) => {
      // Download in the background and install on quit (autoInstallOnAppQuit
      // defaults to true).
      autoUpdater.autoDownload = true;
      autoUpdater.on("error", () => {
        // A repo with no published releases yields a 404 here, which is
        // expected until the first `app-v*` tag ships installers.
      });
      autoUpdater.on("update-downloaded", (info: { version?: string }) => {
        const v = info?.version ? ` ${info.version}` : "";
        notify(
          `GitStudio${v} is ready to install`,
          "It will be applied the next time you quit GitStudio.",
        );
      });
      autoUpdater.checkForUpdates().catch(() => {
        // No release feed yet — stay silent.
      });
    })
    .catch(() => {
      // electron-updater not installed in this build; updates are disabled.
    });
}
