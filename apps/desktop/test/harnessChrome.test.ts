import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every harness launcher finds its browser the way packages/webview-ui's
 * headless tests do (test/findChrome.mjs): GS_CHROME, then Playwright's
 * windowless chrome-headless-shell, then its Chrome for Testing, and only then
 * a system Chrome. Each used to fall back to /Applications/Google Chrome.app
 * whenever GS_CHROME was unset, and one run launched the owner's own Chrome 111
 * times.
 */

const HARNESS = fileURLToPath(new URL("../harness/", import.meta.url));
const SYSTEM_CHROME = /Google Chrome\.app/;

/** The launchers: every harness script that starts a browser. */
function launchers(): { name: string; src: string }[] {
  return readdirSync(HARNESS)
    .filter((n) => /\.(mjs|sh)$/.test(n) && n !== "chrome.mjs")
    .map((name) => ({ name, src: readFileSync(join(HARNESS, name), "utf8") }))
    .filter(({ src }) => /\bCHROME\b/.test(src));
}

test("no harness launcher names the system Chrome, and every one asks the shared discovery", () => {
  const found = launchers();
  // check, validate, probe, perf, contrast, affordance, fit and shot.sh
  assert.ok(found.length >= 8, `found only ${found.map((f) => f.name).join(", ")}`);
  for (const { name, src } of found) {
    assert.doesNotMatch(src, SYSTEM_CHROME, `${name} still names /Applications/Google Chrome.app`);
    if (name.endsWith(".mjs")) {
      assert.match(src, /import \{ harnessChrome \} from "\.\/chrome\.mjs";/, `${name} does not import harnessChrome`);
      assert.match(src, /const CHROME = harnessChrome\(\);/, `${name} does not take CHROME from harnessChrome()`);
    } else {
      assert.match(src, /packages\/webview-ui\/test\/findChrome\.mjs/, `${name} does not ask findChrome.mjs`);
    }
  }
});

/** A fake Playwright cache: an old and a new headless shell and a Chrome for
 *  Testing, each a script that records how it was launched. */
function fakeCache(dir: string, log: string) {
  const script = `#!/bin/sh\necho "$0" >> "${log}"\nfor a in "$@"; do case "$a" in --screenshot=*) : > "\${a#--screenshot=}";; esac; done\nexit 0\n`;
  const put = (rel: string) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, script);
    chmodSync(p, 0o755);
    return p;
  };
  put("chromium_headless_shell-999/chrome-headless-shell-x/chrome-headless-shell");
  const newest = put("chromium_headless_shell-1228/chrome-headless-shell-x/chrome-headless-shell");
  put("chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  put("chromium-1300/chrome-x/chrome");
  return newest;
}

function envWithout(cache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  delete env.GS_CHROME;
  return env;
}

test("harnessChrome() with GS_CHROME unset is the newest Playwright headless shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-harness-chrome-"));
  try {
    const newest = fakeCache(join(dir, "cache"), join(dir, "log"));
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import { harnessChrome } from ${JSON.stringify(join(HARNESS, "chrome.mjs"))}; console.log(harnessChrome());`],
      { env: envWithout(join(dir, "cache")), encoding: "utf8" },
    ).trim();
    assert.equal(out, newest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shot.sh with GS_CHROME unset launches the newest Playwright headless shell", { skip: process.platform === "win32" && "sh" }, () => {
  const shot = join(HARNESS, "shot.sh");
  // Never run a shot.sh that could still reach the system Chrome: that is the
  // bug this pins, and running it would open the owner's browser.
  assert.doesNotMatch(readFileSync(shot, "utf8"), SYSTEM_CHROME, "shot.sh still names the system Chrome — not running it");
  const dir = mkdtempSync(join(tmpdir(), "gs-harness-chrome-"));
  try {
    const log = join(dir, "log");
    const newest = fakeCache(join(dir, "cache"), log);
    execFileSync("sh", [shot, "issues", join(dir, "out.png")], {
      env: { ...envWithout(join(dir, "cache")), GS_HARNESS_PAGE: dir },
      encoding: "utf8",
    });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [newest]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
