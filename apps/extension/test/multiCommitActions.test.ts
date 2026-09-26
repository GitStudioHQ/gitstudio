import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

// Several commits at once (issue #32), through the REAL extension doors: the
// menu the graph and the Commits list offer for a selection
// (multiCommitMenuItemsFor), what each item runs (runMultiCommitAction), and
// the real UndoLedger — with `vscode` and ui/dialogs swapped for scripted
// stand-ins, against real repositories.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-many-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

const said: { kind: string; text: string; items: string[] }[] = [];
const say = (kind: string) => async (text: string, ...items: unknown[]) => {
  said.push({ kind, text, items: items.filter((i): i is string => typeof i === "string") });
  return undefined;
};
let clipboard = "";
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
  env: { clipboard: { writeText: async (t: string) => { clipboard = t; } } },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
};

interface Asked {
  kind: "confirm" | "pick" | "input";
  title: string;
  text: string;
  choices?: { id: string; label: string }[];
  danger?: boolean;
  value?: string;
  multiline?: boolean;
  selectOnOpen?: boolean;
}
const asked: Asked[] = [];
let answer: { confirm: boolean; pick?: string; input?: (value: string) => string | undefined } = { confirm: true };
const dialogsStub = {
  promptConfirm: async (spec: { title: string; message: string; danger?: boolean }) => {
    asked.push({ kind: "confirm", title: spec.title, text: spec.message, danger: spec.danger });
    return answer.confirm;
  },
  promptPick: async (spec: { title: string; hint?: string; choices: { id: string; label: string }[] }) => {
    asked.push({ kind: "pick", title: spec.title, text: spec.hint ?? "", choices: spec.choices });
    return answer.pick;
  },
  promptInput: async (spec: { title: string; hint?: string; value?: string; multiline?: boolean; selectOnOpen?: boolean }) => {
    asked.push({ kind: "input", title: spec.title, text: spec.hint ?? "", value: spec.value, multiline: spec.multiline, selectOnOpen: spec.selectOnOpen });
    return answer.input ? answer.input(spec.value ?? "") : undefined;
  },
  // The Undo envelope counts the questions an op put (undoLedger.ts).
  questionsAsked: () => asked.length,
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB_VSCODE = join(tmpdir(), "__gs_many_vscode_stub__.js");
const STUB_DIALOGS = join(tmpdir(), "__gs_many_dialogs_stub__.js");
const origResolve = M._resolveFilename;

/* eslint-disable @typescript-eslint/no-explicit-any */
let runMultiCommitAction: any;
let multiCommitMenuItemsFor: any;
let multiCommitMenuItems: any;
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
  ({ runMultiCommitAction, multiCommitMenuItemsFor, multiCommitMenuItems } = require("../src/graph/commitActions"));
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
  const dir = mkdtempSync(join(tmpdir(), "gs-ext-many-"));
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

function reset(a: typeof answer = { confirm: true }): void {
  said.length = 0;
  asked.length = 0;
  answer = a;
  clipboard = "";
}

const ids = (items: { id: string }[]) => items.map((i) => i.id).filter(Boolean);
const compared: Array<[string, string]> = [];
const host = { compare: async (base: string, head: string) => { compared.push([base, head]); } };

function ledgerFor(r: Repo) {
  const active = { root: r.dir, ctx: r.ctx };
  const ledger = new UndoLedger({ getActive: () => active }, { workspaceState: { get: () => undefined, update: async () => {} } });
  const undo = (label: string, fn: () => Promise<unknown>, opts?: unknown) => ledger.runWithUndo(active, label, fn, opts);
  return { ledger, undo };
}

// ── What the menu offers — one row per kind of selection ────────────────────

test("the menu for a selection offers exactly what can apply to it", async () => {
  const r = mkRepo();
  try {
    r.commit("base");
    const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("checkout", "-q", "-b", "side", a);
    const s1 = r.commit("S1"); const s2 = r.commit("S2");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = r.git("rev-parse", "HEAD");
    const top = r.commit("top"); const top2 = r.commit("top2"); const top3 = r.commit("top3");
    // [what, selection newest first, expected ids]
    const TABLE: Array<[string, string[], string[]]> = [
      ["two contiguous at the tip", [top3, top2], ["cherryPickMany", "revertMany", "squashMany", "dropMany", "compareTwo", "copyShas"]],
      ["three contiguous above the merge", [top3, top2, top], ["cherryPickMany", "revertMany", "squashMany", "dropMany", "copyShas"]],
      ["two with a gap: no squash", [top3, top], ["cherryPickMany", "revertMany", "dropMany", "compareTwo", "copyShas"]],
      ["a merge among them", [top, merge], ["compareTwo", "copyShas"]],
      ["below a merge", [c, b], ["cherryPickMany", "revertMany", "compareTwo", "copyShas"]],
      ["merged in from another branch", [s2, s1], ["cherryPickMany", "revertMany", "compareTwo", "copyShas"]],
      ["three across branches", [top2, s2, b], ["cherryPickMany", "revertMany", "copyShas"]],
    ];
    for (const [what, shas, want] of TABLE) {
      const items = await multiCommitMenuItemsFor(r.ctx, shas);
      assert.deepEqual(ids(items), want, what);
      // The raw list, separators included — ids() drops them, and a menu
      // opening on a divider right under its title passed that way.
      const acts = want.filter((id) => id !== "compareTwo" && id !== "copyShas");
      const rest = want.filter((id) => id === "compareTwo" || id === "copyShas");
      assert.deepEqual(
        items.map((i: { id: string; sep?: boolean }) => (i.sep ? "—" : i.id)),
        [...acts, ...(acts.length ? ["—"] : []), ...rest],
        `${what}: a separator only between the actions and compare/copy`,
      );
    }
    void a;
  } finally {
    r.dispose();
  }
});

test("its words: Title Case with the count, an ellipsis where it asks, Drop in the danger colour", () => {
  const items = multiCommitMenuItems(3, { apply: true, drop: true, squash: true });
  const label = (id: string) => items.find((i: { id: string }) => i.id === id);
  assert.equal(label("cherryPickMany").label, "Cherry-Pick 3 Commits");
  assert.equal(label("revertMany").label, "Revert 3 Commits");
  assert.equal(label("squashMany").label, "Squash 3 Commits…");
  assert.equal(label("dropMany").label, "Drop 3 Commits…");
  assert.equal(label("dropMany").danger, true);
  assert.equal(label("copyShas").label, "Copy SHAs");
  assert.equal(label("compareTwo"), undefined, "compare only for exactly two");
  assert.equal(multiCommitMenuItems(2, { apply: false, drop: false, squash: false }).find((i: { id: string }) => i.id === "compareTwo")?.label, "Compare These Two Commits");
});

test("every icon the menu uses exists in the webview's codicon subset (a missing one is a blank gap)", () => {
  const css = readFileSync(join(__dirname, "../../../packages/webview-ui/src/styles/codicons.ts"), "utf8");
  for (const item of multiCommitMenuItems(2, { apply: true, drop: true, squash: true })) {
    if (item.icon) assert.match(css, new RegExp(`\\.codicon-${item.icon}::before`), `codicon-${item.icon}`);
  }
});

// ── Cherry-Pick N / Revert N ────────────────────────────────────────────────

test("Cherry-Pick N applies them oldest first in one run, and Undo takes them all back", async () => {
  const r = mkRepo();
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "side");
    const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("checkout", "-q", "main");
    const before = r.git("rev-parse", "HEAD");
    const { ledger, undo } = ledgerFor(r);
    reset();
    // Sent newest first, as the list shows them.
    const changed = await runMultiCommitAction("cherryPickMany", r.ctx, [c, b, a], host, undo);
    assert.equal(changed, true);
    assert.deepEqual(r.subjects().slice(0, 3), ["C", "B", "A"], "A first, C last");
    assert.ok(said.some((s) => s.kind === "status" && /Cherry-picked 3 commits\./.test(s.text)), JSON.stringify(said));
    reset();
    await ledger.undoLast();
    assert.equal(r.git("rev-parse", "HEAD"), before, "Undo puts the branch back");
  } finally {
    r.dispose();
  }
});

test("a conflict mid-pick lands on the conflict flow: paused, first commit applied, Resolve Conflicts… offered", async () => {
  const r = mkRepo();
  try {
    r.commit("base", "f.txt", "0\n");
    r.git("checkout", "-q", "-b", "side");
    const a = r.commit("A", "a.txt"); const b = r.commit("B", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("main edit", "f.txt", "main\n");
    reset();
    await runMultiCommitAction("cherryPickMany", r.ctx, [b, a], host);
    const pause = said.find((s) => s.kind === "warning");
    assert.match(pause?.text ?? "", /Cherry-picking 2 commits stopped on a commit that needs you/);
    assert.ok(pause?.items.includes("Resolve Conflicts…"), "the notice opens the conflicts dashboard");
    assert.ok(!said.some((s) => s.kind === "error"), "not an error");
    assert.ok(existsSync(join(r.dir, ".git", "CHERRY_PICK_HEAD")));
    assert.equal(r.git("log", "-1", "--format=%s"), "A");
  } finally {
    r.dispose();
  }
});

test("an edit in the way of a later commit is asked about before anything is picked", async () => {
  const r = mkRepo();
  try {
    r.commit("base", "f.txt", "0\n");
    r.git("checkout", "-q", "-b", "side");
    const a = r.commit("A", "a.txt"); const b = r.commit("B", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    const before = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "f.txt"), "mine\n");
    reset({ confirm: true, pick: "cancel" });
    await runMultiCommitAction("cherryPickMany", r.ctx, [b, a], host);
    const q = asked.find((x) => x.kind === "pick");
    assert.equal(q?.title, "Your uncommitted changes are in the way");
    assert.match(q?.text ?? "", /f\.txt/);
    assert.equal(r.git("rev-parse", "HEAD"), before, "nothing was picked");
    assert.ok(!existsSync(join(r.dir, ".git", "sequencer")), "and no sequencer left open");
  } finally {
    r.dispose();
  }
});

test("Revert N reverts newest first, which is the order that applies", async () => {
  const r = mkRepo();
  try {
    r.commit("base", "f.txt", "0\n");
    const a = r.commit("A", "f.txt", "1\n"); const b = r.commit("B", "f.txt", "2\n");
    reset();
    await runMultiCommitAction("revertMany", r.ctx, [b, a], host);
    assert.equal(readFileSync(join(r.dir, "f.txt"), "utf8"), "0\n");
    assert.deepEqual(r.subjects().slice(0, 2), ['Revert "A"', 'Revert "B"']);
    assert.ok(said.some((s) => /Reverted 2 commits\./.test(s.text)));
  } finally {
    r.dispose();
  }
});

// ── Drop N ───────────────────────────────────────────────────────────────────

test("Drop N asks once, listing every commit, then drops them; Undo restores the tip", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); const c = r.commit("C");
    const tip = r.git("rev-parse", "HEAD");
    const { ledger, undo } = ledgerFor(r);
    reset();
    await runMultiCommitAction("dropMany", r.ctx, [c, a], host, undo);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].kind, "confirm");
    assert.equal(asked[0].title, "Drop 2 commits?");
    assert.match(asked[0].text, new RegExp(`2 commits will be removed from main: ${c.slice(0, 7)} "C" and ${a.slice(0, 7)} "A"\\.`));
    assert.match(asked[0].text, /One later commit will be replayed/);
    assert.equal(asked[0].danger, true);
    assert.deepEqual(r.subjects(), ["B", "base"]);
    reset();
    await ledger.undoLast();
    assert.equal(r.git("rev-parse", "HEAD"), tip);
  } finally {
    r.dispose();
  }
});

test("pushed commits: the question says so, with the force push; No keeps everything", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    r.git("update-ref", "refs/remotes/origin/main", b);
    reset({ confirm: false });
    await runMultiCommitAction("dropMany", r.ctx, [b, a], host);
    assert.match(asked[0].text, /Some of these commits are already pushed\. Dropping them would rewrite history other people have\. The next push will need to be a force push\./);
    assert.deepEqual(r.subjects(), ["B", "A", "base"], "declined: nothing dropped");
  } finally {
    r.dispose();
  }
});

test("a drop over uncommitted changes is refused before the question", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    writeFileSync(join(r.dir, "A.txt"), "edited\n");
    reset();
    await runMultiCommitAction("dropMany", r.ctx, [b, a], host);
    assert.equal(asked.length, 0);
    assert.match(said.find((s) => s.kind === "warning")?.text ?? "", /then drop the commits\./);
  } finally {
    r.dispose();
  }
});

// ── Squash N ─────────────────────────────────────────────────────────────────

test("Squash N opens the message editor pre-filled with every message, and uses what the user wrote", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("feat: parser"); const b = r.commit("wip"); r.commit("later");
    const tip = r.git("rev-parse", "HEAD");
    const { ledger, undo } = ledgerFor(r);
    reset({ confirm: true, input: (v) => `feat: the whole parser\n\n${v}` });
    await runMultiCommitAction("squashMany", r.ctx, [b, a], host, undo);
    const q = asked.find((x) => x.kind === "input");
    assert.equal(q?.title, "Squash 2 commits");
    assert.equal(q?.value, "feat: parser\n\nwip", "oldest first, in full");
    assert.equal(q?.multiline, true);
    assert.equal(q?.selectOnOpen, false, "the caret, not a selection the first keystroke would replace");
    assert.match(q?.text ?? "", /will become one commit with the message below\./);
    assert.deepEqual(r.subjects(), ["later", "feat: the whole parser", "base"]);
    assert.equal(r.git("log", "-1", "--format=%B", "HEAD~1").trim(), "feat: the whole parser\n\nfeat: parser\n\nwip");
    reset();
    await ledger.undoLast();
    assert.equal(r.git("rev-parse", "HEAD"), tip, "Undo restores the commits");
  } finally {
    r.dispose();
  }
});

test("Squash N: dismissing the editor, or emptying it, squashes nothing", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    for (const input of [() => undefined, () => "   "]) {
      reset({ confirm: true, input });
      assert.equal(await runMultiCommitAction("squashMany", r.ctx, [b, a], host), false);
      assert.deepEqual(r.subjects(), ["B", "A", "base"]);
    }
  } finally {
    r.dispose();
  }
});

test("Squash N with a branch on a rewritten commit asks whether it comes along", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("branch", "feature", c);
    r.commit("D");
    reset({ confirm: true, pick: "carry", input: () => "AB" });
    await runMultiCommitAction("squashMany", r.ctx, [b, a], host);
    const pick = asked.find((x) => x.kind === "pick");
    assert.deepEqual(pick?.choices?.map((x) => x.id), ["carry", "only", "no"]);
    assert.equal(pick?.title, "Squash 2 commits — move the branches too?");
    assert.match(pick?.text ?? "", /feature points at a commit that will be rewritten/);
    assert.doesNotMatch(pick?.text ?? "", /message below/, "its choices are below it, not a message");
    assert.equal(r.git("merge-base", "--is-ancestor", "feature", "HEAD"), "", "feature followed the rewrite");
    assert.deepEqual(r.subjects(), ["D", "C", "AB", "base"]);
  } finally {
    r.dispose();
  }
});

test("Squash N that carried branches: Undo puts them back too", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B"); const c = r.commit("C");
    r.git("branch", "on-a", a);
    r.git("branch", "on-c", c);
    const { ledger, undo } = ledgerFor(r);
    reset({ confirm: true, pick: "carry", input: () => "AB" });
    await runMultiCommitAction("squashMany", r.ctx, [b, a], host, undo);
    assert.deepEqual(r.subjects(), ["C", "AB", "base"]);
    assert.notEqual(r.git("rev-parse", "on-c"), c, "on-c followed the squash");
    reset();
    await ledger.undoLast();
    // Each branch that goes back is named, with where it goes.
    const q = asked.find((x) => x.kind === "confirm")?.text ?? "";
    assert.match(q, new RegExp(`'on-a' goes back to ${a.slice(0, 7)}\\.`));
    assert.match(q, new RegExp(`'on-c' goes back to ${c.slice(0, 7)}\\.`));
    assert.equal(r.git("rev-parse", "HEAD"), c);
    assert.equal(r.git("rev-parse", "on-a"), a, "on-a is back");
    assert.equal(r.git("rev-parse", "on-c"), c, "on-c is back");
  } finally {
    r.dispose();
  }
});

test("a stale menu is refused, in words: the selection can no longer be squashed", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); r.commit("B"); const c = r.commit("C");
    reset({ confirm: true, input: () => "x" });
    await runMultiCommitAction("squashMany", r.ctx, [c, a], host);
    assert.equal(asked.length, 0, "no question for a selection with a gap");
    assert.match(said.find((s) => s.kind === "warning")?.text ?? "", /Only commits next to each other on the branch can be squashed/);
  } finally {
    r.dispose();
  }
});

// ── Compare, Copy ───────────────────────────────────────────────────────────

test("Compare These Two Commits opens the compare view older → newer; Copy SHAs copies every one", async () => {
  const r = mkRepo();
  try {
    r.commit("base"); const a = r.commit("A"); const b = r.commit("B");
    compared.length = 0;
    reset();
    await runMultiCommitAction("compareTwo", r.ctx, [b, a], host);
    assert.deepEqual(compared, [[a, b]]);
    await runMultiCommitAction("copyShas", r.ctx, [b, a], host);
    assert.equal(clipboard, `${b}\n${a}`);
    assert.ok(said.some((s) => s.text === "$(check) Copied 2 SHAs"));
  } finally {
    r.dispose();
  }
});
