// Every piece of text on the Worktrees page, scored against the colour
// actually behind it (WCAG), per theme — the list, an open row, rows busy
// with an action, and the More menu. Prints the failures; exits 1 if there
// are any.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/contrast.ts
//
// Disabled controls are exempt (WCAG 1.4.3); inherited opacity is folded in;
// a colour-mix() computes to color(srgb …) and is read as such (memory:
// measuring-contrast-and-affordance).

import { WorktreesPage, type VsCodeTheme } from "../../test/worktreesPage";
import { fixtureDetails, fixtureRows } from "../../test/worktreesFixtures";

const PROBE = `(function () {
  function parse(s) {
    if (!s || s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    var srgb = s.indexOf("color(srgb") === 0;
    var m = s.replace(/^color\\(srgb/, "").match(/[\\d.]+/g).map(Number);
    var k = srgb ? 255 : 1;
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
  }
  function over(t, u) { return { r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 }; }
  function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function ground(el) {
    var chain = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    var c = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (c.a === 0) c = { r: 255, g: 255, b: 255, a: 1 };
    for (var i = chain.length - 1; i >= 0; i--) c = over(parse(getComputedStyle(chain[i]).backgroundColor), c);
    return c;
  }
  function opacity(el) { var o = 1; for (var n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; }
  var out = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    var t = walker.currentNode;
    var text = t.textContent.trim();
    if (!text) continue;
    var el = t.parentElement;
    if (!el || el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
    if (el.closest("[aria-disabled=true], :disabled, .is-disabled")) continue;
    if (el.closest(".gs-tip")) continue;
    var cs = getComputedStyle(el);
    var bg = ground(el);
    var fg = parse(cs.color);
    fg.a = fg.a * opacity(el);
    var ink = over(fg, bg);
    var l1 = lum(ink), l2 = lum(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    var large = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && Number(cs.fontWeight) >= 700);
    var need = large ? 3 : 4.5;
    if (ratio < need) out.push(text.slice(0, 40) + " — " + ratio.toFixed(2) + ":1 (" + el.className + ")");
  }
  return out;
})()`;

(async () => {
  if (!WorktreesPage.chrome()) throw new Error("no windowless Chrome (set GS_CHROME)");
  let failures = 0;
  for (const theme of ["dark", "light", "dark-modern", "light-modern", "hc-dark", "hc-light"] as VsCodeTheme[]) {
    const page = await WorktreesPage.open(theme, { width: 320, height: 900 });
    try {
      await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: { reveal: "Reveal in Finder" } });
      await page.clickOn('.wt-row[data-path="/code/app-login"] .wt-name');
      await page.send({ type: "details", path: "/code/app-login", details: fixtureDetails() });
      await page.settle();
      const list = await page.eval<string[]>(PROBE);
      // Rows busy with an action say what they are doing.
      await page.send({ type: "busy", path: "/code/app-checkout", busy: true, label: "Removing…" });
      await page.send({ type: "busy", path: "/code/app-login", busy: true, label: "Pulling…" });
      await page.settle();
      const busy = await page.eval<string[]>(PROBE);
      await page.send({ type: "busy", path: "/code/app-checkout", busy: false });
      await page.send({ type: "busy", path: "/code/app-login", busy: false });
      await page.clickOn('.wt-row[data-path="/code/app/.claude/worktrees/agent-a2c9ae27"] .wt-more');
      await page.settle();
      const menu = await page.eval<string[]>(PROBE);
      const all = [...new Set([...list, ...busy, ...menu])];
      failures += all.length;
      console.log(`${theme}: ${all.length} below AA`);
      for (const f of all) console.log(`  ${f}`);
    } finally {
      await page.close();
    }
  }
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
