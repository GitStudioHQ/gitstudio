import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, bareRemote, gitIn, type BridgeRepo } from "./gitBridgeFixture";

// The graph's commit menu, the Branches view's tag and push verbs, the
// operation banner's verbs, and the conflict dashboard's writes — each checked
// by what the repository looks like afterwards, and by which failures come
// back `expected` (a state the user is in) versus reported (something broke).

let r: BridgeRepo | undefined;
afterEach(() => {
  r?.cleanup();
  r = undefined;
});

function repo(prefix = "ops"): BridgeRepo {
  r = initRepo(prefix);
  return r;
}

function threeCommits(t: BridgeRepo): string[] {
  const shas: string[] = [];
  for (const [i, v] of ["one", "two", "three"].entries()) {
    t.write("a.txt", `${v}\n`);
    t.write(`f${i}.txt`, `${v}\n`);
    shas.push(t.commitAll(v));
  }
  return shas;
}

/** Three commits that each add their own file, so any one reverts cleanly. */
function separateCommits(t: BridgeRepo): string[] {
  return ["one", "two", "three"].map((v) => {
    t.write(`${v}.txt`, `${v}\n`);
    return t.commitAll(v);
  });
}

const head = (t: BridgeRepo): string => t.git("rev-parse", "HEAD").trim();

// ── commit menu ─────────────────────────────────────────────────────────────

test("the three resets move the branch and treat the index and working tree as named", async () => {
  const t = repo();
  const [first, , third] = threeCommits(t);
  void third;

  t.write("a.txt", "dirty\n");
  const soft = await t.bridge.commitAction({ action: "reset-soft", sha: first });
  assert.deepEqual(soft, { ok: true, changed: true });
  assert.equal(head(t), first);
  assert.match(t.git("diff", "--cached", "--name-only"), /f1\.txt/, "soft keeps the undone commits staged");
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "dirty\n");

  const mixed = await t.bridge.commitAction({ action: "reset-mixed", sha: first });
  assert.equal(mixed.ok, true);
  assert.equal(t.git("diff", "--cached", "--name-only").trim(), "", "mixed empties the index");
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "dirty\n", "and keeps the working tree");

  const hard = await t.bridge.commitAction({ action: "reset-hard", sha: first });
  assert.equal(hard.ok, true);
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "one\n", "hard puts the files back");
});

test("branch and tag from the commit menu are made at that commit", async () => {
  const t = repo();
  const [first] = threeCommits(t);
  assert.deepEqual(await t.bridge.commitAction({ action: "branch", sha: first, name: "from-first" }), { ok: true, changed: true });
  assert.equal(t.git("rev-parse", "refs/heads/from-first").trim(), first);
  assert.deepEqual(await t.bridge.commitAction({ action: "tag", sha: first, name: "at-first" }), { ok: true, changed: true });
  assert.equal(t.git("rev-parse", "refs/tags/at-first").trim(), first);

  // A name git rejects is git's refusal, said.
  const bad = await t.bridge.commitAction({ action: "branch", sha: first, name: "has space" });
  assert.equal(bad.ok, false);
  assert.match(bad.message ?? "", /not a valid branch name/);
});

test("the commit menu refuses option-shaped values and runs nothing for copy-sha", async () => {
  const t = repo();
  const [first] = threeCommits(t);
  const before = head(t);
  assert.equal((await t.bridge.commitAction({ action: "reset-hard", sha: "--merge" })).ok, false);
  assert.equal((await t.bridge.commitAction({ action: "branch", sha: first, name: "-D" })).ok, false);
  assert.equal((await t.bridge.commitAction({ action: "tag", sha: first })).ok, false, "a tag needs a name");
  assert.deepEqual(await t.bridge.commitAction({ action: "copy-sha", sha: "" }), { ok: true, changed: false });
  assert.equal(head(t), before);
});

test("reverting a commit whose change is already undone is git declining, not a crash", async () => {
  const t = repo();
  const [, second] = separateCommits(t);
  t.git("revert", "--no-edit", second);
  const res = await t.bridge.commitAction({ action: "revert", sha: second });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.ok((res.message ?? "").length > 0, "git's explanation, not a blank toast");
});

test("a cherry-pick that stops on a conflict says so as a state, with the conflict left to resolve", async () => {
  const t = repo();
  t.write("a.txt", "base\n");
  t.commitAll("base");
  t.git("checkout", "-q", "-b", "topic");
  t.write("a.txt", "topic\n");
  const pick = t.commitAll("topic edit");
  t.git("checkout", "-q", "main");
  t.write("a.txt", "main\n");
  t.commitAll("main edit");
  const res = await t.bridge.commitAction({ action: "cherry-pick", sha: pick });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /conflict/i);
  const state = await t.bridge.opState();
  assert.equal(state.cherryPicking, true);
  assert.equal(state.kind, "cherry-pick");
  assert.equal(state.conflicts, 1);

  const abort = await t.bridge.cherryPickAbort();
  assert.equal(abort.ok, true, abort.message);
  assert.equal((await t.bridge.opState()).kind, null);
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "main\n");
});

test("checkout of a ref refuses an option-shaped name and a request without its full name", async () => {
  const t = repo();
  const [first] = threeCommits(t);
  const unsafe = await t.bridge.commitAction({ action: "checkout-ref", sha: first, name: "-f", fullName: "refs/heads/-f" });
  assert.equal(unsafe.ok, false);
  const noName = await t.bridge.commitAction({ action: "checkout-ref", sha: first, name: "" });
  assert.match(noName.message ?? "", /valid git reference/);
  const flagFull = await t.bridge.commitAction({ action: "checkout-ref", sha: first, name: "main", fullName: "--orphan" });
  assert.match(flagFull.message ?? "", /valid git reference/);
  const noFull = await t.bridge.commitAction({ action: "checkout-ref", sha: first, name: "main" });
  assert.equal(noFull.ok, false);
  assert.match(noFull.message ?? "", /Couldn't tell which main to check out/);
});

test("checking out a branch while a conflict is unresolved answers in the operation's words", async () => {
  const t = repo();
  t.write("a.txt", "base\n");
  t.commitAll("base");
  t.git("branch", "other");
  t.git("checkout", "-q", "-b", "topic");
  t.write("a.txt", "topic\n");
  t.commitAll("topic");
  t.git("checkout", "-q", "main");
  t.write("a.txt", "main\n");
  t.commitAll("main");
  t.gitTry("merge", "topic");
  const sha = t.git("rev-parse", "other").trim();
  const res = await t.bridge.commitAction({ action: "checkout-ref", sha, name: "other", fullName: "refs/heads/other" });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /conflict/i);
  assert.equal(t.git("symbolic-ref", "--short", "HEAD").trim(), "main", "still on main, mid-merge");
});

test("picking several commits refuses unreadable shas and a merge among them", async () => {
  const t = repo();
  const [first, second] = separateCommits(t);
  const ghost = "f".repeat(40);
  const unreadable = await t.bridge.commitAction({ action: "cherry-pick", sha: first, shas: [first, ghost] });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.expected, true);
  assert.match(unreadable.message ?? "", /could not be read any more/);

  t.git("checkout", "-q", "-b", "side", first);
  t.write("side.txt", "side\n");
  t.commitAll("side");
  t.git("checkout", "-q", "main");
  t.git("merge", "-q", "--no-ff", "--no-edit", "side");
  const merge = head(t);
  t.git("checkout", "-q", "-b", "target", first);
  const before = head(t);
  const withMerge = await t.bridge.commitAction({ action: "cherry-pick", sha: second, shas: [second, merge] });
  assert.equal(withMerge.ok, false);
  assert.equal(withMerge.expected, true);
  assert.match(withMerge.message ?? "", new RegExp(`${merge.slice(0, 7)} is a merge commit`));
  assert.equal(head(t), before, "nothing was picked");

  // Duplicates collapse to one sha: not "several", and not guessed at either.
  const one = await t.bridge.commitAction({ action: "revert", sha: second, shas: [second, second] });
  assert.equal(one.ok, false);
  assert.match(one.message ?? "", /valid git reference/);
  assert.equal(head(t), before);
});

test("reverting several commits that git declines is reported with its reason", async () => {
  const t = repo();
  const [, second, third] = separateCommits(t);
  // Both already reverted: the revert run has nothing to do on the first one.
  t.git("revert", "--no-edit", third);
  t.git("revert", "--no-edit", second);
  const res = await t.bridge.commitAction({ action: "revert", sha: second, shas: [second, third] });
  assert.equal(res.ok, false);
  assert.ok((res.message ?? "").length > 0);
});

// ── branches: push / delete / default ──────────────────────────────────────

test("pushing an unpublished branch with no remote, or with several, says why instead of guessing", async () => {
  const t = repo();
  threeCommits(t);
  const none = await t.bridge.branchPush("refs/heads/main");
  assert.equal(none.ok, false);
  assert.match(none.message ?? "", /No remote is configured, so 'main' can't be published/);

  bareRemote(t, "alpha");
  bareRemote(t, "beta");
  const several = await t.bridge.branchPush("refs/heads/main");
  assert.equal(several.ok, false);
  assert.match(several.message ?? "", /Several remotes are configured/);

  // The only remote is taken when there is exactly one.
  t.git("remote", "remove", "beta");
  const one = await t.bridge.branchPush("refs/heads/main");
  assert.equal(one.ok, true, one.message);
  assert.equal(t.git("rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "alpha/main");
});

test("the branch list measures merged against the default branch another remote names", async () => {
  const t = repo();
  const [first] = threeCommits(t);
  t.git("branch", "merged-one", first);
  t.git("checkout", "-q", "-b", "ahead", first);
  t.write("x.txt", "x\n");
  t.commitAll("ahead work");
  t.git("checkout", "-q", "main");
  // Only an "upstream" remote, whose HEAD points at main.
  bareRemote(t, "upstream");
  t.git("push", "-q", "upstream", "main");
  t.git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main");

  const list = await t.bridge.branchesList();
  const byName = new Map(list.map((b) => [b.name, b]));
  assert.equal(byName.get("main")?.isDefault, true);
  assert.equal(byName.get("merged-one")?.merged, true);
  assert.equal(byName.get("merged-one")?.behindDefault, 2);
  assert.equal(byName.get("ahead")?.merged, false);
  assert.equal(byName.get("ahead")?.aheadDefault, 1);
  assert.deepEqual(byName.get("ahead")?.tipAuthor, { name: "Dev", email: "dev@example.com" });
});

test("with the default branch unreadable the list still loads, with no divergence bars", async () => {
  const t = repo();
  threeCommits(t);
  t.git("branch", "topic");
  const run = t.ctx.process.run.bind(t.ctx.process);
  // Every read of the default branch fails; the list itself still works.
  t.ctx.process.run = async (args, opts) => {
    if (args[0] === "for-each-ref" && args.includes("refs/remotes/*/HEAD")) throw new Error("spawn failed");
    return run(args, opts);
  };
  t.ctx.refs.getHead = async () => {
    throw new Error("HEAD unreadable");
  };
  const list = await t.bridge.branchesList();
  assert.deepEqual(list.map((b) => b.name).sort(), ["main", "topic"]);
  assert.equal(list.some((b) => b.merged !== undefined || b.isDefault), false, "nothing to measure against");
  assert.deepEqual(await t.bridge.branchesPeople(), {}, "and no base to find creators from");
});

test("an older git without ahead-behind leaves the bars off rather than failing the list", async () => {
  const t = repo();
  threeCommits(t);
  const run = t.ctx.process.run.bind(t.ctx.process);
  t.ctx.process.run = async (args, opts) => {
    if (args[0] === "for-each-ref" && args.some((a) => a.includes("%(ahead-behind:"))) throw new Error("unknown field name");
    return run(args, opts);
  };
  const list = await t.bridge.branchesList();
  assert.equal(list.length, 1);
  assert.equal(list[0].isDefault, true);
  assert.equal(list[0].merged, undefined);
});

test("branch people names each branch's first author and counts contributors, skipping failures", async () => {
  const t = repo();
  threeCommits(t);
  t.git("checkout", "-q", "-b", "feature");
  t.write("feat.txt", "1\n");
  t.git("add", "-A");
  t.git("-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "start");
  t.write("feat.txt", "2\n");
  t.commitAll("dev follows");
  t.write("feat.txt", "3\n");
  t.git("add", "-A");
  t.git("-c", "user.name=Ada", "-c", "user.email=ADA@example.com", "commit", "-q", "-m", "ada again");
  t.git("checkout", "-q", "main");
  t.git("branch", "broken");

  const run = t.ctx.process.run.bind(t.ctx.process);
  t.ctx.process.run = async (args, opts) => {
    if (args[0] === "log" && args.some((a) => a.endsWith("..broken"))) throw new Error("one odd ref");
    return run(args, opts);
  };
  const people = await t.bridge.branchesPeople();
  assert.deepEqual(people.feature.creator, { name: "Ada", email: "ada@example.com" });
  assert.deepEqual(
    people.feature.contributors.map((c) => [c.email.toLowerCase(), c.count]),
    [
      ["ada@example.com", 2],
      ["dev@example.com", 1],
    ],
  );
  assert.equal("main" in people, false, "the base itself has no unique commits");
  assert.equal("broken" in people, false, "one branch's failure is its own");
});

test("deleting a remote branch remembers where it was, and restoring pushes it back only if absent", async () => {
  const t = repo();
  const [first, , tip] = threeCommits(t);
  const bare = bareRemote(t);
  t.git("push", "-q", "origin", "main:feature");
  t.git("fetch", "-q", "origin");

  const del = await t.bridge.branchDeleteRemote({ remote: "origin", name: "feature" });
  assert.equal(del.ok, true, del.message);
  assert.equal(del.was, tip);
  assert.equal(gitIn(bare, "for-each-ref", "refs/heads/feature").trim(), "", "gone on the remote");

  const back = await t.bridge.branchRestoreRemote({ remote: "origin", name: "feature", sha: tip });
  assert.deepEqual(back, { ok: true, changed: true });
  assert.equal(gitIn(bare, "rev-parse", "refs/heads/feature").trim(), tip);

  // Somebody re-made it meanwhile, at an ANCESTOR of the old tip — an ordinary
  // push would fast-forward their branch. The restore is refused instead.
  gitIn(bare, "update-ref", "refs/heads/feature", first);
  const again = await t.bridge.branchRestoreRemote({ remote: "origin", name: "feature", sha: tip });
  assert.equal(again.ok, false);
  assert.equal(again.expected, true);
  assert.equal(gitIn(bare, "rev-parse", "refs/heads/feature").trim(), first, "their branch is untouched");
});

// ── tags ───────────────────────────────────────────────────────────────────

test("a tag with a message is annotated, one without is lightweight, and option-shaped names are refused", async () => {
  const t = repo();
  const [first] = threeCommits(t);
  assert.deepEqual(await t.bridge.tagCreate({ name: "v1", message: "release one" }), { ok: true, changed: true });
  assert.equal(t.git("cat-file", "-t", "refs/tags/v1").trim(), "tag");
  assert.deepEqual(await t.bridge.tagCreate({ name: "v0", ref: first }), { ok: true, changed: true });
  assert.equal(t.git("cat-file", "-t", "refs/tags/v0").trim(), "commit");
  assert.equal(t.git("rev-parse", "refs/tags/v0").trim(), first);

  assert.equal((await t.bridge.tagCreate({ name: "--delete" })).ok, false);
  assert.equal((await t.bridge.tagCreate({ name: "ok", ref: "--all" })).ok, false);
  assert.equal(t.gitTry("rev-parse", "--verify", "refs/tags/ok").code === 0, false);
});

test("a deleted annotated tag comes back annotated, and not over a tag made since", async () => {
  const t = repo();
  threeCommits(t);
  t.git("tag", "-a", "v1", "-m", "the message");
  const obj = t.git("rev-parse", "refs/tags/v1").trim();
  const del = await t.bridge.tagDelete("v1");
  assert.equal(del.ok, true);
  assert.equal(del.was, obj, "the tag object, not the commit it names");

  const back = await t.bridge.tagRestore({ name: "v1", sha: obj });
  assert.deepEqual(back, { ok: true, changed: true });
  assert.equal(t.git("cat-file", "-t", "refs/tags/v1").trim(), "tag");
  assert.match(t.git("cat-file", "-p", "refs/tags/v1"), /the message/);

  const twice = await t.bridge.tagRestore({ name: "v1", sha: obj });
  assert.equal(twice.ok, false);
  assert.match(twice.message ?? "", /is there again/);

  const bogus = await t.bridge.tagRestore({ name: "v2", sha: "1234567".repeat(5) + "89abc" });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.expected, true);
  assert.equal(t.gitTry("rev-parse", "--verify", "refs/tags/v2").code === 0, false);
});

test("pushing a tag picks origin, else the only remote, and refuses to guess between several", async () => {
  const t = repo();
  threeCommits(t);
  t.git("tag", "v1");
  const none = await t.bridge.tagPush({ name: "v1" });
  assert.equal(none.ok, false);
  assert.match(none.message ?? "", /No remote is configured, so 'v1' can't be pushed/);

  const only = bareRemote(t, "fork");
  const one = await t.bridge.tagPush({ name: "v1" });
  assert.equal(one.ok, true, one.message);
  assert.equal(gitIn(only, "rev-parse", "refs/tags/v1").trim(), t.git("rev-parse", "v1").trim());

  bareRemote(t, "mirror");
  t.git("tag", "v2");
  const several = await t.bridge.tagPush({ name: "v2" });
  assert.equal(several.ok, false);
  assert.match(several.message ?? "", /Several remotes are configured/);

  const named = await t.bridge.tagPush({ name: "v2", remote: "mirror" });
  assert.equal(named.ok, true, named.message);
  assert.equal((await t.bridge.tagPush({ name: "v2", remote: "--mirror" })).ok, false);
  assert.equal((await t.bridge.tagPush({ name: "-v2" })).ok, false);
});

// ── the operation banner ───────────────────────────────────────────────────

test("abandoning a patch series after HEAD moved warns that git did not rewind", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.git("checkout", "-q", "-b", "patch");
  t.write("a.txt", "from the patch\n");
  t.commitAll("the patch");
  const out = mkdtempSync(join(tmpdir(), "gitstudio-patches-"));
  t.alsoRemove.push(out);
  t.git("format-patch", "-q", "-1", "-o", out);
  t.git("checkout", "-q", "main");
  t.write("a.txt", "conflicting line\n");
  t.commitAll("main moves");
  assert.notEqual(t.gitTry("am", join(out, readdirSync(out)[0])).code, 0);
  // HEAD moves while the series is stopped.
  t.git("commit", "-q", "--allow-empty", "-m", "moved meanwhile");
  const moved = head(t);

  const res = await t.bridge.amAbort();
  assert.equal(res.ok, true);
  assert.match(res.message ?? "", /HEAD had moved since it started/);
  assert.equal(head(t), moved, "git left HEAD where it is");
});

test("skipping a revert when none is stopped fails as an expected state", async () => {
  const t = repo();
  threeCommits(t);
  const res = await t.bridge.revertSkip();
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.ok(res.message);
});

test("continuing a rebase when none is running is a stated failure, not a crash", async () => {
  const t = repo();
  threeCommits(t);
  const res = await t.bridge.rebaseContinue();
  assert.equal(res.ok, false);
  assert.ok((res.message ?? "").length > 0);
  assert.equal(res.expected, false, "not stopped — nothing is waiting on the user");
});

test("a rebase runner that throws is reported with its message", async () => {
  const t = repo();
  threeCommits(t);
  const broken = new (t.bridge.constructor as typeof import("../src/main/gitBridge").GitBridge)({
    getContext: () => t.ctx,
    current: () => ({ root: t.repo }),
    state: () => ({ tabs: [] }),
    runnerOptions: () => {
      throw new Error("no git binary configured");
    },
  } as never);
  const res = await broken.rebaseSkip();
  assert.deepEqual(res, { ok: false, changed: false, message: "no git binary configured" });
});

test("an operation state that cannot be inspected reads as nothing in progress", async () => {
  const t = repo();
  threeCommits(t);
  t.ctx.operation.inspect = async () => {
    throw new Error("unreadable .git");
  };
  const s = await t.bridge.opState();
  assert.equal(s.kind, null);
  assert.equal(s.canContinue, false);
});

// ── the conflict dashboard ─────────────────────────────────────────────────

test("conflict writes that throw come back as reported failures, not rejections", async () => {
  const t = repo();
  threeCommits(t);
  const boom = async (): Promise<never> => {
    throw new Error("disk full");
  };
  t.ctx.conflictOps.writeResolution = boom;
  t.ctx.conflictOps.takeStage = boom;
  t.ctx.conflictOps.takeRole = boom;
  t.ctx.conflictOps.restore = boom;
  t.ctx.conflictOps.deleteFile = boom;
  t.ctx.conflict.listConflicts = boom;
  const results = [
    await t.bridge.conflictResolve({ path: "a.txt", content: "x" }),
    await t.bridge.conflictTakeSide({ path: "a.txt", side: "theirs" }),
    await t.bridge.conflictTakeRole({ path: "a.txt", role: "theirs" }),
    await t.bridge.conflictRestore({ path: "a.txt" }),
    await t.bridge.conflictDelete({ path: "a.txt" }),
  ];
  for (const res of results) {
    assert.equal(res.ok, false);
    assert.equal(res.expected, undefined, "a throw is ours to hear about");
    assert.match(res.message ?? "", /disk full/);
  }
  assert.deepEqual(await t.bridge.conflictList(), []);
});

test("conflict writes refuse unusable paths, sides and roles before touching anything", async () => {
  const t = repo();
  threeCommits(t);
  assert.match((await t.bridge.conflictResolve({ path: "", content: "x" })).message ?? "", /usable file path/);
  assert.match(
    (await t.bridge.conflictResolve({ path: "a.txt", content: 5 as unknown as string })).message ?? "",
    /Nothing to save/,
  );
  assert.match((await t.bridge.conflictTakeSide({ path: "a\0b", side: "ours" })).message ?? "", /usable file path/);
  assert.match(
    (await t.bridge.conflictTakeSide({ path: "a.txt", side: "base" as unknown as "ours" })).message ?? "",
    /usable file path/,
  );
  assert.match(
    (await t.bridge.conflictTakeRole({ path: "a.txt", role: "base" as unknown as "yours" })).message ?? "",
    /Choose Yours or Theirs/,
  );
  assert.match((await t.bridge.conflictRestore({ path: "" })).message ?? "", /usable file path/);
  assert.match((await t.bridge.conflictDelete({ path: "" })).message ?? "", /usable file path/);
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "three\n");
});

test("a conflict state read that fails is not served again from the cache", async () => {
  const t = repo();
  threeCommits(t);
  const real = t.ctx.conflictOps.snapshot.bind(t.ctx.conflictOps);
  let calls = 0;
  t.ctx.conflictOps.snapshot = async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return real();
  };
  await assert.rejects(t.bridge.conflictState(), /transient/);
  // Give the eviction (a .catch on the cached promise) its turn.
  await new Promise((resolve) => setImmediate(resolve));
  const snap = await t.bridge.conflictState();
  assert.equal(calls, 2, "the failed read was dropped, so this one asked git again");
  assert.equal(snap.total, 0);
  // And a good read IS cached: the next call does not ask again.
  await t.bridge.conflictState();
  assert.equal(calls, 2);
});
