// The Worktrees view's page, rendered for real (test/worktreesPage.ts): the
// bundle the extension ships, in a windowless Chrome, driven with real keys
// and clicks. Asserted by what a person sees — words, computed colours,
// geometry — never by a class name alone (memory: dead-css-class-names).
//
// The view is one line per worktree, as a VS Code tree draws it: the folder's
// name, its branch in quieter ink, and at most one state in words. Nothing is
// a badge or a pill; nothing hovered, open or current is drawn with a line.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { WorktreeRow } from "@gitstudio/host-bridge/worktreesProtocol";
import { WorktreesPage, type VsCodeTheme } from "./worktreesPage";
import { agentRows, fixtureDetails, fixtureRows, row } from "./worktreesFixtures";

const skip = WorktreesPage.chrome() ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const LABELS = { reveal: "Reveal in Finder" };
// Light Modern and Dark Modern are what a fresh install picks; Light Modern's
// descriptionForeground IS its foreground, which a view drawn only in Dark+
// and Light+ never meets.
const THEMES: VsCodeTheme[] = ["dark", "light", "dark-modern", "light-modern", "hc-dark", "hc-light"];
const opened: WorktreesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

async function open(theme: VsCodeTheme = "dark", width = 300, height = 700): Promise<WorktreesPage> {
  const page = await WorktreesPage.open(theme, { width, height });
  opened.push(page);
  await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: LABELS });
  // The page tells the host which rows are in view once they are laid out
  // (a debounced post): let that land before a test clears what was posted.
  await page.page.waitFor(`window.__posted.some(function (m) { return m.type === "visible"; })`);
  await page.settle();
  return page;
}

/**
 * What the page asked the host for — without its "rows in view" reports,
 * which follow any layout change (a row opening moves the rest) on a
 * debounce of their own, and are pinned by their own test.
 */
async function asked(page: WorktreesPage): Promise<Record<string, unknown>[]> {
  return (await page.posted()).filter((m) => m.type !== "visible");
}

const LOGIN = "/code/app-login";
const AGENT = "/code/app/.claude/worktrees/agent-a2c9ae27";
const UNLINKED = "/code/app/.claude/worktrees/agent-7f3e";

/** Colour maths for the page: parse (rgb() or color(srgb …)), composite, luminance, contrast. */
const COLOUR = `
  function rgb(s) {
    if (!s || s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    var m = s.replace(/^color\\(srgb/, "").match(/[\\d.]+/g).map(Number);
    var k = s.indexOf("color(srgb") === 0 ? 255 : 1;
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
  }
  function over(top, under) { return { r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 }; }
  function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function ground(el) {
    var chain = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    var bg = rgb(getComputedStyle(document.body).backgroundColor);
    for (var i = chain.length - 1; i >= 0; i--) bg = over(rgb(getComputedStyle(chain[i]).backgroundColor), bg);
    return bg;
  }
  function contrast(el) {
    var bg = ground(el);
    var fg = rgb(getComputedStyle(el).color);
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) fg.a *= Number(getComputedStyle(n).opacity);
    var ink = over(fg, bg);
    var l1 = lum(ink), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function seen(el) { return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; }
  // Its text runs past its box by any fraction of a pixel — text-overflow
  // draws its ellipsis for 0.4px too, which scrollWidth's whole pixels miss.
  function textOver(el) { var r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01; }
`;

interface Line {
  name: string;
  head: string;
  state: string;
  /** Every word the row shows, in order — what a person reads on it. */
  words: string[];
  expanded: string | null;
  tip: string;
  height: number;
}

/** A row's line, by folder, as a person reads it. */
function lineOf(page: WorktreesPage, path: string): Promise<Line | null> {
  return page.eval<Line | null>(`(function () {
    ${COLOUR}
    var l = document.querySelector('.wt-row[data-path="${path}"]');
    if (!l) return null;
    var head = l.querySelector(".wt-head");
    var state = l.querySelector(".wt-state");
    var words = [];
    var w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      var t = w.currentNode.textContent.trim();
      if (t && seen(w.currentNode.parentElement)) words.push(t);
    }
    return {
      name: l.querySelector(".wt-name").textContent,
      head: seen(head) ? head.textContent : "",
      state: seen(state) ? state.textContent : "",
      words: words,
      expanded: l.getAttribute("aria-expanded"),
      tip: l.dataset.tip || "",
      height: l.getBoundingClientRect().height,
    };
  })()`);
}

test("one row per worktree, two lines as a stash's: its folder, then its branch and at most one state in words — no badges, no pills, nothing said twice", { skip }, async () => {
  const page = await open();
  assert.deepEqual(await lineOf(page, LOGIN), {
    name: "app-login",
    head: "feature/login",
    state: "5 changed",
    words: ["app-login", "feature/login", "5 changed"],
    expanded: "false",
    tip: [
      "~/code/app-login",
      "Current — open in this window.",
      "5 uncommitted changes: 2 staged, 2 unstaged, 1 untracked.",
      "2 commits not pushed to origin/feature/login.",
    ].join("\n"),
    height: 38,
  });
  const main = (await lineOf(page, "/code/app"))!;
  assert.deepEqual(main.words, ["app", "main", "3 to pull"], "the main worktree is not labelled on the row");
  assert.match(main.tip, /^~\/code\/app\nMain worktree — the repository's own folder\.\n3 commits on origin\/main not pulled yet\.$/);
  const states = Object.fromEntries(
    await Promise.all(fixtureRows().map(async (r) => [r.name, (await lineOf(page, r.path))!.state] as const)),
  );
  assert.deepEqual(states, {
    app: "3 to pull",
    "app-login": "5 changed",
    "app-checkout": "diverged",
    "agent-a2c9ae27": "3 changed",
    "app-merge": "merge in progress",
    "app-spike": "3 unpublished",
    "app-v2": "",
    "app-hotfix": "upstream gone",
    "app-usb": "folder missing",
    "agent-7f3e": "not a worktree",
    "app-old": "folder missing",
  });
  assert.equal((await lineOf(page, "/code/app-v2"))?.head, "detached at 4f2a9c1");
  assert.equal((await lineOf(page, "/code/app-usb"))?.expanded, null, "a missing folder does not open");
  assert.match((await lineOf(page, "/code/app-usb"))!.tip, /Locked: “on a USB drive”/, "its lock is in the tooltip");
  assert.deepEqual((await lineOf(page, UNLINKED))?.words, ["agent-7f3e", "worktree-agent-7f3e", "not a worktree"]);
  // A tooltip names the folder once — its first line — and no fact says it again.
  for (const r of fixtureRows()) {
    const tip = (await lineOf(page, r.path))!.tip.split("\n");
    assert.deepEqual(tip.filter((l) => l.includes(r.shownPath)), [r.shownPath], `${r.name}: its folder, said once`);
  }

  // Every row: two lines — the name, then the branch and the state on one
  // line under it — 38px, nothing with an edge or a fill of its own at rest.
  const shape = await page.eval<{ heights: number[]; lines: string[]; edges: string[] }>(`(function () {
    ${COLOUR}
    var out = { heights: [], lines: [], edges: [] };
    document.querySelectorAll(".wt-row").forEach(function (l) {
      out.heights.push(l.getBoundingClientRect().height);
      var mid = function (n) { var r = n.getBoundingClientRect(); return r.top + r.height / 2; };
      var name = mid(l.querySelector(".wt-name"));
      var second = null;
      l.querySelectorAll(".wt-head, .wt-state").forEach(function (n) {
        if (!seen(n) || !n.textContent) return;
        var c = mid(n);
        if (c < name + 8) out.lines.push(l.dataset.path + ": " + n.className + " is on the name's line");
        if (second === null) second = c;
        else if (Math.abs(c - second) > 2) out.lines.push(l.dataset.path + ": " + n.className + " is on a third line");
      });
      l.querySelectorAll("*").forEach(function (n) {
        if (!seen(n)) return;
        var cs = getComputedStyle(n);
        var edge = ["Top", "Right", "Bottom", "Left"].some(function (s) { return parseFloat(cs["border" + s + "Width"]) > 0 && rgb(cs["border" + s + "Color"]).a > 0; });
        if (edge) out.edges.push(l.dataset.path + ": " + n.className + " has an edge");
        if (rgb(cs.backgroundColor).a > 0) out.edges.push(l.dataset.path + ": " + n.className + " has a fill");
      });
    });
    return out;
  })()`);
  assert.ok(shape.heights.every((h) => h === 38), `every row 38px, a stash row's two lines: ${shape.heights.join(",")}`);
  assert.deepEqual(shape.lines, []);
  assert.deepEqual(shape.edges, [], "no badge, no pill");

  // This window's worktree is its bold name — no label for it.
  const weights = await page.eval<Record<string, string>>(`(function () { var o = {}; document.querySelectorAll(".wt-row").forEach(function (l) { o[l.dataset.path] = getComputedStyle(l.querySelector(".wt-name")).fontWeight; }); return o; })()`);
  assert.equal(weights[LOGIN], "600");
  assert.ok(Object.entries(weights).every(([p, w]) => p === LOGIN || w === "400"), JSON.stringify(weights));

  // This window's first, then the main worktree, the missing last.
  const order = await page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) { return l.dataset.path; })`);
  assert.deepEqual(order.slice(0, 2), [LOGIN, "/code/app"]);
  assert.deepEqual(order.slice(-2), ["/code/app-old", "/code/app-usb"]);
  assert.deepEqual(page.errors(), []);
});

/** How much louder the name must read than what describes it — "quieter", not
 *  "never fainter": a VS Code tree draws its description at opacity .7. */
const QUIETER = 1.25;

test("every word on a row reads at AA, at rest and hovered, in every theme — and what describes a worktree reads clearly quieter than its name", { skip }, async () => {
  for (const theme of THEMES) {
    const page = await open(theme);
    const probe = () =>
      page.eval<{ text: string; ratio: number }[]>(`(function () {
        ${COLOUR}
        var out = [];
        document.querySelectorAll(".wt-row .wt-name, .wt-row .wt-head, .wt-row .wt-state, .wt-prune").forEach(function (n) {
          if (seen(n) && n.textContent) out.push({ text: n.textContent, ratio: contrast(n) });
        });
        return out;
      })()`);
    for (const r of await probe()) assert.ok(r.ratio >= 4.5, `${theme}: "${r.text}" reads at ${r.ratio.toFixed(2)}:1`);
    // Hovered: the row's fill is under its words.
    for (const path of ["/code/app-checkout", "/code/app-merge", "/code/app-old"]) {
      const at = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector('.wt-row[data-path="${path}"] .wt-name').getBoundingClientRect(); return { x: b.left + 4, y: b.top + b.height / 2 }; })()`);
      await page.mouseMove(at.x, at.y);
      const hovered = await page.eval<{ text: string; ratio: number }[]>(`(function () {
        ${COLOUR}
        var l = document.querySelector('.wt-row[data-path="${path}"]');
        return Array.prototype.filter.call(l.querySelectorAll(".wt-name, .wt-head"), seen).map(function (n) { return { text: n.textContent, ratio: contrast(n) }; });
      })()`);
      for (const r of hovered) assert.ok(r.ratio >= 4.5, `${theme}, hovered: "${r.text}" reads at ${r.ratio.toFixed(2)}:1`);
    }
    await page.mouseMove(1, 1);
    // The folder's name is the row's first word. Its branch, and its state
    // when that is routine, read clearly quieter — in every theme, Light
    // Modern too, where the theme's own "description" ink is its foreground.
    const pairs = await page.eval<{ path: string; name: number; head: number | null; state: number | null; tone: string }[]>(`(function () {
      ${COLOUR}
      return Array.prototype.map.call(document.querySelectorAll(".wt-row:not(.is-missing)"), function (l) {
        var h = l.querySelector(".wt-head"), st = l.querySelector(".wt-state");
        return {
          path: l.dataset.path,
          name: contrast(l.querySelector(".wt-name")),
          head: seen(h) ? contrast(h) : null,
          state: seen(st) && st.textContent ? contrast(st) : null,
          tone: st ? st.dataset.tone || "" : "",
        };
      });
    })()`);
    assert.ok(pairs.filter((p) => p.head !== null).length >= 7, `${theme}: rows with a branch (${pairs.length})`);
    for (const p of pairs) {
      if (p.head !== null) assert.ok(p.name >= p.head * QUIETER, `${theme}: ${p.path}'s branch (${p.head.toFixed(2)}:1) is not quieter than its name (${p.name.toFixed(2)}:1)`);
      if (p.state !== null && p.tone === "muted") assert.ok(p.name >= p.state * QUIETER, `${theme}: ${p.path}'s state (${p.state.toFixed(2)}:1) is not quieter than its name (${p.name.toFixed(2)}:1)`);
    }
    // A folder that is gone: its name is quieter than a live one's.
    const names = await page.eval<{ live: number; gone: number }>(`(function () {
      ${COLOUR}
      return {
        live: contrast(document.querySelector('.wt-row[data-path="/code/app-checkout"] .wt-name')),
        gone: contrast(document.querySelector('.wt-row[data-path="/code/app-old"] .wt-name')),
      };
    })()`);
    assert.ok(names.live >= names.gone * QUIETER, `${theme}: a missing folder's name (${names.gone.toFixed(2)}:1) reads as loud as a live one (${names.live.toFixed(2)}:1)`);
    // Something stopped halfway, or gone, stands apart from "3 to pull" by
    // what a person sees — a hue, or (High Contrast, where there are none)
    // the full ink at a heavier weight — never by a colour string alone
    // (color-mix computes to color(srgb …), which never equals an rgb()).
    const tones = await page.eval<Record<string, { rgb: number[]; weight: number; ratio: number }>>(`(function () {
      ${COLOUR}
      var o = {};
      document.querySelectorAll(".wt-state").forEach(function (s) {
        if (!s.textContent) return;
        var c = rgb(getComputedStyle(s).color);
        o[s.textContent] = { rgb: [c.r, c.g, c.b], weight: Number(getComputedStyle(s).fontWeight), ratio: contrast(s) };
      });
      return o;
    })()`);
    const attention = tones["merge in progress"];
    const quiet = tones["3 to pull"];
    const hue = (c: number[]) => Math.max(...c) - Math.min(...c);
    const apart = Math.abs(hue(attention.rgb) - hue(quiet.rgb)) >= 40 || attention.weight - quiet.weight >= 200;
    assert.ok(apart, `${theme}: "merge in progress" (rgb ${attention.rgb.map(Math.round)} ${attention.weight}) looks like "3 to pull" (rgb ${quiet.rgb.map(Math.round)} ${quiet.weight})`);
    if (theme.startsWith("hc")) assert.ok(attention.ratio >= quiet.ratio - 0.01, `${theme}: …never fainter (${attention.ratio.toFixed(2)} vs ${quiet.ratio.toFixed(2)})`);
  }
});

test("hovered, a row shows at most two buttons — Open in New Window and More — over its state, and nothing before them moves", { skip }, async () => {
  const page = await open("dark", 320);
  const buttons = (path: string) =>
    page.eval<{ shown: string[]; state: boolean; rects: string }>(`(function () {
      ${COLOUR}
      var l = document.querySelector('.wt-row[data-path="${path}"]');
      var rect = function (n) { if (!seen(n)) return "-"; var b = n.getBoundingClientRect(); return [b.left, b.top, b.width].map(Math.round).join(","); };
      return {
        shown: Array.prototype.filter.call(l.querySelectorAll("button"), seen).map(function (b) { return b.getAttribute("aria-label"); }),
        state: seen(l.querySelector(".wt-state")) && !!l.querySelector(".wt-state").textContent,
        rects: rect(l.querySelector(".wt-name")) + " " + rect(l.querySelector(".wt-head")),
      };
    })()`);
  const hover = async (path: string) => {
    const at = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector('.wt-row[data-path="${path}"]').getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
    await page.mouseMove(at.x, at.y);
  };
  await page.mouseMove(1, 1);
  // At rest: no buttons at all, anywhere — the states are there.
  const rest = await page.eval<number>(`(function () { ${COLOUR} return Array.prototype.filter.call(document.querySelectorAll(".wt-row button"), seen).length; })()`);
  assert.equal(rest, 0, "no button shows on a row at rest");
  const before = await buttons("/code/app-checkout");
  assert.equal(before.state, true);
  await hover("/code/app-checkout");
  const hovered = await buttons("/code/app-checkout");
  assert.deepEqual(hovered.shown, ["Open in New Window", "More actions for app-checkout"]);
  // Over the row's end, on the hover's fill: they take no room at rest, and
  // nothing before them moves when they come.
  assert.equal(hovered.rects, before.rects, "the name and the branch do not move");
  // This window's own: no Open — only More. A folder that is gone: only More.
  await hover(LOGIN);
  assert.deepEqual((await buttons(LOGIN)).shown, ["More actions for app-login"]);
  await hover("/code/app-old");
  assert.deepEqual((await buttons("/code/app-old")).shown, ["More actions for app-old"]);
  // Its More menu open, the row keeps its buttons and its fill with the pointer gone.
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
  await page.mouseMove(1, 1);
  assert.deepEqual((await buttons("/code/app-checkout")).shown, ["Open in New Window", "More actions for app-checkout"]);
  await page.key("Escape");
  assert.deepEqual((await buttons("/code/app-checkout")).shown, []);
});

/**
 * Every line an element draws — itself, its ::before and ::after, and
 * everything inside it: an outline (a keyboard focus ring aside: that is
 * accessibility, not a mark), a painted border side, any box-shadow, an
 * underline or overline, a gradient (a stripe is one), a child 4px or less
 * across painted as a bar, and a pseudo-element that paints a fill, a border,
 * a shadow or an outline (a codicon's ::before is a glyph and paints none).
 */
const LINES = `
  function paints(c) { return rgb(c).a > 0.04; }
  function sidesOf(cs) {
    return ["Top", "Right", "Bottom", "Left"].filter(function (s) {
      return parseFloat(cs["border" + s + "Width"]) > 0 && !/none|hidden/.test(cs["border" + s + "Style"]) && paints(cs["border" + s + "Color"]);
    }).map(function (s) { return s.toLowerCase(); });
  }
  function pseudoDrawn(p) {
    return !!p.content && p.content !== "none" && p.content !== "normal" && p.display !== "none" && p.visibility !== "hidden" && parseFloat(p.opacity) > 0.04;
  }
  function linesOf(root) {
    var out = [];
    [root].concat(Array.prototype.slice.call(root.querySelectorAll("*"))).forEach(function (e) {
      if (!seen(e)) return;
      var cs = getComputedStyle(e);
      var name = e === root ? "it" : (typeof e.className === "string" && e.className ? e.className : e.tagName.toLowerCase());
      if (!e.matches(":focus-visible") && cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && paints(cs.outlineColor)) out.push(name + ": an outline");
      sidesOf(cs).forEach(function (s) { out.push(name + ": a " + s + " border"); });
      if (cs.boxShadow !== "none") out.push(name + ": box-shadow " + cs.boxShadow);
      if (cs.textDecorationLine !== "none") out.push(name + ": " + cs.textDecorationLine);
      if (/gradient\\(/.test(cs.backgroundImage)) out.push(name + ": a gradient");
      var r = e.getBoundingClientRect();
      if (e !== root && ((r.width <= 4 && r.height >= 6) || (r.height <= 4 && r.width >= 6)) && paints(cs.backgroundColor)) out.push(name + ": a bar " + Math.round(r.width) + "x" + Math.round(r.height));
      ["::before", "::after"].forEach(function (pe) {
        var p = getComputedStyle(e, pe);
        if (!pseudoDrawn(p)) return;
        if (paints(p.backgroundColor) || /gradient\\(/.test(p.backgroundImage) || sidesOf(p).length || p.boxShadow !== "none" || (p.outlineStyle !== "none" && parseFloat(p.outlineWidth) > 0 && paints(p.outlineColor))) {
          out.push(name + pe + ": draws " + p.width + " x " + p.height);
        }
      });
    });
    return out;
  }
`;

/** What an element draws as a line (LINES), and whether it is filled. */
function linesAt(page: WorktreesPage, sel: string): Promise<{ lines: string[]; fill: boolean }> {
  return page.eval<{ lines: string[]; fill: boolean }>(`(function () {
    ${COLOUR}${LINES}
    var n = document.querySelector(${JSON.stringify(sel)});
    if (!n) return { lines: ["nothing matches ${sel.replace(/"/g, "'")}"], fill: false };
    return { lines: linesOf(n), fill: rgb(getComputedStyle(n).backgroundColor).a > 0 };
  })()`);
}

test("nothing hovered, open, current or with its menu open is drawn with a line — a tinted fill, in every theme", { skip }, async () => {
  for (const theme of THEMES) {
    const page = await open(theme, 320, 900);
    await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
    await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
    await page.settle();
    const hoverOn = async (sel: string) => {
      const at = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + 12, y: b.top + b.height / 2 }; })()`);
      await page.mouseMove(at.x, at.y);
    };
    for (const sel of [
      `.wt-row[data-path="/code/app-checkout"]`,
      `.wt-row[data-path="${LOGIN}"]`,
      `.wt-item[data-path="${LOGIN}"] .cr-file[data-path="src/auth/form.tsx"]`,
      `.wt-item[data-path="${LOGIN}"] .cr-commit`,
      `.wt-prune`,
    ]) {
      await hoverOn(sel);
      const got = await linesAt(page, sel);
      assert.deepEqual(got.lines, [], `${theme}: ${sel} hovered`);
      assert.equal(got.fill, true, `${theme}: ${sel} hovered is a fill`);
    }
    // Its More menu open and the pointer gone: the row keeps its fill — and nothing else.
    await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
    await page.mouseMove(1, 1);
    const withMenu = await linesAt(page, `.wt-row.has-menu`);
    assert.deepEqual(withMenu.lines, [], `${theme}: the row whose menu is open`);
    assert.equal(withMenu.fill, true, `${theme}: the row whose menu is open is a fill`);
    await hoverOn(".wt-menu-item:nth-of-type(2)");
    const item = await linesAt(page, ".wt-menu-item:nth-of-type(2)");
    assert.deepEqual(item.lines, [], `${theme}: a menu item hovered`);
    assert.equal(item.fill, true, `${theme}: a menu item hovered is a fill`);
    await page.key("Escape");
    await page.mouseMove(1, 1);
    // At rest: the open, current worktree — its row AND what it opened to —
    // and the whole list, are drawn apart by no line either.
    assert.deepEqual((await linesAt(page, `.wt-item[data-path="${LOGIN}"]`)).lines, [], `${theme}: the open, current worktree at rest`);
    assert.deepEqual((await linesAt(page, `.wt-list`)).lines, [], `${theme}: the list at rest`);
  }
});

test("the line probe sees every way a line can be drawn — so its passing means there is none", { skip }, async () => {
  const page = await open("dark", 320, 900);
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
  const ITEM = `.wt-item[data-path="${LOGIN}"]`;
  const shapes: [string, string, string][] = [
    ["a ::before strip down this window's row", `.wt-row.is-current{position:relative}.wt-row.is-current::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:2px;background:var(--gs-accent)}`, ITEM],
    ["an inset bar on the row whose menu is open", `.wt-row.has-menu{box-shadow:inset 2px 0 0 var(--gs-accent)}`, ".wt-row.has-menu"],
    ["a side border on an open row's details", `.wt-item.open > .wt-details{border-left:1px solid var(--gs-accent)}`, ITEM],
    ["an underline under this window's name", `.wt-row.is-current .wt-name{text-decoration:underline}`, ITEM],
    ["a hard-stop stripe", `.wt-row.has-menu{background-image:linear-gradient(90deg,var(--gs-accent) 0 2px,transparent 2px)}`, ".wt-row.has-menu"],
    ["a thin child as a bar", `.wt-row.is-current .wt-chevron{flex:0 0 3px;width:3px;overflow:hidden;background:var(--gs-accent)}`, ITEM],
    ["an outline round an open row", `.wt-item.open{outline:1px solid var(--gs-accent)}`, ITEM],
    ["an ::after rule under an open row", `.wt-item.open > .wt-row{position:relative}.wt-item.open > .wt-row::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--gs-accent)}`, ITEM],
    ["a top rule by shadow", `.wt-item.open > .wt-row{box-shadow:0 -1px 0 var(--gs-accent)}`, ITEM],
  ];
  for (const target of new Set(shapes.map(([, , t]) => t))) assert.deepEqual((await linesAt(page, target)).lines, [], `${target}: nothing drawn before a shape is added`);
  for (const [what, css, target] of shapes) {
    await page.eval(`(function () { var st = document.createElement("style"); st.id = "shape"; st.textContent = ${JSON.stringify(css)}; document.head.appendChild(st); })()`);
    const got = await linesAt(page, target);
    await page.eval(`document.getElementById("shape").remove()`);
    assert.ok(got.lines.length > 0, `the probe misses ${what}`);
  }
});

test("no tooltip says only what is written: a label the eye can read is not said again on hover", { skip }, async () => {
  const page = await open("dark", 320, 900);
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  const echoes = await page.eval<string[]>(`Array.prototype.filter.call(document.querySelectorAll(".wt-view [data-tip]"), function (n) {
    return n.dataset.tip.trim() === n.textContent.trim();
  }).map(function (n) { return n.className + ": " + n.dataset.tip; })`);
  assert.deepEqual(echoes, []);
});

test("a status landing later does not move the row: its height is the same before and after", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 300, height: 600 });
  opened.push(page);
  const rows = fixtureRows().map((r) => ({ ...r, status: undefined }));
  await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
  await page.settle();
  const heights = () =>
    page.eval<number[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) { return l.getBoundingClientRect().height; })`);
  const before = await heights();
  for (const r of fixtureRows()) if (r.status) await page.send({ type: "status", path: r.path, status: r.status });
  await page.settle();
  assert.deepEqual(await heights(), before);
  assert.ok(before.every((h) => h === before[0]), `every row one height: ${before.join(",")}`);
});

// The owner, looking at the minimal view: "you don't know what those 2 icons
// mean, one is on branch and one is not" — and the earlier view's look,
// simplified — then "instead of folder, a proper worktree icon". One
// worktree icon (a folder with a branch badge) for every worktree; its branch after git's
// branch symbol; an open worktree's Pull and Push… back, only where there
// is something to move — never greyed out — and legible in every theme.
test("one worktree icon for every worktree, its branch after the branch symbol, and an open one's Pull and Push… only where there is something to move", { skip }, async () => {
  const want: Record<string, string[]> = {
    "/code/app": ["Pull"], // 3 to pull
    [LOGIN]: ["Push…"], // 2 to push
    "/code/app-checkout": ["Pull", "Push…"], // diverged
    "/code/app/.claude/worktrees/agent-a2c9ae27": ["Push…"], // 4 unpublished, no upstream
    "/code/app-merge": [], // a merge in progress: neither runs
    "/code/app-v2": [], // detached: no branch to move
    "/code/app-hotfix": [], // nothing either way
  };
  for (const theme of THEMES) {
    const page = await open(theme, 360, 900);
    const rows = await page.eval<{ icon: string; glyph: string | null; branch: string | null }[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) {
      var g = l.querySelector(".wt-head .codicon"), t = l.querySelector(".wt-head-text");
      var i = l.querySelector(".wt-icon > *");
      return { icon: i ? i.getAttribute("data-icon") || i.getAttribute("class") : "none", glyph: g ? g.className : null, branch: t ? t.textContent : null };
    })`);
    assert.ok(rows.length > 5 && rows.every((r) => r.icon === "codicon codicon-worktree"), `${theme}: every worktree codicons' own worktree: ${JSON.stringify(rows.map((r) => r.icon))}`);
    for (const r of rows.filter((x) => x.branch)) {
      assert.equal(r.glyph, /^detached/.test(r.branch!) ? "codicon codicon-git-commit" : "codicon codicon-git-branch", `${theme}: ${r.branch} wears its symbol`);
    }
    for (const [path, verbs] of Object.entries(want)) {
      await page.clickOn(`.wt-row[data-path="${path}"] .wt-name`);
      await page.send({ type: "details", path, details: fixtureDetails() });
      await page.settle(40);
      const got = await page.eval<{ text: string; off: boolean; ratio: number; role: string | null }[]>(`(function () { ${COLOUR}
        return Array.prototype.map.call(document.querySelectorAll('.wt-item[data-path="${path}"] .wt-verb'), function (b) {
          return { text: b.textContent, off: b.disabled || b.getAttribute("aria-disabled") === "true", ratio: contrast(b), role: b.getAttribute("role") };
        });
      })()`);
      assert.deepEqual(got.map((v) => v.text), verbs, `${theme}: ${path}`);
      for (const v of got) {
        assert.equal(v.off, false, `${theme}: ${path}: ${v.text} is never greyed out`);
        assert.equal(v.role, "treeitem", `${theme}: ${path}: ${v.text} is an item of the row's group`);
        assert.ok(v.ratio >= 4.5, `${theme}: ${path}: "${v.text}" reads ${v.ratio.toFixed(2)}:1`);
      }
      await page.clickOn(`.wt-row[data-path="${path}"] .wt-name`);
    }
    // ↓ reaches Push… and Enter presses it.
    await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
    await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
    await page.settle(40);
    await page.eval(`document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-verb').focus()`);
    await page.clearPosted();
    await page.key("Enter");
    assert.deepEqual(await asked(page), [{ type: "action", path: LOGIN, action: "push" }], `${theme}: Enter presses Push…`);
  }
});

/** An open row's details, as a person reads them. */
function detailsOf(page: WorktreesPage, path: string) {
  return page.eval<{ labels: string[]; counts: string[]; verbs: string[]; files: string[]; commits: string[]; quiet: string[]; tags: number; buttons: number; text: string }>(`(function () {
    ${COLOUR}
    var d = document.querySelector('.wt-item[data-path="${path}"] .wt-details');
    return {
      labels: Array.prototype.map.call(d.querySelectorAll(".cr-section-label .cr-section-text"), function (n) { return n.textContent; }),
      counts: Array.prototype.map.call(d.querySelectorAll(".cr-section-label"), function (n) { var c = n.querySelector(".cr-section-count"); return c ? c.textContent : ""; }),
      verbs: Array.prototype.map.call(d.querySelectorAll(".wt-verb"), function (b) { return b.textContent + (b.disabled || b.getAttribute("aria-disabled") === "true" ? " (disabled)" : ""); }),
      files: Array.prototype.map.call(d.querySelectorAll(":scope > .cr-file"), function (n) { return n.querySelector(".cr-st").textContent + " " + n.querySelector(".cr-name").textContent; }),
      commits: Array.prototype.map.call(d.querySelectorAll(".cr-commit .cr-subj"), function (n) { return n.textContent; }),
      quiet: Array.prototype.map.call(d.querySelectorAll(":scope > .cr-empty, :scope > .cr-loading, :scope > .cr-more"), function (n) { return n.textContent; }),
      tags: Array.prototype.filter.call(d.querySelectorAll(".cr-tag"), seen).length,
      buttons: d.querySelectorAll("button").length,
      text: d.textContent,
    };
  })()`);
}

test("click opens a row: it asks the host for its details, shows Loading…, then its files and commits — grouped and counted, no tags, and only the verbs that have something to do", { skip }, async () => {
  const page = await open();
  await page.clearPosted();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  assert.deepEqual(await asked(page), [{ type: "expand", path: LOGIN }]);
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  const loading = await page.eval<string>(`document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-details').textContent`);
  assert.equal(loading, "Loading…");
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  const shown = await detailsOf(page, LOGIN);
  assert.deepEqual(shown.labels, ["Staged changes", "Changes", "Not pushed to origin/feature/login"]);
  assert.deepEqual(shown.counts, ["2", "3", "2"], "each caption counts what is under it");
  assert.deepEqual(shown.files, ["M login.ts", "A session.ts", "M form.tsx", "D oldLogin.ts", "U login-flow.md"]);
  assert.equal(shown.tags, 0, "the group says staged: no file wears a tag");
  assert.deepEqual(shown.commits, ["Remember the session across restarts", "Validate the login form before sending"]);
  // The owner: the earlier view's look, simplified. Its Pull and Push… come
  // back — only where there is something to move, and never disabled: two
  // commits to push, nothing to pull.
  assert.deepEqual(shown.verbs, ["Push…"], "Push… for its two unpushed commits; no Pull with nothing to pull; nothing greyed out");
  assert.equal(shown.buttons, 1, "no other button in the group");
  assert.doesNotMatch(shown.text, /No remote|No upstream|origin\/feature\/login$/);

  // A file opens its diff in that worktree: the host is handed the file, side and all.
  await page.clearPosted();
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-file[data-path="src/auth/login.ts"]`);
  assert.deepEqual(await asked(page), [{ type: "openFile", path: LOGIN, file: { path: "src/auth/login.ts", status: "M", area: "staged" } }]);

  // A commit opens to its files; a file under it opens what that commit did.
  const sha = fixtureDetails().unpushed!.commits[0].sha;
  await page.clearPosted();
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit-item[data-sha="${sha}"] .cr-commit`);
  assert.deepEqual(await asked(page), [{ type: "commitFiles", path: LOGIN, sha }]);
  await page.send({ type: "commitFiles", path: LOGIN, sha, files: [{ path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 }] });
  await page.clearPosted();
  await page.clickOn(`.cr-commit-item[data-sha="${sha}"] .cr-file`);
  const [msg] = await asked(page);
  assert.deepEqual(msg, {
    type: "openCommitFile",
    path: LOGIN,
    sha,
    parent: "4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    file: { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
  });
  const nums = await page.eval<string>(`document.querySelector('.cr-commit-item[data-sha="${sha}"] .cr-nums').textContent`);
  assert.equal(nums, "+24−3");
});

test("an open row shows only what it has: never an empty list, never a '0', one quiet line when there is nothing", { skip }, async () => {
  const page = await open("dark", 320, 900);
  const d = fixtureDetails();
  const commits = d.unpushed!.commits;
  const cases: [string, typeof d, { labels: string[]; quiet: string[] }][] = [
    ["nothing at all", { files: [], filesTotal: 0, unpushed: { title: "Not pushed to origin/x", commits: [], more: false } }, { labels: [], quiet: ["Nothing to commit or push."] }],
    ["nothing, no rule for 'not pushed'", { files: [], filesTotal: 0 }, { labels: [], quiet: ["Nothing to commit or push."] }],
    ["files only", { ...d, unpushed: { ...d.unpushed!, commits: [] } }, { labels: ["Staged changes", "Changes"], quiet: [] }],
    ["unstaged only", { files: [{ path: "a.ts", status: "M", area: "unstaged" }], filesTotal: 1 }, { labels: ["Changes"], quiet: [] }],
    ["a conflict", { files: [{ path: "a.ts", status: "!", area: "conflicted" }, { path: "b.ts", status: "M", area: "staged" }], filesTotal: 2 }, { labels: ["Conflicts", "Staged changes"], quiet: [] }],
    ["commits only", { files: [], filesTotal: 0, unpushed: d.unpushed }, { labels: ["Not pushed to origin/feature/login"], quiet: [] }],
    ["only to pull", { files: [], filesTotal: 0, unpushed: { title: "Not pushed to origin/main", commits: [], more: false }, toPull: { title: "To pull from origin/main", commits, more: true } }, { labels: ["To pull from origin/main"], quiet: ["and more — the Commit Graph shows them all"] }],
    ["files it couldn't read", { files: [], filesTotal: 0, filesUnread: true, unpushed: { title: "Not on any remote", commits: [], more: false } }, { labels: [], quiet: ["Couldn't read its uncommitted changes."] }],
    ["more files than it lists", { files: d.files.slice(0, 2), filesTotal: 12 }, { labels: ["Staged changes"], quiet: ["and 10 more"] }],
  ];
  await page.clickOn(`.wt-row[data-path="/code/app-spike"] .wt-name`);
  for (const [what, details, want] of cases) {
    await page.send({ type: "details", path: "/code/app-spike", details });
    const got = await detailsOf(page, "/code/app-spike");
    assert.deepEqual({ labels: got.labels, quiet: got.quiet }, want, what);
    assert.doesNotMatch(got.text, /(^|\D)0(\D|$)/, `${what}: never a 0`);
  }
});

test("what couldn't be read says so: a commit's files, a worktree's uncommitted changes — never 'No … changes'", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: { ...fixtureDetails(), files: [], filesTotal: 0, filesUnread: true } });
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit`);
  const sha = fixtureDetails().unpushed!.commits[0].sha;
  await page.send({ type: "commitFiles", path: LOGIN, sha, files: null });
  const said = await page.eval<{ uncommitted: string; label: string; commit: string }>(`(function () {
    var d = document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-details');
    return {
      uncommitted: d.querySelector(".cr-empty").textContent,
      label: d.querySelector(".cr-section-label .cr-section-text").textContent,
      commit: d.querySelector('.cr-commit-item[data-sha="${sha}"] .cr-commit-files').textContent,
    };
  })()`);
  assert.deepEqual(said, { uncommitted: "Couldn't read its uncommitted changes.", label: "Not pushed to origin/feature/login", commit: "Couldn't read this commit's files." });
});

test("clicking a commit or a file opens it without putting a text caret in it — a caret in a clipped subject drops its ellipsis and cuts a letter", { skip }, async () => {
  const page = await open("dark", 320, 900);
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  // A subject too long for the row: its ellipsis must survive the click that opens it.
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit .cr-subj`);
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-file .cr-name`);
  const after = await page.eval<{ caretIn: string; select: string[] }>(`(function () {
    var sel = window.getSelection();
    var n = sel && sel.rangeCount ? sel.anchorNode : null;
    var el = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
    return {
      caretIn: el && el.closest(".cr-commit, .cr-file") ? el.closest(".cr-commit, .cr-file").className : "",
      select: [getComputedStyle(document.querySelector(".cr-commit")).userSelect, getComputedStyle(document.querySelector(".cr-file")).userSelect],
    };
  })()`);
  assert.deepEqual(after, { caretIn: "", select: ["none", "none"] });
});

test("the keyboard walks one tree: ↓ ↑ between rows and into an open one, → opens, ← closes and climbs, Enter toggles", { skip }, async () => {
  const page = await open();
  await page.eval(`document.querySelector('.wt-row').focus()`);
  const focused = () =>
    page.eval<string>(`(function () { var a = document.activeElement; if (!a) return ""; return (a.dataset.path || "") + "|" + (a.classList.contains("wt-row") ? "row" : a.className.split(" ")[0]); })()`);
  assert.equal(await focused(), `${LOGIN}|row`);
  await page.key("ArrowDown");
  assert.equal(await focused(), "/code/app|row");
  await page.key("ArrowUp");
  await page.clearPosted();
  await page.key("ArrowRight");
  assert.deepEqual(await asked(page), [{ type: "expand", path: LOGIN }]);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.key("ArrowRight"); // open → into its first item: its first file
  assert.equal(await focused(), "src/auth/login.ts|cr-file");
  await page.key("ArrowDown");
  assert.equal(await focused(), "src/auth/session.ts|cr-file");
  await page.key("ArrowDown");
  assert.equal(await focused(), "src/auth/form.tsx|cr-file", "over the group's label, not onto it");
  await page.key("ArrowLeft"); // climbs to the row
  assert.equal(await focused(), `${LOGIN}|row`);
  await page.clearPosted();
  await page.key("ArrowLeft"); // closes it
  assert.equal((await lineOf(page, LOGIN))?.expanded, "false");
  assert.deepEqual(await asked(page), [{ type: "collapse", path: LOGIN }]);
  await page.key("Enter");
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  await page.key("End");
  assert.equal(await focused(), "/code/app-usb|row");
  // One tab stop for the tree: every other item is -1.
  const tabStops = await page.eval<number>(`document.querySelectorAll('.wt-list [role=treeitem][tabindex="0"]').length`);
  assert.equal(tabStops, 1);
  // The row with the keyboard shows no buttons over its state — only a pointer brings them.
  await page.mouseMove(1, 1);
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-checkout"]').focus()`);
  const shown = await page.eval<{ buttons: number; state: string }>(`(function () {
    ${COLOUR}
    var l = document.querySelector('.wt-row[data-path="/code/app-checkout"]');
    return { buttons: Array.prototype.filter.call(l.querySelectorAll("button"), seen).length, state: seen(l.querySelector(".wt-state")) ? l.querySelector(".wt-state").textContent : "" };
  })()`);
  assert.deepEqual(shown, { buttons: 0, state: "diverged" });
});

test("a screen reader hears one tree: an open row OWNS its group, and every item in the group is a treeitem — its files and its commits", { skip }, async () => {
  const page = await open("dark", 320, 900);
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle(60);
  await page.page.send("Accessibility.enable", {});
  const { nodes } = (await page.page.send("Accessibility.getFullAXTree", {})) as {
    nodes: { nodeId: string; ignored?: boolean; role?: { value: string }; name?: { value: string }; childIds?: string[]; properties?: { name: string; value: { value: unknown } }[] }[];
  };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // The children a screen reader sees: ignored and generic wrappers are looked through.
  const kids = (id: string): typeof nodes => {
    const out: typeof nodes = [];
    for (const c of byId.get(id)?.childIds ?? []) {
      const n = byId.get(c);
      if (!n) continue;
      if (n.ignored || n.role?.value === "generic" || n.role?.value === "none" || n.role?.value === "StaticText" || n.role?.value === "InlineTextBox") out.push(...kids(c));
      else out.push(n);
    }
    return out;
  };
  const level = (n: (typeof nodes)[number]) => n.properties?.find((x) => x.name === "level")?.value.value;
  const tree = nodes.find((n) => n.role?.value === "tree")!;
  const login = kids(tree.nodeId).find((n) => n.role?.value === "treeitem" && (n.name?.value ?? "").startsWith("app-login"))!;
  assert.ok(login, "the row is a treeitem of the tree");
  assert.match(login.name?.value ?? "", /^app-login, feature\/login\. Current — open in this window\. 5 uncommitted changes/, "its name says what the tooltip does");
  assert.ok(!kids(tree.nodeId).some((n) => n.role?.value === "group"), "no group hangs off the tree beside its row");
  const group = kids(login.nodeId).find((n) => n.role?.value === "group");
  assert.ok(group, `the open row owns its group: ${kids(login.nodeId).map((n) => n.role?.value).join(", ")}`);
  const items = kids(group!.nodeId);
  assert.deepEqual([...new Set(items.map((n) => n.role?.value))], ["treeitem"], `only treeitems in the group: ${items.map((n) => `${n.role?.value} ${n.name?.value}`).join(" | ")}`);
  assert.equal(items[0].name?.value, "login.ts, Modified, staged, in src/auth. Open changes");
  assert.deepEqual(items.map(level), items.map(() => 2), "all at level 2, under the row at level 1");
  assert.equal(level(login), 1);
});

test("⌘⌫ on a row asks to remove it, as Delete does — a Mac's delete key sends Backspace", { skip }, async () => {
  const page = await open();
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-spike"]').focus()`);
  await page.clearPosted();
  await page.key("Backspace");
  assert.deepEqual(await asked(page), [], "Backspace alone is not a delete");
  await page.key("Backspace", { with: ["meta"] });
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-spike", action: "remove" }]);
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-old"]').focus()`);
  await page.clearPosted();
  await page.key("Backspace", { with: ["meta"] });
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-old", action: "forget" }]);
});

/** A row's More menu, opened, as a person reads it: each item's words, and whether any is disabled. */
async function menuOf(page: WorktreesPage, path: string): Promise<string[]> {
  await page.clickOn(`.wt-row[data-path="${path}"] .wt-more`);
  const items = await page.eval<{ labels: string[]; disabled: number; seps: number }>(`(function () {
    var m = document.querySelector(".wt-menu");
    return {
      labels: Array.prototype.map.call(m.children, function (n) { return n.classList.contains("wt-menu-sep") ? "—" : n.textContent; }),
      disabled: m.querySelectorAll('[aria-disabled="true"], :disabled, .is-disabled').length,
    };
  })()`);
  await page.key("Escape");
  assert.equal(items.disabled, 0, `${path}: nothing disabled in its menu — what can't run isn't listed`);
  return items.labels;
}

test("More lists only what can run now, in words — nothing disabled, no reason to read; Escape gives the row back the keyboard", { skip }, async () => {
  const page = await open();
  assert.deepEqual(await menuOf(page, AGENT), [
    "Open in This Window",
    "Open in New Window",
    "Reveal in Finder",
    "Open in Terminal",
    "Copy Path",
    "—",
    "Push…",
    "—",
    "Unlock",
    "Remove Worktree…",
  ]);
  await page.clickOn(`.wt-row[data-path="${AGENT}"] .wt-more`);
  assert.equal(await page.eval<string>(`document.activeElement.textContent`), "Open in This Window");
  // Each item's icon is its own: two that look alike (a folder over a folder
  // once meant Open in This Window and Reveal) would say nothing the words don't.
  const icons = await page.eval<string[][]>(`Array.prototype.map.call(document.querySelectorAll(".wt-menu-item"), function (b) {
    var i = b.querySelector(".codicon");
    return [b.textContent, i ? (i.className.match(/codicon-([a-z-]+)/) || [])[1] : ""];
  })`);
  assert.deepEqual(icons, [
    ["Open in This Window", "window"],
    ["Open in New Window", "empty-window"],
    ["Reveal in Finder", "folder"],
    ["Open in Terminal", "terminal"],
    ["Copy Path", "copy"],
    ["Push…", "repo-push"],
    ["Unlock", "unlock"],
    ["Remove Worktree…", "trash"],
  ]);
  assert.equal(new Set(icons.map(([, i]) => i)).size, icons.length, "no icon twice");
  assert.ok(icons.filter(([, i]) => /folder/.test(i)).length <= 1, "one folder at most");
  await page.key("Escape");
  assert.equal(await page.eval<string>(`document.activeElement.dataset.path`), AGENT);
  assert.equal(await page.eval<number>(`document.querySelectorAll(".wt-menu").length`), 0);

  // This window's worktree: no Open, no Remove.
  assert.deepEqual(await menuOf(page, LOGIN), ["Reveal in Finder", "Open in Terminal", "Copy Path", "—", "Pull", "Push…", "—", "Lock…"]);
  // The main worktree, up to date with nothing to push: Pull, but no Push…; no Lock…, no Remove.
  assert.deepEqual(await menuOf(page, "/code/app"), ["Open in This Window", "Open in New Window", "Reveal in Finder", "Open in Terminal", "Copy Path", "—", "Pull"]);
});

test("Pull and Push…, Lock… and Unlock are listed only where they can run — no remote, a stopped rebase, a folder gone", { skip }, async () => {
  const rebasing = row({ path: "/code/app-rebase", name: "app-rebase", branch: undefined, upstream: undefined, status: { changed: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 1, operation: "rebase", rebasing: "feature/rebase" } });
  const lonely = row({ path: "/code/solo-topic", name: "solo-topic", branch: "topic", upstream: undefined, hasRemotes: false, defaultBranch: "main", status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, unpublished: 2 } });
  const page = await open("dark", 320, 900);
  await page.send({ type: "rows", rows: [...fixtureRows(), rebasing, lonely], state: "ok", labels: LABELS });
  await page.settle();
  const has = async (p: string, ...labels: string[]) => {
    const m = await menuOf(page, p);
    return labels.filter((l) => m.includes(l));
  };
  assert.deepEqual(await has(lonely.path, "Pull", "Push…"), [], "no remote: neither");
  assert.deepEqual(await has(rebasing.path, "Pull", "Push…"), [], "a rebase stopped in it: neither");
  assert.deepEqual(await has("/code/app-hotfix", "Pull", "Push…"), ["Push…"], "its upstream gone: Push… publishes it again");
  assert.deepEqual(await has("/code/app-checkout", "Pull", "Push…", "Lock…"), ["Pull", "Push…", "Lock…"]);
  assert.deepEqual(await has("/code/app", "Lock…", "Unlock", "Remove Worktree…"), [], "the main worktree: git neither locks nor removes it");
  assert.deepEqual(await has("/code/app-old", "Lock…", "Unlock"), [], "a folder that is gone can't be locked");
  assert.deepEqual(await has("/code/app-usb", "Lock…", "Unlock"), ["Unlock"]);
  assert.deepEqual(await menuOf(page, UNLINKED), ["Reveal in Finder", "Copy Path", "—", "Forget Worktree…"]);
  assert.deepEqual(await menuOf(page, "/code/app-old"), ["Copy Path", "—", "Forget Worktree…"]);
});

test("a menu item asks the host for exactly that action on exactly that worktree", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent === "Remove Worktree…"; }).click()`);
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-checkout", action: "remove" }]);
  // The row's own button: Open in New Window, at once.
  await page.clearPosted();
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] [data-action="openNew"]`);
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-checkout", action: "openNew" }]);
  // A missing folder — and one that isn't a worktree any more — is forgotten from its menu.
  for (const gone of ["/code/app-old", UNLINKED]) {
    await page.clickOn(`.wt-row[data-path="${gone}"] .wt-more`);
    await page.clearPosted();
    await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent === "Forget Worktree…"; }).click()`);
    assert.deepEqual(await asked(page), [{ type: "action", path: gone, action: "forget" }]);
  }
  // Delete on a row asks to remove it.
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-spike"]').focus()`);
  await page.clearPosted();
  await page.key("Delete");
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-spike", action: "remove" }]);
});

test("Unlock paints at once — the lock goes before the host answers — and comes back if git says no", { skip }, async () => {
  const locked = row({ path: "/code/app-held", name: "app-held", locked: true, lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)" });
  const page = await open();
  await page.send({ type: "rows", rows: [...fixtureRows(), locked], state: "ok", labels: LABELS });
  await page.settle();
  assert.equal((await lineOf(page, locked.path))?.state, "locked");
  await page.clickOn(`.wt-row[data-path="${locked.path}"] .wt-more`);
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent === "Unlock"; }).click()`);
  assert.deepEqual(await asked(page), [{ type: "action", path: locked.path, action: "unlock" }]);
  await page.mouseMove(1, 1); // hovered, the buttons cover the state
  const now = (await lineOf(page, locked.path))!;
  assert.equal(now.state, "", "unlocked on screen now");
  assert.doesNotMatch(now.tip, /Locked/);
  await page.eval(`(window.__heldRow = document.querySelector('.wt-item[data-path="${locked.path}"]'), true)`);
  await page.send({ type: "patch", path: locked.path, row: { locked: true, lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)" } });
  const back = (await lineOf(page, locked.path))!;
  assert.equal(back.state, "locked", "put back");
  assert.match(back.tip, /Locked: “claude agent/);
  assert.equal(await page.eval<boolean>(`document.querySelector('.wt-item[data-path="${locked.path}"]') === window.__heldRow`), true, "patched in place, not rebuilt");
});

test("a running action: the row says what it is doing — hovered too — and takes no second one; then it goes, and the keyboard moves on", { skip }, async () => {
  const page = await open();
  const menus = () => page.eval<number>(`document.querySelectorAll(".wt-menu").length`);
  // Its menu open when the action starts: the menu goes, the row keeps the keyboard.
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
  assert.equal(await menus(), 1);
  await page.send({ type: "busy", path: "/code/app-checkout", busy: true, label: "Removing…" });
  assert.equal(await menus(), 0, "a menu on a row that turns busy closes");
  assert.equal(await page.eval<string>(`document.activeElement.dataset.path`), "/code/app-checkout", "the row has the keyboard back");
  const busy = await page.eval<{ text: string; disabled: boolean[]; ariaBusy: string | null }>(`(function () {
    var l = document.querySelector('.wt-row[data-path="/code/app-checkout"]');
    return { text: l.querySelector(".wt-state").textContent, disabled: Array.prototype.map.call(l.querySelectorAll("button"), function (b) { return b.disabled; }), ariaBusy: l.getAttribute("aria-busy") };
  })()`);
  assert.equal(busy.text, "Removing…");
  assert.deepEqual(busy.disabled, [true, true]);
  assert.equal(busy.ariaBusy, "true");
  // Hovered, it still says what it is doing: no faded buttons over its words.
  const at = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector('.wt-row[data-path="/code/app-checkout"]').getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  await page.mouseMove(at.x, at.y);
  const hovered = await page.eval<{ state: string; buttons: number }>(`(function () {
    ${COLOUR}
    var l = document.querySelector('.wt-row[data-path="/code/app-checkout"]');
    var st = l.querySelector(".wt-state");
    return { state: seen(st) ? st.textContent : "", buttons: Array.prototype.filter.call(l.querySelectorAll("button"), seen).length };
  })()`);
  assert.deepEqual(hovered, { state: "Removing…", buttons: 0 }, "hovered, a busy row says what it is doing");
  // Nor does its menu open: not by a right-click, not from the keyboard.
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-name`, "right");
  assert.equal(await menus(), 0, "no menu by right-click on a busy row");
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-checkout"]').focus()`);
  await page.key("F10", { with: ["shift"] });
  assert.equal(await menus(), 0, "no menu by Shift+F10 on a busy row");
  await page.clearPosted();
  await page.key("Delete");
  assert.deepEqual(await asked(page), [], "no second action while one runs");
  const next = await page.eval<string>(`(function () { var ls = document.querySelectorAll(".wt-row"); for (var i = 0; i < ls.length; i++) if (ls[i].dataset.path === "/code/app-checkout") return ls[i + 1].dataset.path; })()`);
  await page.send({ type: "drop", path: "/code/app-checkout" });
  assert.equal(await lineOf(page, "/code/app-checkout"), null);
  assert.equal(await page.eval<string>(`document.activeElement.dataset.path`), next, "the next row has the keyboard");
});

test("a busy row still reads at AA, in every theme: what it is doing, its folder and its branch — busy is said, never faded", { skip }, async () => {
  for (const theme of THEMES) {
    const page = await open(theme);
    await page.send({ type: "busy", path: "/code/app-checkout", busy: true, label: "Removing…" });
    await page.send({ type: "busy", path: LOGIN, busy: true, label: "Pulling…" });
    await page.settle();
    const report = await page.eval<{ text: string; ratio: number }[]>(`(function () {
      ${COLOUR}
      var out = [];
      document.querySelectorAll(".wt-row.is-busy").forEach(function (row) {
        var w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) {
          var el = w.currentNode.parentElement;
          if (!w.currentNode.textContent.trim() || el.closest("button")) continue;
          out.push({ text: w.currentNode.textContent.trim(), ratio: contrast(el) });
        }
      });
      return out;
    })()`);
    const texts = report.map((r) => r.text);
    for (const t of ["Removing…", "app-checkout", "feature/checkout", "Pulling…", "app-login", "feature/login"]) assert.ok(texts.includes(t), `${theme}: "${t}" is on a busy row (${texts.join(" | ")})`);
    for (const r of report) assert.ok(r.ratio >= 4.5, `${theme}: "${r.text}" on a busy row reads at ${r.ratio.toFixed(2)}:1`);
  }
});

test("the same list again changes nothing on screen: open rows stay open, the focused row keeps the keyboard", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.eval(`(window.__row = document.querySelector('.wt-row[data-path="/code/app-spike"]'), window.__row.focus())`);
  await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: LABELS });
  assert.equal(await page.eval<boolean>(`document.activeElement === window.__row`), true);
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  assert.equal(await page.eval<number>(`document.querySelectorAll('.wt-item[data-path="${LOGIN}"] .cr-file').length`), 5);
});

test("an open commit and the file row with the keyboard survive a status for that row, a list where another row changed, and details that did not change", { skip }, async () => {
  const page = await open("dark", 320, 900);
  const SHA = fixtureDetails().unpushed!.commits[0].sha;
  const files = [
    { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
    { path: "src/auth/store.ts", status: "A", additions: 41, deletions: 0 },
  ];
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit`);
  await page.send({ type: "commitFiles", path: LOGIN, sha: SHA, files });
  // The second file under the open commit has the keyboard.
  await page.eval(`(window.__file = document.querySelectorAll('.wt-item[data-path="${LOGIN}"] .cr-commit-files .cr-file')[1], window.__file.focus())`);
  const state = () =>
    page.eval<{ sameFocus: boolean; focusText: string; filesUnder: string; open: boolean; height: number; top: number }>(`(function () {
      var item = document.querySelector('.wt-item[data-path="${LOGIN}"]');
      var commit = item.querySelector('.cr-commit-item[data-sha="${SHA}"]');
      return {
        sameFocus: document.activeElement === window.__file,
        focusText: document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "",
        filesUnder: commit.querySelector(".cr-commit-files").textContent,
        open: commit.classList.contains("open"),
        height: item.querySelector(".wt-details").getBoundingClientRect().height,
        top: window.__file.getBoundingClientRect().top,
      };
    })()`);
  const before = await state();
  assert.equal(before.sameFocus, true);
  assert.match(before.filesUnder, /session\.ts.*store\.ts/);

  const settled = async (what: string) => {
    const now = await state();
    assert.equal(now.sameFocus, true, `${what}: the file row keeps the keyboard (on ${JSON.stringify(now.focusText)})`);
    assert.equal(now.open, true, `${what}: the commit stays open`);
    assert.equal(now.filesUnder, before.filesUnder, `${what}: its files stay — never "Loading files…" again`);
    assert.equal(now.height, before.height, `${what}: the open row keeps its height`);
    assert.equal(now.top, before.top, `${what}: nothing moves`);
    assert.deepEqual((await asked(page)).filter((m) => m.type === "commitFiles"), [], `${what}: the files are not asked for again`);
  };

  // 1. A status for THIS row (one more change).
  await page.clearPosted();
  await page.send({ type: "status", path: LOGIN, status: { changed: 6, staged: 2, unstaged: 3, untracked: 1, conflicted: 0 } });
  await page.settle();
  await settled("a status for the row");
  assert.equal((await lineOf(page, LOGIN))?.state, "6 changed", "the row itself says the new count");

  // 2. A list in which only ANOTHER row changed.
  const rows = fixtureRows().map((r) =>
    r.path === "/code/app-checkout" ? { ...r, ahead: 2 } : r.path === LOGIN ? { ...r, status: { changed: 6, staged: 2, unstaged: 3, untracked: 1, conflicted: 0 } } : r,
  );
  await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
  await page.settle();
  await settled("a list where another row changed");

  // 3. Its details sent again, the same commits: the open one is kept, with its files.
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  await settled("the same details again");

  // 3b. Details that did change — one more uncommitted file — above the open commit: it keeps its files and the keyboard.
  const more = fixtureDetails();
  more.files.push({ path: "src/auth/new.ts", status: "U", area: "untracked" });
  more.filesTotal += 1;
  await page.send({ type: "details", path: LOGIN, details: more });
  await page.settle();
  const moved = await state();
  assert.deepEqual([moved.sameFocus, moved.open, moved.filesUnder], [true, true, before.filesUnder], "new details: the open commit is the same, with its files");
  assert.deepEqual((await asked(page)).filter((m) => m.type === "commitFiles"), []);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  await settled("the details as they were");

  // 4. A list that changes THIS row's upstream: the row says so, the commits are untouched.
  await page.send({ type: "rows", rows: rows.map((r) => (r.path === LOGIN ? { ...r, ahead: 3 } : r)), state: "ok", labels: LABELS });
  await page.settle();
  await settled("a list that changes this row");
  assert.deepEqual(page.errors(), []);
});

test("past eight worktrees a filter appears; it narrows by folder, branch or path, and says when nothing matches", { skip }, async () => {
  const page = await open();
  const shown = () => page.eval<boolean>(`!document.querySelector(".wt-filter").hidden && !document.querySelector(".wt-top").hidden`);
  assert.equal(await shown(), true);
  assert.equal(await page.eval<string>(`document.querySelector(".wt-filter-input").placeholder`), "Filter 11 worktrees");
  await page.clickOn(".wt-filter-input");
  await page.type("login");
  const visible = () => page.eval<string[]>(`Array.prototype.filter.call(document.querySelectorAll(".wt-item"), function (i) { return !i.hidden; }).map(function (i) { return i.dataset.path; })`);
  assert.deepEqual(await visible(), [LOGIN]);
  await page.type("zzz");
  assert.deepEqual(await visible(), []);
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /No worktree matches “loginzzz”/);
  await page.key("Escape");
  assert.equal((await visible()).length, 11);
  // Eight or fewer: no filter, and no bar for it.
  await page.send({ type: "rows", rows: fixtureRows().slice(0, 8), state: "ok", labels: LABELS });
  assert.equal(await shown(), false);
  assert.equal(await page.eval<number>(`document.querySelector(".wt-top").getBoundingClientRect().height`), 0);
});

test("Prune N: a quiet link under the list, only when git would prune something — unlocked, missing or not a worktree any more — and says which", { skip }, async () => {
  const page = await open();
  const prune = () =>
    page.eval<{ hidden: boolean; text: string; tip: string; last: boolean; border: string; fill: string; size: string }>(`(function () {
      var b = document.querySelector(".wt-prune");
      var cs = getComputedStyle(b);
      var list = document.querySelector(".wt-list").getBoundingClientRect();
      return {
        hidden: b.getClientRects().length === 0,
        text: b.textContent,
        tip: b.getAttribute("aria-label"),
        last: b.getBoundingClientRect().top >= list.bottom - 1,
        border: cs.borderTopWidth,
        fill: cs.backgroundColor,
        size: cs.fontSize,
      };
    })()`);
  assert.deepEqual(await prune(), {
    hidden: false,
    text: "Prune 2 missing worktrees…",
    tip: "Forget the 2 worktrees git can prune: their folders are gone, or aren't worktrees any more",
    last: true,
    border: "0px",
    fill: "rgba(0, 0, 0, 0)",
    size: "12px",
  });
  await page.clearPosted();
  await page.clickOn(".wt-prune");
  assert.deepEqual(await asked(page), [{ type: "prune" }]);
  await page.send({ type: "rows", rows: fixtureRows().filter((r) => r.path !== UNLINKED), state: "ok", labels: LABELS });
  const one = await prune();
  assert.deepEqual([one.hidden, one.text, one.tip], [false, "Prune 1 missing worktree…", "Forget the worktree whose folder is gone"]);
  await page.send({ type: "rows", rows: fixtureRows().filter((r) => r.path !== "/code/app-old" && r.path !== UNLINKED), state: "ok", labels: LABELS });
  assert.equal((await prune()).hidden, true, "only a locked one is missing: git keeps it");
});

test("only the main worktree: it says what a worktree is for, with New Worktree…", { skip }, async () => {
  const page = await open();
  await page.send({ type: "rows", rows: [fixtureRows()[0]], state: "ok", labels: LABELS });
  const note = await page.eval<string>(`document.querySelector(".wt-note").textContent`);
  assert.match(note, /Work on another branch, side by side/);
  assert.match(note, /New Worktree…/);
  await page.clearPosted();
  await page.clickOn(".wt-add");
  assert.deepEqual(await asked(page), [{ type: "add" }]);
  await page.send({ type: "rows", rows: [], state: "noRepo", labels: LABELS });
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /No repository open/);
  await page.send({ type: "rows", rows: [], state: "discovering", labels: LABELS });
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /Looking for a repository…/);
});

// Arial (Liberation Sans on the Linux runners) draws "…" a whole em wide: the
// shortest clipped name is wider there than its first five letters.
for (const font of ["", "Arial"]) test(`a narrow sidebar${font ? ` in ${font}` : ""}: the state is never cut, the branch gives way before it, the name only in its middle, and no word shrinks to a stray letter`, { skip }, async () => {
  // Agents' worktrees: long folder names AND long branches, nested deep.
  const long = [
    row({ path: "/code/app/.claude/worktrees/agent-a2c9ae276dde4d3da", name: "agent-a2c9ae276dde4d3da", relPath: "app/.claude/worktrees/agent-a2c9ae276dde4d3da", branch: "worktree-agent-a2c9ae276dde4d3da", upstream: undefined, status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, unpublished: 2 } }),
    row({ path: "/code/app/.claude/worktrees/agent-a6ca5aacb06de1cf0", name: "agent-a6ca5aacb06de1cf0", relPath: "app/.claude/worktrees/agent-a6ca5aacb06de1cf0", branch: "ci/desktop-portability", upstream: "origin/ci/desktop-portability", ahead: 3, behind: 1, status: { changed: 7, staged: 2, unstaged: 5, untracked: 0, conflicted: 0 } }),
    row({ path: "/code/app/.claude/worktrees/wf_4b651e91-cc2-2", name: "wf_4b651e91-cc2-2", relPath: "app/.claude/worktrees/wf_4b651e91-cc2-2", branch: "feat/worktrees-webview", upstream: undefined, locked: true, lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)" }),
    row({ path: "/code/app-cherry", name: "app-cherry", branch: "fix/cherry", status: { changed: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, operation: "cherry-pick" } }),
  ];
  const page = await WorktreesPage.open("dark", { width: 300, height: 900 });
  opened.push(page);
  if (font) await page.eval(`(function () { var s = document.createElement("style"); s.textContent = "body, body * { font-family: ${font} !important; }"; document.head.appendChild(s); })()`);
  await page.send({ type: "rows", rows: [...fixtureRows(), ...long], state: "ok", labels: LABELS });
  const measure = () =>
    page.eval<string[]>(`(function () {
      ${COLOUR}
      // How wide the first n characters of an element's text are drawn.
      function lead(el, n) {
        var t = el.firstChild;
        if (!t || t.nodeType !== 3) return 0;
        var r = document.createRange();
        r.setStart(t, 0);
        r.setEnd(t, Math.min(n, t.length));
        return r.getBoundingClientRect().width;
      }
      function cut(el) { return el.scrollWidth > el.clientWidth + 1; }
      var out = [];
      document.querySelectorAll(".wt-row").forEach(function (row) {
        var id = row.dataset.path.split("/").pop();
        var name = row.querySelector(".wt-name");
        var head = row.querySelector(".wt-head");
        var state = row.querySelector(".wt-state");
        var right = row.getBoundingClientRect().right;
        // Its words, after the branch symbol: four letters of them or none.
        var headText = head && head.querySelector(".wt-head-text");
        if (seen(head) && (!headText || headText.clientWidth + 0.5 < lead(headText, 4))) out.push(id + ": its branch shows " + (headText ? headText.clientWidth : 0) + "px of words — under 4 letters");
        var clipped = name.textContent !== id;
        if (textOver(name)) out.push(id + ": its name is cut at its end (" + name.textContent + ")");
        if (name.textContent.replace("…", "").length < Math.min(4, id.length)) out.push(id + ": its name shows under 4 letters (" + name.textContent + ")");
        if (state.textContent && seen(state) && cut(state)) out.push(id + ": its state is cut");
        if (state.textContent && !seen(state) && seen(head)) out.push(id + ": its state went while its branch shows");
        if (state.textContent && state.getBoundingClientRect().right > right + 0.5) out.push(id + ": its state runs past the edge");
        if (row.scrollWidth > row.clientWidth + 1) out.push(id + ": the row runs past the edge");
        var tip = row.dataset.tip;
        if (head && !seen(head) && tip.indexOf(head.textContent) < 0) out.push(id + ": its branch is hidden and not in its tooltip");
        if (clipped && tip.split("\\n")[0] !== id) out.push(id + ": its name is clipped and its tooltip does not lead with it");
      });
      return out;
    })()`);
  // 180: a sidebar dragged as narrow as it goes — branches go whole there.
  for (const width of [180, 220, 240, 300, 360]) {
    await page.resize(width);
    assert.deepEqual(await measure(), [], `at ${width}px`);
    if (width === 180) {
      // The narrowest a sidebar goes: some branches give way (to an ellipsis,
      // or whole) — so the rules above were put to work, not idle.
      const gave = await page.eval<number>(`Array.prototype.filter.call(document.querySelectorAll(".wt-head"), function (h) { var t = h.querySelector(".wt-head-text"); return h.getClientRects().length === 0 || (t && t.scrollWidth > t.clientWidth + 1); }).length`);
      assert.ok(gave > 0, "at its narrowest some branches give way");
    }
    if (width === 220) {
      // Routine counts give way to eight letters of the name; what needs attention keeps its place — in its one word, if that is what fits.
      const shown = await page.eval<Record<string, string>>(`(function () { var o = {}; document.querySelectorAll(".wt-row").forEach(function (l) { var s = l.querySelector(".wt-state"); if (s.dataset.tone === "attention") o[l.dataset.path.split("/").pop()] = s.getClientRects().length > 0 ? s.textContent : ""; }); return o; })()`);
      for (const id of ["app-merge", "app-cherry", "app-old", "app-usb", "agent-7f3e"]) assert.ok(shown[id], `${id}'s state shows at 220px: ${JSON.stringify(shown)}`);
    }
  }
  // At a sidebar's usual width every state is there; wide enough, every branch too.
  await page.resize(300);
  assert.equal(await page.eval<number>(`Array.prototype.filter.call(document.querySelectorAll(".wt-state"), function (h) { return h.textContent && h.getClientRects().length === 0; }).length`), 0, "every state shows at 300px");
  await page.resize(700);
  const hidden = await page.eval<number>(`Array.prototype.filter.call(document.querySelectorAll(".wt-head, .wt-state"), function (h) { return h.textContent && h.getClientRects().length === 0; }).length`);
  assert.equal(hidden, 0, "nothing hidden when there is room");
});

test("a narrow sidebar never makes two rows read alike: a name keeps its end, and a state that needs attention says one word before the name gives way", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 300, height: 900 });
  opened.push(page);
  const read = () =>
    page.eval<{ full: string; shown: string; cut: boolean; state: string; tip: string }[]>(`(function () {
      ${COLOUR}
      return Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) {
        var n = l.querySelector(".wt-name"), st = l.querySelector(".wt-state");
        return { full: l.dataset.path.split("/").pop(), shown: n.textContent, cut: textOver(n), state: seen(st) ? st.textContent : "", tip: l.dataset.tip };
      });
    })()`);
  const sets: [string, WorktreeRow[]][] = [
    ["this repository's agents", agentRows()],
    ["the fixtures", fixtureRows()],
  ];
  for (const [what, rows] of sets) {
    await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
    for (const width of [180, 200, 220, 240, 260, 300]) {
      await page.resize(width);
      const got = await read();
      for (const n of got) {
        assert.equal(n.cut, false, `${what} at ${width}px: ${n.full} is cut at its end ("${n.shown}")`);
        if (n.shown === n.full) continue;
        // Clipped in the middle: its start and its END, each two letters or more.
        const [a, b] = n.shown.split("…");
        assert.ok(b !== undefined && a.length >= 2 && b.length >= 2 && n.full.startsWith(a) && n.full.endsWith(b), `${what} at ${width}px: ${n.full} reads "${n.shown}"`);
        assert.equal(n.tip.split("\n")[0], n.full, `${what} at ${width}px: the tooltip names ${n.full} whole`);
      }
      const shown = got.map((n) => n.shown);
      assert.equal(new Set(shown).size, shown.length, `${what} at ${width}px: two rows read alike — ${shown.join(" | ")}`);
    }
  }
  // At 260px this repository's stopped rebase reads whole — its folder on
  // its own line, "rebase stopped" on the next; the tooltip says the rest.
  await page.send({ type: "rows", rows: agentRows(), state: "ok", labels: LABELS });
  await page.resize(260);
  const stopped = (await read()).find((n) => n.full === "wf_4b651e91-cc2-3")!;
  assert.deepEqual([stopped.shown, stopped.state], ["wf_4b651e91-cc2-3", "rebase stopped"]);
  assert.match(stopped.tip, /A rebase is stopped in it/);
  // Where even its line alone cannot hold the words, the one word.
  await page.resize(120);
  const narrow = (await read()).find((n) => n.full === "wf_4b651e91-cc2-3")!;
  assert.equal(narrow.state, "rebasing", "too narrow for the words: the one word, never cut");
  // With room, the whole words.
  await page.resize(400);
  assert.equal((await read()).find((n) => n.full === "wf_4b651e91-cc2-3")!.state, "rebase stopped");
  assert.deepEqual(page.errors(), []);
});

test("the page tells the host which rows are in view — and again as they scroll into it", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 300, height: 200 });
  opened.push(page);
  const many = Array.from({ length: 20 }, (_, i) => row({ path: `/code/wt-${i}`, name: `wt-${String(i).padStart(2, "0")}` }));
  await page.send({ type: "rows", rows: many, state: "ok", labels: LABELS });
  await page.settle(120);
  const lastVisible = async () => {
    const posted = await page.posted();
    const v = posted.filter((m) => m.type === "visible").pop();
    return (v?.paths as string[] | undefined) ?? [];
  };
  const first = await lastVisible();
  assert.ok(first.includes("/code/wt-0"));
  assert.ok(!first.includes("/code/wt-19"), "not the rows out of view");
  await page.eval(`document.querySelector('.wt-row[data-path="/code/wt-19"]').scrollIntoView()`);
  await page.settle(120);
  const second = await lastVisible();
  assert.ok(second.includes("/code/wt-19"));
  assert.ok(!second.includes("/code/wt-0"));
});
