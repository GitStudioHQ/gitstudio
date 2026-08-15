import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// `isAttributable` decides whether a process-wide failure gets transmitted off
// the user's machine, so it is the privacy boundary of the whole reporter.
//
// The extension host is shared by every installed extension, and
// `process.on("unhandledRejection")` sees all of them. The shipped version
// wrapped non-Error reasons in `new Error(String(reason))` before testing
// ownership — which stamped errorReporter.ts's own frame into the synthesized
// stack, so the check matched our bundle and returned true for everything. Three
// filed reports came from other extensions that way, one of them carrying a
// stranger's application source code in its message.
//
// These cases are the regression, not a style preference.

const SRC = fileURLToPath(new URL("../src/reporting/errorReporter.ts", import.meta.url));

const EXT_PATH = "/Users/someone/.vscode/extensions/gitstudio.gitstudio-1.5.0";

/**
 * Load the predicate without importing the module — errorReporter.ts imports
 * `vscode`, which only resolves inside a real extension host.
 */
async function loadIsAttributable(): Promise<(r: unknown, p: string) => boolean> {
  const source = await readFile(SRC, "utf8");
  const start = source.indexOf("export function isAttributable");
  assert.ok(start > 0, "isAttributable must stay a top-level exported function");
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, "could not find the end of isAttributable");
  const body = source.slice(start, end + 2).replace(/^export\s+/, "");
  // Strip the TS-only type predicate so plain JS can evaluate it.
  const js = body.replace(/:\s*reason is Error/, "").replace(/(\w+):\s*unknown|(\w+):\s*string/g, "$1$2");
  return new Function(`${js}; return isAttributable;`)() as (r: unknown, p: string) => boolean;
}

function errorWithStack(message: string, stack: string): Error {
  const e = new Error(message);
  e.stack = stack;
  return e;
}

test("reports errors thrown from GitStudio's own bundle", async () => {
  const isAttributable = await loadIsAttributable();
  assert.equal(
    isAttributable(
      errorWithStack("boom", `Error: boom\n    at Object.x (${EXT_PATH}/dist/extension.js:1:1)`),
      EXT_PATH,
    ),
    true,
  );
  // Also recognised when the install path differs but the publisher id is present.
  assert.equal(
    isAttributable(
      errorWithStack(
        "boom",
        "Error: boom\n    at x (/tmp/gitstudio.gitstudio-1.5.0/out/extension.js:1:1)",
      ),
      EXT_PATH,
    ),
    true,
  );
});

test("does NOT report another extension's error", async () => {
  const isAttributable = await loadIsAttributable();
  assert.equal(
    isAttributable(
      errorWithStack(
        "Widget Preview server process terminated",
        "Error: Widget Preview\n    at x (/Users/someone/.vscode/extensions/other.ext-2.0.0/out/main.js:1:1)",
      ),
      EXT_PATH,
    ),
    false,
  );
});

test("does NOT report a non-Error rejection, whatever its shape", async () => {
  const isAttributable = await loadIsAttributable();
  // Each of these was filed as a GitStudio crash by the shipped version, because
  // wrapping them produced a stack pointing at our own handler.
  const foreign: unknown[] = [
    "Widget Preview server process terminated",
    { code: 1, detail: "some object" },
    "ParseError\n  syntax error, unexpected token \"<<\"\n  at ~/projects/app/routes/web.php:1338",
    undefined,
    null,
    42,
    Symbol("nope"),
  ];
  for (const reason of foreign) {
    assert.equal(
      isAttributable(reason, EXT_PATH),
      false,
      `${String(reason)} carries no provenance and must not be attributed to GitStudio`,
    );
  }
});

test("does NOT let the MESSAGE stand in for provenance", async () => {
  const isAttributable = await loadIsAttributable();
  // `.stack` starts with the message, which is text we do not control. Matching
  // it would attribute another extension's error to us purely because the user
  // keeps a directory called "gitstudio" — the same privacy leak, different door.
  const foreignFrame =
    "    at Object.x (/Users/someone/.vscode/extensions/other.ext-2.0.0/out/main.js:1:1)";
  const cases: [string, string][] = [
    ["a user's own repo path in the message", "ENOENT: open '/Users/me/code/gitstudio/src/a.ts'"],
    ["our publisher id in the message", "failed to activate gitstudio.gitstudio"],
    ["our install path in the message", `cannot read ${EXT_PATH}/dist/extension.js`],
  ];
  for (const [why, message] of cases) {
    assert.equal(
      isAttributable(errorWithStack(message, `Error: ${message}\n${foreignFrame}`), EXT_PATH),
      false,
      `${why}: no GitStudio frame is present, so it is not ours`,
    );
  }
});

test("still reports when a GitStudio frame is present below a foreign one", async () => {
  const isAttributable = await loadIsAttributable();
  assert.equal(
    isAttributable(
      errorWithStack(
        "boom",
        "Error: boom\n    at vscode (/Applications/Code.app/out/x.js:1:1)\n" +
          `    at ours (${EXT_PATH}/dist/extension.js:9:9)`,
      ),
      EXT_PATH,
    ),
    true,
  );
});

test("does NOT report an Error with no stack at all", async () => {
  const isAttributable = await loadIsAttributable();
  const e = new Error("stackless");
  e.stack = undefined;
  assert.equal(isAttributable(e, EXT_PATH), false);
});

test("the handler never synthesizes an Error before the ownership check", async () => {
  // The exact regression: `new Error(String(reason))` inside the handler roots a
  // fresh stack in this file and defeats the check. Guard the source directly —
  // the behavioural tests above cannot see a wrapper reintroduced upstream.
  const source = await readFile(SRC, "utf8");
  const start = source.indexOf("this.onRejection =");
  assert.ok(start > 0, "could not locate the unhandledRejection handler");
  // Search for the registration FROM the handler, not from the top of the file —
  // the doc comment above mentions process.on("unhandledRejection") too.
  const end = source.indexOf('process.on("unhandledRejection"', start);
  assert.ok(end > start, "could not locate the unhandledRejection registration");
  const handler = source.slice(start, end);
  assert.doesNotMatch(
    handler,
    /new Error\(/,
    "the rejection handler must not construct an Error before attribution — that " +
      "stamps our own frame onto the stack and makes every foreign rejection look like ours",
  );
});
