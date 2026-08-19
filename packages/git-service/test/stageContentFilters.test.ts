import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

// Line/hunk staging writes a blob directly with `git hash-object` instead of
// going through `git add`, because it stages reconstructed content that never
// exists on disk. That skipped the clean filters `git add` runs — attributes
// are selected BY PATH, and we were not passing one.
//
// In any repo with `* text=auto` (the default in most projects, and what
// core.autocrlf does on Windows) `git add` normalises CRLF to LF on the way
// into the index. We stored the CRLF bytes verbatim, so the same file staged
// two different ways produced two different blobs: staging one hunk then showed
// the whole file as modified, and committing wrote CRLF into a history that
// normalises to LF. The same gap skipped `filter=` clean filters entirely,
// which is how git-lfs pointers are produced.
//
// These tests compare our blob against git's own, which is the only definition
// of correct that matters here.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

const stagedBlob = (rel: string): string =>
  git("ls-files", "-s", rel).trim().split(/\s+/)[1] ?? "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-clean-filter-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
  git("add", ".gitattributes");
  git("commit", "-m", "normalise line endings");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

test("the reported bug: our blob is byte-identical to what `git add` writes", async () => {
  const crlf = "one\r\ntwo\r\n";
  writeFileSync(join(repo, "f.txt"), crlf);

  // What git itself decides this content becomes in the index.
  git("add", "f.txt");
  const viaGitAdd = stagedBlob("f.txt");
  git("reset", "-q");

  const r = await ctx.staging.stageContent("f.txt", crlf);
  assert.equal(r.ok, true, r.stderr);

  assert.equal(
    stagedBlob("f.txt"),
    viaGitAdd,
    "staging reconstructed content must land the same blob as `git add`",
  );
});

test("the normalisation really is happening, not both sides being wrong together", () => {
  // Guards the test above: if text=auto stopped normalising, the assertion
  // would pass vacuously with CRLF on both sides and prove nothing.
  writeFileSync(join(repo, "g.txt"), "a\r\nb\r\n");
  git("add", "g.txt");
  const stored = git("cat-file", "-p", stagedBlob("g.txt"));
  assert.equal(stored, "a\nb\n", "git normalises CRLF to LF under * text=auto");
});

test("content that needs no normalisation is stored unchanged", async () => {
  const lf = "alpha\nbeta\n";
  writeFileSync(join(repo, "h.txt"), lf);

  const r = await ctx.staging.stageContent("h.txt", lf);
  assert.equal(r.ok, true, r.stderr);
  assert.equal(git("cat-file", "-p", stagedBlob("h.txt")), lf);
});

test("a path with no attributes of its own still stages correctly", async () => {
  // --path names a file that need not exist yet; it only selects attributes.
  const r = await ctx.staging.stageContent("brand/new/file.txt", "hello\n");
  assert.equal(r.ok, true, r.stderr);
  assert.equal(git("cat-file", "-p", stagedBlob("brand/new/file.txt")), "hello\n");
});

test("a binary path marked -text is NOT normalised", async () => {
  // The inverse guard: attributes can also turn normalisation OFF, and passing
  // --path must respect that rather than normalising everything.
  writeFileSync(join(repo, ".gitattributes"), "* text=auto\n*.bin -text\n");
  git("add", ".gitattributes");
  git("commit", "-m", "binary rule");

  const crlf = "raw\r\nbytes\r\n";
  const r = await ctx.staging.stageContent("data.bin", crlf);
  assert.equal(r.ok, true, r.stderr);
  assert.equal(
    git("cat-file", "-p", stagedBlob("data.bin")),
    crlf,
    "-text means leave my bytes alone",
  );
});
