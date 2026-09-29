// What a desktop release publishes (.github/workflows/release-desktop.yml).
//
// The Windows leg uploaded `release/*.yml`, which took electron-builder's
// `builder-debug.yml` along with `latest.yml`, so every release carried a
// debug file. The updater's feeds must still ship — electron-updater reads
// `latest.yml` on Windows and `latest-linux.yml` on Linux — and the checksum
// file must still cover every installer the install scripts verify.
//
// Read as text, by the lines that carry each fact: there is no YAML library
// in this repository (scripts/merge-studio's tests read their workflow the
// same way).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// LF line ends: Windows CI checks files out with CRLF (core.autocrlf), and the
// patterns below read the file line by line.
const WORKFLOW = readFileSync(join(__dirname, "..", "..", "..", ".github", "workflows", "release-desktop.yml"), "utf8").replace(/\r\n/g, "\n");

/** Each matrix leg's upload globs, by runner. */
const legs = new Map<string, string[]>();
for (const m of WORKFLOW.matchAll(/- os: (\S+)\n(?:\s*#.*\n)*\s*artifact: '([^']+)'/g)) {
  legs.set(m[1], m[2].split(/\s+/).map((g) => g.replace(/^apps\/desktop\/release\//, "")));
}

/** A shell glob (just `*`) as a whole-name matcher. */
const globRe = (glob: string): RegExp =>
  new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
const uploaded = (os: string, names: string[]): string[] =>
  names.filter((n) => (legs.get(os) ?? []).some((g) => globRe(g).test(n)));

/** What electron-builder leaves at the top of release/ on each runner. */
const V = "2.4.0";
const BUILT: Record<string, string[]> = {
  "macos-14": [`GitStudio-${V}-arm64.dmg`, `GitStudio-${V}-arm64.zip`, `GitStudio-${V}-arm64.dmg.blockmap`, "latest-mac.yml", "builder-debug.yml", "builder-effective-config.yaml"],
  "macos-15-intel": [`GitStudio-${V}-x64.dmg`, `GitStudio-${V}-x64.zip`, "latest-mac.yml", "builder-debug.yml", "builder-effective-config.yaml"],
  "windows-latest": [`GitStudio-Setup-${V}.exe`, `GitStudio-Setup-${V}.exe.blockmap`, "latest.yml", "builder-debug.yml", "builder-effective-config.yaml"],
  "ubuntu-22.04": [
    `GitStudio-${V}-x86_64.AppImage`,
    `GitStudio-${V}-amd64.deb`,
    `GitStudio-${V}-x86_64.rpm`,
    `GitStudio-${V}-x64.tar.gz`,
    "latest-linux.yml",
    "builder-debug.yml",
    "builder-effective-config.yaml",
  ],
};

test("the four legs are the ones this test knows", () => {
  assert.deepEqual([...legs.keys()].sort(), Object.keys(BUILT).sort());
});

test("no leg uploads electron-builder's debug or effective-config files", () => {
  for (const [os, names] of Object.entries(BUILT)) {
    const up = uploaded(os, names);
    assert.ok(!up.includes("builder-debug.yml"), `${os} uploads builder-debug.yml (${up.join(", ")})`);
    assert.ok(!up.includes("builder-effective-config.yaml"), `${os} uploads builder-effective-config.yaml`);
  }
});

test("…while every installer and the feeds electron-updater reads still ship", () => {
  assert.deepEqual(uploaded("windows-latest", BUILT["windows-latest"]), [`GitStudio-Setup-${V}.exe`, `GitStudio-Setup-${V}.exe.blockmap`, "latest.yml"]);
  assert.deepEqual(uploaded("ubuntu-22.04", BUILT["ubuntu-22.04"]), BUILT["ubuntu-22.04"].slice(0, 5));
  for (const os of ["macos-14", "macos-15-intel"]) {
    // No mac feed: both arch runners write latest-mac.yml and would clobber
    // each other's (autoUpdate.ts polls the GitHub API on macOS instead).
    assert.deepEqual(uploaded(os, BUILT[os]), BUILT[os].filter((n) => /\.(dmg|zip)$/.test(n)), os);
  }
  // finalize-release refuses to publish without these.
  const verify = /for want in ([^;]+); do/.exec(WORKFLOW)?.[1] ?? "";
  for (const want of ["latest.yml", "latest-linux.yml"]) assert.ok(verify.includes(`"${want}"`), `finalize checks for ${want}`);
});

test("SHA256SUMS.txt covers every installer uploaded, and nothing else", () => {
  const step = /name: Publish checksums[\s\S]*?sha256sum \* > SHA256SUMS\.txt/.exec(WORKFLOW)?.[0] ?? "";
  const patterns = [...step.matchAll(/--pattern '([^']+)'/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, "the checksum step lists its patterns");
  const installers = Object.entries(BUILT)
    .flatMap(([os, names]) => uploaded(os, names))
    .filter((n) => !/\.(yml|blockmap)$/.test(n));
  for (const name of installers) {
    assert.ok(patterns.some((p) => globRe(p).test(name)), `${name} is in SHA256SUMS.txt`);
  }
  for (const name of ["latest.yml", "latest-linux.yml", "builder-debug.yml", `GitStudio-Setup-${V}.exe.blockmap`]) {
    assert.ok(!patterns.some((p) => globRe(p).test(name)), `${name} is not an installer to verify`);
  }
});
