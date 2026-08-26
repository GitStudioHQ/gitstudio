import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalRepoScanner,
  SCAN_TTL_MS,
  isInside,
  samePath,
  scanLocalCopies,
  trashRefusal,
  trashRefusalResolved,
} from "../src/main/localRepos";
import { removeTempRepo } from "./tmpRepo";

// The Settings → Repositories manager's data layer: what's on this machine,
// which copies GitStudio may delete, and the cache that keeps a re-render from
// shelling out to git dozens of times.

let cloneDir: string;
let outside: string;

function makeRepo(dir: string, origin?: string): string {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: "ignore",
  });
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

beforeEach(() => {
  cloneDir = mkdtempSync(join(tmpdir(), "gitstudio-clonedir-"));
  outside = mkdtempSync(join(tmpdir(), "gitstudio-outside-"));
});

afterEach(() => {
  removeTempRepo(cloneDir);
  removeTempRepo(outside);
});

test("scans the clone folder and reads each origin", async () => {
  makeRepo(join(cloneDir, "widgets"), "https://github.com/acme/widgets.git");
  makeRepo(join(cloneDir, "gizmos"), "git@github.com:acme/gizmos.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  assert.deepEqual(
    copies.map((c) => [c.name, c.origin, c.managed, c.recent]),
    [
      ["gizmos", "acme/gizmos", true, false],
      ["widgets", "acme/widgets", true, false],
    ],
  );
});

test("non-repo folders and dotfiles in the clone folder are ignored", async () => {
  mkdirSync(join(cloneDir, "just-a-folder"));
  mkdirSync(join(cloneDir, ".hidden"));
  writeFileSync(join(cloneDir, "notes.txt"), "hi");
  makeRepo(join(cloneDir, "real"), "https://github.com/acme/real.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  assert.deepEqual(copies.map((c) => c.name), ["real"]);
});

test("recents outside the clone folder are listed but not managed", async () => {
  const far = makeRepo(join(outside, "faraway"), "https://github.com/acme/faraway.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [far] });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].origin, "acme/faraway");
  assert.equal(copies[0].managed, false);
  assert.equal(copies[0].recent, true);
});

test("a repo that is BOTH a recent and in the clone folder appears once, with both flags", async () => {
  const r = makeRepo(join(cloneDir, "both"), "https://github.com/acme/both.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [r] });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].managed, true);
  assert.equal(copies[0].recent, true);
});

test("a recent whose folder is gone is reported as missing, never dropped", async () => {
  const ghost = join(outside, "deleted-elsewhere");
  const copies = await scanLocalCopies({ cloneDir, recents: [ghost] });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].missing, true);
  assert.equal(copies[0].origin, undefined);
});

test("missing copies sort last", async () => {
  makeRepo(join(cloneDir, "alive"), "https://github.com/acme/alive.git");
  const copies = await scanLocalCopies({
    cloneDir,
    recents: [join(outside, "aaa-gone")],
  });
  assert.deepEqual(copies.map((c) => c.missing), [false, true]);
});

test("the open repo is flagged current", async () => {
  const r = makeRepo(join(cloneDir, "here"), "https://github.com/acme/here.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [], current: r });
  assert.equal(copies[0].current, true);
});

test("a repo with no origin still lists, without an origin", async () => {
  makeRepo(join(cloneDir, "local-only"));
  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  assert.equal(copies[0].name, "local-only");
  assert.equal(copies[0].origin, undefined);
});

test("a non-GitHub origin lists without an owner/repo chip", async () => {
  makeRepo(join(cloneDir, "gitlabbed"), "https://gitlab.com/acme/thing.git");
  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  assert.equal(copies[0].origin, undefined);
});

test("a missing clone folder is not an error — recents still list", async () => {
  const r = makeRepo(join(outside, "kept"), "https://github.com/acme/kept.git");
  const copies = await scanLocalCopies({
    cloneDir: join(cloneDir, "does-not-exist"),
    recents: [r],
  });
  assert.deepEqual(copies.map((c) => c.name), ["kept"]);
});

// ── cache ────────────────────────────────────────────────────────────────────

test("the scanner caches within the TTL and re-scans after it", async () => {
  let now = 1_000;
  const scanner = new LocalRepoScanner(() => now);
  makeRepo(join(cloneDir, "one"), "https://github.com/acme/one.git");
  const first = await scanner.scan({ cloneDir, recents: [] });
  assert.deepEqual(first.map((c) => c.name), ["one"]);

  // A second repo appears on disk — inside the TTL the cache hides it.
  makeRepo(join(cloneDir, "two"), "https://github.com/acme/two.git");
  now += SCAN_TTL_MS - 1;
  assert.deepEqual((await scanner.scan({ cloneDir, recents: [] })).map((c) => c.name), ["one"]);

  now += 2;
  assert.deepEqual(
    (await scanner.scan({ cloneDir, recents: [] })).map((c) => c.name),
    ["one", "two"],
  );
});

test("invalidate() drops the cache immediately", async () => {
  let now = 1_000;
  const scanner = new LocalRepoScanner(() => now);
  makeRepo(join(cloneDir, "one"), "https://github.com/acme/one.git");
  await scanner.scan({ cloneDir, recents: [] });
  makeRepo(join(cloneDir, "two"), "https://github.com/acme/two.git");
  scanner.invalidate();
  assert.equal((await scanner.scan({ cloneDir, recents: [] })).length, 2);
});

test("a different input re-scans even inside the TTL", async () => {
  const scanner = new LocalRepoScanner(() => 1_000);
  makeRepo(join(cloneDir, "one"), "https://github.com/acme/one.git");
  const far = makeRepo(join(outside, "far"), "https://github.com/acme/far.git");
  assert.equal((await scanner.scan({ cloneDir, recents: [] })).length, 1);
  assert.equal((await scanner.scan({ cloneDir, recents: [far] })).length, 2);
});

// ── the delete rule ──────────────────────────────────────────────────────────

test("isInside is boundary-correct (a sibling prefix is NOT inside)", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
});

test("trashing a managed clone is allowed", () => {
  assert.equal(trashRefusal(join(cloneDir, "widgets"), { cloneDir }), null);
});

test("trashing refuses anything outside the clone folder", () => {
  const why = trashRefusal(join(outside, "precious"), { cloneDir });
  assert.match(why ?? "", /inside your clone folder/);
});

test("trashing refuses the clone folder itself", () => {
  assert.match(trashRefusal(cloneDir, { cloneDir }) ?? "", /clone folder itself/);
});

test("trashing refuses the repo that is currently open", () => {
  const root = join(cloneDir, "open-one");
  assert.match(trashRefusal(root, { cloneDir, current: root }) ?? "", /open right now/);
});

test("a '..' path can't escape the clone folder", () => {
  const escape = join(cloneDir, "..", "elsewhere");
  assert.match(trashRefusal(escape, { cloneDir }) ?? "", /inside your clone folder/);
});

// The resolved form is what main.ts actually calls — it must agree with the
// pure rule AND refuse to delete things that aren't repositories.

test("the resolved rule allows a real managed clone", async () => {
  const r = makeRepo(join(cloneDir, "widgets"), "https://github.com/acme/widgets.git");
  assert.equal(await trashRefusalResolved(r, { cloneDir }), null);
});

test("the resolved rule refuses a plain folder inside the clone folder", async () => {
  const plain = join(cloneDir, "not-a-repo");
  mkdirSync(plain);
  assert.match((await trashRefusalResolved(plain, { cloneDir })) ?? "", /isn't a git repository/);
});

test("the resolved rule refuses a path that doesn't exist", async () => {
  assert.match(
    (await trashRefusalResolved(join(cloneDir, "ghost"), { cloneDir })) ?? "",
    /isn't a git repository/,
  );
});

test("the resolved rule refuses a repo OUTSIDE the clone folder", async () => {
  const far = makeRepo(join(outside, "far"), "https://github.com/acme/far.git");
  assert.match((await trashRefusalResolved(far, { cloneDir })) ?? "", /inside your clone folder/);
});

test("the resolved rule refuses a symlink inside the clone folder pointing out of it", async () => {
  const far = makeRepo(join(outside, "target"), "https://github.com/acme/target.git");
  const link = join(cloneDir, "sneaky");
  symlinkSync(far, link);
  assert.match((await trashRefusalResolved(link, { cloneDir })) ?? "", /inside your clone folder/);
});

test("samePath compares resolved paths, not strings", () => {
  assert.equal(samePath("/a/b", "/a/./b"), true);
  assert.equal(samePath("/a/b", "/a/b/"), true);
  assert.equal(samePath("/a/b", "/a/c"), false);
});
