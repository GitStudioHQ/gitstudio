// What a stash holds (StashProvider.files) and a part cut from it
// (StashProvider.subset): the shapes a stash's sides can take, and every step
// of the cut that git can refuse — each refusal named, nothing written to the
// user's index or stash list.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, type Repo } from "./opRepo";
import { StashProvider } from "../src/StashProvider";
import { cmd, fail, ok, tap, type Rule } from "./stashProvider.kit";

const repos: Repo[] = [];
const procs: { dispose(): void }[] = [];
after(() => {
  for (const p of procs.splice(0)) p.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

const signal = new AbortController().signal;

function base(name: string): Repo {
  const r = makeRepo(name);
  repos.push(r);
  r.write("a.txt", "a\n");
  r.write("b.txt", "b\n");
  r.commitAll("base");
  return r;
}

function provider(r: Repo, rule: Rule = () => undefined): { stashes: StashProvider; ran: string[][] } {
  const t = tap(r.root, rule);
  procs.push(t);
  return { stashes: new StashProvider(t.proc), ran: t.ran };
}

const top = (r: Repo): string => r.git("rev-parse", "refs/stash").trim();
const treeFiles = (r: Repo, commit: string): string[] =>
  r.git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);

/** A -u stash: an edit to a.txt and b.txt, and an untracked new.txt. */
function withUntracked(name: string): { r: Repo; sha: string } {
  const r = base(name);
  r.write("a.txt", "a edited\n");
  r.write("b.txt", "b edited\n");
  r.write("new.txt", "fresh\n");
  r.git("stash", "push", "-q", "-u", "-m", "three files");
  return { r, sha: top(r) };
}

test("files: a -u stash lists its binary untracked file as binary, beside the tracked ones", async () => {
  const r = base("files-bin");
  r.write("a.txt", "a edited\n");
  r.write("pic.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0]));
  r.git("stash", "push", "-q", "-u");
  const { stashes } = provider(r);
  assert.deepEqual(await stashes.files(top(r), { signal }), [
    { path: "a.txt", status: "M" },
    { path: "pic.bin", status: "U", binary: true },
  ]);
});

test("files: a stashed rename is one row under its new name, with the old one", async () => {
  const r = base("files-rename");
  r.git("mv", "a.txt", "renamed.txt");
  r.git("stash", "push", "-q");
  const { stashes } = provider(r);
  assert.deepEqual(await stashes.files(top(r)), [
    { path: "renamed.txt", oldPath: "a.txt", status: "R", staged: "all" },
  ]);
});

test("files: a rename held only staged (its working side the base's) — and its part comes back as the rename, unstaged", async () => {
  // A stash whose index renames a.txt to moved.txt while its working side is
  // the base's. git's own stash writes moved.txt into the working side too, so
  // that side's diff is answered empty here; the index side, the objects and
  // every write are real.
  const r = base("files-onlystaged-rename");
  r.git("mv", "a.txt", "moved.txt");
  r.git("stash", "push", "-q");
  const sha = top(r);
  const { stashes } = provider(r, (a) =>
    a[0] === "diff-tree" && a.includes("--numstat") && !a.includes("--root") ? ok("") : undefined,
  );
  const files = await stashes.files(sha);
  const moved = files?.find((f) => f.path === "moved.txt");
  assert.deepEqual(moved, { path: "moved.txt", oldPath: "a.txt", status: "R", staged: "part", onlyStaged: true });

  const part = await stashes.subset(sha, ["moved.txt"], { unstaged: true, signal });
  assert.ok(part.ok, part.ok ? "" : part.stderr);
  // Its working side IS the staged rename: moved.txt there, a.txt not.
  assert.deepEqual(treeFiles(r, part.sha).sort(), ["b.txt", "moved.txt"]);
  assert.equal(r.git("show", `${part.sha}:moved.txt`), "a\n");
});

test("files: a file turned into a symlink is a type change", { skip: platform() === "win32" && "symlinks need privileges on Windows" }, async () => {
  const r = base("files-type");
  unlinkSync(join(r.root, "b.txt"));
  symlinkSync("a.txt", join(r.root, "b.txt"));
  r.git("stash", "push", "-q");
  const { stashes } = provider(r);
  assert.deepEqual(await stashes.files(top(r)), [{ path: "b.txt", status: "T" }]);
});

test("files: records git never writes — a raw line with no status, a stray token — are skipped, not misread", async () => {
  const stash = "1".repeat(40);
  const oid = "2".repeat(40);
  const t = tap(undefined, (a) => {
    if (a[0] === "rev-list") return ok(`${stash} ${"3".repeat(40)} ${"4".repeat(40)}\n`);
    if (a[0] === "diff-tree" && a.includes("--numstat") && !a.includes("--root")) {
      return ok(
        [
          `:100644 100644 ${"0".repeat(40)} ${oid}`, // no status letter: dropped, and its path token read as a stray
          "orphan.txt",
          "garbage-token",
          `:100644 100644 ${"0".repeat(40)} ${oid} M`,
          "kept.txt",
          "1\t1\tkept.txt",
          "",
        ].join("\0"),
      );
    }
    if (a[0] === "diff-tree") return ok("");
    return undefined;
  });
  const stashes = new StashProvider(t.proc);
  assert.deepEqual(await stashes.files(stash), [{ path: "kept.txt", status: "M" }]);
});

test("subset of something that is not a stash, or of files it does not hold, is refused and writes nothing", async () => {
  const { r, sha } = withUntracked("subset-refused");
  const { stashes, ran } = provider(r);
  assert.deepEqual(await stashes.subset("stash@{0}", ["a.txt"]), { ok: false, stderr: "“stash@{0}” is not a stash git can read." });
  assert.deepEqual(await stashes.subset(sha, ["nope.txt"]), { ok: false, stderr: "None of those files are in the stash." });
  assert.equal(ran.some((a) => a[0] === "commit-tree" || a[0] === "update-index"), false);
});

test("subset of a -u stash takes the picked tracked AND untracked files, with the stash's own message", async () => {
  const { r, sha } = withUntracked("subset-u");
  const { stashes } = provider(r);
  const part = await stashes.subset(sha, ["a.txt", "new.txt"]);
  assert.ok(part.ok);
  assert.equal(r.git("show", `${part.sha}:a.txt`), "a edited\n");
  assert.equal(r.git("show", `${part.sha}:b.txt`), "b\n", "b.txt as the base has it");
  assert.equal(r.git("show", `${part.sha}^3:new.txt`), "fresh\n", "the untracked file rides in the third parent");
  assert.equal(r.git("log", "-1", "--format=%s", part.sha).trim(), "On master: three files");
  assert.equal(r.git("log", "-1", "--format=%an <%ae>", part.sha).trim(), "Dev <dev@example.com>");
  assert.deepEqual(r.git("stash", "list", "--format=%H").trim(), sha, "the stash list is untouched");
});

test("subset when git won't say who made the stash still cuts it, with a plain message where the stash's reads empty", async () => {
  const { r, sha } = withUntracked("subset-noinfo");
  const { stashes } = provider(r, (a) => {
    if (a[0] === "log" && a.includes("--date=raw")) return fail("fatal: bad");
    if (a[0] === "log" && a[2] === "--format=%B") return ok("   \n");
    return undefined;
  });
  const part = await stashes.subset(sha, ["b.txt"]);
  assert.ok(part.ok, part.ok ? "" : part.stderr);
  assert.equal(r.git("log", "-1", "--format=%s", part.sha).trim(), "stash");
  assert.equal(r.git("show", `${part.sha}:b.txt`), "b edited\n");
});

/** Fail the n-th command whose argv starts with `prefix`, with `stderr`. */
function failNth(prefix: string, n: number, stderr = ""): Rule {
  let seen = 0;
  return (a) => (cmd(a).startsWith(prefix) && ++seen === n ? fail(stderr) : undefined);
}

for (const [step, prefix, n, picks] of [
  ["read-tree", "read-tree", 1, ["a.txt"]],
  ["read-tree", "read-tree", 2, ["a.txt"]],
  ["update-index", "update-index", 1, ["a.txt"]],
  ["write-tree", "write-tree", 1, ["a.txt"]],
  ["write-tree", "write-tree", 2, ["a.txt"]],
  ["commit-tree", "commit-tree", 1, ["a.txt"]],
  ["read-tree", "read-tree --empty", 1, ["new.txt"]],
  ["commit-tree", "commit-tree", 2, ["new.txt"]],
  ["commit-tree", "commit-tree", 3, ["new.txt"]],
] as const) {
  test(`subset stops when git refuses ${prefix} #${n} (picking ${picks.join(", ")}), and says which step`, async () => {
    const { r, sha } = withUntracked(`subset-${step}-${n}`);
    const index = r.git("ls-files", "-s");
    const { stashes } = provider(r, failNth(prefix, n, n === 1 ? "fatal: disk full\n" : ""));
    const part = await stashes.subset(sha, [...picks]);
    assert.equal(part.ok, false);
    const words = n === 1 ? "fatal: disk full" : "git refused";
    assert.equal(part.ok ? "" : part.stderr, `Couldn't take those files out of the stash (${step}): ${words}`);
    assert.equal(r.git("ls-files", "-s"), index, "the user's index was never touched (a scratch index was)");
    assert.equal(r.git("rev-parse", "refs/stash").trim(), sha);
  });
}

test("pop and drop by sha, with a signal, act on that stash where it is now", async () => {
  const r = base("pop-drop");
  r.write("a.txt", "first\n");
  r.git("stash", "push", "-q", "-m", "first");
  const first = top(r);
  r.write("b.txt", "second\n");
  r.git("stash", "push", "-q", "-m", "second");
  const second = top(r);
  const { stashes, ran } = provider(r);
  assert.equal((await stashes.drop(first, { signal })).ok, true);
  assert.ok(ran.some((a) => cmd(a) === "stash drop stash@{1}"), "found at stash@{1}, not assumed");
  assert.equal(r.git("stash", "list", "--format=%H").trim(), second);
  assert.equal((await stashes.pop(second, { signal })).ok, true);
  assert.equal(r.read("b.txt"), "second\n");
  assert.equal(r.git("stash", "list").trim(), "");
});

test("show, with a signal, adds a -u stash's untracked files as new files", async () => {
  const { r, sha } = withUntracked("show-u");
  const { stashes } = provider(r);
  const patch = await stashes.show(sha, { signal });
  assert.match(patch, /^\+a edited$/m);
  assert.match(patch, /new file mode 100644[\s\S]*^\+fresh$/m);
});

test("replace, with a signal, puts the rest of a stash back at its place", async () => {
  const { r, sha } = withUntracked("replace-ok");
  r.write("b.txt", "above\n");
  r.git("stash", "push", "-q", "-m", "above");
  const above = top(r);
  const { stashes } = provider(r);
  const part = await stashes.subset(sha, ["b.txt"]);
  assert.ok(part.ok);
  const out = await stashes.replace(sha, part.sha, { signal });
  assert.deepEqual(out, { ok: true, stderr: "", index: 1 });
  assert.deepEqual(r.git("stash", "list", "--format=%H %gs").trim().split("\n"), [
    `${above} On master: above`,
    `${part.sha} On master: three files`,
  ]);
});
