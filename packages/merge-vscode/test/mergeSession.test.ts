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
    fakeGit({ calls }),
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

test("with an undo envelope (GitStudio's ledger) nothing extra is offered — the ledger's Undo covers it", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({ calls }),
    {
      withUndo: async (_label, fn) => fn(),
      offerUndo: () => {
        calls.push("offer");
      },
    },
    calls,
  );
  await new MergeSession(h.deps).apply("resolved\n");
  assert.ok(!calls.includes("offer"));
});
