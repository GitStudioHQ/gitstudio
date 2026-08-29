import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseNameStatus } from "../src/main/gitBridge";

/**
 * Non-ASCII paths in a commit's file list.
 *
 * `git diff/show --name-status` C-QUOTES any path outside ASCII by default, so
 * "café.txt" comes out as the literal 17-character string `"caf\303\251.txt"`
 * — quotes and octal escapes included. That string was what the Commits view
 * printed, and what every subsequent `-- <path>` was handed, so the file's diff
 * came back empty: the path did not exist. Every commit touching an accented,
 * Cyrillic or CJK filename was affected.
 *
 * -z removes the quoting entirely, and handles the paths a `quotepath=false`
 * would still break on (tabs and newlines in filenames are legal).
 */
function repo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-namestatus-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { root, git };
}

test("non-ASCII paths survive, verbatim, from real git", () => {
  const { root, git } = repo();
  try {
    const names = ["café.txt", "日本語.md", "Ünïcødé dir/файл.rs"];
    execFileSync("mkdir", ["-p", `${root}/Ünïcødé dir`]);
    for (const n of names) writeFileSync(`${root}/${n}`, "x\n");
    git("add", "-A");
    git("commit", "-qm", "one");

    const out = git("show", "--name-status", "-M", "-z", "--format=", "HEAD");
    const files = parseNameStatus(out);
    assert.deepEqual(
      files.map((f) => f.path).sort(),
      [...names].sort(),
      "the paths are the real ones, not git's C-quoted octal form",
    );
    assert.ok(
      files.every((f) => f.status === "A"),
      "and each carries its status",
    );
    for (const f of files) {
      assert.ok(!f.path.includes("\\"), `no escape sequences left in ${f.path}`);
      assert.ok(!f.path.startsWith('"'), `no wrapping quotes left in ${f.path}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rename reports the destination, not the source", () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/old-name.txt`, "the quick brown fox\n".repeat(20));
    git("add", "-A");
    git("commit", "-qm", "one");
    git("mv", "old-name.txt", "nouveau-nom.txt");
    git("commit", "-qm", "two");

    const files = parseNameStatus(git("show", "--name-status", "-M", "-z", "--format=", "HEAD"));
    assert.equal(files.length, 1, "one rename is one row");
    assert.equal(files[0].status, "R");
    assert.equal(files[0].path, "nouveau-nom.txt", "the destination — the path that exists now");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary ASCII commits parse exactly as before", () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/a.txt`, "a\n");
    writeFileSync(`${root}/b.txt`, "b\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    writeFileSync(`${root}/a.txt`, "a2\n");
    execFileSync("rm", [`${root}/b.txt`]);
    writeFileSync(`${root}/c.txt`, "c\n");
    git("add", "-A");
    git("commit", "-qm", "two");

    const files = parseNameStatus(git("diff", "--name-status", "-M", "-z", "HEAD~1..HEAD"));
    assert.deepEqual(
      files.map((f) => [f.status, f.path]).sort(),
      [
        ["A", "c.txt"],
        ["D", "b.txt"],
        ["M", "a.txt"],
      ],
      "add / delete / modify all still land",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
