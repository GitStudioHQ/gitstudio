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

// Deleting a tag locally is undoable, and the interesting case is the
// ANNOTATED one: the tag is its own object with a message and a tagger, and
// restoring the commit it names instead of the tag object would quietly
// downgrade it to a lightweight tag — the same name, pointing at the same
// commit, with the annotation gone. That is a data loss disguised as an undo.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-tagrestore-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "first");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => removeTempRepo(repo));

test("a deleted lightweight tag comes back at the same commit", async () => {
  git("tag", "v1");
  const at = git("rev-parse", "refs/tags/v1").trim();

  const gone = await bridge.tagDelete("v1");
  assert.equal(gone.ok, true);
  assert.equal(gone.was, at, "the delete reports what the tag pointed at");
  assert.equal(git("tag", "--list").trim(), "");

  const back = await bridge.tagRestore({ name: "v1", sha: gone.was! });
  assert.equal(back.ok, true, back.message);
  assert.equal(git("rev-parse", "refs/tags/v1").trim(), at);
});

test("a deleted ANNOTATED tag comes back annotated, not flattened", async () => {
  git("tag", "-a", "v2", "-m", "the second release");
  const tagObject = git("rev-parse", "refs/tags/v2").trim();
  const commit = git("rev-parse", "v2^{commit}").trim();
  assert.notEqual(tagObject, commit, "an annotated tag is its own object");

  const gone = await bridge.tagDelete("v2");
  assert.equal(gone.was, tagObject, "the TAG OBJECT is recorded, not the commit");

  await bridge.tagRestore({ name: "v2", sha: gone.was! });
  assert.equal(git("cat-file", "-t", "refs/tags/v2").trim(), "tag", "still annotated");
  assert.match(git("cat-file", "-p", "refs/tags/v2"), /the second release/, "message intact");
});

test("restoring refuses when a tag of that name is back", async () => {
  git("tag", "v3");
  const gone = await bridge.tagDelete("v3");
  git("tag", "v3"); // somebody re-made it in the meantime
  const back = await bridge.tagRestore({ name: "v3", sha: gone.was! });
  assert.equal(back.ok, false, "an undo must not overwrite what took its place");
  assert.match(back.message ?? "", /there again/i);
});

test("restoring refuses flag-shaped arguments", async () => {
  assert.equal((await bridge.tagRestore({ name: "--all", sha: "HEAD" })).ok, false);
  assert.equal((await bridge.tagRestore({ name: "v1", sha: "--exec=x" })).ok, false);
});
