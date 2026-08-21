import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every push surface must have decided about --force-with-lease.
//
// This is the guard that would actually have caught the amend bug. The ENGINE
// was always correct — SyncOps.push() adds --force-with-lease whenever it is
// asked to. The defect was that twelve of thirteen callers never asked, so
// amending a commit the remote already had produced a push that could only ever
// be rejected, with no way forward from the UI.
//
// A test of the engine cannot see that. A census of the call sites can.
//
// The rule: a `sync.push(` / `syncPush(` call either mentions `force`, or it
// carries an explicit `push-force-reviewed:` note saying why forcing is not
// applicable there. Publishing a brand-new branch, for instance, cannot need a
// force — but that should be a decision on the record, not an omission.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN = ["apps/extension/src", "apps/desktop/src", "packages/git-service/src"];
const CALL = /(?:sync\.push|syncPush)\s*\(/;
const EXEMPT = /push-force-reviewed:/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every push call site has decided about force-with-lease", async () => {
  const unreviewed: string[] = [];
  let seen = 0;

  for (const rel of SCAN) {
    for (const file of await tsFiles(join(ROOT, rel))) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (!CALL.test(line)) return;
        seen++;
        // Look BOTH ways: the options may be on this line or wrapped onto the
        // next few, while a `push-force-reviewed:` note is written above the
        // call, where a reader meets it first.
        const window = lines.slice(Math.max(0, i - 4), i + 6).join("\n");
        if (/force/.test(window) || EXEMPT.test(window)) return;
        unreviewed.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
      });
    }
  }

  assert.ok(seen > 5, `the scan found only ${seen} push call sites — it broke`);
  assert.equal(
    unreviewed.join("\n"),
    "",
    "push call sites that neither pass `force` nor carry a " +
      "`push-force-reviewed:` note explaining why they cannot need it:\n" +
      unreviewed.join("\n"),
  );
});
