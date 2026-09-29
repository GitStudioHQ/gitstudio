import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RebaseBridge } from "../src/main/rebaseBridge";
import type { RepoStore } from "../src/main/repoStore";
import { initRepo, type BridgeRepo } from "./gitBridgeFixture";

// The rebase workspace's plan (what "Rebase from here" lists, and the notes it
// owes the reader about what it leaves out), and the rewrite verbs' answers
// with no repository open or when git cannot even be started. The apply /
// drop / squash flows themselves are pinned in rebaseApplyReporting,
// dropCommitFlow and multiCommitFlow; this is the edges around them.

let r: BridgeRepo | undefined;
afterEach(() => {
  r?.cleanup();
  r = undefined;
});

function repo(): { t: BridgeRepo; rebase: RebaseBridge; store: Record<string, unknown> } {
  const t = initRepo("rebase-plans");
  r = t;
  const store = {
    current: () => ({ root: t.repo }),
    getContext: () => t.ctx,
    runnerOptions: () => ({ gitPath: "git", onRun: () => undefined }),
  };
  return { t, rebase: new RebaseBridge(store as unknown as RepoStore), store };
}

function linear(t: BridgeRepo, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    t.write(`f${i}.txt`, `${i}\n`);
    return t.commitAll(`commit ${i}`);
  });
}

const noRepo = new RebaseBridge({
  current: () => undefined,
  getContext: () => undefined,
  runnerOptions: () => ({ gitPath: "git", onRun: () => undefined }),
} as unknown as RepoStore);

test("with no repository open every rebase verb says to open one, as a state", async () => {
  const plan = await noRepo.load({});
  assert.equal(plan.ok, false);
  assert.equal(plan.expected, true);
  assert.equal(plan.message, "Open a repository first.");
  assert.deepEqual(plan.commits, []);

  for (const out of [
    await noRepo.dropPlan({ sha: "a".repeat(40) }),
    await noRepo.drop({ sha: "a".repeat(40), head: "b".repeat(40) }),
    await noRepo.undoDrop({ before: "a".repeat(40), after: "b".repeat(40) }),
    await noRepo.commitsPlan({ verb: "squash", shas: ["a".repeat(40), "b".repeat(40)] }),
    await noRepo.commitsRewrite({ verb: "drop", shas: ["a".repeat(40)], head: "b".repeat(40) }),
    await noRepo.commitsUndo({ what: "drop", before: "a".repeat(40), after: "b".repeat(40) }),
  ] as Array<{ ok: boolean; expected?: boolean; message?: string }>) {
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.equal(out.message, "Open a repository first.");
  }
});

test("rebasing from the root commit plans the whole branch from --root", async () => {
  const { t, rebase } = repo();
  const [root, second, third] = linear(t, 3);
  const plan = await rebase.load({ sha: root });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(plan.base, "--root");
  assert.deepEqual(plan.commits.map((c) => c.sha), [third, second, root], "newest first, the root included");
  assert.equal(plan.baseCommit, undefined, "there is nothing below the root to rebase onto");
  assert.equal(plan.branch, "main");
  assert.equal(plan.message, undefined, "nothing was left out, so nothing to say");
});

test("rebasing from a commit plans onto its parent, so that commit is the first row", async () => {
  const { t, rebase } = repo();
  const [first, second, third] = linear(t, 3);
  const plan = await rebase.load({ sha: second });
  assert.equal(plan.base, `${second}^`);
  assert.deepEqual(plan.commits.map((c) => c.sha), [third, second]);
  assert.equal(plan.baseCommit?.subject, "commit 0");
  assert.equal(plan.baseCommit?.shortSha, t.git("rev-parse", "--short", first).trim());
});

test("a base the caller named that does not resolve is quoted back, and the whole branch shown", async () => {
  const { t, rebase } = repo();
  linear(t, 2);
  const plan = await rebase.load({ base: "no-such-branch" });
  assert.equal(plan.ok, true);
  assert.equal(plan.base, "--root");
  assert.equal(plan.commits.length, 2);
  assert.match(plan.message ?? "", /“no-such-branch” doesn't resolve here — showing the whole branch instead\./);
});

test("two merges in the range are counted in the note, since the plan does not list them", async () => {
  const { t, rebase } = repo();
  const [base] = linear(t, 1);
  for (const side of ["a", "b"]) {
    t.git("checkout", "-q", "-b", side, base);
    t.write(`${side}.txt`, `${side}\n`);
    t.commitAll(`side ${side}`);
    t.git("checkout", "-q", "main");
    t.git("merge", "-q", "--no-ff", "--no-edit", side);
  }
  const plan = await rebase.load({ base });
  assert.equal(plan.ok, true, plan.message);
  assert.match(plan.message ?? "", /^2 merge commits in this range aren't listed/);
  assert.deepEqual(plan.commits.map((c) => c.subject).sort(), ["side a", "side b"], "the merged-in commits are what replays");
});

test("an apply whose runner cannot be configured fails with the reason and rewrites nothing", async () => {
  const { t, rebase, store } = repo();
  linear(t, 3);
  const plan = await rebase.load({ base: "HEAD~2" });
  const before = t.git("rev-parse", "HEAD").trim();
  store.runnerOptions = () => {
    throw new Error("no git binary configured");
  };
  const out = await rebase.apply({
    base: plan.base,
    headSha: plan.headSha,
    rows: plan.commits.map((c) => ({ sha: c.sha, subject: c.subject, action: "pick" as const })),
  });
  assert.deepEqual(out, { status: "failed", ok: false, message: "no git binary configured" });
  assert.equal(t.git("rev-parse", "HEAD").trim(), before);
});

test("a drop or rewrite whose git cannot start fails with the reason instead of rejecting", async () => {
  const { t, rebase } = repo();
  const [, second, third] = linear(t, 3);
  t.ctx.process.run = async () => {
    throw new Error("spawn EACCES");
  };
  const drop = await rebase.drop({ sha: second, head: third });
  assert.equal(drop.ok, false);
  assert.equal(drop.status, "failed");
  assert.equal(drop.expected, undefined, "git failing to start is ours to hear about");
  assert.match(drop.message ?? "", /spawn EACCES/);

  const many = await rebase.commitsRewrite({ verb: "squash", shas: [second, third], head: third, message: "one" });
  assert.equal(many.ok, false);
  assert.equal(many.status, "failed");
  assert.match(many.message ?? "", /spawn EACCES/);
});

test("undoing a rewrite after the branch moved on is refused as the user's state", async () => {
  const { t, rebase } = repo();
  const [first, second] = linear(t, 2);
  // "Undo" from second back to first — but HEAD has moved past second since.
  t.write("later.txt", "later\n");
  t.commitAll("later");
  const moved = t.git("rev-parse", "HEAD").trim();
  const res = await rebase.commitsUndo({ what: "squash", before: first, after: second, branch: "refs/heads/main" });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.ok(res.message);
  assert.equal(t.git("rev-parse", "HEAD").trim(), moved, "nothing was moved");
});
