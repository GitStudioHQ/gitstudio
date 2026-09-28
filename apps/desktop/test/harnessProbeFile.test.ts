import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { probeFile } from "../harness/probe-file.mjs";

/**
 * The harness page runs no code it reads out of its URL. A probe's body used
 * to travel in ?probe= and run through new Function; now the launcher writes
 * it to a file beside the page (harness/probe-file.mjs) and ?probe= only NAMES
 * that file — the shim refuses any other shape of name. And ?op= picks a
 * conflict view from a Map, calling it only when it is a function there, so
 * "constructor" or "toString" in the URL calls nothing an object inherits.
 */

const HARNESS = fileURLToPath(new URL("../harness/", import.meta.url));
const shim = readFileSync(join(HARNESS, "shim.js"), "utf8");
/** Code only: a comment may say what the shim no longer does. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");

test("the harness shim builds no code from its URL", () => {
  const c = code(shim);
  assert.doesNotMatch(c, /\bnew Function\s*\(/, "shim.js compiles a string with new Function");
  assert.doesNotMatch(c, /(^|[^.\w])eval\s*\(/, "shim.js evals a string");
  assert.doesNotMatch(c, /views\[kind\]\s*\(/, "shim.js calls whatever ?op= names on a plain object");
  // The probe name is checked before it becomes a file name.
  assert.match(c, /if \(!\/\^\[A-Za-z0-9-\]\+\$\/\.test\(probe\)\) throw/, "shim.js takes ?probe= as a name only");
  assert.match(c, /s\.src = `probes\/\$\{probe\}\.js`;/, "shim.js loads the probe from its own probes/ directory");
});

test("every probe launcher hands its body over as a file, never in the URL", () => {
  const launchers = readdirSync(HARNESS)
    .filter((n) => n.endsWith(".mjs"))
    .map((name) => ({ name, src: readFileSync(join(HARNESS, name), "utf8") }))
    .filter(({ name, src }) => name !== "probe-file.mjs" && /[?&]probe=/.test(src));
  // probe, perf, validate, contrast, affordance and fit
  assert.ok(launchers.length >= 6, `found only ${launchers.map((l) => l.name).join(", ")}`);
  for (const { name, src } of launchers) {
    assert.match(src, /import \{ probeFile \} from "\.\/probe-file\.mjs";/, `${name} does not import probeFile`);
    assert.match(src, /const probe = probeFile\(PAGE, /, `${name} does not write its body with probeFile()`);
    assert.doesNotMatch(src, /&probe=\$\{(?!probe\.param\})/, `${name} puts something other than the probe's name in ?probe=`);
    assert.match(src, /probe\.cleanup\(\);/, `${name} leaves its probe file behind`);
  }
});

test("a probe file runs its body as the page used to: strict, async, its value returned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-probe-file-"));
  try {
    const page = join(dir, "harness.html");
    writeFileSync(page, "");
    const p = probeFile(page, 'const n = await Promise.resolve(6);\nreturn { n: n * 7, strict: this === undefined };');
    // The name is one the shim accepts.
    assert.match(p.param, /^[A-Za-z0-9-]+$/);
    const file = join(dir, "probes", `${p.param}.js`);
    const window: { __gsProbe?: () => Promise<unknown> } = {};
    runInNewContext(readFileSync(file, "utf8"), { window });
    // Called bare, as the shim calls it.
    const run = window.__gsProbe;
    assert.equal(typeof run, "function");
    // JSON, as the page prints it (the value is from the vm's own realm).
    assert.equal(JSON.stringify(await run!()), JSON.stringify({ n: 42, strict: true }));
    p.cleanup();
    assert.deepEqual(readdirSync(join(dir, "probes")), [], "cleanup() removes the file");
    // A body that does not parse is refused here, in the parser's words —
    // the page could only have said "Script error." — and nothing is written.
    assert.throws(() => probeFile(page, "return {"), SyntaxError);
    assert.deepEqual(readdirSync(join(dir, "probes")), [], "no file for a body that does not parse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
