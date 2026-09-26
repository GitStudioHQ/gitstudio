import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The commit box's subject counter says what it counts, and its "long" state
// is a warning, not information.
//
// It was a bare number (aria-hidden, no tooltip), and past 50 characters it
// turned --gs-status-modified — charts-blue, the colour this view uses for
// modified files and information. Typed for real into the real page.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage | undefined;
after(async () => {
  await page?.close();
});

async function typeSubject(p: ChangesPage, n: number): Promise<{ text: string; tip: string; cls: string; color: string; blue: string }> {
  await p.eval(`(function () { var m = document.getElementById("message"); m.value = ""; m.focus(); })()`);
  await p.type("x".repeat(n));
  return p.eval(`(function () {
    var c = document.getElementById("counter");
    var probe = document.createElement("span");
    probe.style.color = "var(--gs-status-modified)";
    document.body.appendChild(probe);
    var blue = getComputedStyle(probe).color;
    probe.remove();
    return { text: c.textContent, tip: c.dataset.tip || c.title || "", cls: c.className, color: getComputedStyle(c).color, blue: blue };
  })()`);
}

const rgb = (c: string): number[] => (/\(([^)]+)\)/.exec(c)?.[1] ?? "").split(/[ ,]+/).slice(0, 3).map(Number);

test("the counter explains itself, and warns in the warning colour", { skip }, async () => {
  page = await ChangesPage.open("dark", { width: 420, height: 560 });
  await page.eval(`(function () {
    var s = document.createElement("style");
    s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(s);
  })()`);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), staged: [{ path: "a.ts", status: "M" }], stagedCount: 1 });

  const short = await typeSubject(page, 36);
  assert.equal(short.text, "36");
  assert.match(short.tip, /Subject line: 36 characters/);

  const long = await typeSubject(page, 60);
  assert.match(long.cls, /\bwarn\b/);
  assert.match(long.tip, /60 characters, over 50/);
  assert.notEqual(long.color, long.blue, "not the modified-file / information blue");
  const [r, , b] = rgb(long.color);
  assert.ok(r - b > 60, `an amber, not a blue: ${long.color}`);

  const over = await typeSubject(page, 80);
  assert.match(over.cls, /\bover\b/);
  assert.match(over.tip, /80 characters, over 72/);
});
