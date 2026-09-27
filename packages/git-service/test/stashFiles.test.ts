// What a stash holds, file by file, and taking some of those files out of it.
//
// The Changes view lists every stash's files and lets the user bring some of
// them back: Copy to Changes (the stash stays whole) or Move to Changes (the
// files leave the stash). Both apply a stash-shaped commit CUT from the stash
// (StashProvider.subset) through the shared door, so everything a whole stash
// gets — Stash & Retry, its staging, a conflict pause — a part gets too; Move
// then puts what is left of the stash where the stash was (replace).
//
// The state table, against real git:
//   K  the kind of file in the stash: modified, staged, staged then edited
//      (MM), added, untracked, deleted, deleted-and-staged, renamed, binary,
//      staged then put back in the working tree
//   L  the working tree at that path: clean, an edit of the user's there, an
//      edit elsewhere, an untracked file where the stash has one
//   H  HEAD: at the stash's base, moved on over the same file
//   S  the list: stable, pushed onto meanwhile, the stash gone
//   A  list the files, copy a file, move a file, undo the move
// plus the stashes other tools make, and two worktrees sharing one list.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { GitProcess } from "../src/GitProcess";
import { StashProvider, stashTitle, type StashFile } from "../src/StashProvider";
import { runApplying } from "../src/changesInTheWay";

const trash: string[] = [];
afterEach(() => {
  for (const d of trash.splice(0)) removeTempRepo(d);
});

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV });
}

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  write: (f: string, s: string | Buffer) => void;
  read: (f: string) => string;
  bytes: (f: string) => Buffer;
  proc: GitProcess;
  stashes: StashProvider;
}

/** A repository whose base commit holds one file for every kind of change. */
function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-stash-files-"));
  trash.push(dir);
  const git = (...args: string[]): string => gitIn(dir, ...args);
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Me"], ["user.email", "me@example.com"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const write = (f: string, s: string | Buffer): void => writeFileSync(join(dir, f), s);
  for (const f of ["mod.ts", "staged.ts", "mm.ts", "del.ts", "delstaged.ts", "reverted.ts", "other.ts"]) {
    write(f, `${f} base\n`);
  }
  write("old.md", "a\nb\nc\nd\ne\nf\ng\nh\n");
  write("bin.dat", Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const proc = new GitProcess({ cwd: dir });
  return {
    dir,
    git,
    write,
    read: (f) => readFileSync(join(dir, f), "utf8"),
    bytes: (f) => readFileSync(join(dir, f)),
    proc,
    stashes: new StashProvider(proc),
  };
}

/** One stash with every kind of change in it; returns its sha. */
function stashEveryKind(r: Repo, message = "every kind"): string {
  const { git, write } = r;
  write("mod.ts", "mod.ts stashed\n");
  write("staged.ts", "staged.ts stashed\n");
  git("add", "staged.ts");
  write("mm.ts", "mm.ts staged\n");
  git("add", "mm.ts");
  write("mm.ts", "mm.ts working\n");
  write("added.ts", "added\n");
  git("add", "added.ts");
  write("loose.txt", "loose\n");
  rmSync(join(r.dir, "del.ts"));
  git("rm", "-q", "delstaged.ts");
  git("mv", "old.md", "new.md");
  write("bin.dat", Buffer.from([0, 9, 9, 9]));
  write("reverted.ts", "reverted.ts staged\n");
  git("add", "reverted.ts");
  write("reverted.ts", "reverted.ts base\n");
  git("stash", "push", "-q", "-u", "-m", message);
  return shas(r)[0];
}

const shas = (r: Repo): string[] => r.git("stash", "list", "--format=%H").split("\n").filter(Boolean);
const status = (r: Repo): string => r.git("status", "--porcelain").replace(/\n$/, "");
const blobAt = (r: Repo, spec: string): string => r.git("rev-parse", spec).trim();

/** Apply the files `paths` of `stash` through the door, as Copy to Changes does. */
async function copyOut(r: Repo, stash: string, paths: string[]) {
  const part = await r.stashes.subset(stash, paths);
  assert.ok(part.ok, part.ok ? "" : part.stderr);
  const index = await r.stashes.holdsStaged(part.sha);
  const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: stash, index });
  return { part: part.sha, run };
}

// ── K: what a stash holds ────────────────────────────────────────────────────

test("files: every kind of change, with its staging, its old name and binary content", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const files = await r.stashes.files(sha);
  const brief = (f: StashFile) =>
    [f.path, f.status, f.oldPath ?? "", f.staged ?? "", f.binary ? "binary" : "", f.onlyStaged ? "only-staged" : ""]
      .join(" ")
      .trimEnd();
  assert.deepEqual(files?.map(brief), [
    "added.ts A  all",
    "bin.dat M   binary",
    "del.ts D",
    "delstaged.ts D  all",
    "loose.txt U",
    "mm.ts M  part",
    "mod.ts M",
    "new.md R old.md all",
    "reverted.ts M  part  only-staged",
    "staged.ts M  all",
  ]);
});

test("files: a stash with no untracked part, and a name that is not a stash's sha", async () => {
  const r = repo();
  r.write("mod.ts", "x\n");
  r.git("stash", "push", "-q");
  const [sha] = shas(r);
  assert.deepEqual((await r.stashes.files(sha))?.map((f) => f.path), ["mod.ts"]);
  assert.equal(await r.stashes.files("stash@{0}"), undefined);
  assert.equal(await r.stashes.files("--output=/tmp/x"), undefined);
});

// ── K × A=copy, L=clean, H=base: each file lands exactly as it was stashed ──

const LANDS: [string, string, (r: Repo, sha: string) => void][] = [
  ["mod.ts", " M mod.ts", (r) => assert.equal(r.read("mod.ts"), "mod.ts stashed\n")],
  ["staged.ts", "M  staged.ts", (r) => assert.equal(r.read("staged.ts"), "staged.ts stashed\n")],
  [
    "mm.ts",
    "MM mm.ts",
    (r, sha) => {
      assert.equal(r.read("mm.ts"), "mm.ts working\n");
      assert.equal(blobAt(r, ":mm.ts"), blobAt(r, `${sha}^2:mm.ts`), "the staged version is the stash's");
    },
  ],
  ["added.ts", "A  added.ts", (r) => assert.equal(r.read("added.ts"), "added\n")],
  ["loose.txt", "?? loose.txt", (r) => assert.equal(r.read("loose.txt"), "loose\n")],
  ["del.ts", " D del.ts", (r) => assert.equal(existsSync(join(r.dir, "del.ts")), false)],
  ["delstaged.ts", "D  delstaged.ts", (r) => assert.equal(existsSync(join(r.dir, "delstaged.ts")), false)],
  ["new.md", "R  old.md -> new.md", (r) => assert.equal(existsSync(join(r.dir, "old.md")), false)],
  ["bin.dat", " M bin.dat", (r) => assert.deepEqual([...r.bytes("bin.dat")], [0, 9, 9, 9])],
  [
    "reverted.ts",
    "MM reverted.ts",
    (r, sha) => {
      assert.equal(r.read("reverted.ts"), "reverted.ts base\n");
      assert.equal(blobAt(r, ":reverted.ts"), blobAt(r, `${sha}^2:reverted.ts`));
    },
  ],
];

for (const [path, expected, check] of LANDS) {
  test(`copy ${path}: it lands as stashed, alone, and the stash is untouched`, async () => {
    const r = repo();
    const sha = stashEveryKind(r);
    const before = shas(r);
    const { run } = await copyOut(r, sha, [path]);
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(status(r), expected);
    check(r, sha);
    assert.deepEqual(shas(r), before, "the stash list is exactly as it was");
  });
}

test("copy: picking a rename's old name takes the rename whole", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const { run } = await copyOut(r, sha, ["old.md"]);
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal(status(r), "R  old.md -> new.md");
});

test("subset: none of the names in the stash is refused, and nothing is written", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const part = await r.stashes.subset(sha, ["not-there.ts"]);
  assert.equal(part.ok, false);
  assert.equal(status(r), "");
});

test("subset `unstaged`: applied without its staging, a file held only staged comes back from its staged version — every other kind as a plain apply brings it", async () => {
  const plainly = async (unstaged: boolean) => {
    const r = repo();
    const sha = stashEveryKind(r);
    const every = ((await r.stashes.files(sha)) ?? []).map((f) => f.path);
    const part = await r.stashes.subset(sha, every, { unstaged });
    assert.ok(part.ok, part.ok ? "" : part.stderr);
    const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: sha });
    assert.equal(run.result.code, 0, run.result.stderr);
    return { r, sha, status: status(r).split("\n") };
  };
  const cut = await plainly(false);
  const flat = await plainly(true);
  // Without it, git restores the working copy — the base — and reverted.ts's
  // change does not come back at all.
  assert.equal(cut.r.read("reverted.ts"), "reverted.ts base\n");
  assert.equal(cut.status.some((l) => l.endsWith(" reverted.ts")), false);
  // With it: back, unstaged; and nothing else differs.
  assert.equal(flat.r.read("reverted.ts"), "reverted.ts staged\n");
  assert.deepEqual(flat.status.filter((l) => l.endsWith(" reverted.ts")), [" M reverted.ts"]);
  assert.deepEqual(flat.status.filter((l) => !l.endsWith(" reverted.ts")), cut.status);
  assert.equal(flat.r.read("mm.ts"), "mm.ts working\n", "staged then edited: its working copy, as git brings it");
  // The part only ever differs in the working copy: its index is the stash's.
  const f = await flat.r.stashes.subset(flat.sha, ["reverted.ts"], { unstaged: true });
  assert.ok(f.ok);
  assert.equal(blobAt(flat.r, `${f.sha}^2:reverted.ts`), blobAt(flat.r, `${flat.sha}^2:reverted.ts`));
});

test("subset: the part keeps the stash's message, author and date", async () => {
  const r = repo();
  const sha = stashEveryKind(r, "dated");
  const part = await r.stashes.subset(sha, ["mod.ts"]);
  assert.ok(part.ok);
  const fmt = "--format=%s|%an|%ae|%at|%ct";
  assert.equal(r.git("log", "-1", fmt, part.sha), r.git("log", "-1", fmt, sha));
  assert.deepEqual((await r.stashes.files(part.sha))?.map((f) => f.path), ["mod.ts"]);
});

// ── L: the user's own work at those paths ────────────────────────────────────

test("copy over an edit of the user's to that file: refused before anything is written, the file named", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  r.write("mod.ts", "mine\n");
  const before = status(r);
  const { run } = await copyOut(r, sha, ["mod.ts"]);
  assert.notEqual(run.result.code, 0);
  assert.deepEqual(run.inTheWay?.paths, ["mod.ts"]);
  assert.equal(status(r), before, "nothing changed");
  assert.equal(r.read("mod.ts"), "mine\n");
});

test("copy with an edit elsewhere: it lands, and the edit is still there", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  r.write("other.ts", "mine\n");
  const { run } = await copyOut(r, sha, ["mod.ts"]);
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal(r.read("other.ts"), "mine\n");
  assert.equal(r.read("mod.ts"), "mod.ts stashed\n");
});

test("copy an untracked file where the user has one of that name: asked about, theirs untouched", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  r.write("loose.txt", "mine\n");
  const { run } = await copyOut(r, sha, ["loose.txt"]);
  assert.notEqual(run.result.code, 0);
  assert.deepEqual(run.inTheWay?.paths, ["loose.txt"]);
  assert.deepEqual(run.inTheWay?.untracked, ["loose.txt"]);
  assert.equal(r.read("loose.txt"), "mine\n");
});

// ── H: HEAD moved over the same file ─────────────────────────────────────────

test("copy after HEAD moved on over that file: a conflict to resolve, and the stash kept", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  r.write("mod.ts", "mod.ts committed since\n");
  r.git("commit", "-q", "-am", "moved on");
  const before = shas(r);
  const { run } = await copyOut(r, sha, ["mod.ts"]);
  assert.notEqual(run.result.code, 0);
  assert.equal(status(r), "UU mod.ts");
  assert.match(r.read("mod.ts"), /<<<<<<<[\s\S]*mod\.ts stashed[\s\S]*>>>>>>>/);
  assert.deepEqual(shas(r), before);
});

// ── S: the list moving under the user ────────────────────────────────────────

test("a stash pushed after the cut: the part still applies, from the stash picked", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const part = await r.stashes.subset(sha, ["mod.ts"]);
  assert.ok(part.ok);
  r.write("other.ts", "someone else's\n");
  r.git("stash", "push", "-q", "-m", "pushed meanwhile");
  const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: sha });
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal(status(r), " M mod.ts");
});

test("the stash dropped after the cut: nothing runs, and it says the stash is gone", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const part = await r.stashes.subset(sha, ["mod.ts"]);
  assert.ok(part.ok);
  r.git("stash", "drop", "-q");
  const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: sha });
  assert.equal(run.stashGone, true);
  assert.equal(status(r), "");
});

test("a part is never popped: pop with cutFrom runs nothing", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const part = await r.stashes.subset(sha, ["mod.ts"]);
  assert.ok(part.ok);
  const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: sha, pop: true });
  assert.equal(run.stashGone, true);
  assert.equal(status(r), "");
});

// ── A=move: the rest of the stash takes its place ────────────────────────────

test("replace: what is left of a stash sits where the stash was, under its message", async () => {
  const r = repo();
  r.write("other.ts", "older\n");
  r.git("stash", "push", "-q", "-m", "older");
  const sha = stashEveryKind(r, "middle");
  r.write("other.ts", "newer\n");
  r.git("stash", "push", "-q", "-m", "newer");
  const [newer, , older] = shas(r);
  const rest = await r.stashes.subset(sha, ["staged.ts", "loose.txt"]);
  assert.ok(rest.ok);
  const done = await r.stashes.replace(sha, rest.sha);
  assert.equal(done.ok, true, done.stderr);
  assert.deepEqual(shas(r), [newer, rest.sha, older]);
  assert.equal(r.git("stash", "list", "--format=%gs").split("\n")[1], "On main: middle");
  assert.deepEqual((await r.stashes.files(rest.sha))?.map((f) => f.path), ["loose.txt", "staged.ts"]);
});

test("replace: a stash that has left the list changes nothing", async () => {
  const r = repo();
  const sha = stashEveryKind(r);
  const rest = await r.stashes.subset(sha, ["mod.ts"]);
  assert.ok(rest.ok);
  r.git("stash", "drop", "-q");
  const done = await r.stashes.replace(sha, rest.sha);
  assert.equal(done.gone, true);
  assert.deepEqual(shas(r), []);
});

test("undo of a move: the whole stash back where it was, what was left of it gone, the tree as before", async () => {
  const r = repo();
  const ctx = new GitContext({ root: r.dir });
  try {
    r.write("other.ts", "older\n");
    r.git("stash", "push", "-q", "-m", "older");
    const sha = stashEveryKind(r, "picked");
    const before = shas(r);
    const snap = await ctx.snapshot.capture("Move 1 file out of “picked”");
    const part = await r.stashes.subset(sha, ["mod.ts"]);
    const rest = await r.stashes.subset(sha, (await r.stashes.files(sha))!.map((f) => f.path).filter((p) => p !== "mod.ts"));
    assert.ok(part.ok && rest.ok);
    const run = await runApplying(r.proc, { kind: "stash", stash: part.sha, cutFrom: sha });
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal((await r.stashes.replace(sha, rest.sha)).ok, true);
    assert.equal(status(r), " M mod.ts");
    await ctx.snapshot.settle(snap);
    const plan = await ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    await ctx.snapshot.restore(snap);
    assert.deepEqual(shas(r), before, "the stash is back at its place, and the rest of it is gone");
    assert.equal(status(r), "");
  } finally {
    ctx.dispose();
  }
});

// ── Stashes other tools make ─────────────────────────────────────────────────

test("a stash stored by another tool (git's autostash) lists its files and can be cut", async () => {
  const r = repo();
  r.write("mod.ts", "autostashed\n");
  const made = r.git("stash", "create", "autostash").trim();
  r.git("reset", "-q", "--hard");
  r.git("stash", "store", "-m", "autostash", made);
  const [sha] = shas(r);
  assert.deepEqual((await r.stashes.files(sha))?.map((f) => `${f.path} ${f.status}`), ["mod.ts M"]);
  const { run } = await copyOut(r, sha, ["mod.ts"]);
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal(r.read("mod.ts"), "autostashed\n");
});

test("stashTitle: git's messages, a typed one, another tool's, and anything else", () => {
  assert.deepEqual(stashTitle("On main: fix login"), { text: "fix login", branch: "main" });
  assert.deepEqual(stashTitle("On feature/x: a: b"), { text: "a: b", branch: "feature/x" });
  assert.deepEqual(stashTitle("WIP on main: 1a2b3c4 Add tests"), { text: "WIP: Add tests", branch: "main", auto: true });
  assert.deepEqual(stashTitle("WIP on main: 1a2b3c4 "), { text: "WIP", branch: "main", auto: true });
  assert.deepEqual(stashTitle("WIP on (no branch): 1a2b3c4 Try it"), { text: "WIP: Try it", auto: true });
  assert.deepEqual(stashTitle("On (no branch): detached work"), { text: "detached work" });
  assert.deepEqual(stashTitle("On main: !!GitHub_Desktop<main>"), { text: "Stashed by GitHub Desktop", branch: "main" });
  assert.deepEqual(stashTitle("autostash"), { text: "Autostash", auto: true });
  assert.deepEqual(stashTitle("my own words"), { text: "my own words" });
  assert.deepEqual(stashTitle(""), { text: "(no message)" });
  assert.deepEqual(stashTitle("On main: "), { text: "(no message)", branch: "main" });
});

// ── Two worktrees, one stash list ────────────────────────────────────────────

test("worktrees share one list: a stash made in one is moved out in another, and the first sees the rest", async () => {
  const r = repo();
  const sha = stashEveryKind(r, "from main");
  const other = mkdtempSync(join(tmpdir(), "gs-stash-files-wt-"));
  trash.push(other);
  rmSync(other, { recursive: true, force: true });
  r.git("worktree", "add", "-q", "-b", "side", other);
  const proc = new GitProcess({ cwd: other });
  const there = new StashProvider(proc);
  assert.deepEqual((await there.list()).map((e) => e.sha), [sha], "the linked worktree lists the stash");
  const part = await there.subset(sha, ["mod.ts"]);
  const rest = await there.subset(sha, (await there.files(sha))!.map((f) => f.path).filter((p) => p !== "mod.ts"));
  assert.ok(part.ok && rest.ok);
  const run = await runApplying(proc, { kind: "stash", stash: part.sha, cutFrom: sha });
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal((await there.replace(sha, rest.sha)).ok, true);
  assert.equal(gitIn(other, "status", "--porcelain").trim(), "M mod.ts");
  assert.equal(status(r), "", "the main worktree's files are not touched");
  assert.deepEqual((await r.stashes.list()).map((e) => e.sha), [rest.sha], "and its list holds what is left");
  assert.equal(
    (await r.stashes.files(rest.sha))?.some((f) => f.path === "mod.ts"),
    false,
  );
});
