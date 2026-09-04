import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettings } from "../src/main/appSettings";
import { scanLocalCopies } from "../src/main/localRepos";

/**
 * One clone folder was never the shape of a real machine — people keep work
 * under ~/work, ~/src, a client folder, and wherever the last `git clone`
 * landed. These pin the two halves of tracking several: the store, and the
 * scan that reads it.
 */

async function repoAt(dir: string): Promise<string> {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

test("a tracked folder survives a reload, and the clone folder is never listed as one", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-home-"));
  const userData = await mkdtemp(join(tmpdir(), "gs-ud-"));
  const cloneDir = join(home, "GitStudio");
  const work = join(home, "work");

  const s = await AppSettings.load(userData, { defaultCloneDir: cloneDir, home });
  assert.deepEqual(s.repoFolders(), []);

  assert.equal(await s.addRepoFolder(work), true);
  // The clone folder is always scanned; listing it here would let "remove"
  // imply it could be untracked.
  assert.equal(await s.addRepoFolder(cloneDir), false);
  // Idempotent — opening two repos in the same folder must not list it twice.
  assert.equal(await s.addRepoFolder(work), false);
  assert.deepEqual(s.repoFolders(), [work]);

  const again = await AppSettings.load(userData, { defaultCloneDir: cloneDir, home });
  assert.deepEqual(again.repoFolders(), [work], "it persisted");
  assert.deepEqual(again.view().repoFolders, [work], "and reaches the renderer");

  assert.equal(await again.removeRepoFolder(work), true);
  assert.equal(await again.removeRepoFolder(work), false);
  assert.deepEqual(again.repoFolders(), []);
});

test("the scan reads every tracked folder, not just the clone folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-scan-"));
  const cloneDir = join(home, "GitStudio");
  const work = join(home, "work");
  await repoAt(join(cloneDir, "alpha"));
  await repoAt(join(work, "beta"));
  await repoAt(join(work, "gamma"));

  const onlyClone = await scanLocalCopies({ cloneDir, recents: [] });
  assert.deepEqual(onlyClone.map((c) => c.name), ["alpha"]);

  const both = await scanLocalCopies({ cloneDir, folders: [work], recents: [] });
  assert.deepEqual(both.map((c) => c.name), ["alpha", "beta", "gamma"]);

  // Only the clone folder's contents may be trashed: the app put those there.
  assert.equal(both.find((c) => c.name === "alpha")?.managed, true);
  assert.equal(both.find((c) => c.name === "beta")?.managed, false);
});

test("adding the clone folder by hand does not list its repos twice", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-dup-"));
  const cloneDir = join(home, "GitStudio");
  await repoAt(join(cloneDir, "alpha"));
  const list = await scanLocalCopies({ cloneDir, folders: [cloneDir], recents: [] });
  assert.deepEqual(list.map((c) => c.name), ["alpha"]);
});

test("an unreadable tracked folder does not sink the others", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-miss-"));
  const cloneDir = join(home, "GitStudio");
  await repoAt(join(cloneDir, "alpha"));
  const list = await scanLocalCopies({
    cloneDir,
    folders: [join(home, "does-not-exist")],
    recents: [],
  });
  assert.deepEqual(list.map((c) => c.name), ["alpha"]);
});

test("a folder of folders of repositories is found, two levels deep", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-deep-"));
  const cloneDir = join(home, "GitStudio");
  const work = join(home, "work");
  await repoAt(join(cloneDir, "top-level"));
  // The ordinary shape of a machine: a client folder holding repositories.
  await repoAt(join(work, "acme", "website"));
  await repoAt(join(work, "acme", "api"));
  await repoAt(join(work, "personal", "blog"));

  const list = await scanLocalCopies({ cloneDir, folders: [work], recents: [] });
  assert.deepEqual(
    list.map((c) => c.name).sort(),
    ["api", "blog", "top-level", "website"],
    "every repository under a tracked folder is listed",
  );
});

test("a repository inside a repository is not listed separately", async () => {
  const home = await mkdtemp(join(tmpdir(), "gs-nest-"));
  const cloneDir = join(home, "GitStudio");
  await repoAt(join(cloneDir, "outer"));
  // A submodule or a vendored copy is part of its parent, not a repo of yours.
  await repoAt(join(cloneDir, "outer", "vendor", "inner"));
  const list = await scanLocalCopies({ cloneDir, recents: [] });
  assert.deepEqual(list.map((c) => c.name), ["outer"]);
});
