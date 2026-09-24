import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeCandidates, findChrome, SYSTEM_CHROMES } from "./findChrome.mjs";

/**
 * Which browser a headless check launches. With GS_CHROME unset a run once fell
 * through to the owner's /Applications/Google Chrome.app and launched it 111
 * times (an earlier night: ~1,000, and Chrome was uninstalled as broken). After
 * GS_CHROME the order is: Playwright's windowless chrome-headless-shell (newest
 * revision), Playwright's Chrome for Testing, and only then a system Chrome —
 * which the CI runners use, so their paths stay in the list.
 */

const MAC_CACHE = "/Users/ada/Library/Caches/ms-playwright";
const SHELL_1228 = `${MAC_CACHE}/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const SHELL_999 = `${MAC_CACHE}/chromium_headless_shell-999/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const SHELL_1148_OLD = `${MAC_CACHE}/chromium_headless_shell-1148/chrome-mac/headless_shell`;
const CFT_1228 = `${MAC_CACHE}/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CHROMIUM_1140 = `${MAC_CACHE}/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
const SYSTEM_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** A fake file system from a list of files: readdir lists, exists tests. */
function fakeFs(files: string[], sep: "/" | "\\" = "/") {
  const exists = (p: string) => files.includes(p);
  const readdir = (dir: string) => {
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    const names = new Set<string>();
    for (const f of files) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(sep)[0]);
    if (!names.size) throw Object.assign(new Error(`ENOENT ${dir}`), { code: "ENOENT" });
    return [...names];
  };
  return { exists, readdir };
}

const mac = (files: string[], env: Record<string, string> = {}) => ({
  env,
  home: "/Users/ada",
  platform: "darwin",
  ...fakeFs(files),
});

test("GS_CHROME wins over everything", () => {
  const opts = mac([SHELL_1228, CFT_1228, SYSTEM_MAC, "/opt/mine/chrome"], { GS_CHROME: "/opt/mine/chrome" });
  assert.equal(findChrome(opts), "/opt/mine/chrome");
  assert.equal(chromeCandidates(opts)[0], "/opt/mine/chrome");
});

test("unset GS_CHROME: Playwright's headless shell before Chrome for Testing before the system Chrome", () => {
  const all = [SYSTEM_MAC, CFT_1228, SHELL_1228];
  assert.equal(findChrome(mac(all)), SHELL_1228);
  assert.equal(findChrome(mac([SYSTEM_MAC, CFT_1228])), CFT_1228);
  assert.equal(findChrome(mac([SYSTEM_MAC])), SYSTEM_MAC);
  assert.equal(findChrome(mac([])), undefined);

  const order = chromeCandidates(mac(all));
  assert.ok(order.indexOf(SHELL_1228) < order.indexOf(CFT_1228), order.join("\n"));
  assert.ok(order.indexOf(CFT_1228) < order.indexOf(SYSTEM_MAC), order.join("\n"));
  assert.equal(order.at(-SYSTEM_CHROMES.length), SYSTEM_CHROMES[0], "the system Chromes come last");
});

test("the NEWEST headless shell, by revision number (not by string)", () => {
  assert.equal(findChrome(mac([SHELL_999, SHELL_1228])), SHELL_1228);
  // the pre-1200 layout (chrome-mac/headless_shell) is still a headless shell,
  // and still beats any Chrome for Testing
  assert.equal(findChrome(mac([SHELL_1148_OLD, CFT_1228, SYSTEM_MAC])), SHELL_1148_OLD);
  assert.equal(findChrome(mac([SHELL_1148_OLD, SHELL_1228])), SHELL_1228);
  // an older Chromium build is still a Playwright build, and still before the system's
  assert.equal(findChrome(mac([CHROMIUM_1140, SYSTEM_MAC])), CHROMIUM_1140);
});

test("a GS_CHROME that does not exist falls through to the same order", () => {
  assert.equal(findChrome(mac([SYSTEM_MAC, SHELL_1228], { GS_CHROME: "/nowhere/chrome" })), SHELL_1228);
});

test("PLAYWRIGHT_BROWSERS_PATH is searched first", () => {
  const custom = "/srv/pw/chromium_headless_shell-1300/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  assert.equal(findChrome(mac([SHELL_1228, custom], { PLAYWRIGHT_BROWSERS_PATH: "/srv/pw" })), custom);
  // "0" means "inside node_modules": not a directory to search
  assert.equal(findChrome(mac([SHELL_1228], { PLAYWRIGHT_BROWSERS_PATH: "0" })), SHELL_1228);
});

test("Linux CI: the Playwright cache under ~/.cache, then /usr/bin", () => {
  const shell = "/home/runner/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
  const cft = "/home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
  const linux = (files: string[], env: Record<string, string> = {}) => ({ env, home: "/home/runner", platform: "linux", ...fakeFs(files) });
  assert.equal(findChrome(linux(["/usr/bin/google-chrome", cft, shell])), shell);
  assert.equal(findChrome(linux(["/usr/bin/google-chrome", cft])), cft);
  assert.equal(findChrome(linux(["/usr/bin/google-chrome"])), "/usr/bin/google-chrome");
  assert.equal(findChrome(linux(["/usr/bin/chromium"])), "/usr/bin/chromium");
  const xdg = "/xdg/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
  assert.equal(findChrome(linux(["/usr/bin/google-chrome", xdg], { XDG_CACHE_HOME: "/xdg" })), xdg);
});

test("Windows CI: the Playwright cache under LOCALAPPDATA, then Program Files", () => {
  const local = "C:\\Users\\runner\\AppData\\Local";
  const shell = win32.join(local, "ms-playwright", "chromium_headless_shell-1228", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  const system = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const win = (files: string[]) => ({
    env: { LOCALAPPDATA: local },
    home: "C:\\Users\\runner",
    platform: "win32",
    ...fakeFs(files, "\\"),
  });
  assert.equal(findChrome(win([system, shell])), shell);
  assert.equal(findChrome(win([system])), system);
});

/**
 * The real thing, end to end: test/headless.ts's findChrome() in a process with
 * GS_CHROME unset and a Playwright cache holding an old and a new headless shell
 * and a Chrome for Testing. It must pick the newest shell — never the system's
 * Chrome, which this machine may well have.
 */
test("headless.ts: GS_CHROME unset picks the newest Playwright headless shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-find-chrome-"));
  try {
    const exe = process.platform === "win32" ? ".exe" : "";
    const put = (rel: string) => {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
      return p;
    };
    put(`chromium_headless_shell-999/chrome-headless-shell-x/chrome-headless-shell${exe}`);
    const newest = put(`chromium_headless_shell-1228/chrome-headless-shell-x/chrome-headless-shell${exe}`);
    put(
      process.platform === "darwin"
        ? "chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        : `chromium-1300/chrome-x/chrome${exe}`,
    );
    const headless = fileURLToPath(new URL("./headless.ts", import.meta.url));
    const probe = join(dir, "probe.mts");
    writeFileSync(probe, `import { findChrome } from ${JSON.stringify(headless)};\nconsole.log(findChrome() ?? "(none)");\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir };
    delete env.GS_CHROME;
    const out = execFileSync(process.execPath, ["--import", "tsx", probe], {
      env,
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    }).trim();
    assert.equal(out, newest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Both halves of headless.ts's rule, end to end. The order comes from
 * findChrome.mjs, but outside CI the desktop Chrome (a path through
 * "Google Chrome.app") is never driven, not even from GS_CHROME; on a CI runner
 * (CI set) it stays the last resort, so the macOS job still runs these checks.
 */
test("headless.ts: the desktop Chrome only on CI, even when GS_CHROME names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-find-chrome-desktop-"));
  try {
    const exe = process.platform === "win32" ? ".exe" : "";
    const put = (rel: string) => {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
      return p;
    };
    const desktop = put("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    const shell = put(`pw/chromium_headless_shell-1228/chrome-headless-shell-x/chrome-headless-shell${exe}`);
    const headless = fileURLToPath(new URL("./headless.ts", import.meta.url));
    const probe = join(dir, "probe.mts");
    writeFileSync(probe, `import { findChrome } from ${JSON.stringify(headless)};\nconsole.log(findChrome() ?? "(none)");\n`);
    const run = (extra: Record<string, string | undefined>) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GS_CHROME: desktop, ...extra };
      delete env.CI;
      if (extra.CI) env.CI = extra.CI;
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
      return execFileSync(process.execPath, ["--import", "tsx", probe], {
        env,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      }).trim();
    };

    // Not CI: GS_CHROME naming the desktop Chrome is passed over for the shell…
    assert.equal(run({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "pw") }), shell);
    // …and with no Playwright build at all, it is still never chosen.
    const bare = run({ PLAYWRIGHT_BROWSERS_PATH: undefined, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir, XDG_CACHE_HOME: dir });
    assert.doesNotMatch(bare, /Google Chrome\.app/, `picked ${bare}`);

    // CI: GS_CHROME is honoured as given, desktop Chrome or not.
    assert.equal(run({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "pw"), CI: "true" }), desktop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
