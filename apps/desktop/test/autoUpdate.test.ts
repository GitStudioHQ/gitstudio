import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  latestDesktopRelease,
  latestDesktopVersion,
  pickMacAsset,
} from "../src/main/autoUpdate";

// Pure release-feed logic behind the poll→confirm→pull updater. The impure
// parts (electron-updater, fetch, the state machine) stay thin around these.

test("compareVersions orders dotted versions numerically", () => {
  assert.ok(compareVersions("1.6.0", "1.5.9") > 0);
  assert.ok(compareVersions("1.5.1", "1.5.10") < 0);
  assert.equal(compareVersions("2.0", "2.0.0"), 0);
  assert.ok(compareVersions("10.0.0", "9.9.9") > 0);
});

test("latestDesktopRelease picks the newest app-v* and ignores ext/draft/prerelease", () => {
  const releases = [
    { tag_name: "ext-v1.11.1" }, // the extension's tags are not ours
    { tag_name: "app-v1.4.0" },
    { tag_name: "app-v1.6.0", draft: true }, // unpublished
    { tag_name: "app-v1.5.2-beta", prerelease: true },
    { tag_name: "app-v1.5.1", assets: [{ name: "GitStudio-1.5.1-arm64.dmg" }] },
  ];
  const hit = latestDesktopRelease(releases);
  assert.equal(hit?.version, "1.5.1");
  assert.equal(hit?.release.assets?.[0]?.name, "GitStudio-1.5.1-arm64.dmg");
  assert.equal(latestDesktopVersion(releases), "1.5.1");
});

test("latestDesktopRelease is undefined with no desktop tags or a bad payload", () => {
  assert.equal(latestDesktopRelease([{ tag_name: "ext-v1.0.0" }]), undefined);
  assert.equal(latestDesktopRelease([]), undefined);
  assert.equal(latestDesktopRelease(undefined as unknown as []), undefined);
});

test("pickMacAsset prefers this arch's dmg, falls back to its zip", () => {
  const assets = [
    { name: "GitStudio-1.6.0-x64.dmg", browser_download_url: "https://dl/x64.dmg", size: 9 },
    { name: "GitStudio-1.6.0-arm64.zip", browser_download_url: "https://dl/arm64.zip", size: 7 },
    { name: "GitStudio-1.6.0-arm64.dmg", browser_download_url: "https://dl/arm64.dmg", size: 8 },
    { name: "GitStudio-Setup-1.6.0.exe", browser_download_url: "https://dl/win.exe", size: 6 },
  ];
  assert.deepEqual(pickMacAsset(assets, "arm64"), {
    name: "GitStudio-1.6.0-arm64.dmg",
    url: "https://dl/arm64.dmg",
    size: 8,
  });
  // No arm64 dmg → its zip (never another arch's installer).
  const noDmg = assets.filter((a) => a.name !== "GitStudio-1.6.0-arm64.dmg");
  assert.equal(pickMacAsset(noDmg, "arm64")?.name, "GitStudio-1.6.0-arm64.zip");
  assert.equal(pickMacAsset(assets, "x64")?.name, "GitStudio-1.6.0-x64.dmg");
  assert.equal(pickMacAsset([{ name: "notes.txt" }], "arm64"), undefined);
});

// ── The state machine: who hears about an update, and when ──
//
// The owner never saw an update prompt on 2.2.0. On macOS the app outlives
// its window: the 20 s check announced to a window since closed (or to none),
// a window reopened from the Dock was never told, and a check that failed at
// launch waited four hours to try again.

import { mock } from "node:test";
import { initAutoUpdate } from "../src/main/autoUpdate";

type Sent = { event: string; data: unknown };

function withFeed(releases: unknown[] | Error): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (releases instanceof Error) throw releases;
    return new Response(JSON.stringify(releases), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Let the stubbed fetch and the check's awaits run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

function start(sent: Sent[], notified: string[]) {
  return initAutoUpdate({
    isDev: false,
    current: "2.2.0",
    mac: true,
    send: (event, data) => sent.push({ event, data }),
    notify: (v) => notified.push(v),
  });
}

test("a window that loads after the check is told the update is waiting", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const restore = withFeed([{ tag_name: "app-v2.2.1", assets: [] }]);
  t.after(() => {
    restore();
    mock.timers.reset();
  });
  const sent: Sent[] = [];
  const notified: string[] = [];
  const updates = start(sent, notified);

  mock.timers.tick(20_000);
  await settle();
  assert.deepEqual(sent, [{ event: "update:available", data: { version: "2.2.1", current: "2.2.0" } }]);
  assert.deepEqual(notified, ["2.2.1"], "a background find is said outside the window too");

  // The window closes, the app runs on; one is opened from the Dock.
  sent.length = 0;
  updates.windowReady();
  assert.deepEqual(sent, [], "not before the window has settled");
  mock.timers.tick(3_000);
  assert.deepEqual(sent, [{ event: "update:available", data: { version: "2.2.1", current: "2.2.0" } }]);
  assert.deepEqual(notified, ["2.2.1"], "a replay to a window is not a second notification");
});

test("a window with nothing waiting is told nothing", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const restore = withFeed([{ tag_name: "app-v2.2.0" }]);
  t.after(() => {
    restore();
    mock.timers.reset();
  });
  const sent: Sent[] = [];
  const updates = start(sent, []);
  mock.timers.tick(20_000);
  await settle();
  updates.windowReady();
  mock.timers.tick(3_000);
  assert.deepEqual(sent, []);
});

test("a check that failed at launch is tried again in minutes, not hours", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let restore = withFeed(new Error("offline"));
  t.after(() => {
    restore();
    mock.timers.reset();
  });
  const sent: Sent[] = [];
  start(sent, []);
  mock.timers.tick(20_000);
  await settle();
  assert.deepEqual(sent, []);

  restore();
  restore = withFeed([{ tag_name: "app-v2.2.1" }]);
  mock.timers.tick(15 * 60 * 1000);
  await settle();
  assert.deepEqual(sent, [{ event: "update:available", data: { version: "2.2.1", current: "2.2.0" } }]);
});

test("asking from Settings shows the answer in the window but raises no notification", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const restore = withFeed([{ tag_name: "app-v2.2.1" }]);
  t.after(() => {
    restore();
    mock.timers.reset();
  });
  const sent: Sent[] = [];
  const notified: string[] = [];
  const updates = start(sent, notified);
  const r = await updates.check(true);
  assert.equal(r.status, "available");
  assert.equal(sent.length, 1);
  assert.deepEqual(notified, []);
});
