import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The desktop's reporter cannot post outside Electron, so what a report
// carries is tested on the extension's (errorReporter.cov.test.ts) — and
// these two must therefore be the same code. Both capture methods, comments
// aside, line for line.
test("the desktop's capture methods are the extension's", () => {
  const body = (file: string) => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const from = src.indexOf("  captureError(where: string");
    const to = src.indexOf("  private send(", from);
    assert.ok(from > 0 && to > from, file);
    return src
      .slice(from, to)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("/**") && !l.startsWith("*"))
      .join("\n");
  };
  const desktop = body("../src/main/errorReporter.ts");
  assert.equal(desktop, body("../../extension/src/reporting/errorReporter.ts"));
  for (const call of ["isReportableThrown(e)", "thrownReport(e)", "userStateOutcome(stderr", "gitVerdict(stderr"]) {
    assert.ok(desktop.includes(call), call);
  }
});
