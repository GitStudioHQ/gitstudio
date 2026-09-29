import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { GitProcess, type GitRunResult, type GitRunWithInputOptions } from "../src/GitProcess";
import { StagingProvider, chunkPaths } from "../src/StagingProvider";
import { makeRepo, type Repo } from "./opRepo";

// The index writes behind the Changes view — unstage, bulk batches, content
// staging's mode and filters, rename lookup — against real repositories. Each
// test reads the INDEX back with git itself, so it checks what was staged,
// not what the provider said it did.

const posixOnly = process.platform === "win32" ? "needs POSIX file modes / symlinks" : false;

function repo(name: string): Repo {
  const r = makeRepo(name);
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

/** `git ls-files -s -- <rel>` → the mode staged for it, or "" when absent. */
const stagedMode = (r: Repo, rel: string): string => r.git("ls-files", "-s", "--", rel).split(" ")[0] ?? "";
const staged = (r: Repo): string[] => r.git("diff", "--cached", "--name-only").split("\n").filter(Boolean);

/** A real git, except the commands `fail` picks exit 1 with `stderr`. */
class Refusing extends GitProcess {
  constructor(
    cwd: string,
    private readonly fail: (args: string[]) => string | undefined,
  ) {
    super({ cwd });
  }
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    const why = this.fail(args);
    if (why !== undefined) return { code: 1, stdout: "", stderr: why };
    return super.run(args, opts);
  }
}

// ── unstage ────────────────────────────────────────────────────────────────

test("when reset refuses, unstageFile drops the entry with rm --cached and keeps the file on disk", async () => {
  const r = makeRepo("unstage-fallback"); // unborn: nothing committed
  try {
    r.write("new.txt", "new\n");
    r.git("add", "new.txt");
    const staging = new StagingProvider(new Refusing(r.root, (a) => (a[0] === "reset" ? "fatal: no HEAD" : undefined)));
    const res = await staging.unstageFile("new.txt");
    assert.deepEqual(res, { ok: true, stderr: "fatal: no HEAD" }, "the rm was quiet, so the reset's words are kept");
    assert.equal(r.git("ls-files", "--", "new.txt"), "", "no longer in the index");
    assert.equal(r.read("new.txt"), "new\n", "the working copy is untouched");
  } finally {
    r.cleanup();
  }
});

test("when both reset and rm refuse, unstageFile reports the failure with rm's reason", async () => {
  const r = makeRepo("unstage-both");
  try {
    const staging = new StagingProvider(new Refusing(r.root, (a) => (a[0] === "reset" ? "reset said no" : undefined)));
    const res = await staging.unstageFile("never-added.txt");
    assert.equal(res.ok, false);
    assert.match(res.stderr, /never-added\.txt/, "git's own words about the path, not the reset's");
  } finally {
    r.cleanup();
  }
});

test("unstageFiles of nothing is ok and runs no git", async () => {
  const r = repo("unstage-none");
  try {
    const staging = new StagingProvider(new Refusing(r.root, () => "should not run"));
    assert.deepEqual(await staging.unstageFiles([]), { ok: true, stderr: "" });
  } finally {
    r.cleanup();
  }
});

test("unstageFiles unstages every path in one go on a repo with commits", async () => {
  const r = repo("unstage-many");
  try {
    r.write("a.txt", "A\n");
    r.write("b.txt", "b\n");
    r.git("add", "-A");
    assert.deepEqual(staged(r), ["a.txt", "b.txt"]);
    const res = await r.ctx().staging.unstageFiles(["a.txt", "b.txt"]);
    assert.equal(res.ok, true);
    assert.deepEqual(staged(r), []);
    assert.equal(r.read("a.txt"), "A\n");
  } finally {
    r.cleanup();
  }
});

test("when reset refuses, unstageFiles falls back to rm --cached for the whole set", async () => {
  const r = makeRepo("unstage-many-fallback");
  try {
    r.write("x.txt", "x\n");
    r.write("y.txt", "y\n");
    r.git("add", "-A");
    const staging = new StagingProvider(new Refusing(r.root, (a) => (a[0] === "reset" ? "fatal: no HEAD" : undefined)));
    const res = await staging.unstageFiles(["x.txt", "y.txt"]);
    assert.deepEqual(res, { ok: true, stderr: "fatal: no HEAD" }, "ok, with the reset's words kept as unstageFile does");
    assert.equal(r.git("ls-files"), "", "both entries are out of the index");
    assert.equal(r.read("y.txt"), "y\n");
  } finally {
    r.cleanup();
  }
});

test("when reset and rm both refuse, unstageFiles fails with the rm's reason", async () => {
  const r = makeRepo("unstage-many-both");
  try {
    const staging = new StagingProvider(
      new Refusing(r.root, (a) => (a[0] === "reset" ? "reset said no" : a[0] === "rm" ? "rm said no" : undefined)),
    );
    assert.deepEqual(await staging.unstageFiles(["x.txt"]), { ok: false, stderr: "rm said no" });
  } finally {
    r.cleanup();
  }
});

// ── bulk batches ───────────────────────────────────────────────────────────

test("stageFiles of nothing is ok and runs no git", async () => {
  const r = repo("stage-none");
  try {
    const staging = new StagingProvider(new Refusing(r.root, () => "should not run"));
    assert.deepEqual(await staging.stageFiles([]), { ok: true, stderr: "" });
  } finally {
    r.cleanup();
  }
});

test("a changeset too long for one command line is staged whole, across several batches", async () => {
  const r = repo("stage-chunks");
  try {
    const names = Array.from({ length: 260 }, (_, i) => `${String(i).padStart(3, "0")}-${"n".repeat(96)}.txt`);
    for (const n of names) r.write(n, `${n}\n`);
    assert.ok(chunkPaths(names).length >= 2, "precondition: this really is more than one batch");
    const res = await r.ctx().staging.stageFiles(names);
    assert.deepEqual(res, { ok: true, stderr: "" });
    assert.deepEqual(staged(r), names, "every path, from every batch");
  } finally {
    r.cleanup();
  }
});

test("a failing batch is reported with git's reason, and the other batches still run", async () => {
  const r = repo("discard-chunks");
  try {
    const names = Array.from({ length: 260 }, (_, i) => `${String(i).padStart(3, "0")}-${"d".repeat(96)}.txt`);
    for (const n of names) r.write(n, "committed\n");
    r.commitAll("many");
    for (const n of names) r.write(n, "edited\n");
    // An untracked path in the FIRST batch makes that whole `checkout --` refuse.
    r.write("zz-untracked.txt", "u\n");
    const batches = chunkPaths(["zz-untracked.txt", ...names]);
    assert.ok(batches.length >= 2);
    const res = await r.ctx().staging.discardFiles(["zz-untracked.txt", ...names]);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /zz-untracked\.txt/, "the first failure's own words");
    const first = new Set(batches[0]);
    const lastName = names[names.length - 1];
    assert.ok(!first.has(lastName), "(the last path is in a later batch)");
    assert.equal(r.read(lastName), "committed\n", "a later batch was still discarded");
    assert.equal(r.read(names[0]), "edited\n", "the refused batch discarded nothing");
  } finally {
    r.cleanup();
  }
});

test("chunkPaths keeps an over-budget path alone in its own batch, in order", () => {
  const huge = "x".repeat(30000);
  assert.deepEqual(chunkPaths(["a", huge, "b"]), [["a"], [huge], ["b"]]);
  assert.deepEqual(chunkPaths([]), []);
});

// ── stageContent: filters and modes ────────────────────────────────────────

test("a clean filter that fails refuses to stage content, and the index is untouched", async () => {
  const r = repo("stage-filter-fail");
  try {
    r.write(".gitattributes", "*.txt filter=boom\n");
    r.git("config", "filter.boom.clean", "false");
    r.git("config", "filter.boom.required", "true");
    const before = r.git("ls-files", "-s", "--", "a.txt");
    const res = await r.ctx().staging.stageContent("a.txt", "new content\n");
    assert.equal(res.ok, false);
    assert.match(res.stderr, /boom|filter/i, "git's reason is passed on");
    assert.equal(r.git("ls-files", "-s", "--", "a.txt"), before);
  } finally {
    r.cleanup();
  }
});

test("with core.fileMode=false the mode already in the index is kept, whatever the disk says", async () => {
  const r = repo("stage-filemode-off");
  try {
    r.write("run.sh", "#!/bin/sh\n");
    r.git("add", "run.sh");
    r.git("update-index", "--chmod=+x", "run.sh");
    r.git("config", "core.fileMode", "false");
    const staging = r.ctx().staging;
    assert.equal((await staging.stageContent("run.sh", "#!/bin/sh\necho hi\n")).ok, true);
    assert.equal(stagedMode(r, "run.sh"), "100755", "the recorded executable bit survives");
    assert.equal((await staging.stageContent("fresh.txt", "fresh\n")).ok, true);
    assert.equal(stagedMode(r, "fresh.txt"), "100644", "an untracked path defaults to a plain file");
    assert.equal(r.git("show", ":run.sh"), "#!/bin/sh\necho hi\n", "and the content is what was asked");
  } finally {
    r.cleanup();
  }
});

test("staging content for a path gone from disk keeps the index's mode rather than inventing one", async () => {
  const r = repo("stage-gone");
  try {
    r.write("tool", "x\n");
    r.git("add", "tool");
    r.git("update-index", "--chmod=+x", "tool");
    r.git("commit", "-q", "-m", "tool");
    rmSync(join(r.root, "tool"));
    const res = await r.ctx().staging.stageContent("tool", "y\n");
    assert.equal(res.ok, true);
    assert.equal(stagedMode(r, "tool"), "100755");
    assert.equal(r.git("show", ":tool"), "y\n");
  } finally {
    r.cleanup();
  }
});

test("a brand-new executable staged through content staging is recorded executable", { skip: posixOnly }, async () => {
  const r = repo("stage-exec");
  try {
    r.write("build.sh", "#!/bin/sh\n");
    chmodSync(join(r.root, "build.sh"), 0o755);
    r.git("config", "core.fileMode", "true");
    assert.equal((await r.ctx().staging.stageContent("build.sh", "#!/bin/sh\nmake\n")).ok, true);
    assert.equal(stagedMode(r, "build.sh"), "100755");
  } finally {
    r.cleanup();
  }
});

test("chmod +x on a tracked file is staged by content staging (fileMode unset: git's POSIX default)", { skip: posixOnly }, async () => {
  const r = repo("stage-chmod");
  try {
    chmodSync(join(r.root, "a.txt"), 0o755);
    assert.equal((await r.ctx().staging.stageContent("a.txt", "a\n")).ok, true);
    assert.equal(stagedMode(r, "a.txt"), "100755");
  } finally {
    r.cleanup();
  }
});

test("a symlink staged through content staging is recorded as a link", { skip: posixOnly }, async () => {
  const r = repo("stage-link");
  try {
    symlinkSync("a.txt", join(r.root, "link"));
    assert.equal((await r.ctx().staging.stageContent("link", "a.txt")).ok, true);
    assert.equal(stagedMode(r, "link"), "120000");
    assert.equal(r.git("show", ":link"), "a.txt", "the link's target is the blob");
  } finally {
    r.cleanup();
  }
});

// ── renamedFrom / index & HEAD reads ───────────────────────────────────────

test("renamedFrom names the HEAD side of a staged rename, and nothing for any other path", async () => {
  const r = repo("renamed-from");
  try {
    r.write("keep.txt", "k\n");
    r.write("old-name.txt", "line one\nline two\nline three\nline four\n");
    r.commitAll("two more files");
    r.write("keep.txt", "k2\n");
    r.write("added.txt", "brand new\n");
    r.git("mv", "old-name.txt", "new-name.txt");
    r.git("add", "-A");
    const staging = r.ctx().staging;
    assert.equal(await staging.renamedFrom("new-name.txt"), "old-name.txt");
    assert.equal(await staging.renamedFrom("old-name.txt"), undefined, "the source is not a destination");
    assert.equal(await staging.renamedFrom("keep.txt"), undefined, "a modification is not a rename");
    assert.equal(await staging.renamedFrom("added.txt"), undefined);
  } finally {
    r.cleanup();
  }
});

test("renamedFrom is undefined when git cannot answer", async () => {
  const r = repo("renamed-fail");
  try {
    const staging = new StagingProvider(new Refusing(r.root, (a) => (a[0] === "diff" ? "fatal" : undefined)));
    assert.equal(await staging.renamedFrom("a.txt"), undefined);
  } finally {
    r.cleanup();
  }
});

test("indexContent and headContent of a path that is not there are empty, not an error", async () => {
  const r = repo("contents-missing");
  try {
    r.write("new.txt", "staged only\n");
    r.git("add", "new.txt");
    const staging = r.ctx().staging;
    assert.equal(await staging.indexContent("new.txt"), "staged only\n");
    assert.equal(await staging.headContent("new.txt"), "", "not in HEAD yet");
    assert.equal(await staging.indexContent("nowhere.txt"), "");
  } finally {
    r.cleanup();
  }
});

// ── signals ────────────────────────────────────────────────────────────────

test("every staging call honours an already-aborted signal: it rejects and changes nothing", async () => {
  const r = repo("staging-abort");
  try {
    r.write("a.txt", "edited\n");
    r.write("u.txt", "untracked\n");
    const s = r.ctx().staging;
    const ac = new AbortController();
    ac.abort();
    const opts = { signal: ac.signal };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["stageFile", () => s.stageFile("a.txt", opts)],
      ["stageFiles", () => s.stageFiles(["a.txt"], opts)],
      ["unstageFile", () => s.unstageFile("a.txt", opts)],
      ["discardChanges", () => s.discardChanges("a.txt", opts)],
      ["discardFiles", () => s.discardFiles(["a.txt"], opts)],
      ["cleanFiles", () => s.cleanFiles(["u.txt"], opts)],
      ["stageContent", () => s.stageContent("a.txt", "x\n", opts)],
      ["markedConflicts", () => s.markedConflicts(["a.txt"], opts)],
      ["renamedFrom", () => s.renamedFrom("a.txt", opts)],
      ["indexContent", () => s.indexContent("a.txt", opts)],
      ["headContent", () => s.headContent("a.txt", opts)],
      ["commit", () => s.commit("msg", opts)],
      ["stagedCount", () => s.stagedCount(opts)],
      ["whyNothingToCommit", () => s.whyNothingToCommit(opts)],
    ];
    for (const [name, call] of calls) {
      await assert.rejects(call(), { name: "AbortError" }, name);
    }
    assert.equal(r.read("a.txt"), "edited\n", "nothing discarded");
    assert.equal(r.read("u.txt"), "untracked\n", "nothing cleaned");
    assert.deepEqual(staged(r), [], "nothing staged");
    assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "1", "nothing committed");
  } finally {
    r.cleanup();
  }
});

test("a live signal that never fires changes nothing about the answers", async () => {
  const r = repo("staging-live-signal");
  try {
    r.write("a.txt", "edited\n");
    const s = r.ctx().staging;
    const opts = { signal: new AbortController().signal };
    assert.equal((await s.stageFile("a.txt", opts)).ok, true);
    assert.equal(await s.stagedCount(opts), 1);
    assert.equal(await s.indexContent("a.txt", opts), "edited\n");
    assert.equal(await s.headContent("a.txt", opts), "a\n");
    assert.equal((await s.unstageFile("a.txt", opts)).ok, true);
    assert.equal(await s.whyNothingToCommit(opts), "unstagedChanges");
    assert.equal((await s.discardChanges("a.txt", opts)).ok, true);
    assert.equal(r.read("a.txt"), "a\n");
  } finally {
    r.cleanup();
  }
});
