// What pressing Pull does when the branch has diverged — end to end, from the
// bridge arm the IPC handler calls down to real git, and back up through the
// renderer flow that turns the refusal into a question.
//
// Report #12: a GitStudio Desktop 1.4.0 user pressed Pull and got git's own
// terminal advice in a toast — "You have divergent branches and need to specify
// how to reconcile them", then three `git config` lines. Two things went wrong
// at once: the app had no answer for that state, AND `handle()` filed it as a
// crash report, because an ok:false result carrying a message is reported
// unless it is marked expected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { isExpectedError } from "../src/main/expectedError";
import { pullWithChoice } from "../src/renderer/pullFlow";
import type { PullActionResult, PullDivergence, PullMode } from "../src/shared/ipc";

/** A clone whose branch and upstream have each gained a commit of their own. */
function divergedRepo(): {
  work: string;
  git: (...a: string[]) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(`${tmpdir()}/gs-pull-`);
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  const work = `${root}/work`;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  const at =
    (cwd: string) =>
    (...a: string[]): string =>
      execFileSync("git", a, { cwd }).toString();
  const s = at(seed);
  for (const [k, v] of [
    ["user.email", "t@t"],
    ["user.name", "t"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
  ]) {
    s("config", k, v);
  }
  writeFileSync(`${seed}/base.txt`, "base\n");
  s("add", ".");
  s("commit", "-qm", "base");
  s("push", "-q", "origin", "main");

  execFileSync("git", ["clone", "-q", remote, work]);
  const git = at(work);
  for (const [k, v] of [
    ["user.email", "t@t"],
    ["user.name", "t"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
  ]) {
    git("config", k, v);
  }

  // Their commit, then ours. Note that nothing is FETCHED here: the clone's
  // origin/main is stale, exactly as it is for a user who has not fetched — so
  // the bridge cannot know about the divergence until its own pull does.
  writeFileSync(`${seed}/theirs.txt`, "theirs\n");
  s("add", ".");
  s("commit", "-qm", "theirs");
  s("push", "-q", "origin", "main");
  writeFileSync(`${work}/mine.txt`, "mine\n");
  git("add", ".");
  git("commit", "-qm", "mine");

  return { work, git, cleanup: () => removeTempRepo(root) };
}

async function bridgeOn(work: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(work);
  return new GitBridge(repos);
}

test("a diverged Pull asks instead of failing, and changes nothing", async () => {
  const { work, git, cleanup } = divergedRepo();
  try {
    const bridge = await bridgeOn(work);
    const head = git("rev-parse", "HEAD").trim();
    const r = await bridge.syncPull();

    assert.equal(r.ok, false);
    assert.deepEqual(r.diverged, {
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
    });
    // The message is ours and says what is true, with counts. Git's advice —
    // the thing the user was handed — must be nowhere in it.
    assert.match(r.message ?? "", /'main' and origin\/main have both moved on/);
    assert.match(r.message ?? "", /1 commit here, 1 commit there/);
    assert.doesNotMatch(r.message ?? "", /git config/);
    assert.doesNotMatch(r.message ?? "", /divergent branches/);

    assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing was pulled");
    assert.equal(git("status", "--porcelain").trim(), "", "no half-done merge");
    assert.equal(r.changed, false, "…so the graph is not told to refresh");
  } finally {
    cleanup();
  }
});

// The second half of report #12. `handle()` crash-reports any ok:false result
// with a message unless it carries `expected`, so without this the fix would
// have kept filing a report on every press — only with nicer wording.
test("the divergence answer is not crash-report material", async () => {
  const { work, cleanup } = divergedRepo();
  try {
    const bridge = await bridgeOn(work);
    const r = await bridge.syncPull();
    assert.equal(r.expected, true);
    assert.equal(isExpectedError(r), true, "the reporter's own predicate agrees");
  } finally {
    cleanup();
  }
});

test("picking merge performs the merge, and picking rebase the rebase", async () => {
  for (const mode of ["merge", "rebase"] as const) {
    const { work, git, cleanup } = divergedRepo();
    try {
      const bridge = await bridgeOn(work);
      assert.ok((await bridge.syncPull()).diverged, "precondition: it asks");

      const r = await bridge.syncPull({ mode });
      assert.ok(r.ok, r.message);
      assert.equal(r.changed, true);
      assert.equal(r.diverged, undefined, "a pull that named its mode never asks again");

      const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/);
      assert.equal(parents.length, mode === "merge" ? 3 : 2, `${mode} shaped history`);
      // And the choice stayed a choice: nothing was written into the repo's
      // config, so the next pull asks again rather than silently repeating it.
      for (const key of ["pull.rebase", "pull.ff", "branch.main.rebase"]) {
        let set: string | undefined;
        try {
          set = git("config", "--get", key).trim();
        } catch {
          set = undefined;
        }
        assert.equal(set, undefined, `${mode} must not write ${key}`);
      }
    } finally {
      cleanup();
    }
  }
});

// `mode` is typed on the channel, but a type is not a check — what arrives is
// whatever the renderer sent, and it chooses a command-line flag. Before this
// arm existed syncPull took no arguments at all; the bridge's own arg-guard
// census is what noticed it had started taking one.
test("a mode the app does not offer never reaches git", async () => {
  const { work, git, cleanup } = divergedRepo();
  try {
    const bridge = await bridgeOn(work);
    const head = git("rev-parse", "HEAD").trim();
    const r = await bridge.syncPull({ mode: "--upload-pack=evil" as PullMode });

    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
    assert.equal(r.diverged, undefined, "a refused request is not a question");
    assert.equal(r.expected, true, "…and a renderer bug is not a user's crash report");
    assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing ran");
  } finally {
    cleanup();
  }
});

// ── the renderer's half, DOM-free ───────────────────────────────────────────
// Both doors onto Pull — the top bar's widget and the Branches list's ↓ pill —
// go through pullWithChoice, for the reason askForCommitAction exists: a
// question that lives inside one door is a question the other does not ask.

const DIVERGED: PullDivergence = {
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 3,
};

function fakePull(first: PullActionResult) {
  const calls: (PullMode | undefined)[] = [];
  return {
    calls,
    pull: async (o: { mode?: PullMode } | undefined): Promise<PullActionResult> => {
      calls.push(o?.mode);
      return o?.mode ? { ok: true, changed: true } : first;
    },
  };
}

test("a clean pull asks nothing at all", async () => {
  const f = fakePull({ ok: true, changed: true });
  const out = await pullWithChoice({
    pull: f.pull,
    ask: async () => {
      throw new Error("must not ask when git managed on its own");
    },
  });
  assert.equal(out.result.ok, true);
  assert.equal(out.cancelled, false);
  assert.deepEqual(f.calls, [undefined], "one call, no mode");
});

test("a diverged pull asks, then retries with exactly what was picked", async () => {
  const f = fakePull({ ok: false, changed: false, expected: true, diverged: DIVERGED });
  let asked: PullDivergence | undefined;
  const out = await pullWithChoice({
    pull: f.pull,
    ask: async (d) => {
      asked = d;
      return "rebase";
    },
  });
  assert.deepEqual(asked, DIVERGED, "the question carries the counts to show");
  assert.deepEqual(f.calls, [undefined, "rebase"]);
  assert.equal(out.result.ok, true);
  assert.equal(out.mode, "rebase");
  assert.equal(out.cancelled, false);
});

test("cancelling runs nothing more and is not a failure", async () => {
  const f = fakePull({ ok: false, changed: false, expected: true, diverged: DIVERGED });
  const out = await pullWithChoice({ pull: f.pull, ask: async () => undefined });
  assert.deepEqual(f.calls, [undefined], "no second pull");
  assert.equal(out.cancelled, true);
  // The caller must read `cancelled` and return: toasting `result.message`
  // would show "choose how to combine them" to someone who just chose not to.
  assert.equal(out.result.ok, false);
});

// One retry by construction. A mode-ful pull cannot come back `diverged` — the
// engine test pins that — but if it ever did, this must not become a loop the
// user cannot leave.
test("the retry is never asked twice", async () => {
  let calls = 0;
  let asks = 0;
  const out = await pullWithChoice({
    pull: async () => {
      calls++;
      return { ok: false, changed: false, expected: true, diverged: DIVERGED };
    },
    ask: async () => {
      asks++;
      return "merge";
    },
  });
  assert.equal(calls, 2);
  assert.equal(asks, 1);
  assert.equal(out.result.ok, false, "and the second failure is reported as one");
});
