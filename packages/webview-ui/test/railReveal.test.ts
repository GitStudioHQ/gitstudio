import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The sidebar rail's `reveal()` — a host `revealCommit`, or the header's
 * "Jump to HEAD" — used to queue a sha that was not among the loaded rows into
 * `pendingReveal` and stop there: nothing paged toward it, so the jump silently
 * did nothing when HEAD sat past the loaded window. Worse, the queue was
 * consumed by `updated()` INSTEAD of the paint: every reactive update while it
 * pended re-queued the sha without calling renderRows(), so a page that landed
 * never grew the sizer and the near-bottom loadMore trigger never fired.
 *
 * These drive the real element in headless Chrome: the virtualizer, the shadow
 * DOM and Lit's update cycle are the mechanism, and node cannot fake them.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url));
const CHROME = findChrome();
const ROW_HEIGHT = 40;

/** The page's common prologue: a mounted rail with a 150-row first page. */
const MOUNT = `
  const ROW_HEIGHT = ${ROW_HEIGHT};
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace",
    authorEmail: i === 7 ? "needle@example.com" : "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const page1 = Array.from({ length: 150 }, (_, i) => row(i));
  const page2 = Array.from({ length: 200 }, (_, i) => row(150 + i));
  const raf = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const rail = document.createElement("gitstudio-commit-rail");
  const actions = [];
  rail.onAction = (a) => actions.push(a);
  rail.status = "loading";
  document.getElementById("root").replaceChildren(rail);
  await rail.updateComplete;
  rail.head = sha(0); rail.rows = page1; rail.totalColumns = 1; rail.hasMore = true; rail.status = "ready";
  await rail.updateComplete;
  await raf();
  const $ = (sel) => rail.shadowRoot.querySelector(sel);
  const scroller = $(".scroller");
  const sizerHeight = () => parseFloat($(".sizer").style.height);
  const loadMores = () => actions.filter((a) => a.type === "loadMore").length;
  expect(scroller && scroller.clientHeight > 100, "the list has a real height to scroll in");
  expect(sizerHeight() === 150 * ROW_HEIGHT, "first page painted (sizer " + sizerHeight() + ")");
  /** The host answers a loadMore with the second page. */
  const landPage2 = async (hasMore) => {
    rail.rows = rail.rows.concat(page2);
    rail.hasMore = hasMore;
    await rail.updateComplete;
    await raf();
  };
`;

const CSS = `#root{height:600px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`;

const run = (script: string) => runInChrome(CHROME!, ENTRY, MOUNT + script, { css: CSS });

test("a commit further back than the loaded rows is paged toward, and lands when its page does", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await run(`
    const before = loadMores();
    rail.reveal(sha(300));
    await rail.updateComplete;
    expect(loadMores() === before + 1, "reveal of an unloaded sha asks the host for the next page (" + loadMores() + " loadMore actions, was " + before + ")");
    await landPage2(false);
    const selected = $(".row.selected");
    expect(!!selected, "a row is selected once the page landed");
    expect(selected && selected.dataset.sha === sha(300), "the selected row is the revealed commit (" + (selected && selected.dataset.sha) + ")");
    expect(scroller.scrollTop > 200 * ROW_HEIGHT, "the list scrolled down to it (scrollTop " + scroller.scrollTop + ")");
    notes.scrollTop = scroller.scrollTop;
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a reveal that can never land is dropped, and never stops the list painting", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await run(`
    rail.reveal("f".repeat(40));
    await rail.updateComplete;
    expect(loadMores() === 1, "it asks for a page first (" + loadMores() + ")");
    // The page lands without it, and the history ends there.
    await landPage2(false);
    expect(sizerHeight() === 350 * ROW_HEIGHT, "the appended page was painted: sizer grew to " + sizerHeight() + " (expected " + 350 * ROW_HEIGHT + ")");
    expect(!$(".row.selected"), "nothing was selected for a commit that does not exist");
    // A later, loaded reveal still lands — the dead one did not wedge the queue.
    rail.reveal(sha(10));
    await rail.updateComplete;
    await raf();
    const selected = $(".row.selected");
    expect(selected && selected.dataset.sha === sha(10), "a later reveal of a loaded commit lands (" + (selected && selected.dataset.sha) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("paging toward a reveal is bounded: at the start of history it stops asking", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await run(`
    rail.reveal("f".repeat(40));
    await rail.updateComplete;
    await landPage2(false);
    const asked = loadMores();
    // With hasMore false there is nothing left to page; a further update must not ask again.
    rail.totalColumns = 2;
    await rail.updateComplete;
    await raf();
    expect(loadMores() === asked, "no further page requested once history ended (" + loadMores() + " vs " + asked + ")");
    expect(asked === 1, "exactly one page was requested before the end of history (" + asked + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the rail's All search scope matches the author email, like the graph's", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  // The two lists each kept their own rowMatches and drifted: the rail's "all"
  // stopped looking at the author email. One shared rowMatches now.
  const v = await run(`
    const input = $(".search input");
    input.value = "needle@";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await rail.updateComplete;
    await raf();
    const count = $(".count");
    expect(!!count, "a match counter is shown while searching");
    expect(count && count.textContent.trim() === "1/1", "the email matched under All (counter reads " + (count && count.textContent.trim()) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a reveal issued before the first page exists lands when the list comes up", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  // MOUNT already brought the list up; start a second, cold rail beside it.
  const v = await run(`
    const cold = document.createElement("gitstudio-commit-rail");
    const coldActions = [];
    cold.onAction = (a) => coldActions.push(a);
    cold.status = "loading";
    document.getElementById("root").replaceChildren(cold);
    await cold.updateComplete;
    cold.reveal(sha(40));
    await cold.updateComplete;
    expect(coldActions.length === 0, "nothing is asked of the host before the first page (" + coldActions.length + " actions)");
    cold.head = sha(0); cold.rows = page1; cold.totalColumns = 1; cold.hasMore = true; cold.status = "ready";
    await cold.updateComplete;
    await raf();
    const selected = cold.shadowRoot.querySelector(".row.selected");
    expect(selected && selected.dataset.sha === sha(40), "the queued reveal landed on the first paint (" + (selected && selected.dataset.sha) + ")");
    expect(cold.shadowRoot.querySelector(".scroller").scrollTop > 0, "and the list scrolled to it");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("two reveals racing one page request it once, and the later one wins", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await run(`
    rail.reveal(sha(300));
    rail.reveal(sha(320));
    await rail.updateComplete;
    expect(loadMores() === 1, "one page requested for two reveals (" + loadMores() + ")");
    await landPage2(false);
    const selected = $(".row.selected");
    expect(selected && selected.dataset.sha === sha(320), "the commit revealed LAST is the one selected (" + (selected && selected.dataset.sha) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("paging toward a reveal gives up after its bound, even while the host says more remain", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await run(`
    rail.reveal("f".repeat(40));
    await rail.updateComplete;
    // Thirty empty pages, each still promising more: the bound is 25.
    for (let i = 0; i < 30; i++) {
      rail.rows = rail.rows.concat([]);
      rail.hasMore = true;
      await rail.updateComplete;
    }
    expect(loadMores() === 25, "stopped asking at the bound (" + loadMores() + " requests)");
    expect(sizerHeight() === 150 * ROW_HEIGHT, "the list kept painting throughout (sizer " + sizerHeight() + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
