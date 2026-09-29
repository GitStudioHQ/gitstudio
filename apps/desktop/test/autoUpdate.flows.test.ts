// The updater's confirm → pull → apply flows (main/autoUpdate.ts), past the
// check the older autoUpdate.test.ts covers:
//
//   macOS — the installer is downloaded from the GitHub release into
//     ~/Downloads with progress, announced ready, and opened on install; a
//     release without a mac asset sends the user to the releases page.
//   Windows / Linux — electron-updater (faked) is checked, downloads only
//     once the user says so, and restarts into the update on install.
//
// Every refusal (nothing waiting, nothing downloaded, a dev build) is an
// `expected` result, never a throw. Timers are mocked: initAutoUpdate
// schedules a background check 20 s out, and no test may wait for it.

import { electron } from "./ghFakeElectron"; // first: seeds `electron` (shell, app.getPath)
import { updater } from "./autoUpdate.fakeUpdater"; // first: answers import("electron-updater")
import { mock, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAutoUpdate, type UpdateManager } from "../src/main/autoUpdate";

/**
 * Let the updater's async work land: event-loop turns until `done()`, capped by
 * wall time, not by a turn count — loading electron-updater on a busy CI runner
 * took more than 20 turns, and a check that read too early saw nothing.
 */
async function settle(done: () => boolean, ms = 5000): Promise<void> {
  const until = performance.now() + ms;
  while (!done() && performance.now() < until) await new Promise((r) => setImmediate(r));
}

const RELEASES_API = "https://api.github.com/repos/GitStudioHQ/gitstudio/releases";
const RELEASES_PAGE = "https://github.com/GitStudioHQ/gitstudio/releases/latest";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `GitStudio-2.3.0-${arch}.dmg`;
const ASSET_URL = `https://github.com/GitStudioHQ/gitstudio/releases/download/app-v2.3.0/${ASSET}`;

type Sent = { event: string; data: unknown };

interface World {
  sent: Sent[];
  notified: string[];
  fetched: string[];
  downloads: string;
  updates: UpdateManager;
}

/**
 * A manager on a mocked clock with a fake network: the releases API answers
 * `releases` (or `status`), and the asset URL answers `asset()`.
 */
function world(
  t: TestContext,
  o: { mac: boolean; releases?: unknown; status?: number; asset?: () => Response | Promise<Response>; isDev?: boolean },
): World {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const downloads = mkdtempSync(join(tmpdir(), "gs-update-"));
  electron.paths.downloads = downloads;
  electron.externals.length = 0;
  electron.opened.length = 0;
  electron.shown.length = 0;
  electron.openPathAnswer = "";
  updater.reset();
  const fetched: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url === RELEASES_API) {
      return new Response(JSON.stringify(o.releases ?? []), { status: o.status ?? 200 });
    }
    if (url === ASSET_URL && o.asset) return o.asset();
    return new Response("no fake for " + url, { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    mock.timers.reset();
    rmSync(downloads, { recursive: true, force: true });
  });
  const sent: Sent[] = [];
  const notified: string[] = [];
  const updates = initAutoUpdate({
    isDev: o.isDev ?? false,
    current: "2.2.0",
    mac: o.mac,
    send: (event, data) => sent.push({ event, data }),
    notify: (v) => notified.push(v),
  });
  return { sent, notified, fetched, downloads, updates };
}

const withMacAsset = [
  {
    tag_name: "app-v2.3.0",
    assets: [
      { name: ASSET, browser_download_url: ASSET_URL, size: 10 },
      { name: "GitStudio-Setup-2.3.0.exe", browser_download_url: "https://example.invalid/win.exe", size: 1 },
    ],
  },
];

/** A response whose body arrives in these chunks. */
function chunked(chunks: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }),
    { status: 200, headers },
  );
}

const events = (sent: Sent[], name: string) => sent.filter((s) => s.event === name).map((s) => s.data);

// ── Development builds ──

test("a development build never checks, downloads or installs, and says why", async (t) => {
  const w = world(t, { mac: true, isDev: true });
  assert.deepEqual(await w.updates.check(true), {
    status: "disabled",
    current: "2.2.0",
    message: "Updates are disabled in development builds.",
  });
  const refusal = { ok: false, expected: true, message: "Updates are disabled in development builds." };
  assert.deepEqual(await w.updates.download(), refusal);
  assert.deepEqual(await w.updates.install(), refusal);
  w.updates.windowReady();
  mock.timers.tick(60_000);
  assert.deepEqual(w.fetched, [], "not even the background check runs");
  assert.deepEqual(w.sent, []);
});

// ── macOS ──

test("mac: a newer release is announced to the window, without a system notification when asked", async (t) => {
  const w = world(t, { mac: true, releases: withMacAsset });
  assert.deepEqual(await w.updates.check(true), { status: "available", current: "2.2.0", version: "2.3.0" });
  assert.deepEqual(events(w.sent, "update:available"), [{ version: "2.3.0", current: "2.2.0" }]);
  assert.deepEqual(w.notified, []);
});

test("mac: the same release or an older one is up to date", async (t) => {
  const w = world(t, { mac: true, releases: [{ tag_name: "app-v2.2.0" }, { tag_name: "app-v2.1.9" }] });
  assert.deepEqual(await w.updates.check(true), { status: "uptodate", current: "2.2.0" });
  assert.deepEqual(w.sent, []);
});

test("mac: GitHub refusing the releases read is an error status with its code", async (t) => {
  const w = world(t, { mac: true, status: 503 });
  assert.deepEqual(await w.updates.check(true), { status: "error", current: "2.2.0", message: "GitHub responded 503." });
});

test("mac: nothing downloads or installs before an update is waiting", async (t) => {
  const w = world(t, { mac: true, releases: [] });
  assert.deepEqual(await w.updates.download(), { ok: false, expected: true, message: "No update is waiting to download." });
  assert.deepEqual(await w.updates.install(), { ok: false, expected: true, message: "No downloaded update to open." });
});

test("mac: a release with no installer for this machine opens the releases page instead", async (t) => {
  const w = world(t, { mac: true, releases: [{ tag_name: "app-v2.3.0", assets: [{ name: "notes.txt", browser_download_url: "https://x/n" }] }] });
  await w.updates.check(true);
  assert.deepEqual(await w.updates.download(), {
    ok: false,
    message: "Couldn't find a macOS download — opened the releases page.",
  });
  assert.deepEqual(electron.externals, [RELEASES_PAGE]);
});

test("mac: the confirmed download lands in Downloads with progress, is announced, and install opens it", async (t) => {
  const w = world(t, {
    mac: true,
    releases: withMacAsset,
    asset: () => chunked(["01234", "56789"], { "content-length": "10" }),
  });
  await w.updates.check(true);
  assert.deepEqual(await w.updates.download(), { ok: true });

  const dest = join(w.downloads, ASSET);
  assert.equal(readFileSync(dest, "utf8"), "0123456789");
  assert.deepEqual(readdirSync(w.downloads), [ASSET], "no .part file left behind");
  assert.deepEqual(events(w.sent, "update:progress"), [{ percent: 50 }, { percent: 100 }], "each percent once, ending at 100");
  assert.deepEqual(events(w.sent, "update:ready"), [{ version: "2.3.0", kind: "installer", path: dest }]);

  assert.deepEqual(await w.updates.check(true), { status: "ready", current: "2.2.0", version: "2.3.0" });
  // Pressing Download again re-announces the installer rather than fetching it twice.
  assert.deepEqual(await w.updates.download(), { ok: true });
  assert.equal(w.fetched.filter((u) => u === ASSET_URL).length, 1);
  assert.equal(events(w.sent, "update:ready").length, 2);

  assert.deepEqual(await w.updates.install(), { ok: true });
  assert.deepEqual(electron.opened, [dest]);
});

test("mac: a window opened after the download is told the installer is ready", async (t) => {
  const w = world(t, { mac: true, releases: withMacAsset, asset: () => chunked(["x"]) });
  await w.updates.check(true);
  await w.updates.download();
  w.sent.length = 0;
  w.updates.windowReady();
  mock.timers.tick(3_000);
  assert.deepEqual(w.sent, [
    { event: "update:ready", data: { version: "2.3.0", kind: "installer", path: join(w.downloads, ASSET) } },
  ]);
});

test("mac: progress falls back to the release's stated size when there is no content-length", async (t) => {
  const w = world(t, { mac: true, releases: withMacAsset, asset: () => chunked(["abcde", "fghij"]) });
  await w.updates.check(true);
  await w.updates.download();
  assert.deepEqual(events(w.sent, "update:progress"), [{ percent: 50 }, { percent: 100 }]);
});

test("mac: an installer the OS won't open is shown in its folder and the error returned", async (t) => {
  const w = world(t, { mac: true, releases: withMacAsset, asset: () => chunked(["x"]) });
  await w.updates.check(true);
  await w.updates.download();
  electron.openPathAnswer = "No application knows how to open this file.";
  const dest = join(w.downloads, ASSET);
  assert.deepEqual(await w.updates.install(), { ok: false, message: "No application knows how to open this file." });
  assert.deepEqual(electron.shown, [dest]);
});

test("mac: a failed download says so, leaves nothing behind, and can be tried again", async (t) => {
  let fail = true;
  const w = world(t, {
    mac: true,
    releases: withMacAsset,
    asset: () => (fail ? new Response("gone", { status: 404 }) : chunked(["ok"])),
  });
  await w.updates.check(true);
  assert.deepEqual(await w.updates.download(), { ok: false, message: "Download failed (404)." });
  assert.deepEqual(readdirSync(w.downloads), []);
  assert.deepEqual(await w.updates.check(true), { status: "available", current: "2.2.0", version: "2.3.0" });
  fail = false;
  assert.deepEqual(await w.updates.download(), { ok: true });
  assert.equal(existsSync(join(w.downloads, ASSET)), true);
});

test("mac: while the installer is downloading, a check says so instead of asking GitHub again", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const w = world(t, {
    mac: true,
    releases: withMacAsset,
    asset: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            await gate;
            c.enqueue(new TextEncoder().encode("done"));
            c.close();
          },
        }),
        { status: 200 },
      ),
  });
  await w.updates.check(true);
  const downloading = w.updates.download();
  await settle(() => w.fetched.includes(ASSET_URL));
  const apiReads = w.fetched.filter((u) => u === RELEASES_API).length;
  assert.deepEqual(await w.updates.check(true), { status: "downloading", current: "2.2.0", version: "2.3.0" });
  assert.equal(w.fetched.filter((u) => u === RELEASES_API).length, apiReads);
  release();
  assert.deepEqual(await downloading, { ok: true });
});

// ── Windows / Linux (electron-updater) ──

test("el: a newer version is announced, and the updater is told never to download on its own", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  assert.deepEqual(await w.updates.check(true), { status: "available", current: "2.2.0", version: "2.3.0" });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.deepEqual(events(w.sent, "update:available"), [{ version: "2.3.0", current: "2.2.0" }]);
  assert.equal(updater.downloads, 0, "found is not downloaded");
});

test("el: no newer version is up to date; a failed check is an error status", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.2.0" } };
  assert.deepEqual(await w.updates.check(true), { status: "uptodate", current: "2.2.0" });
  updater.checkAnswer = null;
  assert.deepEqual(await w.updates.check(true), { status: "uptodate", current: "2.2.0" });
  updater.checkAnswer = new Error("net::ERR_INTERNET_DISCONNECTED");
  assert.deepEqual(await w.updates.check(true), {
    status: "error",
    current: "2.2.0",
    message: "net::ERR_INTERNET_DISCONNECTED",
  });
});

test("el: nothing downloads or installs before an update is waiting", async (t) => {
  const w = world(t, { mac: false });
  assert.deepEqual(await w.updates.download(), { ok: false, expected: true, message: "No update is waiting to download." });
  assert.deepEqual(await w.updates.install(), { ok: false, expected: true, message: "No downloaded update to install." });
  assert.equal(updater.downloads, 0);
});

test("el: the confirmed download reports progress, then ready, and install restarts into it", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  updater.download = async () => {
    updater.emit("download-progress", { percent: 12.9 });
    updater.emit("download-progress", { percent: 12.2 });
    updater.emit("download-progress", { percent: 150 });
    updater.emit("update-downloaded", { version: "2.3.0" });
    return [];
  };
  await w.updates.check(true);
  assert.deepEqual(await w.updates.download(), { ok: true });
  assert.equal(updater.downloads, 1);
  assert.deepEqual(events(w.sent, "update:progress"), [{ percent: 12 }, { percent: 100 }], "floored, clamped, deduped");
  assert.deepEqual(events(w.sent, "update:ready"), [{ version: "2.3.0", kind: "restart" }]);
  assert.deepEqual(await w.updates.check(true), { status: "ready", current: "2.2.0", version: "2.3.0" });
  assert.equal(updater.checks, 1, "a ready update is not checked for again");

  assert.deepEqual(await w.updates.download(), { ok: true }, "Download again just re-announces");
  assert.equal(updater.downloads, 1);

  assert.deepEqual(await w.updates.install(), { ok: true });
  await settle(() => updater.installs > 0);
  assert.equal(updater.installs, 1, "restarted into the new version");
});

test("el: a window opened after the download is told to restart", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  updater.download = async () => updater.emit("update-downloaded", {});
  await w.updates.check(true);
  await w.updates.download();
  w.sent.length = 0;
  w.updates.windowReady();
  mock.timers.tick(3_000);
  assert.deepEqual(w.sent, [{ event: "update:ready", data: { version: "2.3.0", kind: "restart" } }]);
});

test("el: while downloading, a check says so", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  let finish!: () => void;
  updater.download = () => new Promise<void>((r) => (finish = r));
  await w.updates.check(true);
  const downloading = w.updates.download();
  await settle(() => updater.downloads > 0);
  assert.deepEqual(await w.updates.check(true), { status: "downloading", current: "2.2.0", version: "2.3.0" });
  assert.equal(updater.checks, 1, "not checked again mid-download");
  finish();
  assert.deepEqual(await downloading, { ok: true });
});

test("el: a failed download returns its message and can be tried again", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  updater.download = async () => {
    throw new Error("sha512 checksum mismatch");
  };
  await w.updates.check(true);
  assert.deepEqual(await w.updates.download(), { ok: false, message: "sha512 checksum mismatch" });
  updater.download = async () => [];
  assert.deepEqual(await w.updates.download(), { ok: true }, "back to available, so a retry is allowed");
  assert.equal(updater.downloads, 2);
});

test("el: the background check announces once and raises a system notification", async (t) => {
  const w = world(t, { mac: false });
  updater.checkAnswer = { updateInfo: { version: "2.3.0" } };
  mock.timers.tick(20_000);
  await settle(() => w.notified.length > 0);
  assert.deepEqual(w.notified, ["2.3.0"]);
  assert.deepEqual(events(w.sent, "update:available"), [{ version: "2.3.0", current: "2.2.0" }]);
});
