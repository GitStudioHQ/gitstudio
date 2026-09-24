// "You still have conflicts", as the desktop says it, over every stop of the
// conflict matrix (scripts/merge-e2e/fixtures.sh — every operation, every
// merge.conflictStyle).
//
// A command git refuses over an unmerged index is answered with
// unresolvedConflictsMessage, `expected` (the user's state, never filed). It
// told a rebase, a cherry-pick, a revert and a `git am` to "commit" — in the
// middle of a rebase, the one thing not to do. The way on is now the stopped
// operation's own: commit the merge; continue the rebase, the cherry-pick,
// the revert, the am; and for files a stash pop left unmerged, just resolve.
// Pressed here as a soft reset from the graph, which git refuses over any
// conflicted stop ("Cannot do a soft reset in the middle of a merge").

import "./hermeticGit";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";

const FIXTURES = fileURLToPath(new URL("../../../scripts/merge-e2e/fixtures.sh", import.meta.url));

let target: string;
let scenarios: { id: string; op: string; dir: string }[] = [];

before(() => {
  target = mkdtempSync(join(tmpdir(), "gs-desk-words-matrix-"));
  const r = spawnSync("bash", [FIXTURES, target], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`fixtures.sh failed (${r.status}):\n${r.stderr}`);
  scenarios = (JSON.parse(readFileSync(join(target, "matrix.json"), "utf8")) as { scenarios: typeof scenarios }).scenarios.map(
    (s) => ({ ...s, dir: join(target, s.dir) }),
  );
});
after(() => removeTempRepo(target));

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** The operation each scenario is stopped in, by the words its way on must use. */
function wayOn(op: string): RegExp {
  if (op === "merge") return /Resolve (?:it|them) and commit the merge, or abort it, then try again\.$/;
  if (op.startsWith("rebase") || op.startsWith("issue12")) return /Resolve (?:it|them) and continue the rebase, or abort it, then try again\.$/;
  if (op.startsWith("cherry-pick")) return /Resolve (?:it|them) and continue the cherry-pick, or abort it, then try again\.$/;
  if (op === "revert") return /Resolve (?:it|them) and continue the revert, or abort it, then try again\.$/;
  if (op === "am") return /Resolve (?:it|them) and continue, or abort it, then try again\.$/;
  if (op === "stash") return /Resolve (?:it|them), then try again\.$/;
  throw new Error(`no words for ${op}`);
}

test("a command refused over the conflicts says the stopped operation's own way on — 'commit' only for a merge", async () => {
  assert.equal(scenarios.length, 33, "the whole matrix");
  for (const s of scenarios) {
    const repos = new RepoStore([]);
    await repos.open(s.dir);
    const bridge = new GitBridge(repos);
    const head = git(s.dir, "rev-parse", "HEAD").trim();
    const r = await bridge.commitAction({ action: "reset-soft", sha: head });
    assert.equal(r.ok, false, `${s.id}: git refuses a soft reset over the conflicts`);
    assert.equal(r.expected, true, `${s.id}: the user's state`);
    assert.equal(reportableResultMessage(r), undefined, `${s.id}: nothing filed`);
    assert.match(r.message ?? "", /^(?:1 file still has|\d+ files still have) unresolved conflicts\. /, `${s.id}: ${r.message}`);
    assert.match(r.message ?? "", wayOn(s.op), `${s.id}: ${r.message}`);
    if (s.op !== "merge") assert.doesNotMatch(r.message ?? "", /commit/, `${s.id}: never "commit" outside a merge`);
  }
});
