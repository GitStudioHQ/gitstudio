import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("with updateRefs off, nothing the user did not name is rewritten", async () => {
  const { root } = stackRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new RebaseBridge(repos);
    const plan = await bridge.load({ base: "trunk" });
    const before = shaOf(root, "stacked-a");

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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  }
});
