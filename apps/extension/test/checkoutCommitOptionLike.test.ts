import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

// The graph row's "Checkout Commit" on a commit a branch named "-f" tips
// (issue #30's follow-up). resolveCheckoutTarget offers "Switch to -f", and the
// arm ran `git checkout <picked>` — `git checkout -f`: every uncommitted
// change in the working tree thrown away, HEAD left where it was, and a toast
// saying "Switched to -f". The ref arms refused that name since 4c72977; this
// door, one menu item above them, still handed it to git bare.
//
// The arm imports `vscode`, so this loads the REAL commitActions.ts with
// `vscode` and ui/dialogs swapped for scripted stand-ins, and runs it against
// a real repository: the claim is what git does to the working tree.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-cco-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

/** What the stand-ins were asked, in order. */
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
  env: { clipboard: { writeText: async () => {} } },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
};
/** The branch the "Check out <sha>" pick answers with: the first branch row. */
const dialogsStub = {
  promptPick: async (spec: { choices: { id: string }[] }) => spec.choices.find((c) => c.id !== "..detach")?.id,
  promptConfirm: async () => true,
  promptInput: async () => undefined,
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB_VSCODE = join(tmpdir(), "__gs_vscode_stub__.js");
const STUB_DIALOGS = join(tmpdir(), "__gs_dialogs_stub__.js");
const origResolve = M._resolveFilename;

let repo: string;
let ctx: GitContext;
let dashTip = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runCommitAction: any;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  M._cache[STUB_VSCODE] = { id: STUB_VSCODE, filename: STUB_VSCODE, loaded: true, exports: vscodeStub };
  M._cache[STUB_DIALOGS] = { id: STUB_DIALOGS, filename: STUB_DIALOGS, loaded: true, exports: dialogsStub };
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === "vscode") return STUB_VSCODE;
    const r = origResolve.call(this, request, parent, ...rest);
    return /[\\/]src[\\/]ui[\\/]dialogs\.ts$/.test(r) ? STUB_DIALOGS : r;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ runCommitAction } = require("../src/graph/commitActions"));

  repo = mkdtempSync(join(tmpdir(), "gs-ext-cco-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "f.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(repo, "d.txt"), "dash\n");
  git("add", ".");
  git("commit", "-qm", "dash work");
  dashTip = git("rev-parse", "HEAD");
  // Porcelain refuses a branch called "-f"; update-ref (and a fetch) do not.
  git("update-ref", "refs/heads/-f", dashTip);
  git("reset", "-q", "--hard", "HEAD~1");
  ctx = new GitContext({ root: repo });
});

after(() => {
  M._resolveFilename = origResolve;
  delete M._cache[STUB_VSCODE];
  delete M._cache[STUB_DIALOGS];
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('"Checkout Commit" on the tip of a branch named "-f" never runs `git checkout -f`', async () => {
  // An uncommitted edit: what `git checkout -f` throws away.
  writeFileSync(join(repo, "f.txt"), "UNCOMMITTED WORK\n");
  said.length = 0;
  await runCommitAction("checkout", ctx, {
    sha: dashTip,
    subject: "dash work",
    refs: [{ kind: "head", name: "-f", fullName: "refs/heads/-f" }],
  });
  assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "UNCOMMITTED WORK\n", "the working tree is untouched");
  assert.equal(git("symbolic-ref", "HEAD"), "refs/heads/main", "HEAD stays where it was");
  assert.ok(!said.some((s) => /Switched to -f/.test(s.text)), `no "Switched to -f" — nothing switched: ${JSON.stringify(said)}`);
  const warned = said.find((s) => s.kind === "warning");
  assert.match(warned?.text ?? "", /starts with "-"/, "the refusal says why, as the ref arms do");
  assert.deepEqual(warned?.items, ["Rename…"], "…and offers the rename that fixes it");
});

test('"Checkout Commit" still switches to an ordinary branch by name — the refusal is for "-f" alone', async () => {
  writeFileSync(join(repo, "f.txt"), "base\n");
  git("branch", "ordinary", dashTip);
  said.length = 0;
  await runCommitAction("checkout", ctx, {
    sha: dashTip,
    subject: "dash work",
    refs: [{ kind: "head", name: "ordinary", fullName: "refs/heads/ordinary" }],
  });
  assert.equal(git("symbolic-ref", "HEAD"), "refs/heads/ordinary", "on the branch, not detached");
  assert.ok(said.some((s) => s.kind === "status" && /Switched to ordinary/.test(s.text)), JSON.stringify(said));
  git("checkout", "-q", "main");
});
