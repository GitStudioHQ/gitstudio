import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictOps } from "@gitstudio/git-service/ConflictOps";
import { GitContext } from "@gitstudio/git-service/GitContext";
import type { OperationDetection } from "@gitstudio/git-service/OperationProvider";
import type { OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import { MergeSession, type MergeSessionDeps, type SessionGit } from "../src/mergeSession";
import { git, mergeConflict, removeTemp, view } from "./fixtures";

// The merge editor's message sequencing (S0 contract §3), with fakes for the
// git surface — plus Apply against REAL git, where `git add` is refused.

interface Harness {
  posts: HostMessage[];
  notes: { kind: string; text: string }[];
  calls: string[];
  deps: MergeSessionDeps;
}

function fakeGit(over: {
  addCode?: number;
  view?: OperationView;
  detect?: OperationDetection;
  continueOutcome?: OperationOutcome;
  abortOutcome?: OperationOutcome;
  stillConflicted?: boolean;
  calls: string[];
}): SessionGit {
  const v = over.view ?? view("rebase", { canContinue: false });
  return {
    operation: {
      view: async () => v,
      detect: async () => over.detect ?? { kind: v.kind, unmerged: 1 },
      continue: async (o) => {
        over.calls.push(`continue:${o?.confirmDrop ? "drop" : "keep"}`);
        return over.continueOutcome!;
      },
      abort: async () => {
        over.calls.push("abort");
        return over.abortOutcome!;
      },
    },
    conflictOps: {
      readSides: async (path) => ({
        op: v,
        path,
        shape: "text",
        hasBase: true,
        source: "git-stages",
        base: "b\n",
        yours: "y\n",
        theirs: "t\n",
      }),
      takeRole: async (path, role) => {
        over.calls.push(`takeRole:${path}:${role}`);
        return { ok: true, changed: true };
      },
      deleteFile: async (path) => {
        over.calls.push(`delete:${path}`);
        return { ok: false, changed: false, expected: true, message: "Not a both-deleted file." };
      },
      noteChoice: (path, choice) => over.calls.push(`note:${path}:${choice}`),
      restore: async (path) => {
        over.calls.push(`restore:${path}`);
        return { ok: true, changed: true };
      },
    },
    conflict: { isConflicted: async () => over.stillConflicted ?? false },
    process: {
      run: async (args) => {
        over.calls.push(`git ${args.join(" ")}`);
        const code = over.addCode ?? 0;
        return { code, stderr: code === 0 ? "" : "fatal: Unable to create '.git/index.lock': File exists.\n" };
      },
    },
  };
}

function harness(git?: SessionGit, extra: Partial<MergeSessionDeps> = {}, calls: string[] = []): Harness {
  const posts: HostMessage[] = [];
  const notes: { kind: string; text: string }[] = [];
  const deps: MergeSessionDeps = {
    git,
    rel: git ? "a.txt" : undefined,
    fileName: "/r/a.txt",
    workingText: () => "<<<<<<< ours\ny\n=======\nt\n>>>>>>> theirs\n",
    save: async (text) => {
      calls.push(`save:${text}`);
    },
    post: (m) => posts.push(m),
    settings: () => ({ autoApplyNonConflicting: false }),
    jetbrainsName: () => undefined,
    notify: (kind, text) => notes.push({ kind, text }),
    ...extra,
  };
  return { posts, notes, calls, deps };
}

const outcome = (o: Partial<OperationOutcome>): OperationOutcome => ({
  ok: false,
  view: view("none"),
  remainingConflicts: 0,
  ...o,
});

test("Apply: save → git add (exit 0) → noteChoice merged → applied{staged:true} → opChanged", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls }), {}, calls);
  await new MergeSession(h.deps).apply("resolved\n");
  assert.deepEqual(calls, ["save:resolved\n", "git add -- a.txt", "note:a.txt:merged"]);
  assert.deepEqual(
    h.posts.map((p) => p.type),
    ["applied", "opChanged"],
    "applied first, then the re-read operation",
  );
  assert.deepEqual(h.posts[0], { type: "applied", staged: true, message: undefined });
  const changed = h.posts[1] as Extract<HostMessage, { type: "opChanged" }>;
  assert.equal(changed.remainingConflicts, 1);
  assert.equal(changed.op.kind, "rebase");
});

test("Apply: a refused `git add` (non-zero exit) is staged:false with git's reason — never 'staged'", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls, addCode: 128 }), {}, calls);
  await new MergeSession(h.deps).apply("resolved\n");
  const applied = h.posts[0] as Extract<HostMessage, { type: "applied" }>;
  assert.equal(applied.type, "applied");
  assert.equal(applied.staged, false);
  assert.match(applied.message ?? "", /could not stage it \(Unable to create '\.git\/index\.lock': File exists\.\)/);
  assert.ok(!calls.some((c) => c.startsWith("note:")), "an unstaged file is not recorded as merged");
  assert.ok(h.notes.some((n) => n.kind === "warn"), "the user is warned");
  assert.ok(!h.notes.some((n) => /staged/.test(n.text) && n.kind === "info"));
});

test("Apply: a save that fails stops before git and says so", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls }),
    {
      save: async () => {
        throw new Error("disk full");
      },
    },
    calls,
  );
  await new MergeSession(h.deps).apply("x");
  assert.deepEqual(calls, []);
  assert.equal(h.posts.length, 1);
  assert.equal((h.posts[0] as { staged: boolean }).staged, false);
  assert.match((h.posts[0] as { message?: string }).message ?? "", /disk full/);
});

test("Apply outside a repository saves and says there is nothing to stage", async () => {
  const h = harness(undefined);
  await new MergeSession(h.deps).apply("x");
  assert.deepEqual(h.posts, [
    {
      type: "applied",
      staged: false,
      message: "Saved. This file is not in a Git repository, so there is nothing to stage.",
    },
  ]);
});

test("Apply runs inside the product's undo envelope when there is one", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls }),
    {
      withUndo: async (label, fn) => {
        calls.push(`undo:${label}`);
        return fn();
      },
    },
    calls,
  );
  await new MergeSession(h.deps).apply("r");
  assert.equal(calls[0], "undo:Apply merge resolution");
});

test("takeRole: ConflictOps.takeRole, then applied and opChanged", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls }), {}, calls);
  await new MergeSession(h.deps).takeRole("yours");
  assert.deepEqual(calls, ["takeRole:a.txt:yours"]);
  assert.deepEqual(h.posts.map((p) => p.type), ["applied", "opChanged"]);
  assert.equal((h.posts[0] as { staged: boolean }).staged, true);
});

test("deleteFile: an expected refusal is reported inline, not as an error toast", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls }), {}, calls);
  await new MergeSession(h.deps).deleteFile();
  assert.deepEqual(calls, ["delete:a.txt"]);
  assert.deepEqual(h.posts[0], { type: "applied", staged: false, message: "Not a both-deleted file." });
  assert.equal(h.notes.filter((n) => n.kind === "error").length, 0);
});

test("Continue that finishes: outcome 'done' then opChanged; no re-init", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls, continueOutcome: outcome({ ok: true, view: view("none") }) }),
    {},
    calls,
  );
  await new MergeSession(h.deps).continueOperation();
  assert.deepEqual(calls, ["continue:keep"]);
  assert.deepEqual(h.posts.map((p) => p.type), ["outcome", "opChanged"]);
  assert.deepEqual(h.posts[0], { type: "outcome", kind: "done", text: "Rebase complete." });
});

test("Continue that stops on the next commit conflicting in THIS file: outcome, opChanged, then a fresh init from disk", async () => {
  const calls: string[] = [];
  const next = view("rebase", { episode: "rebase:2", step: { n: 2, m: 3, unit: "commit" } });
  const h = harness(
    fakeGit({
      calls,
      stillConflicted: true,
      continueOutcome: outcome({ ok: false, stopped: true, expected: true, view: next, remainingConflicts: 1 }),
    }),
    { diskText: async () => "from disk\n" },
    calls,
  );
  await new MergeSession(h.deps).continueOperation(true);
  assert.deepEqual(calls, ["continue:drop"]);
  assert.deepEqual(h.posts.map((p) => p.type), ["outcome", "opChanged", "init"]);
  assert.deepEqual(h.posts[0], {
    type: "outcome",
    kind: "stopped",
    text: "Stopped at commit 2 of 3 — it has conflicts to resolve.",
  });
  const init = h.posts[2] as Extract<HostMessage, { type: "init" }>;
  assert.equal(init.result, "from disk\n", "the re-init reads what git wrote, not the stale document");
});

test("Continue refused with a reason: outcome 'failed' carrying the reason", async () => {
  const calls: string[] = [];
  const blocked = view("rebase", { continueBlocked: "a.txt still has conflict markers staged" });
  const h = harness(
    fakeGit({
      calls,
      continueOutcome: outcome({ refused: "blocked", expected: true, view: blocked, remainingConflicts: 0 }),
    }),
    {},
    calls,
  );
  await new MergeSession(h.deps).continueOperation();
  assert.deepEqual(h.posts[0], {
    type: "outcome",
    kind: "failed",
    text: "a.txt still has conflict markers staged",
  });
});

test("Abort: saves the conflicted documents first, then aborts, then closes the merge tabs", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls, abortOutcome: outcome({ ok: true, view: view("none") }) }),
    {
      beforeAbort: async () => {
        calls.push("save-conflicted");
      },
      afterAbort: async () => {
        calls.push("close-tabs");
      },
    },
    calls,
  );
  await new MergeSession(h.deps).abortOperation();
  assert.deepEqual(calls, ["save-conflicted", "abort", "close-tabs"]);
  assert.deepEqual(h.posts[0], {
    type: "outcome",
    kind: "done",
    text: "Rebase cancelled — the repository is back where it was before.",
  });
});

test("REAL git: Apply while a stale index.lock blocks `git add` reports staged:false and leaves the file unmerged", async () => {
  const r = mergeConflict();
  const ctx = new GitContext({ root: r.repo });
  const posts: HostMessage[] = [];
  const notes: string[] = [];
  const source = { view: async () => view("merge") };
  const session = new MergeSession({
    git: {
      operation: {
        view: source.view,
        detect: async () => ({ kind: "merge", unmerged: (await ctx.conflict.listConflicts()).length }),
        continue: async () => outcome({}),
        abort: async () => outcome({}),
      },
      conflictOps: new ConflictOps(ctx.process, r.repo, ctx.conflict, source),
      conflict: ctx.conflict,
      process: ctx.process,
    },
    rel: "a.txt",
    fileName: join(r.repo, "a.txt"),
    workingText: () => readFileSync(join(r.repo, "a.txt"), "utf8"),
    save: async (text) => writeFileSync(join(r.repo, "a.txt"), text),
    post: (m) => posts.push(m),
    settings: () => ({ autoApplyNonConflicting: false }),
    jetbrainsName: () => undefined,
    notify: (_k, t) => notes.push(t),
  });
  try {
    writeFileSync(join(r.repo, ".git", "index.lock"), "");
    await session.apply("one\ntwo\nthree-merged\nfour\n");
    const applied = posts.find((p) => p.type === "applied") as Extract<HostMessage, { type: "applied" }>;
    assert.equal(applied.staged, false, "git refused — the file is NOT staged");
    assert.match(applied.message ?? "", /index\.lock/);
    assert.match(git(r.repo, "ls-files", "-u", "--", "a.txt"), /a\.txt/, "still unmerged in git");
    const changed = posts.find((p) => p.type === "opChanged") as Extract<HostMessage, { type: "opChanged" }>;
    assert.equal(changed.remainingConflicts, 1);
  } finally {
    ctx.dispose();
    removeTemp(r.dir);
  }
});

test("REAL git: Apply stages the resolution and git agrees", async () => {
  const r = mergeConflict();
  const ctx = new GitContext({ root: r.repo });
  const posts: HostMessage[] = [];
  const source = { view: async () => view("merge") };
  const session = new MergeSession({
    git: {
      operation: {
        view: source.view,
        detect: async () => ({ kind: "merge", unmerged: (await ctx.conflict.listConflicts()).length }),
        continue: async () => outcome({}),
        abort: async () => outcome({}),
      },
      conflictOps: new ConflictOps(ctx.process, r.repo, ctx.conflict, source),
      conflict: ctx.conflict,
      process: ctx.process,
    },
    rel: "a.txt",
    fileName: join(r.repo, "a.txt"),
    workingText: () => readFileSync(join(r.repo, "a.txt"), "utf8"),
    save: async (text) => writeFileSync(join(r.repo, "a.txt"), text),
    post: (m) => posts.push(m),
    settings: () => ({ autoApplyNonConflicting: false }),
    jetbrainsName: () => undefined,
    notify: () => {},
  });
  try {
    await session.apply("one\ntwo\nthree-merged\nfour\n");
    const applied = posts.find((p) => p.type === "applied") as Extract<HostMessage, { type: "applied" }>;
    assert.equal(applied.staged, true);
    assert.equal(git(r.repo, "ls-files", "-u", "--", "a.txt"), "", "no longer unmerged");
    assert.equal(git(r.repo, "show", ":a.txt"), "one\ntwo\nthree-merged\nfour\n");
    const changed = posts.find((p) => p.type === "opChanged") as Extract<HostMessage, { type: "opChanged" }>;
    assert.equal(changed.remainingConflicts, 0);
  } finally {
    ctx.dispose();
    removeTemp(r.dir);
  }
});

test("no undo envelope (Merge Studio): Apply offers Undo, and Undo re-creates the conflict and re-inits", async () => {
  const calls: string[] = [];
  let undo: (() => Promise<void>) | undefined;
  const h = harness(
    fakeGit({ calls, stillConflicted: true }),
    {
      offerUndo: (text, fn) => {
        calls.push(`offer:${text}`);
        undo = fn;
      },
      diskText: async () => "<<<<<<< ours\nback\n=======\nagain\n>>>>>>> theirs\n",
    },
    calls,
  );
  const session = new MergeSession(h.deps);
  await session.apply("resolved\n");
  assert.ok(calls.includes("offer:resolved file saved and staged."), calls.join(" | "));
  assert.ok(!h.notes.some((n) => n.text === "resolved file saved and staged."), "offered, not flashed");
  h.posts.length = 0;
  await undo!();
  assert.ok(calls.includes("restore:a.txt"));
  assert.deepEqual(h.posts.map((p) => p.type), ["opChanged", "init"], "the shell is told, then shown the conflict again");
});

test("an Apply on a file with NO conflict ('Reopen With…') runs in the product's envelope and offers nothing extra", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls, stillConflicted: false }),
    {
      withUndo: async (_label, fn) => {
        calls.push("envelope");
        return fn();
      },
      offerUndo: () => {
        calls.push("offer");
      },
      diskText: async () => "resolved\n",
    },
    calls,
  );
  await new MergeSession(h.deps).apply("resolved\n");
  assert.ok(calls.includes("envelope"));
  assert.ok(!calls.includes("offer"), "no conflict to bring back, so no conflict-restoring Undo");
});

test("an Apply that RESOLVES a conflict offers the conflict-restoring Undo in every product — the envelope is skipped", async () => {
  // GitStudio's envelope is the UndoLedger, which snapshots with `git stash
  // create`; git refuses that while any path is unmerged (see the REAL git
  // test below), so wrapping a conflict resolution in it recorded nothing and
  // GitStudio's Apply had no undo at all.
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls, stillConflicted: true }),
    {
      withUndo: async (_label, fn) => {
        calls.push("envelope");
        return fn();
      },
      offerUndo: (text) => {
        calls.push(`offer:${text}`);
      },
      diskText: async () => "resolved\n",
    },
    calls,
  );
  await new MergeSession(h.deps).apply("resolved\n");
  assert.ok(!calls.includes("envelope"), calls.join(" | "));
  assert.ok(calls.includes("offer:resolved file saved and staged."), calls.join(" | "));
});

test("REAL git: the ledger's snapshot cannot be taken while a path is unmerged (why a resolution is not wrapped in it)", async () => {
  const r = mergeConflict();
  const ctx = new GitContext({ root: r.repo });
  try {
    await assert.rejects(ctx.snapshot.capture("Apply merge resolution"), /stash create/);
  } finally {
    ctx.dispose();
    removeTemp(r.dir);
  }
});

/** A SessionGit whose stop, HEAD and restore the test moves by hand. */
function movableGit(state: { episode: string; head: string; calls: string[] }): SessionGit {
  const base = fakeGit({ calls: state.calls, stillConflicted: true });
  return {
    ...base,
    operation: {
      ...base.operation,
      view: async () => view("merge", { episode: state.episode }),
    },
    process: {
      run: async (args) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: `${state.head}\n`, stderr: "" };
        state.calls.push(`git ${args.join(" ")}`);
        return { code: 0, stderr: "" };
      },
    },
  };
}

for (const [what, move] of [
  ["git's stop moved on (the merge was concluded / the rebase went to the next commit)", (s: { episode: string }) => (s.episode = "none")],
  ["HEAD moved (a commit was made; a stash stop keeps the same episode)", (s: { head: string }) => (s.head = "c0ffee2")],
] as const) {
  test(`a late Undo refuses when ${what}: nothing is restored`, async () => {
    const state = { episode: "merge:abc", head: "c0ffee1", calls: [] as string[] };
    let undo: (() => Promise<void>) | undefined;
    const h = harness(movableGit(state), {
      offerUndo: (_t, fn) => (undo = fn),
      diskText: async () => "resolved\n",
    });
    const session = new MergeSession(h.deps);
    await session.apply("resolved\n");
    assert.ok(undo, "offered");
    move(state as never);
    h.posts.length = 0;
    await undo!();
    assert.ok(!state.calls.some((c) => c.startsWith("restore:")), state.calls.join(" | "));
    // The editor is not re-initialised; its own Undo (beside Apply) is told
    // why nothing happened, in place.
    assert.deepEqual(h.posts.map((p) => p.type), ["outcome"], "the editor is not re-initialised");
    assert.equal((h.posts[0] as Extract<HostMessage, { type: "outcome" }>).kind, "failed");
    assert.ok(h.notes.some((n) => /moved on since that Apply/.test(n.text)), JSON.stringify(h.notes));
  });
}

test("a late Undo refuses when the file changed after the Apply: those edits are not thrown away", async () => {
  const state = { episode: "merge:abc", head: "c0ffee1", calls: [] as string[] };
  let disk = "resolved\n";
  let undo: (() => Promise<void>) | undefined;
  const h = harness(movableGit(state), {
    offerUndo: (_t, fn) => (undo = fn),
    diskText: async () => disk,
  });
  await new MergeSession(h.deps).apply("resolved\n");
  disk = "resolved\nand then some more work\n";
  await undo!();
  assert.ok(!state.calls.some((c) => c.startsWith("restore:")), state.calls.join(" | "));
  assert.ok(h.notes.some((n) => /a\.txt changed after the Apply/.test(n.text)), JSON.stringify(h.notes));
});

/**
 * A session on a REAL merge conflict whose operation view says what git says
 * (merging while MERGE_HEAD exists) and whose restore is what P2's does for a
 * both-sides text conflict: `git checkout -m -- <path>`.
 */
function realMergeSession(repo: string, ctx: GitContext, onUndo: (fn: () => Promise<void>) => void): MergeSession {
  const file = join(repo, "a.txt");
  const merging = async () => (await ctx.process.run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  const opView = async () => (await merging() ? view("merge", { episode: "merge:x" }) : view("none"));
  const reader = new ConflictOps(ctx.process, repo, ctx.conflict, { view: opView });
  return new MergeSession({
    git: {
      operation: {
        view: opView,
        detect: async () => ({ kind: "merge", unmerged: (await ctx.conflict.listConflicts()).length }),
        continue: async () => outcome({}),
        abort: async () => outcome({}),
      },
      conflictOps: {
        readSides: (p, o) => reader.readSides(p, o),
        noteChoice: () => {},
        takeRole: async () => ({ ok: false, changed: false }),
        deleteFile: async () => ({ ok: false, changed: false }),
        restore: async (p) => {
          const res = await ctx.process.run(["checkout", "-m", "--", p]);
          return { ok: res.code === 0, changed: res.code === 0, message: res.stderr };
        },
      },
      conflict: ctx.conflict,
      process: ctx.process,
    },
    rel: "a.txt",
    fileName: file,
    workingText: () => readFileSync(file, "utf8"),
    diskText: async () => readFileSync(file, "utf8"),
    save: async (text) => writeFileSync(file, text),
    post: () => {},
    settings: () => ({ autoApplyNonConflicting: false }),
    jetbrainsName: () => undefined,
    offerUndo: (_t, fn) => onUndo(fn),
    notify: () => {},
  });
}

for (const [what, afterCommit] of [
  ["the file untouched since", undefined],
  ["the file edited after the commit", "one\ntwo\nthree-merged\nfour\nfive (written after the merge)\n"],
] as const) {
  test(`REAL git: an Undo clicked after the merge was committed (${what}) brings no conflict back`, async () => {
    // The resolve-undo record `checkout -m` answers from outlives the merge
    // commit (`ls-files --resolve-undo` still lists the path), so this click
    // used to re-conflict a finished merge and rewrite the file.
    const r = mergeConflict();
    const ctx = new GitContext({ root: r.repo });
    const file = join(r.repo, "a.txt");
    let undo: (() => Promise<void>) | undefined;
    const session = realMergeSession(r.repo, ctx, (fn) => (undo = fn));
    try {
      await session.apply("one\ntwo\nthree-merged\nfour\n");
      assert.ok(undo, "an Undo was offered for the resolution");
      git(r.repo, "commit", "--no-edit", "-q");
      if (afterCommit) writeFileSync(file, afterCommit);
      await undo!();
      assert.equal(git(r.repo, "ls-files", "-u"), "", "no conflict was brought back into a finished merge");
      assert.equal(readFileSync(file, "utf8"), afterCommit ?? "one\ntwo\nthree-merged\nfour\n");
    } finally {
      ctx.dispose();
      removeTemp(r.dir);
    }
  });
}

test("REAL git: an Undo clicked while the merge is still stopped there brings the conflict back", async () => {
  const r = mergeConflict();
  const ctx = new GitContext({ root: r.repo });
  let undo: (() => Promise<void>) | undefined;
  const session = realMergeSession(r.repo, ctx, (fn) => (undo = fn));
  try {
    await session.apply("one\ntwo\nthree-merged\nfour\n");
    await undo!();
    assert.match(git(r.repo, "ls-files", "-u", "--", "a.txt"), /a\.txt/, "unmerged again");
    assert.match(readFileSync(join(r.repo, "a.txt"), "utf8"), /^<<<<<<< /m);
  } finally {
    ctx.dispose();
    removeTemp(r.dir);
  }
});
