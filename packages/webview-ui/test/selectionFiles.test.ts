import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Issue #161: the "N commits selected" summary lists the files the selection
 * changed, as one change, the way one commit's Files changed does — list or
 * tree, a click (or Enter, or Space) opening a file's diff across them, the
 * open file lit (#158). Through the real graph entry (graph/main.ts), driven
 * as the host drives it: `commitsFiles` for the selection on screen only.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState() {}, setState() {} });
`;

const SCRIPT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const rows = Array.from({ length: 8 }, (_, i) => ({
    sha: sha(i + 1), shortSha: sha(i + 1).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + (i + 1), author: "Ada Lovelace", authorEmail: "a@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (m) => window.dispatchEvent(new MessageEvent("message", { data: m }));
  host({ type: "graphInit", rows, head: sha(1), totalColumns: 1, hasMore: false, refFilter: null, refList: [] });
  await wait(300);
  const graph = document.querySelector("gitstudio-graph");
  const details = document.querySelector("gitstudio-commit-details");
  const sr = graph.shadowRoot;
  const dsr = details.shadowRoot;
  const R = (i) => sr.querySelector('.row[data-sha="' + sha(i) + '"]');
  const click = async (i, mods = {}) => { R(i).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...mods })); await wait(200); };
  const settle = async () => { await details.updateComplete; await wait(40); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  const items = () => [...dsr.querySelectorAll('.ftree [role="treeitem"]')];
  const name = (r) => (r?.querySelector(".fname")?.textContent ?? "").trim();
  const rowNamed = (n) => items().find((r) => name(r) === n);
  const lit = () => [...dsr.querySelectorAll(".file.active")].map(name);
  const head = () => (dsr.querySelector(".files-head")?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const note = () => (dsr.querySelector(".sel-note")?.textContent ?? "").trim();
  const three = [sha(2), sha(3), sha(4)];
  const STACK = {
    kind: "stack",
    files: [
      { path: "src/app/main.ts", status: "M", additions: 7, deletions: 2, from: sha(5), to: sha(2) },
      { path: "src/app/util.ts", oldPath: "src/util.ts", status: "R", additions: 1, deletions: 1, from: sha(5), to: sha(2) },
      { path: "README.md", status: "A", additions: 4, deletions: 0, from: sha(5), to: sha(2) },
    ],
  };

  await click(2);
  await click(4, { shiftKey: true });
  await settle();
  expect((dsr.querySelector(".sum-title")?.textContent || "").trim() === "3 commits selected", "the summary is up");
  expect(head() === "Files changed" && dsr.querySelector(".files-head")?.getAttribute("aria-busy") === "true", "its Files section waits for the host (" + head() + ")");
  expect(items().length === 0, "with no rows yet");

  // A late answer for another selection is dropped.
  host({ type: "commitsFiles", shas: [sha(2), sha(3)], files: STACK });
  await settle();
  expect(items().length === 0, "an answer for another selection is not shown");

  host({ type: "commitsFiles", shas: three, files: STACK });
  await settle();
  expect(head() === "Files changed 3 +12−3", "the run's files, counted, with git's line totals (" + head() + ")");
  expect(!note(), "a run needs no note (" + note() + ")");
  expect(items().length === 3, "three rows (" + items().length + ")");

  // A click opens that file's diff across them, and lights it.
  window.__posted.length = 0;
  rowNamed("util.ts").click();
  await settle();
  const open = posted("openCombinedFile").at(-1);
  const key = open?.key;
  expect(/^selection:3:/.test(key ?? ""), "the selection's key names it: " + key);
  expect(open && open.path === "src/app/util.ts" && open.oldPath === "src/util.ts" && open.status === "R"
    && open.from === sha(5) && open.to === sha(2) && !("preserveFocus" in open), "the diff is asked for, between the two revisions: " + JSON.stringify(open));
  expect(posted("openFile").length === 0, "never as one commit's file");
  expect(JSON.stringify(lit()) === '["util.ts"]', "the clicked file is lit (" + lit() + ")");

  // Space on the next row: opened, the keyboard kept in the list.
  rowNamed("util.ts").focus();
  dsr.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, composed: true, cancelable: true }));
  await settle();
  dsr.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true, cancelable: true }));
  await settle();
  const spaced = posted("openCombinedFile").at(-1);
  expect(spaced && spaced.path === "src/app/main.ts" && spaced.preserveFocus === true, "Space opens and keeps the keyboard: " + JSON.stringify(spaced));
  expect(JSON.stringify(lit()) === '["main.ts"]', "and lights it (" + lit() + ")");

  // The host moves the light (another diff tab), or puts it out.
  host({ type: "activeFile", sha: key, path: "README.md" });
  await settle();
  expect(JSON.stringify(lit()) === '["README.md"]', "the host's word moves the light (" + lit() + ")");
  host({ type: "activeFile", sha: sha(2), path: "README.md" });
  await settle();
  expect(lit().length === 0, "one commit's file of the same name lights nothing here (" + lit() + ")");
  host({ type: "activeFile", sha: key, path: "README.md" });
  await settle();

  // The tree shows the same files and the same light.
  dsr.querySelector(".files-layout").click();
  await settle();
  expect(!!dsr.querySelector(".file.dir") && JSON.stringify(lit()) === '["README.md"]', "as a tree, the same light (" + lit() + ")");
  dsr.querySelector(".files-layout").click();
  await settle();

  // Another selection: its own files, no light carried over.
  await click(5, { shiftKey: true });
  await settle();
  const four = [sha(2), sha(3), sha(4), sha(5)];
  expect(JSON.stringify(posted("selectCommits").at(-1)?.shas) === JSON.stringify(four), "four selected");
  expect(items().length === 0, "the old selection's files are gone while the new ones are read");
  host({ type: "commitsFiles", shas: four, files: { kind: "pieces", files: [
    { path: "src/app/main.ts", status: "M", additions: 0, deletions: 0, from: sha(6), to: sha(2) },
  ] } });
  await settle();
  expect(head() === "Files changed 1", "pieces: counted, no line totals (" + head() + ")");
  expect(/not one unbroken run/i.test(note()), "and the list says what its diffs span (" + note() + ")");
  expect(lit().length === 0, "nothing lit on another selection (" + lit() + ")");
  host({ type: "commitsFiles", shas: four, files: { kind: "pieces", divergent: true, files: [
    { path: "src/app/main.ts", status: "M", additions: 0, deletions: 0, from: sha(6), to: sha(2) },
  ] } });
  await settle();
  expect(/more than one line of history/.test(note()), "commits on two lines say a diff can leave a change out (" + note() + ")");

  // Nothing changed overall, and git failing, are both said.
  await click(6, { shiftKey: true });
  host({ type: "commitsFiles", shas: [sha(2), sha(3), sha(4), sha(5), sha(6)], files: { kind: "stack", files: [] } });
  await settle();
  expect(/change no files/.test(note()), "an empty combined change is said (" + note() + ")");
  await click(7, { shiftKey: true });
  host({ type: "commitsFiles", shas: [sha(2), sha(3), sha(4), sha(5), sha(6), sha(7)], failed: true });
  await settle();
  expect(/Couldn't read/.test(note()), "a failure is said (" + note() + ")");

  // Same size, same two ends, another commit between: another selection, so
  // the open diff of the first lights nothing on the second.
  const filesFor = (shas) => host({ type: "commitsFiles", shas, files: { kind: "pieces", files: [
    { path: "src/app/main.ts", status: "M", additions: 0, deletions: 0, from: sha(7), to: sha(2) },
  ] } });
  await click(2);
  await click(5, { shiftKey: true });
  await click(3, { metaKey: true });
  const first = posted("selectCommits").at(-1)?.shas ?? [];
  filesFor(first);
  await settle();
  window.__posted.length = 0;
  rowNamed("main.ts").click();
  await settle();
  const firstKey = posted("openCombinedFile").at(-1)?.key;
  await click(3, { metaKey: true });
  await click(4, { metaKey: true });
  const second = posted("selectCommits").at(-1)?.shas ?? [];
  expect(first.length === 3 && second.length === 3 && first[0] === second[0] && first[2] === second[2] && first[1] !== second[1],
    "two selections of three with the same ends: " + JSON.stringify(first) + " / " + JSON.stringify(second));
  filesFor(second);
  await settle();
  host({ type: "activeFile", sha: firstKey, path: "src/app/main.ts" });
  await settle();
  expect(!!firstKey && lit().length === 0, "the first one's open diff lights nothing on the second (" + lit() + ")");
`;

test("the selection summary lists the files the commits changed, and opens each one's diff across them (#161)", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, SCRIPT, {
    prelude: PRELUDE,
    rootAttrs: 'data-layout="dock"',
    width: 1100,
    height: 900,
    css: "#root{height:860px}",
  });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
