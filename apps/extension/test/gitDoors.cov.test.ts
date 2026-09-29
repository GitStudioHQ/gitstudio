// The small shared doors in src/git that every pull, push and repository
// picker goes through: what they say, the one button each offers and where it
// leads, the words for an operation already in progress, the built-in git
// API's lookup, a worktree's context, and Switch Repository's edge cases.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerWith,
  asked,
  commandsRun,
  committedRepo,
  resetRecorders,
  said,
  vs,
  withRemote,
} from "./commitViewCovKit";

/* eslint-disable @typescript-eslint/no-require-imports -- the stand-in is in place (commitViewCovKit) */
const pullMode = require("../src/git/pullMode") as typeof import("../src/git/pullMode");
const paused = require("../src/git/pausedForUser") as typeof import("../src/git/pausedForUser");
const pauseNotice = require("../src/git/pauseNotice") as typeof import("../src/git/pauseNotice");
const { worktreeEntry } = require("../src/git/worktreeContext") as typeof import("../src/git/worktreeContext");
const { getBuiltInGitApi } = require("../src/git/builtInGit") as typeof import("../src/git/builtInGit");
const { switchRepository, FOLLOW_EDITOR_ID } = require("../src/git/repoPicker") as typeof import("../src/git/repoPicker");
const { applyOrAsk, pullOrAsk } = require("../src/git/inTheWay") as typeof import("../src/git/inTheWay");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { STASH_GONE_MESSAGE } = require("@gitstudio/git-service/StashProvider") as typeof import("@gitstudio/git-service/StashProvider");
/* eslint-enable @typescript-eslint/no-require-imports */

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  answerWith(() => "ok");
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

/** Answer the next warnings with `pick`, recording them as the stand-in does. */
function warningsAnswer(pick: string | undefined): () => void {
  const original = vs.window.showWarningMessage;
  vs.window.showWarningMessage = (message: string, ...actions: string[]) => {
    vs.__said.push({ kind: "warning", message });
    return Promise.resolve(actions.includes(pick ?? "") ? pick : undefined);
  };
  return () => {
    vs.window.showWarningMessage = original;
  };
}

// ── pullMode ─────────────────────────────────────────────────────────────────

test("settlePushUnseen: only a refused-unseen push is settled, and its Pull button runs Pull", async () => {
  assert.equal(pullMode.settlePushUnseen({}), false);
  assert.deepEqual(said("warning"), []);
  const restore = warningsAnswer("Pull");
  try {
    assert.equal(pullMode.settlePushUnseen({ unseen: true }), true);
    await until(() => commandsRun.some((c) => c.id === "gitstudio.sync.pull"));
  } finally {
    restore();
  }
  assert.equal(said("warning").length, 1);
  assert.match(said("warning")[0], /^GitStudio: /);
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.sync.pull"));
});

test("settlePushUnseen: a warning dismissed runs nothing", async () => {
  const restore = warningsAnswer(undefined);
  try {
    assert.equal(pullMode.settlePushUnseen({ unseen: true }), true);
    await new Promise((r) => setImmediate(r));
  } finally {
    restore();
  }
  assert.equal(commandsRun.length, 0);
});

test("settlePullDetached: a pull on a detached HEAD is settled, and Check Out a Branch… leads to the branch UI", async () => {
  let checkedOut = 0;
  assert.equal(pullMode.settlePullDetached({}, () => checkedOut++), false);
  const restore = warningsAnswer("Check Out a Branch…");
  try {
    assert.equal(pullMode.settlePullDetached({ detached: true }, () => checkedOut++), true);
    await until(() => checkedOut > 0);
  } finally {
    restore();
  }
  assert.equal(checkedOut, 1);
  assert.match(said("warning")[0], /^GitStudio: /);
});

test("settlePullStop: uncommitted work in the pull's way is a plain warning and a trip to Changes, not a pause", async () => {
  assert.equal(pullMode.settlePullStop({}), false);
  const settled = pullMode.settlePullStop({ dirty: { paths: ["a.txt"] } } as never);
  assert.equal(settled, true);
  assert.equal(said("warning").length, 1);
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.commit.focus"));
});

// ── pausedForUser / pauseNotice ──────────────────────────────────────────────

test("the words for an operation already in progress name each kind, and say nothing when nothing is", () => {
  const m = paused.operationInProgressMessage;
  assert.equal(m({ kind: "am", unmerged: 0 }), "Applying patches (git am) is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "stash", unmerged: 0 }), "Applying a stash is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "merge", unmerged: 1 }), "A merge is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "cherry-pick", unmerged: 0 }), "A cherry-pick is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "revert", unmerged: 0 }), "A revert is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "bisect", unmerged: 0 }), "An operation is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "rebase-merge-step", unmerged: 2 }), "A rebase is already in progress — continue or abort it first.");
  assert.equal(m({ kind: "none", unmerged: 1 }), "There are unresolved conflicts — resolve them or cancel first.");
  assert.equal(m({ kind: "none", unmerged: 0 }), undefined);
});

test("detectOperation never throws: a failed read is 'nothing in progress'", async () => {
  const none = await pauseNotice.detectOperation({
    operation: {
      detect: async () => {
        throw new Error("not a repository");
      },
    },
  });
  assert.deepEqual(none, { kind: "none", unmerged: 0 });
  const merge = await pauseNotice.detectOperation({ operation: { detect: async () => ({ kind: "merge", unmerged: 1 }) } });
  assert.deepEqual(merge, { kind: "merge", unmerged: 1 });
});

// ── worktreeContext ──────────────────────────────────────────────────────────

test("a worktree the window has open is that entry; one it has not gets its own context, let go by release", () => {
  const r = committedRepo("git-wt");
  cleanups.push(r.done);
  const wt = join(r.dir, "..", `${r.dir.split(/[\\/]/).pop()}-wt`);
  r.git("worktree", "add", "-q", "-b", "wt", wt);
  cleanups.push(() => {
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* the system's temp cleanup takes it */
    }
  });
  const ctx = new GitContext({ root: r.dir });
  cleanups.push(() => ctx.dispose());
  const active = { root: r.dir, ctx };
  const openOne = { root: wt, ctx };
  const both = worktreeEntry({ getActive: () => active as never, getAll: () => [active, openOne] as never }, wt);
  assert.equal(both?.open, true);
  assert.equal(both?.entry, openOne);

  const made = worktreeEntry({ getActive: () => active as never }, wt);
  assert.ok(made);
  assert.equal(made.open, false);
  assert.equal(made.entry.root, wt);
  assert.notEqual(made.entry.ctx, ctx, "a context of its own");
  assert.equal(made.entry.ctx.root, wt);
  made.release();

  assert.equal(worktreeEntry({ getActive: () => undefined }, wt), undefined, "no repository, no context to make one from");
});

// ── builtInGit ───────────────────────────────────────────────────────────────
// The API handle is cached for the module's life, so these run in order and
// the one that finds it comes last.

test("the built-in git API is undefined when vscode.git is missing, disabled, or throws", async () => {
  const ext = vs as unknown as { extensions: Record<string, unknown> };
  ext.extensions.getExtension = () => undefined;
  assert.equal(await getBuiltInGitApi(), undefined);
  ext.extensions.getExtension = () => ({ isActive: true, exports: { enabled: false, getAPI: () => ({}) } });
  assert.equal(await getBuiltInGitApi(), undefined);
  ext.extensions.getExtension = () => {
    throw new Error("extension host is shutting down");
  };
  assert.equal(await getBuiltInGitApi(), undefined);
});

test("an inactive vscode.git is activated, and its API is asked for once and kept", async () => {
  const ext = vs as unknown as { extensions: Record<string, unknown> };
  const api = { marker: "v1" };
  let activated = 0;
  let looked = 0;
  const versions: number[] = [];
  ext.extensions.getExtension = (id: string) => {
    looked++;
    assert.equal(id, "vscode.git");
    return {
      isActive: false,
      activate: async () => {
        activated++;
        return {
          enabled: true,
          getAPI: (v: number) => {
            versions.push(v);
            return api;
          },
        };
      },
    };
  };
  assert.equal(await getBuiltInGitApi(), api);
  assert.equal(await getBuiltInGitApi(), api);
  assert.equal(activated, 1);
  assert.equal(looked, 1, "cached after the first answer");
  assert.deepEqual(versions, [1]);
});

// ── Switch Repository ────────────────────────────────────────────────────────

function fakeRepos(entries: { root: string; repo?: unknown }[], opts: { picked?: string; setActive?: (root: string | undefined) => boolean } = {}) {
  const set: (string | undefined)[] = [];
  return {
    set,
    repos: {
      getAll: () => entries,
      getActive: () => entries[0],
      getPicked: () => opts.picked,
      setActive: (root: string | undefined) => {
        set.push(root);
        return opts.setActive ? opts.setActive(root) : true;
      },
    } as never,
  };
}

test("Switch Repository with none open says so and asks nothing", async () => {
  await switchRepository(fakeRepos([]).repos);
  assert.equal(asked.length, 0);
  assert.deepEqual(said("info"), ["GitStudio: No repository is open."]);
});

test("Switch Repository names a detached repository by where it is, and a pick that closed meanwhile is said", async () => {
  const detached = { state: { HEAD: { commit: "abcdef1234567890" }, mergeChanges: [], indexChanges: [], workingTreeChanges: [] } };
  const { repos, set } = fakeRepos(
    [
      { root: join("/", "work", "api"), repo: detached },
      { root: join("/", "work", "web") },
    ],
    { setActive: () => false },
  );
  answerWith(() => join("/", "work", "web"));
  await switchRepository(repos);
  const choices = (asked[0] as { choices: { id: string; description?: string }[] }).choices;
  const api = choices.find((c) => c.id === join("/", "work", "api"));
  assert.match(String(api?.description), /detached at abcdef1$/);
  assert.deepEqual(set, [join("/", "work", "web")]);
  assert.deepEqual(said("info"), ["GitStudio: web is no longer open, so it can't be shown."]);
});

test("Switch Repository's Follow the active editor drops the pick; dismissing changes nothing", async () => {
  const picked = join("/", "work", "api");
  const { repos, set } = fakeRepos([{ root: picked }, { root: join("/", "work", "web") }], { picked });
  answerWith(() => FOLLOW_EDITOR_ID);
  await switchRepository(repos);
  assert.match(String((asked[0] as { hint?: string }).hint), /stay on api until you pick again/);
  assert.deepEqual(set, [undefined]);
  answerWith(() => undefined);
  await switchRepository(repos);
  assert.deepEqual(set, [undefined], "dismissed: no change");
});

// ── The shared door (inTheWay) ───────────────────────────────────────────────

test("a stash applied by a sha that has left the list runs nothing and says it is gone", async () => {
  const r = committedRepo("git-stash-gone");
  cleanups.push(r.done);
  const ctx = new GitContext({ root: r.dir });
  cleanups.push(() => ctx.dispose());
  const applied = await applyOrAsk(ctx, { kind: "stash", stash: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(applied.settled, true);
  assert.equal(applied.gone, true);
  assert.deepEqual(said("info"), [`GitStudio: ${STASH_GONE_MESSAGE}`]);
});

test("a stash restored with its staging over the user's own staged changes is not run: the index is busy", async () => {
  const r = committedRepo("git-stash-index-busy");
  cleanups.push(r.done);
  r.write("a.txt", "stashed\n");
  r.git("add", "a.txt");
  r.git("stash", "push", "-q", "-m", "staged work");
  const sha = r.git("rev-parse", "stash@{0}").trim();
  r.write("b.txt", "mine, staged\n");
  r.git("add", "b.txt");
  const ctx = new GitContext({ root: r.dir });
  cleanups.push(() => ctx.dispose());
  const applied = await applyOrAsk(ctx, { kind: "stash", stash: sha, index: true });
  assert.equal(applied.staging, "busy");
  assert.equal(r.git("show", ":a.txt"), "a\n", "nothing was applied");
  assert.equal(r.git("show", ":b.txt"), "mine, staged\n", "the user's staging is untouched");
});

test("Stash & Retry over a pull whose incoming change collides with the stashed edit says where the edit went", async () => {
  const r = committedRepo("git-pull-note");
  cleanups.push(r.done);
  const remote = withRemote(r);
  cleanups.push(remote.done);
  // Another clone moves a.txt on the remote…
  const other = committedRepo("git-pull-note-other");
  cleanups.push(other.done);
  other.git("remote", "add", "origin", remote.bare);
  other.git("fetch", "-q", "origin");
  other.git("reset", "-q", "--hard", "origin/main");
  writeFileSync(join(other.dir, "a.txt"), "theirs\n");
  other.git("commit", "-qam", "theirs");
  other.git("push", "-q", "origin", "HEAD:main");
  // …while a.txt is edited here, uncommitted.
  r.write("a.txt", "mine, uncommitted\n");
  const ctx = new GitContext({ root: r.dir });
  cleanups.push(() => ctx.dispose());
  answerWith(() => "stash");
  const pulled = await pullOrAsk(ctx);
  assert.equal(asked[0].title, "Your uncommitted changes are in the way");
  assert.ok(pulled, "the pull ran after the stash");
  assert.equal(r.git("log", "-1", "--format=%s").trim(), "theirs");
  const warnings = said("warning");
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.match(warnings[0], /^GitStudio: Your changes to a\.txt /);
  assert.match(r.git("stash", "list"), /./, "the edit is kept in a stash");
});
