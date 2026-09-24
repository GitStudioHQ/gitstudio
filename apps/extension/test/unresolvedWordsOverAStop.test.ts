// "You still have conflicts", as the extension says it, over every stop of the
// conflict matrix (scripts/merge-e2e/fixtures.sh — every operation, every
// merge.conflictStyle).
//
// A git command refused over an unmerged index is a warning in
// unresolvedConflictsMessage's words, never an error and never filed. They
// told a rebase, a cherry-pick, a revert and a `git am` to "commit" — in the
// middle of a rebase, the one thing not to do. The way on is now the stopped
// operation's own. Pressed here as the graph's Reset → Soft, which git refuses
// over any conflicted stop ("Cannot do a soft reset in the middle of a merge").
// (The desktop's column: apps/desktop/test/unresolvedWordsOverAStop.test.ts.)

import Module from "node:module";
import { join } from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { __said: { kind: string; message: string }[] };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { runCommitAction } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-words-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const filed: string[] = [];
(ErrorReporter as unknown as { current: unknown }).current = {
  captureGitError: (label: string, stderr: string) => filed.push(`${label}: ${stderr}`),
  captureError: (where: string, err: unknown) => filed.push(`${where}: ${String(err)}`),
};
// Reset asks which kind: Soft.
registerDialogHost({ show: async () => ({ value: "--soft" }) });

const FIXTURES = join(__dirname, "../../../scripts/merge-e2e/fixtures.sh");
let target: string;
let scenarios: { id: string; op: string; dir: string }[] = [];

before(() => {
  target = mkdtempSync(join(tmpdir(), "gs-ext-words-matrix-"));
  const r = spawnSync("bash", [FIXTURES, target], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`fixtures.sh failed (${r.status}):\n${r.stderr}`);
  scenarios = (JSON.parse(readFileSync(join(target, "matrix.json"), "utf8")) as { scenarios: typeof scenarios }).scenarios.map(
    (s) => ({ ...s, dir: join(target, s.dir) }),
  );
});
after(() => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** The words each operation's way on must use. */
function wayOn(op: string): RegExp {
  if (op === "merge") return /Resolve (?:it|them) and commit the merge, or abort it, then try again\.$/;
  if (op.startsWith("rebase") || op.startsWith("issue12")) return /Resolve (?:it|them) and continue the rebase, or abort it, then try again\.$/;
  if (op.startsWith("cherry-pick")) return /Resolve (?:it|them) and continue the cherry-pick, or abort it, then try again\.$/;
  if (op === "revert") return /Resolve (?:it|them) and continue the revert, or abort it, then try again\.$/;
  if (op === "am") return /Resolve (?:it|them) and continue, or abort it, then try again\.$/;
  if (op === "stash") return /Resolve (?:it|them), then try again\.$/;
  throw new Error(`no words for ${op}`);
}

test("a command refused over the conflicts warns in the stopped operation's own words — 'commit' only for a merge", async () => {
  assert.equal(scenarios.length, 33, "the whole matrix");
  for (const s of scenarios) {
    const ctx = new GitContext({ root: s.dir });
    try {
      vscode.__said.length = 0;
      filed.length = 0;
      const head = git(s.dir, "rev-parse", "HEAD").trim();
      await runCommitAction("reset", ctx, { sha: head, subject: "x" } as never);
      const warned = vscode.__said.filter((m) => m.kind === "warning").map((m) => m.message);
      assert.equal(warned.length, 1, `${s.id}: one warning — said ${JSON.stringify(vscode.__said)}`);
      assert.deepEqual(vscode.__said.filter((m) => m.kind === "error"), [], `${s.id}: no red error`);
      assert.deepEqual(filed, [], `${s.id}: nothing filed`);
      assert.match(warned[0], /— (?:1 file still has|\d+ files still have) unresolved conflicts\. /, `${s.id}: ${warned[0]}`);
      assert.match(warned[0], wayOn(s.op), `${s.id}: ${warned[0]}`);
      if (s.op !== "merge") assert.doesNotMatch(warned[0], /commit/, `${s.id}: never "commit" outside a merge`);
    } finally {
      ctx.dispose();
    }
  }
});
