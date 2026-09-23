// Which browser a headless check drives — the ONE list, for this package's
// test/headless.ts and every launcher in apps/desktop/harness (shot.sh asks it
// on the command line: `node findChrome.mjs` prints the path).
//
// The order is the point. A run with GS_CHROME unset once fell through to the
// owner's own /Applications/Google Chrome.app and launched it 111 times; an
// earlier night it was ~1,000, the windows kept flashing, and Chrome was
// uninstalled as broken. So after GS_CHROME comes Playwright's windowless
// chrome-headless-shell (the newest revision in its cache), then Playwright's
// Chrome for Testing, and only then a Chrome installed on the system — which is
// what the Linux, macOS and Windows CI runners have, so they keep working.
//
// Plain JavaScript on purpose: the desktop harness runs under bare `node`.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** A browser installed on the system, after every Playwright build. */
export const SYSTEM_CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * @typedef {object} DiscoveryEnv
 * @property {Record<string, string | undefined>} [env]  defaults to process.env
 * @property {string} [home]                            defaults to os.homedir()
 * @property {string} [platform]                        defaults to process.platform
 * @property {(dir: string) => string[]} [readdir]      defaults to fs.readdirSync
 * @property {(path: string) => boolean} [exists]       defaults to fs.existsSync
 */

/**
 * Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH when it names a
 * directory ("0" means "inside node_modules", which we do not search), then the
 * platform's cache directory.
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @param {string} platform
 * @returns {string[]}
 */
export function playwrightRoots(env, home, platform) {
  const join = platform === "win32" ? win32.join : posix.join;
  const roots = [];
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") roots.push(custom);
  if (platform === "darwin") roots.push(join(home, "Library", "Caches", "ms-playwright"));
  else if (platform === "win32") roots.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright"));
  else roots.push(join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright"));
  return [...new Set(roots)];
}

/**
 * `<prefix><revision>` directories under `root`, newest revision first.
 * @param {string} root
 * @param {string} prefix
 * @param {(dir: string) => string[]} readdir
 * @returns {string[]}
 */
function revisions(root, prefix, readdir) {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  return list(root, readdir)
    .map((name) => ({ name, rev: Number(pattern.exec(name)?.[1] ?? NaN) }))
    .filter((d) => Number.isFinite(d.rev))
    .sort((a, b) => b.rev - a.rev)
    .map((d) => d.name);
}

/**
 * @param {string} dir
 * @param {(dir: string) => string[]} readdir
 * @returns {string[]}
 */
function list(dir, readdir) {
  try {
    return readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Every browser a headless check may drive, in the order it should be tried.
 * Nothing here is checked for existence except the directories it lists.
 * @param {DiscoveryEnv} [opts]
 * @returns {string[]}
 */
export function chromeCandidates(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const readdir = opts.readdir ?? ((dir) => readdirSync(dir));
  const join = platform === "win32" ? win32.join : posix.join;
  const exe = platform === "win32" ? ".exe" : "";
  const roots = playwrightRoots(env, home, platform);

  /** @type {string[]} */
  const out = [];
  if (env.GS_CHROME) out.push(env.GS_CHROME);

  // 1. chrome-headless-shell: no window, no Dock icon, nothing on screen.
  //    chromium_headless_shell-<rev>/chrome-headless-shell-<platform>/chrome-headless-shell
  //    (older revisions: chromium_headless_shell-<rev>/chrome-<platform>/headless_shell)
  for (const root of roots) {
    for (const rev of revisions(root, "chromium_headless_shell-", readdir)) {
      const dir = join(root, rev);
      const builds = list(dir, readdir).sort();
      for (const b of builds) if (b.startsWith("chrome-headless-shell-")) out.push(join(dir, b, `chrome-headless-shell${exe}`));
      for (const b of builds) if (/^chrome-(mac|linux|win)/.test(b)) out.push(join(dir, b, `headless_shell${exe}`));
    }
  }

  // 2. Chrome for Testing (older revisions: Chromium), a full browser run headless.
  for (const root of roots) {
    for (const rev of revisions(root, "chromium-", readdir)) {
      const dir = join(root, rev);
      for (const b of list(dir, readdir).sort()) {
        if (!b.startsWith("chrome-")) continue;
        if (platform === "darwin") {
          out.push(join(dir, b, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
          out.push(join(dir, b, "Chromium.app", "Contents", "MacOS", "Chromium"));
        } else {
          out.push(join(dir, b, `chrome${exe}`));
        }
      }
    }
  }

  // 3. Last: a Chrome installed on the system (CI runners).
  out.push(...SYSTEM_CHROMES);
  return [...new Set(out)];
}

/**
 * The browser to drive, or undefined when this machine has none.
 * @param {DiscoveryEnv} [opts]
 * @returns {string | undefined}
 */
export function findChrome(opts = {}) {
  const exists = opts.exists ?? existsSync;
  return chromeCandidates(opts).find((p) => exists(p));
}

// `node findChrome.mjs` prints the path (for shell launchers), or fails.
function runAsScript() {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (runAsScript()) {
  const chrome = findChrome();
  if (!chrome) {
    process.stderr.write("no headless Chrome found — set GS_CHROME to Playwright's chrome-headless-shell\n");
    process.exit(1);
  }
  process.stdout.write(chrome + "\n");
}
