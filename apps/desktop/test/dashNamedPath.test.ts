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

/**
 * `conflictTakeSide` probes the index to learn which sides of a conflict exist,
 * because that decides whether "Take theirs" WRITES a file or DELETES one. It
 * asked with a pathspec, and a pathspec is glob-capable — a filename like
 * `[id].tsx`, ordinary in every Next.js and SvelteKit app, is a character class
 * if it is ever read as one.
 *
 * Measured on git 2.49 it matches literally in all three pathspec modes, so
 * this is coverage of a real surface rather than a reproduction of a live bug.
 * The probe now compares paths itself and does not depend on git's
 * literal-vs-glob precedence, which is steerable from the environment.
 */
test("a modify/delete conflict on a filename that could be read as a glob", async () => {
  const name = "[id].tsx";
  const root = mkdtempSync(`${tmpdir()}/gs-glob-`);
  try {
    const git = (...a: string[]): string =>
      execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    writeFileSync(`${root}/${name}`, "base\n");
    writeFileSync(`${root}/i`, "an innocent bystander\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const main = git("rev-parse", "--abbrev-ref", "HEAD").trim();

    // theirs DELETES it; ours edits it — a modify/delete, where the probe's
    // answer decides whether Take theirs removes the file or errors out.
    git("checkout", "-qb", "side");
    git("rm", "-q", "--", name);
    git("commit", "-qm", "theirs deletes it");
    git("checkout", "-q", main);
    writeFileSync(`${root}/${name}`, "ours\n");
    git("commit", "-qam", "ours edits it");
    try {
      execFileSync("git", ["merge", "side"], { cwd: root, stdio: "ignore" });
    } catch {
      /* the conflict is the point */
    }

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    assert.deepEqual(await b.conflictList(), [name], "the view lists it");

    const r = await b.conflictTakeSide({ path: name, side: "theirs" });
    assert.equal(r.ok, true, `Take theirs works — ${r.message ?? ""}`);
    assert.deepEqual(await b.conflictList(), [], "the conflict is resolved");
    assert.equal(readFileSync(`${root}/i`, "utf8"), "an innocent bystander\n", "and the sibling is untouched");
  } finally {
    removeTempRepo(root);
  }
});
