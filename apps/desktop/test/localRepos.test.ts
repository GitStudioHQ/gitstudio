import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  LocalRepoScanner,
  SCAN_TTL_MS,
  isInside,
  samePath,
  scanLocalCopies,
  trashRefusal,
  trashRefusalResolved,
  worktreeMainRoot,
  parsePorcelainV2,
  statusOf,
  localStatuses,
  STATUS_ROOTS_CAP,
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

// ── Worktrees ───────────────────────────────────────────────────────────────
//
// "FlexiMeal 5" — three repositories and two linked worktrees of one of them,
// and the folder head counted all five. A worktree's `.git` is a FILE naming
// the main repo's `.git/worktrees/<name>`; the scan marks it, the count in
// main.ts skips it, the row says "worktree". A submodule also uses a gitfile
// but IS its own repository, so its gitdir (into `.git/modules/`) must not
// match.

test("worktreeMainRoot reads a worktree gitfile and nothing else", () => {
  // posix.join: git writes forward slashes in a worktree gitfile on every
  // platform (this file's own assertions below say so), and the host's join
  // turned the POSIX path into a Windows one on the Windows runner.
  const wt = `gitdir: ${posix.join("/Users/x/dev/app", ".git", "worktrees", "wt-design")}\n`;
  assert.equal(worktreeMainRoot(wt), "/Users/x/dev/app");
  const sub = `gitdir: ${posix.join("..", ".git", "modules", "vendored")}\n`;
  assert.equal(worktreeMainRoot(sub), undefined, "a submodule is its own repository");
  assert.equal(worktreeMainRoot("not a gitfile"), undefined);
  assert.equal(worktreeMainRoot(""), undefined);
  // git writes forward slashes on every platform; Windows tools may rewrite.
  assert.equal(worktreeMainRoot("gitdir: C:/dev/app/.git/worktrees/wt\n"), "C:/dev/app");
  assert.equal(worktreeMainRoot("gitdir: C:\\dev\\app\\.git\\worktrees\\wt\n"), "C:\\dev\\app");
});

test("a linked worktree scans as a checkout of its repo, not another repo", async () => {
  const main = makeRepo(join(cloneDir, "app"));
  writeFileSync(join(main, "a.txt"), "hello\n");
  execFileSync("git", ["-C", main, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", main, "commit", "-m", "first"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  execFileSync("git", ["-C", main, "worktree", "add", join(cloneDir, "app-wt"), "-b", "design"], {
    stdio: "ignore",
  });

  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  const wt = copies.find((c) => c.name === "app-wt");
  const repo = copies.find((c) => c.name === "app");
  assert.ok(wt, "the worktree still LISTS — it is openable");
  assert.equal(
    wt?.worktreeOf?.endsWith("app"),
    true,
    `it names its repository (got ${wt?.worktreeOf})`,
  );
  assert.equal(repo?.worktreeOf, undefined, "the main repo carries no such mark");
});

// ── Home-row working-tree signals ───────────────────────────────────────────
//
// One `git status --porcelain=v2 --branch` per repo answers "which of my
// repositories has unpushed work" without opening any of them. The parse is
// pinned separately from the probe because porcelain v2's header lines are a
// format contract, and the branch.ab line VANISHES without an upstream — the
// zero has to come from the parser's default, not from git.

test("parsePorcelainV2 reads the headers and counts every kind of change", () => {
  const out = [
    "# branch.oid 1234567",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 abc def src/a.ts",
    "2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts",
    "u UU N... 100644 100644 100644 100644 abc def ghi both.ts",
    "? scratch.txt",
  ].join("\n");
  assert.deepEqual(parsePorcelainV2(out), { branch: "feature/x", dirty: 4, ahead: 2, behind: 1 });
});

test("no upstream means ahead 0, not a crash; detached means no branch", () => {
  const out = ["# branch.oid 1234567", "# branch.head (detached)"].join("\n");
  assert.deepEqual(parsePorcelainV2(out), { branch: "", dirty: 0, ahead: 0, behind: 0 });
});

test("statusOf answers for a real repo and undefined for a plain folder", async () => {
  const repo = makeRepo(join(cloneDir, "signals"));
  writeFileSync(join(repo, "w.txt"), "work\n");
  const st = await statusOf(repo);
  assert.equal(st?.dirty, 1, "the untracked file counts");
  assert.equal(st?.ahead, 0, "no upstream reads as zero");
  const not = await statusOf(join(cloneDir, "no-such-dir"));
  assert.equal(not, undefined);
});

test("localStatuses caps the roots it will probe", async () => {
  const many = Array.from({ length: STATUS_ROOTS_CAP + 5 }, (_, i) => join(cloneDir, `r${i}`));
  const out = await localStatuses(many);
  assert.equal(Object.keys(out).length, STATUS_ROOTS_CAP, "a bug wearing a loop stays capped");
});

test("localStatuses answers from its own clock, immune to renderer busts", async () => {
  // The renderer's SWR cache is busted by refreshAll() on every watcher tick;
  // this TTL is the one those busts can't reach.
  const repo = makeRepo(join(cloneDir, "ttl"));
  let t = 0;
  const first = await localStatuses([repo], () => t);
  writeFileSync(join(repo, "new.txt"), "x\n");
  t = 5_000;
  const cached = await localStatuses([repo], () => t);
  assert.equal(cached, first, "within the TTL the SAME answer object returns — no probes ran");
  t = 20_000;
  const fresh = await localStatuses([repo], () => t);
  assert.equal(fresh[repo]?.dirty, 1, "past the TTL the new file is seen");
});
