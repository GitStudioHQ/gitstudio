import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// Two reads that were paying for git processes nobody looked at.
//
// `commit:rowStats` answers the graph's CHANGES column for every row in view.
// It ran per sha: a `log -1` for any row the graph accumulator had not seen
// (which, right after a page load from the sidebar rail, is all of them), then
// the two diffs behind `getCommitFiles` — three spawns per row, all fired at
// once, for a window of sixty. Now it is one `log --no-walk` for the window.
//
// `repo:headCommit` always ran `rev-list --count HEAD` — a walk of the whole
// history — although two of its three readers (the amend prefill, the
// dashboard) never look at the count. The count is opt-in now.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
let spawns: string[][] = [];
const shas: string[] = [];

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-rowstats-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0"); // no background gc racing the cleanup
  git("config", "core.autocrlf", "false"); // and no line-ending rewriting
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `${"line\n".repeat(i + 1)}`);
    if (i > 0) writeFileSync(join(repo, "f0.txt"), `${"line\n".repeat(i + 1)}`);
    git("add", ".");
    git("commit", "-q", "-m", `commit ${i}\n\nbody ${i}\n\nCo-Authored-By: Someone <s@example.com>`);
    shas.push(git("rev-parse", "HEAD"));
  }
  ctx = new GitContext({ root: repo, onRun: (e) => void spawns.push(e.args) });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

after(() => {
  ctx?.dispose();
  removeTempRepo(repo);
});

test("rowStats answers a window of rows the graph has never loaded with ONE git process", async () => {
  // A bridge that has loaded no graph page: every sha is uncached, which is the
  // state right after a reveal from the sidebar rail, and the worst case.
  spawns = [];
  const stats = await bridge.rowStats(shas);
  assert.equal(spawns.length, 1, `spawned ${spawns.length} git processes for ${shas.length} rows`);
  assert.equal(stats.length, shas.length, "every row is answered");
  const bySha = new Map(stats.map((s) => [s.sha, s]));
  // …and says what the per-commit read said. The first commit adds f0 (one
  // line); each later commit i adds f<i> (i+1 lines) and grows f0 by one.
  assert.deepEqual(bySha.get(shas[0]), { sha: shas[0], files: 1, additions: 1, deletions: 0 });
  for (let i = 1; i < shas.length; i++) {
    assert.deepEqual(
      bySha.get(shas[i]),
      { sha: shas[i], files: 2, additions: i + 2, deletions: 0 },
      `commit ${i}`,
    );
  }
});

test("rowStats: more shas than the cap are answered up to the cap, still in one process", async () => {
  spawns = [];
  const many = Array.from({ length: 300 }, (_, i) => shas[i % shas.length]);
  const stats = await bridge.rowStats(many);
  assert.equal(spawns.length, 1);
  // git answers each distinct sha once, whatever the request repeated.
  assert.equal(stats.length, shas.length);
});

test("headCommit does not walk the history unless the count is asked for", async () => {
  spawns = [];
  const hc = await bridge.headCommit();
  assert.ok(hc);
  assert.equal(hc.sha, shas[shas.length - 1]);
  assert.equal(hc.subject, "commit 5");
  assert.equal(hc.message, "commit 5\n\nbody 5\n\nCo-Authored-By: Someone <s@example.com>");
  assert.equal(hc.total, undefined, "no count was asked for, so none is reported");
  assert.equal(spawns.length, 1, "one `log -1`, no `rev-list --count`");
  assert.ok(!spawns.some((a) => a[0] === "rev-list"), "the history was not walked");
});

test("headCommit counts the history when asked", async () => {
  spawns = [];
  const hc = await bridge.headCommit({ count: true });
  assert.ok(hc);
  assert.equal(hc.total, shas.length);
  assert.ok(spawns.some((a) => a[0] === "rev-list" && a.includes("--count")));
});
