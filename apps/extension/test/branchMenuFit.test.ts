import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type LocalBranch, type VsCodeTheme } from "./changesPage";

// The Changes view's branch menu ("Search for branches and actions") where
// the sidebar is narrow or short, in the real page commitView.ts serves, in a
// windowless Chrome:
//   · a branch's submenu stays inside the view, however narrow or short it
//     is — every item reachable, the highlighted one scrolled into view, and
//     the same for the file rows' action menu, which is the same popup;
//   · the menu keeps its width while you type: the width its whole list
//     needs, also when the branches arrive after it opened and when the view
//     is widened under it;
//   · a new query starts the list at the top, its first group header in view;
//   · the menu takes the room below the pill, fits a view narrower than its
//     least width, and is placed again (with its submenu) when the view is
//     resized while it is open;
//   · a branch's name keeps the row's room — its upstream label gives way
//     first, and its ↑/↓ counts before the name falls under 45% of the row;
//   · an upstream deleted from its remote says so;
//   · the upstream label and the group counts are readable text (4.5:1), and
//     an empty star reads as a control (3:1);
//   · the highlighted row still shows what matched, and its star.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const pages: ChangesPage[] = [];
async function open(theme: VsCodeTheme, width: number, height: number): Promise<ChangesPage> {
  const p = await ChangesPage.open(theme, { width, height });
  pages.push(p);
  return p;
}
after(async () => {
  for (const p of pages) await p.close();
});

const LONG = "feature/checkout-flow/billing-address-validation-for-international-customers-v2";
const FEW: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 2, behind: 1 },
  { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true },
  { name: "spike/cache" },
];

async function openMenu(p: ChangesPage, state: unknown): Promise<void> {
  await p.send(state);
  await p.send({ type: "openBranchMenu" });
  await p.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  await p.eval(`new Promise(function (r) { setTimeout(r, 20); })`);
}
async function closeMenu(p: ChangesPage): Promise<void> {
  await p.eval(`(function () { if (document.querySelector(".branch-menu")) document.getElementById("branch-pill").click(); })()`);
}
async function query(p: ChangesPage, q: string): Promise<void> {
  await p.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  if (q) await p.type(q);
}
/** Put the highlight on a row by its key, the way the arrows get there. */
async function arrowTo(p: ChangesPage, key: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const on = await p.eval<string>(`(function () { var a = document.querySelector(".bm-list .is-active"); return a ? a.dataset.bmkey : ""; })()`);
    if (on === key) return;
    await p.key("ArrowDown");
  }
  throw new Error(`never reached ${key}`);
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (p: ChangesPage, sel: string): Promise<Box> =>
  p.eval<Box>(`(function () { var r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const viewport = (p: ChangesPage): Promise<{ w: number; h: number }> => p.eval(`({ w: innerWidth, h: innerHeight })`);

function assertInside(b: Box, vp: { w: number; h: number }, what: string): void {
  const m = 0.5;
  assert.ok(b.left >= -m && b.right <= vp.w + m, `${what} fits across the ${vp.w}px view: ${JSON.stringify(b)}`);
  assert.ok(b.top >= -m && b.bottom <= vp.h + m, `${what} fits down the ${vp.h}px view: ${JSON.stringify(b)}`);
}

test("a branch's submenu stays inside a narrow view", { skip }, async () => {
  for (const width of [260, 300]) {
    const p = await open("dark", width, 640);
    const local: LocalBranch[] = [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: LONG, upstream: "origin/" + LONG, upstreamOnRemote: true, ahead: 1 },
    ];
    await openMenu(p, stateMessage({ local, remote: ["origin/main", "origin/" + LONG] }));
    for (const q of [LONG.slice(0, 30), "main"]) {
      await query(p, q);
      await arrowTo(p, q === "main" ? "b:local:main" : "b:local:" + LONG);
      await p.key("ArrowRight");
      assertInside(await box(p, ".branch-submenu"), await viewport(p), `${q}'s submenu at ${width}px`);
      await p.key("ArrowLeft");
    }
    await closeMenu(p);
  }
});

test("a branch's submenu stays inside a short view: every item reachable, the highlighted one in view", { skip }, async () => {
  const p = await open("dark", 300, 400);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature"] }));
  await query(p, "feature");
  await arrowTo(p, "b:local:feature");
  await p.key("ArrowRight");
  const vp = await viewport(p);
  assertInside(await box(p, ".branch-submenu"), vp, "the submenu");
  const labels = await p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`);
  // Walk to the last item: every one on the way is shown.
  for (let i = 1; i < labels.length; i++) {
    await p.key("ArrowDown");
    const at = await p.eval<{ label: string; item: Box; list: Box }>(`(function () {
      var a = document.querySelector(".branch-submenu .is-active");
      var r = a.getBoundingClientRect(), l = a.parentElement.getBoundingClientRect();
      return { label: a.textContent.trim(),
        item: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        list: { left: l.left, top: l.top, right: l.right, bottom: l.bottom, width: l.width, height: l.height } };
    })()`);
    assert.equal(at.label, labels[i]);
    assertInside(at.item, vp, `'${at.label}'`);
    const clip = await box(p, ".branch-submenu .bm-sublist");
    assert.ok(at.item.top >= clip.top - 0.5 && at.item.bottom <= clip.bottom + 0.5, `'${at.label}' is scrolled into the submenu's visible part`);
  }
  assert.equal(labels[labels.length - 1], "Delete");

  // The host repaints the menu (fresh counts): the item stays highlighted AND in view.
  await p.send(stateMessage({ local: FEW.map((b) => (b.name === "feature" ? { ...b, ahead: 3 } : b)), remote: ["origin/main", "origin/feature"] }));
  const after = await p.eval<{ label: string; top: number; bottom: number; clipTop: number; clipBottom: number }>(`(function () {
    var a = document.querySelector(".branch-submenu .is-active");
    var r = a.getBoundingClientRect(), c = a.parentElement.getBoundingClientRect();
    return { label: a.textContent.trim(), top: r.top, bottom: r.bottom, clipTop: c.top, clipBottom: c.bottom };
  })()`);
  assert.equal(after.label, "Delete");
  assert.ok(after.top >= after.clipTop - 0.5 && after.bottom <= after.clipBottom + 0.5, `still in view after the repaint: ${JSON.stringify(after)}`);
  await closeMenu(p);
});

test("the file rows' action menu — the same popup — stays inside a short view too", { skip }, async () => {
  const p = await open("dark", 300, 220);
  await p.send(stateMessage({ local: FEW }));
  await p.page.waitFor(`!!document.querySelector('.row.is-file[data-path="src/app.ts"]')`);
  // A right-click on the row, where a person can see it.
  await p.eval(`(function () {
    var row = document.querySelector('.row.is-file[data-path="src/app.ts"]');
    row.scrollIntoView({ block: "nearest" });
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  })()`);
  await p.page.waitFor(`!!document.querySelector(".action-menu")`);
  const vp = await viewport(p);
  assertInside(await box(p, ".action-menu"), vp, "the file's action menu");
  // Its first item has focus (Tab walks this menu): the ring is whole, not
  // clipped by the list that now scrolls.
  const ring = await p.eval<{ focused: boolean; drawn: boolean; out: number; item: Box; list: Box }>(`(function () {
    var a = document.activeElement, s = getComputedStyle(a);
    var r = a.getBoundingClientRect(), l = a.parentElement.getBoundingClientRect();
    var out = parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
    return { focused: a.classList.contains("bm-subaction"), drawn: s.outlineStyle !== "none", out: out,
      item: { left: r.left - out, top: r.top - out, right: r.right + out, bottom: r.bottom + out, width: 0, height: 0 },
      list: { left: l.left, top: l.top, right: l.right, bottom: l.bottom, width: 0, height: 0 } };
  })()`);
  assert.ok(ring.focused && ring.drawn, `the first item has focus, and its ring shows: ${JSON.stringify(ring)}`);
  assert.ok(
    ring.item.left >= ring.list.left - 0.5 && ring.item.right <= ring.list.right + 0.5 && ring.item.top >= ring.list.top - 0.5,
    `its focus ring lies inside the list that clips it: ${JSON.stringify(ring)}`,
  );
  // Its last item can be scrolled to.
  const last = await p.eval<{ top: number; bottom: number; clipTop: number; clipBottom: number }>(`(function () {
    var items = document.querySelectorAll(".action-menu .bm-subaction");
    var a = items[items.length - 1];
    a.scrollIntoView({ block: "nearest" });
    var r = a.getBoundingClientRect(), c = a.parentElement.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, clipTop: Math.max(0, c.top), clipBottom: Math.min(innerHeight, c.bottom) };
  })()`);
  assert.ok(last.top >= last.clipTop - 0.5 && last.bottom <= last.clipBottom + 0.5, `its last item scrolls into view: ${JSON.stringify(last)}`);
});

test("the menu takes all the room below the pill in a short view, and no more", { skip }, async () => {
  const p = await open("dark", 300, 380);
  const many: LocalBranch[] = [
    ...FEW,
    ...Array.from({ length: 40 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(p, stateMessage({ local: many }));
  const m = await box(p, ".branch-menu");
  const pill = await box(p, "#branch-pill");
  const vp = await viewport(p);
  assert.ok(m.top >= pill.bottom, `under the pill: ${JSON.stringify({ m, pill })}`);
  assert.ok(m.bottom <= vp.h - 8 + 0.5, `inside the view: ${JSON.stringify(m)}`);
  assert.ok(m.bottom >= vp.h - 8 - 1, `down to the view's foot, not a fixed share of it: ${JSON.stringify(m)} in ${vp.h}px`);
  await closeMenu(p);
});

test("a view narrower than the menu's least width still holds the whole menu", { skip }, async () => {
  const p = await open("dark", 236, 480);
  await openMenu(p, stateMessage({ local: FEW }));
  assertInside(await box(p, ".branch-menu"), await viewport(p), "the menu");
  await closeMenu(p);
});

test("the sidebar resized with the menu and a submenu open: both are placed inside it again", { skip }, async () => {
  const p = await open("dark", 560, 640);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature"] }));
  await query(p, "feature");
  await arrowTo(p, "b:local:feature");
  await p.key("ArrowRight");
  await p.key("ArrowDown");
  const before = await p.eval<string>(`document.querySelector(".branch-submenu .is-active").textContent.trim()`);
  for (const [w, h] of [[300, 400], [260, 360]]) {
    await p.resize(w, h);
    const vp = await viewport(p);
    assertInside(await box(p, ".branch-menu"), vp, `the menu at ${w}×${h}`);
    assertInside(await box(p, ".branch-submenu"), vp, `the submenu at ${w}×${h}`);
    const now = await p.eval<{ head: string; active: string }>(`({
      head: document.querySelector(".branch-submenu .bm-subhead-name").textContent,
      active: document.querySelector(".branch-submenu .is-active").textContent.trim(),
    })`);
    assert.deepEqual(now, { head: "feature", active: before }, "the same branch's submenu, the same item highlighted");
  }
  await closeMenu(p);
});

test("the menu keeps its width while you type", { skip }, async () => {
  const p = await open("dark", 320, 640);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature", "origin/release/2.1"], tags: ["v2.1.0"] }));
  const w0 = (await box(p, ".branch-menu")).width;
  for (const q of ["re", "release", "zzzq", ""]) {
    await query(p, q);
    const w = (await box(p, ".branch-menu")).width;
    assert.ok(Math.abs(w - w0) < 0.5, `the same width with '${q}' in the box: ${w}px, opened at ${w0}px`);
  }
  await closeMenu(p);
});

// The width it keeps is what its whole list needs, not whatever it held the
// moment it opened: the branches can arrive after it (a Changes view not yet
// shown, a repository just switched to), and the view can be widened under it.
test("the menu keeps the width its branches need while you type, when they arrive after it opened", { skip }, async () => {
  const p = await open("dark", 560, 640);
  const first = stateMessage({ local: FEW });
  delete first.branches; // the host's first post for a repository carries none
  await openMenu(p, first);
  const loading = (await box(p, ".branch-menu")).width;
  await p.send(stateMessage({ local: [...FEW, { name: LONG, upstream: "origin/" + LONG }], remote: ["origin/main"] }));
  const w1 = (await box(p, ".branch-menu")).width;
  assert.ok(w1 > loading + 50, `the branches widened it: ${loading}px while loading, ${w1}px with them`);
  for (const q of ["zzzq", "main", "", "re"]) {
    await query(p, q);
    const w = (await box(p, ".branch-menu")).width;
    assert.ok(Math.abs(w - w1) < 0.5, `the same width with '${q}' in the box: ${w}px, ${w1}px when the branches arrived`);
  }
  await closeMenu(p);
});

test("the menu keeps the width its branches need while you type, after the view was widened under it", { skip }, async () => {
  const p = await open("dark", 280, 640);
  await openMenu(p, stateMessage({ local: [...FEW, { name: LONG, upstream: "origin/" + LONG }] }));
  const opened = (await box(p, ".branch-menu")).width;
  await p.resize(560, 640);
  const wide = (await box(p, ".branch-menu")).width;
  assert.ok(wide > opened + 50, `widening the view widened it: ${opened}px → ${wide}px`);
  for (const q of ["main", "zzzq", ""]) {
    await query(p, q);
    const w = (await box(p, ".branch-menu")).width;
    assert.ok(Math.abs(w - wide) < 0.5, `the same width with '${q}' in the box: ${w}px, ${wide}px after the resize`);
  }
  // Narrowed again: it fits the view, and still holds while you type.
  await p.resize(300, 640);
  const narrow = (await box(p, ".branch-menu")).width;
  assertInside(await box(p, ".branch-menu"), await viewport(p), "the menu after narrowing");
  await query(p, "main");
  assert.ok(Math.abs((await box(p, ".branch-menu")).width - narrow) < 0.5, "and holds its width there too");
  await closeMenu(p);
});

test("a new query starts the list at the top, its first group header in view", { skip }, async () => {
  const p = await open("dark", 320, 480);
  const many: LocalBranch[] = [
    ...FEW,
    ...Array.from({ length: 60 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(p, stateMessage({ local: many }));
  await p.eval(`document.querySelector(".bm-list").scrollTop = 400`);
  await p.type("item");
  const s = await p.eval<{ scrollTop: number; headerTop: number; listTop: number }>(`(function () {
    var list = document.querySelector(".bm-list");
    return { scrollTop: list.scrollTop, headerTop: list.querySelector(".bm-sep").getBoundingClientRect().top, listTop: list.getBoundingClientRect().top };
  })()`);
  assert.equal(s.scrollTop, 0, "scrolled to the top");
  assert.ok(s.headerTop >= s.listTop, `the first group header is in view: ${JSON.stringify(s)}`);
  await closeMenu(p);
});

test("a branch's name keeps the row's room: its upstream label gives way first", { skip }, async () => {
  for (const width of [260, 300, 340]) {
    const p = await open("dark", width, 640);
    const local: LocalBranch[] = [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: "bugfix/session-timeout-on-idle-tabs", upstream: "origin/bugfix/session-timeout-on-idle-tabs", upstreamOnRemote: true, ahead: 2, behind: 1 },
      { name: LONG, upstream: "origin/" + LONG, upstreamOnRemote: true },
    ];
    await openMenu(p, stateMessage({ local }));
    const rows = await p.eval<{ name: string; nameShown: number; nameWants: number; upShown: number }[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch"), function (r) {
      var n = r.querySelector(".bm-bname"), u = r.querySelector(".bm-bup");
      return { name: r.dataset.bname, nameShown: n.clientWidth, nameWants: n.scrollWidth, upShown: u ? u.getBoundingClientRect().width : 0 };
    })`);
    for (const r of rows) {
      if (r.nameWants > r.nameShown) {
        assert.ok(r.upShown <= 0.5, `${width}px: '${r.name}' is cut to ${r.nameShown}px of ${r.nameWants}px while its upstream label keeps ${r.upShown}px`);
      }
    }
    await closeMenu(p);
  }
});

// Beside ↑/↓ counts as wide as ↑1204 ↓37 a long name came down to "bugfix…"
// at 260px, the upstream label already gone. The counts give way too: the
// name keeps at least 45% of the row, or all of itself when it is shorter
// than that, and the counts are still in the tooltip and the spoken label.
test("a branch's name stays readable beside ↑/↓ counts: they give way before it falls under 45% of the row", { skip }, async () => {
  const BUGFIX = "bugfix/very-long-branch-name-that-keeps-going-and-going-to-see-the-ellipsis";
  const JIRA = "feature/JIRA-48213-migrate-the-authentication-flow-to-oauth2-with-pkce-and-refresh-tokens";
  const local: LocalBranch[] = [
    { name: "main", upstream: "origin/main", upstreamOnRemote: true, behind: 12 },
    { name: JIRA, current: true, upstream: "origin/" + JIRA, upstreamOnRemote: true, ahead: 3, behind: 118 },
    { name: BUGFIX, upstream: "upstream/" + BUGFIX, upstreamOnRemote: true, ahead: 1204, behind: 37, favorite: true },
    { name: "wip", upstream: "origin/wip" },
    { name: "short", upstream: "origin/short", upstreamOnRemote: true, ahead: 2, behind: 1 },
  ];
  type Row = { name: string; shown: number; wants: number; row: number; counts: number; label: string; tip: string };
  const measure = (p: ChangesPage): Promise<Row[]> =>
    p.eval<Row[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch"), function (r) {
      var n = r.querySelector(".bm-bname");
      var counts = Array.prototype.filter.call(r.querySelectorAll(".bm-ab"), function (a) { return a.getBoundingClientRect().width > 0; }).length;
      return { name: r.dataset.bname, shown: n.clientWidth, wants: n.scrollWidth, row: r.getBoundingClientRect().width,
        counts: counts, label: r.getAttribute("aria-label"), tip: r.title || r.dataset.tip || "" };
    })`);
  const check = (rows: Row[], at: string): void => {
    for (const r of rows) {
      const floor = Math.min(r.wants, 0.45 * r.row);
      assert.ok(r.shown >= floor - 0.5, `${at}: '${r.name.slice(0, 24)}…' shows ${r.shown}px of ${r.wants}px in a ${r.row}px row (at least ${Math.round(floor)}px)`);
    }
    const jira = rows.find((r) => r.name === JIRA)!;
    assert.match(jira.label, /3 to push, 118 to pull/, `${at}: the counts are still spoken`);
    assert.match(jira.tip, /3 to push, 118 to pull/, `${at}: and in the tooltip`);
  };
  for (const width of [260, 300, 340]) {
    const p = await open("dark", width, 640);
    await openMenu(p, stateMessage({ local, remote: ["origin/main"], recent: ["main", "wip"] }));
    const rows = await measure(p);
    check(rows, `${width}px`);
    // A short name beside its counts keeps them: only a name that needs the room takes it.
    assert.equal(rows.find((r) => r.name === "short")!.counts, 2, `${width}px: 'short' keeps its counts`);
    await closeMenu(p);
  }
  // Wide enough for both: the counts stay beside the long names.
  const p = await open("dark", 560, 640);
  await openMenu(p, stateMessage({ local, remote: ["origin/main"] }));
  const wide = await measure(p);
  check(wide, "560px");
  for (const r of wide) if (r.name === JIRA || r.name === BUGFIX) assert.equal(r.counts, 2, `560px: '${r.name.slice(0, 24)}…' keeps its counts`);
  // Narrowed with the menu open: the rows are fitted again.
  await p.resize(260, 640);
  check(await measure(p), "560px narrowed to 260px");
  await p.resize(560, 640);
  const again = await measure(p);
  for (const r of again) if (r.name === JIRA || r.name === BUGFIX) assert.equal(r.counts, 2, `widened again: '${r.name.slice(0, 24)}…' has its counts back`);
  await closeMenu(p);
});

test("an upstream deleted from its remote says so, even in a row too narrow for its name", { skip }, async () => {
  for (const width of [560, 260]) {
    const p = await open("dark", width, 640);
    const local: LocalBranch[] = [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: "merged-pr", upstream: "origin/merged-pr", gone: true },
      { name: LONG, upstream: "origin/" + LONG, gone: true },
    ];
    await openMenu(p, stateMessage({ local }));
    const rows = await p.eval<Record<string, { gone: string; goneShown: boolean; struck: boolean; label: string; tip: string }>>(`(function () {
      var out = {};
      document.querySelectorAll(".bm-list .bm-branch").forEach(function (r) {
        var g = r.querySelector(".bm-gone"), u = r.querySelector(".bm-bup");
        var gr = g && g.getBoundingClientRect(), rr = r.getBoundingClientRect();
        out[r.dataset.bname] = {
          gone: g ? g.textContent : "",
          goneShown: !!g && gr.width > 0 && gr.left >= rr.left && gr.right <= rr.right + 0.5,
          struck: !!u && getComputedStyle(u).textDecorationLine.indexOf("line-through") >= 0,
          label: r.getAttribute("aria-label"),
          tip: r.title || r.dataset.tip || "", // the page turns a title into its own tooltip
        };
      });
      return out;
    })()`);
    for (const name of ["merged-pr", LONG]) {
      const r = rows[name];
      assert.equal(r.gone, "gone", `${width}px: '${name}' says gone`);
      assert.ok(r.goneShown, `${width}px: and it can be seen: ${JSON.stringify(r)}`);
      assert.ok(r.struck, `${width}px: its upstream is struck through`);
      assert.match(r.label, /no longer exists/, "a screen reader hears it");
      assert.match(r.tip, /no longer exists/, "and the tooltip says it");
    }
    const live = rows["main"];
    assert.ok(!live.gone && !live.struck && !/no longer exists/.test(live.label + live.tip), `a live upstream is not: ${JSON.stringify(live)}`);
    await closeMenu(p);
  }
});

/** In-page colour maths: composite CSS colours bottom-first on a canvas, then WCAG contrast. */
const COLOUR = `
window.__px = function (layers) {
  var c = document.createElement("canvas"); c.width = c.height = 1;
  var x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, 1, 1);
  layers.forEach(function (l) { x.fillStyle = "#fff"; x.fillStyle = l; x.fillRect(0, 0, 1, 1); });
  var d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
};
window.__bgLayers = function (el) {
  var out = [];
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) out.unshift(getComputedStyle(n).backgroundColor);
  return out;
};
window.__lum = function (rgb) {
  var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
window.__contrast = function (a, b) {
  var la = __lum(a), lb = __lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** The text colour of el against what is painted behind it. */
window.__textContrast = function (el) {
  var bg = __bgLayers(el);
  return __contrast(__px(bg.concat([getComputedStyle(el).color])), __px(bg));
};
`;

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the upstream label and the group counts read at 4.5:1`, { skip }, async () => {
    const p = await open(theme, 400, 640);
    await p.eval(COLOUR);
    await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main"] }));
    const r = await p.eval<{ up: number; count: number }>(`({
      up: __textContrast(document.querySelector('.bm-branch[data-bname="feature"] .bm-bup')),
      count: __textContrast(document.querySelector(".bm-sep-count")),
    })`);
    assert.ok(r.up >= 4.5, `the upstream label: ${r.up.toFixed(2)}:1`);
    assert.ok(r.count >= 4.5, `a group count: ${r.count.toFixed(2)}:1`);
    await closeMenu(p);
  });

  // The hollow star is a control on every local row: 3:1, as a control needs.
  test(`${theme}: an empty star on a plain row reads at 3:1`, { skip }, async () => {
    const p = await open(theme, 400, 640);
    await p.eval(COLOUR);
    await openMenu(p, stateMessage({ local: FEW }));
    const r = await p.eval<{ on: boolean; ratio: number }>(`(function () {
      var s = document.querySelector('.bm-list .bm-branch[data-bname="spike/cache"] .bm-star');
      return { on: s.classList.contains("on"), ratio: __textContrast(s) };
    })()`);
    assert.ok(!r.on, "the row is not starred");
    assert.ok(r.ratio >= 3, `the empty star: ${r.ratio.toFixed(2)}:1`);
    await closeMenu(p);
  });

  test(`${theme}: the highlighted row still shows what matched, and its star`, { skip }, async () => {
    const p = await open(theme, 400, 640);
    await p.eval(COLOUR);
    await openMenu(p, stateMessage({ local: FEW }));
    await p.type("feat");
    const r = await p.eval<{ key: string; markBand: number; markText: number; differs: boolean; star: number }>(`(function () {
      var row = document.querySelector(".bm-list .is-active");
      var mark = row.querySelector(".bm-hl"), star = row.querySelector(".bm-star");
      var rowBg = __bgLayers(row), markBg = __bgLayers(mark);
      var ms = getComputedStyle(mark), rs = getComputedStyle(row);
      return {
        key: row.dataset.bmkey,
        // A mark shows as a band behind the letters, or as letters of their own colour.
        markBand: __contrast(__px(markBg), __px(rowBg)),
        markText: __contrast(__px(markBg.concat([ms.color])), __px(markBg)),
        differs: ms.color !== rs.color || ms.fontWeight !== rs.fontWeight,
        star: __textContrast(star),
      };
    })()`);
    assert.equal(r.key, "b:local:feature");
    const shows = r.markBand >= 3 || (r.differs && r.markText >= 3);
    assert.ok(shows, `the match stands out on the highlighted row: ${JSON.stringify(r)}`);
    assert.ok(r.star >= 3, `the star on the highlighted row: ${r.star.toFixed(2)}:1`);
    await closeMenu(p);
  });
}
