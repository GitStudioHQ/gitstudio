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
