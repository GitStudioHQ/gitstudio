import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Hermetic git for every process this file spawns, GitContext's included
// (see opInProgress.test.ts for why).
const CFG = join(mkdtempSync(join(tmpdir(), "gs-abort-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

import { GitContext } from "@gitstudio/git-service/GitContext";
import { abortRebaseLike } from "../src/rebase/rebaseAbort";

// The verifier: a rebase door still ran `git rebase --abort` unconditionally,
// so during a `git am` (same rebase-apply/ directory) it offered an Abort git
// refuses. The doors go through the shared operation core now.

function repo(): { root: string; git: (...a: string[]) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gs-abort-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("-c", "init.defaultBranch=master", "init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "f.txt"), "one\ntwo\nthree\n");
  git("add", "f.txt");
  git("commit", "-qm", "base");
  return { root: dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("during git am, the rebase doors' Abort ends the patch series (am --abort), which rebase --abort cannot", async () => {
  const r = repo();
  try {
    r.git("checkout", "-qb", "feature");
    writeFileSync(join(r.root, "f.txt"), "one\ntwo-feature\nthree\n");
    r.git("commit", "-qam", "feature edit");
    const patch = join(r.root, "..", `${basename(r.root)}.patch`);
    writeFileSync(patch, r.git("format-patch", "-1", "--stdout"));
    r.git("checkout", "-q", "master");
    writeFileSync(join(r.root, "f.txt"), "one\ntwo-master\nthree\n");
    r.git("commit", "-qam", "master edit");
    const master = r.git("rev-parse", "HEAD").trim();
    assert.notEqual(spawnSync("git", ["am", "-3", patch], { cwd: r.root }).status, 0, "git am stops on the conflict");
    assert.ok(existsSync(join(r.root, ".git", "rebase-apply")), "precondition: a patch series is stopped");
    // What the doors used to run:
    assert.notEqual(spawnSync("git", ["rebase", "--abort"], { cwd: r.root }).status, 0, "git refuses rebase --abort during am");

    const ctx = new GitContext({ root: r.root });
    try {
      const out = await abortRebaseLike(ctx.operation);
      assert.equal(out.ran, true);
      assert.equal(out.kind, "am");
      assert.equal(out.ran && out.outcome.ok, true, out.ran ? out.outcome.message : "");
      assert.equal(existsSync(join(r.root, ".git", "rebase-apply")), false, "the series is over");
      assert.equal(r.git("rev-parse", "HEAD").trim(), master);
    } finally {
      ctx.dispose();
      rmSync(patch, { force: true });
    }
  } finally {
    r.done();
  }
});

test("with a merge stopped (or nothing at all) the rebase doors abort nothing — never a reset --merge", async () => {
  const r = repo();
  try {
    r.git("checkout", "-qb", "feature");
    writeFileSync(join(r.root, "f.txt"), "one\ntwo-feature\nthree\n");
    r.git("commit", "-qam", "feature edit");
    r.git("checkout", "-q", "master");
    writeFileSync(join(r.root, "f.txt"), "one\ntwo-master\nthree\n");
    r.git("commit", "-qam", "master edit");
    assert.notEqual(spawnSync("git", ["merge", "feature"], { cwd: r.root }).status, 0);
    const ctx = new GitContext({ root: r.root });
    try {
      const out = await abortRebaseLike(ctx.operation);
      assert.deepEqual(out, { ran: false, kind: "merge" });
      assert.ok(existsSync(join(r.root, ".git", "MERGE_HEAD")), "the merge is untouched");
      r.git("merge", "--abort");
      assert.deepEqual(await abortRebaseLike(ctx.operation), { ran: false, kind: "none" });
    } finally {
      ctx.dispose();
    }
  } finally {
    r.done();
  }
});

test("no door in the extension runs git rebase --abort itself", () => {
  // The census that keeps a third door from appearing: every Abort goes
  // through abortRebaseLike (the operation core), never straight to git.
  const SRC = join(__dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const code = readFileSync(p, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/\[\s*["']rebase["']\s*,\s*["']--abort["']/.test(code)) offenders.push(`${p}: runs rebase --abort`);
        if (/\babortRebaseAt\s*\(/.test(code) && !p.endsWith("rebaseRunner.ts")) offenders.push(`${p}: calls abortRebaseAt`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});
