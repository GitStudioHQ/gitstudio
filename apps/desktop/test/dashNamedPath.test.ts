import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge, safePath, safeArg } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * A file whose name starts with "-" is an ordinary file. `-fix.patch`,
 * `--generated/schema.json`, `-README` — none of them are unusual, and the
 * conflict view listed them like any other.
 *
 * Every button it offered then refused them. The path guard was `safeArg`, the
 * one written for REFS, which rejects a leading dash because a ref reaching git
 * as a bare positional would be read as an option. A path never does: every
 * call here passes it after `--`, where git has already stopped reading
 * options. So the app listed a conflict and then answered "That value isn't a
 * valid git reference" to every attempt to resolve it, with no other way out.
 */
test("a path guard accepts what a ref guard must not", () => {
  assert.equal(safeArg("-fix.patch"), false, "a REF may not lead with a dash — git would read it as an option");
  assert.equal(safePath("-fix.patch"), true, "a PATH may: it is passed after `--`");
  assert.equal(safePath("--generated/schema.json"), true);
  assert.equal(safePath(""), false, "empty is still refused");
  assert.equal(safePath("a\0b"), false, "and a NUL, which no filename can contain");
  assert.equal(safePath(undefined), false);
});

function conflicted(name: string): string {
  const root = mkdtempSync(`${tmpdir()}/gs-dash-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  writeFileSync(`${root}/${name}`, "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const main = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  git("checkout", "-qb", "side");
  writeFileSync(`${root}/${name}`, "theirs\n");
  git("commit", "-qam", "theirs");
  git("checkout", "-q", main);
  writeFileSync(`${root}/${name}`, "ours\n");
  git("commit", "-qam", "ours");
  try {
    execFileSync("git", ["merge", "side"], { cwd: root, stdio: "ignore" });
  } catch {
    /* the conflict is the point */
  }
  return root;
}

test("a conflicted file whose name starts with a dash can be resolved", async () => {
  const name = "-fix.patch";
  const root = conflicted(name);
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    assert.deepEqual(await b.conflictList(), [name], "the view lists it");

    const taken = await b.conflictTakeSide({ path: name, side: "theirs" });
    assert.equal(taken.ok, true, "and taking a side works, instead of 'not a valid git reference'");
    assert.equal(readFileSync(`${root}/${name}`, "utf8"), "theirs\n", "with the chosen side on disk");
  } finally {
    removeTempRepo(root);
  }
});

test("a merged result can be written back to a dash-named file", async () => {
  const name = "-fix.patch";
  const root = conflicted(name);
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const r = await b.conflictResolve({ path: name, content: "ours\ntheirs\n" });
    assert.equal(r.ok, true, "the three-pane resolution saves");
    assert.equal(readFileSync(`${root}/${name}`, "utf8"), "ours\ntheirs\n");
    assert.deepEqual(await b.conflictList(), [], "and the conflict is gone");
  } finally {
    removeTempRepo(root);
  }
});

test("a path that escapes the repository is still refused", async () => {
  const root = conflicted("-fix.patch");
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const r = await new GitBridge(repos).conflictResolve({ path: "../escaped.txt", content: "x" });
    assert.equal(r.ok, false, "loosening the guard for dashes must not loosen containment");
    assert.match(r.message ?? "", /escapes the repository/i);
  } finally {
    removeTempRepo(root);
  }
});
