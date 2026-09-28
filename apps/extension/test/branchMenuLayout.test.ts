import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type LocalBranch, type VsCodeTheme } from "./changesPage";
import { jsLiteral } from "../../../scripts/test/js-literal.mjs";

// The branch menu's layout, as a state table over the view's size, the
// theme, the kind of ref and the query — in the real page commitView.ts
// serves, in a windowless Chrome with real keys and a real pointer:
//   · a ref's actions open beside the menu when the view has room there,
//     and otherwise IN the menu, in place of the list, under a back row
//     ('‹ feature'): never laid over the menu and the row they belong to.
//     The back row, Left and Escape return to the list, scrolled where it
//     was, the branch highlighted; typing returns and searches; a repaint
//     or a resize keeps the actions open with the same item highlighted —
//     found by what it is, when the repaint added or dropped items above
//     it — beside the menu or in it as the new size allows;
//   · every kind of ref lists its actions in one order, with a separator
//     only between groups that have items: at most four;
//   · a group's heading stays pinned while its rows scroll under it, and a
//     row brought into view is never left under it;
//   · remote branches are grouped by remote — a remote's name may hold a
//     slash — each group paged 40 at a time;
//   · a row names its upstream by the remote alone when it tracks the
//     branch of the same name there; a count past 999 reads 999+;
//   · a long name whose match lies past the row's end is cut in the middle,
//     so every matched letter is in sight; the whole name stays in the
//     tooltip and the spoken label;
//   · the chevron that says a row has actions is always drawn, at 3:1; a
//     match reads at 3:1 on a plain row, the highlighted row and the
//     current branch's bold one; the detached line and a remote's name in
//     its heading read at 4.5:1 — in every theme.

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
const JIRA = "feature/JIRA-48213-migrate-the-authentication-flow-to-oauth2-with-pkce-and-refresh-tokens";
const LOCAL: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 2, behind: 1 },
  { name: "topic" },
  { name: "merged-pr", upstream: "origin/merged-pr", gone: true },
];
const REMOTE = ["origin/main", "origin/feature", "upstream/fixes"];
const STATE = stateMessage({ local: LOCAL, remote: REMOTE, tags: ["v1.0"] });

async function openMenu(p: ChangesPage, state: unknown = STATE): Promise<void> {
  await p.eval(`(function () { if (document.querySelector(".branch-menu")) document.getElementById("branch-pill").click(); window.__posted.length = 0; })()`);
  await p.send(state);
  await p.send({ type: "openBranchMenu" });
  await p.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  await p.eval(`new Promise(function (r) { setTimeout(r, 20); })`);
}
async function query(p: ChangesPage, q: string): Promise<void> {
  await p.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  if (q) await p.type(q);
}
/** The highlight onto a row by its key, the way the arrows get there. */
async function arrowTo(p: ChangesPage, key: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const on = await p.eval<string>(`(function () { var a = document.querySelector(".bm-list .is-active"); return a ? a.dataset.bmkey : ""; })()`);
    if (on === key) return;
    await p.key("ArrowDown");
  }
  throw new Error(`never reached ${key}`);
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (p: ChangesPage, sel: string): Promise<Box> =>
  p.eval<Box>(`(function () { var r = document.querySelector(${jsLiteral(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
function inside(inner: Box, outer: { left: number; top: number; right: number; bottom: number }, what: string): void {
  const m = 0.5;
  assert.ok(
    inner.left >= outer.left - m && inner.right <= outer.right + m && inner.top >= outer.top - m && inner.bottom <= outer.bottom + m,
    `${what}: ${JSON.stringify(inner)} inside ${JSON.stringify(outer)}`,
  );
}

/** Where a ref's actions opened, and what the page looks like around them. */
interface Placement {
  mode: "drilled" | "beside" | "none";
  sub: Box;
  menu: Box;
  listShown: boolean;
  back: string;
  row: Box | null;
  vw: number;
  vh: number;
}
const placement = (p: ChangesPage): Promise<Placement> =>
  p.eval<Placement>(`(function () {
    var s = document.querySelector(".branch-submenu"), m = document.querySelector(".branch-menu");
    var rb = function (e) { var r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    var open = document.querySelector(".bm-list .is-open");
    return {
      mode: !s ? "none" : m.contains(s) ? "drilled" : "beside",
      sub: s ? rb(s) : null, menu: rb(m),
      listShown: getComputedStyle(document.querySelector(".bm-list")).display !== "none",
      back: s ? s.querySelector(".bm-subhead").textContent.trim() : "",
      row: open && open.getClientRects().length ? rb(open) : null,
      vw: innerWidth, vh: innerHeight,
    };
  })()`);

const REFS: [string, string][] = [
  ["the current branch", "b:local:main"],
  ["a local branch with an upstream", "b:local:feature"],
  ["a local branch with none", "b:local:topic"],
  ["a local branch whose upstream is gone", "b:local:merged-pr"],
  ["a remote branch on a second remote", "b:remote:upstream/fixes"],
  ["a tag", "b:tag:v1.0"],
];

// Whether there is room beside the menu depends on the view's width and on
// the menu's own, which its longest name sets: both are axes.
const WIDE = stateMessage({ local: [...LOCAL, { name: LONG, upstream: "origin/" + LONG }], remote: REMOTE, tags: ["v1.0"] });
for (const [width, height, names, expect] of [
  [260, 640, "short", "drilled"], [300, 380, "short", "drilled"], [340, 640, "short", "drilled"],
  [560, 640, "short", "drilled"], [640, 640, "short", "beside"], [560, 640, "long", "drilled"], [900, 640, "long", "beside"],
] as const) {
  test(`${width}×${height}, ${names} names: a ref's actions open ${expect === "drilled" ? "in the menu, under a back row" : "beside the menu"}, every item reachable — for every kind of ref`, { skip }, async () => {
    const p = await open("dark", width, height);
    await openMenu(p, names === "long" ? WIDE : STATE);
    for (const [what, key] of REFS) {
      await query(p, "");
      await arrowTo(p, key);
      await p.key("ArrowRight");
      const at = await placement(p);
      const vp = { left: 0, top: 0, right: at.vw, bottom: at.vh };
      assert.equal(at.mode, expect, `${what}`);
      inside(at.sub, vp, `${what}: the actions are inside the view`);
      if (expect === "drilled") {
        assert.equal(at.listShown, false, `${what}: in place of the list`);
        inside(at.sub, at.menu, `${what}: inside the menu`);
        assert.equal(at.back, key.replace(/^b:[a-z]+:/, ""), `${what}: the back row names the ref`);
      } else {
        assert.ok(at.listShown, `${what}: the list stays`);
        assert.ok(at.sub.left >= at.menu.right - 3 || at.sub.right <= at.menu.left + 3, `${what}: beside the menu, not over it: ${JSON.stringify(at)}`);
        assert.ok(at.row && at.row.width > 0, `${what}: the row they belong to stays in sight, marked`);
      }
      // Every item can be reached, and is shown when highlighted.
      const n = await p.eval<number>(`document.querySelectorAll(".branch-submenu .bm-subaction").length`);
      for (let i = 1; i < n; i++) await p.key("ArrowDown");
      const last = await p.eval<{ label: string; item: Box; clip: Box }>(`(function () {
        var a = document.querySelector(".branch-submenu .is-active"), l = a.parentElement;
        var r = a.getBoundingClientRect(), c = l.getBoundingClientRect();
        return { label: a.textContent.trim(), item: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
          clip: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, width: c.width, height: c.height } };
      })()`);
      inside(last.item, last.clip, `${what}: its last item '${last.label}' scrolled into sight`);
      inside(last.item, vp, `${what}: and inside the view`);
      await p.key("ArrowLeft");
      const back = await placement(p);
      assert.equal(back.mode, "none", `${what}: Left closes them`);
      assert.ok(back.listShown, `${what}: the list is back`);
      assert.equal(await p.eval(`document.querySelector(".bm-list .is-active").dataset.bmkey`), key, `${what}: its row highlighted`);
    }
  });
}

// Whether there is room beside the menu is the view's and the menu's to
// say, not the ref's: a ref's labels quote its name, so its actions' own
// width differs from row to row, and deciding by it opened one row's
// actions beside the menu and the next row's in it.
test("in one menu at one width, every ref's actions open the same way, whatever the length of its name", { skip }, async () => {
  const state = stateMessage({
    local: [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: "topic" },
      { name: "fix/pay-7", upstream: "origin/fix/pay-7", upstreamOnRemote: true },
      { name: "feat/pay-v2", upstream: "origin/feat/pay-v2", upstreamOnRemote: true },
    ],
    remote: ["origin/main", "origin/fix/pay-7"],
    tags: ["v1.0"],
  });
  const keys = ["b:local:main", "b:local:topic", "b:local:fix/pay-7", "b:local:feat/pay-v2", "b:remote:origin/fix/pay-7", "b:tag:v1.0"];
  const seen: Record<number, string> = {};
  for (const width of [480, 500, 520, 560, 580, 600, 640, 900]) {
    const p = await open("dark", width, 640);
    await openMenu(p, state);
    const modes: Record<string, { mode: string; sub: number }> = {};
    for (const key of keys) {
      await query(p, "");
      await arrowTo(p, key);
      await p.key("ArrowRight");
      const at = await placement(p);
      modes[key] = { mode: at.mode, sub: Math.round(at.sub.width) };
      inside(at.sub, { left: 0, top: 0, right: at.vw, bottom: at.vh }, `${width}px ${key}: inside the view`);
      await p.key("ArrowLeft");
    }
    const kinds = new Set(Object.values(modes).map((m) => m.mode));
    assert.equal(kinds.size, 1, `${width}px: one way for every ref: ${JSON.stringify(modes)}`);
    seen[width] = [...kinds][0];
  }
  assert.equal(seen[480], "drilled");
  assert.equal(seen[900], "beside");
});

test("drilled in: the back row, Left and Escape return to the list where it was; typing returns and searches", { skip }, async () => {
  const p = await open("dark", 300, 480);
  const many: LocalBranch[] = [...LOCAL, ...Array.from({ length: 40 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` }))];
  await openMenu(p, stateMessage({ local: many, remote: REMOTE }));
  await arrowTo(p, "b:local:work/item-30");
  const scrolled = await p.eval<number>(`document.querySelector(".bm-list").scrollTop`);
  assert.ok(scrolled > 100, `the list is scrolled down (${scrolled})`);
  const where = async (): Promise<{ scroll: number; key: string; inView: boolean; menuOpen: boolean; focus: boolean }> =>
    p.eval(`(function () {
      var l = document.querySelector(".bm-list"), a = l.querySelector(".is-active");
      var lr = l.getBoundingClientRect(), r = a ? a.getBoundingClientRect() : null;
      return { scroll: l.scrollTop, key: a ? a.dataset.bmkey : "", inView: !!r && r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1,
        menuOpen: !!document.querySelector(".branch-menu"), focus: document.activeElement === document.querySelector(".bm-search input") };
    })()`);

  // The back row, by the pointer.
  await p.key("ArrowRight");
  assert.equal((await placement(p)).mode, "drilled");
  const head = await box(p, ".branch-submenu .bm-subhead");
  await p.mouseMove(head.left + 20, head.top + head.height / 2);
  await p.click(head.left + 20, head.top + head.height / 2);
  let w = await where();
  assert.equal((await placement(p)).mode, "none", "the back row returns");
  assert.deepEqual(w, { scroll: scrolled, key: "b:local:work/item-30", inView: true, menuOpen: true, focus: true });

  // Escape: back to the list, the menu stays open.
  await p.key("ArrowRight");
  await p.key("ArrowDown");
  await p.key("Escape");
  w = await where();
  assert.equal((await placement(p)).mode, "none");
  assert.deepEqual(w, { scroll: scrolled, key: "b:local:work/item-30", inView: true, menuOpen: true, focus: true }, "Escape returns");

  // Typing: back to the list, searching.
  await p.key("ArrowRight");
  await p.type("topic");
  assert.equal((await placement(p)).mode, "none", "typing returns");
  assert.equal((await where()).key, "b:local:topic");
});

test("drilled in, the actions survive a repaint from the host, and a resize puts them beside the menu or back in it", { skip }, async () => {
  const p = await open("dark", 300, 640);
  await openMenu(p);
  await query(p, "feature");
  await p.key("ArrowRight");
  await p.key("ArrowDown");
  await p.key("ArrowDown");
  const item = await p.eval<string>(`document.querySelector(".branch-submenu .is-active").textContent.trim()`);
  // The host repaints (a fetch changed the counts).
  await p.send(stateMessage({ local: LOCAL.map((b) => (b.name === "feature" ? { ...b, ahead: 5 } : b)), remote: REMOTE, tags: ["v1.0"] }));
  let at = await placement(p);
  assert.equal(at.mode, "drilled", "still drilled in");
  assert.equal(await p.eval(`document.querySelector(".branch-submenu .is-active").textContent.trim()`), item, "the same item highlighted");
  // Widened: room beside the menu now.
  await p.resize(900, 640);
  at = await placement(p);
  assert.equal(at.mode, "beside", "the wider view has room beside the menu");
  assert.equal(await p.eval(`document.querySelector(".branch-submenu .is-active").textContent.trim()`), item);
  assert.equal(await p.eval(`document.querySelector(".branch-submenu .bm-subhead-name").textContent`), "feature");
  // Narrowed again: back in the menu.
  await p.resize(300, 640);
  at = await placement(p);
  assert.equal(at.mode, "drilled");
  assert.equal(await p.eval(`document.querySelector(".branch-submenu .is-active").textContent.trim()`), item);
  inside(at.sub, { left: 0, top: 0, right: at.vw, bottom: at.vh }, "inside the view");
});

// A repaint can change which actions a ref has — an upstream appears (a
// push set it), or goes (a fetch pruned it) — and so every item's place.
// The highlight is what Enter runs: it stays on the item it was on, found by
// what it is, beside the menu and drilled in, and through a resize after.
// An item the repaint took away hands the highlight to the first item —
// never to whatever took its place.
test("a repaint that adds or drops a ref's actions keeps the highlight on the same action, and Enter runs it", { skip }, async () => {
  const active = (p: ChangesPage): Promise<string> =>
    p.eval<string>(`(function () { var a = document.querySelector(".branch-submenu .is-active"); return a ? a.textContent.trim() : ""; })()`);
  const walkTo = async (p: ChangesPage, label: string | RegExp): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      const on = await active(p);
      if (typeof label === "string" ? on === label : label.test(on)) return;
      await p.key("ArrowDown");
    }
    throw new Error(`never reached ${label}`);
  };
  const live = LOCAL.map((b) => (b.name === "topic" ? { ...b, upstream: "origin/topic", upstreamOnRemote: true } : b));
  const pruned = LOCAL.map((b) => (b.name === "feature" ? { ...b, gone: true, upstreamOnRemote: false, ahead: 0, behind: 0 } : b));
  for (const [width, mode] of [[900, "beside"], [300, "drilled"]] as const) {
    const p = await open("dark", width, 640);
    // The upstream goes: Set Tracked Branch… comes first, Pull into and Reset go.
    await openMenu(p);
    await query(p, "feature");
    await p.key("ArrowRight");
    await walkTo(p, "Add to Favorites");
    await p.send(stateMessage({ local: pruned, remote: REMOTE.filter((r) => r !== "origin/feature"), tags: ["v1.0"] }));
    assert.equal((await placement(p)).mode, mode);
    assert.equal(await p.eval(`document.querySelector(".branch-submenu .bm-subaction").textContent.trim()`), "Set Tracked Branch…", `${width}px: the list did change`);
    assert.equal(await active(p), "Add to Favorites", `${width}px: an upstream gone, the highlight on the same action`);
    await p.resize(width === 900 ? 300 : 900, 640);
    assert.equal(await active(p), "Add to Favorites", `${width}px: and through a resize after it`);
    await p.resize(width, 640);
    await p.eval(`window.__posted.length = 0`);
    await p.key("Enter");
    assert.deepEqual((await p.posted()).filter((m) => m.type === "branchAction" || m.type === "branchRefCommand"),
      [{ type: "branchAction", action: "favorite", ref: "feature" }], `${width}px: Enter runs the action it is on`);

    // An upstream appears: Pull into, Tracked Branch and Reset come in above.
    await openMenu(p);
    await query(p, "topic");
    await p.key("ArrowRight");
    await walkTo(p, "Copy Branch Name");
    const items = (): Promise<string[]> => p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`);
    const was = (await items()).indexOf("Copy Branch Name");
    await p.send(stateMessage({ local: live, remote: [...REMOTE, "origin/topic"], tags: ["v1.0"] }));
    assert.ok((await items()).includes("Pull into 'topic'"), `${width}px: the list did change: ${(await items()).join(" | ")}`);
    assert.notEqual((await items()).indexOf("Copy Branch Name"), was, `${width}px: and the action moved`);
    assert.equal(await active(p), "Copy Branch Name", `${width}px: an upstream appeared, the highlight on the same action`);

    // The action it was on is gone: the first item, not whatever is there now.
    await openMenu(p);
    await query(p, "feature");
    await p.key("ArrowRight");
    await walkTo(p, /^Pull 1 Commit into 'feature'/);
    await p.send(stateMessage({ local: pruned, remote: REMOTE.filter((r) => r !== "origin/feature"), tags: ["v1.0"] }));
    assert.equal(await active(p), "Set Tracked Branch…", `${width}px: a pull that is gone hands the highlight to the first item`);
  }
});

// The groups every action belongs to, in order, and each action's place.
const ORDER: [number, RegExp][] = [
  [0, /^Set Tracked Branch…$/], // first only for a gone upstream (below)
  [0, /^Checkout( Tag \(detached\))?$/],
  [0, /^Pull using Rebase$/],
  [0, /^Pull using Merge$/],
  [0, /^Pull( \d+ Commits?)? into '/],
  [0, /^New Branch from '/],
  [0, /^New Worktree from '/],
  [1, /^Compare with /],
  [1, /^Merge '/],
  [1, /^Rebase /],
  [2, /^Push…$|^Push Tag to Remote…$/],
  [2, /^Tracked Branch: |^Set Tracked Branch…$/],
  [3, /^Rename…$/],
  [3, /^Copy (Branch|Tag) Name$/],
  [3, /^(Add to|Remove from) Favorites$/],
  [4, /^Reset to '/],
  [4, /^Delete( Tag)?$/],
];

test("every kind of ref lists its actions in one order, with at most four separators, only between groups", { skip }, async () => {
  const p = await open("dark", 900, 800);
  await openMenu(p);
  for (const [what, key] of REFS) {
    await query(p, "");
    await arrowTo(p, key);
    await p.key("ArrowRight");
    const items = await p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-sublist > *"), function (n) {
      return n.classList.contains("bm-subsep") ? "|" : n.textContent.trim();
    })`);
    await p.key("ArrowLeft");
    const labels = items.filter((x) => x !== "|");
    assert.ok(items[0] !== "|" && items[items.length - 1] !== "|", `${what}: no separator at either end: ${items.join(" ")}`);
    assert.ok(!items.join("\n").includes("|\n|"), `${what}: no two separators together`);
    assert.ok(items.filter((x) => x === "|").length <= 4, `${what}: at most four separators: ${items.join(" ")}`);
    const gone = key === "b:local:merged-pr";
    let last = -1;
    let group = -1;
    let sinceSep = true;
    for (const it of items) {
      if (it === "|") { sinceSep = true; continue; }
      const place = ORDER.findIndex(([, re], i) => re.test(it) && (i !== 0 || gone));
      assert.ok(place >= 0, `${what}: '${it}' has a place in the order`);
      if (!(gone && place === 0)) assert.ok(place > last, `${what}: '${it}' comes after the item before it: ${labels.join(" | ")}`);
      last = Math.max(last, place);
      const g = ORDER[place][0];
      // A separator exactly where the group changes.
      if (group >= 0 && !(gone && place === 0)) {
        assert.equal(sinceSep, g !== group, `${what}: a separator ${g !== group ? "between" : "never inside"} groups, at '${it}': ${items.join(" ")}`);
      }
      group = g;
      sinceSep = false;
    }
    if (gone) assert.equal(labels[0], "Set Tracked Branch…", `${what}: starts with Set Tracked Branch…`);
  }
});

test("a group's heading stays pinned while its rows scroll under it; a row brought into view is never under it", { skip }, async () => {
  const p = await open("dark", 320, 480);
  const remote = [...REMOTE, ...Array.from({ length: 30 }, (_, i) => `origin/topic/item-${String(i).padStart(2, "0")}`)];
  await openMenu(p, stateMessage({ local: LOCAL, remote, tags: ["v1.0"] }));
  await p.eval(`document.querySelector(".bm-list").scrollTop = 520`);
  const pinned = await p.eval<{ label: string; top: number; listTop: number; position: string; bg: string; covers: string }>(`(function () {
    var l = document.querySelector(".bm-list"), lr = l.getBoundingClientRect();
    // The row at the top of the list, and its group's heading.
    var row = document.elementFromPoint(lr.left + lr.width / 2, lr.top + 40).closest("[data-bmkey]");
    var head = row.closest(".bm-group").querySelector(".bm-sep");
    var cs = getComputedStyle(head);
    var onTop = document.elementFromPoint(lr.left + 30, lr.top + 10);
    return { label: head.textContent.trim(), top: head.getBoundingClientRect().top, listTop: lr.top, position: cs.position, bg: cs.backgroundColor,
      covers: onTop && onTop.closest(".bm-sep") === head ? "heading" : (onTop ? onTop.className : "") };
  })()`);
  assert.match(pinned.label, /^Remote\s*origin/);
  assert.equal(pinned.position, "sticky");
  assert.ok(Math.abs(pinned.top - pinned.listTop) < 1, `pinned at the list's top: ${JSON.stringify(pinned)}`);
  assert.equal(pinned.covers, "heading", "on top of the rows scrolling under it");
  assert.doesNotMatch(pinned.bg, /rgba\(.*, 0\)|transparent/, "and opaque, so they do not show through");

  // Up from below: the row the arrows reach is below the pinned heading.
  await arrowTo(p, "b:remote:origin/topic/item-20");
  for (let i = 0; i < 12; i++) {
    await p.key("ArrowUp");
    const r = await p.eval<{ key: string; rowTop: number; headBottom: number }>(`(function () {
      var a = document.querySelector(".bm-list .is-active"), g = a.closest(".bm-group");
      return { key: a.dataset.bmkey, rowTop: a.getBoundingClientRect().top, headBottom: g ? g.querySelector(".bm-sep").getBoundingClientRect().bottom : -1 };
    })()`);
    assert.ok(r.rowTop >= r.headBottom - 0.5, `${r.key} is not under its heading: ${JSON.stringify(r)}`);
  }
});

test("remote branches are grouped by remote — a slash in a remote's name too — and paged 40 at a time", { skip }, async () => {
  const p = await open("dark", 420, 640);
  const remote = [
    "origin/main",
    ...Array.from({ length: 55 }, (_, i) => `origin/topic/item-${String(i).padStart(2, "0")}`),
    "team/eu/feature",
    "team/eu/fix/x",
  ];
  const state = stateMessage({ local: LOCAL, remote });
  (state.branches as Record<string, unknown>).remoteNames = ["origin", "team/eu"];
  await openMenu(p, state);
  const groups = (): Promise<{ label: string; name: string; nameCase: string; count: string; rows: string[]; more: string }[]> =>
    p.eval(`Array.prototype.filter.call(document.querySelectorAll(".bm-list .bm-group"), function (g) { return /Remote/.test(g.querySelector(".bm-sep-label").textContent); })
      .map(function (g) {
        var n = g.querySelector(".bm-sep-remote"), more = g.querySelector(".bm-more");
        return { label: g.querySelector(".bm-sep-label").textContent, name: n ? n.textContent : "", nameCase: n ? getComputedStyle(n).textTransform : "",
          count: g.querySelector(".bm-sep-count").textContent,
          rows: Array.prototype.map.call(g.querySelectorAll(".bm-branch"), function (r) { return r.dataset.bname + "=" + r.querySelector(".bm-bname").textContent; }),
          more: more ? more.textContent : "" };
      })`);
  let g = await groups();
  assert.deepEqual(g.map((x) => [x.name, x.nameCase, x.count]), [["origin", "none", "56"], ["team/eu", "none", "2"]]);
  assert.deepEqual(g[1].rows, ["team/eu/feature=feature", "team/eu/fix/x=fix/x"], "rows named without the remote");
  assert.equal(g[0].rows.length, 40, "origin: the first 40");
  assert.equal(g[0].more, "Show 16 more");
  const tip = await p.eval<string>(`document.querySelector('.bm-branch[data-bname="team/eu/fix/x"]').dataset.tip || document.querySelector('.bm-branch[data-bname="team/eu/fix/x"]').title`);
  assert.match(tip, /^team\/eu\/fix\/x/, "the whole name in the tooltip");

  // Enter on "Show more": the rest, the highlight on the first of them.
  await arrowTo(p, "more:remote:origin");
  await p.key("Enter");
  g = await groups();
  assert.equal(g[0].rows.length, 56);
  assert.equal(g[0].more, "");
  assert.equal(await p.eval(`document.querySelector(".bm-list .is-active").dataset.bmkey`), "b:remote:origin/topic/item-39");

  // A query starts from the first page again.
  await query(p, "item");
  g = await groups();
  assert.equal(g[0].rows.length, 40);
  assert.equal(g[0].more, "Show 15 more");

  // A host that lists no remotes (an older one): grouped by the first path segment.
  const bare = stateMessage({ local: LOCAL, remote: ["origin/main", "team/eu/feature"] });
  await openMenu(p, bare);
  g = await groups();
  assert.deepEqual(g.map((x) => x.name), ["origin", "team"]);
});

// What a screen reader meets: a group's heading named in words ("Remote
// origin, 56 branches" — from its text it was "REMOTEorigin 56": the
// remote's name is set off by a margin, not a space), and, drilled in, a
// back row that is a button saying where it goes, with the actions' list
// saying which keys go back.
test("a screen reader hears each group's heading in words, and the drilled-in back row as a way back", { skip }, async () => {
  type AXNode = { nodeId: string; role?: { value: string }; name?: { value: string }; description?: { value: string }; ignored?: boolean; backendDOMNodeId?: number };
  const tree = async (p: ChangesPage): Promise<AXNode[]> =>
    ((await p.page.send("Accessibility.getFullAXTree", {})) as { nodes: AXNode[] }).nodes.filter((n) => !n.ignored);
  const p = await open("dark", 300, 640);
  const state = stateMessage({ local: LOCAL, remote: [...REMOTE, "team/eu/x", "team/eu/y"], tags: ["v1.0"] });
  (state.branches as Record<string, unknown>).remoteNames = ["origin", "upstream", "team/eu"];
  await openMenu(p, state);
  // The headings: every button of the branch menu's list that is not a row (a row is an option).
  const headings = (await tree(p)).filter((n) => n.role?.value === "button" && /^(Local|Remote|Tags|Favorites|Recents)/i.test(n.name?.value ?? "")).map((n) => n.name?.value);
  assert.deepEqual(headings, ["Local, 4 branches", "Remote origin, 2 branches", "Remote upstream, 1 branch", "Remote team/eu, 2 branches", "Tags, 1 tag"]);

  await query(p, "feature");
  await p.key("ArrowRight");
  assert.equal((await placement(p)).mode, "drilled");
  const nodes = await tree(p);
  const back = nodes.filter((n) => n.role?.value === "button" && n.name?.value === "Back to the branches");
  assert.equal(back.length, 1, "the back row is a button named for where it goes");
  const head = await p.eval<{ role: string | null; tab: number; focusable: boolean }>(`(function () {
    var h = document.querySelector(".branch-submenu .bm-subhead");
    return { role: h.getAttribute("role"), tab: h.tabIndex, focusable: h.tabIndex >= 0 };
  })()`);
  assert.deepEqual(head, { role: "button", tab: -1, focusable: false }, "no Tab stop: focus stays in the search box");
  const listbox = nodes.find((n) => n.role?.value === "listbox" && /^Actions for feature/.test(n.name?.value ?? ""));
  assert.ok(listbox, "the actions' listbox");
  assert.equal(listbox.description?.value, "Left or Escape goes back to the branches");
  const hint = await p.eval<{ w: number; h: number }>(`(function () { var r = document.getElementById("bm-back-hint").getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
  assert.ok(hint.w <= 1 && hint.h <= 1, `the hint is for a screen reader only: ${JSON.stringify(hint)}`);
  // Beside the menu there is no back row: the title band is left out.
  await p.resize(900, 640);
  assert.equal((await placement(p)).mode, "beside");
  assert.equal((await tree(p)).filter((n) => n.name?.value === "Back to the branches").length, 0);
});

test("a row names its upstream by the remote alone when it tracks the same name there — in full when it is gone; counts past 999 read 999+", { skip }, async () => {
  const p = await open("dark", 560, 640);
  const local: LocalBranch[] = [
    { name: "main", current: true, upstream: "origin/main" },
    { name: "renamed", upstream: "origin/other-name" },
    { name: "tracks-local", upstream: "main" },
    { name: "x", upstream: "feature/x" },
    { name: "big", upstream: "origin/big", ahead: 1204, behind: 37 },
    { name: "merged-pr", upstream: "origin/merged-pr", gone: true },
  ];
  const state = stateMessage({ local, remote: ["origin/main"] });
  (state.branches as Record<string, unknown>).remoteNames = ["origin"];
  await openMenu(p, state);
  const rows = await p.eval<Record<string, { up: string; struck: boolean; counts: string[]; tip: string }>>(`(function () {
    var out = {};
    document.querySelectorAll(".bm-list .bm-branch").forEach(function (r) {
      var u = r.querySelector(".bm-bup");
      out[r.dataset.bname] = { up: u ? u.textContent : "", struck: !!u && getComputedStyle(u).textDecorationLine === "line-through",
        counts: Array.prototype.map.call(r.querySelectorAll(".bm-ab"), function (a) { return a.textContent; }), tip: r.dataset.tip || r.title };
    });
    return out;
  })()`);
  assert.equal(rows["main"].up, "origin");
  assert.equal(rows["main"].struck, false);
  // 'origin' struck through would say the remote is gone.
  assert.deepEqual([rows["merged-pr"].up, rows["merged-pr"].struck], ["origin/merged-pr", true], "a gone upstream: in full, struck through");
  assert.equal(rows["renamed"].up, "origin/other-name", "another name there: said in full");
  assert.equal(rows["tracks-local"].up, "main", "a local branch: said in full");
  assert.equal(rows["x"].up, "feature/x", "'feature' is no remote here, so not cut to it");
  assert.deepEqual(rows["big"].counts, ["↑999+", "↓37"]);
  assert.match(rows["big"].tip, /origin\/big.*1204 to push, 37 to pull/, "the tooltip has the whole upstream and the real count");
});

test("a long name whose match lies past the row's end is cut in the middle: every matched letter in sight", { skip }, async () => {
  const local: LocalBranch[] = [
    { name: "main", current: true, upstream: "origin/main" },
    { name: LONG, upstream: "origin/" + LONG, ahead: 3, behind: 118 },
    { name: JIRA, upstream: "origin/" + JIRA },
  ];
  for (const width of [260, 300, 340]) {
    const p = await open("dark", width, 640);
    await openMenu(p, stateMessage({ local, remote: ["origin/" + LONG, "origin/" + JIRA] }));
    // A run of letters, then scattered ones — the first letter the name's
    // own ("fbilling"), or not ("cv2"), the last far past the row's end.
    for (const q of ["billing", "customers-v2", "oauth2", "refresh-tokens", "pkce", "feature/chec", "jira",
      "fbilling", "fval", "fcv2", "fintern", "cv2", "frefresh", "ftok"]) {
      await query(p, q);
      const rows = await p.eval<{ name: string; shown: string; label: string; tip: string; nameBox: Box; marks: Box[]; marked: string }[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch"), function (r) {
        var n = r.querySelector(".bm-bname"), nb = n.getBoundingClientRect();
        return { name: r.dataset.bname, shown: n.textContent, label: r.getAttribute("aria-label"), tip: r.dataset.tip || r.title,
          nameBox: { left: nb.left, top: nb.top, right: nb.right, bottom: nb.bottom, width: nb.width, height: nb.height },
          marks: Array.prototype.map.call(n.querySelectorAll(".bm-hl"), function (m) { var b = m.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; }),
          marked: Array.prototype.map.call(n.querySelectorAll(".bm-hl"), function (m) { return m.textContent; }).join("") };
      })`);
      assert.ok(rows.length > 0, `${width}px '${q}': rows`);
      for (const r of rows) {
        assert.equal(r.marked.toLowerCase(), q.replace(/\s/g, "").toLowerCase(), `${width}px '${q}': '${r.shown}' marks every letter of the query`);
        for (const m of r.marks) {
          assert.ok(m.left >= r.nameBox.left - 0.5 && m.right <= r.nameBox.right + 0.5,
            `${width}px '${q}': the match is in sight in '${r.shown}' (${Math.round(m.left)}–${Math.round(m.right)} in ${Math.round(r.nameBox.left)}–${Math.round(r.nameBox.right)})`);
        }
        assert.ok(r.label.startsWith(r.name) && r.tip.startsWith(r.name), `${width}px '${q}': the whole name in the spoken label and the tooltip`);
        // A match that starts the name keeps the name's first path segment
        // in sight, whole — the same on every row with that name.
        if (q.startsWith("f")) assert.ok(r.shown.startsWith("feature/"), `${width}px '${q}': '${r.shown}' still starts as the name does`);
      }
      if (q === "feature/chec") {
        // (A remote branch's row shows its name without the remote.)
        for (const r of rows) assert.ok(r.name.endsWith("/" + r.shown) || r.name === r.shown, `a match at the start is never cut out: '${r.shown}'`);
      }
    }
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
window.__textContrast = function (el) {
  var bg = __bgLayers(el);
  return __contrast(__px(bg.concat([getComputedStyle(el).color])), __px(bg));
};
/** How a mark stands out from the name around it: a band, or letters of another colour. */
window.__markStandsOut = function (mark) {
  var name = mark.parentElement;
  var band = __contrast(__px(__bgLayers(mark)), __px(__bgLayers(name)));
  var hue = __contrast(__px(__bgLayers(mark).concat([getComputedStyle(mark).color])), __px(__bgLayers(name).concat([getComputedStyle(name).color])));
  return { band: band, hue: hue, text: __textContrast(mark) };
};
`;

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the chevron on every row, a match on any row, the detached line and a remote's name are readable`, { skip }, async () => {
    const p = await open(theme, 420, 640);
    await p.eval(COLOUR);
    await openMenu(p);
    const chevrons = await p.eval<{ key: string; visible: boolean; ratio: number }[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch"), function (r) {
      var c = r.querySelector(".bm-bmore"), cs = getComputedStyle(c);
      return { key: r.dataset.bmkey, visible: cs.visibility === "visible" && parseFloat(cs.opacity) === 1 && c.getBoundingClientRect().width > 0, ratio: __textContrast(c) };
    })`);
    for (const c of chevrons) {
      assert.ok(c.visible, `${c.key}: its chevron is drawn`);
      assert.ok(c.ratio >= 3, `${c.key}: its chevron at ${c.ratio.toFixed(2)}:1`);
    }
    assert.ok((await p.eval<number>(`__textContrast(document.querySelector(".bm-sep-remote"))`)) >= 4.5, "a remote's name in its heading");

    // 'ma': the current branch 'main' (bold, in the accent colour) and the
    // remote 'main'; the highlight is on the current one.
    await query(p, "ma");
    const marks = await p.eval<{ key: string; active: boolean; band: number; hue: number; text: number }[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch .bm-hl"), function (m) {
      var r = m.closest(".bm-branch"), o = __markStandsOut(m);
      return { key: r.dataset.bmkey, active: r.classList.contains("is-active"), band: o.band, hue: o.hue, text: o.text };
    })`);
    assert.ok(marks.some((m) => m.active) && marks.some((m) => !m.active), JSON.stringify(marks));
    for (const m of marks) {
      assert.ok(m.text >= 3, `${m.key}${m.active ? " (highlighted)" : ""}: the matched letters at ${m.text.toFixed(2)}:1`);
      assert.ok(m.band >= 1.15 || m.hue >= 1.5, `${m.key}${m.active ? " (highlighted)" : ""}: the match stands out from the name: ${JSON.stringify(m)}`);
    }

    // The line a detached HEAD shows where Pull and Push were.
    await openMenu(p, { ...stateMessage({ local: LOCAL.map((b) => ({ ...b, current: false })) }), branch: "a1b2c3d", detached: true, upstream: undefined });
    const why = await p.eval<number>(`__textContrast(document.querySelector(".bm-why span"))`);
    assert.ok(why >= 4.5, `the detached line at ${why.toFixed(2)}:1`);
  });
}

test("the menu keeps its width while a long query is typed, and takes the whole list's width when the branches arrive after typing", { skip }, async () => {
  const p = await open("dark", 560, 640);
  const local: LocalBranch[] = [...LOCAL, { name: LONG, upstream: "origin/" + LONG }];
  await openMenu(p, stateMessage({ local, remote: REMOTE }));
  const whole = (await box(p, ".branch-menu")).width;
  await query(p, "a-new-branch-name-long-enough-to-overflow-the-row-it-is-offered-in-" + "x".repeat(60));
  assert.ok(Math.abs((await box(p, ".branch-menu")).width - whole) < 0.5, "a long query does not push the menu out");
  const offer = await p.eval<{ sw: number; cw: number }>(`(function () { var s = document.querySelector('[data-bmkey="a:newNamed"] span'); return { sw: s.scrollWidth, cw: s.clientWidth }; })()`);
  assert.ok(offer.sw > offer.cw, "the offer's label is cut instead");

  // Typed while loading: when the branches arrive, the whole list's width.
  const first = stateMessage({ local });
  delete first.branches;
  await openMenu(p, first);
  await query(p, "main");
  const loading = (await box(p, ".branch-menu")).width;
  await p.send(stateMessage({ local, remote: REMOTE }));
  const arrived = (await box(p, ".branch-menu")).width;
  assert.ok(Math.abs(arrived - whole) < 0.5, `the width the whole list needs: ${loading}px while loading, ${arrived}px after, ${whole}px opened with them`);
  await query(p, "zzzq");
  assert.ok(Math.abs((await box(p, ".branch-menu")).width - whole) < 0.5, "and it holds while typing on");
});

// A resize measures the menu again — the whole list, never what the query
// shows: the offers quote a long query in full, so measured on them the
// menu took its widest, and kept it after the box was cleared.
test("a resize while a long query is typed keeps the width the whole list needs, and so does clearing the box after", { skip }, async () => {
  const p = await open("dark", 560, 640);
  await openMenu(p); // short names: the menu at its least width
  const whole = (await box(p, ".branch-menu")).width;
  const width = async (): Promise<number> => (await box(p, ".branch-menu")).width;
  await query(p, "a-new-branch-name-long-enough-to-overflow-the-row-it-is-offered-in-" + "x".repeat(60));
  assert.ok(Math.abs((await width()) - whole) < 0.5, "typed: the width it opened at");
  for (const [w, what] of [[561, "a pixel wider"], [320, "a sidebar"], [560, "back"]] as const) {
    await p.resize(w, 640);
    const expect = Math.min(whole, w - 12);
    assert.ok(Math.abs((await width()) - expect) < 0.5, `resized ${what} (${w}px): ${await width()}px, the whole list's ${expect}px`);
    assert.equal(await p.eval(`document.querySelectorAll(".bm-list [data-bmkey]").length`), 2, `${what}: still the query's two offers`);
  }
  await query(p, "");
  assert.ok(Math.abs((await width()) - whole) < 0.5, `cleared: ${await width()}px, the whole list's ${whole}px`);
});
