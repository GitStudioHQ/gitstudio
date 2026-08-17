import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoWatcher, shouldRefreshFor } from "../src/main/repoWatcher";

// The app never watched the filesystem, so editing a file elsewhere and switching
// back showed a stale Changes list (issue #17). A watcher fixes that only if it
// stays quiet: a recursive watch on a real repo sees node_modules churn during an
// install and .git lock files several times a second during a fetch, and every
// event we accept costs a git spawn.
//
// This predicate is the whole difference between a watcher that is invisible and
// one that makes the app worse than it was.

test("an ordinary source edit refreshes", () => {
  for (const p of ["src/index.ts", "README.md", "a.txt", "deep/nested/file.rs"]) {
    assert.equal(shouldRefreshFor(p), true, p);
  }
});

test("dotfiles people actually edit still refresh", () => {
  // A naive ".git" prefix check swallows all of these.
  for (const p of [".gitignore", ".gitattributes", ".github/workflows/ci.yml", ".env"]) {
    assert.equal(shouldRefreshFor(p), true, p);
  }
});

test("build output and dependency trees are ignored", () => {
  // The volume case: an npm install writes tens of thousands of these.
  for (const p of [
    "node_modules/lodash/index.js",
    "apps/desktop/node_modules/x/y.js",
    "dist/main.js",
    "out/bundle.js",
    "build/app.o",
    "target/debug/app",
    ".next/cache/x",
    "__pycache__/mod.pyc",
  ]) {
    assert.equal(shouldRefreshFor(p), false, p);
  }
});

test("git's own churn is ignored, but the parts that move history are not", () => {
  // Kept: these change what the user sees.
  for (const p of [
    ".git/HEAD",
    ".git/index",
    ".git/packed-refs",
    ".git/MERGE_HEAD",
    ".git/CHERRY_PICK_HEAD",
    ".git/REVERT_HEAD",
    ".git/REBASE_HEAD",
    ".git/refs/heads/main",
    ".git/rebase-merge/done",
  ]) {
    assert.equal(shouldRefreshFor(p), true, p);
  }
  // Dropped: pure noise, and there is a lot of it.
  for (const p of [
    ".git/objects/ab/cdef123",
    ".git/logs/HEAD",
    ".git/COMMIT_EDITMSG",
    ".git/FETCH_HEAD",
    ".git/hooks/pre-commit.sample",
  ]) {
    assert.equal(shouldRefreshFor(p), false, p);
  }
});

test("lock files never trigger — the real write follows a moment later", () => {
  // Reacting to the lock doubles every refresh: git writes index.lock, then
  // index. Both would fire inside one debounce window at best, two at worst.
  for (const p of [".git/index.lock", ".git/refs/heads/main.lock", ".git/HEAD.lock"]) {
    assert.equal(shouldRefreshFor(p), false, p);
  }
});

test("editor scratch files are ignored", () => {
  // Save-through-temp-file would otherwise fire twice per save.
  for (const p of ["src/index.ts~", "src/.#index.ts", ".DS_Store", "src/.index.ts.swp", "notes.tmp"]) {
    assert.equal(shouldRefreshFor(p), false, p);
  }
});

test("Windows backslash paths are understood", () => {
  // fs.watch hands back the platform separator, and on Windows that is "\".
  assert.equal(shouldRefreshFor("src\\index.ts"), true);
  assert.equal(shouldRefreshFor("node_modules\\lodash\\index.js"), false);
  assert.equal(shouldRefreshFor(".git\\index"), true);
  assert.equal(shouldRefreshFor(".git\\objects\\ab\\cdef"), false);
  assert.equal(shouldRefreshFor(".git\\index.lock"), false);
});

test("an empty or nameless path never triggers", () => {
  assert.equal(shouldRefreshFor(""), false);
  assert.equal(shouldRefreshFor("/"), false);
});

test("a file merely NAMED like an ignored directory still refreshes", () => {
  // The filter matches path SEGMENTS, so a real source file called dist.ts, or a
  // folder called distribution, must not be swallowed.
  assert.equal(shouldRefreshFor("src/dist.ts"), true);
  assert.equal(shouldRefreshFor("distribution/readme.md"), true);
  assert.equal(shouldRefreshFor("src/build.rs"), true);
  assert.equal(shouldRefreshFor("my-node_modules-notes.md"), true);
});

// ── The watcher itself, against a real directory ─────────────────────────────
//
// The filter tests above prove what we IGNORE. These prove the thing actually
// fires — which is the half that matters to the person who reported it, and the
// half a pure unit test cannot show.

/** Resolve on the watcher's next callback, or reject after `ms`. */
function nextChange(
  attach: (cb: (info: { gitDir: boolean }) => void) => void,
  ms = 3000,
): Promise<{ gitDir: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no change within ${ms}ms`)), ms);
    attach((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

test("a working-tree edit fires, and is NOT reported as a git-dir change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-watch-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  let fire: ((i: { gitDir: boolean }) => void) | undefined;
  const w = new RepoWatcher(dir, (i) => fire?.(i));
  try {
    if (w.degraded) {
      return; // no recursive watch on this platform/kernel — the focus path covers it
    }
    const seen = nextChange((cb) => (fire = cb));
    writeFileSync(join(dir, "hello.txt"), "hi\n");
    const info = await seen;
    assert.equal(info.gitDir, false, "a file edit must not drag a graph reload with it");
  } finally {
    w.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .git change IS reported as one, so history gets re-read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-watch-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  let fire: ((i: { gitDir: boolean }) => void) | undefined;
  const w = new RepoWatcher(dir, (i) => fire?.(i));
  try {
    if (w.degraded) {
      return;
    }
    const seen = nextChange((cb) => (fire = cb));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.equal((await seen).gitDir, true);
  } finally {
    w.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a burst of writes collapses into ONE refresh", async () => {
  // Save All over fifty files, or a build, must not mean fifty git spawns.
  const dir = mkdtempSync(join(tmpdir(), "gs-watch-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  let calls = 0;
  const w = new RepoWatcher(dir, () => {
    calls++;
  });
  try {
    if (w.degraded) {
      return;
    }
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `x${i}\n`);
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(calls, 1, `fifty writes produced ${calls} refreshes`);
  } finally {
    w.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored churn produces NO refresh at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-watch-"));
  mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  let calls = 0;
  const w = new RepoWatcher(dir, () => {
    calls++;
  });
  try {
    if (w.degraded) {
      return;
    }
    writeFileSync(join(dir, ".git", "objects", "ab", "cdef"), "blob\n");
    writeFileSync(join(dir, ".git", "index.lock"), "");
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, "node_modules", "pkg", `m${i}.js`), "//\n");
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(calls, 0, "an npm install must not wake the app up");
  } finally {
    w.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose() stops it, so a closed repo cannot keep firing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-watch-"));
  let calls = 0;
  const w = new RepoWatcher(dir, () => {
    calls++;
  });
  w.dispose();
  writeFileSync(join(dir, "after.txt"), "x\n");
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(calls, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing directory degrades instead of throwing", () => {
  // The app must survive opening a repo that vanished from under it.
  const w = new RepoWatcher(join(tmpdir(), "gs-does-not-exist-" + Date.now()), () => {});
  assert.equal(w.degraded, true, "no watcher, but no crash either");
  w.dispose();
});
