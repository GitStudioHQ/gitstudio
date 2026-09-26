import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// Apply and Pop bring a stash's STAGED changes back staged, as the extension's
// do (the door is shared: git-service changesInTheWay.ts, ApplyOp `index`).
//
// A plain `git stash apply` unstages them, and where a file's staged version
// differed from its working copy (`MM`), a pop then dropped the only copy of
// the staged one. Where git cannot restore the staging — the user has staged
// changes of their own, or the staged half no longer applies at HEAD —
// nothing of it has run, and the desktop applies it as it always did,
// everything unstaged: never worse than before.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const write = (f: string, s: string): void => writeFileSync(join(repo, f), s);
const status = (): string => git("status", "--porcelain").replace(/\n$/, "");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stashstaging-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  write("util.ts", "export const a = 1;\n");
  write("other.ts", "other\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  // util.ts staged as a = 2, working copy a = 3.
  write("util.ts", "export const a = 2;\n");
  git("add", "util.ts");
  write("util.ts", "export const a = 3;\n");
  git("stash", "push", "-q", "-m", "staged and not");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  ctx.dispose();
  removeTempRepo(repo);
});

for (const pop of [false, true]) {
  const verb = pop ? "pop" : "apply";
  const run = (): ReturnType<GitBridge["stashApply"]> => (pop ? bridge.stashPop("stash@{0}") : bridge.stashApply("stash@{0}"));

  test(`${verb}: the staged version comes back staged`, async () => {
    const r = await run();
    assert.notEqual(r.ok, false, r.message);
    assert.equal(status(), "MM util.ts");
    assert.equal(git("show", ":util.ts"), "export const a = 2;\n");
    assert.equal(readFileSync(join(repo, "util.ts"), "utf8"), "export const a = 3;\n");
    assert.equal(git("stash", "list").trim() === "", pop);
  });

  test(`${verb}: over the user's own staged change, as before — unstaged, their staging kept`, async () => {
    write("other.ts", "mine, staged\n");
    git("add", "other.ts");
    const r = await run();
    assert.notEqual(r.ok, false, r.message);
    assert.equal(status(), "M  other.ts\n M util.ts");
    assert.equal(git("show", ":other.ts"), "mine, staged\n", "never unstaged by an --index run");
  });

  test(`${verb}: a staged half that no longer applies at HEAD is applied as before, unstaged`, async () => {
    write("util.ts", "export const a = 7;\n");
    git("commit", "-q", "-am", "HEAD moves under the staged file");
    const r = await run();
    // What a plain apply does here: a conflict to resolve (both changed util.ts).
    assert.match(status(), /^UU util\.ts$/m, `${JSON.stringify(r)}\n${status()}`);
  });
}
