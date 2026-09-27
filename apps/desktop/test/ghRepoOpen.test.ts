import "./hermeticGit";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openGitHubRepo, type GhOpenResult } from "../src/main/ghRepoOpen";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The find-existing-clone half of "open owner/repo as a normal repo": an
// already-cloned repo (recents or the managed folder) must open INSTANTLY and
// never re-clone; a folder-name collision with a DIFFERENT project must
// refuse with a clear message instead of opening the wrong repo.
//
// No clone here ever leaves this disk. "GitHub" is a folder of bare
// repositories (`hub`) handed to openGitHubRepo as its clone base, so a clone
// is a file:// clone. This file once cloned https://github.com/acme/elsewhere
// for real — waiting on the network and on the macOS keychain's credential
// helper, whose dialog lands on whoever's screen runs the suite.

let managed: string;
let repoA: string;
/** The stand-in for github.com: <hub>/<owner>/<repo>.git, bare. */
let hub: string;
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

/** A repository on the stand-in GitHub, with one commit on main. */
function publish(fullName: string): void {
  const work = mkdtempSync(join(tmpdir(), "gitstudio-hubwork-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "pipe" });
    git("-c", "init.defaultBranch=main", "init", "-q");
    git("config", "gc.auto", "0");
    writeFileSync(join(work, "README.md"), `# ${fullName}\n`);
    git("add", "README.md");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    execFileSync("git", ["clone", "-q", "--bare", work, join(hub, `${fullName}.git`)], { stdio: "pipe" });
  } finally {
    removeTempRepo(work);
  }
}

/** openGitHubRepo, cloning from the stand-in GitHub. */
function open(fullName: string, dest?: string, nameOverride?: string): Promise<GhOpenResult> {
  return openGitHubRepo(fullName, store, () => {}, managed, dest, nameOverride, pathToFileURL(hub).href);
}

beforeEach(() => {
  opened.length = 0;
  managed = mkdtempSync(join(tmpdir(), "gitstudio-managed-"));
  repoA = mkdtempSync(join(tmpdir(), "gitstudio-clonea-"));
  hub = mkdtempSync(join(tmpdir(), "gitstudio-hub-"));
  makeRepo(repoA, "git@github.com:GitStudioHQ/gitstudio.git");
});

afterEach(() => {
  removeTempRepo(managed);
  removeTempRepo(repoA);
  removeTempRepo(hub);
});

test("a matching recent clone opens instantly, no clone", async () => {
  const r = await open("GitStudioHQ/gitstudio");
  assert.equal(r.ok, true);
  assert.equal(r.cloned, false);
  assert.equal(r.root, repoA);
  assert.deepEqual(opened, [repoA]);
});

test("matching is case-insensitive on owner/repo", async () => {
  const r = await open("gitstudiohq/GITSTUDIO");
  assert.equal(r.ok, true);
  assert.equal(r.root, repoA);
});

test("a managed-folder clone is found when recents don't have it", async () => {
  const inManaged = join(managed, "other");
  makeRepo(inManaged, "https://github.com/acme/other.git");
  const r = await open("acme/other");
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
  const r = await open("acme/elsewhere");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /already exists/);
  assert.deepEqual(opened, []);
});

// ── E1: destination control + structured codes ───────────────────────────────

test("a collision reports code 'collision'", async () => {
  mkdirSync(join(managed, "elsewhere"));
  mkdirSync(join(managed, "acme-elsewhere"));
  const r = await open("acme/elsewhere");
  assert.equal(r.ok, false);
  assert.equal(r.code, "collision");
});

test("a garbage name reports code 'bad-name'", async () => {
  const r = await open("nonsense");
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad-name");
});

test("an explicit dest overrides the managed folder for discovery-miss clones", async () => {
  // The clone itself fails — acme/elsewhere is not on the stand-in GitHub —
  // and what matters is that the attempt happened in `dest`, proven by the
  // code being clone-failed (the dest dir was created + no collision) rather
  // than collision.
  const dest = mkdtempSync(join(tmpdir(), "gitstudio-dest-"));
  try {
    // Occupy BOTH default candidate names in the managed dir: with dest
    // honored, neither matters.
    mkdirSync(join(managed, "elsewhere"));
    mkdirSync(join(managed, "acme-elsewhere"));
    const r = await open("acme/elsewhere", dest);
    assert.equal(r.ok, false);
    assert.equal(r.code, "clone-failed");
  } finally {
    removeTempRepo(dest);
  }
});

test("an explicit name override collides only on ITSELF (no owner-repo fallback)", async () => {
  mkdirSync(join(managed, "mydir"));
  const r = await open("acme/elsewhere", undefined, "mydir");
  assert.equal(r.ok, false);
  assert.equal(r.code, "collision");
  assert.match(r.message ?? "", /mydir/);
});

// ── The other half: no clone anywhere ──────────────────────────────────────

test("with no clone anywhere, owner/repo is cloned into the managed folder and opened", async () => {
  publish("acme/fresh");
  const r = await open("acme/fresh");
  assert.equal(r.ok, true, r.message);
  assert.equal(r.cloned, true);
  assert.equal(r.root, join(managed, "fresh"));
  assert.deepEqual(opened, [join(managed, "fresh")]);
  assert.ok(existsSync(join(managed, "fresh", "README.md")), "the clone checked out the repository's files");
  const origin = execFileSync("git", ["-C", join(managed, "fresh"), "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  assert.equal(origin, `${pathToFileURL(hub).href}/acme/fresh.git`, "cloned from the base it was given, and nowhere else");
});
