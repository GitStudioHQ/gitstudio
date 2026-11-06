import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// #147: a long commit message ran under "Review changes with AI". The
// textarea's right padding kept clear of ONE button, and with AI on there are
// two (Review beside Generate). Measured from layout: the text's box ends left
// of every button that is showing, with AI on, off, and not set up.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

interface Fit {
  textRight: number;
  buttons: { id: string; left: number }[];
}

const measure = (page: ChangesPage) =>
  page.eval<Fit>(`(function () {
    var t = document.getElementById("message");
    t.value = "fix: a subject long enough to run all the way across the commit box and wrap";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    var r = t.getBoundingClientRect();
    var cs = getComputedStyle(t);
    var textRight = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    var buttons = Array.prototype.slice.call(document.querySelectorAll(".message-wrap .sparkle"))
      .filter(function (b) { return getComputedStyle(b).display !== "none"; })
      .map(function (b) { return { id: b.id, left: b.getBoundingClientRect().left }; });
    return { textRight: textRight, buttons: buttons };
  })()`);

for (const [label, extra, count] of [
  ["AI on: Generate and Review", { aiEnabled: true }, 2],
  ["AI not set up: the Connect plug", { aiEnabled: false }, 1],
  ["AI turned off: no button", { aiEnabled: false, aiOff: true }, 0],
] as const) {
  test(`the commit message keeps clear of the box's buttons — ${label}`, { skip }, async () => {
    const page = await ChangesPage.open("dark", { width: 300, height: 560 });
    opened.push(page);
    await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), ...extra });
    const fit = await measure(page);
    assert.equal(fit.buttons.length, count, `buttons showing: ${fit.buttons.map((b) => b.id).join(", ")}`);
    for (const b of fit.buttons) {
      assert.ok(
        fit.textRight <= b.left,
        `the text runs to ${fit.textRight.toFixed(1)}px, under #${b.id} at ${b.left.toFixed(1)}px`,
      );
    }
  });
}
