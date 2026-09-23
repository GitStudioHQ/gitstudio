import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { applyGraphInitRefs } from "../src/graph/graphInit";

/**
 * The editor-area graph's REAL webview entry (graph/main.ts), driven the way
 * the extension host drives it: host messages in through window.postMessage,
 * the webview's messages out through a stubbed acquireVsCodeApi.
 *
 * Two things from issue #30 are pinned here, because both live in the join
 * between the graph and the details pane beside it, which no single element
 * test can see:
 *
 *   · the details pane's ref chips are the same shortcut as the graph's
 *     ("Clicking a ref chip could also be a shortcut: show only this branch /
 *     add this branch to the filter") — through the GRAPH's menu, resolved
 *     through the ref list by name and kind, so "heads/release" (a branch
 *     beside a tag of that name) means refs/heads/release, never the
 *     refs/heads/heads/release a rebuilt name would be;
 *   · a graphInit WITHOUT a refList (the host sends it only when it changed)
 *     keeps the list the webview has, so the picker still offers a ref the
 *     filter hides.
 *
 * State is asserted before paint, and nothing waits on an animation frame
 * alone: headless Chrome under a virtual-time budget services none on the
 * Windows runner.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });
`;

const MOUNT = `
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
  // A branch and a tag both called "release": git shortens them to
  // "heads/release" and "tags/release", and those are the chips' names.
  const rows = [
    row(0, [ref("main", "currentHead"), ref("origin/main", "remoteHead")]),
    row(1, [ref("heads/release", "head"), ref("origin/release", "remoteHead")]),
    row(2, [ref("tags/release", "tag")]),
    row(3, [ref("feature/x", "head")]),
    row(4), row(5),
  ];
  const refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true, upstream: "refs/remotes/origin/main" },
    { fullName: "refs/heads/release", name: "heads/release", kind: "head" },
    { fullName: "refs/heads/feature/x", name: "feature/x", kind: "head" },
    { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
    { fullName: "refs/remotes/origin/release", name: "origin/release", kind: "remoteHead" },
    { fullName: "refs/tags/release", name: "tags/release", kind: "tag" },
  ];
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  const last = (type) => posted(type)[posted(type).length - 1];
  const details = (i, refs) => ({
    kind: "commit", sha: sha(i), shortSha: sha(i).slice(0, 7), parents: [sha(i + 1)],
    author: "Ada Lovelace", authorEmail: "ada@example.com", authorDate: 1700000000,
    committer: "Ada Lovelace", committerEmail: "ada@example.com", committerDate: 1700000000,
    subject: "commit " + i, body: "", refs, files: [], hasRemote: true,
  });

  await host({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: null, refList });
  const graph = document.querySelector("gitstudio-graph");
  const pane = document.querySelector("gitstudio-commit-details");
  expect(!!graph && !!pane, "the entry mounted the graph and the details pane");
  await graph.updateComplete;
  const $g = (sel) => graph.shadowRoot.querySelector(sel);
  const $$g = (sel) => [...graph.shadowRoot.querySelectorAll(sel)];
  const chipIn = (name) => pane.shadowRoot.querySelector('.chip[data-ref-menu][data-ref="' + name + '"]');
  const showDetails = async (i, refs) => {
    await host({ type: "commitDetails", details: details(i, refs) });
    await pane.updateComplete;
  };
  /** A real pointer's click on a chip: coordinates inside it, bubbling. */
  const clickChip = async (chip, type) => {
    const b = chip.getBoundingClientRect();
    chip.dispatchEvent(new MouseEvent(type || "click", {
      bubbles: true, composed: true, cancelable: true,
      clientX: b.left + 4, clientY: b.top + 4, button: type === "contextmenu" ? 2 : 0,
    }));
    await graph.updateComplete;
    await tick();
  };
  const menu = () => $g(".gh-chip-menu");
  const item = (action) => menu() && menu().querySelector('[data-chip-action="' + action + '"]');
`;

const CSS = `#root{height:720px;width:1280px}`;

const run = (script: string) =>
  runInChrome(CHROME!, ENTRY, MOUNT + script, {
    css: CSS,
    prelude: PRELUDE,
    rootAttrs: 'data-layout="side"',
    width: 1280,
    height: 720,
  });

const skip = !CHROME && "no Chrome on this machine";

test("a details-pane ref chip opens the graph's chip menu, resolved through the ref list — heads/release is refs/heads/release", { skip }, async () => {
  const v = await run(`
    await showDetails(1, [ref("heads/release", "head"), ref("origin/release", "remoteHead")]);
    const chip = chipIn("heads/release");
    expect(!!chip, "the pane's branch chip is a menu chip");
    expect(chip && chip.getAttribute("role") === "button" && chip.tabIndex === 0, "…a focusable control, not a label");
    await clickChip(chip);
    // State first: what the menu is ABOUT.
    const st = graph.chipMenu;
    expect(!!st, "clicking it opened the graph's chip menu");
    expect(st && JSON.stringify(st.refs) === JSON.stringify(["refs/heads/release"]),
      "the chip resolved to refs/heads/release through the ref list (" + JSON.stringify(st && st.refs) + ")");
    expect(st && st.sha === sha(1), "…for the commit the pane shows");
    // Then the paint.
    expect(!!menu(), "the menu is on screen");
    expect(!!item("only") && !item("only").disabled, "it offers Show only this branch");
    expect(!!item("checkout"), "…and the checkout the graph's chips offer");
    item("only").click();
    await graph.updateComplete;
    const f = last("setRefFilter");
    expect(f && JSON.stringify(f.refs) === JSON.stringify(["refs/heads/release"]),
      "Show only posts the FULL name git gave the branch (" + JSON.stringify(f && f.refs) + ")");
    expect(!menu(), "and the menu closed");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the details chip's checkout goes out by the full name; a tag chip adds the TAG to the filter", { skip }, async () => {
  const v = await run(`
    await showDetails(1, [ref("heads/release", "head")]);
    await clickChip(chipIn("heads/release"), "contextmenu");
    expect(!!menu(), "a right-click opens it too");
    item("checkout").click();
    await graph.updateComplete;
    const c = last("checkoutRef");
    expect(c && c.fullName === "refs/heads/release" && c.sha === sha(1),
      "Checkout carries refs/heads/release, never heads/release (" + JSON.stringify(c) + ")");

    // Under a filter the menu adds/removes. The tag chip resolves to the tag.
    await host({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: ["refs/heads/release"] });
    await showDetails(2, [ref("tags/release", "tag")]);
    await clickChip(chipIn("tags/release"));
    expect(graph.chipMenu && graph.chipMenu.refs[0] === "refs/tags/release", "the tag chip is refs/tags/release");
    expect(!!item("add"), "a filtered graph offers Add to filter");
    item("add").click();
    await graph.updateComplete;
    const f = last("setRefFilter");
    expect(f && JSON.stringify(f.refs) === JSON.stringify(["refs/heads/release", "refs/tags/release"]),
      "Add to filter adds exactly the tag (" + JSON.stringify(f && f.refs) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a chip the ref list does not have acts on nothing — no full name is guessed for it", { skip }, async () => {
  const v = await run(`
    await showDetails(4, [ref("heads/ghost", "head")]);
    const before = window.__posted.length;
    await clickChip(chipIn("heads/ghost"));
    expect(!!menu(), "the menu still opens, so the click is not dead");
    expect(graph.chipMenu && graph.chipMenu.refs.length === 0, "…resolved to nothing (" + JSON.stringify(graph.chipMenu && graph.chipMenu.refs) + ")");
    expect(item("only") && item("only").disabled, "Show only is disabled");
    expect(!item("checkout"), "no checkout of a ref it cannot name");
    item("only").click();
    await graph.updateComplete;
    expect(window.__posted.length === before, "and nothing was posted (" + JSON.stringify(window.__posted.slice(before)) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the details chip's menu works from the keyboard and hands focus back to the chip", { skip }, async () => {
  const v = await run(`
    await showDetails(1, [ref("heads/release", "head")]);
    const chip = chipIn("heads/release");
    chip.focus();
    expect(pane.shadowRoot.activeElement === chip, "the chip takes focus");
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    await graph.updateComplete;
    await tick();
    expect(!!graph.chipMenu, "Enter opened the menu");
    const focused = graph.shadowRoot.activeElement;
    expect(!!focused && focused.dataset.chipAction === "only", "…and focus is on its first item (" + (focused && focused.outerHTML.slice(0, 80)) + ")");
    // Escape, where the keystroke lands: on the focused item.
    focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await graph.updateComplete;
    await tick();
    expect(!graph.chipMenu, "Escape closed it");
    expect(pane.shadowRoot.activeElement === chip, "…and focus went back to the chip, not the graph's list");
    expect(document.querySelector(".gs-shell").dataset.detailsOpen === "true", "the details pane itself stayed open");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the menu opens at the pointer, over the details pane, and is what the pointer hits there", { skip }, async () => {
  const v = await run(`
    await showDetails(1, [ref("heads/release", "head")]);
    const chip = chipIn("heads/release");
    const cb = chip.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    expect(cb.left >= paneBox.left, "the chip is in the pane, right of the graph (side layout)");
    await clickChip(chip);
    const m = menu();
    const mb = m && m.getBoundingClientRect();
    expect(!!mb && Math.abs(mb.left - Math.min(cb.left + 4, window.innerWidth - mb.width - 6)) <= 2,
      "the menu's left edge is at the pointer (" + (mb && mb.left) + " vs " + (cb.left + 4) + ")");
    expect(!!mb && mb.top >= cb.top, "…and below it");
    // Not hidden behind the pane: the top of the stack at the menu's centre is
    // the graph element (whose shadow root holds the menu).
    const hit = mb && document.elementFromPoint(mb.left + mb.width / 2, mb.top + mb.height / 2);
    expect(hit === graph, "the menu paints above the details pane (hit " + (hit && hit.tagName) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a graphInit without a refList keeps the picker's list: a filtered-out ref can still be ticked back in", { skip }, async () => {
  const v = await run(`
    // The filter changes; the host's list did not, so it sends none.
    await host({ type: "graphInit", rows: rows.slice(0, 3), head: sha(0), totalColumns: 1, hasMore: false,
      refFilter: ["refs/heads/release"] });
    expect(graph.refList.length === refList.length, "the element kept the list it had (" + graph.refList.length + ")");
    expect(JSON.stringify(graph.refFilter) === JSON.stringify(["refs/heads/release"]), "and took the new filter");
    $g(".gh-branches").click();
    await graph.updateComplete;
    await tick();
    const listed = $$g(".gh-branches-pop .gh-menuitem").map((b) => b.dataset.ref);
    expect(listed.includes("refs/heads/feature/x"), "the picker still lists feature/x, which the filter hides (" + JSON.stringify(listed) + ")");
    expect(listed.length === refList.length, "…and every other ref (" + listed.length + ")");
    // A list that DID change replaces it.
    await host({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: null,
      refList: refList.slice(0, 2) });
    expect(graph.refList.length === 2, "a list that is sent replaces the old one (" + graph.refList.length + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("applyGraphInitRefs: absent is unchanged, never empty", () => {
  const state = {
    refFilter: null as string[] | null,
    refList: [{ fullName: "refs/heads/main", name: "main", kind: "head" as const }],
  };
  applyGraphInitRefs(state, { refFilter: ["refs/heads/main"] });
  assert.deepEqual(state.refFilter, ["refs/heads/main"]);
  assert.equal(state.refList.length, 1, "an omitted list keeps the one held");
  applyGraphInitRefs(state, { refFilter: null, refList: [] });
  assert.equal(state.refFilter, null);
  assert.deepEqual(state.refList, [], "an empty list that IS sent empties it (a repository with no refs)");
});
