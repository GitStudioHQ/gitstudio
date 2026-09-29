// Where a Push goes when the caller does not spell it out — the named-branch
// push of the Branches view, the first push of an unpublished branch (which
// remote it picks, and when it refuses to guess), tags, a detached HEAD, and a
// force push with nothing tracked to lease on. Every case pushes to a local
// bare repository and asserts the refs it ended with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bareRepo, cloneOf, synced } from "./syncOps.fixture";
import { makeRepo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";
import { execFileSync } from "node:child_process";

function refsOf(bare: string): Map<string, string> {
  const out = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
    cwd: bare,
    encoding: "utf8",
  });
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [ref, sha] = line.trim().split(" ");
    if (ref) m.set(ref, sha);
  }
  return m;
}

test("pushing a renamed branch by name updates the remote branch it tracks, not a new one under the new name", async () => {
  const s = synced("named");
  try {
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("g.txt", "g\n");
    s.me.commitAll("feat");
    s.me.git("push", "-q", "-u", "origin", "feat");
    // `git branch -m` keeps the tracking config pointing at origin/feat.
    s.me.git("branch", "-m", "feat", "feat-renamed");
    s.me.write("g.txt", "g2\n");
    const tip = s.me.commitAll("feat, more");
    s.me.git("checkout", "-q", "main");

    const ctx = s.ctx();
    const r = await ctx.sync.push({ remote: "origin", branch: "feat-renamed" });
    assert.equal(r.ok, true, r.stderr);
    const refs = s.remoteRefs();
    assert.equal(refs.get("refs/heads/feat"), tip, "the tracked remote branch moved to the new tip");
    assert.equal(refs.has("refs/heads/feat-renamed"), false, "and no second branch appeared under the new name");
    const push = s.runs.find((a) => a[0] === "push");
    assert.deepEqual(push, ["push", "origin", "refs/heads/feat-renamed:refs/heads/feat"], "a fully qualified refspec");
    assert.deepEqual(await ctx.sync.aheadBehind("feat-renamed"), { ahead: 0, behind: 0 }, "and the branch is in sync after it");
  } finally {
    s.cleanup();
  }
});

test("a forced publish of a branch with no upstream uses git's own lease and sets the upstream", async () => {
  const s = synced("forcepub");
  try {
    s.me.git("checkout", "-q", "-b", "solo");
    s.me.write("s.txt", "s\n");
    const tip = s.me.commitAll("solo");
    const ctx = s.ctx();
    const r = await ctx.sync.push({ remote: "origin", branch: "solo", force: true, setUpstream: true });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(s.remoteRefs().get("refs/heads/solo"), tip, "published");
    const push = s.runs.find((a) => a[0] === "push") ?? [];
    assert.ok(push.includes("--force-with-lease"), "a lease with no explicit value: nothing tracked to lease on");
    assert.equal(push.some((a) => a.startsWith("--force-with-lease=")), false);
    assert.ok(push.includes("--set-upstream"));
    assert.equal(push[push.length - 1], "refs/heads/solo:refs/heads/solo", "the publish refspec is qualified");
    assert.equal(s.me.git("config", "--get", "branch.solo.merge").trim(), "refs/heads/solo", "and it now tracks origin/solo");
  } finally {
    s.cleanup();
  }
});

test("Push with tags sends the repository's tags to the remote", async () => {
  const s = synced("tags");
  try {
    s.me.git("tag", "v1.0");
    s.me.git("tag", "-a", "v1.1", "-m", "annotated");
    const r = await s.ctx().sync.push({ tags: true });
    assert.equal(r.ok, true, r.stderr);
    const refs = s.remoteRefs();
    assert.equal(refs.get("refs/tags/v1.0"), s.me.sha("HEAD"));
    assert.ok(refs.has("refs/tags/v1.1"), "the annotated tag too");
    assert.ok((s.runs.find((a) => a[0] === "push") ?? []).includes("--tags"));
  } finally {
    s.cleanup();
  }
});

test("Push on a detached HEAD publishes nothing", async () => {
  const s = synced("detached");
  try {
    s.me.git("checkout", "-q", "--detach");
    s.me.write("d.txt", "d\n");
    s.me.commitAll("detached work");
    const before = s.remoteRefs();
    const ctx = s.ctx();
    const r = await ctx.sync.push();
    assert.equal(r.ok, false, "git has nothing to push a detached HEAD to");
    assert.deepEqual(s.remoteRefs(), before, "the remote is untouched");
    assert.equal(await ctx.sync.upstreamUnseen(), false, "and a detached HEAD has nothing tracked to be unseen");
    assert.equal(await ctx.sync.divergence(), null);
  } finally {
    s.cleanup();
  }
});

test("a renamed branch whose remote branch was deleted is neither re-published under its new name nor resurrected", async () => {
  const s = synced("gone");
  try {
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("g.txt", "g\n");
    s.me.commitAll("feat");
    s.me.git("push", "-q", "-u", "origin", "feat");
    // Merged and deleted on the remote, pruned here — the tracking config stays.
    s.me.git("push", "-q", "origin", "--delete", "feat");
    s.me.git("fetch", "-q", "--prune");
    s.me.git("branch", "-m", "feat", "feat-local");
    const ctx = s.ctx();
    assert.equal(await ctx.sync.currentUpstream(), null, "@{u} no longer resolves");
    const r = await ctx.sync.push();
    assert.equal(r.ok, false, "the push fails so the upstream can be repaired");
    const refs = s.remoteRefs();
    assert.equal(refs.has("refs/heads/feat"), false, "the deleted branch stays deleted");
    assert.equal(refs.has("refs/heads/feat-local"), false, "and nothing was published under the new name");
    assert.equal(s.me.git("config", "--get", "branch.feat-local.merge").trim(), "refs/heads/feat", "the tracking config is untouched");
  } finally {
    s.cleanup();
  }
});

// publishTarget's comment always said a tracked branch whose remote branch
// was deleted "must not be auto-published — let the push fail so the
// upstream-repair flow runs". It did return null, but push() then ran a bare
// `git push`, and with the tracking config intact git's push.default=simple
// pushed the branch to its (deleted) upstream name and re-created it:
// "* [new branch] feat -> feat", exit 0 (git 2.49). Only a branch whose local
// name differed from its upstream's (the test above) was protected.
test("Push on a branch whose remote branch was deleted does not resurrect it", async () => {
  const s = synced("gone-same");
  try {
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("g.txt", "g\n");
    s.me.commitAll("feat");
    s.me.git("push", "-q", "-u", "origin", "feat");
    s.me.git("push", "-q", "origin", "--delete", "feat");
    s.me.git("fetch", "-q", "--prune");
    const r = await s.ctx().sync.push();
    assert.equal(r.ok, false);
    assert.equal(s.remoteRefs().has("refs/heads/feat"), false, "the deleted branch stays deleted");
  } finally {
    s.cleanup();
  }
});

// The twin: the Branches view's Push names the branch, and the refspec built
// from its tracking config named the deleted remote branch outright.
test("pushing a branch BY NAME whose remote branch was deleted does not resurrect it either", async () => {
  const s = synced("gone-named");
  try {
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("g.txt", "g\n");
    s.me.commitAll("feat");
    s.me.git("push", "-q", "-u", "origin", "feat");
    s.me.git("push", "-q", "origin", "--delete", "feat");
    s.me.git("fetch", "-q", "--prune");
    s.me.git("checkout", "-q", "main");
    const r = await s.ctx().sync.push({ remote: "origin", branch: "feat" });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /no longer exists on the remote/);
    assert.equal(s.remoteRefs().has("refs/heads/feat"), false, "the deleted branch stays deleted");
    assert.equal(s.runs.some((a) => a[0] === "push"), false, "and git was never asked to push");
  } finally {
    s.cleanup();
  }
});

// What "gone" must NOT be confused with: in a single-branch (or shallow) clone
// the fetch refspec maps no remote-tracking ref for a pushed branch, so @{u}
// does not resolve although the remote branch is alive — and Push must still work.
test("in a single-branch clone, Push on a tracked branch with no remote-tracking ref still pushes", async () => {
  const s = synced("single");
  try {
    s.me.git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("g.txt", "g\n");
    s.me.commitAll("feat");
    s.me.git("push", "-q", "-u", "origin", "feat");
    s.me.write("g.txt", "g2\n");
    const tip = s.me.commitAll("feat, more");
    const ctx = s.ctx();
    assert.equal(await ctx.sync.currentUpstream(), null, "@{u} does not resolve here");
    const r = await ctx.sync.push();
    assert.equal(r.ok, true, r.stderr);
    assert.equal(s.remoteRefs().get("refs/heads/feat"), tip);
    const named = await ctx.sync.push({ remote: "origin", branch: "feat" });
    assert.equal(named.ok, true, named.stderr);
  } finally {
    s.cleanup();
  }
});

test("with no remote configured, Push fails instead of guessing and nothing is tracked", async () => {
  const r = makeRepo("noremote");
  try {
    r.write("f.txt", "x\n");
    r.commitAll("base");
    const ctx = r.ctx();
    const out = await ctx.sync.push();
    assert.equal(out.ok, false);
    assert.ok(out.stderr.length > 0, "with git's reason");
    assert.equal(r.tryGit("config", "--get", "branch.master.remote"), 1, "no upstream was written");
    assert.equal(await ctx.sync.upstreamUnseen(), false, "no upstream: nothing can be unseen");
    assert.equal(await ctx.sync.rewroteUpstream(), false, "no upstream: nothing was rewritten");
    assert.equal(await ctx.sync.upstreamTip(), null);
    assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 0, behind: 0 });
    assert.deepEqual(await ctx.sync.aheadBehind("master"), { ahead: 0, behind: 0 }, "a named branch with no upstream too");
  } finally {
    r.cleanup();
  }
});

/** A repo with the given remotes (each a fresh bare), on a new unpublished branch `topic`. */
function withRemotes(name: string, remotes: string[]): { r: ReturnType<typeof makeRepo>; bares: Record<string, string>; cleanup(): void } {
  const r = makeRepo(name);
  r.write("f.txt", "x\n");
  r.commitAll("base");
  const bares: Record<string, string> = {};
  for (const rem of remotes) {
    bares[rem] = bareRepo(`${name}-${rem}`);
    r.git("remote", "add", rem, bares[rem]);
  }
  r.git("checkout", "-q", "-b", "topic");
  r.write("t.txt", "t\n");
  r.commitAll("topic");
  return {
    r,
    bares,
    cleanup: () => {
      r.cleanup();
      for (const b of Object.values(bares)) removeTempRepo(b);
    },
  };
}

test("remote.pushDefault routes a first push to the fork, not to origin", async () => {
  const w = withRemotes("pushdefault", ["origin", "fork"]);
  try {
    w.r.git("config", "remote.pushDefault", "fork");
    const out = await w.r.ctx().sync.push();
    assert.equal(out.ok, true, out.stderr);
    assert.equal(refsOf(w.bares.fork).get("refs/heads/topic"), w.r.sha("topic"), "published to the fork");
    assert.equal(refsOf(w.bares.origin).has("refs/heads/topic"), false, "and not to origin");
    assert.equal(w.r.git("config", "--get", "branch.topic.remote").trim(), "fork", "tracking the fork");
  } finally {
    w.cleanup();
  }
});

test("a branch.<name>.pushRemote naming no configured remote is ignored in favour of origin", async () => {
  const w = withRemotes("pushremote", ["origin", "fork"]);
  try {
    w.r.git("config", "branch.topic.pushRemote", "nowhere");
    const out = await w.r.ctx().sync.push();
    assert.equal(out.ok, true, out.stderr);
    assert.ok(refsOf(w.bares.origin).has("refs/heads/topic"), "origin, the fallback");
    assert.equal(refsOf(w.bares.fork).has("refs/heads/topic"), false);
  } finally {
    w.cleanup();
  }
});

test("with several remotes and none called origin, a first push refuses to guess", async () => {
  const w = withRemotes("ambiguous", ["alpha", "beta"]);
  try {
    const out = await w.r.ctx().sync.push();
    assert.equal(out.ok, false);
    assert.equal(refsOf(w.bares.alpha).size, 0, "nothing reached alpha");
    assert.equal(refsOf(w.bares.beta).size, 0, "nothing reached beta");
  } finally {
    w.cleanup();
  }
});

test("the only remote is used for a first push even when it is not called origin", async () => {
  const w = withRemotes("single", ["upstream"]);
  try {
    const out = await w.r.ctx().sync.push({});
    assert.equal(out.ok, true, out.stderr);
    assert.equal(refsOf(w.bares.upstream).get("refs/heads/topic"), w.r.sha("topic"));
    assert.equal(w.r.git("config", "--get", "branch.topic.remote").trim(), "upstream");
  } finally {
    w.cleanup();
  }
});

test("fetch --all --prune brings in every remote's branches and drops ones deleted there", async () => {
  const s = synced("fetchall");
  const forkBare = bareRepo("fetchall-fork");
  try {
    s.me.git("remote", "add", "fork", forkBare);
    const o = s.other();
    o.git("checkout", "-q", "-b", "doomed");
    o.write("d.txt", "d\n");
    o.commitAll("doomed");
    o.git("push", "-q", "origin", "doomed");
    o.git("push", "-q", forkBare, "doomed:refs/heads/forked");
    s.me.git("fetch", "-q", "origin");
    assert.ok(s.me.git("for-each-ref", "refs/remotes/origin/doomed").trim(), "fixture: tracked before the delete");
    o.git("push", "-q", "origin", "--delete", "doomed");

    const ctx = s.ctx();
    const r = await ctx.sync.fetch({ all: true, prune: true });
    assert.equal(r.ok, true, r.stderr);
    assert.ok(s.me.git("for-each-ref", "refs/remotes/fork/forked").trim(), "the fork's branch arrived");
    assert.equal(s.me.git("for-each-ref", "refs/remotes/origin/doomed").trim(), "", "the deleted branch was pruned");
    const fetch = s.runs.find((a) => a[0] === "fetch");
    assert.deepEqual(fetch, ["fetch", "--all", "--prune"]);
  } finally {
    s.cleanup();
    removeTempRepo(forkBare);
  }
});

test("aheadBehind of a named branch counts against that branch's upstream", async () => {
  const s = synced("named-ab");
  try {
    s.me.git("checkout", "-q", "-b", "feat");
    s.me.write("a.txt", "a\n");
    s.me.commitAll("a");
    s.me.git("push", "-q", "-u", "origin", "feat");
    s.me.write("b.txt", "b\n");
    s.me.commitAll("b");
    s.me.write("c.txt", "c\n");
    s.me.commitAll("c");
    s.me.git("checkout", "-q", "main");
    assert.deepEqual(await s.ctx().sync.aheadBehind("feat"), { ahead: 2, behind: 0 });
  } finally {
    s.cleanup();
  }
});

test("a clone of an empty remote has no upstream to count against", async () => {
  const bare = bareRepo("empty");
  const c = cloneOf(bare, "empty");
  try {
    c.write("f.txt", "x\n");
    c.commitAll("first");
    const branch = c.git("symbolic-ref", "--short", "HEAD").trim();
    const ctx = c.ctx();
    assert.equal(await ctx.sync.currentUpstream(), null);
    assert.deepEqual(await ctx.sync.aheadBehind(branch), { ahead: 0, behind: 0 });
  } finally {
    c.cleanup();
    removeTempRepo(bare);
  }
});
