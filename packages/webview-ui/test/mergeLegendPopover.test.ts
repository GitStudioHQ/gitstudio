import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The legend's "?" key is a FIXED popover (the toolbar scrolls sideways and
 * would clip an absolute one). It was placed once, on open, so a window
 * resize or a toolbar scroll while it was open left it floating away from the
 * button it belongs to.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

test("the legend's key popover follows its button when the window resizes while it is open", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    const view = new W.MergeView(host);
    const slot = document.getElementById("slot");
    slot.style.cssText = "position:relative;padding-left:10px";
    view.attachLegend(slot);
    view.render(W.payload({ op: W.REBASE_OP }));
    await sleep(50);
    const help = slot.querySelector(".jb-legend-help");
    const pop = slot.querySelector(".jb-legend-pop");
    help.click();
    await sleep(20);
    expect(!pop.hidden, "precondition: the key is open");
    const before = parseFloat(pop.style.left);
    // The toolbar reflows: the button moves 200px right.
    slot.style.paddingLeft = "210px";
    window.dispatchEvent(new Event("resize"));
    await sleep(50);
    const want = Math.round(Math.max(8, Math.min(help.getBoundingClientRect().left, innerWidth - pop.offsetWidth - 8)));
    const after = parseFloat(pop.style.left);
    notes.pos = { before, after, want };
    expect(after !== before, "the popover moved");
    expect(Math.abs(after - want) <= 1, "…to its button again (" + after + " vs " + want + ")");
    const top = parseFloat(pop.style.top);
    expect(Math.abs(top - Math.round(help.getBoundingClientRect().bottom + 4)) <= 1, "and stays just below it");
    // Closing stops the tracking.
    help.click();
    await sleep(20);
    slot.style.paddingLeft = "10px";
    window.dispatchEvent(new Event("resize"));
    await sleep(50);
    expect(parseFloat(pop.style.left) === after, "a closed popover is left alone");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("in a short window the key never runs off the bottom: it opens above, or scrolls within the room it has", { skip }, async () => {
  // The critic's desktop shots at 1000px: the key opened below the legend and
  // cut its last two rows — the two that explain the resolved look.
  const v = await runMergePage(
    CHROME!,
    `
    const W = gsMerge;
    const view = new W.MergeView(host);
    const slot = document.getElementById("slot");
    view.attachLegend(slot);
    view.render(W.payload({ op: W.REBASE_OP }));
    await sleep(50);
    const help = slot.querySelector(".jb-legend-help");
    const pop = slot.querySelector(".jb-legend-pop");
    const inside = () => {
      const r = pop.getBoundingClientRect();
      return r.top >= -1 && r.bottom <= innerHeight + 1;
    };
    const lastRowSeen = () => {
      const rows = pop.querySelectorAll(".jb-legend-row");
      const last = rows[rows.length - 1];
      last.scrollIntoView({ block: "nearest" });
      const r = last.getBoundingClientRect();
      return r.bottom <= innerHeight + 1 && r.top >= 0;
    };
    // Near the bottom of a short window: more room above than below.
    slot.style.cssText = "position:fixed;left:20px;top:" + (innerHeight - 40) + "px";
    help.click();
    await sleep(30);
    notes.below = { top: pop.getBoundingClientRect().top, bottom: pop.getBoundingClientRect().bottom, h: innerHeight };
    expect(!pop.hidden, "precondition: the key is open");
    expect(inside(), "opened above the button, inside the window (" + JSON.stringify(notes.below) + ")");
    expect(pop.getBoundingClientRect().bottom <= help.getBoundingClientRect().top + 1, "and above its button");
    expect(lastRowSeen(), "every row can be reached");
    help.click();
    await sleep(20);
    // No room either way: capped at the room below, and scrolls.
    slot.style.cssText = "position:fixed;left:20px;top:40px";
    help.click();
    await sleep(30);
    expect(inside(), "capped to the window when it fits neither way");
    expect(lastRowSeen(), "and its last row is reachable by scrolling");
  `,
    { height: 260 },
  );
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});
