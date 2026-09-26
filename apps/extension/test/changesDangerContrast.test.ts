import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type VsCodeTheme } from "./changesPage";

// The Changes view's filled danger buttons — a danger confirm's Discard /
// Delete, and the push review's Force push — carry their label at AA
// contrast (4.5:1) in every built-in theme.
//
// They were filled with --gs-danger, the theme's error TEXT colour: in Dark+
// that is #f48771, and white on it is about 2.5:1. Measured on the computed
// colours of the real page in each theme.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

/** WCAG contrast of two computed CSS colours (rgb() or color(srgb …)). */
const CONTRAST = `
  function rgb(c) {
    var m = /^rgba?\\(([^)]+)\\)/.exec(c);
    if (m) return m[1].split(/[ ,\\/]+/).filter(Boolean).slice(0, 3).map(Number);
    m = /^color\\(srgb ([^)]+)\\)/.exec(c);
    if (m) return m[1].split(/[ \\/]+/).filter(Boolean).slice(0, 3).map(function (v) { return Number(v) * 255; });
    throw new Error("unparsed colour " + c);
  }
  function lum(c) {
    var v = rgb(c).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function contrast(el) {
    var s = getComputedStyle(el);
    var a = lum(s.color), b = lum(s.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
`;

const THEMES: VsCodeTheme[] = ["dark", "light", "hc-dark", "hc-light"];

for (const theme of THEMES) {
  test(`${theme}: a danger confirm's button and Force push read at 4.5:1 or more`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 420, height: 640 });
    opened.push(page);
    await page.eval(`(function () {
      var s = document.createElement("style");
      s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(s);
    })()`);
    await page.send(stateMessage({ local: [{ name: "main", current: true }] }));

    await page.send({
      type: "dialog",
      dialogId: "d1",
      spec: { kind: "confirm", title: "Discard 3 files?", message: "Their unstaged edits are lost.", confirmLabel: "Discard", danger: true },
    });
    const confirm = await page.eval<number>(`(function () { ${CONTRAST}
      var b = document.querySelector(".rp-foot button.primary.danger");
      if (!b) throw new Error("no danger confirm button");
      return contrast(b);
    })()`);
    assert.ok(confirm >= 4.5, `the danger confirm reads ${confirm.toFixed(2)}:1`);

    await page.eval(`document.querySelector(".rp-foot button:not(.primary)").click()`);
    await page.send({
      type: "pushPreview",
      hasUpstream: true,
      target: "origin/main",
      branch: "main",
      base: "b".repeat(40),
      canPush: true,
      ahead: 1,
      behind: 1,
      needsForce: true,
      additions: 1,
      deletions: 0,
      commits: [{ sha: "a".repeat(40), subject: "Amended", author: "Ada", date: 1700000000 }],
      files: [],
    });
    const force = await page.eval<number>(`(function () { ${CONTRAST}
      var b = document.querySelector(".pm-btn.primary.danger");
      if (!b) throw new Error("no Force push button");
      return contrast(b);
    })()`);
    assert.ok(force >= 4.5, `Force push reads ${force.toFixed(2)}:1`);
  });
}
