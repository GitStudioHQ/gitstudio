import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import Module from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

// "Drop Commit…" in the graph's commit menu (issue #32), through the REAL
// extension doors: commitMenuItemsFor (what the graph and the sidebar Commits
// list offer), runCommitAction("drop") (what the item runs) and the real
// UndoLedger (what Ctrl/Cmd+Alt+G Z does afterwards) — with `vscode` and
// ui/dialogs swapped for scripted stand-ins, against real repositories.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-drop-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

/** What the user was told, in order. */
const said: { kind: string; text: string; items: string[] }[] = [];
const say = (kind: string) => async (text: string, ...items: unknown[]) => {
  said.push({ kind, text, items: items.filter((i): i is string => typeof i === "string") });
  return undefined;
};
const vscodeStub = {
  window: {
    showWarningMessage: say("warning"),
    showErrorMessage: say("error"),
    showInformationMessage: say("info"),
    setStatusBarMessage: (text: string) => {
      said.push({ kind: "status", text, items: [] });
      return { dispose() {} };
    },
  },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => {} } },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
};

/** What each dialog was asked, and how the next one answers. */
interface Asked {
  kind: "confirm" | "pick";
  title: string;
  text: string;
  choices?: { id: string; label: string; danger?: boolean }[];
  danger?: boolean;
}
const asked: Asked[] = [];
let answer: { confirm: boolean; pick?: string } = { confirm: true };
const dialogsStub = {
  promptConfirm: async (spec: { title: string; message: string; danger?: boolean }) => {
    asked.push({ kind: "confirm", title: spec.title, text: spec.message, danger: spec.danger });
    return answer.confirm;
  },
  promptPick: async (spec: { title: string; hint?: string; choices: { id: string; label: string; danger?: boolean }[] }) => {
    asked.push({ kind: "pick", title: spec.title, text: spec.hint ?? "", choices: spec.choices });
    return answer.pick;
  },
  promptInput: async () => undefined,
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB_VSCODE = join(tmpdir(), "__gs_drop_vscode_stub__.js");
const STUB_DIALOGS = join(tmpdir(), "__gs_drop_dialogs_stub__.js");
const origResolve = M._resolveFilename;

/* eslint-disable @typescript-eslint/no-explicit-any */
let runCommitAction: any;
let commitMenuItemsFor: any;
let commitMenuItems: any;
let UndoLedger: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

before(() => {
  M._cache[STUB_VSCODE] = { id: STUB_VSCODE, filename: STUB_VSCODE, loaded: true, exports: vscodeStub };
  M._cache[STUB_DIALOGS] = { id: STUB_DIALOGS, filename: STUB_DIALOGS, loaded: true, exports: dialogsStub };
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === "vscode") return STUB_VSCODE;
    const r = origResolve.call(this, request, parent, ...rest);
    return /[\\/]src[\\/]ui[\\/]dialogs\.ts$/.test(r) ? STUB_DIALOGS : r;
  };
  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ runCommitAction, commitMenuItemsFor, commitMenuItems } = require("../src/graph/commitActions"));
  ({ UndoLedger } = require("../src/undo/undoLedger"));
  /* eslint-enable @typescript-eslint/no-require-imports */
});

after(() => {
  M._resolveFilename = origResolve;
  delete M._cache[STUB_VSCODE];
  delete M._cache[STUB_DIALOGS];
});

interface Repo {
  dir: string;
  git: (...a: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  subjects: () => string[];
  ctx: GitContext;
  dispose: () => void;
}

function mkRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-ext-drop-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  return {
    dir,
    git,
    commit,
    subjects: () => git("log", "--format=%s").split("\n").filter(Boolean),
    ctx,
    dispose: () => {
      ctx.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function reset(a: { confirm: boolean; pick?: string } = { confirm: true }): void {
  said.length = 0;
  asked.length = 0;
  answer = a;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const dropItem = (items: { id: string }[]) => items.find((i) => i.id === "drop");

// ── What the menu offers ─────────────────────────────────────────────────────

test("Drop Commit… is offered for the tip, a middle commit and the oldest, between Revert and Reset", async () => {
  const r = mkRepo();
  try {
    const root = r.commit("root"); const mid = r.commit("mid"); const tip = r.commit("tip");
    for (const sha of [tip, mid, root]) {
      const items = await commitMenuItemsFor(r.ctx, sha);
      const item = dropItem(items);
      assert.ok(item, `offered for ${sha.slice(0, 7)}: ${ids(items).join(",")}`);
      assert.equal(item.label, "Drop Commit…", "Title Case with an ellipsis, like the menu's other asking items");
      assert.equal(item.danger, true, "danger-styled like Reset");
      assert.equal(item.icon, "trash");
      const at = ids(items).indexOf("drop");
      assert.equal(ids(items)[at - 1], "revert");
      assert.equal(ids(items)[at + 1], "reset");
    }
  } finally {
    r.dispose();
  }
});

test("Drop Commit… is NOT offered for a merge, a commit below a merge, another branch's commit, or the only commit", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const below = r.commit("below");
    r.git("checkout", "-q", "-b", "side");
    const side = r.commit("side");
    r.git("checkout", "-q", "main");
    r.commit("main-work");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "other", below);
    const other = r.commit("other");
    r.git("checkout", "-q", "main");
    for (const [what, sha] of [["merge", merge], ["below a merge", below], ["merged-in side", side], ["another branch", other]]) {
      assert.equal(dropItem(await commitMenuItemsFor(r.ctx, sha)), undefined, `not offered for ${what}`);
    }
    // Everything else on the menu is still there.
    assert.deepEqual(ids(await commitMenuItemsFor(r.ctx, merge)), ids(commitMenuItems()));
  } finally {
    r.dispose();
  }
  const one = mkRepo();
  try {
    const only = one.commit("only");
    assert.equal(dropItem(await commitMenuItemsFor(one.ctx, only)), undefined, "not offered for the only commit");
  } finally {
    one.dispose();
  }
});

test("the item's icon exists in the webview's codicon subset (a missing one renders a blank gap)", () => {
  const css = readFileSync(join(__dirname, "../../../packages/webview-ui/src/styles/codicons.ts"), "utf8");
  for (const item of commitMenuItems({ drop: true })) {
    if (item.icon) assert.match(css, new RegExp(`\\.codicon-${item.icon}::before`), `codicon-${item.icon}`);
  }
});

// ── What the item does ───────────────────────────────────────────────────────

test("dropping the tip asks first, in words, then moves the branch to its parent", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const b = r.commit("B"); const c = r.commit("C");
    reset();
    const changed = await runCommitAction("drop", r.ctx, { sha: c, subject: "C" });
    assert.equal(changed, true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].kind, "confirm");
    assert.equal(asked[0].title, `Drop ${c.slice(0, 7)}?`);
    assert.match(asked[0].text, new RegExp(`${c.slice(0, 7)} "C" is removed from main\\.`));
    assert.match(asked[0].text, /nothing else is replayed/);
    assert.equal(asked[0].danger, true);
    assert.equal(r.git("rev-parse", "HEAD"), b);
    assert.ok(said.some((s) => s.kind === "status" && s.text.includes(`Dropped ${c.slice(0, 7)}.`)), JSON.stringify(said));
  } finally {
    r.dispose();
  }
});

test("dropping a middle commit says how many are replayed, and replays them", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); r.commit("C");
    reset();
    await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.match(asked[0].text, /The 2 commits after it are replayed on top/);
    assert.deepEqual(r.subjects(), ["C", "B", "base"]);
  } finally {
    r.dispose();
  }
});

test("dropping the oldest commit on the branch works (the root, via --root)", async () => {
  const r = mkRepo();
  try {
    const root = r.commit("root"); r.commit("A"); r.commit("B");
    reset();
    await runCommitAction("drop", r.ctx, { sha: root, subject: "root" });
    assert.deepEqual(r.subjects(), ["B", "A"]);
    assert.ok(!existsSync(join(r.dir, "root.txt")));
  } finally {
    r.dispose();
  }
});

test("Cancel at the question changes nothing and records no undo", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A");
    const tip = r.git("rev-parse", "HEAD");
    const active = { root: r.dir, ctx: r.ctx };
    const ledger = new UndoLedger({ getActive: () => active }, { workspaceState: { get: () => undefined, update: async () => {} } });
    reset({ confirm: false });
    const changed = await runCommitAction("drop", r.ctx, { sha: a, subject: "A" }, (label: string, fn: () => Promise<unknown>) =>
      ledger.runWithUndo(active, label, fn),
    );
    assert.equal(changed, false);
    assert.equal(r.git("rev-parse", "HEAD"), tip);
    reset();
    await ledger.undoLast();
    assert.ok(said.some((s) => s.text === "Nothing to undo."), JSON.stringify(said));
  } finally {
    r.dispose();
  }
});

test("a later commit that conflicts stops the rebase and hands it to the conflict flow", async () => {
  const r = mkRepo();
  try {
    r.commit("base", "f.txt", "one\n");
    const a = r.commit("A", "f.txt", "one\ntwo\n");
    r.commit("B", "f.txt", "one\ntwo\nthree\n");
    reset();
    const changed = await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.equal(changed, true, "the graph refreshes: the repository is mid-rebase now");
    const paused = said.find((s) => s.kind === "warning");
    assert.match(paused?.text ?? "", /hit a conflict while replaying a later commit/);
    assert.match(paused?.text ?? "", /abort to put the branch back as it was/);
    assert.deepEqual(paused?.items, ["Resolve Conflicts…"], "the notice opens the Conflicts dashboard");
    assert.ok(existsSync(join(r.git("rev-parse", "--absolute-git-dir"), "rebase-merge")), "the rebase is left open");
    assert.ok(!said.some((s) => s.kind === "error"), "a stop is not an error");
    r.git("rebase", "--abort");
  } finally {
    r.dispose();
  }
});

test("uncommitted changes refuse the drop BEFORE the question", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A");
    const tip = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "base.txt"), "edited\n");
    reset();
    const changed = await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.equal(changed, false);
    assert.equal(asked.length, 0, "nobody is asked to agree to a drop that cannot run");
    assert.match(said.find((s) => s.kind === "warning")?.text ?? "", /uncommitted changes/);
    assert.equal(r.git("rev-parse", "HEAD"), tip);
    assert.equal(readFileSync(join(r.dir, "base.txt"), "utf8"), "edited\n");
  } finally {
    r.dispose();
  }
});

test("an operation in progress refuses the drop BEFORE the question", async () => {
  const r = mkRepo();
  try {
    r.commit("base", "f.txt", "one\n");
    r.git("checkout", "-q", "-b", "side");
    const pick = r.commit("side edit", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    const a = r.commit("A", "f.txt", "main\n");
    assert.notEqual(spawnSync("git", ["cherry-pick", pick], { cwd: r.dir }).status, 0);
    reset();
    const changed = await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.equal(changed, false);
    assert.equal(asked.length, 0);
    assert.match(said.find((s) => s.kind === "warning")?.text ?? "", /cherry-pick is still in progress.*before dropping a commit/);
    r.git("cherry-pick", "--abort");
  } finally {
    r.dispose();
  }
});

test("a published commit's question warns that pushed history is rewritten and a force push follows", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    r.git("update-ref", "refs/remotes/origin/main", r.git("rev-parse", "HEAD"));
    reset({ confirm: false });
    await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.match(asked[0].text, /Already pushed\. Dropping it would rewrite history other people have\./);
    assert.match(asked[0].text, /force push/);
  } finally {
    r.dispose();
  }
  const local = mkRepo();
  try {
    local.commit("base"); const a = local.commit("A");
    reset({ confirm: false });
    await runCommitAction("drop", local.ctx, { sha: a, subject: "A" });
    assert.doesNotMatch(asked[0].text, /pushed|force/i, "no warning for a commit only this machine has");
  } finally {
    local.dispose();
  }
});

test("branches on replayed commits: the reorder's carry question, and 'move' moves them", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); r.commit("C");
    r.git("branch", "feature", b);
    reset({ confirm: true, pick: "carry" });
    await runCommitAction("drop", r.ctx, { sha: a, subject: "A" });
    assert.equal(asked[0].kind, "pick");
    assert.deepEqual(asked[0].choices?.map((c) => c.id), ["carry", "only", "no"]);
    assert.match(asked[0].text, /feature points at a commit that is replayed/);
    assert.deepEqual(r.subjects(), ["C", "B", "base"]);
    assert.equal(r.git("merge-base", "--is-ancestor", "feature", "HEAD"), "", "feature followed the rewrite");
  } finally {
    r.dispose();
  }
});

// ── Undo ─────────────────────────────────────────────────────────────────────

function ledgerFor(r: Repo) {
  const active = { root: r.dir, ctx: r.ctx };
  const ledger = new UndoLedger({ getActive: () => active }, { workspaceState: { get: () => undefined, update: async () => {} } });
  const undo = (label: string, fn: () => Promise<unknown>) => ledger.runWithUndo(active, label, fn);
  return { ledger, undo };
}

test("Undo restores the original tip after dropping a middle commit", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B");
    const tip = r.git("rev-parse", "HEAD");
    const { ledger, undo } = ledgerFor(r);
    reset();
    await runCommitAction("drop", r.ctx, { sha: a, subject: "A" }, undo);
    assert.deepEqual(r.subjects(), ["B", "base"]);
    assert.ok(said.some((s) => s.kind === "info" && s.text === `Undid? Drop ${a.slice(0, 7)}`), JSON.stringify(said));
    reset();
    await ledger.undoLast();
    assert.equal(r.git("rev-parse", "HEAD"), tip, "back on the original tip");
    assert.deepEqual(r.subjects(), ["B", "A", "base"]);
  } finally {
    r.dispose();
  }
});

test("Undo restores the tip after dropping it onto a PUBLISHED parent — a fast-forward, never a revert", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const pushed = r.commit("pushed");
    r.git("update-ref", "refs/remotes/origin/main", pushed);
    const tip = r.commit("local only");
    const { ledger, undo } = ledgerFor(r);
    reset();
    await runCommitAction("drop", r.ctx, { sha: tip, subject: "local only" }, undo);
    assert.equal(r.git("rev-parse", "HEAD"), pushed);
    reset();
    await ledger.undoLast();
    assert.ok(!asked.some((q) => /already been pushed/.test(q.title)), `no "Revert instead": ${JSON.stringify(asked)}`);
    assert.equal(r.git("rev-parse", "HEAD"), tip, "back on the original tip");
  } finally {
    r.dispose();
  }
});

test("a drop refused before it ran records no undo", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A");
    const { ledger, undo } = ledgerFor(r);
    // HEAD moves between the question and the run: the host re-reads and refuses.
    reset();
    answer = { confirm: true };
    const realConfirm = dialogsStub.promptConfirm;
    dialogsStub.promptConfirm = async (spec) => {
      const ok = await realConfirm(spec);
      r.commit("landed meanwhile");
      return ok;
    };
    try {
      await runCommitAction("drop", r.ctx, { sha: a, subject: "A" }, undo);
    } finally {
      dialogsStub.promptConfirm = realConfirm;
    }
    assert.match(said.find((s) => s.kind === "warning")?.text ?? "", /The branch has moved since you chose Drop/);
    assert.deepEqual(r.subjects(), ["landed meanwhile", "A", "base"]);
    reset();
    await ledger.undoLast();
    assert.ok(said.some((s) => s.text === "Nothing to undo."), JSON.stringify(said));
  } finally {
    r.dispose();
  }
});
