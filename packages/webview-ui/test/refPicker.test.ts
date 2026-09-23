import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The Branches picker (issue #30) on both commit lists — the editor-area graph
 * and the sidebar rail. A filter is a host round trip (the element posts
 * `setRefFilter`, the host answers with a fresh page), so what these pin is
 * the element's half: the trigger says what the list is built around, the
 * picker offers every ref the host listed (the filtered-out ones included),
 * a tick posts the FULLY-QUALIFIED ref, presets tick what they say, the last
 * untick is All, a chip's own menu narrows to that chip, and the popover is
 * reachable and dismissable from the keyboard like the scope popover beside
 * it. Driven in headless Chrome: shadow DOM, Lit's update cycle and focus
 * are the mechanism, and node cannot fake them.
 */
const GRAPH = fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url));
const CHROME = findChrome();

/** A history whose refs cover every group: the current branch with an
 *  upstream, a second local, a remote without a local twin, and a tag. */
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
  const rows = [
    row(0, [ref("main", "currentHead"), ref("origin/main", "remoteHead"), ref("v1", "tag")]),
    row(1, [ref("feature/x", "head")]),
    row(2, [ref("origin/feat/line-staging", "remoteHead")]),
    row(3), row(4), row(5),
  ];
  const refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true, upstream: "refs/remotes/origin/main" },
    { fullName: "refs/heads/feature/x", name: "feature/x", kind: "head" },
    { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
    { fullName: "refs/remotes/origin/feat/line-staging", name: "origin/feat/line-staging", kind: "remoteHead" },
    { fullName: "refs/tags/v1", name: "v1", kind: "tag" },
  ];
  // Timer-based, never a frame: headless Chrome services no requestAnimationFrame
  // on an idle page, and a run waiting on one dies at the budget with no verdict.
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const actions = [];
  const filters = () => actions.filter((a) => a.type === "setRefFilter").map((a) => a.refs);
  const lastFilter = () => filters()[filters().length - 1];
`;

/** Mount the graph with the fixture; \`el\`, \`$\`, \`$$\` and \`settle\` are the page's vocabulary. */
const MOUNT_GRAPH = FIXTURE + `
  const el = document.createElement("gitstudio-graph");
  el.onAction = (a) => actions.push(a);
  el.status = "loading";
  document.getElementById("root").replaceChildren(el);
  await el.updateComplete;
  el.head = sha(0); el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  el.refFilter = null; el.refList = refList;
  await el.updateComplete;
  await tick();
  const $ = (sel) => el.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const settle = async () => { await el.updateComplete; await tick(); };
  const TRIGGER = ".gh-branches";
  const POP = ".gh-branches-pop";
  const ITEM = ".gh-branches-pop .gh-menuitem";
  const PRESET = ".gh-branches-pop .gh-preset";
  const FILTER_INPUT = ".gh-branches-pop .gh-pop-filter input";
  const CHIP = ".chip[data-ref]";
  const CHIP_MENU = ".gh-chip-menu";
  const label = () => ($(TRIGGER + " .lbl") || {}).textContent || "";
`;

const MOUNT_RAIL = FIXTURE + `
  const el = document.createElement("gitstudio-commit-rail");
  el.onAction = (a) => actions.push(a);
  el.status = "loading";
  document.getElementById("root").replaceChildren(el);
  await el.updateComplete;
  el.head = sha(0); el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  el.refFilter = null; el.refList = refList;
  await el.updateComplete;
  await tick();
  const $ = (sel) => el.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const settle = async () => { await el.updateComplete; await tick(); };
  const TRIGGER = ".ibtn.branches";
  const POP = ".pop.branches";
  const ITEM = ".pop.branches .mi";
  const PRESET = ".pop.branches .preset";
  const FILTER_INPUT = ".pop.branches .flt input";
  const CHIP = ".chip[data-ref]";
  const CHIP_MENU = ".pop.chipmenu";
  // The rail's trigger is icon-only under All; its accessible name carries the state.
  const label = () => { const t = $(TRIGGER); return t ? t.getAttribute("aria-label") || "" : ""; };
`;

const CSS_GRAPH = `#root{height:700px;width:1100px;display:flex;flex-direction:column} gitstudio-graph{flex:1;min-height:0}`;
const CSS_RAIL = `#root{height:600px;width:320px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`;

/** The same script, run against both elements: the vocabulary above is what differs. */
const SCRIPT = `
  // ── The trigger says what the list is built around ──
  expect(!!$(TRIGGER), "the toolbar has a Branches trigger");
  expect(/All branches/.test(label()), "with no filter it says All branches (" + label() + ")");
  expect(!$(POP), "the picker starts closed");

  // ── Opening lists every ref the host offered, grouped, current pinned ──
  $(TRIGGER).click();
  await settle();
  expect(!!$(POP), "clicking the trigger opens the picker");
  expect($(TRIGGER).getAttribute("aria-expanded") === "true", "the trigger says it is expanded");
  const items = () => $$(ITEM);
  expect(items().length === 5, "every ref is listed, filtered-out ones included (" + items().length + ")");
  expect(items()[0].dataset.ref === "refs/heads/main", "the current branch is pinned first (" + items()[0].dataset.ref + ")");
  expect(/current/i.test(items()[0].textContent), "and labelled current");
  const presets = () => $$(PRESET);
  expect(presets().map((p) => p.textContent.trim()).join("|") === "Current branch|Current + upstream|Local only|All",
    "the four presets, in order (" + presets().map((p) => p.textContent.trim()).join("|") + ")");
  expect(items().every((b) => b.getAttribute("aria-checked") === "false"), "nothing is ticked under All");
  const active = el.shadowRoot.activeElement;
  expect(!!active && active.matches(FILTER_INPUT), "the filter box takes focus on open");

  // ── A tick posts the FULLY-QUALIFIED ref and narrows to it alone ──
  items().find((b) => b.dataset.ref === "refs/heads/feature/x").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/feature/x"]),
    "ticking from All narrows to that ref alone, by full name (" + JSON.stringify(lastFilter()) + ")");
  expect(!!$(POP), "the picker stays open for the next tick");
  expect(/feature\\/x/.test(label()), "the trigger names the filter (" + label() + ")");
  expect(items().find((b) => b.dataset.ref === "refs/heads/feature/x").getAttribute("aria-checked") === "true",
    "the row shows its tick without waiting for the host");

  // ── A second tick adds; unticking the last is All ──
  items().find((b) => b.dataset.ref === "refs/tags/v1").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/feature/x", "refs/tags/v1"]), "a second tick adds (" + JSON.stringify(lastFilter()) + ")");
  items().find((b) => b.dataset.ref === "refs/heads/feature/x").click();
  await settle();
  items().find((b) => b.dataset.ref === "refs/tags/v1").click();
  await settle();
  expect(lastFilter() === null, "unticking the last ref is All again, never an empty list (" + JSON.stringify(lastFilter()) + ")");
  expect(/All branches/.test(label()), "and the trigger says so (" + label() + ")");

  // ── Presets tick what they say NOW, and are SENT as what they mean ──
  // (the host stores "@current", so the preset follows a checkout)
  const ticked = () => items().filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.ref).sort().join(",");
  presets().find((p) => p.dataset.preset === "currentUpstream").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["@current", "@upstream"]),
    "Current + upstream is sent as the preset (" + JSON.stringify(lastFilter()) + ")");
  expect(ticked() === "refs/heads/main,refs/remotes/origin/main", "and ticks the branch and its upstream at once (" + ticked() + ")");
  expect(presets().find((p) => p.dataset.preset === "currentUpstream").classList.contains("active"), "the preset the filter IS reads active");
  expect(label().includes("main + upstream"), "the trigger names what it stands for (" + label() + ")");
  presets().find((p) => p.dataset.preset === "local").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["@local"]),
    "Local only is sent as the preset (" + JSON.stringify(lastFilter()) + ")");
  expect(ticked() === "refs/heads/feature/x,refs/heads/main", "and ticks every local branch (" + ticked() + ")");
  presets().find((p) => p.dataset.preset === "all").click();
  await settle();
  expect(lastFilter() === null, "All is null");

  // ── The list narrows by typing, case-insensitively ──
  const box = $(FILTER_INPUT);
  box.value = "FEAT";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(items().map((b) => b.dataset.ref).join(",") === "refs/heads/feature/x,refs/remotes/origin/feat/line-staging",
    "typing narrows the list (" + items().map((b) => b.dataset.ref).join(",") + ")");

  // ── ArrowDown from the box lands on the first row ──
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }));
  await settle();
  expect(el.shadowRoot.activeElement === items()[0], "ArrowDown from the filter box lands on the first row");

  // ── Escape closes it and hands focus back to the trigger ──
  const focused = el.shadowRoot.activeElement || document.activeElement;
  focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  await settle();
  expect(!$(POP), "Escape closes the picker");
  expect(el.shadowRoot.activeElement === $(TRIGGER), "and focus returns to the trigger (" + (el.shadowRoot.activeElement && el.shadowRoot.activeElement.className) + ")");

  // ── A pointer down outside dismisses it, like the scope popover ──
  $(TRIGGER).click();
  await settle();
  expect(!!$(POP), "reopened");
  expect($(FILTER_INPUT).value === "", "a fresh open starts with the whole list");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  await settle();
  expect(!$(POP), "a pointer down outside closes it");

  // ── A chip's own menu: only this / add / remove ──
  const chipOf = (name) => $$(CHIP).find((c) => c.dataset.ref === name);
  expect(!!chipOf("feature/x"), "a ref chip carries its ref name");
  chipOf("feature/x").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 300, clientY: 200 }));
  await settle();
  expect(!!$(CHIP_MENU), "right-clicking a chip opens its own menu");
  const only = $(CHIP_MENU + " [data-chip-action=only]");
  expect(!!only, "with Show only this branch");
  expect(!$(CHIP_MENU + " [data-chip-action=add]") && !$(CHIP_MENU + " [data-chip-action=remove]"),
    "and no add/remove while the filter is All — there is nothing to add to");
  only.click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/feature/x"]), "Show only this branch narrows to it (" + JSON.stringify(lastFilter()) + ")");
  expect(!$(CHIP_MENU), "and the menu closes");
  // The folded chip: "main" with origin/main folded in moves as one thing.
  chipOf("main").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, altKey: true, clientX: 100, clientY: 100 }));
  await settle();
  expect(!!$(CHIP_MENU), "alt-click opens the same menu");
  const add = $(CHIP_MENU + " [data-chip-action=add]");
  expect(!!add, "with Add to filter, now that a filter is set");
  add.click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/feature/x", "refs/heads/main", "refs/remotes/origin/main"]),
    "adding a folded chip adds the branch and its remote twin (" + JSON.stringify(lastFilter()) + ")");
  chipOf("main").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 100, clientY: 100 }));
  await settle();
  const remove = $(CHIP_MENU + " [data-chip-action=remove]");
  expect(!!remove, "a chip in the filter offers Remove from filter");
  remove.click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/feature/x"]), "removing takes both back out (" + JSON.stringify(lastFilter()) + ")");
  // Escape closes the chip menu too.
  chipOf("v1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 100, clientY: 100 }));
  await settle();
  expect(!!$(CHIP_MENU), "a tag chip has the menu too");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  await settle();
  expect(!$(CHIP_MENU), "Escape closes a chip menu");
  notes.actions = actions.length;
`;

test("the graph's Branches picker: trigger, presets, ticks, keyboard, chips", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + SCRIPT, { css: CSS_GRAPH, width: 1100, height: 700 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail's Branches picker: trigger, presets, ticks, keyboard, chips", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, RAIL, MOUNT_RAIL + SCRIPT, { css: CSS_RAIL, width: 320, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * A branch and a tag both called "release". git's %(refname:short) hands out
 * "heads/release" and "tags/release" for them, and that is the name on the
 * chip — so the chip's shortcut must go through the list the host sent (which
 * carries the full names) rather than rebuild "refs/heads/heads/release",
 * a ref that does not exist and that the host would prune to All.
 */
const AMBIGUOUS_SCRIPT = `
  el.rows = [
    row(0, [ref("main", "currentHead")]),
    row(1, [ref("heads/release", "head"), ref("tags/release", "tag")]),
    row(2),
  ];
  el.refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true },
    { fullName: "refs/heads/release", name: "heads/release", kind: "head" },
    { fullName: "refs/tags/release", name: "tags/release", kind: "tag" },
  ];
  await settle();
  const chipOf = (name) => $$(CHIP).find((c) => c.dataset.ref === name);
  expect(!!chipOf("heads/release") && !!chipOf("tags/release"), "both chips carry git's disambiguated short names");
  chipOf("heads/release").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 }));
  await settle();
  $(CHIP_MENU + " [data-chip-action=only]").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/release"]),
    "Show only this branch on the branch chip posts the branch's real full name (" + JSON.stringify(lastFilter()) + ")");
  chipOf("tags/release").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 }));
  await settle();
  $(CHIP_MENU + " [data-chip-action=add]").click();
  await settle();
  expect(JSON.stringify(lastFilter()) === JSON.stringify(["refs/heads/release", "refs/tags/release"]),
    "Add to filter on the tag chip adds the tag's real full name (" + JSON.stringify(lastFilter()) + ")");
  // …and so does Checkout. The host used to be handed the chip's name, and
  // 'git checkout heads/release' DETACHES at the branch tip — the very thing
  // a "Checkout <branch>" item exists to prevent.
  const lastAction = () => actions[actions.length - 1];
  chipOf("heads/release").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 }));
  await settle();
  $(CHIP_MENU + " [data-chip-action=checkout]").click();
  await settle();
  expect(lastAction().type === "checkoutRef" && lastAction().fullName === "refs/heads/release",
    "Checkout on the branch chip posts the branch's real full name (" + JSON.stringify(lastAction()) + ")");
  expect(lastAction().name === "heads/release" && lastAction().kind === "head", "…beside the chip's own words");
  chipOf("tags/release").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 }));
  await settle();
  $(CHIP_MENU + " [data-chip-action=checkout]").click();
  await settle();
  expect(lastAction().fullName === "refs/tags/release" && lastAction().kind === "tag",
    "Checkout on the tag chip posts the tag's (" + JSON.stringify(lastAction()) + ")");
`;

test("the graph's chip shortcut resolves an ambiguous short name through the ref list", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + AMBIGUOUS_SCRIPT, { css: CSS_GRAPH, width: 1100, height: 700 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail's chip shortcut resolves an ambiguous short name through the ref list", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, RAIL, MOUNT_RAIL + AMBIGUOUS_SCRIPT, { css: CSS_RAIL, width: 320, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * The follow-ups on the picker and the chip menu (issue #30): ArrowUp from
 * the filter box lands on the LAST row, Escape on a chip menu hands the
 * keyboard back to the list, an empty filter reads as All everywhere, and a
 * chip's menu keeps the "Checkout <ref>" the row's commit menu used to offer
 * for that right-click.
 */
const FOLLOWUPS_SCRIPT = `
  const chipOf = (name) => $$(CHIP).find((c) => c.dataset.ref === name);
  const openChip = async (name) => {
    chipOf(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 }));
    await settle();
  };
  const lastAction = () => actions[actions.length - 1];

  // ── ArrowUp from the filter box lands on the last row ──
  $(TRIGGER).click();
  await settle();
  const items = () => $$(ITEM);
  const box = $(FILTER_INPUT);
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, composed: true }));
  await settle();
  expect(el.shadowRoot.activeElement === items()[items().length - 1],
    "ArrowUp from the filter box lands on the last row (" + (el.shadowRoot.activeElement && el.shadowRoot.activeElement.dataset.ref) + ")");
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }));
  await settle();
  expect(el.shadowRoot.activeElement === items()[0], "and ArrowDown still lands on the first");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  await settle();

  // ── Escape on a chip menu hands the keyboard to the list, not to <body> ──
  await openChip("feature/x");
  expect(!!$(CHIP_MENU), "a chip menu is open");
  (el.shadowRoot.activeElement || document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  await settle();
  expect(!$(CHIP_MENU), "Escape closes it");
  const after = el.shadowRoot.activeElement;
  expect(!!after && after.classList.contains("scroller"),
    "and the list has the keyboard (" + (after ? after.className : document.activeElement.tagName) + ")");

  // ── An empty filter is All, wherever it is read ──
  el.refFilter = [];
  await settle();
  expect(/All branches/.test(label()), "an empty filter reads All branches (" + label() + ")");
  expect(!$(TRIGGER).classList.contains("scoped"), "and the trigger is not tinted as scoped");
  expect(el.refFilter === null, "it is folded to null at the boundary");
  await openChip("feature/x");
  expect(!$(CHIP_MENU + " [data-chip-action=add]") && !$(CHIP_MENU + " [data-chip-action=remove]"),
    "so a chip menu offers nothing to add to");

  // ── Checkout from the chip menu ──
  const checkout = $(CHIP_MENU + " [data-chip-action=checkout]");
  expect(!!checkout, "a branch chip's menu offers a checkout");
  expect(/^Checkout feature\\/x$/.test(checkout.textContent.trim()), "labelled for the branch (" + checkout.textContent.trim() + ")");
  checkout.click();
  await settle();
  expect(!$(CHIP_MENU), "picking it closes the menu");
  expect(JSON.stringify(lastAction()) === JSON.stringify({ type: "checkoutRef", sha: sha(1), name: "feature/x", kind: "head", fullName: "refs/heads/feature/x" }),
    "and asks the host to check the ref out, on its row, by its full name (" + JSON.stringify(lastAction()) + ")");
  await openChip("v1");
  expect(/^Checkout v1…$/.test(($(CHIP_MENU + " [data-chip-action=checkout]") || {}).textContent?.trim() || ""),
    "a tag's checkout says it will ask first");
  $(CHIP_MENU + " [data-chip-action=checkout]").click();
  await settle();
  expect(lastAction().kind === "tag" && lastAction().name === "v1" && lastAction().sha === sha(0), "a tag checkout carries its kind");
  expect(lastAction().fullName === "refs/tags/v1", "…and its full name");
  await openChip("origin/feat/line-staging");
  expect(/^Checkout origin\\/feat\\/line-staging$/.test(($(CHIP_MENU + " [data-chip-action=checkout]") || {}).textContent?.trim() || ""),
    "a remote chip offers its checkout");
  $(CHIP_MENU + " [data-chip-action=checkout]").click();
  await settle();
  expect(lastAction().kind === "remoteHead", "…as a remote");
  expect(lastAction().fullName === "refs/remotes/origin/feat/line-staging", "…by its full name");
  await openChip("main");
  expect(!!$(CHIP_MENU), "the current branch's chip has a menu");
  expect(!$(CHIP_MENU + " [data-chip-action=checkout]"), "…with no checkout: you are already on it");
`;

test("the graph's picker and chip menu follow-ups: ArrowUp, Escape, an empty filter, Checkout", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + FOLLOWUPS_SCRIPT, { css: CSS_GRAPH, width: 1100, height: 700 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail's picker and chip menu follow-ups: ArrowUp, Escape, an empty filter, Checkout", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, RAIL, MOUNT_RAIL + FOLLOWUPS_SCRIPT, { css: CSS_RAIL, width: 320, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * The rail's picker is sized to the sidebar it sits in: branchesPopTpl places
 * the shell at x ≤ innerWidth − W − 4 for W = min(232, innerWidth − 8). Its
 * width rule was a CONTENT width, so .pop's padding and border made the shell
 * 10px wider than that W, and in a sidebar of 240px or less it overhung the
 * right edge by 6px. Headless Chrome floors the window at 500px, so the
 * narrow case cannot be staged here; the invariant it breaks can be — the
 * rendered shell must be exactly the W the positioning assumes.
 */
test("the rail's picker shell is as wide as its positioning assumes", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const script = MOUNT_RAIL + `
    $(TRIGGER).click();
    await settle();
    const pop = $(POP).getBoundingClientRect();
    const W = Math.min(232, window.innerWidth - 8);
    notes.width = pop.width; notes.W = W; notes.right = pop.right; notes.innerWidth = window.innerWidth;
    expect(Math.round(pop.width) === W, "the shell is the W the positioning clamps with (" + pop.width + " vs " + W + ")");
    expect(pop.right <= window.innerWidth - 4, "so its right edge keeps the 4px margin (" + Math.round(pop.right) + " of " + window.innerWidth + ")");
  `;
  const v = await runInChrome(CHROME!, RAIL, script, { css: CSS_RAIL, width: 320, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * The picker opens leftwards from its trigger, which is right while the
 * header has spare width on that side. In the bottom panel with the details
 * pane open (42% of the panel) the graph pane is 580–740px on a laptop, the
 * trigger sits ~235px from the left edge, and a 280px shell anchored to its
 * right edge ran 45px off the pane — the presets and the filter box were cut.
 * Every width here is inside that band; the shell must stay inside the pane.
 */
const FIT_SCRIPT = `
  const host = el.getBoundingClientRect();
  $(TRIGGER).click();
  await settle();
  const pop = $(POP).getBoundingClientRect();
  notes.pane = Math.round(host.width); notes.left = Math.round(pop.left - host.left); notes.right = Math.round(pop.right - host.left);
  expect(pop.left >= host.left, "the picker's left edge is inside the pane (" + Math.round(pop.left - host.left) + "px)");
  expect(pop.right <= host.right, "and its right edge too (" + Math.round(pop.right - host.left) + "px of " + Math.round(host.width) + ")");
`;

// …and the panes where NEITHER side has the room: 320px is the desktop
// resizer's floor for the graph beside a wide details pane. Choosing a side
// only chose which edge to run off; the shell is pulled back inside now.
for (const width of [320, 360, 420, 600, 680, 720]) {
  test(`the graph's picker stays inside a ${width}px pane`, { skip: !CHROME && "no Chrome on this machine" }, async () => {
    const css = `#root{height:300px;width:${width}px;display:flex;flex-direction:column} gitstudio-graph{flex:1;min-height:0}`;
    const v = await runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + FIT_SCRIPT, { css, width: 1100, height: 300 });
    assert.deepEqual(v.fails, [], v.fails.join("\n") + " " + JSON.stringify(v.notes));
  });
}

/**
 * A host may overlay the bottom of the pane — the desktop's terminal dock is
 * an overlay footer that shrinks nothing above it — and says so with
 * `--dock-reserve`, which inherits into this shadow root. The picker measures
 * the room it really has: the shell ends above the reserve, the list gives
 * its height up first (down to its floor), and the tail is still reachable by
 * scrolling the shell. Without the reserve the shell ran the whole pane.
 */
const DOCK_SCRIPT = `
  const host = el.getBoundingClientRect();
  document.getElementById("root").style.setProperty("--dock-reserve", "300px");
  $(TRIGGER).click();
  await settle();
  const pop = $(POP);
  const pr = pop.getBoundingClientRect();
  const limit = host.bottom - 300;
  notes.bottom = Math.round(pr.bottom); notes.limit = Math.round(limit); notes.hostBottom = Math.round(host.bottom);
  expect(pr.bottom <= limit, "the shell ends above the dock's reserve (" + Math.round(pr.bottom) + " of " + Math.round(limit) + ")");
  const list = $(".gh-pop-list");
  expect(list.getBoundingClientRect().height >= 56, "the list keeps its floor");
  expect(list.scrollHeight > list.clientHeight, "…and scrolls for the rest");
  pop.scrollTop = pop.scrollHeight;
  await settle();
  const hint = $(".gh-branches-pop .gh-pop-hint").getBoundingClientRect();
  expect(hint.bottom <= limit, "scrolled to its tail, the hint is above the reserve too (" + Math.round(hint.bottom) + ")");
  // Without a reserve the same pane's shell reaches further down.
  document.getElementById("root").style.removeProperty("--dock-reserve");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  await settle();
  $(TRIGGER).click();
  await settle();
  const free = $(POP).getBoundingClientRect();
  expect(free.bottom > limit && free.bottom <= host.bottom, "with no reserve the shell uses the pane (" + Math.round(free.bottom) + ")");
`;

test("the graph's picker clears a host's dock reserve", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const css = `#root{height:560px;width:1100px;display:flex;flex-direction:column} gitstudio-graph{flex:1;min-height:0}`;
  const v = await runInChrome(CHROME!, GRAPH, MOUNT_GRAPH + DOCK_SCRIPT, { css, width: 1100, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * A cursor-positioned menu is never wider than the W its clamp assumes.
 *
 * The chip menu's "Checkout <ref>" is a ref name, and the commit menu's
 * host-built "Checkout origin/…" items are too; unbounded, a long one widened
 * the rendered menu past the width the x-clamp had allowed for, and in a
 * 240px sidebar the menu ran 44px off the edge. Headless Chrome floors the
 * window at 500px, so the edge itself cannot be staged; the invariant it
 * breaks can be: the rendered shell is at most the W the positioning uses,
 * and the long label ellipsizes inside it rather than pushing it out.
 */
const LONG = "origin/feat/a-rather-long-branch-name-that-goes-on-and-on-and-on";
const WIDE_SCRIPT = (W: string | number) => `
  el.rows = [row(0, [ref("main", "currentHead")]), row(1, [ref(${JSON.stringify(LONG)}, "remoteHead")]), row(2)];
  el.refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true },
    { fullName: "refs/remotes/" + ${JSON.stringify(LONG)}, name: ${JSON.stringify(LONG)}, kind: "remoteHead" },
  ];
  await settle();
  const W = ${W};
  const chip = $$(CHIP).find((c) => c.dataset.ref === ${JSON.stringify(LONG)});
  expect(!!chip, "the long remote chip renders");
  chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 300, clientY: 120 }));
  await settle();
  const menu = $(CHIP_MENU);
  expect(!!menu, "its menu opens");
  const mr = menu.getBoundingClientRect();
  notes.chipMenuWidth = Math.round(mr.width);
  expect(Math.round(mr.width) <= W, "the chip menu is no wider than the W its clamp assumes (" + Math.round(mr.width) + " of " + W + ")");
  expect(mr.right <= window.innerWidth - 4, "and inside the window (" + Math.round(mr.right) + ")");
  const lbl = $(CHIP_MENU + " [data-chip-action=checkout] .lbl, " + CHIP_MENU + " [data-chip-action=checkout] .nm");
  expect(!!lbl && lbl.scrollWidth > lbl.clientWidth + 1, "the checkout label ellipsizes rather than widening the menu");
  expect(!!lbl && getComputedStyle(lbl).textOverflow === "ellipsis", "…with an ellipsis");
  (el.shadowRoot.activeElement || document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  await settle();
  // The commit menu, with the host-built item for the same ref.
  el.showCommitMenu(sha(1), 300, 120, "0001000 · commit 1", [
    { id: "ref:refs/remotes/" + ${JSON.stringify(LONG)}, label: "Checkout " + ${JSON.stringify(LONG)}, icon: "cloud" },
    { id: "", label: "", sep: true },
    { id: "checkout", label: "Checkout Commit", icon: "git-commit" },
  ]);
  await settle();
  const cm = $(COMMIT_MENU);
  expect(!!cm, "the commit menu opens");
  const cr = cm.getBoundingClientRect();
  notes.commitMenuWidth = Math.round(cr.width);
  expect(Math.round(cr.width) <= W, "the commit menu is no wider than W either (" + Math.round(cr.width) + " of " + W + ")");
  expect(cr.right <= window.innerWidth - 4, "and inside the window (" + Math.round(cr.right) + ")");
`;

test("the graph's chip and commit menus stay as wide as their clamp assumes under a long ref", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const script = MOUNT_GRAPH + `const COMMIT_MENU = ".gh-pop.gh-ctx:not(.gh-chip-menu)";` + WIDE_SCRIPT(240);
  const v = await runInChrome(CHROME!, GRAPH, script, { css: CSS_GRAPH, width: 1100, height: 700 });
  assert.deepEqual(v.fails, [], v.fails.join("\n") + " " + JSON.stringify(v.notes));
});

test("the rail's chip and commit menus stay as wide as their clamp assumes under a long ref", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const script = MOUNT_RAIL + `const COMMIT_MENU = ".pop:not(.chipmenu):not(.branches)";` + WIDE_SCRIPT("Math.min(240, window.innerWidth - 8)");
  const v = await runInChrome(CHROME!, RAIL, script, { css: CSS_RAIL, width: 320, height: 600 });
  assert.deepEqual(v.fails, [], v.fails.join("\n") + " " + JSON.stringify(v.notes));
});
