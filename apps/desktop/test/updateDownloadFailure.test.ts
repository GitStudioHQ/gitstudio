import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadFailure } from "../src/main/autoUpdate";

// Reports #61 ("The operation was aborted due to timeout") and #62 ("fetch
// failed") were a user's network, filed as crashes of "Update download".

test("a download the network dropped is the user's network, not a crash", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const offline = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  // Report #88 (desktop 2.7.1): Chromium's net.fetch, the network switched
  // mid-download (Wi-Fi to Ethernet, a VPN coming up). Covered since #150.
  const switched = new Error("net::ERR_NETWORK_CHANGED");
  for (const e of [timeout, offline, switched]) {
    const r = downloadFailure(e);
    assert.equal(r.ok, false);
    assert.equal(r.expected, true, e.message);
    assert.match(r.message ?? "", /check your connection/);
  }
});

test("a download that failed for another reason keeps reporting", () => {
  // A disk error carries a Node code too; only the network's codes are the network.
  const r = downloadFailure(Object.assign(new Error("EACCES: permission denied, open '/x/GitStudio.dmg.part'"), { code: "EACCES" }));
  assert.equal(r.expected, undefined);
  assert.match(r.message ?? "", /permission denied/);
});
