import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Issue #30, found by driving the RELEASED extension 1.13.0 in a real VS Code:
 * four things the picker's first version got wrong, pinned through the REAL
 * webview entries (graph/main.ts, graph/sidebar-main.ts) the way the host
 * drives them — host messages in through window.postMessage, the webview's out
 * through a stubbed acquireVsCodeApi.
 *
 *   · "Current branch" is a preset that follows HEAD: after a checkout the
 *     host's graphInit says so (refPreset), and the picker lights it and names
 *     the branch it means now;
 *   · a new filter's rows open at their top, not at the old list's offset;
 *   · a plain click on a chip in the panel did nothing (the rail selected the
 *     row) — both open the chip's own menu now;
 *   · the rail's picker in a short sidebar view ran past the bottom of it.
 *
 * State is asserted before paint, and nothing waits on an animation frame
 * alone: headless Chrome under a virtual-time budget services none on the
 * Windows runner.
 */
const GRAPH = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/sidebar-main.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });
`;

/** Shared fixture: 400 rows (enough to scroll), a branch/tag name collision. */
const FIXTURE = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  // A chip as a host sends it: git's short name AND the full name (issue
  // #30's follow-up). The short name of a branch beside a tag of its name is
  // "heads/<name>", of the tag "tags/<name>" — the full name is what git has.
  const ref = (name, kind) => ({
    name,
    kind,
    fullName:
      kind === "tag" ? "refs/tags/" + (name.startsWith("tags/") ? name.slice(5) : name)
      : kind === "remoteHead" ? "refs/remotes/" + name
      : "refs/heads/" + (name.startsWith("heads/") ? name.slice(6) : name),
  });
  const row = (i, refs) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: refs || [],
  });
  const CHIPS = {
    0: [ref("main", "currentHead"), ref("origin/main", "remoteHead")],
    1: [ref("heads/release", "head"), ref("origin/release", "remoteHead")],
    2: [ref("tags/release", "tag")],
    3: [ref("local-exp", "head")],
  };
  const rows = Array.from({ length: 400 }, (_, i) => row(i, CHIPS[i]));
  const listOn = (current) => [
    { fullName: "refs/heads/main", name: "main", kind: "head", ...(current === "main" ? { isCurrent: true } : {}), upstream: "refs/remotes/origin/main" },
    { fullName: "refs/heads/release", name: "heads/release", kind: "head", ...(current === "release" ? { isCurrent: true } : {}) },
    { fullName: "refs/heads/local-exp", name: "local-exp", kind: "head", ...(current === "local-exp" ? { isCurrent: true } : {}) },
    { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
    { fullName: "refs/remotes/origin/release", name: "origin/release", kind: "remoteHead" },
    { fullName: "refs/tags/release", name: "tags/release", kind: "tag" },
  ];
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  const last = (type) => posted(type)[posted(type).length - 1];
  const init = (over) => ({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: true, refFilter: null, ...over });
`;

const MOUNT_GRAPH = FIXTURE + `
  await host(init({ refList: listOn("main") }));
  const el = document.querySelector("gitstudio-graph");
  expect(!!el, "the entry mounted the graph");
  await el.updateComplete;
  const $ = (sel) => el.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const TRIGGER = ".gh-branches";
  const label = () => ($(TRIGGER + " .lbl") || {}).textContent || "";
  const POP = ".gh-branches-pop";
  const PRESET = ".gh-branches-pop .gh-preset";
  const ITEM = ".gh-branches-pop .gh-menuitem";
  const CHIP_MENU = ".gh-chip-menu";
  const MENU_ITEM = ".gh-menuitem";
`;

const MOUNT_RAIL = FIXTURE + `
  await host(init({ refList: listOn("main") }));
  const el = document.querySelector("gitstudio-commit-rail");
  expect(!!el, "the entry mounted the rail");
  await el.updateComplete;
  const $ = (sel) => el.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const TRIGGER = ".ibtn.branches";
  const label = () => { const t = $(TRIGGER); return t ? t.getAttribute("aria-label") || "" : ""; };
  const POP = ".pop.branches";
  const PRESET = ".pop.branches .preset";
  const ITEM = ".pop.branches .mi";
  const CHIP_MENU = ".pop.chipmenu";
  const MENU_ITEM = ".mi";
`;

const runGraph = (script: string, opts: { height?: number } = {}) =>
  runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + script, {
    css: `#root{height:${opts.height ?? 700}px;width:1100px}`,
    prelude: PRELUDE,
    rootAttrs: 'data-layout="side"',
    width: 1100,
    height: opts.height ?? 700,
  });

const runRail = (script: string, opts: { height?: number; css?: string } = {}) =>
  runInChrome(CHROME!, RAIL, MOUNT_RAIL + script, {
    css: opts.css ?? `#root{height:600px;width:320px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`,
    prelude: PRELUDE,
    width: 420,
    height: opts.height ?? 700,
  });

/** "Current branch" follows a checkout — the same script for both lists. */
const PRESET_FOLLOWS = `
  // The host stored "@current" and resolved it to main.
  await host(init({ refFilter: ["refs/heads/main"], refPreset: "current" }));
  expect(label().includes("main (current)"), "the trigger names the preset and the branch it means (" + label() + ")");
  $(TRIGGER).click();
  await el.updateComplete; await tick();
  const active = () => $$(PRESET).filter((p) => p.classList.contains("active")).map((p) => p.dataset.preset).join(",");
  expect(active() === "current", "Current branch is lit (" + active() + ")");
  // \`git checkout local-exp\`: the host resolves the SAME stored preset to the
  // new branch, and its list moved (isCurrent), so it sends that too.
  await host(init({ refFilter: ["refs/heads/local-exp"], refPreset: "current", refList: listOn("local-exp") }));
  expect(label().includes("local-exp (current)"), "after the checkout it names the new branch (" + label() + ")");
  expect(active() === "current", "and Current branch is still lit (" + active() + ")");
  const ticked = $$(ITEM).filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.ref);
  expect(JSON.stringify(ticked) === JSON.stringify(["refs/heads/local-exp"]), "the new branch's row is the one ticked (" + JSON.stringify(ticked) + ")");
  // A preset click sends the preset, not a snapshot of it.
  $$(PRESET).find((p) => p.dataset.preset === "local").click();
  await el.updateComplete;
  expect(JSON.stringify(last("setRefFilter").refs) === JSON.stringify(["@local"]), "Local only goes out as the preset (" + JSON.stringify(last("setRefFilter").refs) + ")");
  // A hand-picked selection is no preset: the next graphInit says none, and nothing is lit.
  await host(init({ refFilter: ["refs/heads/main"] }));
  expect(active() === "", "a hand-picked [main] lights no preset, even on main (" + active() + ")");
  expect(label() === "main" || label().endsWith(": main"), "and reads as the branch (" + label() + ")");
  // The picker's rows read "release", not git's "heads/release".
  const names = $$(ITEM).map((b) => (b.querySelector(".gh-ref-name, .nm") || {}).textContent);
  expect(names.filter((n) => n === "release").length === 2 && !names.some((n) => /^(heads|tags)\\//.test(n)),
    "the branch and the tag both read release, under their headings (" + JSON.stringify(names) + ")");
`;

test("the graph: Current branch follows a checkout — lit, named, ticked", { skip }, async () => {
  const v = await runGraph(PRESET_FOLLOWS);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail: Current branch follows a checkout — lit, named, ticked", { skip }, async () => {
  const v = await runRail(PRESET_FOLLOWS);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the graph's header names the current branch when the filter leaves it out — and names it plainly", { skip }, async () => {
  // An attached HEAD is walked only when ticked now, so under "Show only
  // local-exp" no row carries main's chip. The header read its branch off
  // those chips, and said "Detached HEAD" over a HEAD that was on main.
  const v = await runGraph(`
    const rowsNoCurrent = rows.map((r) => ({ ...r, refs: r.refs.filter((c) => c.kind !== "currentHead") }));
    await host(init({ rows: rowsNoCurrent, refFilter: ["refs/heads/local-exp"] }));
    const pill = () => $(".gh-branch");
    expect(!!pill() && !pill().classList.contains("is-detached"), "the header does not call HEAD detached (" + (pill() && pill().className) + ")");
    expect(pill() && pill().querySelector(".nm").textContent.trim() === "main", "it names main (" + (pill() && pill().textContent.trim()) + ")");
    // On a branch that shares its name with a tag, git's chip says heads/release.
    await host(init({ rows: rowsNoCurrent, refFilter: null, refList: listOn("release") }));
    expect(pill().querySelector(".nm").textContent.trim() === "release", "the branch's own name, not heads/release (" + pill().textContent.trim() + ")");
    // Detached (no current branch in the list, none on the rows): the sha.
    const detachedList = listOn("none");
    await host(init({ rows: rowsNoCurrent, head: sha(5), refList: detachedList }));
    expect(pill().classList.contains("is-detached") && pill().textContent.includes(sha(5).slice(0, 8)), "a detached HEAD reads as its commit (" + pill().textContent.trim() + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/** A new filter opens at its top; a refresh keeps its place. */
const SCROLL_RESET = `
  const s = $(".scroller");
  expect(!!s && s.scrollHeight > s.clientHeight * 3, "the list scrolls (" + (s && s.scrollHeight) + ")");
  const scrollTo = (y) => { s.scrollTop = y; s.dispatchEvent(new Event("scroll")); };
  scrollTo(Math.round(s.scrollHeight / 2));
  await el.updateComplete; await tick();
  const mid = s.scrollTop;
  expect(mid > 1000, "scrolled to the middle (" + mid + ")");
  // A refresh under the SAME filter keeps its place.
  await host(init({}));
  expect(Math.abs(s.scrollTop - mid) < 2, "a refresh keeps the position (" + s.scrollTop + " vs " + mid + ")");
  // A new filter is a new history: its top, in state, before any paint.
  const loadsBefore = posted("loadMore").length;
  window.postMessage(init({ refFilter: ["refs/heads/local-exp"], rows: rows.slice(0, 300) }), "*");
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  expect(s.scrollTop === 0, "the filtered rows open at their top (scrollTop " + s.scrollTop + ")");
  await tick(); await tick();
  expect(s.scrollTop === 0, "…and stay there (" + s.scrollTop + ")");
  expect(posted("loadMore").length === loadsBefore, "no page was chain-loaded for sitting near the new bottom (" + (posted("loadMore").length - loadsBefore) + ")");
  // The rows painted are the top ones, not the old window's.
  const top = $$(".row").map((r) => Number(r.dataset.idx ?? r.getAttribute("aria-rowindex") ?? -1)).filter((n) => n >= 0);
  expect(!!$('.row[data-sha="' + sha(0) + '"]'), "the first row is painted (" + JSON.stringify(top.slice(0, 5)) + ")");
  // Choosing All again is a change too.
  scrollTo(2000);
  await el.updateComplete; await tick();
  await host(init({ refFilter: null }));
  expect(s.scrollTop === 0, "back to All opens at the top as well (" + s.scrollTop + ")");
  notes.mid = mid;
`;

test("the graph: a new filter's rows open at their top; a refresh keeps its place", { skip }, async () => {
  const v = await runGraph(SCROLL_RESET);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail: a new filter's rows open at their top; a refresh keeps its place", { skip }, async () => {
  const v = await runRail(SCROLL_RESET);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/** A plain click on a chip opens the chip's menu — in both lists. */
const CHIP_CLICK = `
  const chip = (name) => $$('.chip[data-ref="' + name + '"]')[0];
  const c = chip("heads/release");
  expect(!!c, "the heads/release chip is painted");
  const b = c.getBoundingClientRect();
  const x = b.left + 4, y = b.top + b.height / 2;
  // A REAL pointer's target: what is under that point, inside the shadow root.
  const hit = el.shadowRoot.elementFromPoint(x, y);
  expect(!!hit && !!hit.closest('.chip[data-ref="heads/release"]'), "the chip is what a click there hits (" + (hit && hit.className) + ")");
  const selectsBefore = posted("selectCommit").length;
  hit.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y }));
  await el.updateComplete; await tick();
  const m = $(CHIP_MENU);
  expect(!!m, "a plain click opens the chip's own menu");
  expect(m && /release/.test(m.textContent) && !/heads\\/release/.test(m.textContent), "titled release, not heads/release (" + (m && m.textContent.replace(/\\s+/g, " ").trim().slice(0, 80)) + ")");
  expect(posted("selectCommit").length === selectsBefore, "and it is not a row selection");
  const only = m && m.querySelector("[data-chip-action=only]");
  only && only.click();
  await el.updateComplete;
  // …with its origin twin: folded by FULL name, "heads/release" is the
  // branch refs/heads/release and origin/release is its twin (it used to be
  // sought as "origin/heads/release", never found, and left behind).
  expect(JSON.stringify(last("setRefFilter") && last("setRefFilter").refs) === JSON.stringify(["refs/heads/release", "refs/remotes/origin/release"]),
    "Show only takes the branch and its twin by full name (" + JSON.stringify(last("setRefFilter") && last("setRefFilter").refs) + ")");
  // The folded chip ("main" with origin/main in it) moves as one thing.
  const mc = chip("main");
  const mb = mc.getBoundingClientRect();
  mc.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, clientX: mb.left + 4, clientY: mb.top + 4 }));
  await el.updateComplete; await tick();
  const add = $(CHIP_MENU + " [data-chip-action=add]");
  expect(!!add, "under a filter the clicked chip offers Add to filter");
  add && add.click();
  await el.updateComplete;
  expect(JSON.stringify(last("setRefFilter").refs) === JSON.stringify(["refs/heads/release", "refs/remotes/origin/release", "refs/heads/main", "refs/remotes/origin/main"]),
    "adding the folded chip adds the branch and its remote twin (" + JSON.stringify(last("setRefFilter").refs) + ")");
  // A tag chip's menu says tag.
  const t = chip("tags/release");
  const tb = t.getBoundingClientRect();
  t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: tb.left + 4, clientY: tb.top + 4 }));
  await el.updateComplete; await tick();
  const tm = $(CHIP_MENU);
  expect(!!tm && /Show only this tag/.test(tm.textContent), "a tag chip offers Show only this tag (" + (tm && tm.textContent.replace(/\\s+/g, " ").trim().slice(0, 80)) + ")");
`;

test("the graph: a plain click on a ref chip opens its menu (it used to do nothing)", { skip }, async () => {
  const v = await runGraph(CHIP_CLICK);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail: a plain click on a ref chip opens its menu, like the graph's", { skip }, async () => {
  const v = await runRail(CHIP_CLICK);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

// The default sidebar: Changes expanded, the Commits view about 240px tall.
// Headless Chrome keeps a window's height (it floors only the WIDTH at 500px),
// less its own frame, so the view is short for real. The check is the
// invariant the bug broke — inside the view, hint included — plus a floor on
// how short the view is, so a runner that hands out a tall one cannot turn
// this green for free.
test("the rail's Branches picker fits a short sidebar view: inside it, hint included, one list scrolling", { skip }, async () => {
  const v = await runRail(
    `
    notes.innerHeight = innerHeight;
    expect(innerHeight <= 330, "the view is short enough to test this (" + innerHeight + ")");
    $(TRIGGER).click();
    await el.updateComplete; await tick();
    const pop = $(POP);
    expect(!!pop, "the picker opened");
    const pb = pop.getBoundingClientRect();
    notes.pop = [Math.round(pb.top), Math.round(pb.bottom)];
    expect(pb.bottom <= innerHeight, "the picker ends inside the view (bottom " + pb.bottom + " of " + innerHeight + ")");
    const hint = [...pop.querySelectorAll(".hint")].pop();
    const hb = hint.getBoundingClientRect();
    notes.hint = [Math.round(hb.top), Math.round(hb.bottom)];
    expect(hb.bottom <= pb.bottom + 0.5 && hb.top >= pb.top, "the footnote is inside the picker, not scrolled off it (" + hb.top + "-" + hb.bottom + " in " + pb.top + "-" + pb.bottom + ")");
    expect(pop.scrollHeight <= pop.clientHeight + 1, "the shell itself does not scroll (" + pop.scrollHeight + " vs " + pop.clientHeight + ")");
    const list = pop.querySelector(".list");
    expect(list.scrollHeight > list.clientHeight, "the list is the one part that scrolls");
    const lb = list.getBoundingClientRect();
    expect(lb.height >= 48, "…and shows at least two rows (" + lb.height + ")");
    // The last row the list shows is clickable where a pointer would be.
    const rowsIn = [...list.querySelectorAll(".mi")].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom <= lb.bottom && b.top >= lb.top; });
    const lastRow = rowsIn[rowsIn.length - 1];
    const rb = lastRow.getBoundingClientRect();
    const at = el.shadowRoot.elementFromPoint(rb.left + rb.width / 2, rb.top + rb.height / 2);
    expect(!!at && lastRow.contains(at), "the last visible row is what a click at its centre hits");
  `,
    {
      // A window whose view is ~240px on this machine (Chrome's frame takes the rest).
      height: 327,
      css: `#root{height:100vh;width:299px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`,
    },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail offers Jump to HEAD only when HEAD can be in the graph", { skip }, async () => {
  // A filter walks an attached HEAD only when its branch is ticked, so under
  // "Show only local-exp" the jump had nothing to land on: it paged through
  // the filtered history looking, then gave up without a word.
  const v = await runRail(`
    const jump = () => $('.ibtn[title="Jump to HEAD"]');
    expect(!!jump(), "unfiltered: offered");
    const elsewhere = rows.slice(1).map((r) => ({ ...r, refs: [] }));
    await host(init({ rows: elsewhere, refFilter: ["refs/heads/local-exp"] }));
    expect(!jump(), "a filter that leaves HEAD's branch out, HEAD's commit not in its rows: not offered");
    await host(init({ refFilter: ["refs/heads/local-exp"] }));
    expect(!!jump(), "…offered again when another ticked ref reaches HEAD's commit (it is on a row)");
    await host(init({ rows: elsewhere, refFilter: ["refs/heads/main"], refPreset: "current" }));
    expect(!!jump(), "the current branch ticked: offered");
    await host(init({ rows: elsewhere, head: sha(9), refFilter: ["refs/heads/local-exp"], refList: listOn("none") }));
    expect(!!jump(), "detached: HEAD is always walked, offered");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail's search box keeps its room when a filter names itself beside it", { skip }, async () => {
  const v = await runRail(
    `
    // The report's filter: one long remote branch, its label clipped anyway.
    await host(init({ refFilter: ["refs/remotes/origin/claude/ai-mcp-desktop"] }));
    const input = $(".search input");
    const trig = $(TRIGGER);
    notes.widths = [Math.round(input.getBoundingClientRect().width), Math.round(trig.getBoundingClientRect().width)];
    expect(el.getBoundingClientRect().width === 299, "a 299px sidebar (" + el.getBoundingClientRect().width + ")");
    expect(input.getBoundingClientRect().width >= 80, "the search input keeps a usable width (" + input.getBoundingClientRect().width + ")");
    expect(trig.getAttribute("title").includes("origin/claude/ai-mcp-desktop"), "the trigger's title still names the filter");
  `,
    { css: `#root{height:600px;width:299px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}` },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
