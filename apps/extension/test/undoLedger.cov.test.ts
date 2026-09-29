// The Undo envelope's own rules (undoLedger.ts), against real repositories and
// the real SnapshotProvider — the edges the operation state tables don't reach:
//
//  · an op that can't be snapshotted (an unborn HEAD) still runs, unguarded;
//  · an op that throws is still recorded — what it changed can be undone;
//  · an op whose changes can't be read is not recorded at all;
//  · the history is a ring of 20, and survives a reload (v1 entries do not);
//  · Undo / Undo History with no repository, no history, a dismissed pick;
//  · a toast's Undo for an entry already gone says so;
//  · a plan or a restore that fails is reported, and the entry kept;
//  · the pushed-history Revert: declined, paused on a conflict, already
//    undone, refused.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
};
// Toasts are recorded; a test can answer one by pressing a button.
type Toast = { kind: string; message: string; items: string[]; press: (item: string | undefined) => void };
const toasts: Toast[] = [];
const toastsOf = (kind: string) => (message: string, ...items: string[]) =>
  new Promise<string | undefined>((press) => {
    vscode.__said.push({ kind, message });
    toasts.push({ kind, message, items, press });
    if (items.length === 0) press(undefined);
  });
vscode.window.showInformationMessage = toastsOf("info");
vscode.window.showWarningMessage = toastsOf("warning");
vscode.window.showErrorMessage = toastsOf("error");

const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { UndoLedger, outcomeOf, nothingRan } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});
const yes = (spec: DialogSpec) => (spec.kind === "confirm" ? "ok" : undefined);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-undo-ledger-cov-")));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Snap = InstanceType<typeof GitContext>["snapshot"];
let seq = 0;
/** A repository; `snap` overrides members of its snapshot provider as the ledger sees it. */
function fixture(opts: { empty?: boolean; state?: Map<string, unknown>; snap?: (real: Snap) => Partial<Snap> } = {}) {
  const dir = join(scratch, `r${++seq}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  if (!opts.empty) commit("base", "f.txt", "1\n");
  const real = new GitContext({ root: dir });
  contexts.push(real);
  const snapshot = new Proxy(real.snapshot, {
    get(target, p) {
      const over = opts.snap?.(target) as Record<string | symbol, unknown> | undefined;
      if (over && p in over) return over[p];
      const v = (target as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const ctx = new Proxy(real, {
    get: (target, p) => (p === "snapshot" ? snapshot : (target as unknown as Record<string | symbol, unknown>)[p]),
  });
  const entry = { root: dir, ctx };
  const state = opts.state ?? new Map<string, unknown>();
  const context = { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } };
  const repos = { getActive: () => entry, getAll: () => [entry] } as never;
  const ledger = new UndoLedger(repos, context as never);
  const run = <T>(label: string, fn: () => Promise<T>) => ledger.runWithUndo(entry as never, label, fn);
  return { dir, git, commit, ctx: real, entry, repos, ledger, run, state, context };
}

function said(kind: string): string[] {
  return vscode.__said.filter((s) => s.kind === kind).map((s) => s.message);
}
function reset(): void {
  vscode.__said.length = 0;
  toasts.length = 0;
  asked = [];
}

test("an unborn repository can't be snapshotted: the op still runs, and there is nothing to undo", async () => {
  const f = fixture({ empty: true });
  reset();
  const out = await f.run("Commit first", async () => {
    f.commit("first");
    return 42;
  });
  assert.equal(out, 42, "the op ran and its result passed through");
  assert.equal(f.git("log", "--format=%s"), "first");
  await f.ledger.undoLast();
  assert.deepEqual(said("info"), ["GitStudio: Nothing to undo."], "no toast offered Undo, and there is no entry");
});

test("an op that throws after changing something is still recorded — and can be undone", async () => {
  const f = fixture();
  const base = f.git("rev-parse", "HEAD");
  reset();
  await assert.rejects(
    f.run("Commit X", async () => {
      f.commit("X");
      throw new Error("half-way");
    }),
    /half-way/,
  );
  assert.deepEqual(toasts, [], "no done-toast for an op that threw");
  answer = yes;
  await f.ledger.undoLast();
  assert.equal(f.git("rev-parse", "HEAD"), base, "the half-finished commit is undone");

  // Thrown before changing anything: nothing to record.
  reset();
  await assert.rejects(f.run("Nothing", async () => Promise.reject(new Error("early"))), /early/);
  await f.ledger.undoLast();
  assert.deepEqual(said("info"), ["GitStudio: Nothing to undo."]);
});

test("an op whose changes can't be read afterwards is not recorded — its undo could only guess", async () => {
  const f = fixture({
    snap: () => ({
      settle: async () => {
        throw new Error("cannot read refs");
      },
    }),
  });
  reset();
  await f.run("Commit X", async () => void f.commit("X"));
  await assert.rejects(f.run("Commit Y", async () => {
    f.commit("Y");
    throw new Error("boom");
  }));
  assert.deepEqual(toasts, []);
  await f.ledger.undoLast();
  assert.deepEqual(said("info"), ["GitStudio: Nothing to undo."]);
});

test("the history keeps the newest 20 operations", async () => {
  const f = fixture();
  for (let i = 1; i <= 21; i++) await f.run(`Commit ${i}`, async () => void f.commit(`c${i}`));
  let offered: string[] = [];
  answer = (spec) => {
    if (spec.kind === "pick") offered = spec.choices.map((c) => c.label);
    return undefined;
  };
  await f.ledger.showHistory();
  assert.equal(offered.length, 20);
  assert.equal(offered[0], "Commit 21", "newest first");
  assert.equal(offered[19], "Commit 2", "the oldest fell off the end");
});

test("the history survives a reload; an entry from before snapshots had a scope does not", async () => {
  const f = fixture();
  const base = f.git("rev-parse", "HEAD");
  await f.run("Commit X", async () => void f.commit("X"));
  const stored = f.state.get("gitstudio.undoLedger.v2") as Record<string, unknown[]>;
  assert.equal(stored[f.dir].length, 1, "persisted");
  // A v1-shaped entry (HEAD-only snapshot) for the same repo, and a hole.
  stored[f.dir].unshift({ snapshot: { headSha: base }, label: "Old v1 op", time: 0, headBefore: base }, null);

  const reloaded = new UndoLedger(f.repos, f.context as never);
  let offered: string[] = [];
  answer = (spec) => {
    if (spec.kind === "pick") offered = spec.choices.map((c) => c.label);
    return undefined;
  };
  await reloaded.showHistory();
  assert.deepEqual(offered, ["Commit X"], "only the entry that can be undone safely came back");
  answer = yes;
  await reloaded.undoLast();
  assert.equal(f.git("rev-parse", "HEAD"), base, "and it undoes after the reload");
});

test("Undo and Undo History with no repository, no history, or a dismissed pick change nothing", async () => {
  const none = new UndoLedger(
    { getActive: () => undefined, getAll: () => [] } as never,
    { workspaceState: { get: () => undefined, update: async () => {} } } as never,
  );
  reset();
  await none.undoLast();
  await none.showHistory();
  assert.deepEqual(said("info"), ["GitStudio: No repository is open.", "GitStudio: No repository is open."]);

  const f = fixture();
  reset();
  await f.ledger.showHistory();
  assert.deepEqual(said("info"), ["GitStudio: No undo history yet."]);

  await f.run("Commit X", async () => void f.commit("X"));
  const x = f.git("rev-parse", "HEAD");
  answer = () => undefined;
  await f.ledger.showHistory();
  answer = (spec) => (spec.kind === "pick" ? "99" : undefined); // not an entry
  await f.ledger.showHistory();
  assert.equal(f.git("rev-parse", "HEAD"), x, "nothing undone");
  const pick = asked.find((a) => a.kind === "pick");
  assert.ok(pick && pick.kind === "pick");
  assert.match(pick.choices[0].description ?? "", /^HEAD was [0-9a-f]{7}$/);
});

test("a done-toast's Undo, pressed after that entry was already undone, says it is gone", async () => {
  const f = fixture();
  reset();
  await f.run("Commit X", async () => void f.commit("X"));
  const toast = toasts.find((t) => t.message === "GitStudio: Commit X — done.");
  assert.ok(toast, "the envelope offered Undo");
  assert.deepEqual(toast.items, ["Undo"]);
  answer = yes;
  await f.ledger.undoLast();
  vscode.__said.length = 0;
  toast.press("Undo");
  for (let i = 0; i < 50 && said("info").length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(said("info"), [`GitStudio: "Commit X" isn't in the undo history any more.`]);
});

test("a plan that can't be read, or a restore that fails, is reported and the entry kept", async () => {
  let failPlan = true;
  let failExecute = true;
  const f = fixture({
    snap: (real) => ({
      plan: async (s: Parameters<Snap["plan"]>[0]) => {
        if (failPlan) throw new Error("plan unreadable");
        return real.plan(s);
      },
      execute: async (s: Parameters<Snap["execute"]>[0], steps: Parameters<Snap["execute"]>[1]) => {
        if (failExecute) throw new Error("index.lock exists");
        return real.execute(s, steps);
      },
    }),
  });
  const base = f.git("rev-parse", "HEAD");
  await f.run("Commit X", async () => void f.commit("X"));
  answer = yes;
  reset();
  await f.ledger.undoLast();
  assert.equal(said("error").length, 1);
  assert.match(said("error")[0], /Undo/);
  assert.match(said("error")[0], /plan unreadable/);

  failPlan = false;
  reset();
  await f.ledger.undoLast();
  assert.match(said("error")[0] ?? "", /index\.lock exists/);
  assert.notEqual(f.git("rev-parse", "HEAD"), base);

  failExecute = false;
  reset();
  await f.ledger.undoLast();
  assert.equal(f.git("rev-parse", "HEAD"), base, "the kept entry undoes once git lets it");
  assert.deepEqual(said("status"), ["$(discard) Undid Commit X"]);
});

/** A repository whose main is pushed to a bare origin after "Commit X" ran in the envelope. */
function pushedX(snap?: (real: Snap) => Partial<Snap>) {
  const f = fixture({ snap });
  const remote = join(scratch, `origin${seq}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  f.git("remote", "add", "origin", remote);
  f.git("push", "-q", "-u", "origin", "main");
  return f;
}

test("pushed since: Undo offers a Revert instead; declined, nothing happens", async () => {
  const f = pushedX();
  await f.run("Commit X", async () => void f.commit("X", "f.txt", "2\n"));
  f.git("push", "-q", "origin", "main");
  const x = f.git("rev-parse", "HEAD");
  reset();
  answer = () => undefined;
  await f.ledger.undoLast();
  const q = asked.find((a) => a.kind === "confirm");
  assert.equal(q?.title, `"Commit X" has already been pushed`);
  assert.equal(q && "confirmLabel" in q ? q.confirmLabel : "", "Revert");
  assert.equal(f.git("rev-parse", "HEAD"), x, "declined: no revert commit");
});

test("pushed since: a Revert that stops on a conflict says so and offers the way through", async () => {
  // The revert git runs is made to conflict for real: it reverts an older
  // change to the same line, which git cannot apply cleanly.
  let older = "";
  const f = pushedX(() => ({
    revert: async () => {
      try {
        execFileSync("git", ["revert", "--no-edit", older], { cwd: f.dir, stdio: "pipe" });
        return { code: 0, stderr: "", stdout: "" };
      } catch (e) {
        const err = e as { status: number; stderr: Buffer };
        return { code: err.status, stderr: String(err.stderr), stdout: "" };
      }
    },
  }));
  older = f.commit("older", "f.txt", "older\n");
  await f.run("Commit X", async () => void f.commit("X", "f.txt", "2\n"));
  f.git("push", "-q", "origin", "main");
  reset();
  answer = yes;
  await f.ledger.undoLast();
  for (let i = 0; i < 50 && said("warning").length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(said("warning").length, 1);
  assert.match(said("warning")[0], /Revert of "Commit X" needs a decision/);
  assert.deepEqual(toasts.find((t) => t.kind === "warning")?.items, ["Resolve Conflicts…"]);
  f.git("revert", "--abort");
});

test("pushed since: a Revert git declines is reported — as already undone when git says nothing", async () => {
  let result = { code: 1, stderr: "", stdout: "nothing to commit" };
  const f = pushedX(() => ({ revert: async () => result }));
  await f.run("Commit X", async () => void f.commit("X", "f.txt", "2\n"));
  f.git("push", "-q", "origin", "main");
  answer = yes;
  reset();
  await f.ledger.undoLast();
  assert.deepEqual(said("info"), [`GitStudio: Nothing to revert — "Commit X" is already undone.`]);

  result = { code: 128, stderr: "fatal: bad revision\n", stdout: "" };
  reset();
  await f.ledger.undoLast();
  assert.equal(said("error").length, 1, "the entry was kept, and the second try reports git's refusal");
  assert.match(said("error")[0], /Revert/);
  assert.match(said("error")[0], /fatal: bad revision/);
});

test("what the envelope's toast says an op came to", () => {
  const snap = (settled?: { op?: string }, deferred?: object) => ({ scope: { settled, deferred } }) as never;
  assert.equal(outcomeOf(snap({ op: "rebase" }), undefined), "stopped", "left git stopped");
  assert.equal(outcomeOf(snap({ op: "rebase" }, {}), undefined), "done", "a deferred op is MEANT to be under way");
  assert.equal(outcomeOf(snap(), { status: "stopped" }), "stopped");
  assert.equal(outcomeOf(snap(), { ok: false }), "failed");
  assert.equal(outcomeOf(snap(), { status: "failed" }), "failed");
  assert.equal(outcomeOf(snap(), { result: { code: 1 } }), "failed");
  assert.equal(outcomeOf(snap(), { result: { code: 0 } }), "done");
  assert.equal(outcomeOf(snap(), "ok"), "done");
  assert.equal(nothingRan(false), true);
  assert.equal(nothingRan({ cancelled: true }), true);
  assert.equal(nothingRan({ cancelled: false }), false);
  assert.equal(nothingRan(undefined), false);
});
