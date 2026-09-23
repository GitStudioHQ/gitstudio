import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { syncBranchLabel } from "../src/statusBar/syncLabel";

// The GitStudio status item (issue #30's follow-up) read `git symbolic-ref
// --short HEAD`, and with a tag of the same name that is "heads/release" —
// so the status bar said "$(git-branch) heads/release". It names the branch
// by the part under refs/heads/ now. Real git: the claim is what git answers.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-sl-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-ext-sl-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "one");
  git("tag", "release");
  git("checkout", "-q", "-b", "release");
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* scratch */
  }
});

test("git itself calls the checked-out branch heads/release here", () => {
  assert.equal(git("symbolic-ref", "--short", "HEAD"), "heads/release");
});

test("the status item names it release — and the head still carries git's revision and its full name", async () => {
  const head = await ctx.refs.getHead();
  assert.equal(syncBranchLabel(head), "release");
  assert.equal(head.fullName, "refs/heads/release");
  assert.equal(head.branch, "heads/release", "the short form stays a revision git resolves (the compare panel's)");
});

test("an ordinary branch and a detached HEAD read as before", async () => {
  git("checkout", "-q", "main");
  assert.equal(syncBranchLabel(await ctx.refs.getHead()), "main");
  git("checkout", "-q", "--detach", "HEAD");
  const sha = git("rev-parse", "HEAD");
  assert.equal(syncBranchLabel(await ctx.refs.getHead()), `${sha.slice(0, 7)} (detached)`);
  git("checkout", "-q", "release");
});

test("the status item's text, its publish and its upstream repair all use the plain name", () => {
  // syncStatus imports vscode; its wiring is pinned at source level, and
  // what it calls is exercised for real above.
  const src = readFileSync(fileURLToPath(new URL("../src/statusBar/syncStatus.ts", import.meta.url)), "utf8");
  assert.match(src, /const branch = syncBranchLabel\(head\);/, "the item's text");
  assert.doesNotMatch(src, /head\.branch/, "nothing in the status item reads git's short form any more");
  assert.match(src, /return headBranchName\(head\);/, "publish pushes refs/heads/<plain>");
});
