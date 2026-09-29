// StashProvider's doors when the name is wrong, the stash has gone, or git
// says no — each answered in words, with the repository left as it was.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, type Repo } from "./opRepo";
import { GitProcess } from "../src/GitProcess";
import { STASH_GONE_MESSAGE, StashProvider } from "../src/StashProvider";
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

/** A provider over the real repo, with `rule` answering first. */
function provider(r: Repo, rule: Rule = () => undefined): { stashes: StashProvider; ran: string[][] } {
  const t = tap(r.root, rule);
  procs.push(t);
  return { stashes: new StashProvider(t.proc), ran: t.ran };
}

const stashShas = (r: Repo): string[] => r.git("stash", "list", "--format=%H").split("\n").filter(Boolean);

test("the list is empty when git can't list the stashes, and a line with no selector is skipped", async () => {
  const r = base("list-fails");
  const broken = provider(r, (a) => (a[0] === "stash" && a[1] === "list" ? fail("fatal: bad", 128) : undefined));
  assert.deepEqual(await broken.stashes.list(), []);

  const sha = "c".repeat(40);
  const odd = provider(r, (a) =>
    a[0] === "stash" && a[1] === "list" ? ok(`${"d".repeat(40)}\n${sha}\x1fstash@{0}\n`) : undefined,
  );
  assert.deepEqual(await odd.stashes.list({ signal }), [{ sha, ref: "stash@{0}", message: "", time: 0 }]);
});

test("find: a name that is not a full sha is never looked up", async () => {
  const r = base("find");
  const { stashes, ran } = provider(r);
  assert.equal(await stashes.find("stash@{0}"), undefined);
  assert.equal(await stashes.find("HEAD"), undefined);
  assert.deepEqual(ran, []);
});

test("apply, pop, drop and branch refuse a name that is no stash's, and run nothing", async () => {
  const r = base("names");
  const { stashes, ran } = provider(r);
  for (const bad of ["--all", "HEAD~1", "main"]) {
    assert.deepEqual(await stashes.apply(bad), { ok: false, stderr: `“${bad}” is not a stash.` });
    assert.deepEqual(await stashes.pop(bad), { ok: false, stderr: `“${bad}” is not a stash.` });
    assert.deepEqual(await stashes.drop(bad), { ok: false, stderr: `“${bad}” is not a stash.` });
    assert.deepEqual(await stashes.branch(bad, "fresh"), { ok: false, stderr: `“${bad}” is not a stash.` });
    assert.equal(await stashes.show(bad), "");
    assert.equal(await stashes.holdsStaged(bad), false);
  }
  // Only branch's name check reaches git (check-ref-format / rev-parse of refs/heads/fresh).
  assert.ok(ran.every((a) => a[0] === "check-ref-format" || a[0] === "rev-parse"), ran.map(cmd).join("\n"));
});

test("pop, drop and branch of a stash that has left the list are the user's state: gone, and nothing ran", async () => {
  const r = base("gone");
  r.write("a.txt", "mine\n");
  r.git("stash", "push", "-q", "-m", "kept");
  const kept = stashShas(r);
  const { stashes } = provider(r);
  const ghost = "e".repeat(40);
  for (const out of [await stashes.pop(ghost, { signal }), await stashes.drop(ghost, { signal }), await stashes.branch(ghost, "fresh", { signal })]) {
    assert.deepEqual(out, { ok: false, gone: true, stderr: STASH_GONE_MESSAGE });
  }
  assert.deepEqual(stashShas(r), kept, "the other stash is untouched");
  assert.equal(r.git("branch", "--list", "fresh").trim(), "", "no branch was made");
});

test("apply with a signal applies the stash by its sha", async () => {
  const r = base("apply");
  r.write("a.txt", "stashed\n");
  r.git("stash", "push", "-q");
  const [sha] = stashShas(r);
  const { stashes } = provider(r);
  const out = await stashes.apply(sha, { signal });
  assert.equal(out.ok, true);
  assert.equal(r.read("a.txt"), "stashed\n");
  assert.deepEqual(stashShas(r), [sha], "apply keeps the stash");
});

test("show of a commit that is no stash reads as empty, not as a patch", async () => {
  const r = base("show-plain");
  const head = r.sha("HEAD");
  const { stashes } = provider(r);
  assert.equal(await stashes.show(head, { signal }), "");
});

test("files: a sha git can't read, and a plain commit, hold no files", async () => {
  const r = base("files-none");
  const { stashes } = provider(r);
  assert.equal(await stashes.files("f".repeat(40), { signal }), undefined, "no such object");
  assert.equal(await stashes.files(r.sha("HEAD")), undefined, "one parent: not stash-shaped");
  assert.equal(await stashes.files("stash@{0}"), undefined, "only a full sha names a stash here");
});

test("files: a diff-tree git refuses means the stash can't be read, and nothing is cached", async () => {
  const r = base("files-difftree");
  r.write("a.txt", "stashed\n");
  r.git("stash", "push", "-q");
  const [sha] = stashShas(r);
  let refuse = true;
  const { stashes } = provider(r, (a) => (refuse && a[0] === "diff-tree" ? fail("fatal: bad object") : undefined));
  assert.equal(await stashes.files(sha), undefined);
  refuse = false;
  assert.deepEqual(await stashes.files(sha), [{ path: "a.txt", status: "M" }], "read again once git can");
});

test("the file lists of the 200 most recently read stashes are kept; the oldest read is let go", async () => {
  const shaOf = (n: number): string => n.toString(16).padStart(40, "0");
  const reads = new Map<string, number>();
  const t = tap(undefined, (a) => {
    if (a[0] === "rev-list") {
      const sha = a[4];
      reads.set(sha, (reads.get(sha) ?? 0) + 1);
      return ok(`${sha} ${"b".repeat(40)} ${"c".repeat(40)}\n`);
    }
    if (a[0] === "diff-tree") return ok("");
    return undefined;
  });
  const stashes = new StashProvider(t.proc);
  await stashes.files(shaOf(1));
  await stashes.files(shaOf(2));
  for (let n = 3; n <= 200; n++) await stashes.files(shaOf(n));
  await stashes.files(shaOf(1)); // read again: now the most recent
  await stashes.files(shaOf(201)); // one too many: #2 is the oldest read
  await stashes.files(shaOf(1));
  await stashes.files(shaOf(2));
  assert.equal(reads.get(shaOf(1)), 1, "a stash read recently is still cached");
  assert.equal(reads.get(shaOf(2)), 2, "the oldest read was dropped and read from git again");
});

test("replace refuses a name that is not a full sha, naming the wrong one", async () => {
  const r = base("replace-names");
  const { stashes, ran } = provider(r);
  const good = "a".repeat(40);
  assert.deepEqual(await stashes.replace("stash@{0}", good), { ok: false, stderr: "“stash@{0}” is not a stash." });
  assert.deepEqual(await stashes.replace(good, "HEAD"), { ok: false, stderr: "“HEAD” is not a stash." });
  assert.deepEqual(ran, []);
});

test("replace of a stash that has left the list is gone, and the list is unchanged", async () => {
  const r = base("replace-gone");
  r.write("a.txt", "x\n");
  r.git("stash", "push", "-q");
  const before = stashShas(r);
  const { stashes } = provider(r);
  const out = await stashes.replace("e".repeat(40), before[0], { signal });
  assert.equal(out.gone, true);
  assert.deepEqual(stashShas(r), before);
});

test("replace stops, with git's words, when the stash can't be dropped", async () => {
  const r = base("replace-drop");
  r.write("a.txt", "x\n");
  r.git("stash", "push", "-q");
  const before = stashShas(r);
  const { stashes } = provider(r, (a) => (a[0] === "stash" && a[1] === "drop" ? fail("error: refs/stash is locked") : undefined));
  const out = await stashes.replace(before[0], r.sha("HEAD"));
  assert.deepEqual(out, { ok: false, stderr: "error: refs/stash is locked" });
  assert.deepEqual(stashShas(r), before, "the stash is still there");
});

test("replace that can't store the replacement says which commit holds the files left in the stash", async () => {
  const r = base("replace-store");
  r.write("a.txt", "one\n");
  r.write("b.txt", "two\n");
  r.git("stash", "push", "-q", "-m", "both");
  const [sha] = stashShas(r);
  const rp = new GitProcess({ cwd: r.root });
  procs.push(rp);
  const real = new StashProvider(rp);
  const part = await real.subset(sha, ["b.txt"]);
  assert.ok(part.ok);
  const { stashes } = provider(r, (a) => (a[0] === "stash" && a[1] === "store" ? fail("") : undefined));
  const out = await stashes.replace(sha, part.sha);
  assert.equal(out.ok, false);
  assert.match(out.stderr, new RegExp(`Couldn't put the stash back\\..*The files left in the stash are in commit ${part.sha}: \`git stash store ${part.sha}\` brings them back\\.$`));
});

test("a push git refuses with something to stash is a failure, not a blocker", async () => {
  const r = base("push-fails");
  r.write("a.txt", "work\n");
  const { stashes } = provider(r, (a) => (a[0] === "stash" && a[1] === "push" ? fail("error: could not write index") : undefined));
  const out = await stashes.save({ message: "try" });
  assert.deepEqual(out, { ok: false, created: false, stderr: "error: could not write index" });
  assert.equal(r.read("a.txt"), "work\n", "the work is where it was");
  assert.deepEqual(stashShas(r), []);
});

test("a diff git can't run counts as nothing changed, never as junk to stash", async () => {
  const r = base("count-fails");
  const { stashes, ran } = provider(r, (a) => (a[0] === "diff" || a[0] === "ls-files" ? fail("fatal: bad") : undefined));
  const out = await stashes.save({ signal });
  assert.equal(out.ok, true);
  assert.equal(out.created, false);
  assert.equal(out.blocker, "cleanTree");
  assert.ok(ran.some((a) => a[0] === "stash" && a[1] === "push"), "the push itself still ran");
  assert.deepEqual(stashShas(r), []);
});

test("staged-only with a path is refused, and NOTHING in the repository changes — staged, unstaged or untracked", async () => {
  // `git stash push --staged -- <path>` ignores the pathspec: every staged
  // change goes, and files outside it lose their working copy (exit 0).
  const r = base("staged-paths");
  r.write("a.txt", "a staged\n");
  r.write("b.txt", "b staged\n");
  r.git("add", "a.txt", "b.txt");
  r.write("b.txt", "b staged, then edited\n"); // MM: the working copy git would throw away
  r.write("new.txt", "untracked\n");
  const status = r.git("status", "--porcelain=v1", "-uall");
  const index = r.git("ls-files", "-s");
  const { stashes, ran } = provider(r);
  const out = await stashes.save({ stagedOnly: true, paths: ["a.txt"], includeUntracked: true, message: "x" });
  assert.equal(out.ok, false);
  assert.equal(out.created, false);
  assert.match(out.stderr, /Stashing the staged changes of specific files is not supported by git/);
  assert.deepEqual(ran, [], "git never ran");
  assert.equal(r.git("status", "--porcelain=v1", "-uall"), status);
  assert.equal(r.git("ls-files", "-s"), index);
  assert.equal(r.read("b.txt"), "b staged, then edited\n");
  assert.equal(r.git("show", ":b.txt"), "b staged\n");
  assert.deepEqual(stashShas(r), []);
});

test("staged-only with only empty paths is the whole staged section, and stashes just that", async () => {
  const r = base("staged-empty-paths");
  r.write("a.txt", "a staged\n");
  r.git("add", "a.txt");
  r.write("b.txt", "b unstaged\n");
  const { stashes } = provider(r);
  const out = await stashes.save({ stagedOnly: true, paths: [""], keepIndex: false });
  assert.equal(out.created, true);
  assert.equal(r.read("a.txt"), "a\n", "the staged change went into the stash");
  assert.equal(r.read("b.txt"), "b unstaged\n", "the unstaged one stayed");
});

test("branch from a stash refuses a name that is taken or unusable before git runs", async () => {
  const r = base("branch-names");
  r.write("a.txt", "x\n");
  r.git("stash", "push", "-q");
  r.git("branch", "taken");
  const [sha] = stashShas(r);
  const { stashes, ran } = provider(r);
  assert.deepEqual(await stashes.branch(sha, "taken"), { ok: false, stderr: "A branch named “taken” already exists." });
  assert.deepEqual(await stashes.branch(sha, "-D"), { ok: false, stderr: "“-D” is not a branch name git can use." });
  assert.deepEqual(await stashes.branch(sha, "bad..name"), { ok: false, stderr: "“bad..name” is not a branch name git can use." });
  assert.equal(ran.some((a) => a[0] === "stash"), false, "git stash never ran");
  assert.deepEqual(stashShas(r), [sha]);
});

test("branch from a stash by sha: made at its base, applied, and the stash dropped", async () => {
  const r = base("branch-ok");
  r.write("a.txt", "stashed\n");
  r.git("stash", "push", "-q");
  const [sha] = stashShas(r);
  const { stashes } = provider(r);
  const out = await stashes.branch(sha, "from-stash", { signal });
  assert.equal(out.ok, true, out.stderr);
  assert.equal(r.git("symbolic-ref", "--short", "HEAD").trim(), "from-stash");
  assert.equal(r.read("a.txt"), "stashed\n");
  assert.deepEqual(stashShas(r), []);
});
