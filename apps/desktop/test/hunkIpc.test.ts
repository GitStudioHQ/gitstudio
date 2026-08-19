import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The desktop half of per-hunk ticks (#20), driven through the same bridge
// methods the IPC channels call.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const BASE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-hunkipc-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(repo, "f.txt"), BASE);
  git("add", ".");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

function twoEdits(): void {
  const lines = BASE.split("\n");
  lines[0] = "FIRST EDIT";
  lines[8] = "SECOND EDIT";
  writeFileSync(join(repo, "f.txt"), lines.join("\n"));
}

test("hunks:list reads the file from disk and reports the unstaged changes", async () => {
  twoEdits();
  const hunks = await bridge.hunksList("f.txt");
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].preview, "FIRST EDIT");
});

test("hunks:stage stages one change and leaves the rest unstaged", async () => {
  twoEdits();
  const hunks = await bridge.hunksList("f.txt");

  const r = await bridge.hunksStage({ path: "f.txt", index: hunks[0].index });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);

  const staged = git("show", ":f.txt");
  assert.match(staged, /FIRST EDIT/);
  assert.doesNotMatch(staged, /SECOND EDIT/, "the untouched change stays unstaged");

  // And it drops out of what is still tickable.
  const after = await bridge.hunksList("f.txt");
  assert.equal(after.length, 1);
  assert.equal(after[0].preview, "SECOND EDIT");
});

test("a stale index is refused as expected, not filed as a failure", async () => {
  twoEdits();
  const hunks = await bridge.hunksList("f.txt");
  git("add", "f.txt"); // everything staged by other means

  const r = await bridge.hunksStage({ path: "f.txt", index: hunks[1].index });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "a stale tick is a state, not a crash to report");
});

test("a path escaping the repo is refused", async () => {
  const r = await bridge.hunksStage({ path: "../../etc/passwd", index: 0 });
  assert.equal(r.ok, false);
  assert.deepEqual(await bridge.hunksList("../../etc/passwd"), []);
});

test("an unreadable or binary file offers nothing rather than throwing", async () => {
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const hunks = await bridge.hunksList("bin.dat");
  assert.ok(Array.isArray(hunks));
});
