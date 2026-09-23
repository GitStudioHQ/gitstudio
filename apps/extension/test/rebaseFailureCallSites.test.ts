import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A rebase the extension runs and that FAILS must reach the crash reporter —
// unless it failed over a state of the user's repository.
//
// The extension reports git failures from one place, showGitError, and the
// rebase doors never went through it: the rebase panel (Start / Continue)
// posted a failed outcome to its webview and stopped, and the graph's
// drag-to-reorder showed "reorder failed" and stopped. So the runner's editor
// shim not starting, or a base that does not exist, was never heard — the same
// hole the desktop's `rebase:apply` had, whose answer `{status}` the IPC
// wrapper never read.
//
// Both products now apply one rule, `reportableRebaseFailure` in
// @gitstudio/git-service/RebaseRunner: a `failed` outcome is filed unless the
// runner (a rebase already under way, uncommitted changes) or the plan
// builder (a plan the user composed that git cannot run) marked it
// `expected`. In the extension it is applied in the runner's VS Code binding,
// so no door can run a rebase without it. The extension's test runner cannot
// load `vscode`, so this reads the source.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BINDING = "apps/extension/src/rebase/rebaseRunner.ts";
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A function's body, comments stripped: from its declaration to the first
 *  line that closes it at column 0. */
function body(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `${decl} is still declared`);
  return src
    .slice(start, src.indexOf("\n}\n", start))
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
}

test("the reporting rule is the shared one, and it files through the reporter", async () => {
  const src = await readFile(join(ROOT, BINDING), "utf8");
  const code = body(src, "export function reportRebaseFailure(");
  assert.match(code, /reportableRebaseFailure\(/, "the rule both products apply, not a copy of it");
  assert.match(code, /ErrorReporter\.current\?\.captureGitError\(/, "…filed through the extension's reporter");
});

test("every rebase the binding runs or resumes goes through that rule", async () => {
  const src = await readFile(join(ROOT, BINDING), "utf8");
  for (const decl of ["export async function runRebasePlan(", "export async function continueRebase("]) {
    assert.match(body(src, decl), /reportRebaseFailure\(/, `${decl.trim()} reports a failed outcome`);
  }
});

test("no door runs the shared runner around the binding", async () => {
  const bypass: string[] = [];
  for (const file of await tsFiles(join(ROOT, "apps/extension/src"))) {
    if (relative(ROOT, file) === BINDING) continue;
    const src = await readFile(file, "utf8");
    const imports = src.match(/import\s*\{[^}]*\}\s*from\s*"@gitstudio\/git-service\/RebaseRunner"/g) ?? [];
    for (const i of imports) {
      if (/\b(runRebasePlan|continueRebase|skipRebase)\b/.test(i)) bypass.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(bypass, [], "a rebase run straight from the engine would skip the report rule");
});

test("every plan the builder refuses is judged by the same rule", async () => {
  const unjudged: string[] = [];
  let seen = 0;
  for (const file of await tsFiles(join(ROOT, "apps/extension/src"))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line) || !/\bbuildRebasePlan\(/.test(line) || /^\s*import\b/.test(line)) return;
      seen++;
      const below = lines
        .slice(i, i + 14)
        .filter((l) => !COMMENT.test(l))
        .join("\n");
      if (/reportRebaseFailure\(/.test(below)) return;
      unjudged.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.ok(seen >= 2, `the scan found only ${seen} plan builds — it broke`);
  assert.equal(
    unjudged.join("\n"),
    "",
    "plan refusals nobody hands to reportRebaseFailure — a request built wrong would never be heard of:\n" +
      unjudged.join("\n"),
  );
});
