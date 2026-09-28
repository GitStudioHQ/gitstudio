import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { statCount } from "../src/graph/format";

/**
 * Two ways a Commit Graph row used to hand text back to the HTML parser, now
 * closed, through the real graph entry:
 *  - the CHANGES column's counts arrive by postMessage and are written into
 *    row HTML — only real counts are kept (statCount), so a string that
 *    carries markup never reaches the row;
 *  - the SHA cell's "Copied" flash restores its label from `data-label` — as a
 *    text node now, where it used to be re-parsed through innerHTML.
 * The legitimate cases read exactly as before.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
`;

const MOUNT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (s, i) => ({
    sha: s, shortSha: s.slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const graph = () => document.querySelector("gitstudio-graph");
  const $ = (sel) => graph().shadowRoot.querySelector(sel);
  const rowEl = (s) => graph().shadowRoot.querySelector('[data-sha="' + s + '"]');
  await host({ type: "graphInit", rows: [row(sha(1), 1), row(sha(2), 2), row(sha(3), 3)], head: sha(1), totalColumns: 1, hasMore: false, refFilter: null });
  await graph().updateComplete;
`;

const skip = !CHROME && "no Chrome on this machine";
const opts = { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 };

test("statCount keeps whole non-negative counts and nothing else", () => {
  assert.equal(statCount(3), 3);
  assert.equal(statCount(0), 0);
  assert.equal(statCount(12.9), 12);
  for (const bad of [-1, NaN, Infinity, "3", "<img src=x onerror=alert(1)>", null, undefined, {}, [4]]) {
    assert.equal(statCount(bad), 0, String(bad));
  }
});

test("CHANGES counts render as numbers; markup sent as a count never reaches the row", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    await host({ type: "rowStats", stats: [
      { sha: sha(1), files: 3, additions: 10, deletions: 2 },
      { sha: sha(2), files: '<img src=x onerror="window.__pwned=1">', additions: 1, deletions: 1 },
      { sha: sha(3), files: 1, additions: '<b id="inj">x</b>', deletions: 0 },
    ] });
    await graph().updateComplete;
    const r1 = rowEl(sha(1)), r2 = rowEl(sha(2)), r3 = rowEl(sha(3));
    expect(!!r1 && !!r2 && !!r3, "three rows painted");
    const c1 = r1.querySelector(".ch-count");
    expect(c1 && c1.textContent.trim() === "3" && c1.title === "3 files changed · +10 −2", "a real count reads as before (" + (c1 && c1.title) + ")");
    expect(!r2.querySelector(".ch-count") && !graph().shadowRoot.querySelector("img[src=x]"), "a string for files is no count: the cell stays empty");
    const c3 = r3.querySelector(".ch-count");
    expect(c3 && c3.title === "1 file changed · +0 −0" && !graph().shadowRoot.getElementById("inj"), "a string for additions counts as 0 (" + (c3 && c3.title) + ")");
    expect(window.__pwned === undefined, "nothing ran");
  `, opts);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the SHA cell's Copied flash restores its label as text", { skip }, async () => {
  // The clipboard answers at once (a real one resolves whenever the browser
  // gets to it, which would make the flash's timing the browser's, not ours).
  const clipboard = `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { (window.__copied ??= []).push(t); return Promise.resolve(); } } });`;
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    const cell = rowEl(sha(1)).querySelector("[data-sha-cell]");
    expect(!!cell, "the sha cell");
    expect(cell.getAttribute("data-label") === sha(1).slice(0, 7), "the label is the short sha");
    cell.click();
    await new Promise((r) => setTimeout(r, 100));
    const live = () => rowEl(sha(1)).querySelector("[data-sha-cell]");
    expect(live().classList.contains("copied") && live().textContent === "Copied" && !!live().querySelector(".codicon-check"), "flashes Copied");
    await new Promise((r) => setTimeout(r, 1100));
    expect(!live().classList.contains("copied") && live().textContent === sha(1).slice(0, 7) && !!live().querySelector(".codicon-copy"), "restores the short sha and its copy glyph (" + live().innerHTML + ")");

    // Whatever the label attribute holds comes back as the same text — not as markup.
    const hostile = '<img src=x onerror="window.__pwned=1">';
    live().setAttribute("data-label", hostile);
    live().click();
    await new Promise((r) => setTimeout(r, 100));
    expect(live().textContent === "Copied", "flashes Copied again");
    await new Promise((r) => setTimeout(r, 1100));
    expect(live().textContent === hostile && !live().querySelector("img") && window.__pwned === undefined, "the label is text (" + live().innerHTML + ")");
    expect(window.__copied.length === 2 && window.__copied[0] === sha(1), "the FULL sha was copied, twice");
  `, { ...opts, prelude: PRELUDE + clipboard });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
