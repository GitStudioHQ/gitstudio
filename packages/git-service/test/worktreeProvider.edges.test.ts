import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitProcess } from "../src/GitProcess";
import { GitContext } from "../src/GitContext";
import { WorktreeProvider, parseWorktreePorcelain, parseWorktreePorcelainZ, sameFolder, unquoteC } from "../src/WorktreeProvider";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// Worktree plumbing edges the other suites leave out: where the main checkout
// is, what an unreadable folder reports, prune, a refused unlock, a record
// with no gitdir, and the parsers' less common lines.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function repo(name: string): Repo {
  const r = makeRepo(`wtp-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

/** A sibling folder for linked worktrees, cleaned up afterwards. */
function sibling(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `gs-wtp-${name}-`));
  cleanup.push(() => removeTempRepo(d));
  return d;
}

test("mainRoot is the main checkout even when asked from a linked worktree; outside a repo it is undefined", async () => {
  const r = repo("mainroot");
  const linked = join(sibling("mainroot"), "linked");
  r.git("worktree", "add", "-q", "-b", "side", linked);
  const fromMain = await r.ctx().worktrees.mainRoot();
  assert.ok(fromMain && sameFolder(fromMain, r.root), `${fromMain} is ${r.root}`);
  const inLinked = new GitContext({ root: linked });
  cleanup.push(() => inLinked.dispose());
  const fromLinked = await inLinked.worktrees.mainRoot();
  assert.ok(fromLinked && sameFolder(fromLinked, r.root), "the main checkout, not the linked one");

  const nowhere = sibling("nowhere");
  const outside = new GitContext({ root: nowhere });
  cleanup.push(() => outside.dispose());
  assert.deepEqual(await outside.worktrees.list(), []);
  assert.equal(await outside.worktrees.mainRoot(), undefined);
});

test("a git without `list -z` whose plain list also fails lists nothing", async () => {
  const fake = {
    run: async (args: string[]) =>
      args.includes("-z") ? { code: 129, stdout: "", stderr: "usage" } : { code: 128, stdout: "", stderr: "fatal: not a git repository" },
  } as unknown as GitProcess;
  assert.deepEqual(await new WorktreeProvider(fake).list(), []);
});

test("uncommitted() is undefined for a folder git cannot read, and names each change once", async () => {
  const r = repo("uncommitted");
  const wt = r.ctx().worktrees;
  assert.equal(await wt.uncommitted(join(r.root, "no-such-folder")), undefined);
  r.write("a.txt", "changed\n");
  r.write("new.txt", "new\n");
  r.write("b-src.txt", "content long enough to be recognised as a rename by git\n");
  r.git("add", "b-src.txt");
  r.git("commit", "-q", "-m", "b");
  r.git("mv", "b-src.txt", "b-dst.txt");
  assert.deepEqual((await wt.uncommitted(r.root))?.sort(), ["a.txt", "b-dst.txt", "new.txt"]);
});

test("prune forgets a worktree whose folder is gone, and leaves a present one", async () => {
  const r = repo("prune");
  const base = sibling("prune");
  r.git("worktree", "add", "-q", "-b", "gone", join(base, "gone"));
  r.git("worktree", "add", "-q", "-b", "kept", join(base, "kept"));
  rmSync(join(base, "gone"), { recursive: true, force: true });
  const wt = r.ctx().worktrees;
  assert.equal((await wt.list()).length, 3);
  assert.deepEqual(await wt.prune(), { ok: true, stderr: "" });
  const branches = (await wt.list()).map((e) => e.branch).sort();
  assert.deepEqual(branches, ["kept", "master"]);
});

test("removeAsAgreed past a lock that is not there: the refused unlock is returned and nothing is removed", async () => {
  const r = repo("unlock");
  const path = join(sibling("unlock"), "wt");
  r.git("worktree", "add", "-q", "-b", "u", path);
  const res = await r.ctx().worktrees.removeAsAgreed(path, { pastLock: { reason: "stale" } });
  assert.equal(res.ok, false);
  assert.match(res.stderr, /not locked/);
  assert.ok(existsSync(path), "the worktree is still there");
});

test("Forget skips a record with no gitdir file and still forgets the unlinked folder it was asked about", async () => {
  const r = repo("forget");
  const base = sibling("forget");
  r.git("worktree", "add", "-q", "-b", "one", join(base, "one"));
  r.git("worktree", "add", "-q", "-b", "two", join(base, "two"));
  // "one" stops being a worktree: its .git goes, the folder stays.
  unlinkSync(join(base, "one", ".git"));
  // "two"'s record loses its gitdir file.
  const records = join(r.root, ".git", "worktrees");
  const twoId = readdirSync(records).find((id) => id.startsWith("two"))!;
  unlinkSync(join(records, twoId, "gitdir"));
  const res = await r.ctx().worktrees.removeAsAgreed(join(base, "one"), {});
  assert.equal(res.ok, true, res.stderr);
  assert.ok(existsSync(join(base, "one", "a.txt")), "the folder and its files stay");
  const left = readdirSync(records);
  assert.ok(left.includes(twoId), "the other record is not touched");
  assert.equal(left.some((id) => id.startsWith("one")), false, "one's record is gone");
});

test("the porcelain parsers keep a non-heads branch as git wrote it, and ignore lines before any worktree", () => {
  const nl = parseWorktreePorcelain("HEAD stray\nbranch refs/heads/x\nlocked\n\nworktree /r\nHEAD a\nbranch refs/remotes/o/x\nunknown-attr y\n");
  assert.deepEqual(nl, [{ path: "/r", head: "a", branch: "refs/remotes/o/x" }]);
  const z = parseWorktreePorcelainZ("HEAD stray\0\0worktree /r\0HEAD a\0branch refs/remotes/o/x\0bare\0locked\0prunable\0other\0worktree /s\0HEAD b\0");
  assert.deepEqual(z, [
    { path: "/r", head: "a", branch: "refs/remotes/o/x", bare: true, locked: true, prunable: true },
    { path: "/s", head: "b" },
  ]);
});

test("unquoteC decodes git's C quoting, and keeps an escape it does not know as written", () => {
  assert.equal(unquoteC("plain"), "plain");
  assert.equal(unquoteC('"'), '"', "a lone quote is not a quoted value");
  assert.equal(unquoteC('"tab\\there"'), "tab\there");
  assert.equal(unquoteC('"caf\\303\\251"'), "café");
  assert.equal(unquoteC('"a\\qb"'), "a\\qb", "an unknown escape is kept, backslash and all");
  assert.equal(unquoteC('"end\\"'), "end\\", "a trailing backslash is kept");
});
