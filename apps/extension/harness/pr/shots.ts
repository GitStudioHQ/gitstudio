// Screenshots of the pull request page — open, closed without merging,
// merged and draft — per theme, as the real panel code writes it and under
// its OWN Content-Security-Policy (test/prPanelPage.ts), in a windowless
// Chrome. A style or script the policy refuses is refused here too, and
// reported: the label chips' colours were dropped that way, unseen.
//
//   npx tsx apps/extension/harness/pr/shots.ts [outDir]
//
// Writes <scene>-<theme>.png to <repo>/out/pr-panel by default, and prints
// what each page shows (badge, checks, labels' colours, actions).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../../../scripts/merge-e2e/cdp";
import { OUT_DIR, panelHtml, scenes, themedPage, type VsCodeTheme } from "../../test/prPanelPage";

const OUT = process.argv[2] ?? OUT_DIR;
const THEMES: VsCodeTheme[] = ["dark", "light"];
const WIDTH = 980;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await Browser.launch({ width: WIDTH, height: 900 });
  let refused = 0;
  try {
    for (const scene of scenes()) {
      const html = await panelHtml(scene);
      for (const theme of THEMES) {
        const file = join(OUT, `${scene.name}-${theme}.html`);
        writeFileSync(file, themedPage(html, theme));
        const page = await browser.newPage(WIDTH, 900, 1);
        const csp: string[] = [];
        await page.send("Log.enable");
        page.on("Log.entryAdded", (p) => {
          const text = String((p as { entry?: { text?: string } }).entry?.text ?? "");
          if (/Content Security Policy/i.test(text)) csp.push(text);
        });
        await browser.goto(page, pathToFileURL(file).href);
        // The whole page in one picture.
        const height = await page.eval<number>("document.documentElement.scrollHeight");
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: WIDTH,
          height: Math.min(height, 2400),
          deviceScaleFactor: 1,
          mobile: false,
        });
        const png = join(OUT, `${scene.name}-${theme}.png`);
        writeFileSync(png, await page.screenshot());
        const facts = await page.eval<Record<string, unknown>>(`(() => ({
          badge: document.querySelector(".badge")?.textContent.trim(),
          checks: document.querySelector(".checks")?.textContent.trim(),
          labels: [...document.querySelectorAll(".label")].map((l) => l.textContent + " " + getComputedStyle(l).getPropertyValue("--label").trim()),
          actions: [...document.querySelectorAll(".toolbar button")].map((b) => b.textContent.trim() + (b.disabled ? " (disabled)" : "")),
          head: document.querySelector(".branch--head")?.textContent.trim(),
        }))()`);
        console.log(`${png}\n  ${JSON.stringify(facts)}`);
        if (csp.length > 0 || page.errors.length > 0) {
          refused += csp.length + page.errors.length;
          console.log(`  REFUSED/ERRORS: ${JSON.stringify([...csp, ...page.errors])}`);
        }
        await browser.closePage(page);
      }
    }
  } finally {
    await browser.close();
  }
  if (refused > 0) {
    process.exitCode = 1;
  }
}

void main();
