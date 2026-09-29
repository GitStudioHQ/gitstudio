import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import type { GitProcess, GitRunResult } from "../src/GitProcess";
import { HistoryProvider, parseFileHistory } from "../src/HistoryProvider";
import { removeTempRepo } from "./tmpRepo";

// File and line history where git refuses, where a git build rejects `-L`
// without a patch (the patch-bearing retry), and output that isn't all
// commit headers.

let repo: string;
let ctx: GitContext;
let c1: string;
let c2: string;
let c3: string;

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: ENV }).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-historyprov-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "core.autocrlf", "false");
  const commit = (body: string, msg: string) => {
    writeFileSync(join(repo, "f.txt"), body);
    git("add", "f.txt");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  c1 = commit("one\ntwo\nthree\n", "create");
  c2 = commit("one\nTWO\nthree\n", "edit two");
  c3 = commit("one\nTWO, again\nthree\n", "edit two again");
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  removeTempRepo(repo);
});

/** A HistoryProvider whose git answers `hook(args)` when it returns a result, and records every call. */
function provider(hook: (args: string[], n: number) => GitRunResult | undefined): { h: HistoryProvider; calls: string[][] } {
  const calls: string[][] = [];
  const proc = {
    cwd: repo,
    run: async (args: string[], opts?: Parameters<GitProcess["run"]>[1]) => {
      calls.push(args);
      return hook(args, calls.length) ?? ctx.process.run(args, opts);
    },
  } as unknown as GitProcess;
  return { h: new HistoryProvider(proc), calls };
}

test("fileHistory of an unknown revision throws with git's reason and the path", async () => {
  await assert.rejects(ctx.history.fileHistory("f.txt", { rev: "no-such-rev" }), /^Error: git log --follow failed for f\.txt \(exit 128\): fatal: .*no-such-rev/);
});

test("fileHistory without rename-following still lists the file's commits, from the revision asked for", async () => {
  const entries = await ctx.history.fileHistory("f.txt", { follow: false, rev: c2, signal: new AbortController().signal });
  assert.deepEqual(entries.map((e) => e.sha), [c2, c1]);
  assert.deepEqual(entries.map((e) => e.path), ["f.txt", "f.txt"]);
});

test("lineHistory stops at maxCount, newest first", async () => {
  const entries = await ctx.history.lineHistory("f.txt", 2, 2, { maxCount: 1, signal: new AbortController().signal });
  assert.deepEqual(entries.map((e) => [e.sha, e.subject]), [[c3, "edit two again"]]);
});

test("lineHistory of a range past the end of the file throws with git's reason", async () => {
  await assert.rejects(ctx.history.lineHistory("f.txt", 50, 60), /^Error: git log -L failed for f\.txt \(exit 128\): fatal: /);
});

test("a git that rejects -L without a patch is asked again with the patch, and only the commit headers are kept", async () => {
  const { h, calls } = provider((args) =>
    args.includes("--no-patch") ? { code: 129, stdout: "", stderr: "usage: git log [<options>]\n  --no-patch cannot be used with -L" } : undefined,
  );
  const entries = await h.lineHistory("f.txt", 2, 2);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].includes("--no-patch"), "the retry carries the patch");
  assert.deepEqual(entries.map((e) => e.sha), [c3, c2, c1], "diff hunks between records are not taken for commits");
  assert.equal(entries[1].subject, "edit two");
  assert.equal(entries[1].authorEmail, "dev@example.com");
});

test("a refusal that isn't about the patch is not retried — it is reported", async () => {
  const { h, calls } = provider(() => ({ code: 128, stdout: "", stderr: "fatal: file f.txt has only 3 lines" }));
  await assert.rejects(h.lineHistory("f.txt", 9, 9), { message: "git log -L failed for f.txt (exit 128): fatal: file f.txt has only 3 lines" });
  assert.equal(calls.length, 1);
});

test("the patch-bearing retry failing too is reported with the retry's reason", async () => {
  const { h, calls } = provider((_, n) =>
    n === 1 ? { code: 129, stdout: "", stderr: "error: --no-patch not allowed" } : { code: 128, stdout: "", stderr: "fatal: bad range" },
  );
  await assert.rejects(h.lineHistory("f.txt", 1, 1), { message: "git log -L failed for f.txt (exit 128): fatal: bad range" });
  assert.equal(calls.length, 2);
});

test("records that aren't commit headers — no sha, or cut short — are skipped", async () => {
  const sha = "a".repeat(40);
  const good = [sha, "Ann", "ann@example.com", "1700000000", "subject", "body"].join("\x1f");
  const stdout = [
    "stray diff text, no commit here",
    `\n@@ -1 +1 @@\n${"b".repeat(40)}\x1fonly two fields`,
    `\n${good}`,
    "trailing text after the last separator",
  ].join("\x1e");
  const { h } = provider(() => ({ code: 0, stdout, stderr: "" }));
  const entries = await h.lineHistory("f.txt", 1, 1);
  assert.deepEqual(entries, [
    { sha, shortSha: "aaaaaaa", author: "Ann", authorEmail: "ann@example.com", authorDate: 1700000000, subject: "subject" },
  ]);
});

test("fileAtRevision takes a signal and still answers", async () => {
  assert.equal(await ctx.history.fileAtRevision(c1, "f.txt", { signal: new AbortController().signal }), "one\ntwo\nthree\n");
});

test("parseFileHistory: a commit with no name-status (a merge) takes the path its newer neighbour came from", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const rec = (sha: string, status: string) => `\x1e${[sha, "A", "a@e", "1", "s", "", status].join("\x1f")}`;
  const out = parseFileHistory(rec(a, "\n\nR100\0old.txt\0new.txt\0") + rec(b, "") + "\x1enot a record", "new.txt");
  assert.deepEqual(out.map((e) => [e.path, e.oldPath]), [
    ["new.txt", "old.txt"],
    ["old.txt", undefined],
  ]);
});
