import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { removeTempRepo } from "./tmpRepo";

// "i cant see who created the tags and remote branches" — the WHO now rides
// the same for-each-ref that lists every ref. The three cases have three
// different sources and getting them crossed is silent:
//
//   remote branch    → the tip commit's author
//   annotated tag    → the TAGGER (they cut the tag; the commit's author may
//                      be somebody else entirely)
//   lightweight tag  → the commit's author, via the ref DIRECTLY (no peel)
//
// The harness cannot test this — its shim answers refs:list from a fixture,
// bypassing the provider — so real git pins it here.

let repo: string;
let ctx: GitContext;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

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
  repo = mkdtempSync(join(tmpdir(), "gitstudio-refwho-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "tagger@example.com");
  git("config", "user.name", "The Tagger");
  git("config", "gc.auto", "0");
  commitAs("Mira Holt", "mira@example.com", "a.txt", "first");
  ctx = new GitContext({ root: repo });
});

afterEach(() => removeTempRepo(repo));

test("a branch carries its tip commit's author, email unwrapped", async () => {
  const refs = await ctx.refs.listRefs();
  const main = refs.find((r) => r.type === "head" && r.name === "main");
  assert.deepEqual(main?.who, { name: "Mira Holt", email: "mira@example.com" });
});

test("an annotated tag carries its TAGGER, not the commit's author", async () => {
  git("tag", "-a", "v1", "-m", "the first release");
  const refs = await ctx.refs.listRefs();
  const tag = refs.find((r) => r.type === "tag" && r.name === "v1");
  assert.equal(tag?.objectType, "tag");
  assert.equal(tag?.who?.name, "The Tagger", "the person who CUT the tag");
  assert.equal(tag?.who?.email, "tagger@example.com");
  assert.equal(tag?.who?.tagger, true, "and the row can say 'Tagged by' rather than guessing");
});

test("a lightweight tag falls back to the commit's author, with no tagger flag", async () => {
  git("tag", "bare");
  const refs = await ctx.refs.listRefs();
  const tag = refs.find((r) => r.type === "tag" && r.name === "bare");
  assert.equal(tag?.objectType, "commit", "a bare pointer, no tag object");
  assert.equal(tag?.who?.name, "Mira Holt");
  assert.equal(tag?.who?.tagger, undefined);
});

test("a remote-tracking branch carries its tip author too", async () => {
  // A local bare remote is enough — the ref namespace is what's under test.
  const remote = mkdtempSync(join(tmpdir(), "gitstudio-refwho-remote-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  const refs = await ctx.refs.listRefs();
  const rb = refs.find((r) => r.type === "remote" && r.name === "origin/main");
  assert.deepEqual(rb?.who, { name: "Mira Holt", email: "mira@example.com" });
  removeTempRepo(remote);
});
