import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A NUL byte written LITERALLY into a source file makes grep and ripgrep
// classify that whole file as binary and skip it — silently. Not "matches
// nothing": the file stops existing as far as every text search is concerned,
// yours and every contributor's.
//
// Five files had one, all of them using NUL legitimately as a delimiter that
// cannot occur in a path, label or URI. The cost was not the delimiter, it was
// the encoding. `grep -rn diffInit apps/extension/src` reported that nothing in
// the extension ever opened our own 2-pane diff page, so it was written off as
// dead code — while merge/diffPanel.ts, invisible, registered it as a webview
// panel, kept it live on document changes and exported the entry point for it.
// The same blindness hid `String.raw` in ai/aiCommands.ts from a search run to
// check whether that very file was String.raw-tagged.
//
// The fix is always the escape: "\u0000" is the same character at runtime and
// leaves the file as plain text. This guard keeps it that way.

const ROOTS = [
  "../src",
  "../../desktop/src",
  "../../mcp/src",
  "../../../packages/webview-ui/src",
  "../../../packages/engine/src",
  "../../../packages/git-service/src",
  "../../../packages/host-bridge/src",
  "../../../packages/ai/src",
  "../../../packages/secret-store/src",
].map((r) => fileURLToPath(new URL(r, import.meta.url)));

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (/\.(ts|tsx|js|mjs|cjs|css|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("no source file contains a literal NUL byte", async () => {
  const files = (await Promise.all(ROOTS.map(sourceFiles))).flat();
  assert.ok(files.length > 100, "expected to have scanned the monorepo sources");

  const offenders: string[] = [];
  for (const file of files) {
    // Read as bytes. Reading as utf8 and searching for the character would work
    // too, but bytes make it explicit that this is about what is ON DISK.
    const bytes = await readFile(file);
    const at = bytes.indexOf(0);
    if (at === -1) continue;
    const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
    const rel = relative(REPO, file).split("\\").join("/");
    offenders.push(
      `${rel}:${line} — literal NUL byte, so grep and rg skip this entire file. ` +
        `Write it as the escape "\\u0000" instead; it is the same character at runtime.`,
    );
  }

  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}\n`);
});

test("the escape really is the same character, so the fix costs nothing", () => {
  // Guards the assumption the advice above rests on. If this ever failed, every
  // delimiter we rewrote would have quietly changed meaning.
  const NUL = String.fromCharCode(0);
  assert.equal("\u0000", NUL);
  assert.equal("\u0000".length, 1);
  assert.ok(new RegExp("^a\\u0000b$").test(`a${NUL}b`));
  // And the key-building idiom that started this: components joined on NUL
  // cannot collide with a component that merely contains the separator text.
  assert.notEqual(["a", "b"].join("\u0000"), ["a\\u0000b"].join("\u0000"));
});
