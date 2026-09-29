import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRef } from "@gitstudio/host-bridge/git";
import { GitProcess, type GitRunResult } from "../src/GitProcess";
import { RefProvider, headBranchName } from "../src/RefProvider";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// RefProvider against real git: what the sidebar, the graph's chips and the
// status bar read about branches, tags, stashes and HEAD. Each test builds the
// state it describes in a throwaway repository and checks the parsed GitRef /
// RepoHead a host would receive.

const byFull = (refs: GitRef[], fullName: string): GitRef | undefined => refs.find((r) => r.fullName === fullName);

function withRepo(name: string, fn: (r: Repo) => Promise<void>): () => Promise<void> {
  return async () => {
    const r = makeRepo(name);
    try {
      await fn(r);
    } finally {
      r.cleanup();
    }
  };
}

/** A GitProcess stand-in that answers each command from `answer`. */
function stubProc(answer: (args: string[]) => Partial<GitRunResult>): GitProcess {
  return {
    cwd: tmpdir(),
    run: async (args: string[]) => ({ stdout: "", stderr: "", code: 0, ...answer(args) }),
  } as unknown as GitProcess;
}

test(
  "a lightweight tag and an annotated tag are listed as tags, both on the COMMIT they mark",
  withRepo("refs-tags", async (r) => {
    r.write("a.txt", "a\n");
    const c = r.commitAll("first commit");
    r.git("tag", "light");
    r.gitEnv(
      { GIT_COMMITTER_NAME: "Rel Eng", GIT_COMMITTER_EMAIL: "rel@example.com" },
      "tag", "-a", "v1.0", "-m", "release one",
    );
    const refs = await r.ctx().refs.listRefs();

    const light = byFull(refs, "refs/tags/light");
    assert.ok(light, "the lightweight tag is listed");
    assert.equal(light.type, "tag");
    assert.equal(light.name, "light");
    assert.equal(light.sha, c);
    assert.equal(light.objectType, "commit", "a lightweight tag points straight at the commit");
    assert.equal(light.subject, "first commit");
    assert.deepEqual(light.who, { name: "Dev", email: "dev@example.com" }, "no tagger: the commit's author");

    const annotated = byFull(refs, "refs/tags/v1.0");
    assert.ok(annotated, "the annotated tag is listed");
    assert.equal(annotated.type, "tag");
    assert.equal(annotated.sha, c, "peeled to the commit, not the tag object's own sha");
    assert.notEqual(r.git("rev-parse", "refs/tags/v1.0").trim(), c, "(the tag object really is a different object)");
    assert.equal(annotated.objectType, "tag");
    assert.equal(annotated.subject, "release one", "an annotated tag's subject is its own message");
    assert.deepEqual(annotated.who, { name: "Rel Eng", email: "rel@example.com", tagger: true }, "the tagger cut it");
    assert.equal(annotated.isCurrent, false);
    assert.equal(typeof light.date, "number", "a lightweight tag carries its commit's date");
  }),
);

// REF_FORMAT used to read %(committerdate), which is EMPTY for an annotated tag
// (the ref points at a tag object, which has no committer). So every annotated
// tag — i.e. most releases — arrived with no date, and the desktop's tag rows
// and ref detail showed no time for them.
test(
  "an annotated tag carries a date like every other ref",
  withRepo("refs-tagdate", async (r) => {
    r.write("a.txt", "a\n");
    r.commitAll("base");
    r.git("tag", "-a", "v2", "-m", "two");
    const ref = byFull(await r.ctx().refs.listRefs(), "refs/tags/v2");
    assert.ok(ref);
    assert.equal(typeof ref.date, "number");
  }),
);

test(
  "an annotated tag with no tagger line is credited to the author of the commit underneath",
  withRepo("refs-notagger", async (r) => {
    r.write("a.txt", "a\n");
    const c = r.commitAll("tagged commit");
    // Old git (and some importers) wrote tag objects without a tagger.
    const body = `object ${c}\ntype commit\ntag bare\n\nno tagger here\n`;
    const obj = execFileSync("git", ["hash-object", "-t", "tag", "-w", "--literally", "--stdin"], {
      cwd: r.root,
      input: body,
      encoding: "utf8",
    }).trim();
    r.git("update-ref", "refs/tags/bare", obj);

    const ref = byFull(await r.ctx().refs.listRefs(), "refs/tags/bare");
    assert.ok(ref);
    assert.equal(ref.sha, c, "still peeled to the commit");
    assert.equal(ref.objectType, "tag");
    assert.deepEqual(ref.who, { name: "Dev", email: "dev@example.com" }, "the commit's author, not marked as tagger");
  }),
);

test(
  "a branch tracking another reports its ahead/behind counts from git's own track field",
  withRepo("refs-track", async (r) => {
    r.write("a.txt", "a\n");
    r.commitAll("base");
    r.git("branch", "feature");
    r.write("m.txt", "m1\n");
    r.commitAll("main 1");
    r.write("m.txt", "m2\n");
    r.commitAll("main 2");
    r.git("checkout", "-q", "feature");
    r.write("f.txt", "f\n");
    r.commitAll("feature 1");
    r.git("branch", "--set-upstream-to=master");
    r.git("branch", "only-ahead", "feature");
    r.git("branch", "--set-upstream-to=feature", "only-ahead");
    r.git("branch", "only-behind", "master~2");
    r.git("branch", "--set-upstream-to=master", "only-behind");

    const refs = await r.ctx().refs.listRefs();
    const feature = byFull(refs, "refs/heads/feature");
    assert.ok(feature);
    assert.equal(feature.isCurrent, true, "the checked-out branch is current");
    assert.equal(feature.upstream, "master");
    assert.equal(feature.ahead, 1);
    assert.equal(feature.behind, 2);
    assert.equal(feature.gone, undefined);

    const inSync = byFull(refs, "refs/heads/only-ahead");
    assert.ok(inSync);
    assert.equal(inSync.upstream, "feature");
    assert.equal(inSync.ahead, undefined, "in sync: no counts at all");
    assert.equal(inSync.behind, undefined);

    const behind = byFull(refs, "refs/heads/only-behind");
    assert.ok(behind);
    assert.equal(behind.behind, 2);
    assert.equal(behind.ahead, undefined, "only the side git reported");

    const master = byFull(refs, "refs/heads/master");
    assert.ok(master);
    assert.equal(master.upstream, undefined, "an untracked branch carries no upstream");
    assert.equal(master.isCurrent, false);
  }),
);

test(
  "a branch whose upstream was deleted is marked gone — not read as in sync",
  withRepo("refs-gone", async (r) => {
    const bare = mkdtempSync(join(tmpdir(), "gs-refs-bare-"));
    try {
      r.git("init", "-q", "--bare", bare);
      r.write("a.txt", "a\n");
      r.commitAll("base");
      r.git("remote", "add", "origin", bare);
      r.git("push", "-q", "-u", "origin", "master:refs/heads/topic");
      r.git("config", "branch.master.merge", "refs/heads/topic");
      r.git("update-ref", "-d", "refs/remotes/origin/topic");

      const master = byFull(await r.ctx().refs.listRefs(), "refs/heads/master");
      assert.ok(master);
      assert.equal(master.upstream, "origin/topic");
      assert.equal(master.gone, true);
      assert.equal(master.ahead, undefined);
      assert.equal(master.behind, undefined);
    } finally {
      removeTempRepo(bare);
    }
  }),
);

test(
  "remote branches are typed remote, and origin/HEAD says which branch is the default",
  withRepo("refs-remote", async (r) => {
    r.write("a.txt", "a\n");
    const c = r.commitAll("base");
    r.git("update-ref", "refs/remotes/origin/master", c);
    r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    const refs = await r.ctx().refs.listRefs();
    const om = byFull(refs, "refs/remotes/origin/master");
    assert.ok(om);
    assert.equal(om.type, "remote");
    assert.equal(om.name, "origin/master");
    assert.equal(om.sha, c);
    assert.equal(om.symref, undefined, "a plain ref points at no other ref");
    const oh = byFull(refs, "refs/remotes/origin/HEAD");
    assert.ok(oh);
    assert.equal(oh.symref, "origin/master");
  }),
);

test(
  "stashes are listed newest first, by their stash@{n} selector and commit",
  withRepo("refs-stash", async (r) => {
    r.write("a.txt", "a\n");
    r.commitAll("base");
    r.write("a.txt", "first\n");
    r.git("stash", "push", "-q", "-m", "one");
    r.write("a.txt", "second\n");
    r.git("stash", "push", "-q", "-m", "two");
    const stashes = (await r.ctx().refs.listRefs()).filter((x) => x.type === "stash");
    assert.deepEqual(
      stashes.map((s) => [s.name, s.sha, s.fullName, s.isCurrent]),
      [
        ["stash@{0}", r.git("rev-parse", "stash@{0}").trim(), "refs/stash", false],
        ["stash@{1}", r.git("rev-parse", "stash@{1}").trim(), "refs/stash", false],
      ],
    );
  }),
);

test("a stash listing that fails leaves the branches and tags intact, with no stash rows", async () => {
  const US = "\x1f";
  const proc = stubProc((args) => {
    if (args[0] === "stash") return { code: 1, stderr: "fatal: broken" };
    return {
      stdout: [
        ["a".repeat(40), "refs/heads/main", "main", "*", "", "", "", "1700000000", "s", "commit", ""].join(US),
        // A ref outside heads/remotes/tags (for-each-ref was asked for those
        // three, but a stray line must not become a chip of unknown kind).
        ["b".repeat(40), "refs/notes/commits", "notes/commits", "", "", "", "", "0", "", "commit", ""].join(US),
      ].join("\n"),
    };
  });
  const refs = await new RefProvider(proc).listRefs();
  assert.deepEqual(
    refs.map((x) => [x.type, x.fullName]),
    [["head", "refs/heads/main"]],
  );
  assert.equal(refs[0].date, 1700000000);
  assert.equal(refs[0].who, undefined, "no names at all: no person");
});

test("a stash line without a selector is skipped rather than listed as a nameless stash", async () => {
  const proc = stubProc((args) => (args[0] === "stash" ? { stdout: `${"c".repeat(40)}\n${"d".repeat(40)}\x1fstash@{0}\x1fWIP\n` } : {}));
  const refs = await new RefProvider(proc).listRefs();
  assert.deepEqual(refs.map((x) => x.name), ["stash@{0}"]);
});

test(
  "headCommit is HEAD's commit, or empty on an unborn branch (never the word HEAD)",
  withRepo("refs-headcommit", async (r) => {
    const refs = r.ctx().refs;
    assert.equal(await refs.headCommit(), "", "no commit yet");
    r.write("a.txt", "a\n");
    const c = r.commitAll("base");
    assert.equal(await refs.headCommit(), c);
    r.git("checkout", "-q", "--detach");
    assert.equal(await refs.headCommit(), c, "detached: still where HEAD is");
  }),
);

test(
  "getHead: on a branch it gives the branch and its full name; detached it gives only the sha",
  withRepo("refs-gethead", async (r) => {
    r.write("a.txt", "a\n");
    const c = r.commitAll("base");
    const refs = r.ctx().refs;
    assert.deepEqual(await refs.getHead(), { detached: false, branch: "master", sha: c, fullName: "refs/heads/master" });
    r.git("checkout", "-q", "--detach");
    assert.deepEqual(await refs.getHead(), { detached: true, sha: c });
  }),
);

// It used to answer a DETACHED head with an empty sha here, and the push
// review then advised creating a branch in a repository git could not open.
test("getHead over a .git git cannot read fails with git's reason rather than calling HEAD detached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-refs-unreadable-"));
  try {
    writeFileSync(join(dir, ".git"), "gitdir: ./nowhere\n");
    const proc = new GitProcess({ cwd: dir });
    try {
      await assert.rejects(new RefProvider(proc).getHead(), /not a git repository/);
    } finally {
      proc.dispose();
    }
  } finally {
    removeTempRepo(dir);
  }
});

test("getHead on a HEAD that points outside refs/heads carries no full name", async () => {
  // symbolic-ref succeeds but names something that is not a local branch.
  const proc = stubProc((args) => {
    if (args[0] === "rev-parse") return { stdout: `${"e".repeat(40)}\n` };
    if (args.includes("--short")) return { stdout: "weird\n" };
    return { stdout: "refs/weird\n" };
  });
  assert.deepEqual(await new RefProvider(proc).getHead(), { detached: false, branch: "weird", sha: "e".repeat(40) });
});

test("headBranchName reads the plain name from the full one, and nothing when detached", () => {
  assert.equal(headBranchName({ detached: true, sha: "a" }), undefined);
  assert.equal(
    headBranchName({ detached: false, branch: "heads/release", sha: "a", fullName: "refs/heads/release" }),
    "release",
    "never git's disambiguated short form",
  );
  assert.equal(headBranchName({ detached: false, branch: "feature/x", sha: "a", fullName: "refs/heads/feature/x" }), "feature/x");
  assert.equal(headBranchName({ detached: false, branch: "main", sha: "a" }), "main", "no full name: the branch as read");
  assert.equal(
    headBranchName({ detached: false, branch: "main", sha: "a", fullName: "refs/heads/" }),
    "main",
    "an empty remainder falls back rather than naming nothing",
  );
});

test(
  "containingBranches lists locals then remotes, sorted, skipping origin/HEAD and a detached HEAD",
  withRepo("refs-contains", async (r) => {
    r.write("a.txt", "a\n");
    const base = r.commitAll("base");
    r.git("branch", "zeta");
    r.git("branch", "feature/x");
    r.git("update-ref", "refs/remotes/origin/master", base);
    r.git("update-ref", "refs/remotes/origin/b", base);
    r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    r.write("b.txt", "b\n");
    r.commitAll("later"); // master moves on; still contains base
    r.git("branch", "not-containing", "HEAD");
    r.git("update-ref", "refs/heads/not-containing", r.git("commit-tree", "-m", "orphan", `${base}^{tree}`).trim());
    r.git("checkout", "-q", "--detach", base);

    const got = await r.ctx().refs.containingBranches(base);
    assert.deepEqual(got.branches, ["feature/x", "master", "zeta", "origin/b", "origin/master"]);
    assert.deepEqual(got.refs, [
      "refs/heads/feature/x",
      "refs/heads/master",
      "refs/heads/zeta",
      "refs/remotes/origin/b",
      "refs/remotes/origin/master",
    ]);
    assert.equal(got.truncated, false);

    const capped = await r.ctx().refs.containingBranches(base, { limit: 2 });
    assert.deepEqual(capped.branches, ["feature/x", "master"]);
    assert.deepEqual(capped.refs, ["refs/heads/feature/x", "refs/heads/master"]);
    assert.equal(capped.truncated, true, "the cap is reported, not silent");
  }),
);

test(
  "containingBranches of an unknown commit is none, not an error",
  withRepo("refs-contains-unknown", async (r) => {
    r.write("a.txt", "a\n");
    r.commitAll("base");
    assert.deepEqual(await r.ctx().refs.containingBranches("0".repeat(40)), { branches: [], refs: [], truncated: false });
  }),
);

test("containingBranches ignores blank lines and a name listed twice", async () => {
  const proc = stubProc(() => ({ stdout: "refs/heads/a\n   \nrefs/heads/a\nrefs/remotes/o/b\nrefs/remotes/o/b\nrefs/remotes/\n" }));
  assert.deepEqual(await new RefProvider(proc).containingBranches("f".repeat(40)), {
    branches: ["a", "o/b"],
    refs: ["refs/heads/a", "refs/remotes/o/b"],
    truncated: false,
  });
});
