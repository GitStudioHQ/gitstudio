// Screenshots of the GitStudio · AI settings panel, per theme, from the page
// its html() returns (test/aiSettingsPage.ts), in a windowless Chrome.
//
//   npx tsx apps/extension/harness/ai-settings/shots.ts [outDir]
//
//   THEMES=dark,light,hc-dark,hc-light   which themes (default: all four)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiSettingsPage, aiStatus } from "../../test/aiSettingsPage";
import type { VsCodeTheme } from "../../../../scripts/merge-e2e/themes";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/ai-settings/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const scenes: { name: string; status: Record<string, unknown>; click?: string }[] = [
  { name: "01-not-connected", status: aiStatus() },
  { name: "02-connected", status: aiStatus({ ready: true, activeId: "anthropic", provider: "anthropic", hasAnthropicKey: true }) },
  { name: "03-configuring", status: aiStatus(), click: "OpenAI" },
];

(async () => {
  const themes: VsCodeTheme[] = process.env.THEMES
    ? (process.env.THEMES.split(",") as VsCodeTheme[])
    : ["dark", "light", "hc-dark", "hc-light"];
  for (const theme of themes) {
    for (const s of scenes) {
      const page = await AiSettingsPage.open(theme, { width: 720, height: 980, scale: 2 });
      try {
        await page.send({ type: "status", status: s.status });
        if (s.click) {
          await page.eval(`(function () {
            var cards = document.querySelectorAll(".ai-prov-card");
            for (var i = 0; i < cards.length; i++) if (cards[i].textContent.indexOf(${JSON.stringify(s.click)}) === 0 || cards[i].querySelector(".ai-prov-name").textContent.trim().indexOf(${JSON.stringify(s.click)}) === 0) { cards[i].click(); return; }
          })()`);
        }
        await page.eval("new Promise(function (r) { setTimeout(r, 200); })");
        const file = join(OUT, `${s.name}-${theme}.png`);
        await page.screenshot(file);
        console.log(file, page.page.errors.length ? "ERRORS: " + page.page.errors.join(" | ") : "");
      } finally {
        await page.close();
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
