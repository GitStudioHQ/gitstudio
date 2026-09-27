// Syntax-checks the Changes view's inline script, which no compiler reads:
// lifts the page out of commitView.ts exactly as the tests do, writes each
// <script> body to a file and runs `node --check` on it.
//
//   npx tsx apps/extension/harness/changes/check-script.ts
//
// Exits non-zero, with node's message, on the first script that does not parse.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesViewHtml } from "../../test/changesPage";

const html = changesViewHtml("dark");
const dir = mkdtempSync(join(tmpdir(), "gs-changes-script-"));
let n = 0;
try {
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const file = join(dir, `script-${n++}.js`);
    writeFileSync(file, m[1]);
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
  console.log(`${n} script(s) parse`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
