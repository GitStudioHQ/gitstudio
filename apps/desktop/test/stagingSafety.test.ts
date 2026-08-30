import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * Line and hunk staging round-trip a file through a JavaScript string: the two
 * sides are decoded as UTF-8, the selected changes applied to the string, and
 * the result hashed back with `hash-object`. Three kinds of file do not survive
 * that trip, and all three used to be destroyed silently, with ok:true.
 */
function repo(name: string): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-safety-${name}-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  return { root, git };
}

/**
 * A PNG staged line by line came back 29 bytes in, 42 out, its header
 * `efbfbd504e47` instead of `89504e47` — every non-UTF-8 byte replaced by
 * U+FFFD — and the app said "Staged selected lines."
 */
test("a binary file cannot be staged line by line, and is not offered hunks", async () => {
  const { root, git } = repo("bin");
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xc3, 0x28, 0x0a]);
    writeFileSync(`${root}/img.png`, png);
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/img.png`, Buffer.concat([png, Buffer.from("ABC\n")]));

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const sl = await b.stageLines({ path: "img.png", lines: [1, 2] });
    assert.equal(sl.ok, false, "line staging is refused");
    assert.match(sl.message ?? "", /whole/i, "and says to stage it whole");
    assert.equal(sl.expected, true, "it is a condition, not a crash to report");

    assert.equal((await b.hunksList("img.png")).length, 0, "no hunks are offered either");
    const hs = await b.hunksStage({ path: "img.png", index: 0 });
    assert.equal(hs.ok, false, "and staging one is refused");

    assert.equal(git("diff", "--cached", "--name-only").trim(), "", "the index is untouched");
  } finally {
    removeTempRepo(root);
  }
});

/** Latin-1 with no NUL byte looks like ordinary text — and is destroyed too. */
test("a non-UTF-8 text file is refused, not silently rewritten", async () => {
  const { root, git } = repo("latin1");
  try {
    const latin1 = Buffer.from("line1\ncaf\xe9\nline3\n", "latin1");
    writeFileSync(`${root}/notes.txt`, latin1);
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/notes.txt`, Buffer.concat([latin1, Buffer.from("line4\n")]));

    const repos = new RepoStore([]);
    await repos.open(root);
    const r = await new GitBridge(repos).stageLines({ path: "notes.txt", lines: [4] });
    assert.equal(r.ok, false, "refused");
    assert.equal(
      Buffer.compare(readFileSync(`${root}/notes.txt`).subarray(0, latin1.length), latin1),
      0,
      "and the bytes on disk are untouched",
    );
  } finally {
    removeTempRepo(root);
  }
});

/** An ordinary large text file must STILL stage — the guard is about bytes, not size. */
test("a big text file still stages line by line", async () => {
  const { root, git } = repo("big");
  try {
    const big = Array.from({ length: 25_000 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    writeFileSync(`${root}/big.txt`, big);
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/big.txt`, big.replace("L11\n", "L11-EDIT\n"));

    const repos = new RepoStore([]);
    await repos.open(root);
    const r = await new GitBridge(repos).stageLines({ path: "big.txt", lines: [11] });
    assert.equal(r.ok, true, `it stages (${r.message ?? ""})`);
    assert.ok(git("show", ":big.txt").includes("L11-EDIT"), "and the line is in the index");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * `readFile` FOLLOWS a symlink, so the diff showed the pointed-at file's
 * contents and staging wrote those contents in as the link's new target —
 * mode 120000, a permanently dangling link, committed and cloned that way.
 */
test("a symlink diffs as its target, and cannot be staged in parts", async () => {
  const { root, git } = repo("link");
  try {
    writeFileSync(`${root}/target.txt`, "T\n");
    writeFileSync(`${root}/other.txt`, "OTHER-1\nOTHER-2\n");
    symlinkSync("target.txt", `${root}/link`);
    git("add", "-A");
    git("commit", "-qm", "base");
    unlinkSync(`${root}/link`);
    symlinkSync("other.txt", `${root}/link`);

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const d = await b.fileDiff({ path: "link" });
    assert.equal(d?.leftText, "target.txt", "the left pane is the OLD link target");
    assert.equal(d?.rightText, "other.txt", "the right pane is the NEW one");
    assert.ok(
      !(d?.rightText ?? "").includes("OTHER-1"),
      "not the contents of the file it points at",
    );

    const sl = await b.stageLines({ path: "link", lines: [1] });
    assert.equal(sl.ok, false, "and partial staging is refused");
    assert.match(sl.message ?? "", /symbolic link/i, "saying why");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A staged RENAME means HEAD has only the OLD name, so `git show HEAD:<new>`
 * failed and the HEAD side read as "". The file then looked like one giant
 * insertion, and unstaging a single line rolled the WHOLE thing back to
 * nothing: the empty blob in the index, the rename collapsed into add+delete,
 * and a 0-byte file committed — ok:true at every step.
 */
test("unstaging one line of a staged rename keeps the file and the rename", async () => {
  const { root, git } = repo("rename");
  try {
    const lines = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    writeFileSync(`${root}/util.ts`, lines);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("mv", "util.ts", "helpers.ts");
    writeFileSync(`${root}/helpers.ts`, lines.replace("L10", "L10-FIXED"));
    git("add", "-A");
    assert.match(git("status", "--porcelain=v1"), /^R {2}util\.ts -> helpers\.ts/m, "a staged rename");

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const d = await b.fileDiff({ path: "helpers.ts" });
    assert.ok(
      (d?.leftText ?? "").includes("L1"),
      "the left pane reads HEAD under the name HEAD knows — not empty",
    );

    const un = await b.stageLines({ path: "helpers.ts", lines: [10], reverse: true });
    assert.equal(un.ok, true, `unstaging that line succeeds (${un.message ?? ""})`);

    const idx = git("show", ":helpers.ts");
    assert.ok(idx.includes("L1"), "the file is still in the index, with its content");
    assert.ok(!idx.includes("L10-FIXED"), "and only the selected line was rolled back");
    assert.match(
      git("status", "--porcelain=v1"),
      /util\.ts -> helpers\.ts/,
      "the rename survives — it did not collapse into an add plus a delete",
    );
  } finally {
    removeTempRepo(root);
  }
});
