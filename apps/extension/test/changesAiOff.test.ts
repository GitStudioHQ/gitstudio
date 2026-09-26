import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";
import { changesHost, scratchRepo, vscode } from "./changesHost";

// After "Disable AI Features" (gitstudio.ai.provider = "off") the commit box
// still showed the Connect-AI plug, inviting the user to connect what they had
// just turned off. The host says when AI is off, and the page shows no plug
// then; with AI merely not set up, the plug stays (the view title's Connect
// AI Provider is the way back either way).

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const f of cleanups) await f();
});

test("the host says when the user turned AI off", async () => {
  const repo = scratchRepo("ai-off");
  cleanups.push(repo.done);
  const ws = (vscode as unknown as { workspace: Record<string, unknown> }).workspace;
  const before = ws.getConfiguration;
  let provider = "off";
  ws.getConfiguration = () => ({ get: (key: string, fallback: unknown) => (key === "ai.provider" ? provider : fallback) });
  cleanups.push(() => {
    ws.getConfiguration = before;
  });
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.send({ type: "ready" });
  await host.idle();
  const off = host.posted.filter((m) => m.type === "state");
  assert.ok(off.length > 0);
  assert.equal(off[off.length - 1].aiOff, true);

  provider = "auto";
  host.posted.length = 0;
  await host.send({ type: "ready" });
  await host.idle();
  const auto = host.posted.filter((m) => m.type === "state");
  assert.equal(auto[auto.length - 1].aiOff, false);
});

test("the page shows the plug only while AI is neither on nor turned off", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 560 });
  cleanups.push(() => page.close());
  const plug = () => page.eval<boolean>(`(function () {
    var b = document.getElementById("connect-ai");
    return !!b && b.classList.contains("visible") && getComputedStyle(b).display !== "none";
  })()`);
  const base = stateMessage({ local: [{ name: "main", current: true }] });
  await page.send({ ...base, aiEnabled: false });
  assert.equal(await plug(), true, "AI not set up: the plug offers to connect it");
  await page.send({ ...base, aiEnabled: false, aiOff: true });
  assert.equal(await plug(), false, "AI turned off: no plug");
  await page.send({ ...base, aiEnabled: true });
  assert.equal(await plug(), false, "AI on: the sparkle, not the plug");
});
