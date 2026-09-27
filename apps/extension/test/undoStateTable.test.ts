// The extension's Undo, as a STATE TABLE — every operation the product wraps
// in the Undo envelope × the starting states that change what Undo does.
//
// Each cell drives the REAL door (commitActions, branchActions, stashesView,
// rebaseCommands, the reorder/amend/merge-editor call shapes) with the REAL
// UndoLedger and SnapshotProvider, against a real repository with a real
// `origin`, then presses Undo (ledger.undoLast, answering every question the
// way someone who asked to undo would: yes) and records what git looks like
// afterwards — which branch HEAD is on, where every branch and tag points,
// the working tree, the stash list, any operation left in progress.
//
// The assertions are what a user expects Undo to do. Where the product does
// something else the cell FAILS: these are the repro, not a regression suite.
// Nothing in src/ is changed by this file.
//
// UNDO_AUDIT_SCRATCH  — where the scratch repos go (default: the OS tmpdir)
// UNDO_AUDIT_OUT      — write every cell's measured states here as JSON
//
// The runner cannot load VS Code: vscodeStub.cjs stands in and records every
// message; the dialog host answers each question from the cell's script.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  workspace: unknown;
};
// Settings answer their defaults (the rebase runner reads git.path) — the
// generic stub would hand back a Proxy where a string belongs.
vscode.workspace = { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { runCommitAction, refActionId, runMultiCommitAction } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const { UndoLedger } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
const { startInteractiveRebase } = require("../src/rebase/rebaseCommands") as typeof import("../src/rebase/rebaseCommands");
const { runRebasePlan } = require("../src/rebase/rebaseRunner") as typeof import("../src/rebase/rebaseRunner");
const { buildRebasePlan } = require("@gitstudio/git-service/rebasePlan") as typeof import("@gitstudio/git-service/rebasePlan");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-undo-table-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

const ROOT = process.env.UNDO_AUDIT_SCRATCH || tmpdir();
mkdirSync(ROOT, { recursive: true });
const scratch = mkdtempSync(join(ROOT, "ext-undo-"));
let seq = 0;

// ── The dialog host: every question is recorded and answered by `answer`. ──
let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});
/** "Yes" to every confirm; `picks` answers the pick questions in order. */
function yes(...picks: string[]): (spec: DialogSpec) => string | undefined {
  const queue = [...picks];
  return (spec) => (spec.kind === "confirm" ? "ok" : spec.kind === "pick" ? queue.shift() : undefined);
}

// The interactive-rebase launch hands a command to a terminal; keep it so the
// cell can run exactly that command, with a scripted sequence editor.
const terminalCommands: { cwd?: string; text: string }[] = [];
vscode.window.createTerminal = (opts: { cwd?: string }) => ({
  show() {},
  sendText(text: string) {
    terminalCommands.push({ cwd: opts?.cwd, text });
  },
  dispose() {},
});

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Fx {
  dir: string;
  remote: string;
  git: (...a: string[]) => string;
  gitEnv: (env: Record<string, string>, ...a: string[]) => string;
  /** Commit `file` = `body` (defaults: <msg>.txt = <msg>) with subject `msg`. */
  commit: (msg: string, file?: string, body?: string) => string;
  write: (file: string, body: string) => void;
  read: (file: string) => string | null;
  ctx: InstanceType<typeof GitContext>;
  ledger: InstanceType<typeof UndoLedger>;
  entry: { ctx: InstanceType<typeof GitContext>; root: string };
  repos: never;
  undoRunner: <T>(label: string, fn: () => Promise<T>, opts?: { branch?: string }) => Promise<T>;
  /** Shas a cell's setup wants to compare against later. */
  memo: Record<string, string>;
}

/** main has one commit, "base" (f.txt = "base\n"), pushed to origin/main. */
function fx(): Fx {
  const base = join(scratch, `c${++seq}`);
  mkdirSync(base, { recursive: true });
  const remote = join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const gitEnv = (env: Record<string, string>, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }).trim();
  const git = (...args: string[]) => gitEnv({}, ...args);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  git("remote", "add", "origin", remote);
  const write = (file: string, body: string) => writeFileSync(join(dir, file), body);
  const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    write(file, body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  commit("base", "f.txt", "base\n");
  git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");

  const ctx = new GitContext({ root: dir });
  const entry = { ctx, root: dir };
  const state = new Map<string, unknown>();
  const context = {
    workspaceState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => void state.set(k, v),
    },
  };
  let ledger: InstanceType<typeof UndoLedger> | undefined;
  const repos = { getActive: () => entry, getAll: () => [entry], getUndoLedger: () => ledger } as never;
  ledger = new UndoLedger(repos, context as never);
  const l = ledger;
  const undoRunner = <T>(label: string, fn: () => Promise<T>, opts?: { branch?: string }) =>
    l.runWithUndo(entry as never, label, fn, opts);
  return { dir, remote, git, gitEnv, commit, write, read, ctx, ledger: l, entry, repos, undoRunner, memo: {} };
}

// ── What the repository looks like ───────────────────────────────────────────

interface RepoState {
  head: string;
  refs: Record<string, string>;
  status: string[];
  stashes: string[];
  op: string;
}

function subjectOf(f: Fx, sha: string): string {
  try {
    const t = f.git("cat-file", "-t", sha);
    if (t === "tag") return `tag-object→${f.git("log", "-1", "--format=%s", `${sha}^{commit}`)}`;
    return f.git("log", "-1", "--format=%s", sha);
  } catch {
    return sha.slice(0, 7);
  }
}

function state(f: Fx): RepoState {
  let head: string;
  try {
    head = f.git("symbolic-ref", "-q", "HEAD");
  } catch {
    head = "(detached)";
  }
  let at = "";
  try {
    at = subjectOf(f, f.git("rev-parse", "HEAD"));
  } catch {
    at = "(unborn)";
  }
  const refs: Record<string, string> = {};
  const lines = f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/remotes").split("\n");
  for (const line of lines.filter(Boolean)) {
    const [name, sha] = line.split(" ");
    if (name.endsWith("/HEAD")) continue;
    // Subject AND short sha: a rewritten copy keeps its subject.
    refs[name.replace(/^refs\/(heads|tags|remotes)\//, (_m, ns) => (ns === "heads" ? "" : ns === "tags" ? "tag:" : "remote:"))] =
      `${subjectOf(f, sha)}(${sha.slice(0, 7)})`;
  }
  // Untrimmed: the first porcelain line's leading space is its meaning.
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: f.dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  const stashes = f.git("stash", "list", "--format=%s").split("\n").filter(Boolean);
  const gd = f.git("rev-parse", "--git-dir");
  const gitDir = gd.startsWith("/") ? gd : join(f.dir, gd);
  const ops = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase(apply)"],
    // A cherry-pick or revert of several commits queues the rest here; git
    // status (and its Continue) still see the operation while it exists.
    ["sequencer", "sequence"],
  ]
    .filter(([p]) => existsSync(join(gitDir, p)))
    .map(([, n]) => n);
  return {
    head: `${head === "(detached)" ? "(detached)" : head.replace(/^refs\/heads\//, "")} @ ${at}`,
    refs,
    status,
    stashes,
    op: ops.join(",") || "none",
  };
}

function describe(s: RepoState): string {
  const refs = Object.entries(s.refs)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return (
    `HEAD=${s.head} | ${refs} | tree: ${s.status.length ? s.status.join("; ") : "clean"}` +
    ` | stash: ${s.stashes.length ? s.stashes.join("; ") : "none"}` +
    (s.op !== "none" ? ` | in progress: ${s.op}` : "")
  );
}

// ── Recording ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  operation: string;
  state: string;
  expected: string;
  before: string;
  afterOp: string;
  afterUndo: string;
  opAsked: string[];
  undoAsked: string[];
  undoSaid: string[];
  opRecordedUndo: boolean;
  /** The envelope's own toast(s) for the op, word for word. */
  opToasts: string[];
  failure?: string;
  extra?: Record<string, unknown>;
}
const rows: Row[] = [];
/** The envelope's toast, with Undo: "GitStudio: <label> — done.", "GitStudio:
 *  <label> stopped — finish it, or Undo." (git is waiting on the user), or
 *  "GitStudio: <label> did not finish.". */
const UNDO_TOAST = / — done\.$| stopped — finish it, or Undo\.$| did not finish\.$/;
after(() => {
  if (process.env.UNDO_AUDIT_OUT) writeFileSync(process.env.UNDO_AUDIT_OUT, JSON.stringify(rows, null, 2));
});

function clear(): void {
  asked = [];
  vscode.__said.length = 0;
}
const saidLines = (): string[] => vscode.__said.map((m) => `${m.kind}: ${m.message}`);

interface CellSpec {
  id: string;
  operation: string;
  state: string;
  expected: string;
  setup: (f: Fx) => void | Promise<void>;
  op: (f: Fx) => Promise<unknown>;
  /** Between the op and Undo (what the user did in between). */
  between?: (f: Fx) => void | Promise<void>;
  /** Assertions on the repository after Undo — the user's expectation. */
  expect: (f: Fx, s: RepoState, ctx: { undoAsked: DialogSpec[]; undoSaid: string[]; row: Row }) => void | Promise<void>;
  /** After asserting, what happens if the user keeps going (e.g. rebase --continue). */
  followUp?: (f: Fx, row: Row) => void | Promise<void>;
}

function cell(spec: CellSpec): void {
  test(`${spec.id} ${spec.operation} — ${spec.state}`, async () => {
    const f = fx();
    const row: Row = {
      id: spec.id,
      operation: spec.operation,
      state: spec.state,
      expected: spec.expected,
      before: "",
      afterOp: "",
      afterUndo: "",
      opAsked: [],
      undoAsked: [],
      undoSaid: [],
      opRecordedUndo: false,
      opToasts: [],
    };
    rows.push(row);
    try {
      await spec.setup(f);
      row.before = describe(state(f));
      clear();
      await spec.op(f);
      row.opToasts = vscode.__said.filter((m) => m.kind === "info" && UNDO_TOAST.test(m.message)).map((m) => m.message);
      row.opRecordedUndo = row.opToasts.length > 0;
      row.opAsked = asked.map((a) => a.title);
      row.afterOp = describe(state(f)) + ` | op said: ${saidLines().join(" / ") || "-"}`;
      if (spec.between) await spec.between(f);
      clear();
      answer = yes();
      await f.ledger.undoLast();
      const undoAsked = [...asked];
      row.undoAsked = undoAsked.map((a) => `${a.title}${"message" in a && a.message ? ` — ${a.message}` : ""}`);
      row.undoSaid = saidLines();
      const s = state(f);
      row.afterUndo = describe(s);
      try {
        await spec.expect(f, s, { undoAsked, undoSaid: row.undoSaid, row });
      } catch (err) {
        row.failure = err instanceof Error ? err.message.split("\n")[0] : String(err);
        throw err;
      } finally {
        if (spec.followUp) {
          try {
            await spec.followUp(f, row);
          } catch (err) {
            row.extra = { ...(row.extra ?? {}), followUpError: String(err) };
          }
        }
      }
    } finally {
      f.ctx.dispose();
    }
  });
}

const node = (name: string, type = "head") => ({ ref: { name, type, sha: "" } });

/** After an Undo that left a rebase open: what the banner's Continue (the
 *  rebase's own next step) then does to the branches. */
function continueAfterUndo(f: Fx, row: Row): void {
  let cont = "exit 0";
  try {
    f.gitEnv({ GIT_EDITOR: "true" }, "rebase", "--continue");
  } catch (err) {
    cont = String((err as { stderr?: string; stdout?: string }).stderr || (err as { stdout?: string }).stdout || err)
      .replace(/\s+/g, " ")
      .slice(0, 200);
  }
  row.extra = { ...(row.extra ?? {}), rebaseContinueSaid: cont, afterRebaseContinue: describe(state(f)) };
}
const noop = () => {};
const sha = (f: Fx, rev: string) => f.git("rev-parse", rev);
const isAt = (f: Fx, ref: string, subject: string, why: string) =>
  assert.equal(subjectOf(f, sha(f, ref)), subject, `${why} (${ref})`);
const hasRef = (f: Fx, ref: string): boolean => {
  try {
    f.git("rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};
const onBranch = (f: Fx, branch: string, why: string) => {
  let head = "(detached)";
  try {
    head = f.git("symbolic-ref", "-q", "HEAD");
  } catch {
    /* detached */
  }
  assert.equal(head, `refs/heads/${branch}`, why);
};

/** main: base → M (pushed). feature: base → F (local only unless pushed). */
function mainAndFeature(f: Fx, opts: { pushFeature?: boolean; pushMain?: boolean } = {}): void {
  f.commit("M", "m.txt");
  if (opts.pushMain !== false) f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
  f.git("checkout", "-q", "-b", "feature", "HEAD~1");
  f.commit("F", "feat.txt");
  if (opts.pushFeature) f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
  f.git("checkout", "-q", "main");
}

// ══ 1. Checkout (graph ref chip / Checkout Commit / Detach) ══════════════════

cell({
  id: "E01",
  operation: "Checkout <branch> (graph chip 'Checkout feature')",
  state: "on main, clean, feature exists, feature tip NOT pushed",
  expected: "HEAD back on main; main and feature where they were",
  setup: (f) => mainAndFeature(f),
  op: (f) => runCommitAction(refActionId("refs/heads/feature"), f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f, _s, { row }) => {
    // The control for every "offers no Undo" cell below: an op that ran IS
    // offered, so a detector that stopped matching the toast cannot pass them.
    assert.equal(row.opRecordedUndo, true, "the checkout's toast offers Undo");
    isAt(f, "refs/heads/feature", "F", "feature was never touched by the user — it must stay on F");
    onBranch(f, "main", "Undo of a checkout switches back to main");
    isAt(f, "refs/heads/main", "M", "main stays where it was");
  },
});

cell({
  id: "E02",
  operation: "Checkout <branch> (graph chip 'Checkout feature')",
  state: "on main, clean, feature exists, feature tip PUSHED (origin/feature)",
  expected: "HEAD back on main; no commit created; feature untouched",
  setup: (f) => mainAndFeature(f, { pushFeature: true }),
  op: (f) => runCommitAction(refActionId("refs/heads/feature"), f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f) => {
    isAt(f, "refs/heads/feature", "F", "feature must not gain a revert commit — a checkout wrote nothing");
    onBranch(f, "main", "Undo of a checkout switches back to main");
  },
});

cell({
  id: "E03",
  operation: "Checkout <branch> (graph chip 'Checkout main')",
  state: "on feature (= main + F), switching DOWN to main which is an ancestor; main pushed",
  expected: "HEAD back on feature; main stays at M",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "feature");
    f.commit("F", "feat.txt");
  },
  op: (f) => runCommitAction(refActionId("refs/heads/main"), f.ctx, { sha: sha(f, "main"), subject: "M" }, f.undoRunner),
  expect: (f) => {
    isAt(f, "refs/heads/main", "M", "main must not be fast-forwarded onto feature's commits");
    onBranch(f, "feature", "Undo of a checkout switches back to feature");
  },
});

cell({
  id: "E04",
  operation: "Checkout <branch> (graph chip 'Checkout feature')",
  state: "on main with an uncommitted edit (f.txt) that the switch carries; feature not pushed",
  expected: "HEAD back on main, the edit still there, feature untouched",
  setup: (f) => {
    mainAndFeature(f);
    f.write("f.txt", "my uncommitted edit\n");
  },
  op: (f) => runCommitAction(refActionId("refs/heads/feature"), f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f) => {
    isAt(f, "refs/heads/feature", "F", "feature must stay on F");
    onBranch(f, "main", "Undo switches back to main");
    assert.equal(f.read("f.txt"), "my uncommitted edit\n", "the edit survives");
  },
});

cell({
  id: "E05",
  operation: "Checkout <branch> (graph chip 'Checkout feature')",
  state: "starting DETACHED at M; feature not pushed",
  expected: "HEAD detached at M again; feature untouched",
  setup: (f) => {
    mainAndFeature(f);
    f.git("checkout", "-q", "--detach", "main");
  },
  op: (f) => runCommitAction(refActionId("refs/heads/feature"), f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f) => {
    isAt(f, "refs/heads/feature", "F", "feature must stay on F");
    assert.throws(() => f.git("symbolic-ref", "-q", "HEAD"), "HEAD is detached again");
    isAt(f, "HEAD", "M", "at M");
  },
});

cell({
  id: "E06",
  operation: "Checkout origin/x (graph chip) — creates local x tracking origin/x",
  state: "on main (M, pushed); no local x; origin/x = X diverged from main",
  expected: "HEAD back on main; the x the checkout created removed (or left at X); no commit made",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "tmp", "HEAD~1");
    f.commit("X", "x.txt");
    f.git("push", "-q", "origin", "refs/heads/tmp:refs/heads/x");
    f.git("checkout", "-q", "main");
    f.git("branch", "-q", "-D", "tmp");
    f.git("fetch", "-q", "origin");
  },
  op: (f) =>
    runCommitAction(refActionId("refs/remotes/origin/x"), f.ctx, { sha: sha(f, "refs/remotes/origin/x"), subject: "X" }, f.undoRunner),
  expect: (f) => {
    onBranch(f, "main", "Undo of a checkout switches back to main");
    if (hasRef(f, "refs/heads/x")) isAt(f, "refs/heads/x", "X", "a local x, if it stays, is origin/x's commit — no revert on it");
  },
});

cell({
  id: "E07",
  operation: "Checkout origin/x (graph chip) — creates local x tracking origin/x",
  state: "on main (M, pushed); no local x; origin/x = base (an ancestor of main)",
  expected: "HEAD back on main; x removed or left at base",
  setup: (f) => {
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/x");
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("fetch", "-q", "origin");
  },
  op: (f) =>
    runCommitAction(refActionId("refs/remotes/origin/x"), f.ctx, { sha: sha(f, "refs/remotes/origin/x"), subject: "base" }, f.undoRunner),
  expect: (f) => {
    onBranch(f, "main", "Undo of a checkout switches back to main");
    if (hasRef(f, "refs/heads/x")) isAt(f, "refs/heads/x", "base", "x, if it stays, is where origin/x is");
  },
});

cell({
  id: "E08",
  operation: "Checkout tag v1 (graph chip, detaches)",
  state: "on main (M, pushed); tag v1 on base (ancestor, pushed)",
  expected: "HEAD back ON main (attached), not detached",
  setup: (f) => {
    f.git("tag", "v1");
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
  },
  op: async (f) => {
    answer = yes();
    return runCommitAction(refActionId("refs/tags/v1"), f.ctx, { sha: sha(f, "v1"), subject: "base" }, f.undoRunner);
  },
  expect: (f) => {
    onBranch(f, "main", "Undo of a detaching checkout re-attaches HEAD to main");
    isAt(f, "refs/heads/main", "M", "main unchanged");
  },
});

cell({
  id: "E09",
  operation: "Detach HEAD Here (commit menu)",
  state: "on main (M, pushed); detaching at F (feature's local commit)",
  expected: "HEAD back ON main (attached)",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    answer = yes();
    return runCommitAction("detach", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner);
  },
  expect: (f) => {
    onBranch(f, "main", "Undo of a detach re-attaches HEAD to main");
    isAt(f, "refs/heads/feature", "F", "feature untouched");
  },
});

cell({
  id: "E10",
  operation: "Checkout Commit → 'Switch to feature' (commit menu, row carries a branch)",
  state: "on main, clean, feature not pushed",
  expected: "HEAD back on main; feature untouched",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    answer = yes("feature");
    return runCommitAction(
      "checkout",
      f.ctx,
      {
        sha: sha(f, "feature"),
        subject: "F",
        refs: [{ kind: "head", name: "feature", fullName: "refs/heads/feature" } as never],
      },
      f.undoRunner,
    );
  },
  expect: (f) => {
    isAt(f, "refs/heads/feature", "F", "feature must stay on F");
    onBranch(f, "main", "Undo switches back to main");
  },
});

// ══ 2. Cherry-pick / Revert ══════════════════════════════════════════════════

cell({
  id: "E11",
  operation: "Cherry-pick F onto main",
  state: "on main, clean, result not pushed",
  expected: "main back at M, clean",
  setup: (f) => mainAndFeature(f),
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M", "main back at M");
    onBranch(f, "main", "still on main");
    assert.deepEqual(s.status, []);
  },
});

cell({
  id: "E12",
  operation: "Cherry-pick F onto main",
  state: "on main, clean, then the result is PUSHED",
  expected: "a Revert commit on main undoing F (published history is not rewritten)",
  setup: (f) => mainAndFeature(f),
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  between: (f) => f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main"),
  expect: (f) => {
    onBranch(f, "main", "still on main");
    isAt(f, "refs/heads/main", 'Revert "F"', "undone by a revert commit");
    assert.equal(f.read("feat.txt"), null, "F's file is gone again");
  },
});

cell({
  id: "E13",
  operation: "Cherry-pick F onto main",
  state: "on main with an UNSTAGED edit to a file the pick does not touch (f.txt) — git runs the pick over it",
  expected: "main back at M; the f.txt edit still there, unstaged",
  setup: (f) => {
    mainAndFeature(f);
    f.write("f.txt", "unstaged edit\n");
  },
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M", "main back at M");
    assert.equal(f.read("f.txt"), "unstaged edit\n", "the unstaged edit is back");
    assert.deepEqual(s.status, [" M f.txt"], "and unstaged, as it was");
  },
});

cell({
  id: "E14",
  operation: "Cherry-pick F onto main",
  state: "pick CONFLICTS (paused, CHERRY_PICK_HEAD)",
  expected: "pick abandoned: main at M, clean, nothing in progress",
  setup: (f) => {
    f.commit("M", "f.txt", "main's line\n");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "feature", "HEAD~1");
    f.commit("F", "f.txt", "feature's line\n");
    f.git("checkout", "-q", "main");
  },
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f, s, { row }) => {
    // Stopped for the user, not done: the toast beside "needs a decision" says so.
    assert.deepEqual(row.opToasts, [`GitStudio: Cherry-pick ${sha(f, "feature").slice(0, 7)} stopped — finish it, or Undo.`]);
    isAt(f, "refs/heads/main", "M", "main at M");
    assert.deepEqual(s.status, [], "clean");
    assert.equal(s.op, "none", "no cherry-pick left in progress");
  },
});

cell({
  id: "E15",
  operation: "Cherry-pick F onto main, then the user edits a file",
  state: "on main, clean at the op; UNCOMMITTED edit made AFTER the op, before Undo",
  expected: "the pick is undone and the later edit is kept — or Undo warns that it will be discarded",
  setup: (f) => mainAndFeature(f),
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  between: (f) => f.write("f.txt", "edit made after the pick\n"),
  expect: (f, _s, { undoAsked }) => {
    isAt(f, "refs/heads/main", "M", "pick undone");
    const warned = undoAsked.some((a) => "message" in a && /discard|lost|uncommitted changes you have made/i.test(a.message ?? ""));
    assert.ok(
      f.read("f.txt") === "edit made after the pick\n" || warned,
      `the later edit was discarded without a word (f.txt is now ${JSON.stringify(f.read("f.txt"))}; asked: ${undoAsked.map((a) => ("message" in a ? a.message : a.title)).join(" | ")})`,
    );
  },
});

cell({
  id: "E16",
  operation: "Cherry-pick F onto main, then the user commits C",
  state: "on main; a new commit C made AFTER the op (outside GitStudio), not pushed",
  expected: "C is kept — or Undo warns that C will be discarded",
  setup: (f) => mainAndFeature(f),
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  between: (f) => void f.commit("C", "c.txt"),
  expect: (f, _s, { undoAsked }) => {
    const containsC = f.git("log", "--format=%s", "main").split("\n").includes("C");
    const warned = undoAsked.some((a) => "message" in a && /\bC\b|commit.*(discard|lost)|discard/i.test(a.message ?? ""));
    assert.ok(
      containsC || warned,
      `C was dropped from main without a word (main is now at ${subjectOf(f, sha(f, "main"))}; asked: ${undoAsked.map((a) => ("message" in a ? a.message : a.title)).join(" | ")})`,
    );
  },
});

cell({
  id: "E17",
  operation: "Revert M (commit menu)",
  state: "on main (M pushed), clean, the revert commit not pushed",
  expected: "main back at M",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
  },
  op: (f) => runCommitAction("revert", f.ctx, { sha: sha(f, "main"), subject: "M" }, f.undoRunner),
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M", "main back at M");
    assert.deepEqual(s.status, []);
  },
});

cell({
  id: "E18",
  operation: "Cherry-pick F while DETACHED",
  state: "detached at M, clean",
  expected: "detached at M again; no branch moved",
  setup: (f) => {
    mainAndFeature(f);
    f.git("checkout", "-q", "--detach", "main");
  },
  op: (f) => runCommitAction("cherryPick", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner),
  expect: (f) => {
    assert.throws(() => f.git("symbolic-ref", "-q", "HEAD"), "still detached");
    isAt(f, "HEAD", "M", "at M");
    isAt(f, "refs/heads/main", "M", "main untouched");
    isAt(f, "refs/heads/feature", "F", "feature untouched");
  },
});

// ══ 3. Reset (commit menu, Soft / Mixed / Hard) ══════════════════════════════

cell({
  id: "E19",
  operation: "Reset Current Branch to Here — Hard, backwards to M1",
  state: "on main (M1, M2 pushed) with an uncommitted edit",
  expected: "main back at M2 (and the edit back, if Undo can)",
  setup: (f) => {
    f.commit("M1", "m1.txt");
    f.commit("M2", "m2.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.write("f.txt", "uncommitted edit\n");
  },
  op: async (f) => {
    answer = yes("--hard");
    const done = await runCommitAction("reset", f.ctx, { sha: sha(f, "main~1"), subject: "M1" }, f.undoRunner);
    // The second gate said Undo could NOT bring the edits back; it does.
    const gate = asked.find((a) => a.title === "Discard all uncommitted changes?");
    assert.match(
      gate && "message" in gate ? (gate.message ?? "") : "",
      /Undo can put the branch back and bring those edits back/,
      "the hard-reset question says what Undo will do",
    );
    return done;
  },
  expect: (f, _s, { row }) => {
    isAt(f, "refs/heads/main", "M2", "main back at M2");
    row.extra = { editAfterUndo: f.read("f.txt") };
    assert.equal(f.read("f.txt"), "uncommitted edit\n", "the edit is back, as the question said");
  },
});

cell({
  id: "E20",
  operation: "Reset Current Branch to Here — Soft, backwards to M1",
  state: "on main (M1, M2 not pushed), clean",
  expected: "main back at M2, clean",
  setup: (f) => {
    f.commit("M1", "m1.txt");
    f.commit("M2", "m2.txt");
  },
  op: async (f) => {
    answer = yes("--soft");
    return runCommitAction("reset", f.ctx, { sha: sha(f, "main~1"), subject: "M1" }, f.undoRunner);
  },
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M2", "main back at M2");
    assert.deepEqual(s.status, [], "clean");
  },
});

cell({
  id: "E21",
  operation: "Reset Current Branch to Here — Mixed, FORWARD onto origin/main's newer commit",
  state: "on main at M1; origin/main = M2 (pushed by someone else, fetched); clean",
  expected: "main back at M1; no commit created",
  setup: (f) => {
    f.commit("M1", "m1.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.commit("M2", "m2.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("reset", "-q", "--hard", "HEAD~1");
  },
  op: async (f) => {
    answer = yes("--mixed");
    return runCommitAction("reset", f.ctx, { sha: sha(f, "refs/remotes/origin/main"), subject: "M2" }, f.undoRunner);
  },
  expect: (f) => {
    isAt(f, "refs/heads/main", "M1", "main back at M1 — not a revert of someone else's M2");
  },
});

cell({
  id: "E22",
  operation: "Reset Current Branch to Here — Hard, sideways onto feature's F",
  state: "on main (M pushed); F local only; clean",
  expected: "main back at M",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    answer = yes("--hard");
    return runCommitAction("reset", f.ctx, { sha: sha(f, "feature"), subject: "F" }, f.undoRunner);
  },
  expect: (f) => {
    isAt(f, "refs/heads/main", "M", "main back at M");
    isAt(f, "refs/heads/feature", "F", "feature untouched");
  },
});

// ══ 4. Branches view: Merge / Rebase onto / Delete ═══════════════════════════

cell({
  id: "E23",
  operation: "Merge feature into main (Branches view) — fast-forward",
  state: "on main (M pushed); feature = M + F, PUSHED; main's new position not pushed",
  expected: "main back at M (moving main back rewrites nothing published)",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "feature");
    f.commit("F", "feat.txt");
    f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.mergeBranchIntoCurrent(f.repos, node("feature"), noop);
  },
  expect: (f) => {
    isAt(f, "refs/heads/main", "M", "main back at M, without a revert commit");
    isAt(f, "refs/heads/feature", "F", "feature untouched");
  },
});

cell({
  id: "E24",
  operation: "Merge feature into main (Branches view) — merge commit",
  state: "on main (M), feature (F) diverged, not pushed, clean",
  expected: "main back at M",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    answer = yes();
    return branchActions.mergeBranchIntoCurrent(f.repos, node("feature"), noop);
  },
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M", "main back at M");
    assert.deepEqual(s.status, []);
  },
});

cell({
  id: "E25",
  operation: "Merge feature into main (Branches view)",
  state: "merge CONFLICTS (paused, MERGE_HEAD)",
  expected: "merge abandoned: main at M, clean, nothing in progress",
  setup: (f) => {
    f.commit("M", "f.txt", "main's line\n");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "feature", "HEAD~1");
    f.commit("F", "f.txt", "feature's line\n");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.mergeBranchIntoCurrent(f.repos, node("feature"), noop);
  },
  expect: (f, s) => {
    isAt(f, "refs/heads/main", "M", "main at M");
    assert.deepEqual(s.status, []);
    assert.equal(s.op, "none");
  },
});

cell({
  id: "E26",
  operation: "Rebase feature onto main (Branches view)",
  state: "on feature (F, own commit), main moved on (M); nothing pushed but main",
  expected: "feature back at F",
  setup: (f) => {
    mainAndFeature(f);
    f.git("checkout", "-q", "feature");
    f.memo.F = sha(f, "feature");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  },
  expect: (f) => {
    onBranch(f, "feature", "on feature");
    // By sha: the rebased copy F' carries the same subject.
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature back at the ORIGINAL F");
    isAt(f, "refs/heads/main", "M", "main untouched");
  },
});

cell({
  id: "E27",
  operation: "Rebase feature onto main (Branches view) — the rebase fast-forwards",
  state: "on feature (= base, no own commits); main = M, PUSHED",
  expected: "feature back at base; no commit created",
  setup: (f) => {
    f.git("branch", "feature");
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "feature");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  },
  expect: (f) => {
    onBranch(f, "feature", "on feature");
    isAt(f, "refs/heads/feature", "base", "feature back at base — not a revert of main's M on feature");
  },
});

cell({
  id: "E28",
  operation: "Rebase feature onto main (Branches view)",
  state: "rebase STOPS on a conflict (HEAD detached mid-rebase); main NOT pushed past base",
  expected: "rebase abandoned: on feature at F, nothing in progress",
  setup: (f) => {
    f.commit("M", "f.txt", "main's line\n");
    f.git("checkout", "-q", "-b", "feature", "HEAD~1");
    f.memo.F = f.commit("F", "f.txt", "feature's line\n");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  },
  expect: (f, s, { row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Rebase onto main stopped — finish it, or Undo."]);
    assert.equal(s.op, "none", "no rebase left in progress");
    onBranch(f, "feature", "back on feature");
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature at the ORIGINAL F");
  },
  followUp: continueAfterUndo,
});

cell({
  id: "E29",
  operation: "Rebase feature onto main (Branches view)",
  state: "rebase STOPS on a conflict (HEAD detached mid-rebase); main's M IS pushed",
  expected: "rebase abandoned: on feature at F, nothing in progress",
  setup: (f) => {
    f.commit("M", "f.txt", "main's line\n");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.git("checkout", "-q", "-b", "feature", "HEAD~1");
    f.memo.F = f.commit("F", "f.txt", "feature's line\n");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  },
  expect: (f, s) => {
    assert.equal(s.op, "none", "no rebase left in progress");
    onBranch(f, "feature", "back on feature");
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature at the ORIGINAL F");
  },
});

cell({
  id: "E30",
  operation: "Delete branch feature (Branches view) — merged",
  state: "on main; feature merged (points at base); clean",
  expected: "feature recreated where it was (the confirm says Undo can put it back)",
  setup: (f) => {
    f.git("branch", "feature");
    f.commit("M", "m.txt");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.deleteBranch(f.repos, node("feature"), noop);
  },
  expect: (f) => {
    assert.ok(hasRef(f, "refs/heads/feature"), "feature is back");
    isAt(f, "refs/heads/feature", "base", "at base");
  },
});

cell({
  id: "E31",
  operation: "Delete branch feature (Branches view) — NOT merged, Force Delete",
  state: "on main; feature has unmerged F (local only); clean",
  expected: "feature recreated at F (the force confirm says 'Undo can still recover them')",
  setup: (f) => {
    mainAndFeature(f);
    f.memo.F = sha(f, "feature");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.deleteBranch(f.repos, node("feature"), noop);
  },
  expect: (f, _s, { row }) => {
    row.extra = {
      refsContainingF: f.git("for-each-ref", "--contains", f.memo.F, "--format=%(refname)") || "(none — F is unreachable)",
    };
    assert.ok(hasRef(f, "refs/heads/feature"), "feature is back");
    isAt(f, "refs/heads/feature", "F", "at F");
  },
});

cell({
  id: "E32",
  operation: "Delete branch feature (Branches view) — NOT merged, Force Delete CANCELLED",
  state: "on main; feature has unmerged F; the user cancels at 'not fully merged'",
  expected: "nothing ran, so nothing is recorded and no 'Delete branch — done.' toast",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    // Yes to "Delete branch feature?", No to "feature is not fully merged".
    let n = 0;
    answer = (spec) => (spec.kind === "confirm" && n++ === 0 ? "ok" : undefined);
    return branchActions.deleteBranch(f.repos, node("feature"), noop);
  },
  expect: (f, _s, { row, undoSaid }) => {
    assert.ok(hasRef(f, "refs/heads/feature"), "feature still exists");
    assert.equal(row.opRecordedUndo, false, "no 'Delete branch feature — done.' toast for a delete that did not happen");
    assert.ok(undoSaid.includes("info: GitStudio: Nothing to undo."), `Undo has nothing to undo (said: ${undoSaid.join(" / ")})`);
  },
});

// ══ 5. Stashes (the Changes view's Stashes group): Pop / Drop / Move ════════

cell({
  id: "E33",
  operation: "Pop stash@{0} (Stashes group)",
  state: "on main, clean; one stash holding an edit to f.txt",
  expected: "the stash is back in the list and the tree is clean again (as before the pop)",
  setup: (f) => {
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
  },
  op: (f) => stashesView.popStash(f.repos, "stash@{0}", noop),
  expect: (f, s, { row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Pop “my work” — done."], "a pop that finished is done, named by its words — stash@{0} names whichever stash is on top by the time it is read");
    const workSomewhere = s.stashes.length === 1 || f.read("f.txt") === "stashed work\n";
    assert.ok(workSomewhere, `the stashed work is gone: not in the stash list (${s.stashes.join(";") || "empty"}) and not in f.txt (${JSON.stringify(f.read("f.txt"))})`);
    assert.equal(s.stashes.length, 1, "the stash is back");
  },
});

cell({
  id: "E34",
  operation: "Pop stash@{0} (Stashes group)",
  state: "on main with an unrelated uncommitted edit (g.txt); stash holds an edit to f.txt",
  expected: "stash back in the list, g.txt edit kept",
  setup: (f) => {
    f.commit("G", "g.txt", "g\n");
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
    f.write("g.txt", "unrelated edit\n");
  },
  op: (f) => stashesView.popStash(f.repos, "stash@{0}", noop),
  expect: (f, s) => {
    assert.equal(f.read("g.txt"), "unrelated edit\n", "the unrelated edit is kept");
    const workSomewhere = s.stashes.length === 1 || f.read("f.txt") === "stashed work\n";
    assert.ok(workSomewhere, `the stashed work is gone: not in the stash list and not in f.txt (${JSON.stringify(f.read("f.txt"))})`);
  },
});

cell({
  id: "E35",
  operation: "Drop stash@{0} (Stashes group)",
  state: "on main, clean; one stash",
  expected: "the stash is back (the confirm says 'GitStudio's Undo can bring the stash back')",
  setup: (f) => {
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
  },
  op: async (f) => {
    answer = yes();
    return stashesView.dropStash(f.repos, "stash@{0}", noop);
  },
  expect: (_f, s, { row }) => {
    assert.deepEqual(s.stashes, ["On main: my work"], "the stash is back");
    assert.deepEqual(row.opToasts, ["GitStudio: Drop “my work” — done."], "named by its words, not stash@{0}");
  },
});

cell({
  id: "E66",
  operation: "Move to Changes: one file of a two-file stash (Stashes group)",
  state: "on main, clean; a stash holding edits to f.txt and g.txt",
  expected: "the whole stash is back where it was, what was left of it is gone, and f.txt is as before",
  setup: (f) => {
    f.commit("G", "g.txt", "g\n");
    f.write("other.txt", "older\n");
    f.git("stash", "push", "-q", "-u", "-m", "older");
    f.write("f.txt", "stashed f\n");
    f.write("g.txt", "stashed g\n");
    f.git("stash", "push", "-q", "-m", "my work");
    f.memo.stash = f.git("rev-parse", "stash@{0}");
    f.memo.list = f.git("stash", "list", "--format=%H");
  },
  op: (f) => stashesView.moveStashFiles(f.repos, f.memo.stash, ["f.txt"], noop),
  expect: (f, s, { row }) => {
    assert.equal(row.afterOp.includes(" M f.txt"), true, `the file came out of the stash (${row.afterOp})`);
    assert.deepEqual(row.opToasts, ["GitStudio: Move 1 file out of “my work” — done."]);
    // The question names the stash as the toast does, and its place in words.
    assert.match(row.undoAsked.join("\n"), /Put the stash “my work” back on top of the stash list\./);
    assert.doesNotMatch(row.undoAsked.join("\n"), /stash@\{|On main:/);
    assert.equal(f.git("stash", "list", "--format=%H"), f.memo.list, "the same stashes, in the same places");
    assert.equal(f.read("f.txt"), "base\n");
    assert.deepEqual(s.status, []);
  },
});

cell({
  id: "E67",
  operation: "Move to Changes: every file of a stash (Stashes group)",
  state: "on main, clean; a stash holding one edit",
  expected: "moving every file is a Pop: Undo puts the stash back",
  setup: (f) => {
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
    f.memo.stash = f.git("rev-parse", "stash@{0}");
  },
  op: (f) => stashesView.moveStashFiles(f.repos, f.memo.stash, ["f.txt"], noop),
  expect: (f, s, { row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Pop “my work” — done."]);
    assert.deepEqual(s.stashes, ["On main: my work"], "the stash is back");
    assert.equal(f.read("f.txt"), "base\n");
  },
});

cell({
  id: "E51",
  operation: "Pop stash@{0} (Stashes group)",
  state: "the pop CONFLICTS with a commit made since (git keeps the stash)",
  expected: "conflict gone, tree as before the pop, stash still in the list",
  setup: (f) => {
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
    f.commit("M", "f.txt", "committed since\n");
  },
  op: (f) => stashesView.popStash(f.repos, "stash@{0}", noop),
  expect: (f, s, { row }) => {
    // git applied it with conflicts and kept it: the pop did not finish.
    assert.deepEqual(row.opToasts, ["GitStudio: Pop “my work” did not finish."]);
    assert.deepEqual(s.stashes, ["On main: my work"], "the stash is still there");
    assert.equal(f.read("f.txt"), "committed since\n", "the tree is as before the pop");
    assert.deepEqual(s.status, []);
  },
});

// ══ 6. Graph: Reorder / Drop Commit ═════════════════════════════════════════

/** main: base → A → B (local); `side` on A when `withSide`. */
function twoLocal(f: Fx, withSide = false): void {
  f.commit("A", "a.txt");
  if (withSide) f.git("branch", "side");
  f.commit("B", "b.txt");
}

async function reorder(f: Fx, carry: boolean): Promise<unknown> {
  // The graph's reorder door (graphPanel.ts): rows newest-first, carry via
  // --update-refs, run under `Reorder N commits`.
  const a = sha(f, "main~1");
  const b = sha(f, "main");
  const rows = [
    { sha: a, action: "pick" as const, subject: "A", branches: carry ? ["side"] : undefined },
    { sha: b, action: "pick" as const, subject: "B", branches: undefined },
  ];
  const built = buildRebasePlan(rows, { updateRefs: carry });
  assert.ok(built.ok, built.ok ? "" : built.message);
  if (!built.ok) return;
  const base = sha(f, "main~2");
  const run = () => runRebasePlan(f.dir, { base, todo: built.todo, rewords: built.rewords });
  return f.ledger.runWithUndo(f.entry as never, `Reorder ${rows.length} commits`, run);
}

cell({
  id: "E36",
  operation: "Reorder commits (graph drag) — A,B → B,A",
  state: "on main; A and B local only; no other branch on them",
  expected: "main back at B (original order)",
  setup: (f) => twoLocal(f),
  op: (f) => reorder(f, false),
  expect: (f) => {
    isAt(f, "refs/heads/main", "B", "main back at the original B");
    assert.deepEqual(f.git("log", "--format=%s", "main").split("\n"), ["B", "A", "base"]);
  },
});

cell({
  id: "E37",
  operation: "Reorder commits (graph drag) — 'Reorder and move those branches'",
  state: "on main; side points at A; carry = move side",
  expected: "main back at B AND side back at the original A",
  setup: (f) => twoLocal(f, true),
  op: (f) => reorder(f, true),
  expect: (f, _s, { row }) => {
    isAt(f, "refs/heads/main", "B", "main back");
    row.extra = { sideAfterUndo: sha(f, "side"), originalA: sha(f, "main~1") };
    assert.equal(sha(f, "side"), sha(f, "main~1"), "side back on the ORIGINAL A (not the rewritten copy)");
  },
});

cell({
  id: "E38",
  operation: "Drop Commit A (graph) — 'Drop and move those branches'",
  state: "on main (base, A, B, C local); side points at B (a REPLAYED commit); carry = move side",
  expected: "main back at C AND side back at the original B",
  setup: (f) => {
    f.commit("A", "a.txt");
    f.memo.B = f.commit("B", "b.txt");
    f.git("branch", "side");
    f.commit("C", "c.txt");
  },
  op: async (f) => {
    answer = yes("carry");
    const r = await runCommitAction("drop", f.ctx, { sha: sha(f, "main~2"), subject: "A" }, f.undoRunner);
    return r;
  },
  expect: (f, _s, { row }) => {
    isAt(f, "refs/heads/main", "C", "main back");
    assert.equal(sha(f, "side"), f.memo.B, "side back on the ORIGINAL B (not the rewritten copy)");
  },
});

cell({
  id: "E39",
  operation: "Drop Commit A (graph) — plain",
  state: "on main (base, A, B local); no other branch",
  expected: "main back at B",
  setup: (f) => twoLocal(f),
  op: async (f) => {
    answer = yes();
    return runCommitAction("drop", f.ctx, { sha: sha(f, "main~1"), subject: "A" }, f.undoRunner);
  },
  expect: (f) => {
    isAt(f, "refs/heads/main", "B", "main back");
    assert.deepEqual(f.git("log", "--format=%s", "main").split("\n"), ["B", "A", "base"]);
  },
});

// ══ 7. Commit box: Amend ═══════════════════════════════════════════════════

async function amend(f: Fx, message: string): Promise<unknown> {
  // commitView.ts doCommit: an amend is wrapped as "Amend commit".
  const doCommit = () => f.ctx.staging.commit(message, { amend: true });
  return f.ledger.runWithUndo(f.entry as never, "Amend commit", doCommit);
}

cell({
  id: "E40",
  operation: "Amend commit (commit box) with a staged change",
  state: "on main; M not pushed; f.txt edit STAGED",
  expected: "main back at M; the change back and still staged",
  setup: (f) => {
    f.memo.M = f.commit("M", "m.txt");
    f.write("f.txt", "amended in\n");
    f.git("add", "f.txt");
  },
  op: (f) => amend(f, "M"),
  expect: (f, s) => {
    assert.equal(sha(f, "main"), f.memo.M, "main back at the original M");
    assert.equal(f.read("f.txt"), "amended in\n", "the change is back in the tree");
    assert.deepEqual(s.status, ["M  f.txt"], "and staged, as it was");
  },
});

cell({
  id: "E41",
  operation: "Amend commit (commit box), then force-push the amended commit",
  state: "on main; M pushed; amend adds f.txt edit; amended M' force-pushed",
  expected: "only the amendment is undone (a revert of the f.txt edit); M's own change stays",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.write("f.txt", "amended in\n");
    f.git("add", "f.txt");
  },
  op: (f) => amend(f, "M"),
  between: (f) => f.git("push", "-q", "-f", "origin", "refs/heads/main:refs/heads/main"),
  expect: (f) => {
    assert.equal(f.read("m.txt"), "M\n", "M's own change (m.txt) survives the undo");
    assert.equal(f.read("f.txt"), "base\n", "the amendment (f.txt) is undone");
  },
});

cell({
  id: "E42",
  operation: "Amend commit (commit box)",
  state: "on main; M PUSHED but the amended M' not pushed",
  expected: "main back at the original M",
  setup: (f) => {
    f.commit("M", "m.txt");
    f.git("push", "-q", "origin", "refs/heads/main:refs/heads/main");
    f.write("f.txt", "amended in\n");
    f.git("add", "f.txt");
  },
  op: (f) => amend(f, "M"),
  expect: (f) => {
    assert.equal(sha(f, "main"), sha(f, "refs/remotes/origin/main"), "main back at the pushed M");
  },
});

// ══ 8. Interactive rebase: terminal launch / Rebase workspace ═══════════════

/**
 * A todo editor for the terminal's `git rebase -i`: a node script that runs
 * `edit` over the todo's `lines`, named with forward slashes. git runs a
 * sequence editor through `sh -c`, and a Windows path's backslashes were
 * eaten there — the editor never started, no rebase ran, and the cells that
 * only check where main ends up passed over nothing.
 */
function sequenceEditor(f: Fx, edit: string): string {
  const p = join(f.dir, "..", `seq-${seq}.cjs`);
  writeFileSync(
    p,
    `const fs = require("fs"); const t = process.argv[2]; let lines = fs.readFileSync(t, "utf8").split("\\n");\n` +
      `${edit}\nfs.writeFileSync(t, lines.join("\\n"));\n`,
  );
  return `node "${p.replace(/\\/g, "/")}"`;
}

/** Run what the launch sent to its terminal, with a scripted todo editor. */
function runTerminal(f: Fx, editor: string): number {
  const cmd = terminalCommands[terminalCommands.length - 1];
  assert.ok(cmd, "the launch sent a command to a terminal");
  const args = cmd.text.replace(/^git\s+/, "").split(/\s+/);
  try {
    f.gitEnv({ GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: "true" }, ...args);
    return 0;
  } catch {
    return 1;
  }
}

cell({
  id: "E43",
  operation: "Start Interactive Rebase Here (terminal launch) — rebase finishes (A dropped)",
  state: "on main (base, A, B local), clean",
  expected: "main back at B",
  setup: (f) => twoLocal(f),
  op: async (f) => {
    await startInteractiveRebase(f.repos, f.ledger, sha(f, "main~1"));
    assert.equal(runTerminal(f, sequenceEditor(f, `lines[0] = lines[0].replace(/^pick/, "drop");`)), 0, "the rebase ran");
  },
  expect: (f, _s, { undoAsked }) => {
    isAt(f, "refs/heads/main", "B", "main back at B");
    assert.deepEqual(f.git("log", "--format=%s", "main").split("\n"), ["B", "A", "base"]);
    // The label names the base as a short sha — it was the full 40 plus "^".
    const q = undoAsked.find((a) => a.kind === "confirm");
    assert.match(q?.title ?? "", /^Undo "Interactive rebase onto [0-9a-f]{7}\^"\?$/, "the question names the base briefly");
  },
});

cell({
  id: "E44",
  operation: "Start Interactive Rebase Here (terminal launch) — Undo while the rebase is PAUSED at an 'edit' stop",
  state: "on main (base, A, B local); rebase stopped at A (detached, rebase-merge/)",
  expected: "rebase abandoned: on main at B, nothing in progress",
  setup: (f) => twoLocal(f),
  op: async (f) => {
    await startInteractiveRebase(f.repos, f.ledger, sha(f, "main~1"));
    assert.equal(runTerminal(f, sequenceEditor(f, `lines[0] = lines[0].replace(/^pick/, "edit");`)), 0, "the rebase stopped at A");
  },
  expect: (f, s) => {
    assert.equal(s.op, "none", "no rebase left in progress");
    onBranch(f, "main", "back on main");
    isAt(f, "refs/heads/main", "B", "main at B");
  },
  followUp: continueAfterUndo,
});

cell({
  id: "E45",
  operation: "Start Interactive Rebase Here (terminal launch) — the user quits the todo; commits C later",
  state: "on main (base, A, B); the rebase never ran (empty todo); a normal commit C made afterwards",
  expected: "nothing to undo for the rebase (it never happened) — C is kept, or Undo says C goes",
  setup: (f) => twoLocal(f),
  op: async (f) => {
    await startInteractiveRebase(f.repos, f.ledger, sha(f, "main~1"));
    runTerminal(f, sequenceEditor(f, `lines = lines.filter((l) => !/^pick/.test(l));`));
  },
  between: (f) => void f.commit("C", "c.txt"),
  expect: (f, _s, { undoAsked }) => {
    const containsC = f.git("log", "--format=%s", "main").split("\n").includes("C");
    const warned = undoAsked.some((a) => "message" in a && /\bC\b|discard/i.test(a.message ?? ""));
    assert.ok(containsC || warned, `C was dropped without a word (main at ${subjectOf(f, sha(f, "main"))}; asked: ${undoAsked.map((a) => ("message" in a ? a.message : a.title)).join(" | ")})`);
  },
});

cell({
  id: "E46",
  operation: "Interactive Rebase workspace — Start (plan: B,A reordered) STOPS on a conflict",
  state: "on main (base, A, B both edit f.txt); Undo while stopped",
  expected: "rebase abandoned: on main at B, nothing in progress",
  setup: (f) => {
    f.commit("A", "f.txt", "A\n");
    f.commit("B", "f.txt", "B\n");
  },
  op: async (f) => {
    const rows = [
      { sha: sha(f, "main~1"), action: "pick" as const, subject: "A" },
      { sha: sha(f, "main"), action: "pick" as const, subject: "B" },
    ];
    const built = buildRebasePlan(rows);
    assert.ok(built.ok);
    if (!built.ok) return;
    const base = sha(f, "main~2");
    return f.ledger.runWithUndo(f.entry as never, `Interactive rebase onto ${base.slice(0, 7)}`, () =>
      runRebasePlan(f.dir, { base, todo: built.todo, rewords: built.rewords }),
    );
  },
  expect: (f, s) => {
    assert.equal(s.op, "none", "no rebase left in progress");
    onBranch(f, "main", "back on main");
    isAt(f, "refs/heads/main", "B", "main at B");
  },
  followUp: continueAfterUndo,
});

// ══ 9. Merge editor ════════════════════════════════════════════════════════

cell({
  id: "E47",
  operation: "Merge editor Apply on a file with NO conflict ('Reopen With…') — wrapped as 'Apply merge resolution'",
  state: "on main; f.txt has an unstaged edit; Apply writes new text and stages it",
  expected: "f.txt back to the unstaged edit, nothing staged",
  setup: (f) => f.write("f.txt", "my edit\n"),
  op: (f) =>
    f.ledger.runWithUndo(f.entry as never, "Apply merge resolution", async () => {
      f.write("f.txt", "applied result\n");
      f.git("add", "f.txt");
    }),
  expect: (f, s) => {
    assert.equal(f.read("f.txt"), "my edit\n", "the edit is back");
    assert.deepEqual(s.status, [" M f.txt"], "unstaged, as it was");
  },
});

cell({
  id: "E48",
  operation: "Conflicts panel / merge editor 'Accept Yours' DURING a merge conflict",
  state: "merge of feature stopped with f.txt conflicted",
  expected: "either a working Undo or none offered (never an Undo that does something else)",
  setup: (f) => {
    f.commit("M", "f.txt", "main's line\n");
    f.git("checkout", "-q", "-b", "feature", "HEAD~1");
    f.commit("F", "f.txt", "feature's line\n");
    f.git("checkout", "-q", "main");
    try {
      f.git("merge", "feature");
    } catch {
      /* conflict expected */
    }
  },
  op: (f) =>
    f.ledger.runWithUndo(f.entry as never, "Accept Yours: f.txt", () => f.ctx.conflictOps.takeRole("f.txt", "yours")),
  expect: (_f, s, { row, undoSaid }) => {
    row.extra = { note: "`git stash create` is refused over an unmerged index: the tree it changed can't be put back, so a change to it alone is not recorded" };
    assert.equal(row.opRecordedUndo, false, "no ledger entry was offered");
    assert.ok(undoSaid.includes("info: GitStudio: Nothing to undo."), undoSaid.join(" / "));
    assert.equal(s.op, "merge", "the merge is still in progress");
  },
});

// ══ 10. Reset to upstream — the branch-only path (#32) ═══════════════════════

function divergedFeature(f: Fx): void {
  // origin/feature = base + R; local feature = base + L (diverged); on main.
  f.git("checkout", "-q", "-b", "feature");
  f.commit("R", "r.txt");
  f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
  f.git("reset", "-q", "--hard", "HEAD~1");
  f.commit("L", "l.txt");
  f.git("checkout", "-q", "main");
}

cell({
  id: "E49",
  operation: "Reset 'feature' to 'origin/feature' (branch menu) — branch-only undo",
  state: "on main; feature NOT checked out; feature diverged from origin/feature",
  expected: "feature back at L; main and HEAD untouched",
  setup: (f) => divergedFeature(f),
  op: async (f) => {
    answer = yes();
    return branchActions.resetBranchToUpstream(f.repos, node("feature"), noop);
  },
  expect: (f) => {
    isAt(f, "refs/heads/feature", "L", "feature back at L");
    onBranch(f, "main", "HEAD still on main");
  },
});

cell({
  id: "E50",
  operation: "Reset 'feature' to 'origin/feature' (branch menu) — branch-only undo",
  state: "on feature (checked out) with an uncommitted edit; diverged",
  expected: "feature back at L with the edit",
  setup: (f) => {
    divergedFeature(f);
    f.git("checkout", "-q", "feature");
    f.write("f.txt", "my edit\n");
  },
  op: async (f) => {
    answer = yes();
    return branchActions.resetBranchToUpstream(f.repos, node("feature"), noop);
  },
  expect: (f) => {
    isAt(f, "refs/heads/feature", "L", "feature back at L");
    onBranch(f, "feature", "on feature");
    assert.equal(f.read("f.txt"), "my edit\n", "the edit is back");
  },
});

// ══ 11. While a merge is stopped on a conflict ═══════════════════════════════
//
// `git stash create` refuses an unmerged index, and the capture used to throw
// with it: the op ran unguarded and recorded nothing — while the questions
// promised Undo ("Undo can still recover them", "bring those edits back").

/** main (M1, M2) and other (O) both edit f.txt; merging other stops on it. */
function mergeStopped(f: Fx): void {
  f.commit("M1", "m1.txt");
  f.git("checkout", "-q", "-b", "other");
  f.commit("O", "f.txt", "other\n");
  f.git("checkout", "-q", "main");
  f.commit("M2", "f.txt", "main\n");
  try {
    f.git("merge", "other");
  } catch {
    /* stopped on f.txt */
  }
  // A hand resolution in progress, and a new file staged with it.
  f.write("f.txt", "my careful hand resolution\n");
  f.write("g.txt", "a staged new file\n");
  f.git("add", "g.txt");
}

cell({
  id: "E52",
  operation: "Reset Current Branch to Here — Hard, backwards to M1",
  state: "a merge stopped on f.txt, hand-resolved, with a new file staged",
  expected: "the question doesn't promise the edits back; Undo puts main back at M2 and says the edits can't come back",
  setup: (f) => mergeStopped(f),
  op: async (f) => {
    answer = yes("--hard");
    const done = await runCommitAction("reset", f.ctx, { sha: sha(f, "main~1"), subject: "M1" }, f.undoRunner);
    const gate = asked.find((a) => a.title === "Discard all uncommitted changes?");
    const text = gate && "message" in gate ? (gate.message ?? "") : "";
    assert.doesNotMatch(text, /bring those edits back/, "git can't copy them, so Undo can't bring them back");
    assert.match(text, /git can't keep a copy of them while a conflict is unresolved, so GitStudio's Undo can put the branch back, but not those edits\./);
    return done;
  },
  expect: (f, s, { undoAsked }) => {
    isAt(f, "refs/heads/main", "M2", "main back at M2");
    assert.deepEqual(s.status, [], "nothing uncommitted is made up");
    const q = undoAsked.find((a) => a.kind === "confirm");
    assert.match(q && "message" in q ? (q.message ?? "") : "", /can't come back — git couldn't keep a copy of them while a conflict was unresolved/);
  },
});

cell({
  id: "E53",
  operation: "Delete branch feature (Branches view) — NOT merged, Force Delete",
  state: "a merge stopped on f.txt, hand-resolved; feature has unmerged F",
  expected: "feature recreated at F; the merge and its resolution untouched",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.memo.F = f.commit("F", "only-here.txt");
    f.git("checkout", "-q", "main");
    mergeStopped(f);
  },
  op: async (f) => {
    answer = yes();
    await branchActions.deleteBranch(f.repos, node("feature"), noop);
    assert.ok(asked.some((a) => "message" in a && /Undo can still recover them/.test(a.message ?? "")), "the force question promised it");
  },
  expect: (f, s) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature is back at F");
    assert.equal(s.op, "merge", "the merge is still stopped");
    assert.equal(f.read("f.txt"), "my careful hand resolution\n", "and the resolution in progress is as it was");
  },
});

cell({
  id: "E54",
  operation: "Drop stash@{0} (Stashes group)",
  state: "a merge stopped on f.txt; one stash",
  expected: "the stash is back",
  setup: (f) => {
    f.write("f.txt", "stashed work\n");
    f.git("stash", "push", "-q", "-m", "my work");
    mergeStopped(f);
  },
  op: (f) => stashesView.dropStash(f.repos, "stash@{0}", noop),
  expect: (_f, s) => {
    assert.deepEqual(s.stashes, ["On main: my work"], "the stash is back");
    assert.equal(s.op, "merge");
  },
});

// ══ 12. An edit saved while the op's own question is open ════════════════════
//
// GitStudio's questions are DOM, not modal: the user can go to the editor and
// save while one is up. That edit is theirs, not the op's.

/** Answer "yes" to confirms and `pick` to picks, saving f.txt at the `at`-th question. */
function editWhileAsked(f: Fx, at: number, answerThere: string | undefined, pick?: string): (spec: DialogSpec) => string | undefined {
  let n = 0;
  return (spec) => {
    n++;
    if (n === at) {
      f.write("f.txt", "typed while the question was open\n");
      return answerThere;
    }
    return spec.kind === "confirm" ? "ok" : spec.kind === "pick" ? pick : undefined;
  };
}

cell({
  id: "E55",
  operation: "Delete branch feature (Branches view) — NOT merged, Force Delete CANCELLED",
  state: "on main; f.txt saved in the editor while 'not fully merged' is open",
  expected: "nothing recorded, no toast; the edit stays",
  setup: (f) => mainAndFeature(f),
  op: async (f) => {
    answer = editWhileAsked(f, 2, undefined);
    return branchActions.deleteBranch(f.repos, node("feature"), noop);
  },
  expect: (f, _s, { row, undoSaid }) => {
    assert.equal(row.opRecordedUndo, false, "no 'Delete branch — done.' for a delete that didn't happen");
    assert.ok(undoSaid.includes("info: GitStudio: Nothing to undo."), undoSaid.join(" / "));
    assert.equal(f.read("f.txt"), "typed while the question was open\n");
    assert.ok(hasRef(f, "refs/heads/feature"));
  },
});

cell({
  id: "E56",
  operation: "Delete branch feature (Branches view) — NOT merged, Force Delete",
  state: "on main; f.txt saved in the editor while 'not fully merged' is open",
  expected: "Undo brings feature back and leaves the edit alone — its question never mentions the tree",
  setup: (f) => {
    mainAndFeature(f);
    f.memo.F = sha(f, "feature");
  },
  op: async (f) => {
    answer = editWhileAsked(f, 2, "ok");
    return branchActions.deleteBranch(f.repos, node("feature"), noop);
  },
  expect: (f, _s, { undoAsked }) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature is back");
    assert.equal(f.read("f.txt"), "typed while the question was open\n", "the edit is the user's");
    const q = undoAsked.find((a) => a.kind === "confirm");
    assert.equal(q && "message" in q ? q.message : "", `Bring back branch 'feature' at ${f.memo.F.slice(0, 7)}.`);
  },
});

cell({
  id: "E57",
  operation: "Merge feature (Branches view) — Stash & Retry CANCELLED",
  state: "on main with an edit in the merge's way; f.txt saved while the question is open",
  expected: "nothing ran, so nothing is recorded; the edits stay",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.commit("F", "g.txt", "feature\n");
    f.git("checkout", "-q", "main");
    f.commit("G", "g.txt", "g\n");
    f.git("checkout", "-q", "feature");
    f.git("checkout", "-q", "main");
    f.write("g.txt", "in the way\n");
  },
  op: async (f) => {
    answer = editWhileAsked(f, 2, "cancel");
    return branchActions.mergeBranchIntoCurrent(f.repos, node("feature"), noop);
  },
  expect: (f, _s, { row, undoSaid }) => {
    assert.equal(row.opRecordedUndo, false, "a cancelled merge offers no Undo");
    assert.ok(undoSaid.includes("info: GitStudio: Nothing to undo."), undoSaid.join(" / "));
    assert.equal(f.read("f.txt"), "typed while the question was open\n");
    assert.equal(f.read("g.txt"), "in the way\n");
  },
});

cell({
  id: "E58",
  operation: "Rebase onto main (Branches view) — Stash & Retry CANCELLED",
  state: "on feature with an uncommitted edit; f.txt saved while the question is open",
  expected: "nothing ran, so nothing is recorded; the edits stay",
  setup: (f) => {
    mainAndFeature(f);
    f.git("checkout", "-q", "feature");
    f.write("feat.txt", "uncommitted\n");
  },
  op: async (f) => {
    answer = editWhileAsked(f, 2, "cancel");
    return branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  },
  expect: (f, _s, { row, undoSaid }) => {
    assert.equal(row.opRecordedUndo, false, "a cancelled rebase offers no Undo");
    assert.ok(undoSaid.includes("info: GitStudio: Nothing to undo."), undoSaid.join(" / "));
    assert.equal(f.read("f.txt"), "typed while the question was open\n");
    assert.equal(f.read("feat.txt"), "uncommitted\n");
  },
});

// ══ 13. Cherry-pick N / Revert N (#32) that stopped, then Undo ═══════════════
//
// One git command over several commits writes .git/sequencer beside
// CHERRY_PICK_HEAD / REVERT_HEAD. `reset --hard` clears the *_HEAD but not the
// sequence: git status still says the op is in progress, and its Continue
// replays the rest of what Undo just took back.

const manyHost = { compare: async () => {} };

cell({
  id: "E59",
  operation: "Cherry-pick 3 commits A, B, C (graph menu for a selection)",
  state: "on main (base, main edit on f.txt); side has A, B (f.txt), C — stops on B",
  expected: "main back where it was, and no cherry-pick left in progress",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "side");
    f.memo.A = f.commit("A", "a.txt");
    f.memo.B = f.commit("B", "f.txt", "side\n");
    f.memo.C = f.commit("C", "c.txt");
    f.git("checkout", "-q", "main");
    f.memo.before = f.commit("main edit", "f.txt", "main\n");
  },
  op: async (f) => {
    await runMultiCommitAction("cherryPickMany", f.ctx, [f.memo.C, f.memo.B, f.memo.A], manyHost, f.undoRunner);
    assert.equal(state(f).op, "cherry-pick,sequence", "stopped on B, with C still queued");
  },
  expect: async (f, s, { undoAsked, row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Cherry-pick 3 commits stopped — finish it, or Undo."], "stopped, not done");
    assert.equal(sha(f, "HEAD"), f.memo.before, "main back where it was");
    assert.equal(s.op, "none", "no cherry-pick left in progress");
    assert.deepEqual(s.status, []);
    assert.equal((await f.ctx.operation.detect()).kind, "none", "GitStudio's own detector agrees");
    const q = undoAsked.find((a) => a.kind === "confirm");
    assert.match(q && "message" in q ? (q.message ?? "") : "", /The cherry-pick in progress is abandoned\./);
  },
  followUp: (f, row) => {
    // What was the bug: the leftover sequence's Continue re-applied C.
    let cont = "exit 0";
    try {
      f.gitEnv({ GIT_EDITOR: "true" }, "cherry-pick", "--continue");
    } catch (err) {
      cont = String((err as { stderr?: string }).stderr ?? err).trim().split("\n")[0];
    }
    row.extra = { cherryPickContinueSaid: cont, afterContinue: describe(state(f)) };
  },
});

cell({
  id: "E60",
  operation: "Revert 2 commits B, A (graph menu for a selection)",
  state: "on main (base, A, B on f.txt, D on f.txt) — stops on the first, B",
  expected: "main where it was, and no revert left in progress",
  setup: (f) => {
    f.memo.A = f.commit("A", "a.txt");
    f.memo.B = f.commit("B", "f.txt", "b\n");
    f.memo.before = f.commit("D", "f.txt", "d\n");
  },
  op: async (f) => {
    await runMultiCommitAction("revertMany", f.ctx, [f.memo.B, f.memo.A], manyHost, f.undoRunner);
    assert.equal(state(f).op, "revert,sequence", "stopped on B, with A still queued");
  },
  expect: async (f, s, { undoAsked, row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Revert 2 commits stopped — finish it, or Undo."], "stopped, not done");
    assert.equal(sha(f, "HEAD"), f.memo.before, "main where it was");
    assert.equal(s.op, "none", "no revert left in progress");
    assert.deepEqual(s.status, []);
    assert.equal((await f.ctx.operation.detect()).kind, "none", "GitStudio's own detector agrees");
    const q = undoAsked.find((a) => a.kind === "confirm");
    assert.match(q && "message" in q ? (q.message ?? "") : "", /The revert in progress is abandoned\./);
  },
});

cell({
  id: "E61",
  operation: "Drop 2 commits A, C (graph menu for a selection)",
  state: "on main (base, A on f.txt, B, C, D on f.txt) — replaying D after A is gone stops on f.txt",
  expected: "the toast says it stopped; Undo abandons the rebase and main is back at D",
  setup: (f) => {
    f.memo.A = f.commit("A", "f.txt", "a\n");
    f.commit("B", "b.txt");
    f.memo.C = f.commit("C", "c.txt");
    f.memo.D = f.commit("D", "f.txt", "d\n");
  },
  op: async (f) => {
    answer = yes();
    await runMultiCommitAction("dropMany", f.ctx, [f.memo.C, f.memo.A], manyHost, f.undoRunner);
    assert.equal(state(f).op, "rebase", "stopped replaying D");
  },
  expect: (f, s, { row }) => {
    assert.deepEqual(row.opToasts, ["GitStudio: Drop 2 commits stopped — finish it, or Undo."], "stopped, not done");
    assert.equal(s.op, "none", "no rebase left in progress");
    onBranch(f, "main", "on main");
    assert.equal(sha(f, "refs/heads/main"), f.memo.D, "main back at D");
  },
});

// ══ 14. Rebase onto, on a detached HEAD, stopped and continued by hand ══════
//
// The question says "Undo can take you back." A detached rebase writes no
// "rebase (finish)" to any branch's reflog: Undo follows it through HEAD's.

/** Detached at F (f.txt = feature's line); main = M (f.txt = main's line). */
function detachedOnF(f: Fx): void {
  f.commit("M", "f.txt", "main's line\n");
  f.git("checkout", "-q", "-b", "feature", "HEAD~1");
  f.memo.F = f.commit("F", "f.txt", "feature's line\n");
  f.commit("G", "g.txt");
  f.memo.G = sha(f, "HEAD");
  f.git("checkout", "-q", "--detach", "feature");
  f.git("branch", "-q", "-D", "feature");
}

/** Rebase onto main from the Branches view; it stops on f.txt; resolve it and `git rebase --continue`. */
async function detachedRebaseContinued(f: Fx): Promise<void> {
  answer = yes();
  await branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
  const q = asked.find((a) => a.kind === "confirm");
  assert.match(q && "message" in q ? (q.message ?? "") : "", /Undo can take you back\./, "the question's promise");
  assert.equal(state(f).op, "rebase", "stopped on f.txt");
  f.write("f.txt", "both lines\n");
  f.git("add", "f.txt");
  f.gitEnv({ GIT_EDITOR: "true" }, "rebase", "--continue");
  f.memo.rebased = sha(f, "HEAD");
}

cell({
  id: "E63",
  operation: "Rebase HEAD onto main (Branches view) on a DETACHED HEAD",
  state: "detached at G (F, G on no branch); stops on f.txt; resolved and continued by hand before Undo",
  expected: "HEAD detached at G again, as the question promised",
  setup: (f) => detachedOnF(f),
  op: (f) => detachedRebaseContinued(f),
  expect: (f, s, { undoSaid }) => {
    assert.notEqual(f.memo.rebased, f.memo.G, "the rebase rewrote G");
    assert.equal(s.head.startsWith("(detached)"), true, "still detached");
    assert.equal(sha(f, "HEAD"), f.memo.G, `HEAD back at G (said: ${undoSaid.join(" / ")})`);
    assert.equal(s.op, "none");
    assert.deepEqual(s.status, []);
  },
});

cell({
  id: "E64",
  operation: "Rebase HEAD onto main (Branches view) on a DETACHED HEAD",
  state: "as E63, then a commit X made on the detached HEAD before Undo",
  expected: "Undo refuses — putting HEAD back would throw X away — and nothing moves",
  setup: (f) => detachedOnF(f),
  op: (f) => detachedRebaseContinued(f),
  between: (f) => {
    f.memo.X = f.commit("X", "x.txt");
  },
  expect: (f, _s, { undoSaid }) => {
    assert.equal(sha(f, "HEAD"), f.memo.X, "HEAD still at X");
    assert.ok(undoSaid.some((l) => /HEAD has moved since/.test(l)), undoSaid.join(" / "));
  },
});

cell({
  id: "E65",
  operation: "Rebase HEAD onto main (Branches view) on a DETACHED HEAD",
  state: "stops on f.txt; the user aborts it by hand before Undo",
  expected: "nothing to undo: HEAD at G, as the abort left it",
  setup: (f) => detachedOnF(f),
  op: async (f) => {
    answer = yes();
    await branchActions.rebaseCurrentOnto(f.repos, node("main"), noop);
    f.git("rebase", "--abort");
  },
  expect: (f, s) => {
    assert.equal(sha(f, "HEAD"), f.memo.G);
    assert.equal(s.head.startsWith("(detached)"), true);
  },
});
