// The Worktrees commands' other exits, through the REAL extension code against
// real git: no repository open, a worktree that is not listed (or stops being
// listed while a question is up), a question dismissed at every step of New
// Worktree, a ref that cannot be found, a folder git cannot create, a lock git
// refuses, a prune that finds nothing, and every way a Pull in another
// worktree's folder can end. worktreesDoors.test.ts pins the main paths; these
// are asserted the same way — by what the user is told, what git holds after,
// and what the view was told while it ran.
//
// The runner cannot load VS Code: a stand-in records every message, command
// and terminal; the dialog host answers each question from the test's script.

import Module from "node:module";
import { basename, join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { folderKey } from "@gitstudio/git-service/folderPath";

// ── Home, for "~" typed as a folder: a temp folder of the test's own ────────
const home = mkdtempSync(join(tmpdir(), "gs-ext-wtcov-home-"));
writeFileSync(join(home, "notes.txt"), "the home folder is not empty\n");
process.env.HOME = home;
process.env.USERPROFILE = home;

// ── The stand-in for `vscode` ────────────────────────────────────────────────
const said: { kind: string; message: string; items?: string[] }[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const terminals: { name?: string; cwd?: string }[] = [];
let clipboard = "";
let folders: string[] = [];
/** What a message's button answers — the item the user clicks, or none. */
let reply: (message: string, items: string[]) => string | undefined = () => undefined;

class Disposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}
const Uri = {
  file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
  joinPath: (u: { fsPath: string }, ...parts: string[]) => Uri.file(join(u.fsPath, ...parts)),
};
const recorded =
  (kind: string) =>
  (message: string, ...items: string[]): Promise<string | undefined> => {
    said.push({ kind, message, items });
    return Promise.resolve(reply(message, items));
  };
const vscodeStub = {
  Disposable,
  Uri,
  window: {
    showErrorMessage: recorded("error"),
    showWarningMessage: recorded("warning"),
    showInformationMessage: recorded("info"),
    setStatusBarMessage: (message: string) => {
      said.push({ kind: "status", message });
      return new Disposable();
    },
    createTerminal: (o: { name?: string; cwd?: string }) => {
      terminals.push(o);
      return { show: () => {} };
    },
  },
  env: {
    clipboard: {
      writeText: async (t: string) => {
        clipboard = t;
      },
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
    get workspaceFolders() {
      return folders.map((f, index) => ({ uri: Uri.file(f), name: basename(f), index }));
    },
  },
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_worktrees_view_cov_vscode_stub__.js");
M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : origResolve.call(this, request, parent, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const wt = require("../src/views/worktreesView") as typeof import("../src/views/worktreesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { NO_REPOSITORY } = require("../src/ui/notify") as typeof import("../src/ui/notify");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogResult, DialogSpec } from "../src/ui/dialogs";

// ── Hermetic git ─────────────────────────────────────────────────────────────
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-wtcov-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-wtcov-"));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  for (const d of [scratch, home, join(cfg, "..")]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
let seq = 0;

let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => DialogResult | string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : typeof v === "string" ? { value: v } : v;
  },
});

beforeEach(() => {
  asked = [];
  answer = () => undefined;
  reply = () => undefined;
  said.length = 0;
  executed.length = 0;
  terminals.length = 0;
  clipboard = "";
  folders = [];
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const identity = [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]];

interface Scene {
  base: string;
  app: string;
  git: (...a: string[]) => string;
  path: (name: string) => string;
}

/** A main worktree on `main`; linked ones under wt/: feat-clean, feat-locked, feat-gone (folder deleted), detached. */
function scene(): Scene {
  const base = join(scratch, `s${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  writeFileSync(join(app, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const path = (name: string) => join(base, "wt", name);
  for (const b of ["feat-clean", "feat-locked", "feat-gone"]) git("worktree", "add", "-q", "-b", b, path(b));
  git("worktree", "add", "-q", "--detach", path("detached"), "HEAD");
  git("worktree", "lock", "--reason", "on a USB drive", path("feat-locked"));
  rmSync(path("feat-gone"), { recursive: true, force: true });
  return { base, app, git, path };
}

function windowAt(root: string, ledger?: unknown) {
  folders = [root];
  const ctx = new GitContext({ root });
  contexts.push(ctx);
  const entry = { ctx, root };
  return {
    repos: {
      getActive: () => entry,
      getAll: () => [entry],
      onDidChange: () => new Disposable(),
      getUndoLedger: () => ledger,
    } as never,
    ctx,
  };
}

const noRepo = { getActive: () => undefined, getAll: () => [], onDidChange: () => new Disposable(), getUndoLedger: () => undefined } as never;

function uiLog() {
  const events: string[] = [];
  return {
    events,
    ui: {
      busy: (p: string, label: string | undefined) => events.push(`busy ${basename(p)} ${label ?? "-"}`),
      patch: (p: string, row: Record<string, unknown>) => events.push(`patch ${basename(p)} ${JSON.stringify(row)}`),
      drop: (p: string) => events.push(`drop ${basename(p)}`),
    },
  };
}

const listed = (s: Scene): string[] =>
  s.git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => basename(l.slice("worktree ".length)));
const messages = (kind?: string): string[] => said.filter((m) => !kind || m.kind === kind).map((m) => m.message);
const all = (): string => said.map((m) => `${m.kind}: ${m.message}`).join("\n");
const counter = () => {
  let n = 0;
  return { refresh: () => void n++, count: () => n };
};
type Pick = DialogSpec & { kind: "pick" };
type Input = DialogSpec & { kind: "input" };
type Confirm = DialogSpec & { kind: "confirm" };

/** Poll (never a fixed sleep) until `cond` holds, for work a door hands off without awaiting. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "the condition never held");
}

// ── No repository ────────────────────────────────────────────────────────────

test("with no repository open every worktree command says so once and runs nothing; Remove and Forget still redraw", async () => {
  const r = counter();
  await wt.openWorktreeIn(noRepo, "/x", "new");
  await wt.revealWorktree(noRepo, "/x");
  await wt.openWorktreeTerminal(noRepo, "/x");
  await wt.copyWorktreePath(noRepo, "/x");
  await wt.addWorktree(noRepo, r.refresh);
  await wt.worktreeFromRef(noRepo, { name: "main", type: "head", sha: "" } as never, r.refresh);
  await wt.lockWorktree(noRepo, "/x", true, r.refresh);
  await wt.pruneWorktrees(noRepo, r.refresh);
  await wt.pullWorktree(noRepo, "/x", r.refresh);
  assert.equal(await wt.pushTargetFor(noRepo, "/x"), undefined);
  await wt.removeWorktree(noRepo, "/x", r.refresh);
  await wt.forgetWorktree(noRepo, "/x", r.refresh);
  assert.equal(said.length, 12, all());
  assert.ok(said.every((m) => m.kind === "info" && m.message === NO_REPOSITORY), all());
  assert.equal(asked.length, 0);
  assert.deepEqual(executed, []);
  assert.deepEqual(terminals, []);
  assert.equal(clipboard, "");
  assert.equal(r.count(), 2, "Remove and Forget redraw the list, whatever became of it");
});

// ── Finding the worktree ─────────────────────────────────────────────────────

test("a folder git does not list as a worktree is said as that — nothing copied, revealed, or asked — and Remove redraws the list", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const elsewhere = join(s.base, "not-a-worktree");
  await wt.copyWorktreePath(repos, elsewhere);
  await wt.revealWorktree(repos, elsewhere);
  await wt.lockWorktree(repos, elsewhere, true, () => {});
  const r = counter();
  await wt.removeWorktree(repos, elsewhere, r.refresh);
  assert.deepEqual(messages(), Array(4).fill("GitStudio: not-a-worktree is no longer a worktree of this repository."));
  assert.equal(clipboard, "");
  assert.deepEqual(executed, []);
  assert.equal(asked.length, 0);
  assert.equal(r.count(), 1);
});

test("from the palette, Copy Path offers every worktree — dismissed, nothing is copied; picked, its folder is", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  await wt.copyWorktreePath(repos, undefined);
  const q = asked[0] as Pick;
  assert.equal(q.kind, "pick");
  assert.equal(q.title, "Copy a worktree's path");
  assert.deepEqual(q.choices.map((c) => c.label).sort(), ["app", "detached", "feat-clean", "feat-gone", "feat-locked"]);
  const detached = q.choices.find((c) => c.label === "detached");
  assert.match(detached?.description ?? "", /^detached at [0-9a-f]{7} — /);
  assert.equal(clipboard, "");
  assert.equal(said.length, 0);

  answer = (spec) => (spec.kind === "pick" ? spec.choices.find((c) => c.label === "feat-clean")?.id : undefined);
  await wt.copyWorktreePath(repos, "");
  assert.ok(clipboard.endsWith(join("wt", "feat-clean")), clipboard);
  assert.match(messages("status")[0] ?? "", /^\$\(check\) Copied .*feat-clean$/);
});

test("Reveal of a worktree whose folder is gone says so, and shows nothing", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  await wt.revealWorktree(repos, s.path("feat-gone"));
  assert.deepEqual(executed, []);
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, "warning");
  assert.match(said[0].message, /^GitStudio: feat-gone's folder is gone — .*feat-gone\. Forget the worktree in Worktrees to clear it from the list\.$/);
});

// ── New worktree ─────────────────────────────────────────────────────────────

test("New Worktree offers branches, remote branches and tags — never the stash or origin/HEAD — and dismissed, makes nothing", async () => {
  const base = join(scratch, `c${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  at(seed)("add", ".");
  at(seed)("commit", "-qm", "base");
  const app = join(base, "app");
  execFileSync("git", ["clone", "-q", seed, app]);
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  git("tag", "v1");
  writeFileSync(join(app, "a.txt"), "stashed\n");
  git("stash", "push", "-q", "-m", "wip");
  const { repos } = windowAt(app);
  await wt.addWorktree(repos, () => {});
  const q = asked[0] as Pick;
  assert.equal(q.title, "New worktree — pick a ref");
  const rows = q.choices.map((c) => `${c.icon} ${c.label}`);
  assert.equal(rows[0], "add New branch…");
  assert.ok(rows.includes("git-branch main"), rows.join(", "));
  assert.ok(rows.includes("cloud origin/main"), rows.join(", "));
  assert.ok(rows.includes("tag v1"), rows.join(", "));
  assert.ok(!rows.some((r) => /stash|\/HEAD$/.test(r)), rows.join(", "));
  assert.deepEqual(git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});

test("New Worktree whose refs cannot be read still offers a new branch; dismissing its name makes nothing", async () => {
  const s = scene();
  const { repos, ctx } = windowAt(s.app);
  ctx.refs.listRefs = async () => {
    throw new Error("refs unreadable");
  };
  answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : undefined);
  const r = counter();
  await wt.addWorktree(repos, r.refresh);
  assert.deepEqual((asked[0] as Pick).choices.map((c) => c.id), ["gitstudio:new-branch"]);
  assert.equal(asked[1]?.kind, "input");
  assert.equal(asked[1]?.title, "New worktree branch");
  assert.equal(asked.length, 2, "no folder asked for a branch with no name");
  assert.equal(r.count(), 0);
  assert.deepEqual(said, []);
  assert.deepEqual(listed(s).sort(), ["app", "detached", "feat-clean", "feat-gone", "feat-locked"]);
});

test("New Worktree answered with a ref the list did not offer runs nothing", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "refs/heads/not-offered" : undefined);
  await wt.addWorktree(repos, () => {});
  assert.equal(asked.length, 1);
  assert.deepEqual(said, []);
});

test("New worktree from a ref the repository does not have says so in red and asks nothing", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  await wt.worktreeFromRef(repos, { name: "no-such-branch", type: "head", sha: "" } as never, () => {});
  assert.deepEqual(messages("error"), ["GitStudio: couldn't find no-such-branch in this repository's refs — refresh and try again."]);
  assert.equal(asked.length, 0);
});

test("New worktree from a tag: offered detached or as a new branch; detached, it is made at the tag, and Open in New Window opens it", async () => {
  const s = scene();
  s.git("tag", "v1");
  const tagSha = s.git("rev-parse", "v1^{commit}");
  const { repos } = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "direct" : spec.kind === "input" ? spec.value : undefined);
  reply = (_m, items) => (items.includes("Open in New Window") ? "Open in New Window" : undefined);
  const r = counter();
  await wt.worktreeFromRef(repos, { name: "v1", type: "tag", sha: "" } as never, r.refresh);
  const q = asked[0] as Pick;
  assert.equal(q.title, "Worktree from 'v1'");
  assert.deepEqual(q.choices.map((c) => [c.id, c.label, c.icon]), [
    ["direct", "v1 (detached)", "git-commit"],
    ["new", "New branch…", "add"],
  ]);
  assert.equal(q.choices[0].description, "Check out v1 as a detached HEAD.");
  const folderQ = asked[1] as Input;
  assert.equal(folderQ.title, "New worktree for refs/tags/v1");
  const made = join(s.base, "app-v1");
  assert.ok(existsSync(made));
  assert.equal(at(made)("rev-parse", "HEAD"), tagSha);
  assert.throws(() => at(made)("symbolic-ref", "-q", "HEAD"), "detached");
  assert.equal(r.count(), 1);
  assert.match(messages("info")[0] ?? "", /^GitStudio: Created the worktree app-v1 at .*app-v1\.$/);
  assert.deepEqual(executed.map((e) => [e.command, folderKey((e.args[0] as { fsPath: string }).fsPath), e.args[1]]), [
    ["vscode.openFolder", folderKey(made), { forceNewWindow: true }],
  ]);
});

test("New worktree from a local branch no worktree has: checked out directly, on the branch itself", async () => {
  const s = scene();
  s.git("branch", "spare");
  const { repos } = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "direct" : spec.kind === "input" ? spec.value : undefined);
  await wt.worktreeFromRef(repos, { name: "spare", type: "head", sha: "" } as never, () => {});
  const q = asked[0] as Pick;
  assert.deepEqual(q.choices.map((c) => [c.label, c.icon]), [["spare", "git-branch"], ["New branch…", "add"]]);
  assert.equal(q.choices[0].description, "Check out the existing local branch spare.");
  assert.equal(at(join(s.base, "app-spare"))("symbolic-ref", "--short", "HEAD"), "spare");
  assert.deepEqual(executed, [], "the toast's button was not pressed: nothing opened");
});

test("New worktree from a ref: dismissing the choice, or the new branch's name, makes nothing", async () => {
  const s = scene();
  s.git("branch", "spare");
  const { repos } = windowAt(s.app);
  answer = () => undefined;
  await wt.worktreeFromRef(repos, { name: "spare", type: "head", sha: "" } as never, () => {});
  assert.deepEqual(asked.map((q) => q.kind), ["pick"]);

  asked = [];
  answer = (spec) => (spec.kind === "pick" ? "new" : undefined);
  await wt.worktreeFromRef(repos, { name: "spare", type: "head", sha: "" } as never, () => {});
  assert.deepEqual(asked.map((q) => q.kind), ["pick", "input"]);
  assert.equal((asked[1] as Input).hint, "A new local branch is created from spare and checked out in the new worktree.");
  assert.deepEqual(listed(s).sort(), ["app", "detached", "feat-clean", "feat-gone", "feat-locked"]);
  assert.deepEqual(said, []);
});

test("New worktree's folder: a file where the folder would go is refused before git runs, and '~' is home — taken, then a folder in it", async () => {
  const s = scene();
  writeFileSync(join(s.base, "a-file"), "x\n");
  const { repos } = windowAt(s.app);
  const typed = [join(s.base, "a-file"), "~", "~/wt-home"];
  answer = (spec) =>
    spec.kind === "pick"
      ? "gitstudio:new-branch"
      : spec.kind === "input" && spec.title === "New worktree branch"
        ? "homeward"
        : spec.kind === "input"
          ? typed.shift()
          : undefined;
  await wt.addWorktree(repos, () => {});
  const folderQs = asked.filter((q) => q.kind === "input" && q.title.startsWith("New worktree for ")) as Input[];
  assert.equal(folderQs.length, 3);
  assert.match(folderQs[1].hint ?? "", /a-file already exists and isn't empty — choose another folder\./, "a file is not a free folder");
  assert.match(folderQs[2].hint ?? "", /^~ already exists and isn't empty — choose another folder\./, "~ is home, and home has things in it");
  assert.equal(folderQs[2].value, "~", "what was typed stays in the field");
  assert.equal(at(join(home, "wt-home"))("symbolic-ref", "--short", "HEAD"), "homeward", "~/wt-home is a folder in home");
  assert.deepEqual(messages("error"), []);
});

test("New worktree into a folder git cannot create says git's reason in red and redraws nothing", async () => {
  const s = scene();
  writeFileSync(join(s.base, "a-file"), "x\n");
  const { repos } = windowAt(s.app);
  answer = (spec) =>
    spec.kind === "pick"
      ? "gitstudio:new-branch"
      : spec.kind === "input" && spec.title === "New worktree branch"
        ? "blocked"
        : spec.kind === "input"
          ? join(s.base, "a-file", "inside")
          : undefined;
  const r = counter();
  await wt.addWorktree(repos, r.refresh);
  const errors = messages("error");
  assert.equal(errors.length, 1, all());
  assert.match(errors[0], /^GitStudio: couldn't create the worktree — \S/);
  assert.equal(r.count(), 0);
  assert.ok(!listed(s).includes("inside"));
});

// ── Remove / Forget ──────────────────────────────────────────────────────────

test("a detached worktree: removing it offers no branch to delete, and it goes", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  const log = uiLog();
  await wt.removeWorktree(repos, s.path("detached"), () => {}, log.ui);
  const q = asked[0] as Confirm;
  assert.equal(q.kind, "confirm");
  assert.equal(q.options, undefined, "no branch, nothing to delete");
  assert.equal(existsSync(s.path("detached")), false);
  assert.ok(!listed(s).includes("detached"));
  assert.deepEqual(log.events, ["busy detached Removing…", "busy detached -", "drop detached"]);
});

test("when git can't say what the default branch is, a merged branch is not offered for deletion — the worktree still goes", async () => {
  const s = scene();
  const { repos, ctx } = windowAt(s.app);
  ctx.worktrees.snapshot = async () => {
    throw new Error("snapshot failed");
  };
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await wt.removeWorktree(repos, s.path("feat-clean"), () => {});
  assert.equal((asked[0] as Confirm).options, undefined);
  assert.equal(existsSync(s.path("feat-clean")), false);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean", "the branch stays");
});

test("a worktree removed elsewhere between the pick and the question: said as no longer a worktree, dropped from the view, redrawn", async () => {
  const s = scene();
  const { repos, ctx } = windowAt(s.app);
  const list = ctx.worktrees.list.bind(ctx.worktrees);
  let first = true;
  ctx.worktrees.list = async (...a: Parameters<typeof list>) => {
    const out = await list(...a);
    if (first) {
      first = false;
      s.git("worktree", "remove", s.path("feat-clean")); // a terminal, meanwhile
    }
    return out;
  };
  const log = uiLog();
  const r = counter();
  await wt.removeWorktree(repos, s.path("feat-clean"), r.refresh, log.ui);
  assert.equal(asked.length, 0, "nothing asked about a worktree that is not there");
  assert.deepEqual(messages(), ["GitStudio: feat-clean is no longer a worktree of this repository."]);
  assert.deepEqual(log.events, ["drop feat-clean"]);
  assert.equal(r.count(), 1);
});

test("'Also delete the branch' when git can't take the branch: the worktree goes, the branch is kept, and git's reason is said", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const lock = join(s.app, ".git", "refs", "heads", "feat-clean.lock");
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    writeFileSync(lock, ""); // another git holds the branch's ref
    return { value: "ok", options: ["deleteBranch"] };
  };
  try {
    await wt.removeWorktree(repos, s.path("feat-clean"), () => {});
  } finally {
    rmSync(lock, { force: true });
  }
  assert.equal(existsSync(s.path("feat-clean")), false);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean");
  const report = messages("status").join("\n");
  assert.match(report, /Removed the worktree feat-clean; the branch feat-clean was kept — \S/);
  assert.doesNotMatch(report, /deleted the branch/);
});

test("'Also delete the branch' when the default branch is gone by the answer: the branch is kept, since git can't tell it is merged", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    s.git("update-ref", "-d", "refs/heads/main");
    return { value: "ok", options: ["deleteBranch"] };
  };
  await wt.removeWorktree(repos, s.path("feat-clean"), () => {});
  assert.equal(existsSync(s.path("feat-clean")), false);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean");
  assert.match(messages("status").join("\n"), /the branch feat-clean was kept — git couldn't tell whether it is still merged into main/);
});

// ── Lock ─────────────────────────────────────────────────────────────────────

test("Unlock: the lock goes, and it is said", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const r = counter();
  const log = uiLog();
  await wt.lockWorktree(repos, s.path("feat-locked"), false, r.refresh, log.ui);
  assert.doesNotMatch(s.git("worktree", "list", "--porcelain"), /^locked/m);
  assert.deepEqual(messages(), ["$(check) Unlocked the worktree feat-locked"]);
  assert.deepEqual(log.events, [], "the view painted it unlocked already; nothing to put back");
  assert.equal(r.count(), 1);
  assert.equal(asked.length, 0);
});

test("Lock on the main worktree is refused in words — git can't lock it — and nothing is asked", async () => {
  const s = scene();
  const { repos } = windowAt(join(s.path("feat-clean")));
  await wt.lockWorktree(repos, s.app, true, () => {});
  assert.deepEqual(messages(), ["GitStudio: app is the main worktree, which git can't lock."]);
  assert.equal(asked.length, 0);
});

test("a Lock git refuses (locked meanwhile by another hand) takes the view's lock back off and says why", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  answer = (spec) => {
    if (spec.kind !== "input") return undefined;
    s.git("worktree", "lock", "--reason", "an agent got there first", s.path("feat-clean"));
    return "mine";
  };
  const log = uiLog();
  const r = counter();
  await wt.lockWorktree(repos, s.path("feat-clean"), true, r.refresh, log.ui);
  assert.deepEqual(log.events, ['patch feat-clean {"locked":true,"lockReason":"mine"}', 'patch feat-clean {"locked":false}']);
  const errors = messages("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^GitStudio: couldn't lock the worktree feat-clean — \S/);
  assert.match(s.git("worktree", "list", "--porcelain"), /locked an agent got there first/, "the other lock stands");
  assert.equal(r.count(), 1);
});

// ── Prune ────────────────────────────────────────────────────────────────────

test("Prune whose worktree is locked while the question is up prunes nothing, and says so", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    s.git("worktree", "lock", s.path("feat-gone"));
    return "ok";
  };
  await wt.pruneWorktrees(repos, () => {});
  assert.equal(asked[0]?.title, "Prune 1 missing worktree?");
  assert.deepEqual(messages(), ["$(check) Nothing was pruned"]);
  assert.ok(listed(s).includes("feat-gone"));
});

test("Prune that git refuses says git's reason and redraws", async () => {
  const s = scene();
  const { repos, ctx } = windowAt(s.app);
  ctx.worktrees.prune = async () => ({ ok: false, stderr: "fatal: unable to prune\n" }) as never;
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  const r = counter();
  await wt.pruneWorktrees(repos, r.refresh);
  assert.deepEqual(messages(), ["GitStudio: couldn't prune — fatal: unable to prune"]);
  assert.equal(said[0].kind, "error");
  assert.equal(r.count(), 1);
  assert.ok(listed(s).includes("feat-gone"));
});

// ── Pull, in its own folder ──────────────────────────────────────────────────

/**
 * A repository cloned from a bare origin; `topic` is published and checked out
 * in a linked worktree, and someone else has pushed a change to a.txt on it.
 */
function publishedScene() {
  const base = join(scratch, `p${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  at(seed)("add", ".");
  at(seed)("commit", "-qm", "base");
  const origin = join(base, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const app = join(base, "app");
  execFileSync("git", ["clone", "-q", origin, app]);
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  git("branch", "topic", "origin/main");
  git("push", "-q", "-u", "origin", "topic");
  const topic = join(base, "app-topic");
  git("worktree", "add", "-q", topic, "topic");
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", origin, other]);
  const og = at(other);
  for (const [k, v] of identity) og("config", k, v);
  og("checkout", "-q", "topic");
  writeFileSync(join(other, "a.txt"), "theirs\n");
  og("commit", "-qam", "their work");
  og("push", "-q", "origin", "topic");
  git("fetch", "-q");
  return { base, app, git, topic, t: at(topic), origin };
}

test("Pull into a detached worktree runs nothing and says so, and its button opens that worktree in a new window", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  reply = (_m, items) => items[0];
  const log = uiLog();
  const r = counter();
  await wt.pullWorktree(repos, s.path("detached"), r.refresh, log.ui);
  const w = said.find((m) => m.kind === "warning");
  assert.equal(
    w?.message,
    "GitStudio: Pull in the worktree detached didn't run: HEAD is detached, so there is no branch to pull into. Check out a branch first.",
  );
  assert.deepEqual(w?.items, ["Open in New Window"]);
  await until(() => executed.length > 0);
  assert.deepEqual(executed.map((e) => [e.command, folderKey((e.args[0] as { fsPath: string }).fsPath), e.args[1]]), [
    ["vscode.openFolder", folderKey(s.path("detached")), { forceNewWindow: true }],
  ]);
  assert.deepEqual(log.events, ["busy detached Pulling…", "busy detached -"]);
  assert.equal(r.count(), 1);
});

test("Pull where both sides moved asks Merge or Rebase — dismissed, nothing moves; Merge, the worktree gets both", async () => {
  const p = publishedScene();
  writeFileSync(join(p.topic, "mine.txt"), "mine\n");
  p.t("add", "mine.txt");
  p.t("commit", "-qm", "my work");
  const mine = p.t("rev-parse", "HEAD");
  const { repos } = windowAt(p.app);
  answer = () => undefined;
  await wt.pullWorktree(repos, p.topic, () => {});
  assert.equal(asked[0]?.kind, "pick");
  assert.match(asked[0]?.title ?? "", /^'topic' and origin\/topic have diverged$/);
  assert.equal(p.t("rev-parse", "HEAD"), mine, "dismissed: nothing moved");
  assert.deepEqual(messages(), []);

  asked = [];
  answer = (spec) => (spec.kind === "pick" ? "merge" : undefined);
  await wt.pullWorktree(repos, p.topic, () => {});
  assert.deepEqual(messages("error"), []);
  assert.equal(p.t("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a merge commit");
  assert.equal(p.t("show", "HEAD:a.txt"), "theirs");
  assert.equal(p.t("show", "HEAD:mine.txt"), "mine");
  assert.deepEqual(messages("status"), ["$(check) Pulled the worktree app-topic"]);
});

test("Pull over an edit in the way, with Stash & Retry declined, runs nothing", async () => {
  const p = publishedScene();
  writeFileSync(join(p.topic, "a.txt"), "my edit\n");
  const head = p.t("rev-parse", "HEAD");
  const { repos } = windowAt(p.app);
  answer = (spec) => (spec.kind === "pick" ? "cancel" : undefined);
  await wt.pullWorktree(repos, p.topic, () => {});
  assert.equal(asked[0]?.title, "Your uncommitted changes are in the way");
  assert.equal(p.t("rev-parse", "HEAD"), head);
  assert.equal(p.t("status", "--porcelain"), "M a.txt");
  assert.deepEqual(messages(), []);
});

test("Pull merged into conflicts stops, naming the worktree, with Open in New Window", async () => {
  const p = publishedScene();
  writeFileSync(join(p.topic, "a.txt"), "mine\n");
  p.t("commit", "-qam", "mine");
  const { repos } = windowAt(p.app);
  answer = (spec) => (spec.kind === "pick" ? "merge" : undefined);
  await wt.pullWorktree(repos, p.topic, () => {});
  const w = said.find((m) => m.kind === "warning");
  assert.ok(w, all());
  assert.match(w.message, /^GitStudio: Pull in the worktree app-topic: /);
  assert.deepEqual(w.items, ["Open in New Window"]);
  assert.match(p.t("status", "--porcelain"), /^UU a\.txt$/m, "stopped in the merge, for the user to resolve there");
  assert.deepEqual(messages("status"), []);
});

test("Pull whose remote cannot be reached says it failed, in red, naming the worktree", async () => {
  const p = publishedScene();
  p.git("remote", "set-url", "origin", join(p.base, "no-such-origin.git"));
  const head = p.t("rev-parse", "HEAD");
  const { repos } = windowAt(p.app);
  await wt.pullWorktree(repos, p.topic, () => {});
  const e = said.find((m) => m.kind === "error");
  assert.ok(e, all());
  assert.match(e.message, /^GitStudio: Pull in the worktree app-topic failed — \S/);
  assert.deepEqual(e.items, ["Open in New Window"]);
  assert.equal(p.t("rev-parse", "HEAD"), head);
});

test("the window's repository closes while Pull or Push… is finding the worktree: nothing runs in it and nothing is said", async () => {
  const p = publishedScene();
  const head = p.t("rev-parse", "HEAD");
  const closing = () => {
    const { ctx } = windowAt(p.app);
    const entry = { ctx, root: p.app };
    let calls = 0;
    // Open for the first look, gone by the time a context for the worktree is made.
    return { getActive: () => (calls++ === 0 ? entry : undefined), getAll: () => [], getUndoLedger: () => undefined } as never;
  };
  const log = uiLog();
  const r = counter();
  await wt.pullWorktree(closing(), p.topic, r.refresh, log.ui);
  assert.equal(await wt.pushTargetFor(closing(), p.topic), undefined);
  assert.deepEqual(log.events, [], "never marked busy");
  assert.equal(r.count(), 0);
  assert.deepEqual(said, []);
  assert.equal(p.t("rev-parse", "HEAD"), head, "nothing pulled");
});
