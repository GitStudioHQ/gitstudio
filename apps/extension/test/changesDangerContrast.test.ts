import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type VsCodeTheme } from "./changesPage";
import { jsLiteral } from "../../../scripts/test/js-literal.mjs";

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

// Cursor's own dark theme, as its webviews are given it: focusBorder is 15%
// white and the button label is near-black (#191c22, for its light-blue
// buttons). A dialog's primary took its fill from the one and its label from
// the other — dark on dark grey, read as a disabled "Stash" in the real Cursor
// (27 Sep 2026). Every theme here, and Cursor's, must read at AA.
/**
 * Contrast as SEEN: a fill with alpha (Cursor's focusBorder is 15% white) is
 * laid over what is behind it, and so is the label. CONTRAST above reads a
 * colour's rgb alone, so it took that 15% white for white and passed a dark
 * label on a dark button.
 */
const SEEN_CONTRAST = `
  function rgba(c) {
    var m = /^rgba?\\(([^)]+)\\)/.exec(c);
    if (m) { var p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(c);
    if (m) { var q = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return [q[0] * 255, q[1] * 255, q[2] * 255, q.length > 3 ? q[3] : 1]; }
    throw new Error("unparsed colour " + c);
  }
  function over(top, below) {
    var a = top[3];
    return [top[0] * a + below[0] * (1 - a), top[1] * a + below[1] * (1 - a), top[2] * a + below[2] * (1 - a), 1];
  }
  function lum(c) {
    var v = c.slice(0, 3).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function ground(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) {
      var b = rgba(getComputedStyle(e).backgroundColor);
      if (b[3] > 0) layers.push(b);
      if (b[3] >= 1) break;
    }
    // Nothing opaque up the tree: the view's own ground.
    var acc = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : over(rgba(getComputedStyle(document.body).backgroundColor), [0, 0, 0, 1]);
    while (layers.length) acc = over(layers.pop(), acc);
    return acc;
  }
  function seenContrast(el) {
    var bg = ground(el);
    var fg = over(rgba(getComputedStyle(el).color), bg);
    var a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
`;

for (const theme of [...THEMES, "cursor-dark"] as const) {
  test(`${theme}: a dialog's primary button reads at 4.5:1 or more, plain and danger`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 420, height: 640 });
    opened.push(page);
    await page.eval(`(function () {
      var s = document.createElement("style");
      s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(s);
    })()`);
    await page.send(stateMessage({ local: [{ name: "main", current: true }] }));
    const measure = (sel: string) =>
      page.eval<number>(`(function () { ${SEEN_CONTRAST}
        var b = document.querySelector(${jsLiteral(sel)});
        if (!b) throw new Error("no ${sel.replace(/"/g, "")}");
        return seenContrast(b);
      })()`);
    for (const danger of [false, true]) {
      await page.send({
        type: "dialog",
        dialogId: danger ? "d2" : "d1",
        spec: { kind: "confirm", title: danger ? "Discard 3 files?" : "Stash 1 file", message: "…", confirmLabel: danger ? "Discard" : "Stash", danger },
      });
      const sel = danger ? ".rp-foot button.primary.danger" : ".rp-foot button.primary:not(.danger)";
      const ratio = await measure(sel);
      assert.ok(ratio >= 4.5, `${danger ? "the danger" : "the"} primary reads ${ratio.toFixed(2)}:1`);
      // Under a real pointer too: no filter the computed colours cannot see.
      const at = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector(${jsLiteral(sel)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      await page.mouseMove(at.x, at.y + 1);
      await page.mouseMove(at.x, at.y);
      const hover = await page.eval<{ on: boolean; filter: string }>(`(function () { var b = document.querySelector(${jsLiteral(sel)}); return { on: b.matches(":hover"), filter: getComputedStyle(b).filter }; })()`);
      assert.ok(hover.on, "the pointer is on it");
      assert.equal(hover.filter, "none", `a filter would repaint what is measured (${hover.filter})`);
      const hovered = await measure(sel);
      assert.ok(hovered >= 4.5, `${danger ? "the danger" : "the"} primary under the pointer reads ${hovered.toFixed(2)}:1`);
      await page.mouseMove(2, 2);
      await page.eval(`document.querySelector(".rp-foot button:not(.primary)").click()`);
    }
  });
}
