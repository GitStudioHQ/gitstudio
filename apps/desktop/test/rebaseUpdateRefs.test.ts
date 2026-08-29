import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
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
