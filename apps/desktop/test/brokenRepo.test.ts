import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { isExpectedError } from "../src/main/expectedError";

/**
 * A repository git refuses to read.
 *
 * `mustSucceed` exists so a failing `git status` can no longer be laundered
 * into "working tree clean" — the most dangerous sentence this app can print.
 * But it threw a plain `Error`, and every IPC handler files a plain throw as a
 * crash report. A corrupt index, a held `index.lock`, wrong permissions or the
 * folder moving are all conditions the USER is in, not defects in the app —
 * and the status read runs on a filesystem watcher, so one stuck lock would
 * have filed a report per tick.
 *
 * It must still THROW (the renderer's error state depends on it) and still
 * carry git's own words. It just must not read as a crash.
 */
test("a repo git cannot read fails loudly, but as an expected condition", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-broken-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0"); // no background gc racing the cleanup
    git("config", "core.autocrlf", "false"); // and no line-ending rewriting
    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", ".");
    git("commit", "-qm", "one");

    // Corrupt the index — exactly the reported failure.
    writeFileSync(`${root}/.git/index`, "this is not an index\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);

    let thrown: unknown;
    try {
      await bridge.status();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "it throws rather than reporting an empty, clean tree");
    assert.ok(
      isExpectedError(thrown),
      "and it is an EXPECTED condition, so it is never filed as a crash",
    );
    assert.match(
      String((thrown as Error).message),
      /working tree/i,
      "while still saying what failed",
    );
  } finally {
    removeTempRepo(root);
  }
});

/** The healthy path must be untouched by all of this. */
test("a healthy repo still reads its working tree", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-healthy-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0"); // no background gc racing the cleanup
    git("config", "core.autocrlf", "false"); // and no line-ending rewriting
    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(`${root}/a.txt`, "a2\n");
    writeFileSync(`${root}/b.txt`, "b\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const files = await new GitBridge(repos).status();
    assert.deepEqual(
      files.map((f) => [f.status, f.path]).sort(),
      [
        ["?", "b.txt"],
        ["M", "a.txt"],
      ].sort(),
    );
  } finally {
    removeTempRepo(root);
  }
});
