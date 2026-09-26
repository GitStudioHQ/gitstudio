import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The Changes toolbar on a clean tree: Stage All and Stash looked and acted
// exactly as with changes — each click posted stageAll / stash for nothing.
// They are disabled while there is nothing for them to take. And the layout
// toggle was titled "Toggle tree / list view", which does not say which way
// it goes; it now says where it takes you, as the model toggle beside it does.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const BASE = { ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: [] };

async function open(): Promise<ChangesPage> {
  const page = await ChangesPage.open("dark", { width: 420, height: 560 });
  opened.push(page);
  return page;
}

const disabled = (page: ChangesPage): Promise<{ stageAll: boolean; stash: boolean }> =>
  page.eval(`({ stageAll: document.getElementById("stage-all-top").disabled, stash: document.getElementById("stash-changes").disabled })`);

test("Stage All and Stash are disabled while there is nothing for them to take", { skip }, async () => {
  const page = await open();
  await page.send(BASE);
  assert.deepEqual(await disabled(page), { stageAll: true, stash: true }, "a clean tree");
  // A click on a disabled button posts nothing.
  await page.eval(`document.getElementById("stage-all-top").click(); document.getElementById("stash-changes").click();`);
  const posted = (await page.posted()).map((m) => m.type);
  assert.ok(!posted.includes("stageAll") && !posted.includes("stash"), posted.join(", "));

  await page.send({ ...BASE, unstaged: [{ path: "a.ts", status: "M" }] });
  assert.deepEqual(await disabled(page), { stageAll: false, stash: false }, "an unstaged change");
  await page.send({ ...BASE, staged: [{ path: "a.ts", status: "M" }], stagedCount: 1 });
  assert.deepEqual(await disabled(page), { stageAll: true, stash: false }, "everything already staged");
  // The toolbar's Stage All is the Changes group's: the host never stages a
  // conflicted file for it (the Merge Changes header's Stage All does, file by
  // file past the marker check). Lit over conflicted files alone, a click
  // staged nothing and said nothing.
  await page.send({ ...BASE, merge: [{ path: "c.ts", status: "U" }] });
  assert.deepEqual(await disabled(page), { stageAll: true, stash: false }, "only a conflicted file");
  await page.send({ ...BASE, merge: [{ path: "c.ts", status: "U" }], unstaged: [{ path: "a.ts", status: "M" }] });
  assert.deepEqual(await disabled(page), { stageAll: false, stash: false }, "a conflicted file and an unstaged change");
});

test("the layout toggle says which layout it switches to", { skip }, async () => {
  const page = await open();
  await page.send({ ...BASE, unstaged: [{ path: "src/a.ts", status: "M" }], layout: "list" });
  const label = () => page.eval<string>(`document.getElementById("layout-toggle").getAttribute("aria-label")`);
  assert.equal(await label(), "View as Tree");
  await page.eval(`document.getElementById("layout-toggle").click()`);
  assert.equal(await label(), "View as List");
  assert.equal(await page.eval(`document.getElementById("layout-toggle").dataset.tip`), "View as List");
});
