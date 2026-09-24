import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
      // A file URL: an absolute Windows path reads to the ESM loader as the scheme "d:".
      ["--input-type=module", "-e", `import { harnessChrome } from ${JSON.stringify(pathToFileURL(join(HARNESS, "chrome.mjs")).href)}; console.log(harnessChrome());`],
      { env: envWithout(join(dir, "cache")), encoding: "utf8" },
    ).trim();
    assert.equal(out, newest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brand/rasterise.sh asks the shared discovery, launches the newest headless shell, and refuses the desktop Chrome outside CI", { skip: process.platform === "win32" && "sh" }, () => {
  const script = fileURLToPath(new URL("../../../brand/rasterise.sh", import.meta.url));
  const src = readFileSync(script, "utf8");
  // It named "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  // as the program to run; only its refusal may mention the app now.
  assert.doesNotMatch(src, /Google Chrome\.app\/Contents\/MacOS/, "rasterise.sh still launches the system Chrome — not running it");
  assert.match(src, /packages\/webview-ui\/test\/findChrome\.mjs/, "rasterise.sh does not ask findChrome.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gs-brand-chrome-"));
  try {
    const log = join(dir, "log");
    const newest = fakeCache(join(dir, "cache"), log);
    writeFileSync(join(dir, "in.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    execFileSync("sh", [script, join(dir, "in.svg"), join(dir, "out.png"), "16"], {
      env: envWithout(join(dir, "cache")),
      encoding: "utf8",
    });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [newest]);
    // Pointed at the desktop Chrome (a fake one here), outside CI it refuses.
    const fakeDesktop = join(dir, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    mkdirSync(dirname(fakeDesktop), { recursive: true });
    writeFileSync(fakeDesktop, `#!/bin/sh\necho desktop >> "${log}"\n`);
    chmodSync(fakeDesktop, 0o755);
    const env = { ...envWithout(join(dir, "cache")), GS_CHROME: fakeDesktop };
    delete env.CI;
    assert.throws(() => execFileSync("sh", [script, join(dir, "in.svg"), join(dir, "out2.png"), "16"], { env, encoding: "utf8", stdio: "pipe" }));
    assert.doesNotMatch(readFileSync(log, "utf8"), /desktop/, "the desktop Chrome was never launched");
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
