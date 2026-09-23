import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { chipRefs } from "@gitstudio/host-bridge/graphRefFilter";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The commit-details pane's ref chips (issue #30's follow-up). They are a
// shortcut into the graph's chip menu now, resolved through the graph's ref
// list by full name — and the pane listed refs/remotes/origin/HEAD, which the
// graph deliberately draws no chip for (a pointer at the default branch, not a
// branch) and the picker's list deliberately leaves out. So on the default
// branch's tip the pane showed an "origin/HEAD" chip whose menu could only
// ever say "Not in the branch list yet — refresh the graph". The pane's chips
// are the graph's (wireRefs) now. Real git: the claim is what for-each-ref
// lists.

let upstream: string;
let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
let tip = "";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

before(() => {
  upstream = mkdtempSync(join(tmpdir(), "gitstudio-dr-up-"));
  g(upstream, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gitstudio-dr-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  g(repo, "config", "user.email", "dev@example.com");
  g(repo, "config", "user.name", "Dev");
  g(repo, "config", "gc.auto", "0");
  g(repo, "config", "commit.gpgsign", "false");
  g(repo, "remote", "add", "origin", upstream);
  writeFileSync(join(repo, "f.txt"), "one\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "one");
  tip = g(repo, "rev-parse", "HEAD");
  g(repo, "push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  g(repo, "remote", "set-head", "origin", "main");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

after(() => {
  ctx?.dispose();
  removeTempRepo(repo);
  removeTempRepo(upstream);
});

test("the pane's chips are the graph's: origin/HEAD is a pointer, not a chip", async () => {
  assert.equal(g(repo, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/main", "the pointer exists");
  const page = await bridge.graphLoad({ skip: 0, refs: null });
  const row = page.rows.find((r) => r.sha === tip);
  const details = await bridge.commitDetails(tip);
  assert.ok(details && details.kind === "commit");
  const pane = details.refs.map((r) => r.fullName);
  assert.ok(!pane.includes("refs/remotes/origin/HEAD"), `no origin/HEAD chip in the pane: ${JSON.stringify(pane)}`);
  assert.deepEqual(pane, row?.refs.map((r) => r.fullName), "the same chips as the graph's row, in the same order");
  // …and every chip the pane shows resolves in the list its menu uses.
  for (const r of details.refs) {
    assert.ok(chipRefs(page.refList ?? [], r.fullName ?? "").length > 0, `${r.fullName} has a menu that can act`);
  }
});
