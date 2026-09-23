import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { tipAriaLabel, tipData } from "../src/graph/refTip";

/**
 * What a ref chip SAYS when a branch and a tag share a name (issue #30's
 * follow-up). git's %(refname:short) is only shortest UNAMBIGUOUS, so the
 * branch "release" is listed "heads/release" and the tag "tags/release" —
 * and every chip said so: in the graph's rows, the rail's, and the commit
 * details pane. Worse, the fold looked for the branch's twin as
 * "origin/heads/release", so origin/release drew a chip of its own beside it.
 *
 * Chips are labelled by the full name shorn of its namespace, and folded by
 * full name. Driven in headless Chrome: the chips are shadow-DOM markup.
 */
const GRAPH = fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const FIXTURE = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i, refs) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: refs || [],
  });
  // Exactly what wireRefs sends for this repository: git's short names, and
  // the full names beside them.
  const RELEASE = [
    { name: "heads/release", fullName: "refs/heads/release", kind: "head" },
    { name: "origin/release", fullName: "refs/remotes/origin/release", kind: "remoteHead" },
    { name: "tags/release", fullName: "refs/tags/release", kind: "tag" },
  ];
  const rows = [
    row(0, [{ name: "main", fullName: "refs/heads/main", kind: "currentHead" }]),
    row(1, RELEASE),
    row(2), row(3),
  ];
  const refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true },
    { fullName: "refs/heads/release", name: "heads/release", kind: "head" },
    { fullName: "refs/remotes/origin/release", name: "origin/release", kind: "remoteHead" },
    { fullName: "refs/tags/release", name: "tags/release", kind: "tag" },
  ];
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const actions = [];
`;

const mount = (tag: string) => FIXTURE + `
  const el = document.createElement("${tag}");
  el.onAction = (a) => actions.push(a);
  el.status = "loading";
  document.getElementById("root").replaceChildren(el);
  await el.updateComplete;
  el.head = sha(0); el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  el.refFilter = null; el.refList = refList;
  await el.updateComplete;
  await tick();
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
`;

/** The same assertions against both lists. */
const CHIPS = `
  const onRow = $$('.row[data-sha="' + sha(1) + '"] .chip[data-ref]');
  const texts = onRow.map((c) => c.textContent.replace(/\\s+/g, " ").trim());
  notes.texts = texts;
  expect(onRow.length === 2, "one chip for the branch (its twin folded in) and one for the tag (" + onRow.length + ": " + JSON.stringify(texts) + ")");
  expect(texts.every((t) => t === "release"), "both say release (" + JSON.stringify(texts) + ")");
  const all = onRow.map((c) => c.textContent + " " + (c.getAttribute("aria-label") || ""));
  expect(!all.some((t) => /heads\\/|tags\\//.test(t)), "no label or accessible name says heads/ or tags/ (" + JSON.stringify(all) + ")");
  const branch = onRow.find((c) => c.dataset.kind === "head");
  expect(!!branch && branch.dataset.remotes === "origin", "the branch chip carries its origin twin (" + (branch && branch.dataset.remotes) + ")");
  expect(!!branch && branch.dataset.full === "refs/heads/release", "…and its full name (" + (branch && branch.dataset.full) + ")");
  expect(!!branch && branch.dataset.twins === "refs/remotes/origin/release", "…and its twin's (" + (branch && branch.dataset.twins) + ")");
  // Its menu moves the branch and the twin as one thing, by full name.
  const b = branch.getBoundingClientRect();
  branch.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4, button: 2 }));
  await el.updateComplete; await tick();
  const only = el.shadowRoot.querySelector(MENU + " [data-chip-action=only]");
  const title = el.shadowRoot.querySelector(MENU + " " + TITLE);
  expect(!!title && title.textContent.trim() === "release", "the menu is titled release (" + (title && title.textContent.trim()) + ")");
  only && only.click();
  await el.updateComplete;
  const set = actions.filter((a) => a.type === "setRefFilter").pop();
  expect(JSON.stringify(set && set.refs) === JSON.stringify(["refs/heads/release", "refs/remotes/origin/release"]),
    "Show only takes the branch with its twin (" + JSON.stringify(set && set.refs) + ")");
`;

const CSS_GRAPH = `#root{height:600px;width:1100px;display:flex;flex-direction:column} gitstudio-graph{flex:1;min-height:0}`;
const CSS_RAIL = `#root{height:600px;width:360px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`;

test("the graph labels a branch beside a tag of its name 'release', and folds its twin", { skip }, async () => {
  const v = await runInChrome(
    CHROME!,
    GRAPH,
    mount("gitstudio-graph") + `const MENU = ".gh-chip-menu"; const TITLE = ".gh-pop-title";` + CHIPS,
    { css: CSS_GRAPH, width: 1100, height: 600 },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail labels it the same way, by the same fold", { skip }, async () => {
  const v = await runInChrome(
    CHROME!,
    RAIL,
    mount("gitstudio-commit-rail") + `const MENU = ".pop.chipmenu"; const TITLE = ".hd";` + CHIPS,
    { css: CSS_RAIL, width: 360, height: 600 },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the commit-details pane names the refs 'release' too, and its menu resolves by full name", { skip }, async () => {
  const PRELUDE = `
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
  `;
  const v = await runInChrome(
    CHROME!,
    ENTRY,
    FIXTURE + `
      const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
      await host({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: null, refList });
      const graph = document.querySelector("gitstudio-graph");
      const pane = document.querySelector("gitstudio-commit-details");
      await host({ type: "commitDetails", details: {
        kind: "commit", sha: sha(1), shortSha: sha(1).slice(0, 7), parents: [sha(2)],
        author: "Ada Lovelace", authorEmail: "ada@example.com", authorDate: 1700000000,
        committer: "Ada Lovelace", committerEmail: "ada@example.com", committerDate: 1700000000,
        subject: "commit 1", body: "", refs: RELEASE, files: [], hasRemote: true,
      } });
      await pane.updateComplete;
      const chips = [...pane.shadowRoot.querySelectorAll(".chip[data-ref-menu]")];
      const names = chips.map((c) => (c.querySelector(".chip-name") || c).textContent.trim());
      expect(JSON.stringify(names) === JSON.stringify(["release", "origin/release", "release"]),
        "tip of release, pushed to origin/release, tagged release (" + JSON.stringify(names) + ")");
      expect(!chips.some((c) => /heads\\/|tags\\//.test((c.getAttribute("title") || "") + c.textContent)), "no heads/ or tags/ anywhere on them");
      const branch = chips[0];
      const b = branch.getBoundingClientRect();
      branch.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4 }));
      await graph.updateComplete; await tick();
      const title = graph.shadowRoot.querySelector(".gh-chip-menu .gh-pop-title");
      expect(!!title && title.textContent.trim() === "release", "the graph's menu for it is titled release (" + (title && title.textContent.trim()) + ")");
      const only = graph.shadowRoot.querySelector(".gh-chip-menu [data-chip-action=only]");
      expect(!!only && !only.disabled, "and resolves it (not 'not in the branch list')");
    `,
    { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the '+N' card names what it hides by label, and keeps the full names for its click", () => {
  const hidden = [
    { name: "heads/release", label: "release", fullName: "refs/heads/release", kind: "head" as const, remotes: ["origin"], twins: ["refs/remotes/origin/release"] },
    { name: "tags/release", label: "release", fullName: "refs/tags/release", kind: "tag" as const },
  ];
  assert.equal(tipAriaLabel(hidden), "2 more: release (local branch), release (tag)");
  const wire = JSON.parse(tipData(hidden));
  assert.deepEqual(wire[0], { n: "heads/release", l: "release", f: "refs/heads/release", k: "head", r: ["origin"], t: ["refs/remotes/origin/release"] });
});
