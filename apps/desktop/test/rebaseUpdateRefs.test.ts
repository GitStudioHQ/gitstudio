import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync, existsSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";

/**
 * Branches sitting inside a rewritten range.
 *
 * A rebase gives every commit a new sha. A branch pointing at one of the OLD
 * ones is not "left untouched" by that — it is left pointing at a commit that
 * is no longer in this branch's history, on a parallel line nothing references.
 * git solves this with `update-ref` lines in the todo (`rebase.updateRefs`),
 * and the shared plan builder has always been able to emit them — the desktop
 * just never populated the branch list or asked for them, so a stack of
 * branches was silently orphaned by any rebase that touched their commits.
 */
function stackRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-updrefs-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0"); // no background gc racing the cleanup
  const commit = (n: string): void => {
    writeFileSync(`${root}/${n}.txt`, `${n}\n`);
    git("add", "-A");
    git("commit", "-qm", n);
  };
  commit("base");
  git("branch", "trunk"); // the rebase base
  commit("one");
  git("branch", "stacked-a"); // sits ON "one"
  commit("two");
  git("branch", "stacked-b"); // sits ON "two"
  commit("three");
  return { root, git };
}

const shaOf = (root: string, ref: string): string =>
  execFileSync("git", ["rev-parse", ref], { cwd: root }).toString().trim();

/** Is `ref` an ancestor of HEAD — i.e. still part of this branch's history? */
const inHistory = (root: string, ref: string): boolean => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd: root });
    return true;
  } catch {
    return false;
  }
};

test("the plan reports which branches sit on which commits", async () => {
  const { root } = stackRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    assert.equal(plan.ok, true, plan.message ?? "");

    const bySubject = new Map(plan.commits.map((c) => [c.subject, c.branches ?? []]));
    assert.deepEqual(bySubject.get("one"), ["stacked-a"]);
    assert.deepEqual(bySubject.get("two"), ["stacked-b"]);
    assert.deepEqual(bySubject.get("three"), [], "the tip carries no other branch");
  } finally {
    removeTempRepo(root);
  }
});

test("the branch being rebased is never listed — git moves that one itself", async () => {
  const { root, git } = stackRepo();
  try {
    const current = git("symbolic-ref", "--short", "HEAD").trim();
    const repos = new RepoStore([]);
    await repos.open(root);
    const plan = await new RebaseBridge(repos).load({ base: "trunk" });
    assert.ok(
      !plan.commits.some((c) => (c.branches ?? []).includes(current)),
      `"${current}" must not appear — naming it in an update-ref fights the rebase for it`,
    );
  } finally {
    removeTempRepo(root);
  }
});

test("with updateRefs on, a reorder carries the stacked branches with it", async () => {
  const { root } = stackRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    const before = { a: shaOf(root, "stacked-a"), b: shaOf(root, "stacked-b") };

    // Reword the oldest commit — enough to give everything above it a new sha.
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "one" ? "reword" : "pick") as "reword" | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "one" ? "one (reworded)" : undefined,
      branches: c.branches,
    }));

    const out = await bridge.apply({ base: "trunk", rows, updateRefs: true });
    assert.equal(out.status, "done", out.message ?? "");

    assert.notEqual(shaOf(root, "stacked-a"), before.a, "stacked-a moved onto the rewrite");
    assert.ok(inHistory(root, "stacked-a"), "and is still in this branch's history");
    assert.ok(inHistory(root, "stacked-b"), "so is stacked-b");
  } finally {
    removeTempRepo(root);
  }
});

test("with updateRefs off, nothing the user did not name is rewritten", async () => {
  const { root } = stackRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    // FULL ref on both sides of this measurement: a bare "stacked-a" now
    // resolves to the TAG (git prefers refs/tags over refs/heads for an
    // ambiguous name), which of course never moves — the first version of this
    // test measured the tag and blamed the fix.
    const before = shaOf(root, "refs/heads/stacked-a");

    const rows = plan.commits.map((c) => ({
      action: (c.subject === "one" ? "reword" : "pick") as "reword" | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "one" ? "one (reworded)" : undefined,
      branches: c.branches,
    }));
    const out = await bridge.apply({ base: "trunk", rows, updateRefs: false });
    assert.equal(out.status, "done", out.message ?? "");
    assert.equal(
      shaOf(root, "stacked-a"),
      before,
      "opting out means opting out — refs the user did not name stay put",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("the repo's own rebase.updateRefs is what the view starts from", async () => {
  const { root, git } = stackRepo();
  try {
    git("config", "rebase.updateRefs", "true");
    const repos = new RepoStore([]);
    await repos.open(root);
    const plan = await new RebaseBridge(repos).load({ base: "trunk" });
    assert.equal(plan.updateRefs, true, "the app follows the user's git, not its own guess");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A range longer than the display cap.
 *
 * `loadCommits` stops at MAX_PLAN_COMMITS so a huge range does not render
 * thousands of rows — a DISPLAY limit, and the note said exactly that
 * ("Showing the first 200 commits; pick a nearer base to narrow it"). But
 * `apply` then built the todo from those rows and ran it over the WHOLE range,
 * and in an interactive rebase the todo IS the plan: a commit in the range and
 * not in the todo is dropped. So rebasing 205 commits DELETED the 5 oldest and
 * reported "done".
 *
 * Measured on a real repo before the fix: BEFORE=205 AFTER=200 LOST=5.
 */
test("a range longer than the display cap loses nothing", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-rebasecap-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("branch", "trunk");
    // Comfortably past the 200-row cap.
    for (let i = 1; i <= 205; i++) git("commit", "-q", "--allow-empty", "-m", `c${i}`);

    const subjects = (): string[] =>
      git("log", "--format=%s", "trunk..HEAD").trim().split("\n").filter(Boolean);
    const before = subjects();
    assert.equal(before.length, 205);

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    assert.ok(plan.commits.length < before.length, "the plan is capped, as designed");

    const rows = plan.commits.map((c) => ({
      action: "pick" as const,
      sha: c.sha,
      subject: c.subject,
    }));
    const out = await bridge.apply({ base: "trunk", rows });
    assert.equal(out.status, "done", out.message ?? "");

    const after = subjects();
    assert.equal(
      after.length,
      before.length,
      `no commit is dropped (lost ${before.length - after.length})`,
    );
    assert.equal(after[after.length - 1], "c1", "including the oldest, which the plan never showed");
    assert.deepEqual(
      before.filter((x) => !after.includes(x)),
      [],
      "and every subject survives by name",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A branch pointing BELOW the display cap.
 *
 * The commits past the 200-row cap ride along as picks, which is what stops the
 * rebase deleting them (above). But they rode along as BARE picks: the branch
 * map was built inside `loadCommits`, so only the commits shown on screen ever
 * carried their branches. A branch pointing at commit #3 of 205 got no
 * `update-ref` line, and the rebase left it on a parallel line no longer in the
 * rewritten history — the exact orphaning `--update-refs` exists to prevent,
 * happening to the commits the user had the least chance of noticing.
 */
test("a branch below the display cap is carried across the rewrite too", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-capbranch-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("branch", "trunk");
    // Real content per commit, not `--allow-empty`: every empty commit has the
    // same (empty) patch-id, so once the base moves, `--cherry-pick` reads all
    // 205 as duplicates of the one empty commit on the other side and drops
    // them — "Nothing to rebase" on a range that plainly has 205 commits.
    for (let i = 1; i <= 205; i++) {
      writeFileSync(`${root}/c${i}.txt`, `c${i}\n`);
      git("add", "-A");
      git("commit", "-qm", `c${i}`);
      // Deep in the range, far past what the plan will display.
      if (i === 3) git("branch", "deep");
    }
    const deepBefore = git("rev-parse", "deep").trim();
    // Move the base forward, so the rebase genuinely REWRITES every commit in
    // the range. Replayed onto an unchanged base, git fast-forwards the
    // untouched prefix and the shas below the edit do not move at all — a real
    // outcome, but not the one that orphans a branch.
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    git("checkout", "-q", "trunk");
    writeFileSync(`${root}/upstream.txt`, "upstream\n");
    git("add", "-A");
    git("commit", "-qm", "upstream moved");
    git("checkout", "-q", branch);

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    assert.ok(
      !plan.commits.some((c) => c.sha === deepBefore),
      "the branch's commit is below the cap — it is not on screen at all",
    );

    const rows = plan.commits.map((c) => ({ action: "pick" as const, sha: c.sha, subject: c.subject }));
    const out = await bridge.apply({ base: "trunk", rows, updateRefs: true });
    assert.equal(out.status, "done", out.message ?? "");

    const deepAfter = git("rev-parse", "deep").trim();
    assert.notEqual(deepAfter, deepBefore, "the branch moved with the rewrite");
    const contains = git("branch", "--contains", deepAfter).trim();
    assert.ok(
      contains.split("\n").some((l) => l.replace(/^\*?\s*/, "") === branch),
      `the branch is still in the rewritten history, not orphaned beside it (${contains})`,
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A branch whose name is also a tag's.
 *
 * `%(refname:short)` returns the shortest UNAMBIGUOUS name, so a branch
 * colliding with a tag comes back as `heads/stacked-a`. That went straight into
 * `update-ref refs/heads/heads/stacked-a`: a junk branch appeared, the rebase
 * reported success, and the user's REAL branch was left on a parallel line no
 * longer in the rebased history — the exact orphaning this feature prevents.
 * Branch+tag pairs (v1.2, release, stable) are routine.
 */
test("a branch colliding with a tag is carried by its real name", async () => {
  const { root, git } = stackRepo();
  try {
    git("tag", "stacked-a"); // a TAG sharing the branch's name — legal in git

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });

    const named = plan.commits.flatMap((c) => c.branches ?? []);
    assert.ok(
      !named.some((n) => n.includes("/")),
      `no ref path leaks into a branch NAME (got: ${named.join(", ")})`,
    );
    assert.ok(named.includes("stacked-a"), "the real branch is named");

    const before = shaOf(root, "stacked-a");
    const rows = plan.commits.map((c) => ({
      action: (c.subject === "one" ? "reword" : "pick") as "reword" | "pick",
      sha: c.sha,
      subject: c.subject,
      message: c.subject === "one" ? "one (reworded)" : undefined,
      branches: c.branches,
    }));
    const out = await bridge.apply({ base: "trunk", rows, updateRefs: true });
    assert.equal(out.status, "done", out.message ?? "");

    const heads = git("for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n");
    assert.ok(
      !heads.some((h) => h.startsWith("refs/heads/heads/")),
      `no junk branch is created (${heads.join(", ")})`,
    );
    assert.notEqual(
      shaOf(root, "refs/heads/stacked-a"),
      before,
      "the real branch moved with the rewrite",
    );
    assert.ok(
      inHistory(root, "refs/heads/stacked-a"),
      "and is in the rebased history, not orphaned",
    );
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A branch checked out in ANOTHER worktree.
 *
 * git's own `--update-refs` deliberately refuses to move one, writing a comment
 * into the todo instead: "# Ref refs/heads/x checked out at <path>". Moving it
 * anyway leaves that worktree's HEAD on a rewritten commit while its index and
 * working tree stay at the old one — `git status` there then reports staged
 * changes nobody made. The app ships a Worktrees feature, so this is a normal
 * setup for its users, and the checkbox never said the branch was elsewhere.
 */
test("a branch checked out in another worktree is left alone", async () => {
  const { root, git } = stackRepo();
  const linked = `${root}-wt`;
  try {
    git("worktree", "add", "-q", linked, "stacked-a");

    const repos = new RepoStore([]);
    await repos.open(root);
    const plan = await new RebaseBridge(repos).load({ base: "trunk" });
    const named = plan.commits.flatMap((c) => c.branches ?? []);
    assert.ok(
      !named.includes("stacked-a"),
      `a branch checked out elsewhere is never offered (got: ${named.join(", ")})`,
    );
    assert.ok(named.includes("stacked-b"), "while ordinary branches still are");
  } finally {
    try {
      git("worktree", "remove", "--force", linked);
    } catch {
      /* best effort */
    }
    removeTempRepo(linked);
    removeTempRepo(root);
  }
});

/**
 * A merge commit inside the range.
 *
 * `git log <base>..HEAD` lists merges; `git rebase -i` does not — its sequencer
 * builds the todo from `rev-list --reverse --topo-order --no-merges`, and its
 * parser refuses `pick <merge>` outright. So the plan contained a row git would
 * never accept, and applying it left the repo DETACHED AT THE BASE, mid-rebase,
 * with a clean tree and no conflict to resolve; Continue re-ran the same failing
 * todo and only Abort escaped. A feature branch with main merged into it is the
 * ordinary shape of this.
 *
 * Measured before the fix:
 *   {"status":"stopped","reason":"unknown",
 *    "message":"error: 'pick' does not accept merge commits"}
 */
function mergeRangeRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-mergerange-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  const commit = (n: string): void => {
    writeFileSync(`${root}/${n}.txt`, `${n}\n`);
    git("add", "-A");
    git("commit", "-qm", n);
  };
  commit("m1");
  git("branch", "trunk");
  git("checkout", "-qb", "feature");
  commit("f1");
  // main moves on, and is merged INTO the feature branch — the ordinary shape.
  git("checkout", "-q", "trunk");
  commit("m2");
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-ff", "-m", "Merge branch 'trunk' into feature", "trunk");
  commit("f2");
  return { root, git };
}

test("a merge inside the range does not wedge the repo", async () => {
  const { root, git } = mergeRangeRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    assert.equal(plan.ok, true, plan.message ?? "");

    // The plan is what git would replay: no merges in it.
    for (const c of plan.commits) {
      const parents = git("rev-list", "--parents", "-n", "1", c.sha).trim().split(/\s+/);
      assert.ok(parents.length <= 2, `no merge in the plan (${c.subject} has ${parents.length - 1} parents)`);
    }
    // …and it SAYS the merge was left out, rather than silently dropping it.
    assert.match(plan.message ?? "", /merge/i, "the omission is disclosed");

    const rows = plan.commits.map((c) => ({
      action: "pick" as const,
      sha: c.sha,
      subject: c.subject,
      branches: c.branches,
    }));
    const out = await bridge.apply({ base: "trunk", rows });
    assert.equal(out.status, "done", `the rebase completes (${out.message ?? ""})`);

    // Not detached, no rebase in progress, and the work is still there.
    assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "feature", "still on the branch");
    const subjects = git("log", "--format=%s", "HEAD").trim().split("\n");
    for (const s of ["f1", "f2", "m2", "m1"]) {
      assert.ok(subjects.includes(s), `${s} survives the rebase`);
    }
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The plan must be the todo git itself would generate.
 *
 * `git log`'s default order is reverse-chronological, which is NOT the order
 * `git rebase -i` replays in — its sequencer uses `--topo-order`. On a range
 * whose two lines interleave by date the two disagree, and the plan then
 * promised a replay order git would not have chosen:
 *
 *   git log --no-merges          A, C, B  -> todo: pick B, pick C, pick A
 *   git log --no-merges --topo   C, B, A  -> todo: pick A, pick B, pick C
 *   git rebase -i's OWN todo              -> pick A, pick B, pick C
 *
 * (An earlier version of this test asserted "no parent before its child" in the
 * default order. That can never fail: git's walk only puts a parent on the
 * frontier once a child has been emitted. The real invariant is agreement with
 * git, and that IS checkable — so check it.)
 */
function interleavedRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-interleave-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  const at = (n: string, when: string): void => {
    writeFileSync(`${root}/${n}.txt`, `${n}\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", n], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
  };
  at("base", "2024-01-01T00:00:00Z");
  git("branch", "trunk");
  git("checkout", "-qb", "side");
  at("B", "2024-01-09T00:00:00Z");
  at("C", "2024-01-02T00:00:00Z");
  git("checkout", "-q", "trunk");
  git("checkout", "-qb", "feature");
  at("A", "2024-01-03T00:00:00Z");
  git("merge", "-q", "--no-ff", "-m", "merge", "side");
  return { root, git };
}

/**
 * git's own todo for `rebase -i <base>`, captured WITHOUT running it.
 *
 * The sequence editor must exit NON-ZERO: a plain `GIT_SEQUENCE_EDITOR=cat`
 * returns 0, so git takes the todo as approved and executes the whole rebase —
 * which silently rewrote the branch this is supposed to be measuring, and the
 * comparison below then compared a linearized repo against itself and passed
 * no matter what. Exiting 1 makes git abort with the repository untouched.
 */
function nativeTodo(root: string, base: string): string[] {
  const editor = mkdtempSync(`${tmpdir()}/gs-seq-`) + "/seq.sh";
  writeFileSync(editor, '#!/bin/sh\ncat "$1"\nexit 1\n');
  chmodSync(editor, 0o755);
  let out = "";
  try {
    execFileSync("git", ["rebase", "-i", base], {
      cwd: root,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: editor },
      encoding: "utf8",
    });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  assert.equal(
    execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).toString().trim(),
    "feature",
    "capturing git's todo must not run the rebase",
  );
  return out
    .split("\n")
    .filter((l) => l.startsWith("pick "))
    .map((l) => l.split(/\s+/)[2]);
}

test("the plan replays in the order git itself would", async () => {
  const { root } = interleavedRepo();
  try {
    const native = nativeTodo(root, "trunk");
    assert.deepEqual(native, ["A", "B", "C"], "git's own todo, for reference");

    const repos = new RepoStore([]);
    await repos.open(root);
    const plan = await new RebaseBridge(repos).load({ base: "trunk" });
    // The plan is newest-first on screen; `apply` reverses it to make the todo.
    const ours = plan.commits.map((c) => c.subject).reverse();
    assert.deepEqual(ours, native, "our todo is git's todo");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * A commit whose patch is already on the base.
 *
 * git's sequencer builds the todo with `--cherry-mark --right-only` over
 * `upstream...HEAD`, which DROPS commits already applied upstream — a backport,
 * a cherry-pick that travelled both ways, a commit someone else merged. Listing
 * them made git skip the commit and PAUSE:
 *
 *     warning: skipped previously applied commit 4b20fb3
 *
 * leaving the repo mid-rebase with a clean tree and a card telling the user to
 * resolve conflicts that do not exist — the same wedge a merge in the range
 * produced, for the same reason: a plan git will not execute as written.
 */
test("a patch already on the base is not in the plan, and does not wedge the rebase", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-cherrydup-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    writeFileSync(`${root}/m.txt`, "m\n");
    git("add", "-A");
    git("commit", "-qm", "m1");
    git("branch", "trunk");

    git("checkout", "-qb", "feature");
    writeFileSync(`${root}/dup.txt`, "dup\n");
    git("add", "-A");
    git("commit", "-qm", "dup");
    writeFileSync(`${root}/keep.txt`, "keep\n");
    git("add", "-A");
    git("commit", "-qm", "keeper");

    // The SAME patch lands on trunk independently.
    git("checkout", "-q", "trunk");
    git("cherry-pick", "-x", "feature~1");
    git("checkout", "-q", "feature");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });

    assert.deepEqual(
      plan.commits.map((c) => c.subject),
      ["keeper"],
      "the already-applied commit is not offered — git's own todo does not list it",
    );

    const out = await bridge.apply({
      base: "trunk",
      rows: plan.commits.map((c) => ({ action: "pick" as const, sha: c.sha, subject: c.subject })),
    });
    assert.equal(out.status, "done", `the rebase completes (${out.message ?? ""})`);
    assert.ok(
      !existsSync(`${root}/.git/rebase-merge`),
      "and leaves no rebase in progress behind it",
    );
    const log = git("log", "--format=%s", "HEAD").trim().split("\n");
    assert.ok(log.includes("keeper"), "the real work survives");
    assert.ok(log.includes("dup"), "and the duplicated patch is still there, from trunk");
  } finally {
    removeTempRepo(root);
  }
});
