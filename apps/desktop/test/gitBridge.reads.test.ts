import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, bareRemote, type BridgeRepo } from "./gitBridgeFixture";
import { removeTempRepo } from "./tmpRepo";

// The bridge's READ channels — what the Code browser, Compare, the ref pickers,
// the sync widget and Settings show. Each is checked against a real repository
// for the facts it reports, and against a provider that throws for the promise
// every one of them makes: a read that fails answers empty, it never rejects
// into the renderer.

let r: BridgeRepo | undefined;
afterEach(() => {
  r?.cleanup();
  r = undefined;
});

function repo(prefix = "reads"): BridgeRepo {
  r = initRepo(prefix);
  return r;
}

// ── refs / HEAD ─────────────────────────────────────────────────────────────

test("the ref list carries each ref's subject, date, object kind and upstream", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const first = t.commitAll("first commit");
  t.git("tag", "-a", "v1", "-m", "release one");
  t.git("tag", "light");
  const bare = bareRemote(t);
  void bare;
  t.git("push", "-q", "-u", "origin", "main");

  const refs = await t.bridge.refsList();
  const main = refs.find((x) => x.fullName === "refs/heads/main");
  assert.ok(main, "the local branch is listed");
  assert.equal(main.sha, first);
  assert.equal(main.isCurrent, true);
  assert.equal(main.subject, "first commit");
  assert.ok(main.date && main.date > 0, "a date to sort by");
  assert.match(main.upstream ?? "", /origin\/main/);

  const annotated = refs.find((x) => x.fullName === "refs/tags/v1");
  const lightweight = refs.find((x) => x.fullName === "refs/tags/light");
  assert.equal(annotated?.objectType, "tag", "an annotated tag is its own object");
  assert.equal(lightweight?.objectType, "commit", "a lightweight tag points straight at the commit");
  assert.ok(refs.some((x) => x.type === "remote" && x.fullName === "refs/remotes/origin/main"));
});

test("a ref listing that fails answers an empty list instead of rejecting", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  t.ctx.refs.listRefs = async () => {
    throw new Error("packed-refs is corrupt");
  };
  assert.deepEqual(await t.bridge.refsList(), []);
});

test("which branches contain a commit, and an empty answer when git cannot say", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const first = t.commitAll("first");
  t.git("branch", "topic");
  t.write("a.txt", "two\n");
  const second = t.commitAll("second");

  const both = await t.bridge.refsContains(first);
  assert.deepEqual([...both.branches].sort(), ["main", "topic"]);
  const onlyMain = await t.bridge.refsContains(second);
  assert.deepEqual(onlyMain.branches, ["main"]);

  t.ctx.refs.containingBranches = async () => {
    throw new Error("boom");
  };
  assert.deepEqual(await t.bridge.refsContains(first), { branches: [], refs: [], truncated: false });
});

test("HEAD reads as the plain branch name, as a detached sha, and as nothing when unreadable", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const sha = t.commitAll("first");
  assert.deepEqual(await t.bridge.head(), { detached: false, branch: "main", sha });

  t.git("checkout", "-q", "--detach");
  assert.deepEqual(await t.bridge.head(), { detached: true, sha });

  t.ctx.refs.getHead = async () => {
    throw new Error("HEAD is corrupt");
  };
  assert.equal(await t.bridge.head(), undefined);
});

// ── graph ───────────────────────────────────────────────────────────────────

// In a freshly `git init`ed repository the graph's walk used to pass a literal
// `HEAD` to `git log`, which has no commit to resolve — git exited 128
// ("ambiguous argument 'HEAD'") and graph:load REJECTED. The renderer then
// painted "Couldn't load history" + Retry over a repository that simply had no
// commits yet, instead of its crafted "No commits yet" tile
// (graphMount.renderEmpty), which it only shows for an empty page.
test("an unborn repository loads an empty graph with no head, rather than failing", async () => {
  const t = repo();
  const page = await t.bridge.graphLoad({ skip: 0 });
  assert.deepEqual(page.rows, []);
  assert.equal(page.head, "", "no commit to be 'you are here'");
  assert.equal(page.hasMore, false);
});

test("a ref listing that throws still loads the history, with HEAD found from the commit", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const sha = t.commitAll("first");
  t.ctx.refs.listRefs = async () => {
    throw new Error("for-each-ref failed");
  };
  const page = await t.bridge.graphLoad({ skip: 0 });
  assert.equal(page.rows.length, 1, "the commit is still drawn");
  assert.equal(page.head, sha, "HEAD comes from the commit when no branch says so");
});

test("forgetting a tab's graph makes its next page a fresh load from the top", async () => {
  const t = repo();
  for (let i = 0; i < 3; i++) {
    t.write("a.txt", `v${i}\n`);
    t.commitAll(`c${i}`);
  }
  const first = await t.bridge.graphLoad({ skip: 0, maxCount: 2 });
  assert.equal(first.rows.length, 2);
  assert.equal(first.hasMore, true);
  const tip = first.rows[0].sha;

  t.bridge.forgetGraph(t.repo);
  // A page asked for past a forgotten accumulator is not appended to nothing:
  // it restarts at the top, so the renderer never draws a gapped history.
  const after = await t.bridge.graphLoad({ skip: 2, maxCount: 2 });
  assert.equal(after.rows[0].sha, tip);
  assert.equal(after.nextSkip, 2);
});

// ── commit details ──────────────────────────────────────────────────────────

test("details of a revision that names no commit are absent", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  // An empty range walks nothing: there is no commit to describe.
  assert.equal(await t.bridge.commitDetails("HEAD..HEAD"), undefined);
});

test("a stash made with -u lists its new files, which the first-parent diff leaves out", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  t.write("a.txt", "edited\n");
  t.write("brand-new.txt", "new file\n");
  t.git("stash", "push", "-u", "-m", "with new files");
  const sha = t.git("rev-parse", "stash@{0}").trim();

  const d = await t.bridge.commitDetails(sha);
  assert.ok(d);
  const paths = d.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "brand-new.txt"]);
  assert.equal(d.files.find((f) => f.path === "brand-new.txt")?.status, "A");

  // And the diff of that new file reads from the stash's third parent.
  const diff = await t.bridge.fileDiff({ path: "brand-new.txt", sha });
  assert.equal(diff?.rightText, "new file\n");
});

test("commit details whose file list cannot be read still describe the commit", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const sha = t.commitAll("described");
  t.ctx.commitDetails.getCommitFiles = async () => {
    throw new Error("diff failed");
  };
  const d = await t.bridge.commitDetails(sha);
  assert.equal(d?.subject, "described");
  assert.deepEqual(d?.files, []);
  assert.equal(d?.hasRemote, false);
});

test("row stats count each commit's files and lines in one read", async () => {
  const t = repo();
  t.write("a.txt", "one\ntwo\n");
  const first = t.commitAll("first");
  t.write("a.txt", "one\nTWO\nthree\n");
  t.write("b.txt", "b\n");
  const second = t.commitAll("second");
  const stats = await t.bridge.rowStats([first, second]);
  const s2 = stats.find((s) => s.sha === second);
  assert.ok(s2, JSON.stringify(stats));
  assert.equal(s2.files, 2);
  assert.equal(s2.additions, 3);
  assert.equal(s2.deletions, 1);
});

test("blame answers per-line authorship, and nothing for a file git cannot blame", async () => {
  const t = repo();
  t.write("a.txt", "one\ntwo\n");
  const sha = t.commitAll("first");
  const blame = (await t.bridge.blameFile("a.txt")) as Array<{ sha?: string; commit?: { sha?: string } }> | { lines?: unknown[] };
  assert.ok(blame, "a tracked file has blame");
  assert.ok(JSON.stringify(blame).includes(sha), "the lines are attributed to the commit that wrote them");
  assert.equal(await t.bridge.blameFile("not-there.txt"), undefined);
});

// ── compare ─────────────────────────────────────────────────────────────────

function forked(t: BridgeRepo): { base: string } {
  t.write("keep.txt", "keep\n");
  t.write("old-name.txt", "line1\nline2\nline3\nline4\nline5\nline6\n");
  const base = t.commitAll("base");
  t.git("checkout", "-q", "-b", "topic");
  t.git("mv", "old-name.txt", "new-name.txt");
  t.write("new-name.txt", "line1\nline2\nline3\nline4\nline5\nline6 changed\n");
  t.commitAll("rename it\n\nbecause the name was wrong");
  t.write("added.txt", "added\n");
  t.commitAll("add a file");
  t.git("checkout", "-q", "main");
  t.write("keep.txt", "main moved\n");
  t.commitAll("main moves on");
  return { base };
}

test("compare counts ahead and behind, keeps each commit's body, and pairs a rename with its old name", async () => {
  const t = repo();
  forked(t);
  const c = await t.bridge.compareRefs({ base: "main", head: "topic" });
  assert.ok(c);
  assert.equal(c.ahead, 2);
  assert.equal(c.behind, 1);
  assert.equal(c.commitsTruncated, false);
  assert.deepEqual(c.commits.map((x) => x.subject), ["add a file", "rename it"]);
  assert.match(c.commits[1].body ?? "", /because the name was wrong/);
  assert.equal(c.commits[0].isMerge, false);
  // Three-dot: only what topic introduced — main's own edit to keep.txt is not in it.
  const rename = c.files.find((f) => f.status === "R");
  assert.equal(rename?.path, "new-name.txt");
  assert.equal(rename?.oldPath, "old-name.txt");
  assert.equal(c.files.some((f) => f.path === "keep.txt"), false);

  // Two-dot: the literal difference between the tips, main's edit included.
  const direct = await t.bridge.compareRefs({ base: "main", head: "topic", mode: "two-dot" });
  assert.ok(direct?.files.some((f) => f.path === "keep.txt"));
});

test("compare refuses an option-shaped ref instead of handing it to git", async () => {
  const t = repo();
  forked(t);
  assert.equal(await t.bridge.compareRefs({ base: "--output=/tmp/x", head: "topic" }), undefined);
  assert.equal(await t.bridge.compareFileDiff({ base: "main", head: "-p", path: "a" }), undefined);
});

test("a compared rename diffs against the old name at the merge-base", async () => {
  const t = repo();
  const { base } = forked(t);
  const d = await t.bridge.compareFileDiff({ base: "main", head: "topic", path: "new-name.txt", leftPath: "old-name.txt" });
  assert.ok(d);
  assert.match(d.leftText, /line6\n$/, "the left side is the old file, not an empty 'new file'");
  assert.match(d.rightText, /line6 changed/);
  assert.equal(d.leftLabel, "main (merge-base) old-name.txt");
  assert.equal(d.rightLabel, "topic new-name.txt");

  // Two-dot compares the tips; a side named by sha is labelled by its short sha.
  const tipSha = t.git("rev-parse", "topic").trim();
  const two = await t.bridge.compareFileDiff({ base, head: tipSha, path: "added.txt", mode: "two-dot" });
  assert.equal(two?.leftLabel, `${base.slice(0, 7)} added.txt`);
  assert.equal(two?.rightLabel, `${tipSha.slice(0, 7)} added.txt`);
  assert.equal(two?.leftText, "", "absent at the base");
  assert.equal(two?.rightText, "added\n");
});

// ── the code browser ────────────────────────────────────────────────────────

test("the head commit carries the whole message and, when asked, the commit count", async () => {
  const t = repo();
  assert.equal(await t.bridge.headCommit(), undefined, "an unborn HEAD has no tip");
  t.write("a.txt", "one\n");
  t.commitAll("first");
  t.write("a.txt", "two\n");
  t.git("add", "-A");
  t.git("commit", "-q", "-m", "subject line", "-m", "body text", "-m", "Signed-off-by: Dev <dev@example.com>");
  const sha = t.git("rev-parse", "HEAD").trim();

  const plain = await t.bridge.headCommit();
  assert.equal(plain?.sha, sha);
  assert.equal(plain?.shortSha, t.git("rev-parse", "--short", "HEAD").trim());
  assert.equal(plain?.subject, "subject line");
  assert.equal(plain?.message, "subject line\n\nbody text\n\nSigned-off-by: Dev <dev@example.com>");
  assert.equal(plain?.author, "Dev");
  assert.equal(plain?.authorEmail, "dev@example.com");
  assert.ok((plain?.date ?? 0) > 0);
  assert.equal("total" in (plain ?? {}), false, "the count is opt-in");

  const counted = await t.bridge.headCommit({ count: true });
  assert.equal(counted?.total, 2);
});

test("the head commit is absent, not a throw, when git cannot run", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  t.ctx.process.run = async () => {
    throw new Error("spawn failed");
  };
  assert.equal(await t.bridge.headCommit(), undefined);
  assert.deepEqual(await t.bridge.treeList({ path: "" }), []);
  assert.equal(await t.bridge.fileText({ path: "a.txt" }), undefined);
});

test("the tree lists one level, folders first then by name, with blob sizes and no submodules", async () => {
  const t = repo();
  t.write("zeta.txt", "12345");
  t.write("alpha.txt", "1");
  t.write("src/main.ts", "export {};\n");
  t.write("src/deep/x.ts", "x\n");
  t.write("docs/readme.md", "# docs\n");
  const sha = t.commitAll("tree");
  // A gitlink (submodule) entry: listed by git as type "commit", never a file.
  t.git("update-index", "--add", "--cacheinfo", `160000,${sha},vendored`);
  t.git("commit", "-q", "-m", "gitlink");

  const root = await t.bridge.treeList({ path: "" });
  assert.deepEqual(
    root.map((e) => [e.name, e.type]),
    [
      ["docs", "tree"],
      ["src", "tree"],
      ["alpha.txt", "blob"],
      ["zeta.txt", "blob"],
    ],
  );
  assert.equal(root.find((e) => e.name === "zeta.txt")?.size, 5);
  assert.equal("size" in (root.find((e) => e.name === "src") ?? {}), false, "a folder has no size");

  const src = await t.bridge.treeList({ path: "/src/" });
  assert.deepEqual(src.map((e) => e.path), ["src/deep", "src/main.ts"]);
  assert.deepEqual(await t.bridge.treeList({ path: "no-such-dir" }), []);
});

test("the file viewer reads text, and refuses folders, binaries and oversized blobs", async () => {
  const t = repo();
  t.write("docs/readme.md", "# hello\n");
  t.write("image.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  t.write("huge.txt", "x".repeat(600 * 1024));
  t.commitAll("files");

  assert.deepEqual(await t.bridge.fileText({ path: "/docs/readme.md" }), { path: "docs/readme.md", text: "# hello\n" });
  assert.equal(await t.bridge.fileText({ path: "docs" }), undefined, "a folder is not a file");
  assert.equal(await t.bridge.fileText({ path: "missing.txt" }), undefined, "not tracked at HEAD");
  assert.equal(await t.bridge.fileText({ path: "/" }), undefined, "no path at all");
  assert.deepEqual(await t.bridge.fileText({ path: "image.bin" }), { path: "image.bin", text: "", binary: true });
  assert.deepEqual(await t.bridge.fileText({ path: "huge.txt" }), { path: "huge.txt", text: "", truncated: true });
});

// ── settings ────────────────────────────────────────────────────────────────

test("SSH keys are the .pub files in ~/.ssh, sorted, with type and comment", async () => {
  const home = mkdtempSync(join(tmpdir(), "gitstudio-home-"));
  const saved = process.env.HOME;
  try {
    process.env.HOME = home;
    const t = repo();
    assert.deepEqual(await t.bridge.sshKeys(), [], "no .ssh folder is no keys, not an error");

    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_rsa.pub"), "ssh-rsa AAAAB3Nza me@laptop work\n");
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAAC3Nz dev@example.com\n");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY — never listed\n");
    writeFileSync(join(home, ".ssh", "config"), "Host *\n");
    // A directory named like a key cannot be read as one: skipped, not fatal.
    mkdirSync(join(home, ".ssh", "odd.pub"));

    assert.deepEqual(await t.bridge.sshKeys(), [
      { file: "id_ed25519.pub", type: "ssh-ed25519", comment: "dev@example.com" },
      { file: "id_rsa.pub", type: "ssh-rsa", comment: "me@laptop work" },
    ]);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("reading the identity when git cannot run answers blanks rather than failing Settings", async () => {
  const t = repo();
  t.ctx.process.run = async () => {
    throw new Error("spawn failed");
  };
  assert.deepEqual(await t.bridge.gitIdentity(), { name: "", email: "" });
});

test("an identity whose name starts with a dash is refused before git reads it as an option", async () => {
  const t = repo();
  const r = await t.bridge.setGitIdentity({ name: "--global", email: "a@b.c" });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.match(r.message ?? "", /can't start with/);
  t.ctx.process.run = async () => {
    throw new Error("spawn failed");
  };
  const thrown = await t.bridge.setGitIdentity({ name: "Dev", email: "dev@example.com" });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.expected, undefined, "git failing to run is reported, not hidden");
  assert.match(thrown.message ?? "", /spawn failed/);
});

// ── sync widget ─────────────────────────────────────────────────────────────

test("sync status names the branch and counts against its upstream", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  assert.deepEqual(await t.bridge.syncStatus(), { branch: "main", ahead: 0, behind: 0, noUpstream: true });

  bareRemote(t);
  t.git("push", "-q", "-u", "origin", "main");
  t.write("a.txt", "two\n");
  t.commitAll("second");
  const s = await t.bridge.syncStatus();
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  assert.equal(s.noUpstream, false);

  // An unreadable HEAD still answers the counts, just without a name.
  t.ctx.refs.getHead = async () => {
    throw new Error("HEAD unreadable");
  };
  const nameless = await t.bridge.syncStatus();
  assert.equal(nameless.branch, undefined);
  assert.equal(nameless.ahead, 1);
});

test("fetching from a local remote brings its new branch in", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  const bare = bareRemote(t);
  t.git("push", "-q", "origin", "main:elsewhere");
  // The remote has a branch the local repo has not fetched yet.
  t.git("update-ref", "-d", "refs/remotes/origin/elsewhere");
  const r0 = await t.bridge.syncFetch();
  assert.equal(r0.ok, true, r0.message);
  assert.equal(t.gitTry("rev-parse", "--verify", "refs/remotes/origin/elsewhere").code, 0);
  void bare;
});

// ── lists ───────────────────────────────────────────────────────────────────

test("a ref's recent history is capped between 1 and 100 and empty for an unknown ref", async () => {
  const t = repo();
  for (let i = 0; i < 3; i++) {
    t.write("a.txt", `v${i}\n`);
    t.commitAll(`c${i}`);
  }
  const one = await t.bridge.refLog({ ref: "main", maxCount: 0 });
  assert.deepEqual(one.map((c) => c.subject), ["c2"], "a count below 1 still shows the tip");
  const all = await t.bridge.refLog({ ref: "main", maxCount: 1000 });
  assert.deepEqual(all.map((c) => c.subject), ["c2", "c1", "c0"]);
  assert.equal(all[0].shortSha.length, 7);
  assert.deepEqual(await t.bridge.refLog({ ref: "no-such-branch" }), []);
  assert.deepEqual(await t.bridge.refLog({ ref: "--all" }), [], "an option-shaped ref is refused");
});

test("the stash list carries each stash's sha and message, and is empty when unreadable", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  t.write("a.txt", "wip\n");
  t.git("stash", "push", "-m", "my wip");
  const list = await t.bridge.stashList();
  assert.equal(list.length, 1);
  assert.equal(list[0].sha, t.git("rev-parse", "stash@{0}").trim());
  assert.match(list[0].message, /my wip/);
  assert.equal(list[0].ref, "stash@{0}");

  t.ctx.stashes.list = async () => {
    throw new Error("reflog unreadable");
  };
  assert.deepEqual(await t.bridge.stashList(), []);
});

test("the worktree list marks the main and current worktrees and one whose folder is gone", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("first");
  const wtParent = mkdtempSync(join(tmpdir(), "gitstudio-wt-"));
  t.alsoRemove.push(wtParent);
  const wt = join(wtParent, "linked");
  const gone = join(wtParent, "gone");
  t.git("worktree", "add", "-q", "-b", "linked", wt);
  t.git("worktree", "add", "-q", "-b", "gone", gone);
  removeTempRepo(gone);

  const list = await t.bridge.worktreeList();
  assert.equal(list.length, 3);
  assert.equal(list[0].main, true);
  assert.equal(list[0].current, true);
  const linked = list.find((w) => w.branch === "linked");
  assert.equal(linked?.main, false);
  assert.equal(linked?.current, false);
  assert.equal(linked?.missing, false);
  const missing = list.find((w) => w.branch === "gone");
  assert.equal(missing?.missing, true);
  assert.equal(missing?.openInTab, false, "a gone folder is in no tab");

  t.ctx.worktrees.list = async () => {
    throw new Error("worktree list failed");
  };
  assert.deepEqual(await t.bridge.worktreeList(), []);
});
