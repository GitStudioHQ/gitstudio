import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RefTip, REF_KIND_LABEL, escapeTip, placeCard, refTipStyles, tipAriaLabel, tipData, type TipRef } from "../src/graph/refTip";
import { esc } from "../src/graph/format";
import { FakeElement, installFakeDom } from "./fakeDom.cov";

// The hover card behind a row's "+N" pill (and behind any clipped chip or
// subject): when it opens, what it lists, how it escapes ref names, and the
// hover / pin / grace-period rules that decide when it closes. Driven over a
// hand-written fake DOM with node's mocked timers — no waiting on a clock.

const REFS: TipRef[] = [
  { name: "release", kind: "head", fullName: "refs/heads/release", remotes: ["origin", "upstream"], twins: ["refs/remotes/origin/release"] },
  { name: "tags/v1.1.0", label: "v1.1.0", kind: "tag", fullName: "refs/tags/v1.1.0" },
  { name: "origin/wip", kind: "remoteHead", remotes: [] },
];

const over = (el: unknown) => ({ composedPath: () => [el] }) as unknown as Event;

function setup(t: TestContext, find?: () => FakeElement | null) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const win = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    innerWidth: 800,
    innerHeight: 600,
  };
  t.after(installFakeDom(win));

  const card = new FakeElement("div");
  card.className = "reftip";
  card.hidden = true;
  card.rect = { left: 0, top: 0, right: 200, bottom: 80, width: 200, height: 80 };

  const row = new FakeElement("div");
  row.dataset.sha = "c0ffee";
  const pill = new FakeElement("span");
  pill.className = "chip-overflow";
  pill.dataset.more = tipData(REFS);
  pill.rect = { left: 100, top: 50, right: 130, bottom: 70, width: 30, height: 20 };
  row.appendChild(pill);

  const tip = new RefTip((find ?? (() => card)) as unknown as () => HTMLElement | null);
  return { tip, card, row, pill, tick: (ms: number) => t.mock.timers.tick(ms) };
}

/** A second "+N" pill on another row. */
function otherPill(sha = "beef"): FakeElement {
  const row = new FakeElement("div");
  row.dataset.sha = sha;
  const p = new FakeElement("span");
  p.className = "more"; // the sidebar rail's spelling of the pill
  p.dataset.more = tipData([{ name: "main", kind: "currentHead" }]);
  row.appendChild(p);
  return p;
}

test("tipData carries only what differs: a label equal to the name, and empty lists, are left out", () => {
  const wire = JSON.parse(tipData([...REFS, { name: "same", label: "same", kind: "head" }]));
  assert.deepEqual(wire, [
    { n: "release", k: "head", f: "refs/heads/release", r: ["origin", "upstream"], t: ["refs/remotes/origin/release"] },
    { n: "tags/v1.1.0", k: "tag", l: "v1.1.0", f: "refs/tags/v1.1.0" },
    { n: "origin/wip", k: "remoteHead" },
    { n: "same", k: "head" },
  ]);
});

test("the pill's screen-reader text counts the refs and names each one's kind", () => {
  assert.equal(
    tipAriaLabel(REFS),
    "3 more: release (local branch), v1.1.0 (tag), origin/wip (remote branch)",
  );
  assert.equal(REF_KIND_LABEL.currentHead, "current HEAD");
});

test("hovering a '+N' pill opens its card after the short delay, not before", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(89);
  assert.equal(card.hidden, true, "still within the open delay");
  tick(1);
  assert.equal(card.hidden, false);
  assert.equal(tip.sha, "c0ffee", "the card knows which commit it belongs to");
  assert.equal(tip.isPinned, false, "a hover is not a pin");
});

test("the card lists each hidden ref as a link naming its kind, twins and other remotes", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  const rows = card.innerHTML.split("</div>").filter(Boolean);
  assert.equal(rows.length, 3);
  assert.equal(
    rows[0] + "</div>",
    '<div class="tip-row tip-head" role="link" tabindex="0" data-ref="release" data-kind="head"' +
      ' data-full="refs/heads/release" data-remotes="origin,upstream" data-twins="refs/remotes/origin/release">' +
      '<span class="codicon codicon-git-branch" aria-hidden="true"></span>' +
      '<span class="tip-name">release</span><span class="tip-kind">local branch</span>' +
      '<span class="tip-also">· also on origin, upstream</span></div>',
  );
  assert.match(rows[1], /data-ref="tags\/v1\.1\.0"/, "a click hands the host git's short name…");
  assert.match(rows[1], /<span class="tip-name">v1\.1\.0<\/span>/, "…while the card says the shorn label");
  assert.match(rows[1], /codicon-tag/);
  assert.match(rows[2], /codicon-cloud/);
  assert.doesNotMatch(rows[2], /tip-also|data-full|data-remotes|data-twins/, "nothing is said that the ref does not have");
});

test("a hostile ref name reaches the card as text, in the row and in its attributes", (t) => {
  const { tip, card, pill, tick } = setup(t);
  pill.dataset.more = tipData([
    { name: '"><img src=x onerror=alert(1)>', kind: "tag", remotes: ["<script>"], fullName: 'refs/tags/"x' },
  ]);
  tip.handleOver(over(pill));
  tick(90);
  assert.doesNotMatch(card.innerHTML, /<img|<script>|data-full="refs\/tags\/"x"/);
  assert.match(card.innerHTML, /data-ref="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(card.innerHTML, /also on &lt;script&gt;/);
});

test("the card opens below the pill, left-aligned with it", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  assert.equal(card.style.left, "100px");
  assert.equal(card.style.top, "76px", "6px under the pill's bottom edge");
});

test("a clipped commit subject opens a plain-text card, escaped", (t) => {
  const { tip, card, tick } = setup(t);
  const subject = new FakeElement("span");
  subject.dataset.text = "fix <b>bold</b> & more";
  subject.scrollWidth = 300;
  subject.clientWidth = 120;
  tip.handleOver(over(subject));
  tick(90);
  assert.equal(card.hidden, false);
  assert.equal(card.innerHTML, '<div class="tip-text">fix &lt;b&gt;bold&lt;/b&gt; &amp; more</div>');
});

test("text that fits earns no card — and hovering it closes one that was open", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  assert.equal(card.hidden, false);

  const chip = new FakeElement("span");
  chip.dataset.text = "main";
  chip.scrollWidth = 41; // within the 1px rounding slack
  chip.clientWidth = 40;
  chip.appendChild(new FakeElement("span")); // a label that fits too
  tip.handleOver(over(chip));
  assert.equal(card.hidden, true);
  assert.equal(card.innerHTML, "");
  tick(500);
  assert.equal(card.hidden, true, "and nothing opens later either");
});

test("a chip whose NESTED label is cut off opens, whatever that label's class is", (t) => {
  const { tip, card, tick } = setup(t);
  const chip = new FakeElement("span");
  chip.dataset.more = tipData([{ name: "feature/very-long-branch-name", kind: "head" }]);
  chip.scrollWidth = 80;
  chip.clientWidth = 80;
  const label = new FakeElement("span");
  label.className = "name";
  label.scrollWidth = 200;
  label.clientWidth = 60;
  chip.appendChild(label);
  tip.handleOver(over(chip));
  tick(90);
  assert.equal(card.hidden, false);
  assert.match(card.innerHTML, /feature\/very-long-branch-name/);
});

test("sweeping across the same pill does not restart the open delay", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(60);
  tip.handleOver(over(pill));
  tick(30);
  assert.equal(card.hidden, false, "opened 90ms after the FIRST over");
});

test("moving to another pill before the delay abandons the first card", (t) => {
  const { tip, card, pill, tick } = setup(t);
  const next = otherPill();
  tip.handleOver(over(pill));
  tick(50);
  tip.handleOver(over(next));
  tick(50);
  assert.equal(card.hidden, true, "neither delay has run out for the new pill");
  tick(40);
  assert.match(card.innerHTML, /data-ref="main"/);
  assert.match(card.innerHTML, /current HEAD/);
  assert.equal(tip.sha, "beef");
});

test("moving off the pill onto anything else closes the card", (t) => {
  const { tip, card, pill, row, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOver(over(row));
  assert.equal(card.hidden, true);
  assert.equal(tip.sha, undefined);
  // A target that is not an element at all (a text node) is "off" too.
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOver(over({}));
  assert.equal(card.hidden, true);
});

test("moving off the pill INTO the card keeps it open, and leaving the card closes it", (t) => {
  const { tip, card, pill, row, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  card.dispatch("pointerenter");
  tip.handleOver(over(card));
  tip.handleOver(over(row));
  assert.equal(card.hidden, false, "the pointer is inside the card");
  card.dispatch("pointerleave");
  assert.equal(card.hidden, true);
});

test("leaving the pill closes the card only after the grace period", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOut(over(pill));
  tick(139);
  assert.equal(card.hidden, false, "time to cross the gap to the card");
  tick(1);
  assert.equal(card.hidden, true);
});

test("reaching the card within the grace period keeps it open", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOut(over(pill));
  tick(70);
  card.dispatch("pointerenter");
  tick(200);
  assert.equal(card.hidden, false);
});

test("pointerout from something that is not the open pill changes nothing", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOut(over(otherPill()));
  tick(1000);
  assert.equal(card.hidden, false);
});

test("a click pins the card open at once, and the pointer wandering off does not close it", (t) => {
  const { tip, card, pill, row, tick } = setup(t);
  tip.pin(pill as unknown as HTMLElement);
  assert.equal(card.hidden, false, "no hover delay for a click");
  assert.equal(tip.isPinned, true);
  assert.equal(tip.sha, "c0ffee");
  tip.handleOver(over(row));
  tip.handleOut(over(pill));
  card.dispatch("pointerleave");
  tick(1000);
  assert.equal(card.hidden, false, "a pinned card is dismissed by a click, not by the pointer");
});

test("clicking the pinned pill again closes it", (t) => {
  const { tip, card, pill } = setup(t);
  tip.pin(pill as unknown as HTMLElement);
  tip.pin(pill as unknown as HTMLElement);
  assert.equal(tip.isPinned, false);
  assert.equal(card.hidden, true);
  assert.equal(card.innerHTML, "");
});

test("a pin cancels a pending hover open, and a pin on another pill moves the card there", (t) => {
  const { tip, card, pill, tick } = setup(t);
  const next = otherPill("f00d");
  tip.handleOver(over(next));
  tip.pin(pill as unknown as HTMLElement);
  tick(500);
  assert.equal(tip.sha, "c0ffee", "the pending hover on the other pill never repaints over the pin");
  assert.match(card.innerHTML, /data-ref="release"/);

  tip.pin(next as unknown as HTMLElement);
  assert.equal(tip.isPinned, true);
  assert.equal(tip.sha, "f00d");
  assert.match(card.innerHTML, /data-ref="main"/);
});

test("dismiss closes a pinned card and forgets which commit it was for", (t) => {
  const { tip, card, pill } = setup(t);
  tip.pin(pill as unknown as HTMLElement);
  tip.dismiss();
  assert.equal(tip.isPinned, false);
  assert.equal(card.hidden, true);
  assert.equal(tip.sha, undefined);
});

test("a pill recycled out of the DOM during the delay opens nothing", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.handleOver(over(pill));
  pill.connected = false;
  tick(90);
  assert.equal(card.hidden, true);
});

test("a pill with unreadable or empty data opens no card", (t) => {
  const { tip, card, pill, tick } = setup(t);
  pill.dataset.more = "{not json";
  tip.handleOver(over(pill));
  tick(90);
  assert.equal(card.hidden, true);
  tip.hide();
  pill.dataset.more = "[]";
  tip.handleOver(over(pill));
  tick(90);
  assert.equal(card.hidden, true);
  tip.hide();
  pill.dataset.more = "";
  tip.pin(pill as unknown as HTMLElement);
  assert.equal(card.hidden, true);
});

test("with no card element on screen (a loading template), hovering and hiding are harmless", (t) => {
  const { tip, pill, tick } = setup(t, () => null);
  tip.handleOver(over(pill));
  tick(90);
  tip.handleOut(over(pill));
  tick(200);
  tip.hide();
  assert.equal(tip.sha, undefined);
});

test("the card is bound for pointer tracking once, however often it opens", (t) => {
  const { tip, card, pill, tick } = setup(t);
  tip.pin(pill as unknown as HTMLElement);
  tip.dismiss();
  tip.handleOver(over(pill));
  tick(90);
  assert.equal(card.dataset.gsTipBound, "1");
  // Bound twice, one pointerleave would run the close twice.
  let hides = 0;
  const realHide = tip.hide.bind(tip);
  tip.hide = () => {
    hides++;
    realHide();
  };
  card.dispatch("pointerleave");
  assert.equal(hides, 1);
});

test("placeCard flips the card above the pill when the viewport's bottom is too close", (t) => {
  t.after(installFakeDom({ innerWidth: 800, innerHeight: 600 }));
  const card = new FakeElement("div");
  card.rect = { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 };
  const pill = new FakeElement("span");
  pill.rect = { left: 40, top: 500, right: 60, bottom: 520, width: 20, height: 20 };
  card.style.left = "999px";
  placeCard(card as unknown as HTMLElement, pill as unknown as HTMLElement);
  assert.equal(card.style.top, `${500 - 120 - 6}px`);
  assert.equal(card.style.left, "40px");
});

test("placeCard keeps the card inside the viewport's side margins", (t) => {
  t.after(installFakeDom({ innerWidth: 300, innerHeight: 600 }));
  const card = new FakeElement("div");
  card.rect = { left: 0, top: 0, right: 200, bottom: 50, width: 200, height: 50 };
  const pill = new FakeElement("span");
  pill.rect = { left: 280, top: 10, right: 295, bottom: 30, width: 15, height: 20 };
  placeCard(card as unknown as HTMLElement, pill as unknown as HTMLElement);
  assert.equal(card.style.left, `${300 - 200 - 6}px`, "pulled in from the right edge");

  pill.rect = { left: -40, top: 10, right: -20, bottom: 30, width: 20, height: 20 };
  placeCard(card as unknown as HTMLElement, pill as unknown as HTMLElement);
  assert.equal(card.style.left, "6px", "never past the left margin");
});

test("placeCard never lifts a flipped card above the top margin", (t) => {
  t.after(installFakeDom({ innerWidth: 800, innerHeight: 100 }));
  const card = new FakeElement("div");
  card.rect = { left: 0, top: 0, right: 100, bottom: 90, width: 100, height: 90 };
  const pill = new FakeElement("span");
  pill.rect = { left: 10, top: 30, right: 30, bottom: 50, width: 20, height: 20 };
  placeCard(card as unknown as HTMLElement, pill as unknown as HTMLElement);
  assert.equal(card.style.top, "6px");
});

test("the tip escaper is the package's one escaper, and the card is never a pointer target", () => {
  assert.equal(escapeTip, esc);
  const text = refTipStyles.cssText;
  assert.match(text, /\.reftip \{[^}]*pointer-events: none/);
  assert.match(text, /\.reftip\[hidden\] \{\s*display: none/);
});
