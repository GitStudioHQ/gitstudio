import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * The Changes banner names the operation you are in the middle of and offers
 * the two ways out. Both halves were wrong for three of the four operations.
 *
 * `opState` decided "rebasing" from the mere presence of `.git/rebase-apply`.
 * That directory belongs to `git am` just as much as to a rebase on the apply
 * backend — git tells them apart by a marker file INSIDE it, `applying` for am
 * and `rebasing` for a rebase. So a conflicted `git am` beside the app showed
 * "rebase in progress", and both of its buttons ran `git rebase`, which refuses.
 */
function repo(name: string): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-op-${name}-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  return { root, git };
}

/** Run a command that is EXPECTED to fail (a conflict), swallowing the throw. */
function tryGit(root: string, ...a: string[]): void {
  try {
    execFileSync("git", a, { cwd: root, stdio: "ignore" });
  } catch {
    /* the conflict is the point */
  }
}

test("a conflicted `git am` is not reported as a rebase", async () => {
  const { root, git } = repo("am");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    // A patch built on a DIFFERENT base than the branch it is applied to, so
    // applying it conflicts and leaves `git am` stopped.
    git("checkout", "-qb", "side");
    writeFileSync(`${root}/f.txt`, "from the patch\n");
    git("commit", "-qam", "patch side");
    const patch = git("format-patch", "-1", "--stdout");
    writeFileSync(`${root}/p.patch`, patch);

    git("checkout", "-q", "master");
    writeFileSync(`${root}/f.txt`, "from the branch\n");
    git("commit", "-qam", "branch side");
    tryGit(root, "am", "p.patch");

    assert.ok(existsSync(`${root}/.git/rebase-apply`), "git am does use rebase-apply");
    assert.ok(existsSync(`${root}/.git/rebase-apply/applying`), "and marks it `applying`");

    const repos = new RepoStore([]);
    await repos.open(root);
    const st = await new GitBridge(repos).opState();

    assert.equal(
      st.rebasing,
      false,
      "an `am` is not a rebase — the banner's Abort/Continue would run `git rebase` and be refused",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("a real rebase on the apply backend still reports as a rebase", async () => {
  const { root, git } = repo("apply");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "side");
    writeFileSync(`${root}/f.txt`, "side\n");
    git("commit", "-qam", "side");
    git("checkout", "-q", "master");
    writeFileSync(`${root}/f.txt`, "main\n");
    git("commit", "-qam", "main");
    git("checkout", "-q", "side");
    // --apply forces the backend that shares its directory with `git am`.
    tryGit(root, "rebase", "--apply", "master");

    assert.ok(existsSync(`${root}/.git/rebase-apply`), "the apply backend is in use");
    assert.ok(!existsSync(`${root}/.git/rebase-apply/applying`), "with no `applying` marker");

    const repos = new RepoStore([]);
    await repos.open(root);
    const st = await new GitBridge(repos).opState();

    assert.equal(st.rebasing, true, "this one really is a rebase");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The banner said "cherry-pick in progress" and then aborted it with
 * `git merge --abort`, which fails outright — MERGE_HEAD does not exist during
 * a cherry-pick. The one control offering a way out did nothing at all.
 */
test("a stopped cherry-pick aborts itself, not a merge", async () => {
  const { root, git } = repo("pick");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "side");
    writeFileSync(`${root}/f.txt`, "side\n");
    git("commit", "-qam", "side");
    const sideSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "master");
    writeFileSync(`${root}/f.txt`, "main\n");
    git("commit", "-qam", "main");
    const before = git("rev-parse", "HEAD").trim();
    tryGit(root, "cherry-pick", sideSha);

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const st = await b.opState();
    assert.equal(st.cherryPicking, true, "the banner names a cherry-pick");
    assert.equal(st.merging, false, "and it is not a merge");

    const wrong = await b.mergeAbort();
    assert.equal(wrong.ok, false, "`git merge --abort` cannot end a cherry-pick");
    assert.ok(existsSync(`${root}/.git/CHERRY_PICK_HEAD`), "so it is still in progress");

    const right = await b.cherryPickAbort();
    assert.equal(right.ok, true, "its own abort ends it");
    assert.ok(!existsSync(`${root}/.git/CHERRY_PICK_HEAD`), "the state is gone");
    assert.equal(git("rev-parse", "HEAD").trim(), before, "and HEAD is back where it started");
  } finally {
    removeTempRepo(root);
  }
});

test("a stopped revert aborts itself, not a merge", async () => {
  const { root, git } = repo("revert");
  try {
    writeFileSync(`${root}/f.txt`, "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    writeFileSync(`${root}/f.txt`, "two\n");
    git("commit", "-qam", "two");
    const two = git("rev-parse", "HEAD").trim();
    writeFileSync(`${root}/f.txt`, "three\n");
    git("commit", "-qam", "three");
    const before = git("rev-parse", "HEAD").trim();
    tryGit(root, "revert", "--no-edit", two);

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const st = await b.opState();
    assert.equal(st.reverting, true, "the banner names a revert");

    const wrong = await b.mergeAbort();
    assert.equal(wrong.ok, false, "`git merge --abort` cannot end a revert");
    assert.ok(existsSync(`${root}/.git/REVERT_HEAD`), "so it is still in progress");

    const right = await b.revertAbort();
    assert.equal(right.ok, true, "its own abort ends it");
    assert.ok(!existsSync(`${root}/.git/REVERT_HEAD`), "the state is gone");
    assert.equal(git("rev-parse", "HEAD").trim(), before, "and HEAD is back where it started");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * Continue, too. `--no-edit` is what keeps it from stopping in an editor the
 * app cannot show — verified against real git for both verbs, because
 * `--continue` refuses several flags and a rejected one would leave the user
 * exactly where the wrong-abort left them.
 */
test("a resolved cherry-pick and revert are finished by their own continue", async () => {
  for (const kind of ["cherry-pick", "revert"] as const) {
    const { root, git } = repo(kind);
    try {
      writeFileSync(`${root}/f.txt`, "one\n");
      git("add", "-A");
      git("commit", "-qm", "one");
      writeFileSync(`${root}/f.txt`, "two\n");
      git("commit", "-qam", "two");
      const two = git("rev-parse", "HEAD").trim();
      writeFileSync(`${root}/f.txt`, "three\n");
      git("commit", "-qam", "three");

      if (kind === "revert") {
        tryGit(root, "revert", "--no-edit", two);
      } else {
        // A cherry-pick needs a commit from somewhere else to conflict with.
        git("checkout", "-qb", "side", two);
        writeFileSync(`${root}/f.txt`, "side\n");
        git("commit", "-qam", "side");
        const side = git("rev-parse", "HEAD").trim();
        git("checkout", "-q", "-");
        tryGit(root, "cherry-pick", side);
      }
      // Resolve, the way the conflict view would.
      writeFileSync(`${root}/f.txt`, "resolved\n");
      git("add", "f.txt");

      const repos = new RepoStore([]);
      await repos.open(root);
      const b = new GitBridge(repos);
      const r = kind === "revert" ? await b.revertContinue() : await b.cherryPickContinue();

      assert.equal(r.ok, true, `${kind}: continue commits the resolution — ${r.message ?? ""}`);
      assert.ok(!existsSync(`${root}/.git/${kind === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"}`),
        `${kind}: and the operation is over`);
      assert.equal(git("show", "-s", "--format=%s", "HEAD").trim().length > 0, true);
    } finally {
      removeTempRepo(root);
    }
  }
});
