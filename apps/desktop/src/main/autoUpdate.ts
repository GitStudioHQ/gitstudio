// Update handling: poll → ask → pull → apply, with the user in charge.
//
// The manager polls for a newer app-v* release (on startup and every few
// hours), tells the RENDERER when one exists (update:available), and then
// waits: nothing downloads until the user confirms in-app. After the
// confirmed download it reports update:ready, and `update:install` applies it.
//
// Two apply mechanisms, because the platforms genuinely differ:
//
//   Windows / Linux(AppImage) — electron-updater downloads the delta and
//     quitAndInstall() restarts straight into the new version. If the user
//     declines the restart, it still installs on quit (autoInstallOnAppQuit).
//
//   macOS — Squirrel.Mac cannot apply an update to an unsigned build, and the
//     release ships no mac feed (see release-desktop.yml). Instead the manager
//     downloads the right DMG from the GitHub release into ~/Downloads (with
//     progress) and `update:install` opens it — one drag to Applications.
//
// Everything here is best-effort: no network, no releases, or no
// electron-updater must never affect startup.

import { app, shell } from "electron";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IpcEvents, UpdateCheckResult } from "../shared/ipc";

export interface AutoUpdateOptions {
  isDev: boolean;
  /** Push an event to the renderer (main.ts's `send`). */
  send: <E extends keyof IpcEvents>(event: E, data: IpcEvents[E]) => void;
}

export interface UpdateManager {
  /** Poll now. `userInitiated` responses always carry the full status. */
  check(userInitiated?: boolean): Promise<UpdateCheckResult>;
  /** Start the user-confirmed download. */
  download(): Promise<{ ok: boolean; message?: string }>;
  /** Apply a ready update: restart into it, or open the downloaded installer. */
  install(): Promise<{ ok: boolean; message?: string }>;
}

/** Where a mac user goes if the in-app download can't find an asset. */
const RELEASES_PAGE = "https://github.com/GitStudioHQ/gitstudio/releases/latest";
const RELEASES_API = "https://api.github.com/repos/GitStudioHQ/gitstudio/releases";
/** Re-poll cadence while the app stays open. */
const POLL_MS = 4 * 60 * 60 * 1000;
/** Delay the startup check so it never competes with first paint / repo load. */
const FIRST_CHECK_DELAY_MS = 20_000;

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

interface RawAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}
interface RawRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: RawAsset[];
}

/** The newest non-draft desktop release tag in a GitHub releases payload. */
export function latestDesktopVersion(releases: RawRelease[]): string | undefined {
  return latestDesktopRelease(releases)?.version;
}

/** As {@link latestDesktopVersion}, but keeps the release (for its assets). */
export function latestDesktopRelease(
  releases: RawRelease[],
): { version: string; release: RawRelease } | undefined {
  if (!Array.isArray(releases)) {
    return undefined;
  }
  // The repo also tags the VS Code extension (`ext-v*`) — only `app-v*` is us.
  const desktop = releases
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string")
    .filter((r) => (r.tag_name as string).startsWith("app-v"))
    .map((r) => ({ version: (r.tag_name as string).replace(/^app-v/, ""), release: r }));
  if (desktop.length === 0) {
    return undefined;
  }
  return desktop.reduce((best, r) => (compareVersions(r.version, best.version) > 0 ? r : best));
}

/** Pick the mac installer asset for this machine from a release's asset list.
 *  electron-builder names them `GitStudio-<version>-<arch>.dmg` (zip sibling). */
export function pickMacAsset(
  assets: RawAsset[],
  arch: string,
): { name: string; url: string; size: number } | undefined {
  const wantArch = arch === "arm64" ? "arm64" : "x64";
  const candidates = (assets ?? []).filter(
    (a): a is Required<Pick<RawAsset, "name" | "browser_download_url">> & RawAsset =>
      typeof a.name === "string" && typeof a.browser_download_url === "string",
  );
  const byExt = (ext: string): (typeof candidates)[number] | undefined =>
    candidates.find((a) => a.name.endsWith(ext) && a.name.includes(`-${wantArch}`));
  const hit = byExt(".dmg") ?? byExt(".zip");
  return hit ? { name: hit.name, url: hit.browser_download_url, size: hit.size ?? 0 } : undefined;
}

export function initAutoUpdate(opts: AutoUpdateOptions): UpdateManager {
  const current = app.getVersion();
  const send = opts.send;

  // ── shared state machine ──
  let state: "idle" | "available" | "downloading" | "ready" = "idle";
  let availableVersion: string | undefined;
  /** Versions already announced this session — background polls stay quiet. */
  const announced = new Set<string>();
  /** mac: the asset chosen at check time; the downloaded installer's path. */
  let macAsset: { name: string; url: string; size: number } | undefined;
  let readyPath: string | undefined;

  const disabled: UpdateCheckResult = {
    status: "disabled",
    current,
    message: "Updates are disabled in development builds.",
  };
  if (opts.isDev) {
    return {
      check: async () => disabled,
      download: async () => ({ ok: false, message: disabled.message }),
      install: async () => ({ ok: false, message: disabled.message }),
    };
  }

  const announce = (version: string, userInitiated: boolean): void => {
    if (!userInitiated && announced.has(version)) {
      return;
    }
    announced.add(version);
    send("update:available", { version, current });
  };

  const sendProgress = (() => {
    let lastPct = -1;
    return (percent: number): void => {
      const p = Math.max(0, Math.min(100, Math.floor(percent)));
      if (p !== lastPct) {
        lastPct = p;
        send("update:progress", { percent: p });
      }
    };
  })();

  // ── macOS: GitHub poll + installer download ──
  const macCheck = async (userInitiated: boolean): Promise<UpdateCheckResult> => {
    if (state === "downloading") return { status: "downloading", current, version: availableVersion };
    if (state === "ready") return { status: "ready", current, version: availableVersion };
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { status: "error", current, message: `GitHub responded ${res.status}.` };
      }
      const latest = latestDesktopRelease((await res.json()) as RawRelease[]);
      if (!latest || compareVersions(latest.version, current) <= 0) {
        return { status: "uptodate", current };
      }
      state = "available";
      availableVersion = latest.version;
      macAsset = pickMacAsset(latest.release.assets ?? [], process.arch);
      announce(latest.version, userInitiated);
      return { status: "available", current, version: latest.version };
    } catch (e) {
      return {
        status: "error",
        current,
        message: e instanceof Error ? e.message : "The update check failed.",
      };
    }
  };

  const macDownload = async (): Promise<{ ok: boolean; message?: string }> => {
    if (state === "ready" && readyPath && availableVersion) {
      send("update:ready", { version: availableVersion, kind: "installer", path: readyPath });
      return { ok: true };
    }
    if (state !== "available" || !availableVersion) {
      return { ok: false, message: "No update is waiting to download." };
    }
    if (!macAsset) {
      // The release exists but has no matching mac asset (e.g. a partial
      // upload) — send the user to the release page rather than dead-ending.
      void shell.openExternal(RELEASES_PAGE);
      return { ok: false, message: "Couldn't find a macOS download — opened the releases page." };
    }
    state = "downloading";
    const dest = join(app.getPath("downloads"), macAsset.name);
    const tmp = `${dest}.part`;
    try {
      const res = await fetch(macAsset.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed (${res.status}).`);
      }
      const total = Number(res.headers.get("content-length")) || macAsset.size || 0;
      const file = createWriteStream(tmp);
      const reader = res.body.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (total > 0) sendProgress((got / total) * 100);
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((r) => file.once("drain", () => r()));
        }
      }
      await new Promise<void>((resolve, reject) =>
        file.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      await rename(tmp, dest);
      sendProgress(100);
      state = "ready";
      readyPath = dest;
      send("update:ready", { version: availableVersion, kind: "installer", path: dest });
      return { ok: true };
    } catch (e) {
      state = "available";
      void unlink(tmp).catch(() => {});
      return { ok: false, message: e instanceof Error ? e.message : "The download failed." };
    }
  };

  const macInstall = async (): Promise<{ ok: boolean; message?: string }> => {
    if (state !== "ready" || !readyPath) {
      return { ok: false, message: "No downloaded update to open." };
    }
    const err = await shell.openPath(readyPath);
    if (err) {
      shell.showItemInFolder(readyPath);
      return { ok: false, message: err };
    }
    return { ok: true };
  };

  // ── Windows / Linux: electron-updater, gated on confirmation ──
  type Updater = typeof import("electron-updater").autoUpdater;
  let updater: Updater | undefined;
  let updaterWired = false;
  const getUpdater = async (): Promise<Updater | undefined> => {
    if (updater) return updater;
    try {
      // Imported lazily so a missing electron-updater (e.g. a `--dir` smoke
      // build that skips optional deps) never crashes startup.
      updater = (await import("electron-updater")).autoUpdater;
    } catch {
      return undefined;
    }
    if (!updaterWired) {
      updaterWired = true;
      // The whole point: nothing downloads until the user says yes.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = true;
      updater.on("error", () => {
        // A repo with no published installers yields a 404 here — expected
        // until the first app-v* release; surfaced via check() results instead.
      });
      updater.on("download-progress", (p: { percent: number }) => sendProgress(p.percent));
      updater.on("update-downloaded", (info: { version?: string }) => {
        state = "ready";
        const v = info?.version ?? availableVersion ?? "";
        send("update:ready", { version: v, kind: "restart" });
      });
    }
    return updater;
  };

  const elCheck = async (userInitiated: boolean): Promise<UpdateCheckResult> => {
    if (state === "downloading") return { status: "downloading", current, version: availableVersion };
    if (state === "ready") return { status: "ready", current, version: availableVersion };
    const u = await getUpdater();
    if (!u) {
      return { status: "disabled", current, message: "Updates aren't available in this build." };
    }
    try {
      const r = await u.checkForUpdates();
      const version = r?.updateInfo?.version;
      if (version && compareVersions(version, current) > 0) {
        state = "available";
        availableVersion = version;
        announce(version, userInitiated);
        return { status: "available", current, version };
      }
      return { status: "uptodate", current };
    } catch (e) {
      return {
        status: "error",
        current,
        message: e instanceof Error ? e.message : "The update check failed.",
      };
    }
  };

  const elDownload = async (): Promise<{ ok: boolean; message?: string }> => {
    if (state === "ready" && availableVersion) {
      send("update:ready", { version: availableVersion, kind: "restart" });
      return { ok: true };
    }
    if (state !== "available") {
      return { ok: false, message: "No update is waiting to download." };
    }
    const u = await getUpdater();
    if (!u) {
      return { ok: false, message: "Updates aren't available in this build." };
    }
    state = "downloading";
    try {
      await u.downloadUpdate();
      // update-downloaded flips state to ready + notifies.
      return { ok: true };
    } catch (e) {
      state = "available";
      return { ok: false, message: e instanceof Error ? e.message : "The download failed." };
    }
  };

  const elInstall = async (): Promise<{ ok: boolean; message?: string }> => {
    if (state !== "ready") {
      return { ok: false, message: "No downloaded update to install." };
    }
    const u = await getUpdater();
    if (!u) {
      return { ok: false, message: "Updates aren't available in this build." };
    }
    // Restart straight into the new version.
    setImmediate(() => u.quitAndInstall());
    return { ok: true };
  };

  const isMac = process.platform === "darwin";
  const manager: UpdateManager = {
    check: (userInitiated = false) => (isMac ? macCheck(userInitiated) : elCheck(userInitiated)),
    download: () => (isMac ? macDownload() : elDownload()),
    install: () => (isMac ? macInstall() : elInstall()),
  };

  // Poll: shortly after startup (never competing with first paint), then on an
  // interval for as long as the app stays open. Background polls announce a
  // version once; the rest is the user's call.
  setTimeout(() => void manager.check(false), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => {
    if (state === "idle" || state === "available") void manager.check(false);
  }, POLL_MS);
  timer.unref?.();

  return manager;
}
