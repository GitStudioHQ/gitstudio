// The browser every harness launcher drives.
//
// GS_CHROME, else Playwright's windowless chrome-headless-shell (the newest in
// its cache), else its Chrome for Testing, and only then a Chrome installed on
// the system. The order lives in ONE place, packages/webview-ui/test/
// findChrome.mjs, which webview-ui's headless tests use too; shot.sh runs that
// file for the path. Before it, every launcher here fell back to
// /Applications/Google Chrome.app whenever GS_CHROME was unset — one run
// launched the owner's own Chrome 111 times.

import { findChrome } from "../../../packages/webview-ui/test/findChrome.mjs";

/** The browser to launch; exits the run with a plain reason when there is none. */
export function harnessChrome() {
  const chrome = findChrome();
  if (!chrome) {
    console.error(
      "no headless Chrome found — install Playwright's chrome-headless-shell " +
        "(npx playwright install chromium-headless-shell) or set GS_CHROME",
    );
    process.exit(2);
  }
  return chrome;
}
