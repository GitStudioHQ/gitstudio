// scripts/install.sh on an older Mac. 2.3.0 moved to Electron 41, which runs
// on macOS 12 Monterey or later: on macOS 11 the app installed and then did not
// open. The script now refuses before it downloads anything, and names the
// last release that runs there (2.2.1) — which it still installs when asked
// for by version. Run for real, under bash, with `uname`, `sw_vers` and `curl`
// stood in for on the PATH; `curl` records what it was asked and answers
// nothing, so no test ever reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "install.sh");
const skip = process.platform === "win32" && "the installer is for macOS and Linux";

/** Run the installer as `os`/`macos`, with `env` on top; what curl was asked, and what was said. */
function install(os: "Darwin" | "Linux", macos: string, env: Record<string, string> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "gs-install-"));
  try {
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("uname", `case "$1" in -s) echo ${os} ;; -m) echo arm64 ;; *) echo ${os} ;; esac`);
    stub("sw_vers", `[ "$1" = -productVersion ] && echo ${macos}`);
    stub("curl", `echo "$@" >> "${join(bin, "curl.log")}"\nexit 22`);
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env },
      timeout: 30_000,
    });
    let curled = "";
    try {
      curled = readFileSync(join(bin, "curl.log"), "utf8");
    } catch {
      /* never asked */
    }
    return { code: r.status, stderr: r.stderr, stdout: r.stdout, curled };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("macOS 11: refused before anything downloads, pointing at 2.2.1", { skip }, () => {
  const r = install("Darwin", "11.7.10");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /GitStudio 2\.3\.0 and later need macOS 12 Monterey or newer, and this Mac runs macOS 11\.7\.10\./);
  assert.match(r.stderr, /https:\/\/github\.com\/GitStudioHQ\/gitstudio\/releases\/tag\/app-v2\.2\.1/);
  assert.match(r.stderr, /GITSTUDIO_VERSION=2\.2\.1 bash/);
  assert.equal(r.curled, "", "nothing was fetched");
});

test("macOS 11 with the last release that runs there pinned: let through, and it fetches that one", { skip }, () => {
  for (const pin of ["2.2.1", "v2.2.1", "app-v2.2.1", "2.1.0"]) {
    const r = install("Darwin", "11.7.10", { GITSTUDIO_VERSION: pin });
    assert.doesNotMatch(r.stderr, /need macOS 12/, pin);
    const version = pin.replace(/^(app-)?v/, "");
    assert.match(r.curled, new RegExp(`releases/download/app-v${version.replace(/\./g, "\\.")}/GitStudio-${version.replace(/\./g, "\\.")}-arm64\\.dmg`), pin);
  }
  // …but not a release that needs 12.
  const r = install("Darwin", "11.7.10", { GITSTUDIO_VERSION: "2.3.0" });
  assert.match(r.stderr, /need macOS 12/);
  assert.equal(r.curled, "");
});

test("macOS 10: refused, without offering 2.2.1 (it does not run there either)", { skip }, () => {
  const r = install("Darwin", "10.15.7");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /this Mac runs macOS 10\.15\.7\./);
  assert.doesNotMatch(r.stderr, /2\.2\.1/);
  assert.equal(r.curled, "");
});

test("macOS 12 and later, and Linux, go on to find the latest release", { skip }, () => {
  for (const macos of ["12.0", "12.7.6", "14.6.1", "26.0"]) {
    const r = install("Darwin", macos);
    assert.doesNotMatch(r.stderr, /need macOS/, macos);
    assert.match(r.curled, /api\.github\.com\/repos\/GitStudioHQ\/gitstudio\/releases/, macos);
  }
  // Linux never asks sw_vers anything (the stub would claim macOS 11).
  const linux = install("Linux", "11.0");
  assert.doesNotMatch(linux.stderr, /need macOS/);
});

test("an unreadable macOS version is not a reason to refuse", { skip }, () => {
  const r = install("Darwin", "");
  assert.doesNotMatch(r.stderr, /need macOS/);
  assert.match(r.curled, /api\.github\.com/);
});

test("the three places that know the minimum agree: the installer, the cask, and 2.3.0's notes", () => {
  const sh = readFileSync(SCRIPT, "utf8");
  assert.match(sh, /^MIN_MACOS=12$/m);
  assert.match(sh, /^FIRST_NEEDING_MIN="2\.3\.0"$/m);
  assert.match(sh, /^LAST_FOR_MACOS_11="2\.2\.1"$/m);
  const cask = readFileSync(join(__dirname, "..", "..", "..", "Casks", "gitstudio.rb"), "utf8");
  assert.match(cask, /^ {2}depends_on macos: :monterey$/m, "Monterey is macOS 12");
  assert.doesNotMatch(cask, /^ {2}depends_on :macos$/m, "Homebrew refuses a bare `depends_on :macos` beside a versioned one");
  const notes = readFileSync(join(__dirname, "..", "..", "..", "docs", "releases", "app-v2.3.0.md"), "utf8");
  assert.match(notes, /macOS 12 Monterey or later/);
});
