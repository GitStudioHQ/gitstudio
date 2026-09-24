import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The merge editor's toolbar text, MEASURED in VS Code's light themes (the
 * critic, r0923): the caption before a group and the change counter were the
 * theme's muted ink, #717171 on Light+'s #f3f3f3 toolbar — 4.4:1, under AA;
 * the done count the chart green, 3.9:1; the conflict note the warning amber
 * at 85% opacity, 2.38:1. Each is small text and needs 4.5:1 over the
 * toolbar's own ground, computed ink (color-mix comes back as color(srgb …))
 * with opacity folded in. Light Modern too: its toolbar is #f8f8f8 and its
 * ink #3b3b3b. The legend's words and its count badge too (r0924): the count
 * once wore the host's badge pair, 3.9:1 in the desktop's light theme.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

/** VS Code's Light+ and Light Modern values for what the toolbar reads. */
const THEMES: Record<string, Record<string, string>> = {
  "Light+": {
    "--vscode-foreground": "#616161",
    "--vscode-descriptionForeground": "#717171",
    "--vscode-editor-foreground": "#000000",
    "--vscode-editorGroupHeader-tabsBackground": "#f3f3f3",
    "--vscode-editorWarning-foreground": "#bf8803",
    "--vscode-charts-green": "#388a34",
  },
  "Light Modern": {
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-editor-foreground": "#3b3b3b",
    "--vscode-editorGroupHeader-tabsBackground": "#f8f8f8",
    "--vscode-editorWarning-foreground": "#bf8803",
    "--vscode-charts-green": "#388a34",
  },
};

for (const [name, vars] of Object.entries(THEMES)) {
  test(`the toolbar's caption, counter, done count and note read at AA in ${name}`, { skip }, async () => {
    const ground = parseInt(vars["--vscode-editorGroupHeader-tabsBackground"].slice(1, 3), 16);
    const v = await runMergePage(
      CHROME!,
      `
      const parse = (c) => {
        let m = c.match(/^rgba?\\(([^)]+)\\)/);
        if (m) { const p = m[1].split(",").map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
        m = c.match(/^color\\(srgb\\s+([\\d.e-]+)\\s+([\\d.e-]+)\\s+([\\d.e-]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/);
        if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : parseFloat(m[4])];
        return null;
      };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const bar = document.createElement("div");
      bar.className = "jb-toolbar";
      bar.innerHTML = '<span class="jb-toolbar-label">Apply non-conflicting</span><span class="jb-counter">3 of 7 left</span>' +
        '<span class="jb-counter jb-done">All resolved</span><span class="jb-note">Conflicts: both sides changed these lines</span>' +
        '<span class="jb-legend"><button class="jb-legend-chip" type="button"><span class="jb-legend-label">Conflict</span>' +
        '<span class="jb-legend-dash">—</span><span class="jb-legend-note">you choose</span><span class="jb-legend-count">6</span></button></span>';
      document.getElementById("slot").appendChild(bar);
      const ground = parse(getComputedStyle(bar).backgroundColor);
      expect(ground && ground[3] === 1 && ground[0] === ${ground}, "the toolbar has its own ground: " + getComputedStyle(bar).backgroundColor);
      const over = (c, g) => [0, 1, 2].map((i) => c[i] * c[3] + g[i] * (1 - c[3]));
      for (const sel of [".jb-toolbar-label", ".jb-counter:not(.jb-done)", ".jb-counter.jb-done", ".jb-note", ".jb-legend-label", ".jb-legend-note", ".jb-legend-count"]) {
        const el = bar.querySelector(sel);
        const cs = getComputedStyle(el);
        const ink = parse(cs.color);
        expect(!!ink, sel + ": a colour this test reads: " + cs.color);
        if (!ink) continue;
        // The count sits on its own pill: the pill over the toolbar is its ground.
        const pill = parse(cs.backgroundColor);
        const under = pill && pill[3] > 0 ? over(pill, ground) : ground;
        const a = ink[3] * parseFloat(cs.opacity);
        const seen = [0, 1, 2].map((i) => ink[i] * a + under[i] * (1 - a));
        const r = ratio(seen, under);
        expect(r >= 4.5, sel + " reads at " + r.toFixed(2) + ":1 on the toolbar (" + cs.color + " on " + cs.backgroundColor + ", opacity " + cs.opacity + "), below 4.5");
      }
    `,
      // On :root as well as the body, as VS Code sets them on <html>: the
      // --gs-* tokens are declared on :root, and read them there.
      { theme: "light", vars, css: `:root{${Object.entries(vars).map(([k, c]) => `${k}:${c}`).join(";")}}` },
    );
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });
}
