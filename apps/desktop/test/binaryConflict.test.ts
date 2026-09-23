import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * Resolving a conflicted BINARY file.
 *
 * "Take ours" / "Take theirs" is the only resolution the app offers for a
 * binary conflict — there is no meaningful three-pane merge for a PNG. It read
 * the chosen side with `git show :N:path`, took the STDOUT AS A STRING, and
 * wrote it back as UTF-8. `GitProcess.run` decodes stdout with
 * `Buffer.concat(...).toString("utf8")`, which is lossy for every byte that is
 * not valid UTF-8: each becomes U+FFFD, three bytes. So the one available
 * resolution destroyed the asset, staged the wreckage, and reported success.
 *
 * Measured on a real 512×512 PNG before the fix: 36,078 bytes in, 67,288 out,
 * header `efbfbd504e470d0a` instead of `89504e470d0a1a0a`, and `file(1)` went
 * from "PNG image data" to "data".
 *
 * git can write the bytes itself. It never decodes them.
 */
const md5 = (b: Buffer): string => createHash("md5").update(b).digest("hex");

/** A byte string that is NOT valid UTF-8 — a real PNG header plus high bytes. */
function binary(seed: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(512);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + seed) & 0xff;
  return Buffer.concat([head, body]);
}

function conflictedBinaryRepo(): { root: string; ours: Buffer; theirs: Buffer } {
  const root = mkdtempSync(`${tmpdir()}/gs-binconf-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");

  writeFileSync(`${root}/logo.png`, binary(1));
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-qb", "incoming");
  const theirs = binary(200);
  writeFileSync(`${root}/logo.png`, theirs);
  git("commit", "-qam", "theirs");

  git("checkout", "-q", "-");
  const ours = binary(90);
  writeFileSync(`${root}/logo.png`, ours);
  git("commit", "-qam", "ours");

  try {
    git("merge", "incoming");
  } catch {
    /* expected: this conflicts */
  }
  return { root, ours, theirs };
}

test("taking THEIRS on a binary conflict writes their exact bytes", async () => {
  const { root, theirs } = conflictedBinaryRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);

    const r = await bridge.conflictTakeSide({ path: "logo.png", side: "theirs" });
    assert.equal(r.ok, true, `the resolution succeeds (${r.message ?? ""})`);

    const onDisk = readFileSync(`${root}/logo.png`);
    assert.equal(md5(onDisk), md5(theirs), "byte-for-byte the incoming version");
    assert.equal(onDisk.length, theirs.length, "and the same size — no UTF-8 expansion");
    assert.deepEqual(
      [...onDisk.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "the PNG header survives intact",
    );

    // And what was STAGED, which is what a commit would ship.
    const staged = execFileSync("git", ["show", ":logo.png"], {
      cwd: root,
      maxBuffer: 1 << 20,
      encoding: "buffer",
    }) as unknown as Buffer;
    assert.equal(md5(staged), md5(theirs), "the staged blob is their file, not a mangled copy");
  } finally {
    removeTempRepo(root);
  }
});

test("taking OURS on a binary conflict writes our exact bytes", async () => {
  const { root, ours } = conflictedBinaryRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const r = await bridge.conflictTakeSide({ path: "logo.png", side: "ours" });
    assert.equal(r.ok, true, `the resolution succeeds (${r.message ?? ""})`);
    assert.equal(md5(readFileSync(`${root}/logo.png`)), md5(ours), "byte-for-byte our version");
  } finally {
    removeTempRepo(root);
  }
});

/** Text conflicts — the common case — must be completely unaffected. */
test("a text conflict still resolves to the chosen side", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-textconf-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "incoming");
    writeFileSync(`${root}/f.txt`, "theirs\n");
    git("commit", "-qam", "theirs");
    git("checkout", "-q", "-");
    writeFileSync(`${root}/f.txt`, "ours\n");
    git("commit", "-qam", "ours");
    try {
      git("merge", "incoming");
    } catch {
      /* expected */
    }

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const r = await bridge.conflictTakeSide({ path: "f.txt", side: "theirs" });
    assert.equal(r.ok, true, r.message ?? "");
    assert.equal(readFileSync(`${root}/f.txt`, "utf8"), "theirs\n");
    assert.match(
      execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString(),
      /^M {2}f\.txt/m,
      "and it is staged as resolved",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * Merge parity: `conflict:takeRole` goes through the same byte-moving path, and
 * during a REBASE "Yours" is git's stage 3 — the commit being replayed — so
 * Accept Yours on a binary must write YOUR bytes, not the upstream's.
 */
test("Accept Yours on a binary during a rebase writes your commit's exact bytes", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-binrebase-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(`${root}/logo.png`, binary(1));
    git("add", "-A");
    git("commit", "-qm", "base");
    const main = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    git("checkout", "-qb", "feature");
    const mine = binary(77);
    writeFileSync(`${root}/logo.png`, mine);
    git("commit", "-qam", "mine");
    git("checkout", "-q", main);
    const upstream = binary(150);
    writeFileSync(`${root}/logo.png`, upstream);
    git("commit", "-qam", "upstream");
    git("checkout", "-q", "feature");
    try {
      git("rebase", main);
    } catch {
      /* expected: this conflicts */
    }

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const model = await bridge.conflictModel("logo.png");
    assert.equal(model?.shape, "binary");
    const r = await bridge.conflictTakeRole({ path: "logo.png", role: "yours" });
    assert.equal(r.ok, true, r.message ?? "");
    assert.equal(md5(readFileSync(`${root}/logo.png`)), md5(mine), "YOUR bytes — stage 3 in a rebase");
    assert.notEqual(md5(readFileSync(`${root}/logo.png`)), md5(upstream));
  } finally {
    removeTempRepo(root);
  }
});
