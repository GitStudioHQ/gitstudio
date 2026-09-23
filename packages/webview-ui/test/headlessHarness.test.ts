import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeVerdictTitle, findChrome, runInChrome } from "./headless";
import { runMergePage } from "./fixtures/mergeViewPage";

// The headless harness itself, on a machine whose data volume runs near full:
//
// - runInChrome made a `gs-webview-*` directory per page and never removed it;
//   434 had piled up in $TMPDIR in one night of runs across agents.
// - The verdict (JSON in the page <title>) was decoded `&amp;` FIRST, so text
//   that really contained "&lt;" came back as "<" — a check about escaping
//   could read its own evidence wrong.

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));

test("a verdict decodes each entity once: '&amp;lt;' is the text '&lt;', not '<'", () => {
  assert.equal(decodeVerdictTitle("&amp;lt;b&amp;gt; &lt;b&gt; &quot;q&quot; &#39;s&#39; a&amp;b"), "&lt;b&gt; <b> \"q\" 's' a&b");
});

test("runInChrome leaves no page directory behind", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, `notes.href = location.href;`);
  assert.deepEqual(v.fails, []);
  const href = (v.notes as { href?: string } | undefined)?.href;
  assert.ok(href && href.startsWith("file://"), `the page reported where it was (${href})`);
  assert.equal(existsSync(dirname(fileURLToPath(href!))), false, "its directory is gone once the verdict is in");
});

test("the merge page's verdict decodes the same way", { skip }, async () => {
  const v = await runMergePage(CHROME!, `notes.text = "&lt;";`);
  assert.deepEqual(v.fails, []);
  assert.equal((v.notes as { text?: string } | undefined)?.text, "&lt;");
});
