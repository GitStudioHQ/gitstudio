import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The graph's ref list (issue #30) is sent only when it changed. The graph
// host imports `vscode` and cannot run here, so its half is pinned at source
// level; the courier it uses (RefListCourier) and the webview's half
// (applyGraphInitRefs) are exercised for real in host-bridge's and
// webview-ui's suites.

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const WEBVIEW = fileURLToPath(new URL("../../../packages/webview-ui/src", import.meta.url));
const DESKTOP = fileURLToPath(new URL("../../desktop/src", import.meta.url));

test("every graphInit the host posts goes through postInit, which sends the ref list only when it moved", async () => {
  const host = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  assert.equal(
    (host.match(/type: "graphInit"/g) ?? []).length,
    1,
    "exactly one place builds a graphInit — a second would carry the list unconditionally, or never",
  );
  assert.match(
    host,
    /private postInit\([\s\S]*?const refList = this\.refListCourier\.take\(list\);\s*this\.post\(\{ type: "graphInit", \.\.\.init, \.\.\.\(refList \? \{ refList \} : \{\}\) \}\);/,
    "postInit asks the courier, and leaves the key OUT when the list is unchanged",
  );
  assert.doesNotMatch(host, /refList: this\.refList/, "no graphInit spells the list out any more");
});

test("a webview that (re)loads is sent the list whole: 'ready' makes the courier forget", async () => {
  const host = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  assert.match(
    host,
    /case "ready":\s*this\.ready = true;[\s\S]*?this\.refListCourier\.forget\(\);\s*void this\.loadInitial\(\);/,
    "forget() runs before the load whose graphInit the fresh page needs the list in",
  );
});

test("every surface that takes a graphInit keeps its list when the message has none", async () => {
  // Three appliers, one rule: absent is "unchanged", never "empty".
  const appliers = [
    `${WEBVIEW}/graph/main.ts`,
    `${WEBVIEW}/graph/sidebar-main.ts`,
    `${DESKTOP}/renderer/graphMount.ts`,
  ];
  for (const f of appliers) {
    const text = await readFile(f, "utf8");
    assert.match(text, /applyGraphInitRefs\((graph|rail|this\.element), message\);/, `${f} applies the refs through the shared helper`);
    assert.doesNotMatch(text, /refList = message\.refList \?\? \[\]/, `${f} must not read an absent list as an empty one`);
  }
});
