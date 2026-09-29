import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { createGitToolHost } from "../src/GitToolHost";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// The rest of the git-tool surface an agent (MCP server / desktop assistant)
// drives: every tool reports the repository's true state, refuses arguments
// git could read as options, and — when git says no — hands back a reason the
// agent can act on rather than a bare failure.

const repos: Repo[] = [];
after(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

function repo(name: string): Repo {
  const r = makeRepo(`toolhost-${name}`);
  repos.push(r);
  return r;
}

/** A repo with two commits: a.txt created, then edited and b.txt added. */
function twoCommits(name: string): { r: Repo; first: string; second: string } {
  const r = repo(name);
  r.write("a.txt", "one\n");
  const first = r.commitAll("feat: first");
  r.write("a.txt", "one\ntwo\n");
  r.write("b.txt", "bee\n");
  const second = r.commitAll("fix: second\n\nthe body line");
  return { r, first, second };
}

test("outside a repository the read tools answer empty rather than throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-toolhost-norepo-"));
  const ctx = new GitContext({ root: dir });
  try {
    const host = createGitToolHost(ctx);
    assert.deepEqual(await host.status(), []);
    assert.deepEqual(await host.log({}), []);
    assert.deepEqual(await host.branches(), []);
    assert.deepEqual(await host.searchCommits("anything"), []);
    assert.equal(await host.show("HEAD"), undefined);
    assert.equal(await host.diff({}), "");
    assert.deepEqual(await host.head(), { detached: true, sha: "" });
    assert.deepEqual(await host.stashes(), []);
    const cmp = await host.compare("main", "HEAD");
    assert.deepEqual(cmp, { ahead: 0, behind: 0, commits: [], files: [] });
    const reset = await host.reset("hard", "HEAD");
    assert.equal(reset.ok, false);
    assert.ok(reset.message && reset.message.length > 0, "the refusal carries git's reason");
  } finally {
    ctx.dispose();
    removeTempRepo(dir);
  }
});

test("git_log follows a ref and a path, and an option-like ref or path is ignored rather than passed", async () => {
  const { r, first, second } = twoCommits("log");
  const host = createGitToolHost(r.ctx());

  const all = await host.log({ limit: 10 });
  assert.deepEqual(all.map((c) => c.sha), [second, first]);
  assert.equal(all[0].shortSha, second.slice(0, 7));
  assert.equal(all[0].author, "Dev");

  const onlyB = await host.log({ path: "b.txt" });
  assert.deepEqual(onlyB.map((c) => c.subject), ["fix: second"]);

  const fromFirst = await host.log({ ref: first });
  assert.deepEqual(fromFirst.map((c) => c.sha), [first]);

  const limited = await host.log({ limit: 1 });
  assert.equal(limited.length, 1);

  // "--all" as a ref is refused as unsafe and HEAD is walked instead.
  const optionRef = await host.log({ ref: "--all", path: "-p" });
  assert.deepEqual(optionRef.map((c) => c.sha), [second, first]);

  // A ref git cannot resolve yields nothing, not an exception.
  assert.deepEqual(await host.log({ ref: "no-such-branch" }), []);
});

test("git_show returns the commit's message, parents and changed files", async () => {
  const { r, first, second } = twoCommits("show");
  const host = createGitToolHost(r.ctx());

  const d = await host.show(second);
  assert.ok(d);
  assert.equal(d.sha, second);
  assert.equal(d.shortSha, second.slice(0, 7));
  assert.equal(d.subject, "fix: second");
  assert.match(d.body ?? "", /the body line/);
  assert.deepEqual(d.parents, [first]);
  const files = d.files.map((f) => `${f.status}:${f.path}`).sort();
  assert.deepEqual(files, ["A:b.txt", "M:a.txt"]);
  assert.ok(d.files.every((f) => f.staged === true));

  // The root commit has no parent; its file still shows as added.
  const root = await host.show(first);
  assert.ok(root);
  assert.deepEqual(root.parents, []);
  assert.deepEqual(root.files.map((f) => f.path), ["a.txt"]);

  assert.equal(await host.show("--all"), undefined, "an option-like sha is refused");
  assert.equal(await host.show("0000000000000000000000000000000000000000"), undefined, "an unknown commit is undefined");
});

test("git_diff compares two revisions, scopes to a path, and refuses option-like revisions", async () => {
  const { r, first, second } = twoCommits("diff");
  const host = createGitToolHost(r.ctx());

  const range = await host.diff({ base: first, head: second });
  assert.match(range, /\+two/);
  assert.match(range, /\+bee/);

  const scoped = await host.diff({ base: first, head: second, path: "a.txt" });
  assert.match(scoped, /\+two/);
  assert.doesNotMatch(scoped, /bee/);

  assert.equal(await host.diff({ base: "--output=x", head: second }), "");
  assert.equal(await host.diff({ base: first, head: "-R" }), "");

  // Unstaged by default: a working-tree edit shows; the staged diff is empty.
  r.write("a.txt", "one\ntwo\nthree\n");
  assert.match(await host.diff({}), /\+three/);
  assert.equal(await host.diff({ staged: true }), "");
  // An option-like path is dropped, not passed to git.
  assert.match(await host.diff({ path: "--cached" }), /\+three/);
});

test("git_branches reports upstream and how far ahead and behind each branch is", async () => {
  const { r } = twoCommits("branches");
  const bare = mkdtempSync(join(tmpdir(), "gs-toolhost-bare-"));
  try {
    r.git("init", "-q", "--bare", bare);
    r.git("remote", "add", "origin", bare);
    r.git("push", "-q", "-u", "origin", "master");
    // One local commit ahead, and the remote one ahead of us.
    r.write("c.txt", "c\n");
    r.commitAll("local only");
    r.git("update-ref", "refs/remotes/origin/master", r.sha("HEAD~1"));
    r.git("branch", "side", "HEAD~1");
    const other = r.sha("HEAD~1");
    // Make origin/master diverge: a commit on top of the old tip.
    const tree = r.git("rev-parse", "HEAD~1^{tree}").trim();
    const remoteOnly = r.git("commit-tree", tree, "-p", other, "-m", "remote only").trim();
    r.git("update-ref", "refs/remotes/origin/master", remoteOnly);

    const host = createGitToolHost(r.ctx());
    const branches = await host.branches();
    const master = branches.find((b) => b.name === "master");
    const side = branches.find((b) => b.name === "side");
    assert.ok(master && side);
    assert.equal(master.current, true);
    assert.equal(master.upstream, "origin/master");
    assert.equal(master.ahead, 1);
    assert.equal(master.behind, 1);
    assert.equal(master.subject, "local only");
    assert.equal(side.current, false);
    assert.equal(side.upstream, undefined, "no upstream is reported as undefined, not an empty string");
    assert.equal(side.ahead, 0);
    assert.equal(side.behind, 0);
  } finally {
    removeTempRepo(bare);
  }
});

test("git_head reports a detached HEAD by sha, without a branch", async () => {
  const { r, first } = twoCommits("head");
  r.git("checkout", "-q", "--detach", first);
  const host = createGitToolHost(r.ctx());
  const h = await host.head();
  assert.equal(h.detached, true);
  assert.equal(h.sha, first);
  assert.equal(h.branch, undefined);
});

test("git_search_commits matches messages case-insensitively and caps the count", async () => {
  const { r, first, second } = twoCommits("search");
  const host = createGitToolHost(r.ctx());

  const hits = await host.searchCommits("FIX");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sha, second);
  assert.equal(hits[0].shortSha, second.slice(0, 7));
  assert.equal(hits[0].subject, "fix: second");
  assert.equal(hits[0].author, "Dev");
  assert.ok(hits[0].date > 1_000_000_000, "the author date is a unix timestamp");

  const both = await host.searchCommits(": ");
  assert.deepEqual(both.map((c) => c.sha), [second, first]);
  assert.equal((await host.searchCommits(": ", 1)).length, 1);
  assert.deepEqual(await host.searchCommits("nothing matches this"), []);
});

test("git_read_file flags binary content, truncates a huge file, and refuses unsafe input", async () => {
  const r = repo("readfile");
  r.write("bin.dat", Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  r.write("big.txt", "x".repeat(300 * 1024));
  r.write("dir/small.txt", "small\n");
  const first = r.commitAll("files");
  r.write("dir/small.txt", "changed\n");
  r.commitAll("change small");
  const host = createGitToolHost(r.ctx());

  const bin = await host.readFile("bin.dat");
  assert.deepEqual(bin, { path: "bin.dat", text: "", truncated: false, binary: true });

  const big = await host.readFile("big.txt");
  assert.ok(big);
  assert.equal(big.truncated, true);
  assert.equal(big.binary, false);
  assert.equal(big.text.length, 256 * 1024);

  // A leading slash is repo-relative, and an older revision can be read.
  assert.equal((await host.readFile("/dir/small.txt"))?.text, "changed\n");
  const old = await host.readFile("dir/small.txt", first);
  assert.equal(old?.text, "small\n");
  assert.equal(old?.path, "dir/small.txt");

  assert.equal(await host.readFile(""), undefined);
  assert.equal(await host.readFile("/"), undefined);
  assert.equal(await host.readFile("a\nb"), undefined);
  assert.equal(await host.readFile("dir/small.txt", "--output=x"), undefined);
});

test("git_compare lists the commits and files head adds over base, and how far behind it is", async () => {
  const r = repo("compare");
  r.write("a.txt", "one\n");
  r.write("old name.txt", "content that is long enough to be detected as a rename\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "feature");
  r.git("mv", "old name.txt", "new name.txt");
  r.write("é.txt", "accent\n");
  r.commitAll("feature: rename and add");
  const featTip = r.sha("HEAD");
  r.git("checkout", "-q", "master");
  r.write("a.txt", "one\nmaster\n");
  r.commitAll("master moves on");
  const host = createGitToolHost(r.ctx());

  const cmp = await host.compare("master", "feature");
  assert.ok(cmp);
  assert.equal(cmp.ahead, 1);
  assert.equal(cmp.behind, 1);
  assert.deepEqual(cmp.commits.map((c) => c.sha), [featTip]);
  const files = cmp.files.map((f) => `${f.status}:${f.path}`).sort();
  // The rename reports its destination; the non-ASCII path arrives unquoted.
  assert.deepEqual(files, ["A:é.txt", "R:new name.txt"]);

  assert.equal(await host.compare("-x", "feature"), undefined);
  assert.equal(await host.compare("master", "--all"), undefined);
});

test("git_status splits a file staged and edited again into two rows, and a staged rename into one", async () => {
  const r = repo("status");
  r.write("a.txt", "one\n");
  r.write("move-me.txt", "a file with enough content to be seen as a rename\n");
  r.commitAll("base");
  r.write("a.txt", "one\ntwo\n");
  r.git("add", "a.txt");
  r.write("a.txt", "one\ntwo\nthree\n");
  r.git("mv", "move-me.txt", "moved.txt");
  const host = createGitToolHost(r.ctx());
  const rows = (await host.status()).map((f) => `${f.staged ? "S" : "W"}${f.status}:${f.path}`).sort();
  assert.deepEqual(rows, ["SM:a.txt", "SR:moved.txt", "WM:a.txt"]);
});

test("git_stage and git_unstage take 'all' or paths, and refuse option-like paths", async () => {
  const { r } = twoCommits("stage");
  const host = createGitToolHost(r.ctx());
  r.write("a.txt", "changed\n");
  r.write("new.txt", "new\n");

  assert.deepEqual(await host.stage(["-A"]), {
    ok: false,
    message: "Argument rejected for safety (starts with '-' or contains a control character).",
  });
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "", "nothing was staged");

  assert.deepEqual(await host.stage("all"), { ok: true });
  assert.deepEqual(r.git("diff", "--cached", "--name-only").trim().split("\n").sort(), ["a.txt", "new.txt"]);

  assert.equal((await host.unstage(["--hard"])).ok, false);
  assert.deepEqual(await host.unstage(["new.txt"]), { ok: true });
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "a.txt");

  assert.deepEqual(await host.unstage("all"), { ok: true });
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "");

  const missing = await host.stage(["does-not-exist.txt"]);
  assert.equal(missing.ok, false);
  assert.match(missing.message ?? "", /did not match/);
});

test("git_commit names the missing step when nothing is staged, and refuses an empty message", async () => {
  const { r, second } = twoCommits("commit");
  const host = createGitToolHost(r.ctx());

  assert.deepEqual(await host.commit("   "), { ok: false, message: "A commit message is required." });

  // A clean tree: nothing to do, and nothing to stage either.
  assert.deepEqual(await host.commit("msg"), { ok: false, message: "Nothing to commit — the working tree is clean." });

  // Only unstaged edits: the agent is told to stage first.
  r.write("a.txt", "edited\n");
  const unstaged = await host.commit("msg");
  assert.equal(unstaged.ok, false);
  assert.match(unstaged.message ?? "", /^Nothing is staged — stage the changes/);
  assert.match(unstaged.message ?? "", /Use git_stage first\.$/);

  // Only a new, untracked file: the same advice, in the untracked words.
  r.git("checkout", "--", "a.txt");
  r.write("fresh.txt", "fresh\n");
  const untracked = await host.commit("msg");
  assert.match(untracked.message ?? "", /new files git isn't tracking yet.*Use git_stage first\./);
  assert.equal(r.sha("HEAD"), second, "no commit was made by any refusal");

  // An amend may leave the message empty: git keeps the commit's own message.
  r.git("add", "fresh.txt");
  const amended = await host.commit("", true);
  assert.equal(amended.ok, true, amended.message);
  assert.notEqual(r.sha("HEAD"), second, "HEAD was rewritten");
  assert.equal(r.sha("HEAD~1"), r.sha(`${second}~1`), "amended in place, not added on top");
  assert.equal(r.git("log", "-1", "--format=%B").trim(), "fix: second\n\nthe body line");
  assert.equal(r.git("show", "HEAD:fresh.txt"), "fresh\n");
});

test("git_create_branch without checkout creates the branch and stays put; unsafe or taken names are refused", async () => {
  const { r } = twoCommits("branch");
  const host = createGitToolHost(r.ctx());

  assert.deepEqual(await host.createBranch("topic"), { ok: true });
  assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/master", "HEAD did not move");
  assert.equal(r.sha("topic"), r.sha("master"));

  const taken = await host.createBranch("topic");
  assert.equal(taken.ok, false);
  assert.match(taken.message ?? "", /already exists/);

  assert.equal((await host.createBranch("-D")).ok, false);
  assert.equal((await host.createBranch("a\nb", true)).ok, false);
});

test("git_checkout names the uncommitted files in the way, and passes git's reason for an unknown ref", async () => {
  const r = repo("checkout");
  r.write("f.txt", "base\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "other");
  r.write("f.txt", "other\n");
  r.commitAll("other");
  r.git("checkout", "-q", "master");
  r.write("f.txt", "my uncommitted work\n");
  const host = createGitToolHost(r.ctx());

  const blocked = await host.checkout("other");
  assert.equal(blocked.ok, false);
  assert.match(blocked.message ?? "", /Your uncommitted changes to .*f\.txt.* are in the way/);
  assert.equal(r.read("f.txt"), "my uncommitted work\n", "the work is untouched");
  assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/master");

  const unknown = await host.checkout("no-such-ref");
  assert.equal(unknown.ok, false);
  assert.match(unknown.message ?? "", /no-such-ref/);
});

test("git_stash_save parks changes, refuses a message with a newline, and fails loudly when there is nothing to stash", async () => {
  const { r } = twoCommits("stash");
  const host = createGitToolHost(r.ctx());

  assert.deepEqual(await host.stashSave("line\nbreak"), {
    ok: false,
    message: "Argument rejected for safety (starts with '-' or contains a control character).",
  });

  assert.deepEqual(await host.stashSave("nothing"), { ok: false, message: "Nothing to stash — the working tree is clean." });
  assert.deepEqual(await host.stashes(), []);

  // Only an untracked file: not stashed unless asked to include untracked.
  r.write("u.txt", "untracked\n");
  const onlyUntracked = await host.stashSave("try");
  assert.equal(onlyUntracked.ok, false);
  assert.match(onlyUntracked.message ?? "", /new files git isn't tracking/);
  assert.deepEqual(await host.stashSave("with untracked", true), { ok: true });
  assert.equal(r.exists("u.txt"), false, "the untracked file was parked");

  r.write("a.txt", "work in progress\n");
  assert.deepEqual(await host.stashSave("wip"), { ok: true });
  assert.equal(r.read("a.txt"), "one\ntwo\n", "the working tree is back to HEAD");
  const stashes = await host.stashes();
  assert.equal(stashes.length, 2);
  assert.equal(stashes[0].ref, "stash@{0}");
  assert.match(stashes[0].message, /wip/);
  assert.match(stashes[1].message, /with untracked/);
  assert.ok(stashes[0].time > 0);
});

test("git_discard restores each file, reports the ones git refused, and refuses option-like paths", async () => {
  const { r } = twoCommits("discard");
  const host = createGitToolHost(r.ctx());
  r.write("a.txt", "scribble\n");
  r.write("b.txt", "scribble\n");

  assert.equal((await host.discard(["a.txt", "--force"])).ok, false);
  assert.equal(r.read("a.txt"), "scribble\n", "an unsafe batch touches nothing");

  assert.deepEqual(await host.discard(["a.txt", "b.txt"]), { ok: true });
  assert.equal(r.read("a.txt"), "one\ntwo\n");
  assert.equal(r.read("b.txt"), "bee\n");

  const partly = await host.discard(["ghost.txt", "a.txt"]);
  assert.equal(partly.ok, false);
  assert.match(partly.message ?? "", /ghost\.txt/);
});

test("git_delete_branch deletes by plain name, refuses unsafe names, and passes git's refusal for an unmerged branch", async () => {
  const { r } = twoCommits("delete");
  r.git("branch", "merged-one");
  r.git("checkout", "-q", "-b", "unmerged");
  r.write("z.txt", "z\n");
  r.commitAll("only here");
  r.git("checkout", "-q", "master");
  const host = createGitToolHost(r.ctx());

  assert.equal((await host.deleteBranch("-D")).ok, false);

  assert.deepEqual(await host.deleteBranch("merged-one"), { ok: true });
  assert.equal(r.git("for-each-ref", "refs/heads/merged-one").trim(), "");

  const refused = await host.deleteBranch("unmerged");
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? "", /not fully merged/);
  assert.notEqual(r.git("for-each-ref", "refs/heads/unmerged").trim(), "", "the branch survives");

  assert.deepEqual(await host.deleteBranch("refs/heads/unmerged", true), { ok: true });
  assert.equal(r.git("for-each-ref", "refs/heads/unmerged").trim(), "");

  const ghost = await host.deleteBranch("ghost");
  assert.equal(ghost.ok, false);
  assert.match(ghost.message ?? "", /ghost/);
});

test("git_reset moves HEAD in each mode, and refuses an option-like ref", async () => {
  const { r, first, second } = twoCommits("reset");
  const host = createGitToolHost(r.ctx());

  assert.equal((await host.reset("hard", "--merge")).ok, false);
  assert.equal(r.sha("HEAD"), second);

  assert.deepEqual(await host.reset("mixed", first), { ok: true });
  assert.equal(r.sha("HEAD"), first);
  assert.equal(r.read("a.txt"), "one\ntwo\n", "--mixed keeps the working tree");
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "", "--mixed empties the index diff");

  assert.deepEqual(await host.reset("hard", second), { ok: true });
  assert.equal(r.sha("HEAD"), second);

  r.write("a.txt", "dirty\n");
  assert.deepEqual(await host.reset("hard", "HEAD"), { ok: true });
  assert.equal(r.read("a.txt"), "one\ntwo\n", "--hard discards the edit");

  const unknown = await host.reset("soft", "no-such-rev");
  assert.equal(unknown.ok, false);
  assert.match(unknown.message ?? "", /no-such-rev|unknown revision|ambiguous argument/);
});

test("a git process that cannot be spawned is reported as a failure, not thrown", async () => {
  const r = repo("nospawn");
  r.write("a.txt", "a\n");
  r.commitAll("base");
  const ctx = new GitContext({ root: r.root, gitPath: join(r.root, "no-such-git-binary") });
  try {
    const host = createGitToolHost(ctx);
    assert.deepEqual(await host.status(), []);
    assert.equal(await host.readFile("a.txt"), undefined);
    const staged = await host.stage("all");
    assert.equal(staged.ok, false);
    assert.ok(staged.message, "a reason is given");
    const co = await host.createBranch("x", true);
    assert.equal(co.ok, false);
  } finally {
    ctx.dispose();
  }
});


test("git_show of a range that selects no commit is undefined, not the wrong commit", async () => {
  const { r } = twoCommits("show-empty");
  const host = createGitToolHost(r.ctx());
  assert.equal(await host.show("HEAD..HEAD"), undefined);
});

test("git_stash_save before the first commit passes git's refusal through", async () => {
  const r = repo("stash-unborn");
  r.write("a.txt", "a\n");
  r.git("add", "a.txt");
  const host = createGitToolHost(r.ctx());
  const res = await host.stashSave("too early");
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /initial commit/);
  assert.equal(r.read("a.txt"), "a\n", "the work is untouched");
});
