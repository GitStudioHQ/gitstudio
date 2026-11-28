import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Issue #158: the file whose diff is open stays lit in "Files changed", the
 * way the graph lights its selected commit, so a long list never loses which
 * diff you are reading. Through the REAL graph entry (graph/main.ts), driven
 * as the host drives it: a click (or Enter, or Space) lights its row and
 * opens the diff; the host's `activeFile` moves the light (another of the
 * pane's diff tabs switched to) or puts it out (the last one closed). The
 * light outlives a refresh and the list/tree toggle, is the commit's own,
 * never scrolls the list by itself, and is where the keyboard's Tab lands.
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

// Dark+'s list selection, so the light is measured, not its class name.
const THEME = `
  html{--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
       --vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-focusBorder:#007fd4}
  #root{height:520px;width:1100px}
`;

const MOUNT = `
  document.body.className = "vscode-dark";
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const commit = (i, files, extra = {}) => ({
    kind: "commit", sha: sha(i), shortSha: sha(i).slice(0, 7), parents: [sha(i + 1)],
    author: "Ada", authorEmail: "ada@example.com", authorDate: 1700000000,
    committer: "Ada", committerEmail: "ada@example.com", committerDate: 1700000000,
    subject: "commit " + i, body: "", refs: [], hasRemote: false, files, ...extra,
  });
  // A long commit: forty files over a few folders, so the list scrolls.
  const FILES = Array.from({ length: 40 }, (_, i) => ({
    path: ["src/widgets", "src/gadgets/parts", "docs"][i % 3] + "/file" + String(i).padStart(2, "0") + ".ts",
    status: i % 7 === 0 ? "A" : "M", additions: 3 + i, deletions: i % 4,
  }));
  await host({ type: "graphInit", rows: [row(0), row(1), row(2)], head: sha(0), totalColumns: 1, hasMore: false, refFilter: null });
  const pane = document.querySelector("gitstudio-commit-details");
  await host({ type: "commitDetails", details: commit(0, FILES) });
  await pane.updateComplete;
  const $ = (sel) => pane.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...pane.shadowRoot.querySelectorAll(sel)];
  const settle = async () => { await pane.updateComplete; await tick(); };
  const items = () => $$('.ftree [role="treeitem"]');
  const name = (r) => (r?.querySelector(".fname")?.textContent ?? "").trim();
  const rowNamed = (n) => items().find((r) => name(r) === n);
  const lit = () => $$(".file.active").map(name);
  const selected = () => items().filter((r) => r.getAttribute("aria-selected") === "true").map(name);
  const fill = (r) => getComputedStyle(r).backgroundColor;
  const SEL = "rgb(4, 57, 94)";
  const opens = () => window.__posted.filter((m) => m.type === "openFile");
  const key = async (k) => {
    // Where a person's key lands: the row the keyboard is on.
    const at = pane.shadowRoot.activeElement;
    expect(!!at, "a row has the keyboard before " + JSON.stringify(k));
    (at || pane).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }));
    await settle();
  };
  const focused = () => pane.shadowRoot.activeElement;
  // The box that scrolls the files: the files column in the wide split, else the pane's own.
  const scroller = () => [".col-files", ".scroll"].map((sel) => $(sel)).find((e) => e && e.scrollHeight > e.clientHeight + 1);
`;

test("Files changed (#158): the open diff's file is lit, and the light follows clicks, keys and the host", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    if (localStorage.getItem("gitstudio.details.files.layout") === "tree") $(".files-layout").click();
    await settle();
    expect(scroller() && scroller().scrollHeight > scroller().clientHeight + 200, "the forty files scroll (" + scroller()?.scrollHeight + " in " + scroller()?.clientHeight + ")");
    expect(lit().length === 0 && selected().length === 0, "nothing is lit before a diff is opened (" + lit() + ")");
    expect(items().every((r) => r.getAttribute("aria-selected") === "false"), "every file row says it is not the selected one");

    // ── A click lights its row, as the graph lights its selected commit ──
    rowNamed("file04.ts").click();
    await settle();
    expect(JSON.stringify(lit()) === '["file04.ts"]' && JSON.stringify(selected()) === '["file04.ts"]', "the clicked file is lit and selected (" + lit() + " / " + selected() + ")");
    expect(fill(rowNamed("file04.ts")) === SEL, "with the list selection's fill (" + fill(rowNamed("file04.ts")) + ")");
    expect(fill(rowNamed("file05.ts")) !== SEL, "and only it (" + fill(rowNamed("file05.ts")) + ")");
    expect(getComputedStyle(rowNamed("file04.ts")).color === "rgb(255, 255, 255)", "in the selection's ink (" + getComputedStyle(rowNamed("file04.ts")).color + ")");
    expect(opens().length === 1 && opens()[0].path === "src/gadgets/parts/file04.ts" && !("preserveFocus" in opens()[0]), "and its diff is asked for (" + JSON.stringify(opens()[0]) + ")");

    // ── Another click moves it ──
    rowNamed("file09.ts").click();
    await settle();
    expect(JSON.stringify(lit()) === '["file09.ts"]', "another click moves the light (" + lit() + ")");

    // ── A refresh of the same commit keeps it, and scrolls nothing ──
    scroller().scrollTop = 0;
    scroller().dispatchEvent(new Event("scroll"));
    await host({ type: "commitDetails", details: commit(0, FILES) });
    await settle();
    expect(JSON.stringify(lit()) === '["file09.ts"]', "a refresh keeps the light (" + lit() + ")");

    // ── The host moves it (another of these diffs' tabs was switched to) ──
    const top = scroller().scrollTop;
    await host({ type: "activeFile", sha: sha(0), path: "src/widgets/file39.ts" });
    await settle();
    expect(JSON.stringify(lit()) === '["file39.ts"]', "the host's word moves the light (" + lit() + ")");
    expect(scroller().scrollTop === top, "without scrolling the list to it (" + top + " → " + scroller().scrollTop + ")");
    // The keyboard was not in the list: its one Tab stop is the open file now.
    const stops = () => items().filter((r) => r.tabIndex === 0).map(name);
    expect(JSON.stringify(stops()) === '["file39.ts"]', "the Tab stop is the open file (" + stops() + ")");
    // Another commit's word lights nothing here.
    await host({ type: "activeFile", sha: sha(5), path: "src/widgets/file03.ts" });
    await settle();
    expect(lit().length === 0, "a file of another commit lights nothing on this one (" + lit() + ")");
    await host({ type: "activeFile", sha: sha(0), path: "src/widgets/file39.ts" });
    await settle();

    // ── The tree shows the same light, and so does the list again ──
    $(".files-layout").click();
    await settle();
    expect(!!$(".file.dir") && JSON.stringify(lit()) === '["file39.ts"]', "the tree lights the same file (" + lit() + ")");
    expect(rowNamed("file39.ts").getAttribute("aria-level") === "3" && fill(rowNamed("file39.ts")) === SEL, "at its place in its folder, filled the same");
    rowNamed("file13.ts").click();
    await settle();
    expect(JSON.stringify(lit()) === '["file13.ts"]', "a click in the tree moves it (" + lit() + ")");
    $(".files-layout").click();
    await settle();
    expect(!$(".file.dir") && JSON.stringify(lit()) === '["file13.ts"]', "and the list keeps it (" + lit() + ")");

    // ── The keyboard: the cursor and the light are two things, and Enter / Space join them ──
    rowNamed("file13.ts").focus();
    await settle();
    await key("ArrowDown");
    expect(name(focused()) === "file14.ts", "↓ moves the keyboard (" + name(focused()) + ")");
    expect(JSON.stringify(lit()) === '["file13.ts"]', "but not the light: no diff opened (" + lit() + ")");
    expect(fill(rowNamed("file14.ts")) !== fill(rowNamed("file13.ts")), "the keyboard's row and the open file look apart (" + fill(rowNamed("file14.ts")) + " / " + fill(rowNamed("file13.ts")) + ")");
    const before = opens().length;
    await key("Enter");
    expect(JSON.stringify(lit()) === '["file14.ts"]', "Enter opens the keyboard's file and lights it (" + lit() + ")");
    expect(opens().length === before + 1 && opens().at(-1).path.endsWith("file14.ts") && !("preserveFocus" in opens().at(-1)), "Enter asks for the diff to read (" + JSON.stringify(opens().at(-1)) + ")");
    await key("ArrowDown");
    await key(" ");
    expect(JSON.stringify(lit()) === '["file15.ts"]', "Space opens and lights the next (" + lit() + ")");
    expect(opens().at(-1).path.endsWith("file15.ts") && opens().at(-1).preserveFocus === true, "Space keeps the keyboard in the list (" + JSON.stringify(opens().at(-1)) + ")");
    expect(name(focused()) === "file15.ts", "where it is (" + name(focused()) + ")");
    // The host moves the light while the keyboard is in the list: the Tab stop stays with the keyboard.
    await host({ type: "activeFile", sha: sha(0), path: "docs/file02.ts" });
    await settle();
    expect(JSON.stringify(lit()) === '["file02.ts"]' && JSON.stringify(stops()) === '["file15.ts"]', "the keyboard keeps its row (" + lit() + " / " + stops() + ")");

    // ── The last diff closed: the light goes out ──
    await host({ type: "activeFile" });
    await settle();
    expect(lit().length === 0 && selected().length === 0, "no diff open, nothing lit (" + lit() + ")");

    // ── It is one commit's: another commit with the same file shows no light ──
    rowNamed("file20.ts").click();
    await settle();
    await host({ type: "commitDetails", details: commit(1, FILES) });
    await settle();
    expect(lit().length === 0, "another commit's same file is not lit (" + lit() + ")");
    await host({ type: "commitDetails", details: commit(0, FILES) });
    await settle();
    expect(JSON.stringify(lit()) === '["file20.ts"]', "back on the commit, its open file is lit again (" + lit() + ")");

    // ── The working tree: a file staged and unstaged lights the row clicked ──
    const WIP = [
      { path: "src/widgets/file01.ts", status: "M", additions: 0, deletions: 0 },
      { path: "src/widgets/file01.ts", status: "M", additions: 0, deletions: 0 },
      { path: "docs/readme.md", status: "M", additions: 0, deletions: 0 },
    ];
    await host({ type: "commitDetails", details: commit(0, WIP, { kind: "wip", sha: "0".repeat(40), stagedCount: 1 }) });
    await settle();
    const lists = $$(".ftree");
    expect(lists.length === 2, "staged and unstaged lists (" + lists.length + ")");
    lists[1].querySelector('[role="treeitem"]').click();
    await settle();
    const litIn = (l) => [...l.querySelectorAll(".file.active")].length;
    expect(litIn(lists[0]) === 0 && litIn(lists[1]) === 1, "only the unstaged row clicked is lit (" + litIn(lists[0]) + "/" + litIn(lists[1]) + ")");
    expect(opens().at(-1).wip === true && opens().at(-1).sha === "0".repeat(40), "the working tree's diff is asked for");
    // A refresh of the working tree keeps it.
    await host({ type: "commitDetails", details: commit(0, WIP, { kind: "wip", sha: "0".repeat(40), stagedCount: 1 }) });
    await settle();
    expect(litIn(lists[0]) === 0 && litIn($$(".ftree")[1]) === 1, "a working-tree refresh keeps it");

    // ── Staged, then unstaged again, its diff open all along: the light goes with it ──
    const W = "0".repeat(40);
    const ONLY = (staged) => commit(0, [
      ...(staged ? [{ path: "src/widgets/file01.ts", status: "M", additions: 0, deletions: 0 }] : []),
      { path: "docs/readme.md", status: "M", additions: 0, deletions: 0 },
      ...(staged ? [] : [{ path: "src/widgets/file01.ts", status: "M", additions: 0, deletions: 0 }]),
    ], { kind: "wip", sha: W, stagedCount: staged ? 1 : 0 });
    const litAt = () => $$(".ftree").map((l) => l.dataset.group + ":" + [...l.querySelectorAll(".file.active")].map(name).join("+")).join(" ");
    await host({ type: "commitDetails", details: ONLY(false) });
    await settle();
    $$(".ftree")[0].querySelectorAll('[role="treeitem"]')[1].click();
    await settle();
    expect(litAt() === "unstaged:file01.ts", "unstaged only, clicked: lit (" + litAt() + ")");
    await host({ type: "commitDetails", details: ONLY(true) });
    await host({ type: "activeFile", sha: W, path: "src/widgets/file01.ts" });
    await settle();
    expect(litAt() === "staged:file01.ts unstaged:", "staged, its diff still open: still lit, in Staged (" + litAt() + ")");
    await host({ type: "commitDetails", details: ONLY(false) });
    await host({ type: "activeFile", sha: W, path: "src/widgets/file01.ts" });
    await settle();
    expect(litAt() === "unstaged:file01.ts", "unstaged again: still lit (" + litAt() + ")");
    // Clicked in Unstaged while staged too, then wholly staged: Staged lights it.
    await host({ type: "commitDetails", details: commit(0, WIP, { kind: "wip", sha: W, stagedCount: 1 }) });
    await settle();
    $$(".ftree")[1].querySelector('[role="treeitem"]').click();
    await settle();
    expect(litAt() === "staged: unstaged:file01.ts", "partly staged, clicked in Unstaged (" + litAt() + ")");
    await host({ type: "commitDetails", details: ONLY(true) });
    await settle();
    expect(litAt() === "staged:file01.ts unstaged:", "wholly staged: lit in Staged (" + litAt() + ")");
  `, { css: THEME, prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1100, height: 520 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
