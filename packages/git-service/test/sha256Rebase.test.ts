import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRebasePlan } from "../src/rebasePlan";
import { continueRebase, runRebasePlan } from "../src/RebaseRunner";
import { removeTempRepo } from "./tmpRepo";

// A SHA-256 repository names its objects with 64 hex digits, and every reader
// of a todo or `done` line has to take all of them.
//
// The reword installer read the object name off `rebase-merge/done` with
// {4,40}: against 64 digits the \b after the 40th never matched, so it found
// no sha, installed no message — and runRebasePlan still said "done", every
// reword in such a repository silently keeping its original message. The
// plan's own validation carried the same cap and refused such a plan outright.

const SHA256 = (() => {
  const dir = mkdtempSync(join(tmpdir(), "gs-sha256-probe-"));
  try {
    return spawnSync("git", ["init", "-q", "--object-format=sha256", dir]).status === 0;
  } finally {
    removeTempRepo(dir);
  }
})();
const skip = SHA256 ? false : "this git cannot make a SHA-256 repository";

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "gs-sha256-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q", "--object-format=sha256", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  return { root, git };
}

function commit(r: { root: string; git: (...a: string[]) => string }, file: string, body: string, subject: string): string {
  writeFileSync(join(r.root, file), body);
  r.git("add", "-A");
  r.git("commit", "-qm", subject);
  return r.git("rev-parse", "HEAD").trim();
}

test("SHA-256: two rewords land on their own commits", { skip }, async () => {
  const r = repo();
  try {
    commit(r, "m1.txt", "m1\n", "m1");
    r.git("branch", "trunk");
    const a = commit(r, "A.txt", "A\n", "A");
    const b = commit(r, "B.txt", "B\n", "B");
    const c = commit(r, "C.txt", "C\n", "C");
    assert.match(a, /^[0-9a-f]{64}$/, "precondition: a 64-digit object name");

    const built = buildRebasePlan([
      { sha: c, action: "reword", subject: "C", message: "RENAMED-C" },
      { sha: b, action: "pick", subject: "B" },
      { sha: a, action: "reword", subject: "A", message: "RENAMED-A" },
    ]);
    assert.ok(built.ok, built.ok ? "" : built.message);
    const out = await runRebasePlan(r.root, { base: "trunk", todo: built.todo, rewords: built.rewords });
    assert.equal(out.status, "done", out.status === "done" ? "" : out.message);
    assert.deepEqual(
      r.git("log", "--format=%s", "trunk..HEAD").trim().split("\n"),
      ["RENAMED-C", "B", "RENAMED-A"],
      "each message on its own commit — not the originals behind a \"done\"",
    );
  } finally {
    removeTempRepo(r.root);
  }
});

test("SHA-256: a reword continued after a conflict still finds its message in done", { skip }, async () => {
  const r = repo();
  try {
    commit(r, "shared.txt", "base\n", "m1");
    r.git("branch", "trunk");
    r.git("checkout", "-qb", "feature");
    const sha = commit(r, "shared.txt", "feature\n", "OLD-MESSAGE");
    r.git("checkout", "-q", "trunk");
    commit(r, "shared.txt", "trunk\n", "m2");
    r.git("checkout", "-q", "feature");

    const built = buildRebasePlan([{ sha, action: "reword", subject: "OLD-MESSAGE", message: "NEW-MESSAGE" }]);
    assert.ok(built.ok, built.ok ? "" : built.message);
    const out = await runRebasePlan(r.root, { base: "trunk", todo: built.todo, rewords: built.rewords });
    assert.equal(out.status, "stopped", "it conflicts");
    // The line the installer reads, as git wrote it: all 64 digits.
    assert.match(readFileSync(join(r.root, ".git", "rebase-merge", "done"), "utf8"), new RegExp(`^reword ${sha}\\b`, "m"));

    writeFileSync(join(r.root, "shared.txt"), "resolved\n");
    r.git("add", "shared.txt");
    const cont = await continueRebase(r.root);
    assert.equal(cont.status, "done", cont.status === "done" ? "" : cont.message);
    assert.equal(r.git("log", "-1", "--format=%s", "HEAD").trim(), "NEW-MESSAGE");
  } finally {
    removeTempRepo(r.root);
  }
});
