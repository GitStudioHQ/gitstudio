import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// "it would be cool to see who created the branch and who contributed to it."
// Git records no "branch creator" — the nearest honest fact is the author of
// the branch's FIRST unique commit, and "contributed" means authored a commit
// the default branch does not have. These pin both readings against real git,
// because a fixture cannot tell you which end of `git log --reverse` is the
// oldest.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

/** Commit as a specific person. */
function commitAs(name: string, email: string, file: string, msg: string): void {
  writeFileSync(join(repo, file), `${msg}\n`);
  git("add", ".");
  execFileSync("git", ["commit", "-m", msg], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-brpeople-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "anton@example.com");
  git("config", "user.name", "Anton");
  git("config", "gc.auto", "0");
  commitAs("Anton", "anton@example.com", "a.txt", "first");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => removeTempRepo(repo));

test("the creator is the author of the branch's FIRST unique commit", async () => {
  git("checkout", "-q", "-b", "feat/x");
  commitAs("Mira Holt", "mira@example.com", "b.txt", "start the feature");
  commitAs("Anton", "anton@example.com", "c.txt", "continue it");
  commitAs("Sora Ohta", "sora@example.com", "d.txt", "polish it");
  // Back on main: the test repo has no remote, so the bridge's default-branch
  // fallback is the CHECKED-OUT branch — and a branch measured against itself
  // has no unique commits.
  git("checkout", "-q", "main");

  const people = await bridge.branchesPeople();
  const p = people["feat/x"];
  assert.ok(p, "the branch is reported");
  assert.equal(p.creator.name, "Mira Holt", "creator = oldest unique commit's author");
  assert.deepEqual(
    p.contributors.map((c) => c.name).sort(),
    ["Anton", "Mira Holt", "Sora Ohta"],
    "everyone who authored a unique commit",
  );
});

test("commits already on the default branch do not count as contributions", async () => {
  // Anton's "first" is on main; a branch that only carries Mira's work must
  // not list Anton — he contributed to MAIN, not to this branch.
  git("checkout", "-q", "-b", "feat/y");
  commitAs("Mira Holt", "mira@example.com", "b.txt", "solo work");
  git("checkout", "-q", "main");

  const people = await bridge.branchesPeople();
  assert.deepEqual(
    people["feat/y"].contributors.map((c) => c.name),
    ["Mira Holt"],
  );
});

test("the default branch and a merged branch are simply absent", async () => {
  git("checkout", "-q", "-b", "feat/z");
  commitAs("Mira Holt", "mira@example.com", "b.txt", "work");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge z", "feat/z");

  const people = await bridge.branchesPeople();
  assert.equal(people["main"], undefined, "main has no unique commits against itself");
  assert.equal(people["feat/z"], undefined, "a merged branch has none either");
});

test("contributors are ordered by how much they contributed", async () => {
  git("checkout", "-q", "-b", "feat/w");
  commitAs("Mira Holt", "mira@example.com", "b.txt", "one");
  commitAs("Sora Ohta", "sora@example.com", "c.txt", "two");
  commitAs("Sora Ohta", "sora@example.com", "d.txt", "three");
  git("checkout", "-q", "main");

  const people = await bridge.branchesPeople();
  assert.deepEqual(
    people["feat/w"].contributors.map((c) => `${c.name}:${c.count}`),
    ["Sora Ohta:2", "Mira Holt:1"],
  );
});

test("a remote branch is answered even when 40+ local branches crowd the cap", async () => {
  // for-each-ref lists refs/heads before refs/remotes: a shared 40-slot cap
  // let local branches starve every remote of its "created by" — the exact
  // fact that was asked for ON remote branches. The cap is split now.
  const remote = mkdtempSync(join(tmpdir(), "gitstudio-people-remote-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
  git("remote", "add", "origin", remote);
  git("checkout", "-q", "-b", "feat/starver");
  commitAs("Mira Holt", "mira@example.com", "s.txt", "starver work");
  git("push", "-q", "origin", "feat/starver");
  git("checkout", "-q", "main");
  for (let i = 0; i < 45; i++) git("branch", `noise/b${String(i).padStart(2, "0")}`);

  const people = await bridge.branchesPeople();
  assert.ok(
    people["origin/feat/starver"],
    `the remote branch still gets its people (got ${Object.keys(people).filter((k) => k.startsWith("origin/")).length} remote answers)`,
  );
  assert.equal(people["origin/feat/starver"].creator.name, "Mira Holt");
  removeTempRepo(remote);
});
