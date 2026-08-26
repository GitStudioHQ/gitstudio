import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGitHubRepo } from "../src/main/ghRepoOpen";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The find-existing-clone half of "open owner/repo as a normal repo": an
// already-cloned repo (recents or the managed folder) must open INSTANTLY and
// never re-clone; a folder-name collision with a DIFFERENT project must
// refuse with a clear message instead of opening the wrong repo.

let managed: string;
let repoA: string;
const opened: string[] = [];

/** A RepoStore stand-in: records opens, reports repoA as a recent. */
const store = {
  recentRepos: () => [{ root: repoA, name: "gitstudio" }],
  open: async (root: string) => {
    opened.push(root);
    return { root, name: root.split("/").pop()! };
  },
} as unknown as RepoStore;

function makeRepo(dir: string, origin?: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (origin) {
    execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  }
}

beforeEach(() => {
  opened.length = 0;
  managed = mkdtempSync(join(tmpdir(), "gitstudio-managed-"));
  repoA = mkdtempSync(join(tmpdir(), "gitstudio-clonea-"));
  makeRepo(repoA, "git@github.com:GitStudioHQ/gitstudio.git");
});

afterEach(() => {
  removeTempRepo(managed);
  removeTempRepo(repoA);
});

test("a matching recent clone opens instantly, no clone", async () => {
  const r = await openGitHubRepo("GitStudioHQ/gitstudio", store, () => {}, managed);
  assert.equal(r.ok, true);
  assert.equal(r.cloned, false);
  assert.equal(r.root, repoA);
  assert.deepEqual(opened, [repoA]);
});

test("matching is case-insensitive on owner/repo", async () => {
  const r = await openGitHubRepo("gitstudiohq/GITSTUDIO", store, () => {}, managed);
  assert.equal(r.ok, true);
  assert.equal(r.root, repoA);
});

test("a managed-folder clone is found when recents don't have it", async () => {
  const inManaged = join(managed, "other");
  makeRepo(inManaged, "https://github.com/acme/other.git");
  const r = await openGitHubRepo("acme/other", store, () => {}, managed);
  assert.equal(r.ok, true);
  assert.equal(r.cloned, false);
  assert.equal(r.root, inManaged);
});

test("a recent repo with a DIFFERENT remote is skipped, never opened as an impostor", async () => {
  // Both candidate folder names are taken by unrelated projects → the flow
  // must refuse (message names the collision) rather than clone over them or
  // open the wrong repo. This also proves the wrong-remote recents skip.
  mkdirSync(join(managed, "elsewhere"));
  mkdirSync(join(managed, "acme-elsewhere"));
  const r = await openGitHubRepo("acme/elsewhere", store, () => {}, managed);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /already exists/);
  assert.deepEqual(opened, []);
});

// ── E1: destination control + structured codes ───────────────────────────────

test("a collision reports code 'collision'", async () => {
  mkdirSync(join(managed, "elsewhere"));
  mkdirSync(join(managed, "acme-elsewhere"));
  const r = await openGitHubRepo("acme/elsewhere", store, () => {}, managed);
  assert.equal(r.ok, false);
  assert.equal(r.code, "collision");
});

test("a garbage name reports code 'bad-name'", async () => {
  const r = await openGitHubRepo("nonsense", store, () => {}, managed);
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad-name");
});

test("an explicit dest overrides the managed folder for discovery-miss clones", async () => {
  // The clone itself will fail (no network in tests) — what matters is that
  // the attempt happened in `dest`, proven by the code being clone-failed
  // (the dest dir was created + no collision) rather than collision.
  const dest = mkdtempSync(join(tmpdir(), "gitstudio-dest-"));
  try {
    // Occupy BOTH default candidate names in the managed dir: with dest
    // honored, neither matters.
    mkdirSync(join(managed, "elsewhere"));
    mkdirSync(join(managed, "acme-elsewhere"));
    const r = await openGitHubRepo(
      "acme/elsewhere",
      store,
      () => {},
      managed,
      dest,
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "clone-failed");
  } finally {
    removeTempRepo(dest);
  }
});

test("an explicit name override collides only on ITSELF (no owner-repo fallback)", async () => {
  mkdirSync(join(managed, "mydir"));
  const r = await openGitHubRepo(
    "acme/elsewhere",
    store,
    () => {},
    managed,
    undefined,
    "mydir",
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "collision");
  assert.match(r.message ?? "", /mydir/);
});
