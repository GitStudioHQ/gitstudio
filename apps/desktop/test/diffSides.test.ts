// Both sides of a diff must be read the same way.
//
// The Changes view builds its FileDiff from two different readers: the working
// tree through `readWorking`, and HEAD through a raw content read. The working
// side was capped at 512KB and classified as binary/text; the HEAD side was
// neither. Two consequences, both of which render as a confident, wrong diff:
//
//  - a file LARGER than the cap that nobody has touched comes back with a full
//    left side and a capped right side, so every line past the cap is a
//    deletion. The app shows you the entire tail of a large file being removed
//    by a change you did not make.
//  - a file that is binary in HEAD is decoded as UTF-8 into the left pane.
//
// And in `readWorking` itself the size test ran ABOVE the binary tests, so
// anything binary and over the cap — a video, a PNG, a compiled bundle — never
// reached them: its first 512KB were decoded as text and mounted in an editor
// under a note reading "showing the first part of it".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

const CAP = 512 * 1024;

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "gs-diff-sides-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  return { root, git };
}

async function bridge(root: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos);
}

test("a file over the cap does not render its tail as a deletion", async () => {
  const { root, git } = repo();
  try {
    // Comfortably over the cap, and identical in HEAD and on disk apart from
    // one edit near the very top — so every difference past the cap is
    // manufactured, not real.
    const big = "a line of perfectly ordinary text\n".repeat(30_000);
    assert.ok(big.length > CAP, "the fixture must actually exceed the cap");
    writeFileSync(join(root, "big.txt"), big);
    git("add", "-A");
    git("commit", "-qm", "big");
    writeFileSync(join(root, "big.txt"), `EDITED\n${big}`);

    const b = await bridge(root);
    const d = await b.fileDiff({ path: "big.txt" });

    assert.equal(d.truncated, true, "the reader says it only read part of the file");
    // The decisive property: both sides stop at the same place. With HEAD
    // uncapped, leftText was the whole 1MB and rightText was 512KB, so the
    // editor drew ~15,000 deleted lines for an edit of one.
    assert.ok(
      Math.abs(d.leftText.length - d.rightText.length) < 4096,
      `both sides are read to the same length (left ${d.leftText.length}, right ${d.rightText.length})`,
    );
    assert.ok(d.leftText.length <= CAP + 4096, "and the left side really was capped");
  } finally {
    removeTempRepo(root);
  }
});

test("a binary file bigger than the cap is binary, not truncated", async () => {
  const { root, git } = repo();
  try {
    // A NUL in the first bytes, then padding well past the cap. `git` needs it
    // committed so the diff has a left side too.
    const bin = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]),
      Buffer.alloc(CAP + 50_000, 0xd8),
    ]);
    writeFileSync(join(root, "art.png"), bin);
    git("add", "-A");
    git("commit", "-qm", "art");
    writeFileSync(join(root, "art.png"), Buffer.concat([bin, Buffer.alloc(64, 0x7f)]));

    const b = await bridge(root);
    const d = await b.fileDiff({ path: "art.png" });

    assert.equal(d.binary, true, "it is reported as binary");
    assert.equal(d.rightText, "", "and no decoded bytes are handed to the editor");
    // Not "too large to show in full" — that note invites the reader to trust
    // the part they can see, and there is no part they can see.
    assert.notEqual(d.truncated, true, "a binary is not a truncated text file");
  } finally {
    removeTempRepo(root);
  }
});

test("a file that is binary in HEAD is not decoded into the left pane", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(join(root, "f.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]));
    git("add", "-A");
    git("commit", "-qm", "binary");
    // Replaced with ordinary text: the working side classifies clean, so only
    // the HEAD side can catch this.
    writeFileSync(join(root, "f.dat"), "now it is text\n");

    const b = await bridge(root);
    const d = await b.fileDiff({ path: "f.dat" });

    assert.equal(d.binary, true, "the HEAD side's kind counts too");
    assert.equal(d.leftText, "", "and its bytes are not decoded into the pane");
  } finally {
    removeTempRepo(root);
  }
});

test("an ordinary small edit is still an ordinary diff", async () => {
  // The guard above must not make every diff claim to be capped or binary.
  const { root, git } = repo();
  try {
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    writeFileSync(join(root, "a.txt"), "one\ntwo edited\n");

    const b = await bridge(root);
    const d = await b.fileDiff({ path: "a.txt" });

    assert.notEqual(d.binary, true);
    assert.notEqual(d.truncated, true);
    assert.equal(d.leftText, "one\ntwo\n");
    assert.equal(d.rightText, "one\ntwo edited\n");
  } finally {
    removeTempRepo(root);
  }
});

test("both sides are capped by the same ruler", async () => {
  // `showAt` cut a JS STRING at FILE_CAP_BYTES — which counts UTF-16 code
  // units — while `readWorking` cut a Buffer at that many actual BYTES. On any
  // file that is not pure ASCII the two sides of one diff were therefore cut at
  // different points in the file, and the gap between those points rendered as
  // a change in a region nobody had touched.
  const { root, git } = repo();
  try {
    // Three bytes per character, so the two rulers disagree by a factor of ~3.
    const line = "日本語のテキストが一行ずつ並んでいます\n";
    const big = line.repeat(20_000);
    // Over the cap in BYTES and under it in CODE UNITS — the sharpest form of
    // the mismatch. The old `showAt` measured code units, so it did not
    // truncate at all, while `readWorking` measured bytes and did: the left
    // pane held the whole file and the right one stopped a third of the way in,
    // so two thirds of an untouched file rendered as deleted lines.
    assert.ok(Buffer.byteLength(big, "utf8") > CAP, "the fixture exceeds the cap in bytes");
    assert.ok(big.length < CAP, "and does NOT exceed it in code units");
    writeFileSync(join(root, "jp.txt"), big);
    git("add", "-A");
    git("commit", "-qm", "jp");
    // One edit at the very top; everything past it is identical.
    writeFileSync(join(root, "jp.txt"), `EDITED\n${big}`);

    const b = await bridge(root);
    const d = await b.fileDiff({ path: "jp.txt" });
    assert.equal(d.truncated, true);
    // The decisive property: cut at the same byte offset, the two sides differ
    // only by the line that was actually added.
    assert.ok(
      Math.abs(Buffer.byteLength(d.leftText, "utf8") - Buffer.byteLength(d.rightText, "utf8")) < 64,
      `both sides stop at the same BYTE (left ${Buffer.byteLength(d.leftText, "utf8")}, right ${Buffer.byteLength(d.rightText, "utf8")})`,
    );
  } finally {
    removeTempRepo(root);
  }
});
