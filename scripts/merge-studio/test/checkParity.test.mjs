// check-parity.mjs against a small vendored tree it did not write: every way
// the tree can drift from VENDORED_FROM.json is reported, and the CLI's exit
// code says so. (Copied beside check-parity.mjs into the merge-studio
// repository by export.mjs, so it runs in both repositories.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkParity, FAILURE_HELP, hashFiles, listFiles, MANIFEST_FILE, sha256, VENDOR_DIR } from "../check-parity.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-parity.mjs");

function tree() {
  const root = mkdtempSync(join(tmpdir(), "check-parity-"));
  const files = {
    [`${VENDOR_DIR}/engine/src/mergeModel.ts`]: "export const a = 1;\n",
    [`${VENDOR_DIR}/engine/package.json`]: '{"name":"@gitstudio/engine"}\n',
    [`${VENDOR_DIR}/webview-ui/src/styles/diff.css`]: ".jb { color: red }\n",
    "src/extension.ts": "export function activate() {}\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const vendored = listFiles(join(root, VENDOR_DIR), root);
  writeFileSync(
    join(root, MANIFEST_FILE),
    JSON.stringify({
      schema: 1,
      gitstudio: { sha: "0123456789abcdef0123456789abcdef01234567", dirty: false },
      files: hashFiles(root, vendored),
      shell: hashFiles(root, ["src/extension.ts"]),
    }),
  );
  return root;
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const cli = (root, ...extra) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });

test("an untouched export passes, and the CLI exits 0", () => {
  const root = tree();
  try {
    const r = checkParity(root);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 3);
    const run = cli(root);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /check-parity: ok — 3 vendored files match gitstudio 0123456/);
  } finally {
    cleanup(root);
  }
});

test("one changed byte in a vendored file fails, naming the file", () => {
  const root = tree();
  try {
    const file = `${VENDOR_DIR}/engine/src/mergeModel.ts`;
    writeFileSync(join(root, file), "export const a = 2;\n");
    const r = checkParity(root);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [`modified: ${file}`]);
    const run = cli(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /modified: vendor\/gitstudio\/engine\/src\/mergeModel\.ts/);
    // A contributor reading the red CI step learns what to do: keep the pull request.
    assert.ok(run.stderr.includes(FAILURE_HELP));
    assert.match(FAILURE_HELP, /Contributing a change\? Keep it and open your pull request anyway/);
    assert.match(FAILURE_HELP, /npm run check-types && npm test/);
    assert.match(FAILURE_HELP, /scripts\/merge-studio\/import\.mjs/);
  } finally {
    cleanup(root);
  }
});

test("a deleted vendored file and an added one both fail", () => {
  const root = tree();
  try {
    unlinkSync(join(root, `${VENDOR_DIR}/webview-ui/src/styles/diff.css`));
    writeFileSync(join(root, `${VENDOR_DIR}/engine/src/localPatch.ts`), "export {};\n");
    const r = checkParity(root);
    assert.deepEqual(r.problems.sort(), [
      `added: ${VENDOR_DIR}/engine/src/localPatch.ts`,
      `missing: ${VENDOR_DIR}/webview-ui/src/styles/diff.css`,
    ]);
  } finally {
    cleanup(root);
  }
});

test("Finder's .DS_Store is not drift", () => {
  const root = tree();
  try {
    writeFileSync(join(root, `${VENDOR_DIR}/engine/.DS_Store`), "junk");
    assert.equal(checkParity(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test("a shell file changed in merge-studio is a warning, and a failure with --strict", () => {
  const root = tree();
  try {
    writeFileSync(join(root, "src/extension.ts"), "export function activate() { /* local fix */ }\n");
    const r = checkParity(root);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /shell modified: src\/extension\.ts/);
    const strict = checkParity(root, { strict: true });
    assert.equal(strict.ok, false);
    assert.equal(cli(root, "--strict").status, 1);
  } finally {
    cleanup(root);
  }
});

test("no manifest, or an empty one, fails", () => {
  const root = tree();
  try {
    writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ files: {} }));
    assert.equal(checkParity(root).ok, false);
    unlinkSync(join(root, MANIFEST_FILE));
    const r = checkParity(root);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /VENDORED_FROM\.json is missing/);
  } finally {
    cleanup(root);
  }
});

test("hashes are sha256 of the bytes", () => {
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
