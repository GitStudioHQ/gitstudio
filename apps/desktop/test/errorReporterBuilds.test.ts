import { test } from "node:test";
import assert from "node:assert/strict";
import { isShippedBuild } from "../src/main/errorReporter";

// Report #78 came from a test: the main process under plain Node with a fake
// `app` ("0.0.0-quit-test", "Electron ?") posted to the real collector.

test("only a released build inside Electron reports", () => {
  assert.equal(isShippedBuild("2.8.0", "41.10.7"), true);
  assert.equal(isShippedBuild("2.8.1-beta.1", "41.10.7"), true);
  assert.equal(isShippedBuild("0.0.0-quit-test", undefined), false, "a test under plain Node");
  assert.equal(isShippedBuild("0.0.0-test", "41.10.7"), false, "a fake app version");
  assert.equal(isShippedBuild("0.0.0", "41.10.7"), false, "app.getVersion() threw");
  assert.equal(isShippedBuild("2.8.0", undefined), false, "not Electron");
});
