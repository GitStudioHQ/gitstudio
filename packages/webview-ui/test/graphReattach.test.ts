import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The commit list has to survive being taken out of the document and put back.
 *
 * The desktop keeps a built view alive and re-parents its DOM on the way back
 * (the renderer's viewCache), so <gitstudio-graph> is disconnected and
 * reconnected on every trip through another view. `disconnectedCallback` tears
 * the virtualizer down, and the only thing that builds one is `updated()` —
 * which Lit runs when a reactive property changes, not when an element
 * reconnects. So the list came back with no virtualizer at all: the rows of
 * the window you last looked at, still sitting at their old absolute offsets,
 * and nothing that would ever repaint them.
 *
 * Measured in the shipped 2.0.2 build, on this repository: scroll Commits,
 * visit Changes, come back — 46 rows in the sizer, ZERO of them on screen, the
 * first parked at y=1464, and further scrolling moved the scrollbar but never
 * the rows. "Rows exist" passes on that build, which is why these assert what
 * a user can see: rows inside the viewport, and a scroll that recomputes them.
 *
 * The rail is the same element on the extension's sidebar and had the same
 * shape, so it is covered here too.
 */
const CHROME = findChrome();
const ROW_HEIGHT = { graph: 34, rail: 40 };

const FIXTURE = (rowHeight: number) => `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const rows = Array.from({ length: 400 }, (_, i) => row(i));
  const ROW_HEIGHT = ${rowHeight};
  const raf = () => new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(r, 0); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 50);
  });
  const settle = async (el) => { await el.updateComplete; await raf(); };
  /** Scroll the way a wheel does — the virtualizer listens for the event. */
  const scrollTo = async (el, top) => {
    const sc = el.shadowRoot.querySelector(".scroller");
    sc.scrollTop = top;
    sc.dispatchEvent(new Event("scroll"));
    await settle(el);
    return sc;
  };
  const rowsOf = (el) => [...el.shadowRoot.querySelectorAll(".row")];
  const onScreen = (el) => rowsOf(el).filter((r) => {
    const b = r.getBoundingClientRect();
    return b.bottom > 0 && b.top < innerHeight;
  }).length;
`;

const CSS = (tag: string) =>
  `#root{height:600px;display:flex;flex-direction:column} ${tag}{flex:1;min-height:0}`;

/** Mount, scroll away from the top, detach, re-attach, and look. */
const BODY = (tag: string, ready: string) => `
  const el = document.createElement("${tag}");
  el.onAction = () => {};
  ${ready}
  document.getElementById("root").replaceChildren(el);
  await settle(el);
  el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  await settle(el);
  expect(onScreen(el) > 0, "the list paints on first mount (" + onScreen(el) + " rows in view)");

  await scrollTo(el, 1800);
  const deepFirst = rowsOf(el)[0] && rowsOf(el)[0].dataset.sha;
  expect(onScreen(el) > 0, "scrolled down, rows are still on screen");

  // The round trip: out of the document and back, with no reactive change —
  // exactly what the desktop's keep-alive does.
  const parked = document.createElement("div");
  parked.appendChild(el);
  await raf();
  document.getElementById("root").replaceChildren(el);
  await raf();
  await raf();

  const back = onScreen(el);
  expect(back > 0, "rows are on screen when it comes back (" + back + " in view)");
  notes.onScreenAfterReturn = back;
  notes.firstRowTop = rowsOf(el)[0] ? Math.round(rowsOf(el)[0].getBoundingClientRect().top) : null;

  const firstBack = rowsOf(el)[0] && rowsOf(el)[0].dataset.sha;
  await scrollTo(el, 6000);
  const firstAfter = rowsOf(el)[0] && rowsOf(el)[0].dataset.sha;
  expect(firstAfter !== firstBack, "scrolling still moves the rows, not just the bar (" + firstBack + " -> " + firstAfter + ")");
  notes.deepFirst = deepFirst;
`;

test("the commit graph comes back from a detach alive", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(
    CHROME!,
    fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url)),
    FIXTURE(ROW_HEIGHT.graph) + BODY("gitstudio-graph", 'el.status = "loading";'),
    { css: CSS("gitstudio-graph") },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the sidebar rail comes back from a detach alive", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(
    CHROME!,
    fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url)),
    FIXTURE(ROW_HEIGHT.rail) + BODY("gitstudio-commit-rail", 'el.status = "loading"; el.head = sha(0);'),
    { css: CSS("gitstudio-commit-rail") },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
