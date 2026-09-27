import { test, after } from "node:test";
import assert from "node:assert/strict";
import { AiSettingsPage, aiStatus } from "./aiSettingsPage";
import type { VsCodeTheme } from "../../../scripts/merge-e2e/themes";

// The GitStudio · AI panel wears the editor's theme.
//
// It hard-coded the desktop app's palette — #0d1016 behind every dark theme,
// its own greys for cards and lines — and had no high-contrast look: under any
// theme but Dark+ it was a different app pasted into the editor, and in a dark
// theme the provider names were drawn in the button default, black on near
// black. Its lead line said "✨ commit messages" where the UI shows the
// sparkle codicon. Measured from computed styles in the rendered page.

const chrome = AiSettingsPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: AiSettingsPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

/** WCAG contrast of two computed colours: rgb(0–255) or, from color-mix, color(srgb 0–1). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const unit = c.startsWith("color(srgb") ? 255 : 1;
    const [r, g, bl] = (c.replace(/^color\(srgb/, "").match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) * unit);
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** A colour the page resolves for a var(). */
const probe = (page: AiSettingsPage, prop: string, value: string) =>
  page.eval<string>(`(function () {
    var d = document.createElement("div");
    d.style.${prop} = ${JSON.stringify(value)};
    document.body.appendChild(d);
    var c = getComputedStyle(d).${prop};
    d.remove();
    return c;
  })()`);

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the page, its cards and their names are the theme's`, { skip }, async () => {
    const page = await AiSettingsPage.open(theme);
    opened.push(page);
    await page.send({ type: "status", status: aiStatus() });
    const editorBg = await probe(page, "backgroundColor", "var(--vscode-editor-background)");
    const fg = await probe(page, "color", "var(--vscode-foreground)");
    const hc = theme.startsWith("hc");
    const line = await probe(page, "borderTopColor", hc ? "var(--vscode-contrastBorder)" : "var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 16%, transparent))");
    const got = await page.eval<{ bodyBg: string; name: string; cardBg: string; cardBorder: string; lead: string }>(`(function () {
      var card = document.querySelector(".ai-prov-card");
      var cs = getComputedStyle(card);
      return {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        name: getComputedStyle(card.querySelector(".ai-prov-name")).color,
        cardBg: cs.backgroundColor,
        cardBorder: cs.borderTopColor,
        lead: document.querySelector(".lead").textContent,
      };
    })()`);
    assert.equal(got.bodyBg, editorBg, "the page is the editor's background");
    assert.equal(got.name, fg, "a provider's name is the theme's text colour");
    assert.ok(contrast(got.name, got.cardBg) >= 4.5, `name on its card: ${contrast(got.name, got.cardBg).toFixed(2)}:1`);
    assert.equal(got.cardBorder, line, "a card's line is the theme's");
    assert.doesNotMatch(got.lead, /[✨\u{1F300}-\u{1FAFF}]/u, "words, not an emoji the UI does not show");
  });
}

test("high contrast: the primary button is the theme's outlined button, not the violet gradient", { skip }, async () => {
  const page = await AiSettingsPage.open("hc-dark");
  opened.push(page);
  await page.send({ type: "status", status: aiStatus() });
  await page.eval(`(function () {
    var cards = document.querySelectorAll(".ai-prov-card");
    for (var i = 0; i < cards.length; i++) if (cards[i].querySelector(".ai-prov-name").textContent.trim() === "OpenAI") { cards[i].click(); return; }
  })()`);
  const border = await probe(page, "borderTopColor", "var(--vscode-contrastBorder)");
  const b = await page.eval<{ image: string; border: string }>(`(function () {
    var cs = getComputedStyle(document.querySelector(".btn-primary"));
    return { image: cs.backgroundImage, border: cs.borderTopColor };
  })()`);
  assert.equal(b.image, "none");
  assert.equal(b.border, border);
});
