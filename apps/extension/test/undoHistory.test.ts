// Undo History against the real ledger and real git: picking an OLDER entry
// undoes every newer one first, newest first, each asked and put back on its
// own terms — never one hard reset to the older entry's HEAD, which threw away
// whatever the newer ops (a checkout, a branch) had changed without naming it.
// And a question answered after the repository moved is not acted on.

import Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  window: { showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined> };
};
const { registerDialogHost, promptConfirm } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { UndoLedger } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-undo-history-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gs-undo-history-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const commit = (msg: string) => {
    writeFileSync(join(dir, `${msg}.txt`), `${msg}\n`);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  const entry = { root: dir, ctx };
  const state = new Map<string, unknown>();
  const context = { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } };
  const ledger = new UndoLedger({ getActive: () => entry, getAll: () => [entry] } as never, context as never);
  const run = <T>(label: string, fn: () => Promise<T>) => ledger.runWithUndo(entry as never, label, fn);
  return { dir, git, commit, ctx, ledger, run };
}

test("Undo History: an older entry is undone after every newer one, newest first, each in its own words", async () => {
  const f = fixture();
  try {
    f.commit("base");
    f.git("branch", "feature");
    const m = f.commit("M");
    await f.run("Commit X", async () => void f.commit("X"));
    await f.run("Checkout feature", async () => void f.git("checkout", "-q", "feature"));

    asked = [];
    vscode.__said.length = 0;
    // Pick the OLDER entry ("Commit X", listed second), then yes to each question.
    answer = (spec) => (spec.kind === "pick" ? spec.choices[1].id : spec.kind === "confirm" ? "ok" : undefined);
    await f.ledger.showHistory();
    const questions = asked.filter((a) => a.kind === "confirm").map((a) => `${a.title} ${"message" in a ? a.message : ""}`);
    assert.deepEqual(questions, [
      `Undo "Checkout feature"? (1 of 2) Switch back to 'main'.`,
      `Undo "Commit X"? (2 of 2) 'main' goes back to ${m.slice(0, 7)}.`,
    ]);
    assert.equal(f.git("symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(f.git("rev-parse", "main"), m);
    assert.equal(f.git("rev-parse", "feature"), f.git("rev-parse", "main~1"), "feature never moved");

    vscode.__said.length = 0;
    await f.ledger.undoLast();
    assert.ok(vscode.__said.some((s) => s.message === "Nothing to undo."), "both entries are done with");
  } finally {
    f.ctx.dispose();
  }
});

test("a confirm answered after the repository moved is not acted on", async () => {
  const f = fixture();
  try {
    f.commit("base");
    await f.run("Commit X", async () => void f.commit("X"));
    const x = f.git("rev-parse", "HEAD");
    asked = [];
    vscode.__said.length = 0;
    // While the question is up, somebody commits on main.
    answer = (spec) => {
      if (spec.kind !== "confirm") return undefined;
      f.commit("meanwhile");
      return "ok";
    };
    await f.ledger.undoLast();
    assert.equal(asked.length, 1);
    assert.ok(
      vscode.__said.some((s) => s.kind === "warning" && /changed while you were being asked/.test(s.message)),
      JSON.stringify(vscode.__said),
    );
    assert.equal(f.git("rev-parse", "HEAD~1"), x, "the commit made meanwhile is still there");
  } finally {
    f.ctx.dispose();
  }
});

test("the toast's Undo undoes ITS operation — after the newer ones, each asked — not whatever is newest", async () => {
  const f = fixture();
  // Hold every "Undid? …" toast open, to press its Undo later.
  const toasts = new Map<string, () => void>();
  const shown = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = (message: string, ...items: string[]) =>
    message.startsWith("Undid? ")
      ? new Promise<string | undefined>((resolve) => void toasts.set(message, () => resolve("Undo")))
      : shown(message, ...items);
  try {
    f.commit("base");
    f.git("branch", "feature");
    const m = f.commit("M");
    await f.run("Commit X", async () => void f.commit("X"));
    await f.run("Checkout feature", async () => void f.git("checkout", "-q", "feature"));

    asked = [];
    answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
    // The OLDER toast's Undo, pressed after the newer op.
    toasts.get("Undid? Commit X")!();
    for (let i = 0; i < 200 && f.git("rev-parse", "main") !== m; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(
      asked.filter((a) => a.kind === "confirm").map((a) => a.title),
      [`Undo "Checkout feature"? (1 of 2)`, `Undo "Commit X"? (2 of 2)`],
      "the newer op first, then the one whose toast it was",
    );
    assert.equal(f.git("symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(f.git("rev-parse", "main"), m, "X is undone");
  } finally {
    vscode.window.showInformationMessage = shown;
    f.ctx.dispose();
  }
});

// ── The pushed-history Revert ────────────────────────────────────────────────

test("the 'already pushed — Revert' question answered after a commit made meanwhile: nothing is reverted, the commit stays", async () => {
  const f = fixture();
  try {
    const remote = mkdtempSync(join(tmpdir(), "gs-undo-history-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    f.git("remote", "add", "origin", remote);
    f.commit("base");
    f.commit("M");
    f.git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
    await f.run("Amend commit", async () => {
      writeFileSync(join(f.dir, "base.txt"), "amended in\n");
      f.git("add", "base.txt");
      f.git("commit", "-q", "--amend", "--no-edit");
    });
    f.git("push", "-q", "-f", "origin", "refs/heads/main:refs/heads/main");
    asked = [];
    vscode.__said.length = 0;
    let C = "";
    answer = (spec) => {
      if (spec.kind !== "confirm") return undefined;
      C = f.commit("C meanwhile");
      return "ok";
    };
    await f.ledger.undoLast();
    assert.equal(asked[0]?.title, `"Amend commit" has already been pushed`);
    assert.ok(
      vscode.__said.some((s) => s.kind === "warning" && /changed while you were being asked/.test(s.message)),
      JSON.stringify(vscode.__said),
    );
    assert.equal(f.git("rev-parse", "HEAD"), C, "the commit made meanwhile is still the tip");
    assert.equal(f.git("log", "-1", "--format=%s"), "C meanwhile");
  } finally {
    f.ctx.dispose();
  }
});

// ── A question open inside the op ────────────────────────────────────────────

test("an edit saved while the op's own question was open: its Undo says it takes that too, in red", async () => {
  const f = fixture();
  try {
    f.commit("base");
    writeFileSync(join(f.dir, "g.txt"), "stashed\n");
    f.git("add", "g.txt");
    f.git("stash", "push", "-q", "-m", "work");
    answer = (spec) => {
      if (spec.kind !== "confirm") return undefined;
      writeFileSync(join(f.dir, "base.txt"), "typed while the question was open\n");
      return "ok";
    };
    await f.run("Pop stash@{0}", async () => {
      if (await promptConfirm({ title: "Pop it?", message: "", confirmLabel: "Pop" })) f.git("stash", "pop", "-q");
    });
    asked = [];
    answer = () => undefined;
    await f.ledger.undoLast();
    const q = asked.find((a) => a.kind === "confirm");
    assert.ok(q && q.kind === "confirm" && q.danger, JSON.stringify(q));
    assert.match(q && "message" in q ? (q.message ?? "") : "", /Anything you changed while its question was open is discarded too\./);
  } finally {
    f.ctx.dispose();
  }
});
