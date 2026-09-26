// The PR description page in a windowless Chrome, under its OWN
// Content-Security-Policy (prPanelPage.ts): what the user sees, not what the
// html says.
//
// The page's label chips carried their colour in style="--label:#hex". The
// CSP allows only nonce'd <style> blocks, an attribute can't carry a nonce,
// and Chrome dropped every one ("Applying inline style violates … style-src")
// — every label drew the same grey. And a merged PR and one closed without
// merging drew the identical purple "Closed" badge. Both are checked here in
// computed styles, with the CSP console as a witness, in dark and light.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { panelHtml, scenes, themedPage, type VsCodeTheme } from "./prPanelPage";

const chrome = findChrome();
if (chrome && !process.env.GS_CHROME) process.env.GS_CHROME = chrome;
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let browser: Browser | undefined;
const dir = mkdtempSync(join(tmpdir(), "gs-pr-panel-"));
before(async () => {
  if (!skip) browser = await Browser.launch({ width: 980, height: 900 });
});
after(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function load(name: string, theme: VsCodeTheme): Promise<{ page: Page; csp: string[] }> {
  const scene = scenes().find((s) => s.name === name)!;
  const file = join(dir, `${name}-${theme}.html`);
  writeFileSync(file, themedPage(await panelHtml(scene), theme));
  const page = await browser!.newPage(980, 900, 1);
  const csp: string[] = [];
  await page.send("Log.enable");
  page.on("Log.entryAdded", (p) => {
    const text = String((p as { entry?: { text?: string } }).entry?.text ?? "");
    if (/Content Security Policy/i.test(text)) csp.push(text);
  });
  await browser!.goto(page, pathToFileURL(file).href);
  await page.waitFor(`document.readyState === "complete" && typeof window.__send === "function"`);
  return { page, csp };
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: each label chip wears its own colour, and the page's CSP blocks nothing`, { skip }, async () => {
    const { page, csp } = await load("open", theme);
    const chips = await page.eval<{ text: string; label: string; bg: string }[]>(
      `[...document.querySelectorAll(".label")].map(l => ({ text: l.textContent, label: getComputedStyle(l).getPropertyValue("--label").trim(), bg: getComputedStyle(l).backgroundColor }))`,
    );
    assert.deepEqual(
      chips.map((c) => [c.text, c.label]),
      [
        ["enhancement", "#a2eeef"],
        ["extension", "#5319e7"],
        ["bug", "#d73a4a"],
      ],
    );
    assert.equal(new Set(chips.map((c) => c.bg)).size, 3, `three chips, three backgrounds: ${JSON.stringify(chips)}`);
    assert.deepEqual(csp, [], "no style or script the page ships is refused by its own policy");
    assert.deepEqual(page.errors, []);
    // An Actions run failed: the pill says so — not "No checks".
    assert.equal(await page.eval(`document.querySelector(".checks").textContent.trim()`), "1 of 2 checks failed");
    assert.match(String(await page.eval(`document.querySelector(".checks").className`)), /\bfail\b/);
  });

  test(`${theme}: Merged and Closed are two different badges`, { skip }, async () => {
    const badge = async (name: string) => {
      const { page } = await load(name, theme);
      return page.eval<{ word: string; bg: string; icon: string }>(
        `(() => { const b = document.querySelector(".badge"); return { word: b.textContent.trim(), bg: getComputedStyle(b).backgroundColor, icon: b.querySelector(".codicon").className }; })()`,
      );
    };
    const merged = await badge("merged");
    const closed = await badge("closed-unmerged");
    assert.equal(merged.word, "Merged");
    assert.equal(closed.word, "Closed");
    assert.notEqual(merged.bg, closed.bg);
    assert.match(merged.icon, /codicon-git-merge/);
    assert.match(closed.icon, /codicon-git-pull-request-closed/);
  });
}

test("a merge patches the page in place: the badge reads Merged and Merge… is disabled", { skip }, async () => {
  const { page } = await load("open", "dark");
  await page.eval(`window.scrollTo(0, 200)`);
  await page.eval(`window.__send({ type: "state", kind: "merged" })`);
  const after = await page.eval<{ word: string; cls: string; merge: boolean; review: boolean }>(
    `(() => ({ word: document.querySelector(".badge").textContent.trim(), cls: document.querySelector(".badge").className, merge: document.getElementById("btn-merge").disabled, review: document.getElementById("btn-review").disabled }))()`,
  );
  assert.deepEqual(after, { word: "Merged", cls: "badge badge-merged", merge: true, review: true });
  assert.deepEqual(page.errors, []);
});
