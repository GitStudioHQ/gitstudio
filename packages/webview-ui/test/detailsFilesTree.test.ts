import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * "Files changed" as a list or a folder tree (#81), through the REAL graph
 * entry (graph/main.ts), driven the way the host drives it: graphInit, then
 * commitDetails. The toggle switches the list to a tree and back; a folder
 * opens and closes by click and by key; a file opens its diff with the very
 * request the list sends; and the choice outlives the commit, a new pane and
 * a reload (localStorage, as the pane's column width is kept).
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
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

const MOUNT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const commit = (i, files) => ({
    kind: "commit", sha: sha(i), shortSha: sha(i).slice(0, 7), parents: [sha(i + 1)],
    author: "Ada", authorEmail: "ada@example.com", authorDate: 1700000000,
    committer: "Ada", committerEmail: "ada@example.com", committerDate: 1700000000,
    subject: "commit " + i, body: "", refs: [], hasRemote: false, files,
  });
  const FILES = [
    { path: "packages/webview-ui/src/commit-details.ts", status: "M", additions: 120, deletions: 14 },
    { path: "packages/webview-ui/src/filesTree.ts", status: "A", additions: 90, deletions: 0 },
    { path: "packages/webview-ui/src/graph/main.ts", status: "M", additions: 3, deletions: 1 },
    { path: "packages/engine/src/fileTree.ts", oldPath: "packages/engine/src/forge/tree.ts", status: "R", additions: 2, deletions: 2 },
    { path: "media/logo.png", status: "A", additions: -1, deletions: -1 },
    { path: "README.md", status: "M", additions: 1, deletions: 1 },
  ];
  await host({ type: "graphInit", rows: [row(0), row(1), row(2)], head: sha(0), totalColumns: 1, hasMore: false, refFilter: null });
  let pane = document.querySelector("gitstudio-commit-details");
  await host({ type: "commitDetails", details: commit(0, FILES) });
  await pane.updateComplete;
  const $ = (sel, p = pane) => p.shadowRoot.querySelector(sel);
  const $$ = (sel, p = pane) => [...p.shadowRoot.querySelectorAll(sel)];
  const toggle = (p = pane) => $(".files-layout", p);
  const items = (p = pane) => $$('.ftree [role="treeitem"]', p);
  const label = (r) => (r.querySelector(".fname")?.textContent ?? "").trim();
  const rowNamed = (name, p = pane) => items(p).find((r) => label(r) === name);
  const settle = async (p = pane) => { await p.updateComplete; await tick(); };
  const key = async (k, opts = {}) => {
    // Where a person's key lands: the row the keyboard is on.
    const at = pane.shadowRoot.activeElement;
    expect(!!at, "a row has the keyboard before " + k);
    (at || pane).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true, ...opts }));
    await settle();
  };
  const focused = () => pane.shadowRoot.activeElement;
  const opens = () => window.__posted.filter((m) => m.type === "openFile");
  // A list row's parts, where they sit in it (px): what origin/main drew.
  const geometry = (p = pane) => items(p).map((r) => {
    const box = (sel) => r.querySelector(sel).getBoundingClientRect();
    const b = r.getBoundingClientRect(), st = box(".fstatus"), nm = box(".fname"), dr = box(".fdir"), nu = box(".fnums");
    const px = [b.height, st.left - b.left, st.width, nm.left - st.right, dr.left - nm.right, b.right - nu.right].map((n) => Math.round(n * 10) / 10);
    return [label(r), ...px, r.querySelector(".fdir").textContent.trim()].join(" ").trimEnd();
  });
  // Nothing in the pane is wider than the box that shows it.
  const sideways = (p = pane) => [".col-files", ".scroll"]
    .map((sel) => [sel, $(sel, p)])
    .filter(([, e]) => e && e.scrollWidth > e.clientWidth)
    .map(([sel, e]) => sel + " " + e.scrollWidth + ">" + e.clientWidth);
  // Whether a path reads in its own order: its first character left of its second.
  const inOrder = (el) => {
    const tn = el && document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) }).nextNode();
    if (!tn) return false;
    const off = tn.textContent.length - tn.textContent.trimStart().length;
    const x = (i) => { const g = document.createRange(); g.setStart(tn, i); g.setEnd(tn, i + 1); return g.getBoundingClientRect().left; };
    return x(off) < x(off + 1);
  };
`;

test("Files changed: the toggle turns the list into a folder tree and back, and is remembered", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    // ── The list, as it always was ──
    const listBefore = geometry();
    expect(toggle() && toggle().getAttribute("aria-label") === "View as Tree", "the list offers View as Tree (" + toggle()?.getAttribute("aria-label") + ")");
    expect(toggle()?.querySelector(".codicon-list-tree"), "with VS Code's list-tree icon");
    expect(items().length === 6 && !$(".file.dir"), "six file rows and no folders (" + items().length + ")");
    expect(items().every((r) => r.getAttribute("aria-level") === "1"), "every list row is a top-level treeitem");
    expect($(".ftree")?.getAttribute("role") === "tree", "the list is a tree widget");
    expect((rowNamed("main.ts")?.querySelector(".fdir")?.textContent ?? "").trim() === "packages/webview-ui/src/graph", "a list row shows its folder");
    rowNamed("fileTree.ts").click();
    const fromList = opens()[0];
    expect(fromList && fromList.oldPath === "packages/engine/src/forge/tree.ts", "the list's rename opens with its old path (" + JSON.stringify(fromList) + ")");

    // ── View as Tree ──
    toggle().click();
    await settle();
    expect(localStorage.getItem("gitstudio.details.files.layout") === "tree", "the choice is stored");
    expect(toggle().getAttribute("aria-label") === "View as List" && toggle().querySelector(".codicon-list-flat"), "the tree offers View as List, with list-flat");
    const names = items().map((r) => (r.classList.contains("dir") ? "/" : "") + label(r) + "@" + r.getAttribute("aria-level"));
    expect(JSON.stringify(names) === JSON.stringify([
      "/media@1", "logo.png@2",
      "/packages@1", "/engine/src@2", "fileTree.ts@3", "/webview-ui/src@2", "/graph@3", "main.ts@4", "commit-details.ts@3", "filesTree.ts@3",
      "README.md@1",
    ]), "folders first, compacted, nested: " + JSON.stringify(names));
    const pk = rowNamed("packages");
    expect(pk.getAttribute("aria-expanded") === "true" && pk.querySelector(".codicon-chevron-down"), "a folder starts open");
    const sums = (r) => [...r.querySelectorAll(".fnums span")].map((s) => s.textContent.trim()).join(" ");
    expect(sums(pk) === "+215 −17", "packages adds up everything under it (" + sums(pk) + ")");
    expect(sums(rowNamed("media")) === "", "a folder of one binary file has nothing to add up (" + sums(rowNamed("media")) + ")");
    expect(!rowNamed("main.ts").querySelector(".fdir").textContent.trim(), "a tree row does not repeat its folder");
    const from = rowNamed("fileTree.ts").querySelector(".fdir.from");
    expect(from?.querySelector(".from-arrow")?.textContent === "←" && from?.querySelector(".from-path")?.textContent === "packages/engine/src/forge/tree.ts", "a moved file says where it came from (" + from?.textContent + ")");
    expect(rowNamed("README.md").getAttribute("aria-posinset") === "3" && rowNamed("README.md").getAttribute("aria-setsize") === "3", "a root file's place among the three top rows");

    // ── A file opens the same diff it opens from the list ──
    rowNamed("fileTree.ts").click();
    const fromTree = opens()[1];
    expect(JSON.stringify(fromTree) === JSON.stringify(fromList), "the tree posts the list's request: " + JSON.stringify(fromTree) + " vs " + JSON.stringify(fromList));

    // ── Folders close and open by click ──
    rowNamed("webview-ui/src").click();
    await settle();
    expect(rowNamed("webview-ui/src").getAttribute("aria-expanded") === "false", "a click closes a folder");
    expect(!rowNamed("main.ts") && !rowNamed("commit-details.ts"), "and hides what is under it");
    expect(rowNamed("fileTree.ts") && rowNamed("README.md"), "and only that");
    rowNamed("webview-ui/src").click();
    await settle();
    expect(rowNamed("main.ts") && rowNamed("commit-details.ts"), "a second click opens it again");

    // ── The keyboard: one Tab stop, then the arrows ──
    const stops = () => items().filter((r) => r.tabIndex === 0);
    expect(stops().length === 1, "one Tab stop in the tree (" + stops().length + ")");
    rowNamed("packages").focus();
    await settle();
    expect(stops().length === 1 && stops()[0] === rowNamed("packages"), "the Tab stop follows the keyboard");
    await key("ArrowDown");
    expect(focused() === rowNamed("engine/src"), "↓ steps to the next row (" + label(focused() || pane) + ")");
    await key("ArrowLeft");
    expect(rowNamed("engine/src").getAttribute("aria-expanded") === "false" && !rowNamed("fileTree.ts"), "← closes an open folder");
    expect(focused() === rowNamed("engine/src"), "and keeps the keyboard on it");
    await key("ArrowRight");
    expect(rowNamed("engine/src").getAttribute("aria-expanded") === "true" && rowNamed("fileTree.ts"), "→ opens a closed folder");
    await key("ArrowRight");
    expect(focused() === rowNamed("fileTree.ts"), "→ on an open folder steps into it");
    await key("ArrowLeft");
    expect(focused() === rowNamed("engine/src"), "← on a file steps out to its folder");
    await key("End");
    expect(focused() === rowNamed("README.md"), "End goes to the last row");
    await key("Home");
    expect(focused() === rowNamed("media"), "Home goes to the first");
    await key("Enter");
    expect(rowNamed("media").getAttribute("aria-expanded") === "false", "Enter on a folder closes it");
    await key(" ");
    expect(rowNamed("media").getAttribute("aria-expanded") === "true", "Space opens it again");
    await key("ArrowDown");
    await key("Enter");
    const byKey = opens()[2];
    expect(byKey && byKey.path === "media/logo.png" && byKey.status === "A" && byKey.sha === sha(0), "Enter on a file opens its diff (" + JSON.stringify(byKey) + ")");

    // ── Another commit: still a tree, every folder open again ──
    rowNamed("packages").click();
    await settle();
    expect(rowNamed("packages").getAttribute("aria-expanded") === "false", "packages closed on this commit");
    await host({ type: "commitDetails", details: commit(1, FILES) });
    await settle();
    expect(toggle().getAttribute("aria-label") === "View as List", "the next commit opens as a tree too");
    expect(rowNamed("packages")?.getAttribute("aria-expanded") === "true", "with its folders open (" + items().map(label).join(",") + ")");

    // ── A pane made afresh (the desktop makes one per commit; a reload makes a new page) ──
    const fresh = document.createElement("gitstudio-commit-details");
    fresh.style.cssText = "display:block;height:400px;width:600px";
    document.body.appendChild(fresh);
    fresh.details = commit(2, FILES);
    await settle(fresh);
    expect($(".file.dir", fresh) && toggle(fresh).getAttribute("aria-label") === "View as List", "a new pane reads the stored choice");

    // ── Back to the list, everywhere ──
    toggle().click();
    await settle();
    await settle(fresh);
    expect(localStorage.getItem("gitstudio.details.files.layout") === "list", "View as List is stored");
    expect(!$(".file.dir", fresh) && items(fresh).length === 6, "and the other pane follows it at once");
    expect(items().length === 6 && items().every((r) => r.getAttribute("aria-level") === "1"), "the list is back as it was");
    const listAfter = geometry();
    expect(JSON.stringify(listAfter) === JSON.stringify(listBefore), "row for row, part for part: " + JSON.stringify(listAfter) + " vs " + JSON.stringify(listBefore));
  `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Files changed: a choice made before is how the pane first opens", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    expect(toggle()?.getAttribute("aria-label") === "View as List", "the stored tree is what the pane opens with");
    expect(rowNamed("packages")?.getAttribute("aria-expanded") === "true", "its folders open");
    expect(items().filter((r) => r.tabIndex === 0).length === 1, "and one Tab stop");
  `, {
    css: "#root{height:720px;width:1280px}",
    prelude: PRELUDE + `localStorage.setItem("gitstudio.details.files.layout", "tree");`,
    rootAttrs: 'data-layout="dock"',
    width: 1280,
    height: 720,
  });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the extension shares the choice: a toggle tells the host, and the host's word switches the pane without an echo", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    const told = () => window.__posted.filter((m) => m.type === "setFilesLayout");
    toggle().click();
    await settle();
    expect(JSON.stringify(told()) === JSON.stringify([{ type: "setFilesLayout", layout: "tree" }]), "the toggle tells the host (" + JSON.stringify(told()) + ")");
    // Another graph (the bottom panel, the editor tab) chose the list: the host says so.
    await host({ type: "filesLayout", layout: "list" });
    await settle();
    expect(!$(".file.dir") && toggle().getAttribute("aria-label") === "View as Tree", "the open pane switches to the list");
    expect(localStorage.getItem("gitstudio.details.files.layout") === "list", "and keeps it for its next load");
    await host({ type: "filesLayout", layout: "tree" });
    await settle();
    expect(!!$(".file.dir"), "and back to the tree");
    expect(told().length === 1, "the host's word is not sent back to it (" + told().length + " sent)");
  `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the working tree's Staged and Unstaged lists are each their own tree", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    await host({ type: "commitDetails", details: {
      kind: "wip", sha: "0".repeat(40), shortSha: "0000000", parents: [sha(0)],
      author: "", authorEmail: "", authorDate: 0, committer: "", committerEmail: "", committerDate: 0,
      subject: "", body: "", refs: [], stagedCount: 2,
      files: [
        { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "src/b.ts", status: "M", additions: 2, deletions: 0 },
        { path: "src/a.ts", status: "M", additions: 4, deletions: 1 },
      ],
    } });
    await settle();
    toggle().click();
    await settle();
    const trees = $$(".ftree");
    expect(trees.length === 2, "two trees (" + trees.length + ")");
    expect(trees.map((t) => t.getAttribute("aria-label")).join() === "Staged,Unstaged", "named for their groups");
    const shape = trees.map((t) => [...t.querySelectorAll('[role="treeitem"]')].map(label).join("|"));
    expect(shape.join(" / ") === "src|a.ts|b.ts / src|a.ts", "each grouped by folder: " + shape.join(" / "));
    trees[1].querySelector('[role="treeitem"]').click();
    await settle();
    const after = $$(".ftree").map((t) => [...t.querySelectorAll('[role="treeitem"]')].length);
    expect(after.join() === "3,1", "closing Unstaged's folder leaves Staged's open (" + after.join() + ")");
    $$(".ftree")[0].querySelectorAll('[role="treeitem"]')[1].click();
    const o = opens().at(-1);
    expect(o && o.path === "src/a.ts" && o.wip === true, "a working-tree file opens as the list opens it (" + JSON.stringify(o) + ")");
  `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * List mode is the row origin/main drew, measured there (10ae31ad, review
 * build) in the split (dock, 1280px) and the stacked (side, 538px) pane: 26px
 * rows, the status 6px in and 16px wide, 8px to the name and to its folder,
 * the counts 6px from the end; the header the height it was. And the toggle
 * added to that header makes nothing scroll sideways, in either mode.
 */
for (const [layout, headH] of [["dock", 18], ["side", 26]] as const) {
  test("Files changed keeps the list's geometry, and nothing scrolls sideways (" + layout + ")", { skip }, async () => {
    const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
      await host({ type: "commitDetails", details: commit(0, [
        { path: "packages/webview-ui/src/commit-details.ts", status: "M", additions: 120, deletions: 14 },
        { path: ".github/workflows/ci.yml", status: "M", additions: 3, deletions: 1 },
        { path: "media/logo.png", status: "A", additions: -1, deletions: -1 },
        { path: "README.md", status: "D", additions: 0, deletions: 9 },
        { path: "src/moved.ts", oldPath: ".github/old/moved.ts", status: "R", additions: 1, deletions: 1 },
        { path: ".hidden-new.ts", oldPath: ".hidden-old.ts", status: "R", additions: 0, deletions: 0 },
      ]) });
      await settle();
      const g = geometry();
      const want = [
        "commit-details.ts 26 6 16 8 8 6 packages/webview-ui/src",
        "ci.yml 26 6 16 8 8 6 .github/workflows",
        "logo.png 26 6 16 8 8 6 media",
        "README.md 26 6 16 8 8 6 ",
        "moved.ts 26 6 16 8 8 6 src",
        ".hidden-new.ts 26 6 16 8 8 6 ",
      ].map((x) => x.trimEnd());
      expect(JSON.stringify(g) === JSON.stringify(want), "the list's rows as origin/main drew them: " + JSON.stringify(g));
      expect(Math.round($(".files-head").getBoundingClientRect().height) === ${headH}, "the header is the height it was (" + $(".files-head").getBoundingClientRect().height + ")");
      expect(sideways().length === 0, "the list scrolls sideways: " + sideways().join(", "));
      expect(inOrder(rowNamed("ci.yml").querySelector(".fdir")), "a dot folder reads .github/workflows, not github/workflows. (" + rowNamed("ci.yml").querySelector(".fdir").textContent + ")");

      toggle().click();
      await settle();
      expect(sideways().length === 0, "the tree scrolls sideways: " + sideways().join(", "));
      const from = (name) => rowNamed(name)?.querySelector(".from-path");
      expect(from("moved.ts")?.textContent.trim() === ".github/old/moved.ts" && inOrder(from("moved.ts")),
        "a file moved from a dot folder says .github/old/moved.ts, in that order (" + from("moved.ts")?.textContent + ")");
      expect(from(".hidden-new.ts")?.textContent.trim() === ".hidden-old.ts" && inOrder(from(".hidden-new.ts")),
        "a dotfile renamed in place says .hidden-old.ts, in that order (" + from(".hidden-new.ts")?.textContent + ")");
      notes.shot = true;
    `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="' + layout + '"', width: 1280, height: 720 });
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });
}

/**
 * Page Down and Page Up move by a page of what the pane SHOWS. Under 720px
 * the pane stacks and its outer box scrolls, not the files column — which is
 * then as tall as every row, so a page measured off it was the whole list.
 * That is the desktop's details column, the bottom panel and the sidebar.
 */
for (const layout of ["side", "dock"] as const) {
  test("Page Down and Page Up move a page of the rows on screen (" + layout + ")", { skip }, async () => {
    const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
      const MANY = Array.from({ length: 200 }, (_, i) => ({ path: "src/f" + String(i).padStart(3, "0") + ".ts", status: "M", additions: 1, deletions: 0 }));
      await host({ type: "commitDetails", details: commit(0, MANY) });
      await settle();
      const scroller = [".col-files", ".scroll"].map((sel) => $(sel)).find((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
      expect(!!scroller, "something scrolls the 200 rows");
      for (const mode of ["list", "tree"]) {
        if (mode === "tree") { toggle().click(); await settle(); }
        const rows = items();
        const page = Math.max(1, Math.floor(scroller.clientHeight / rows[0].getBoundingClientRect().height) - 1);
        rows[0].focus();
        await settle();
        await key("PageDown");
        const at = items().indexOf(focused());
        expect(at === page, mode + ": Page Down moves " + page + " rows, the pane's page (went to " + at + " of " + rows.length + ")");
        const b = focused().getBoundingClientRect(), s = scroller.getBoundingClientRect();
        expect(b.top >= s.top - 1 && b.bottom <= s.bottom + 1, mode + ": and that row is on screen");
        await key("PageDown");
        expect(items().indexOf(focused()) === Math.min(rows.length - 1, 2 * page), mode + ": a second goes a page further");
        await key("PageUp");
        await key("PageUp");
        expect(items().indexOf(focused()) === 0, mode + ": two Page Ups come back to the top");
      }
    `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="' + layout + '"', width: 1280, height: 720 });
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });
}
