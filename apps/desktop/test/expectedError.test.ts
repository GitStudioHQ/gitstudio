import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpectedError, isExpectedError } from "../src/main/expectedError";

// Every IPC handler is wrapped in a catch that files a crash report, because a
// handler that throws is normally a bug. Some throws are just answers, though —
// "you have not connected GitHub" is a state the user is allowed to be in. Those
// were filed as failures; one arrived three times from someone who had simply
// not signed in.

test("an expected condition is not reportable", () => {
  assert.equal(isExpectedError(new ExpectedError("Not connected to GitHub.")), true);
});

test("an ordinary Error still is", () => {
  assert.equal(isExpectedError(new Error("Not connected to GitHub.")), false);
  assert.equal(isExpectedError(new TypeError("undefined is not a function")), false);
});

test("the message is untouched", () => {
  const e = new ExpectedError("Not connected to GitHub.");
  assert.equal(e.message, "Not connected to GitHub.");
  assert.ok(e instanceof Error, "must stay an Error for existing catch sites");
});

test("survives IPC serialisation looking exactly like a plain Error", () => {
  // The one that matters, and the one an in-process `e.message` assertion cannot
  // see. Electron rejects an IPC call with the handler error's toString(), and
  // the renderer's cleanErr() strips a leading "Error:" — but would NOT strip
  // "ExpectedError:". Setting `name` on this class therefore put the class name
  // in front of every message a user reads. Keep the wire format identical.
  const cleanErr = (s: string): string =>
    s
      .replace(/^Error invoking remote method '[^']*':\s*/i, "")
      .replace(/^(Uncaught\s+)?(Error|UnhandledPromiseRejection):\s*/i, "");

  const onTheWire = (e: Error): string =>
    `Error invoking remote method 'github:notifications': ${e.toString()}`;

  const expected = new ExpectedError("Not connected to GitHub.");
  const plain = new Error("Not connected to GitHub.");

  assert.equal(
    cleanErr(onTheWire(expected)),
    "Not connected to GitHub.",
    "the user must not see the class name",
  );
  assert.equal(
    cleanErr(onTheWire(expected)),
    cleanErr(onTheWire(plain)),
    "must be indistinguishable from the plain Error it replaced",
  );
});

test("recognised structurally, so a bundle boundary cannot defeat it", () => {
  // Two copies of the class across bundles would fail `instanceof`; the marker
  // property is what keeps the check honest.
  assert.equal(isExpectedError({ expected: true, message: "x" }), true);
  assert.equal(isExpectedError({ expected: false }), false);
  assert.equal(isExpectedError({}), false);
});

test("also recognises a RETURNED ok:false result, not just a throw", () => {
  // Some handlers report "not connected" by returning ok:false instead of
  // throwing, and the IPC wrapper reports those down a separate branch. Marking
  // the throw alone left the exact message it was meant to stop still being
  // filed, from prMerge and prApprove.
  assert.equal(
    isExpectedError({ ok: false, changed: false, message: "Not connected to GitHub.", expected: true }),
    true,
  );
  assert.equal(
    isExpectedError({ ok: false, changed: false, message: "merge conflict" }),
    false,
    "an ordinary handled failure must still be reported",
  );
});

test("non-objects never count as expected", () => {
  for (const v of [undefined, null, "expected", 0, true]) {
    assert.equal(isExpectedError(v), false, `${String(v)} must not be treated as expected`);
  }
});
