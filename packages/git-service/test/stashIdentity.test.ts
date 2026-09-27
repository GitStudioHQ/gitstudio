// A stash is addressed by its sha, shown whole, and applied with its staging.
//
// Three things the (since removed) Stashes view got wrong, pinned here
// against real git — the Changes view's Stashes group runs the same doors:
//
//   · `stash@{n}` is a POSITION. Every push, pop or drop renumbers the list,
//     so a row that said stash@{2} when it was drawn could pop or drop another
//     stash by the time the user answered the question. By sha, the entry is
//     found in the list immediately before git runs, and a stash that has left
//     the list runs nothing.
//   · `git stash show -p` leaves out the files a `-u` stash holds, so a stash
//     of new files opened as an EMPTY document.
//   · a plain `stash apply` brings staged changes back unstaged, and a pop
//     then drops the only copy of a staged version that differed from the
//     working copy (`MM`). `--index` restores it — but git runs it over the
//     user's own staged changes by unstaging them and then refusing, so the
//     door never runs it there (`indexBusy`), and says so when git refuses
//     the staged half itself (`indexRefused`).
//
// And Create Branch from a stash (`git stash branch`) through the same door:
// git switches to the stash's base and only then applies it, so a refusal
// over the user's work left them on the new branch with the stash unapplied.
// What is in its way is asked before git runs.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitProcess } from "../src/GitProcess";
import { StashProvider } from "../src/StashProvider";
import { changesInTheWayMessage, runApplying, stashAndRetry } from "../src/changesInTheWay";

const trash: string[] = [];
afterEach(() => {
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

/** util.ts and app.ts, committed on main. */
function repo(): { dir: string; proc: GitProcess; stashes: StashProvider } {
  const dir = mkdtempSync(join(tmpdir(), "gitstudio-stash-id-"));
  trash.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Me");
  git(dir, "config", "user.email", "me@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "gc.auto", "0");
  writeFileSync(join(dir, "util.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "app.ts"), "app\n");
  writeFileSync(join(dir, "other.ts"), "other\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const proc = new GitProcess({ cwd: dir });
  return { dir, proc, stashes: new StashProvider(proc) };
}

const write = (dir: string, f: string, s: string): void => writeFileSync(join(dir, f), s);
const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
/** `git status --porcelain`, leading spaces kept: " M" is not "M ". */
const status = (dir: string): string => git(dir, "status", "--porcelain").replace(/\n$/, "");
const stashShas = (dir: string): string[] =>
  git(dir, "stash", "list", "--format=%H").split("\n").filter((l) => l.length > 0);

/** A stash of util.ts staged as `a = 2` with the working copy at `a = 3`. */
function stashMM(dir: string, message = "mm"): string {
  write(dir, "util.ts", "export const a = 2;\n");
  git(dir, "add", "util.ts");
  write(dir, "util.ts", "export const a = 3;\n");
  git(dir, "stash", "push", "-q", "-m", message);
  return stashShas(dir)[0];
}

/** A stash of an unstaged edit to app.ts. */
function stashEdit(dir: string, message: string, body = `${message}\n`): string {
  write(dir, "app.ts", body);
  git(dir, "stash", "push", "-q", "-m", message);
  return stashShas(dir)[0];
}

// ── Shown whole ─────────────────────────────────────────────────────────────

test("show: a stash made with -u lists its new files — it is not an empty document", async () => {
  const { dir, stashes } = repo();
  write(dir, "new.ts", "brand new\n");
  git(dir, "stash", "push", "-q", "-u", "-m", "untracked only");
  const text = await stashes.show(stashShas(dir)[0]);
  assert.match(text, /^\+\+\+ b\/new\.ts$/m, text);
  assert.match(text, /^\+brand new$/m, text);
});

test("show: a mixed -u stash has its tracked edit AND its new file", async () => {
  const { dir, stashes } = repo();
  write(dir, "app.ts", "app changed\n");
  write(dir, "fresh.ts", "fresh\n");
  git(dir, "stash", "push", "-q", "-u", "-m", "mixed");
  const text = await stashes.show("stash@{0}");
  assert.match(text, /^\+app changed$/m, text);
  assert.match(text, /^\+fresh$/m, text);
});

test("show: with stash.showIncludeUntracked set, a -u stash's new files are listed once", async () => {
  const { dir, stashes } = repo();
  git(dir, "config", "stash.showIncludeUntracked", "true");
  write(dir, "new.ts", "brand new\n");
  git(dir, "stash", "push", "-q", "-u", "-m", "untracked only");
  const text = await stashes.show(stashShas(dir)[0]);
  assert.equal(text.match(/^\+\+\+ b\/new\.ts$/gm)?.length, 1, text);
});

test("show: a stash without -u is shown as git shows it, and a non-stash name shows nothing", async () => {
  const { dir, stashes } = repo();
  const s = stashEdit(dir, "plain");
  assert.equal(await stashes.show(s), git(dir, "stash", "show", "-p", s));
  assert.equal(await stashes.show("--output=x"), "");
});

// ── Addressed by sha ────────────────────────────────────────────────────────

test("drop by sha drops THAT stash after the list was renumbered underneath", async () => {
  const { dir, stashes } = repo();
  const target = stashEdit(dir, "target");
  const other = stashEdit(dir, "pushed on top"); // target is stash@{1} now
  const r = await stashes.drop(target);
  assert.ok(r.ok, r.stderr);
  assert.deepEqual(stashShas(dir), [other], "the stash the user named is gone, the other kept");
});

test("drop / pop / branch by a sha that has left the list run nothing and say so", async () => {
  const { dir, stashes } = repo();
  const gone = stashEdit(dir, "gone");
  git(dir, "stash", "drop", "-q");
  const kept = stashEdit(dir, "kept");
  for (const r of [await stashes.drop(gone), await stashes.pop(gone), await stashes.branch(gone, "from-gone")]) {
    assert.equal(r.ok, false);
    assert.equal(r.gone, true);
  }
  assert.deepEqual(stashShas(dir), [kept], "the stash now at stash@{0} is untouched");
  assert.equal(git(dir, "branch", "--list", "from-gone"), "");
});

test("names that are not a stash never reach git", async () => {
  const { dir, stashes } = repo();
  stashEdit(dir, "one");
  for (const bad of ["--all", "-q", "HEAD", "stash@{0}^", "main"]) {
    assert.equal((await stashes.drop(bad)).ok, false, bad);
    assert.equal((await stashes.pop(bad)).ok, false, bad);
    assert.equal((await stashes.apply(bad)).ok, false, bad);
  }
  assert.equal(stashShas(dir).length, 1);
  assert.equal((await stashes.branch("stash@{0}", "-D")).ok, false, "a branch name like an option");
});

test("branch by sha drops the stash it was made from, not the one at its old number", async () => {
  const { dir, stashes } = repo();
  const target = stashEdit(dir, "target");
  const other = stashEdit(dir, "on top");
  const r = await stashes.branch(target, "from-stash");
  assert.ok(r.ok, r.stderr);
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD").trim(), "from-stash");
  assert.equal(read(dir, "app.ts"), "target\n");
  assert.deepEqual(stashShas(dir), [other]);
});

test("branch refuses a name a branch already has, before git says it", async () => {
  const { dir, stashes } = repo();
  const s = stashEdit(dir, "x");
  const r = await stashes.branch(s, "main");
  assert.equal(r.ok, false);
  assert.match(r.stderr, /already exists/);
  assert.deepEqual(stashShas(dir), [s]);
});

test("the door pops by sha: a stash pushed on top meanwhile is not the one popped", async () => {
  const { dir, proc } = repo();
  const target = stashEdit(dir, "target");
  const other = stashEdit(dir, "pushed on top");
  const r = await runApplying(proc, { kind: "stash", stash: target, pop: true });
  assert.equal(r.result.code, 0, r.result.stderr);
  assert.equal(read(dir, "app.ts"), "target\n");
  assert.deepEqual(stashShas(dir), [other]);
});

test("the door runs nothing for a stash that has left the list", async () => {
  const { dir, proc } = repo();
  const gone = stashEdit(dir, "gone");
  git(dir, "stash", "drop", "-q");
  const kept = stashEdit(dir, "kept");
  for (const pop of [true, false]) {
    const r = await runApplying(proc, { kind: "stash", stash: gone, pop });
    assert.equal(r.stashGone, true);
    assert.equal(status(dir), "");
    assert.deepEqual(stashShas(dir), [kept]);
  }
  const retry = await stashAndRetry(proc, { kind: "stash", stash: gone, pop: true });
  assert.equal(retry.stashGone, true);
  assert.deepEqual(stashShas(dir), [kept]);
});

// ── Applied with its staging ────────────────────────────────────────────────

test("holdsStaged: a stash with a staged part, and one without", async () => {
  const { dir, stashes } = repo();
  const plain = stashEdit(dir, "plain");
  const mm = stashMM(dir);
  assert.equal(await stashes.holdsStaged(mm), true);
  assert.equal(await stashes.holdsStaged(plain), false);
  assert.equal(await stashes.holdsStaged("--all"), false);
});

for (const pop of [false, true]) {
  const verb = pop ? "pop" : "apply";
  test(`${verb} with index brings an MM file back MM, the staged version in the index`, async () => {
    const { dir, proc } = repo();
    const mm = stashMM(dir);
    const r = await runApplying(proc, { kind: "stash", stash: mm, pop, index: true });
    assert.equal(r.result.code, 0, r.result.stderr);
    assert.equal(status(dir), "MM util.ts");
    assert.equal(git(dir, "show", ":util.ts"), "export const a = 2;\n", "the staged version is staged again");
    assert.equal(read(dir, "util.ts"), "export const a = 3;\n");
    assert.deepEqual(stashShas(dir), pop ? [] : [mm]);
  });

  test(`${verb} with index over staged changes of the user's runs nothing (git would unstage them)`, async () => {
    const { dir, proc } = repo();
    const mm = stashMM(dir);
    write(dir, "other.ts", "mine, staged\n");
    git(dir, "add", "other.ts");
    const before = status(dir);
    const r = await runApplying(proc, { kind: "stash", stash: mm, pop, index: true });
    assert.equal(r.indexBusy, true);
    assert.equal(status(dir), before, "the user's staged change is still staged");
    assert.deepEqual(stashShas(dir), [mm]);
    const retry = await stashAndRetry(proc, { kind: "stash", stash: mm, pop, index: true });
    assert.equal(retry.indexBusy, true);
    assert.equal(status(dir), before);
  });

  test(`${verb} with index whose staged half no longer applies says so, having changed nothing`, async () => {
    const { dir, proc } = repo();
    const mm = stashMM(dir);
    write(dir, "util.ts", "export const a = 7;\n");
    git(dir, "commit", "-q", "-am", "HEAD moves under the staged file");
    const r = await runApplying(proc, { kind: "stash", stash: mm, pop, index: true });
    assert.equal(r.indexRefused, true, r.result.stderr);
    assert.equal(r.inTheWay, undefined);
    assert.equal(status(dir), "", "nothing changed");
    assert.deepEqual(stashShas(dir), [mm]);
  });
}

test("Stash & Retry with index: the user's edit in the way comes back, and so does the stash's staging", async () => {
  const { dir, proc } = repo();
  const mm = stashMM(dir);
  write(dir, "util.ts", "export const a = 1;\n// mine\n");
  const first = await runApplying(proc, { kind: "stash", stash: mm, index: true });
  assert.ok(first.inTheWay, "the user's edit is in the way");
  assert.equal(read(dir, "util.ts"), "export const a = 1;\n// mine\n", "and nothing was written");
  const out = await stashAndRetry(proc, { kind: "stash", stash: mm, index: true });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(out.indexRefused, undefined);
  assert.equal(git(dir, "show", ":util.ts"), "export const a = 2;\n", "the stash's staged version is staged");
  // The user's edit: back in the file, or — git will not merge a stash into
  // uncommitted work — kept in the GitStudio stash the outcome names.
  const mine = read(dir, "util.ts").includes("// mine") ||
    git(dir, "stash", "list", "--format=%H %s").split("\n").some((l) =>
      l.includes("GitStudio: before") && git(dir, "show", `${l.split(" ")[0]}:util.ts`).includes("// mine"));
  assert.ok(mine, `the user's edit survives (fate ${out.fate})`);
});

for (const pop of [false, true]) {
  test(`${pop ? "pop" : "apply"} with index over files left unmerged is the stop's to say, not a question about staging`, async () => {
    const { dir, proc } = repo();
    const mm = stashMM(dir);
    git(dir, "checkout", "-q", "-b", "side");
    write(dir, "other.ts", "side\n");
    git(dir, "commit", "-q", "-am", "side");
    git(dir, "checkout", "-q", "main");
    write(dir, "other.ts", "main\n");
    git(dir, "commit", "-q", "-am", "main");
    try {
      git(dir, "merge", "-q", "side");
    } catch {
      // stops on the conflict in other.ts
    }
    assert.equal(status(dir), "UU other.ts");
    const r = await runApplying(proc, { kind: "stash", stash: mm, pop, index: true });
    assert.equal(r.indexBusy, undefined, "not asked about the stash's staging");
    assert.equal(r.blocked?.operation, "merge", JSON.stringify(r));
    assert.equal(status(dir), "UU other.ts");
    assert.deepEqual(stashShas(dir), [mm]);
  });
}

test("a stash with nothing staged is applied as before: no --index, the user's staging kept", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "plain");
  write(dir, "other.ts", "mine, staged\n");
  git(dir, "add", "other.ts");
  const r = await runApplying(proc, { kind: "stash", stash: s, pop: true });
  assert.equal(r.result.code, 0, r.result.stderr);
  assert.equal(status(dir), " M app.ts\nM  other.ts");
});

// ── Create a branch from it, through the door ───────────────────────────────

const head = (dir: string): string => git(dir, "symbolic-ref", "--short", "HEAD").trim();
const branches = (dir: string): string[] =>
  git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter((l) => l.length > 0);

test("branch op: a clean tree gets the branch at the stash's base, the stash applied with its staging, and dropped", async () => {
  const { dir, proc } = repo();
  const mm = stashMM(dir);
  const other = stashEdit(dir, "pushed on top"); // mm is stash@{1} now
  const base = git(dir, "rev-parse", `${mm}^1`).trim();
  write(dir, "app.ts", "HEAD moves on\n");
  git(dir, "commit", "-q", "-am", "HEAD moves on");
  const r = await runApplying(proc, { kind: "stash", stash: mm, branch: "from-stash" });
  assert.equal(r.result.code, 0, r.result.stderr);
  assert.equal(head(dir), "from-stash");
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), base, "at the stash's base");
  assert.equal(status(dir), "MM util.ts", "its staging came back");
  assert.deepEqual(stashShas(dir), [other], "THAT stash dropped, by sha");
});

test("branch op: an edit where the switch writes is in the way — asked before git runs, nothing changed", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "other.ts", "HEAD moves on\n");
  git(dir, "commit", "-q", "-am", "HEAD moves on");
  write(dir, "other.ts", "mine\n"); // differs between HEAD and the stash's base
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["other.ts"], untracked: [], branch: "from-stash" });
  assert.equal(head(dir), "main");
  assert.deepEqual(branches(dir), ["refs/heads/main"], "no branch was made");
  assert.equal(status(dir), " M other.ts");
  assert.deepEqual(stashShas(dir), [s]);
});

test("branch op: an edit to a file the stash changes is in the way — git would switch, then refuse", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "app.ts", "mine\n");
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["app.ts"], untracked: [], branch: "from-stash" });
  assert.equal(head(dir), "main", "not left on a new branch");
  assert.deepEqual(branches(dir), ["refs/heads/main"]);
  assert.equal(read(dir, "app.ts"), "mine\n");
  assert.deepEqual(stashShas(dir), [s]);
});

test("branch op: an untracked file where the stash restores one is in the way", async () => {
  const { dir, proc } = repo();
  write(dir, "new.ts", "stashed new\n");
  git(dir, "stash", "push", "-q", "-u", "-m", "with a new file");
  const [s] = stashShas(dir);
  write(dir, "new.ts", "mine\n");
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["new.ts"], untracked: ["new.ts"], branch: "from-stash" });
  assert.equal(head(dir), "main");
  assert.equal(read(dir, "new.ts"), "mine\n");
});

test("branch op: staged work elsewhere is carried along, still staged — for a stash with nothing staged", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "other.ts", "mine, staged\n");
  git(dir, "add", "other.ts");
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.equal(r.result.code, 0, r.result.stderr);
  assert.equal(head(dir), "from-stash");
  assert.equal(status(dir), " M app.ts\nM  other.ts");
  assert.deepEqual(stashShas(dir), []);
});

// `git stash branch` always applies with --index. For a stash that holds
// staged changes, git resets the index before it merges and then refuses over
// ANY staged change of the user's — after the switch: the user was left on the
// new branch, their staged change unstaged, the stash unapplied, and git's
// error in red.
test("branch op: a stash WITH staged changes over staged work anywhere — in the way, asked before git runs", async () => {
  const { dir, proc } = repo();
  const mm = stashMM(dir);
  write(dir, "other.ts", "mine, staged\n");
  git(dir, "add", "other.ts");
  const r = await runApplying(proc, { kind: "stash", stash: mm, branch: "from-stash" });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["other.ts"], untracked: [], branch: "from-stash" }, r.result.stderr);
  assert.equal(head(dir), "main", "not left on a new branch");
  assert.deepEqual(branches(dir), ["refs/heads/main"], "no branch was made");
  assert.equal(status(dir), "M  other.ts", "still staged");
  assert.deepEqual(stashShas(dir), [mm]);
});

test("branch op: …and Stash & Retry makes the branch with the stash's staging, and the staged work comes back staged", async () => {
  const { dir, proc } = repo();
  const mm = stashMM(dir);
  write(dir, "other.ts", "mine, staged\n");
  git(dir, "add", "other.ts");
  const out = await stashAndRetry(proc, { kind: "stash", stash: mm, branch: "from-stash" });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(head(dir), "from-stash");
  assert.equal(git(dir, "show", ":util.ts"), "export const a = 2;\n", "the stash's staged version is staged");
  assert.equal(read(dir, "util.ts"), "export const a = 3;\n");
  assert.equal(out.fate, "restored");
  assert.equal(read(dir, "other.ts"), "mine, staged\n", "the user's change is back");
  assert.equal(git(dir, "show", ":other.ts"), "mine, staged\n", "…and staged, as it was");
  assert.deepEqual(stashShas(dir), [], "the stash applied and dropped, and ours popped");
});

test("branch op: Stash & Retry over a file of the user's staged apart from its working copy keeps it in the stash — never loses the staged version", async () => {
  const { dir, proc } = repo();
  const mm = stashMM(dir);
  write(dir, "other.ts", "mine, staged\n");
  git(dir, "add", "other.ts");
  write(dir, "other.ts", "mine, staged\nand more, unstaged\n");
  const out = await stashAndRetry(proc, { kind: "stash", stash: mm, branch: "from-stash" });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(head(dir), "from-stash");
  assert.equal(git(dir, "show", ":util.ts"), "export const a = 2;\n", "the stash's staged version is staged");
  // git will not put it back with its staging over the staging that just came
  // in, and without it the staged version would be gone once popped.
  assert.equal(out.fate, "kept");
  const [ours] = stashShas(dir);
  assert.equal(stashShas(dir).length, 1);
  assert.equal(git(dir, "show", `${ours}^2:other.ts`), "mine, staged\n", "its staged version is in the stash");
  assert.equal(git(dir, "show", `${ours}:other.ts`), "mine, staged\nand more, unstaged\n", "and its working copy");
});

test("branch op: what is in its way is said as creating the branch, not as applying the stash", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "other.ts", "HEAD moves on\n");
  git(dir, "commit", "-q", "-am", "HEAD moves on");
  write(dir, "other.ts", "mine\n"); // in the way of the switch; the stash never touches it
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.ok(r.inTheWay);
  const said = changesInTheWayMessage(r.inTheWay!);
  assert.match(said, /^Your uncommitted changes to other\.ts are in the way of creating the branch “from-stash” from the stash/, said);
  assert.doesNotMatch(said, /applying the stash/, said);
  assert.match(
    changesInTheWayMessage({ kind: "stash", paths: ["app.ts"], untracked: [] }),
    /in the way of applying the stash/,
    "an apply is still said as one",
  );
});

test("branch op: Stash & Retry puts the edit in the way aside, makes the branch, and brings the edit back", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "other.ts", "HEAD moves on\n");
  git(dir, "commit", "-q", "-am", "HEAD moves on");
  write(dir, "other.ts", "HEAD moves on\n// mine\n");
  const out = await stashAndRetry(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(out.stashed?.message, "GitStudio: before creating a branch from a stash");
  assert.equal(head(dir), "from-stash");
  assert.equal(read(dir, "app.ts"), "stashed\n", "the stash applied");
  assert.ok(!stashShas(dir).includes(s), "and dropped");
  // The user's edit: back in the file, or — it conflicts with the base the
  // branch is at — in the conflict, or kept in the stash the outcome names.
  assert.ok(out.fate, "the outcome says what became of the edit");
  const mine = read(dir, "other.ts").includes("// mine") ||
    git(dir, "stash", "list", "--format=%H %s").split("\n").some((l) =>
      l.includes("GitStudio: before") && git(dir, "show", `${l.split(" ")[0]}:other.ts`).includes("// mine"));
  assert.ok(mine, `the user's edit survives (fate ${out.fate})`);
});

test("branch op: a name git will not take runs nothing, and is never answered with the user's work in the way", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  write(dir, "app.ts", "mine\n"); // would be in the way
  for (const name of ["main", "-D", "--force", "bad..name", ""]) {
    const r = await runApplying(proc, { kind: "stash", stash: s, branch: name });
    assert.notEqual(r.result.code, 0, name);
    assert.equal(r.inTheWay, undefined, name);
    assert.match(r.result.stderr, /already exists|not a branch name/, name);
  }
  assert.equal(head(dir), "main");
  assert.deepEqual(branches(dir), ["refs/heads/main"]);
  assert.deepEqual(stashShas(dir), [s]);
});

test("branch op: over a stopped merge it is refused as the stop, having switched nothing", async () => {
  const { dir, proc } = repo();
  const s = stashEdit(dir, "stashed", "stashed\n");
  git(dir, "checkout", "-q", "-b", "side");
  write(dir, "other.ts", "side\n");
  git(dir, "commit", "-q", "-am", "side");
  git(dir, "checkout", "-q", "main");
  write(dir, "other.ts", "main\n");
  git(dir, "commit", "-q", "-am", "main");
  try {
    git(dir, "merge", "-q", "side");
  } catch {
    // stops on the conflict
  }
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.equal(r.blocked?.operation, "merge");
  assert.equal(head(dir), "main");
  assert.deepEqual(stashShas(dir), [s]);
});

test("branch op: over a merge stopped with its resolution staged, it is refused — git would switch and END the merge", async () => {
  const { dir, proc } = repo();
  git(dir, "checkout", "-q", "-b", "side");
  write(dir, "other.ts", "side\n");
  git(dir, "commit", "-q", "-am", "side");
  git(dir, "checkout", "-q", "main");
  write(dir, "other.ts", "main\n");
  git(dir, "commit", "-q", "-am", "main");
  const s = stashEdit(dir, "stashed", "stashed\n"); // its base is HEAD: the switch moves nothing
  try {
    git(dir, "merge", "-q", "side");
  } catch {
    // stops on the conflict
  }
  write(dir, "other.ts", "resolved\n");
  git(dir, "add", "other.ts");
  const r = await runApplying(proc, { kind: "stash", stash: s, branch: "from-stash" });
  assert.equal(r.blocked?.operation, "merge", JSON.stringify(r));
  assert.equal(head(dir), "main");
  assert.equal(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").length > 0, true, "the merge is still there to finish");
  assert.equal(status(dir), "M  other.ts");
  assert.deepEqual(stashShas(dir), [s]);
});

test("branch op: a stash that has left the list runs nothing", async () => {
  const { dir, proc } = repo();
  const gone = stashEdit(dir, "gone");
  git(dir, "stash", "drop", "-q");
  const kept = stashEdit(dir, "kept");
  const r = await runApplying(proc, { kind: "stash", stash: gone, branch: "from-gone" });
  assert.equal(r.stashGone, true);
  assert.deepEqual(branches(dir), ["refs/heads/main"]);
  assert.deepEqual(stashShas(dir), [kept]);
});
