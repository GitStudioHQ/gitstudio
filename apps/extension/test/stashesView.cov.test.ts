// The stash operations' edges, against real git: what each says and does with
// no repository open, with a stash that has left the list, when the dialog is
// dismissed or answered with nothing, when git refuses, and when a race moves
// the list under a question that is up. The happy paths are pinned by
// stashesDoors.test.ts and stashesInChanges.test.ts; these are the doors'
// other exits, each asserted by what the user is told and what git holds after.
//
// vscodeStub.cjs stands in for VS Code (it records every message in `__said`);
// the dialog host answers each question as the test says.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  commands: { executeCommand: (...a: unknown[]) => Promise<unknown> };
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { STASH_GONE_MESSAGE } = require("@gitstudio/git-service/StashProvider") as typeof import("@gitstudio/git-service/StashProvider");
const { NO_REPOSITORY } = require("../src/ui/notify") as typeof import("../src/ui/notify");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec, DialogResult } from "../src/ui/dialogs";

// Hermetic git: an empty global config, no system one.
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-stashcov-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-stashcov-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(join(cfg, ".."), { recursive: true, force: true });
});

let answer: (spec: DialogSpec) => Promise<DialogResult | undefined> | DialogResult | undefined = () => undefined;
let asked: DialogSpec[] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    return answer(spec);
  },
});

type Git = (...a: string[]) => string;
interface Fixture {
  dir: string;
  git: Git;
  write: (f: string, s: string) => void;
  read: (f: string) => string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(scratch, "repo-"));
  const git: Git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const write = (f: string, s: string): void => writeFileSync(join(dir, f), s);
  const read = (f: string): string => readFileSync(join(dir, f), "utf8");
  write("util.ts", "export const a = 1;\n");
  write("app.ts", "app\n");
  write("other.ts", "other\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { dir, git, write, read };
}

const shas = (git: Git): string[] => git("stash", "list", "--format=%H").split("\n").filter((l) => l.length > 0);
const subjects = (git: Git): string[] => git("stash", "list", "--format=%s").split("\n").filter((l) => l.length > 0);
const status = (git: Git): string => git("status", "--porcelain").replace(/\n$/, "");

type Ctx = InstanceType<typeof GitContext>;
interface Ledger {
  runWithUndo: (a: unknown, label: string, run: () => Promise<unknown>, opts?: unknown) => Promise<unknown>;
}

async function withRepo<T>(dir: string, fn: (repos: never, ctx: Ctx) => Promise<T>, ledger?: Ledger): Promise<T> {
  const ctx = new GitContext({ root: dir });
  const entry = { ctx, root: dir };
  const repos = { getActive: () => entry, getAll: () => [entry], getUndoLedger: () => ledger } as never;
  try {
    return await fn(repos, ctx);
  } finally {
    ctx.dispose();
  }
}

/** A window with no repository open. */
const noRepo = { getActive: () => undefined, getAll: () => [], getUndoLedger: () => undefined } as never;

function reset(): void {
  asked = [];
  vscode.__said.length = 0;
  answer = () => undefined;
}

const said = (): string => vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n");

/** Counts the redraws a door asks for. */
function redraws(): { refresh: () => void; count: () => number } {
  let n = 0;
  return { refresh: () => void n++, count: () => n };
}

/** util.ts stashed staged as `a = 2`, working copy `a = 3`; app.ts an unstaged edit. */
function stashMM(f: Fixture): string {
  f.write("util.ts", "export const a = 2;\n");
  f.git("add", "util.ts");
  f.write("util.ts", "export const a = 3;\n");
  f.write("app.ts", "app, stashed\n");
  f.git("stash", "push", "-q", "-m", "staged and not");
  return shas(f.git)[0];
}

/** A stash of a.ts (only staged) and b.ts (an edit), with c.ts staged by the user after. */
function onlyStagedStash(f: Fixture): string {
  f.write("a.ts", "a.ts base\n");
  f.write("b.ts", "b.ts base\n");
  f.git("add", ".");
  f.git("commit", "-q", "-m", "a and b");
  f.write("a.ts", "a.ts STAGED VERSION\n");
  f.git("add", "a.ts");
  f.write("a.ts", "a.ts base\n");
  f.write("b.ts", "b.ts stashed\n");
  f.git("stash", "push", "-q", "-m", "reverted a");
  const [sha] = shas(f.git);
  f.write("c.ts", "mine, staged\n");
  f.git("add", "c.ts");
  return sha;
}

// ── The stash document ───────────────────────────────────────────────────────

test("the stash document for a repository this window does not have open reads as empty", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "x\n");
  git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(git);
  await withRepo(dir, async (repos) => {
    const provider = new stashesView.StashDiffContentProvider(repos as never);
    const elsewhere = await provider.provideTextDocumentContent({
      path: `/${encodeURIComponent("stash@{0}")}.diff`,
      query: new URLSearchParams({ root: join(dir, "not-this-one"), sha }).toString(),
    } as never);
    assert.equal(elsewhere, "", "a root the window does not know serves nothing");
    // …while the same stash in the repository it does know reads as its patch.
    const here = await provider.provideTextDocumentContent({
      path: `/${encodeURIComponent("stash@{0}")}.diff`,
      query: new URLSearchParams({ root: dir, sha }).toString(),
    } as never);
    assert.match(here, /^\+x$/m);
    assert.doesNotThrow(() => provider.dispose());
  });
});

// ── No repository, no stash ──────────────────────────────────────────────────

test("with no repository open every stash door says so once, runs nothing, and keeps nothing it cannot", async () => {
  reset();
  let redrawn = 0;
  const refresh = (): void => void redrawn++;
  const outcomes = [
    await stashesView.applyStash(noRepo, "stash@{0}", refresh),
    await stashesView.popStash(noRepo, "stash@{0}", refresh),
    await stashesView.dropStash(noRepo, "stash@{0}", refresh),
    await stashesView.branchFromStash(noRepo, "stash@{0}", refresh),
    await stashesView.copyStashFiles(noRepo, "stash@{0}", ["a"], refresh),
    await stashesView.moveStashFiles(noRepo, "stash@{0}", ["a"], refresh),
  ];
  assert.deepEqual(outcomes.map((o) => o.kind), ["kept", "kept", "kept", "kept", "kept", "kept"]);
  await stashesView.saveStash(noRepo, refresh);
  assert.equal(await stashesView.pickStash(noRepo, "Apply"), undefined);
  const lines = vscode.__said.map((s) => `${s.kind}: ${s.message}`);
  assert.equal(lines.length, 8, lines.join("\n"));
  assert.ok(lines.every((l) => l === `info: ${NO_REPOSITORY}`), lines.join("\n"));
  assert.equal(asked.length, 0, "nothing is asked");
  assert.equal(redrawn, 0, "nothing to redraw");

  // Only looking: no repository or no stash answers "nothing to redraw", silently.
  vscode.__said.length = 0;
  assert.equal(await stashesView.showStash(noRepo, "stash@{0}"), true);
  assert.equal(await stashesView.openStashFile(noRepo, "stash@{0}", "a.ts"), true);
  assert.equal(vscode.__said.length, 0);
});

test("a door handed no stash at all does nothing and says nothing", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "kept\n");
  git("stash", "push", "-q", "-m", "kept");
  const before = shas(git);
  await withRepo(dir, async (repos) => {
    for (const run of [
      () => stashesView.applyStash(repos, "", () => {}),
      () => stashesView.popStash(repos, "", () => {}),
      () => stashesView.dropStash(repos, "", () => {}),
      () => stashesView.branchFromStash(repos, "", () => {}),
      () => stashesView.copyStashFiles(repos, "", ["app.ts"], () => {}),
      () => stashesView.moveStashFiles(repos, "", ["app.ts"], () => {}),
    ]) {
      assert.deepEqual(await run(), { kind: "kept" });
    }
    assert.equal(await stashesView.showStash(repos, ""), true);
    assert.equal(await stashesView.openStashFile(repos, "", "app.ts"), true);
    assert.equal(await stashesView.openStashFile(repos, before[0], ""), true);
  });
  assert.deepEqual(shas(git), before);
  assert.equal(vscode.__said.length, 0, said());
  assert.equal(asked.length, 0);
});

test("Apply, Pop, Create Branch, Copy and Move on a stash that has left the list: said, the list redrawn, nothing run", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("app.ts", "gone\n");
  git("stash", "push", "-q", "-m", "gone");
  const [gone] = shas(git);
  git("stash", "drop", "-q");
  write("app.ts", "kept\n");
  git("stash", "push", "-q", "-m", "kept");
  const [kept] = shas(git);
  const r = redraws();
  const outcomes = await withRepo(dir, async (repos) => [
    await stashesView.applyStash(repos, gone, r.refresh),
    await stashesView.popStash(repos, gone, r.refresh),
    await stashesView.branchFromStash(repos, gone, r.refresh),
    await stashesView.copyStashFiles(repos, gone, ["app.ts"], r.refresh),
    await stashesView.moveStashFiles(repos, gone, ["app.ts"], r.refresh),
  ]);
  assert.deepEqual(outcomes.map((o) => o.kind), ["gone", "gone", "gone", "gone", "gone"]);
  assert.equal(r.count(), 5, "each redraws the list without it");
  const lines = vscode.__said.map((s) => `${s.kind}: ${s.message}`);
  assert.deepEqual(lines, Array(5).fill(`info: GitStudio: ${STASH_GONE_MESSAGE}`));
  assert.equal(asked.length, 0, "no question about a stash that is not there");
  assert.deepEqual(shas(git), [kept], "the other stash is untouched");
  assert.equal(read("app.ts"), "app\n", "nothing applied");
  assert.equal(git("branch", "--list").trim(), "* main", "no branch made");
});

// ── One operation per stash at a time ────────────────────────────────────────

test("a second Drop of a stash whose first Drop is still asking is ignored — the stash goes once, the one under it stays", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("other.ts", "under\n");
  git("stash", "push", "-q", "-m", "under");
  write("app.ts", "picked\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked, under] = shas(git);
  let release!: (r: DialogResult) => void;
  const confirmed = new Promise<DialogResult>((r) => (release = r));
  answer = () => confirmed;
  const outcomes = await withRepo(dir, async (repos) => {
    const first = stashesView.dropStash(repos, picked, () => {});
    // Wait until the first Drop is at its question: the stash is in flight.
    // A deadline, not a turn count: on a slow runner the git reads before the
    // question outlast any fixed number of event-loop turns.
    for (const until = Date.now() + 30_000; asked.length === 0 && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(asked.length, 1);
    const second = await stashesView.dropStash(repos, picked, () => {});
    release({ value: "ok" });
    return [await first, second];
  });
  assert.deepEqual(outcomes, [{ kind: "done" }, { kind: "kept" }]);
  assert.equal(asked.length, 1, "the second press asked nothing");
  assert.deepEqual(shas(git), [under], "dropped once; the stash that moved into its place is kept");
});

// ── Stash (save) ─────────────────────────────────────────────────────────────

test("Stash on a clean working tree says there is nothing to stash and asks nothing", async () => {
  reset();
  const { dir, git } = fixture();
  let redrawn = 0;
  await withRepo(dir, (repos) => stashesView.saveStash(repos, () => void redrawn++));
  assert.equal(asked.length, 0);
  assert.equal(said(), "info: GitStudio: nothing to stash — the working tree is clean.");
  assert.deepEqual(shas(git), []);
  assert.equal(redrawn, 0);
});

test("Stash dismissed at the file list stashes nothing", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "work\n");
  answer = () => undefined;
  await withRepo(dir, (repos) => stashesView.saveStash(repos, () => {}));
  assert.equal(asked.length, 1);
  assert.deepEqual(shas(git), []);
  assert.equal(status(git), " M app.ts");
  assert.equal(vscode.__said.length, 0, said());
});

test("Stash with every file unticked says so and leaves the working tree as it was", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "work\n");
  write("fresh.ts", "new\n");
  answer = (spec) => (spec.kind === "multiPick" ? { value: [] } : undefined);
  await withRepo(dir, (repos) => stashesView.saveStash(repos, () => {}));
  const dialog = asked[0];
  assert.ok(dialog?.kind === "multiPick");
  // An untracked file is listed as new, so the tick decides — no "-u" to know about.
  const fresh = dialog.choices.find((c) => c.id === "f:fresh.ts");
  assert.deepEqual([fresh?.icon, fresh?.detail, fresh?.picked], ["new-file", "new", true]);
  assert.equal(dialog.choices.some((c) => c.id === "o:keep"), false, "nothing staged: no --keep-index to offer");
  assert.equal(said(), "info: GitStudio: nothing stashed — every file was unticked.");
  assert.deepEqual(shas(git), []);
  assert.equal(status(git), " M app.ts\n?? fresh.ts");
});

test("Stash with 'Add a message…' ticked asks for the name and stashes under it; dismissing the name stashes nothing", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "work\n");
  const tickAll = (spec: DialogSpec): string[] =>
    spec.kind === "multiPick" ? [...spec.choices.filter((c) => c.picked).map((c) => c.id), "o:message"] : [];

  answer = (spec) => (spec.kind === "multiPick" ? { value: tickAll(spec) } : undefined); // name dismissed
  await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => {}));
  assert.deepEqual(asked.map((s) => s.kind), ["multiPick", "input"]);
  assert.equal(asked[1].title, "Name this stash");
  assert.deepEqual(shas(f.git), [], "no name, no stash");
  assert.equal(status(f.git), " M app.ts");

  reset();
  let redrawn = 0;
  answer = (spec) =>
    spec.kind === "multiPick" ? { value: tickAll(spec) } : spec.kind === "input" ? { value: "halfway through the parser" } : undefined;
  await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => void redrawn++));
  assert.deepEqual(subjects(f.git), ["On main: halfway through the parser"]);
  assert.equal(status(f.git), "");
  assert.equal(redrawn, 1);
  assert.match(said(), /^status: \$\(check\) Stashed /m);
});

test("Stash everything staged: confirmed by count, the index goes whole and the working tree stays", async () => {
  reset();
  const f = fixture();
  f.write("util.ts", "export const a = 2;\n");
  f.git("add", "util.ts");
  f.write("app.ts", "not staged\n");
  answer = (spec) => (spec.kind === "multiPick" ? { value: [] } : undefined); // no file rows to tick
  await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => {}, { stagedOnly: true }));
  const dialog = asked[0];
  assert.ok(dialog?.kind === "multiPick");
  assert.equal(dialog.title, "Stash everything staged (1 file)");
  assert.match(dialog.hint ?? "", /util\.ts — the index is stashed whole; the working tree is left alone\.$/);
  assert.deepEqual(dialog.choices.map((c) => c.id), ["o:message"], "no per-file ticks, no --keep-index");
  assert.deepEqual(subjects(f.git).length, 1);
  assert.equal(f.git("show", "stash@{0}^2:util.ts"), "export const a = 2;\n", "the staged version is in the stash");
  assert.equal(status(f.git), " M app.ts", "the unstaged edit stays in the working tree");
});

test("Stash of nothing staged in staged mode says the working tree is clean before asking", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "not staged\n");
  await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => {}, { stagedOnly: true }));
  assert.equal(asked.length, 0);
  assert.equal(said(), "info: GitStudio: nothing to stash — the working tree is clean.");
  assert.deepEqual(shas(f.git), []);
});

test("Stash that git refuses (the index is locked) says so in red and redraws nothing", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "work\n");
  const lock = join(f.dir, ".git", "index.lock");
  answer = (spec) => {
    if (spec.kind !== "multiPick") return undefined;
    writeFileSync(lock, ""); // another git holds the index while the dialog is up
    return { value: spec.choices.filter((c) => c.picked).map((c) => c.id) };
  };
  let redrawn = 0;
  try {
    await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => void redrawn++));
  } finally {
    rmSync(lock, { force: true });
  }
  assert.match(said(), /^error: GitStudio: Stash failed — /m);
  assert.doesNotMatch(said(), /^status:/m, "nothing claimed stashed");
  assert.deepEqual(shas(f.git), []);
  assert.equal(f.read("app.ts"), "work\n");
  assert.equal(redrawn, 0);
});

test("Stash of a change undone while the dialog was up says nothing was stashed — for the tree and for a selection", async () => {
  for (const narrowed of [false, true]) {
    reset();
    const f = fixture();
    f.write("app.ts", "work\n");
    f.write("other.ts", "more work\n");
    answer = (spec) => {
      if (spec.kind !== "multiPick") return undefined;
      // Both edits are undone (an editor's revert) while the list is up.
      f.write("app.ts", "app\n");
      f.write("other.ts", "other\n");
      const ids = spec.choices.filter((c) => c.picked).map((c) => c.id);
      return { value: narrowed ? ids.filter((id) => id !== "f:other.ts") : ids };
    };
    let redrawn = 0;
    await withRepo(f.dir, (repos) => stashesView.saveStash(repos, () => void redrawn++));
    assert.equal(
      said(),
      narrowed
        ? "info: GitStudio: Nothing to stash — the files you selected have no changes."
        : "info: GitStudio: Nothing to stash — the working tree is clean.",
    );
    assert.deepEqual(shas(f.git), [], "no stash was claimed");
    assert.equal(redrawn, 1, "the list is redrawn to show the tree as it is");
  }
});

// ── Drop ─────────────────────────────────────────────────────────────────────

test("Drop declined keeps the stash; Drop through Undo is named by its message and runs as refs-only", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "keep me");
  const [sha] = shas(f.git);
  answer = () => undefined;
  const hooked: string[] = [];
  const declined = await withRepo(f.dir, (repos) =>
    stashesView.dropStash(repos, sha, () => {}, { onConfirmed: () => void hooked.push("confirmed") }),
  );
  assert.deepEqual(declined, { kind: "kept" });
  assert.deepEqual(shas(f.git), [sha]);
  assert.equal(hooked.length, 0, "the row stays: nothing was confirmed");

  reset();
  answer = () => ({ value: "ok" });
  const undo: { label: string; opts: unknown }[] = [];
  const ledger: Ledger = {
    runWithUndo: async (_a, label, run, opts) => {
      undo.push({ label, opts });
      return run();
    },
  };
  const dropped = await withRepo(
    f.dir,
    (repos) => stashesView.dropStash(repos, sha, () => {}, { onConfirmed: () => void hooked.push("confirmed") }),
    ledger,
  );
  assert.deepEqual(dropped, { kind: "done" });
  assert.deepEqual(undo, [{ label: "Drop “keep me”", opts: { refsOnly: true } }]);
  assert.deepEqual(hooked, ["confirmed"]);
  assert.deepEqual(shas(f.git), []);
  assert.match(said(), /^status: \$\(check\) Dropped stash$/m);
});

test("Drop of a stash that leaves the list while the confirm is up: said as that, redrawn, answered gone", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(f.git);
  answer = () => {
    f.git("stash", "drop", "-q"); // a terminal drops it meanwhile
    return { value: "ok" };
  };
  const r = redraws();
  const out = await withRepo(f.dir, (repos) => stashesView.dropStash(repos, sha, r.refresh));
  assert.deepEqual(out, { kind: "gone" });
  assert.equal(said(), `info: GitStudio: ${STASH_GONE_MESSAGE}`);
  assert.equal(r.count(), 1);
});

test("Drop that git refuses (the stash ref is locked) says so in red, keeps the stash, and redraws", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(f.git);
  const lock = join(f.dir, ".git", "refs", "stash.lock");
  answer = () => {
    writeFileSync(lock, "");
    return { value: "ok" };
  };
  const r = redraws();
  let out;
  try {
    out = await withRepo(f.dir, (repos) => stashesView.dropStash(repos, sha, r.refresh));
  } finally {
    rmSync(lock, { force: true });
  }
  assert.deepEqual(out, { kind: "kept" });
  assert.match(said(), /^error: GitStudio: Drop stash failed — .*refs\/stash/m);
  assert.equal(r.count(), 1);
  assert.deepEqual(shas(f.git), [sha]);
});

// ── Create Branch ────────────────────────────────────────────────────────────

test("Create Branch with the name dismissed makes nothing and keeps the stash", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(f.git);
  answer = () => undefined;
  const out = await withRepo(f.dir, (repos) => stashesView.branchFromStash(repos, sha, () => {}));
  assert.deepEqual(out, { kind: "kept" });
  assert.equal(asked[0]?.kind, "input");
  assert.equal(asked[0]?.title, "Create branch from “x”");
  assert.equal(f.git("branch", "--list").trim(), "* main");
  assert.deepEqual(shas(f.git), [sha]);
});

// ── Copy / Move some of a stash's files ──────────────────────────────────────

test("Copy and Move of files the stash no longer holds say so, redraw, and change nothing", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.write("other.ts", "y\n");
  f.git("stash", "push", "-q", "-m", "two");
  const [sha] = shas(f.git);
  const r = redraws();
  const outcomes = await withRepo(f.dir, async (repos) => [
    await stashesView.copyStashFiles(repos, sha, ["util.ts"], r.refresh),
    await stashesView.moveStashFiles(repos, sha, ["util.ts"], r.refresh),
  ]);
  assert.deepEqual(outcomes, [{ kind: "kept" }, { kind: "kept" }]);
  assert.deepEqual(vscode.__said.map((s) => `${s.kind}: ${s.message}`), [
    "info: GitStudio: those files are no longer in the stash.",
    "info: GitStudio: those files are no longer in the stash.",
  ]);
  assert.equal(r.count(), 2);
  assert.deepEqual(shas(f.git), [sha]);
  assert.equal(status(f.git), "");
});

test("Copy and Move whose part of the stash git cannot cut say git's words and change nothing", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.write("other.ts", "y\n");
  f.git("stash", "push", "-q", "-m", "two");
  const [sha] = shas(f.git);
  const outcomes = await withRepo(f.dir, async (repos, ctx) => {
    ctx.stashes.subset = async () => ({ ok: false, stderr: "fatal: unable to write new index file" }) as never;
    return [
      await stashesView.copyStashFiles(repos, sha, ["app.ts"], () => {}),
      await stashesView.moveStashFiles(repos, sha, ["app.ts"], () => {}),
    ];
  });
  assert.deepEqual(outcomes, [{ kind: "kept" }, { kind: "kept" }]);
  assert.deepEqual(vscode.__said.map((s) => `${s.kind}: ${s.message}`), [
    "error: GitStudio: fatal: unable to write new index file",
    "error: GitStudio: fatal: unable to write new index file",
  ]);
  assert.deepEqual(shas(f.git), [sha]);
  assert.equal(status(f.git), "", "no file came back");
});

test("Move whose stash leaves the list before what is left of it is written: the files are in Changes, and it says nothing more changed", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.write("other.ts", "y\n");
  f.git("stash", "push", "-q", "-m", "two");
  const [sha] = shas(f.git);
  const r = redraws();
  const out = await withRepo(f.dir, async (repos, ctx) => {
    const replace = ctx.stashes.replace.bind(ctx.stashes);
    ctx.stashes.replace = async (stash, rest) => {
      f.git("stash", "drop", "-q"); // a terminal drops it just before
      return replace(stash, rest);
    };
    return stashesView.moveStashFiles(repos, sha, ["app.ts"], r.refresh);
  });
  assert.deepEqual(out, { kind: "done" }, "done, but with no rest: there is no stash left to redraw");
  assert.equal(f.read("app.ts"), "x\n", "the moved file is in Changes");
  assert.equal(status(f.git), " M app.ts");
  assert.deepEqual(shas(f.git), []);
  assert.match(said(), /^warning: GitStudio: The files are in Changes, but “two” had left the stash list meanwhile, so nothing more was changed\.$/m);
  assert.match(said(), /^status: \$\(check\) Moved 1 file to Changes$/m);
  assert.equal(r.count(), 1);
});

test("Move whose stash git will not rewrite: the files are in Changes, the stash is kept whole, and git's reason is said", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.write("other.ts", "y\n");
  f.git("stash", "push", "-q", "-m", "two");
  const [sha] = shas(f.git);
  const out = await withRepo(f.dir, async (repos, ctx) => {
    ctx.stashes.replace = async () => ({ ok: false, stderr: "cannot lock ref 'refs/stash'\n" }) as never;
    return stashesView.moveStashFiles(repos, sha, ["app.ts"], () => {});
  });
  assert.deepEqual(out, { kind: "done" });
  assert.equal(status(f.git), " M app.ts");
  assert.deepEqual(shas(f.git), [sha], "the stash still holds both");
  assert.match(said(), /^warning: GitStudio: The files are in Changes, but the stash couldn't be updated — cannot lock ref 'refs\/stash'\.$/m);
});

test("Copy of one staged file whose staged version no longer applies at HEAD asks in that file's words; Cancel changes nothing", async () => {
  reset();
  const f = fixture();
  const sha = stashMM(f);
  f.write("util.ts", "export const a = 7;\n");
  f.git("commit", "-q", "-am", "HEAD moves under the staged file");
  answer = () => ({ value: "cancel" });
  const out = await withRepo(f.dir, (repos) => stashesView.copyStashFiles(repos, sha, ["util.ts"], () => {}));
  assert.deepEqual(out, { kind: "kept" });
  const q = asked.find((s) => s.kind === "pick");
  assert.ok(q && q.kind === "pick", asked.map((s) => s.title).join(" | "));
  assert.equal(q.title, "Copy the file without its staging?");
  assert.equal(
    q.hint,
    "“util.ts” was staged in “staged and not”, and its staged version no longer applies to what HEAD has now. Nothing has changed yet.",
  );
  assert.deepEqual(q.choices.map((c) => c.id), ["unstaged", "cancel"]);
  assert.equal(status(f.git), "");
  assert.deepEqual(shas(f.git), [sha]);
});

// ── A stash holding a file only staged, where git cannot cut its plain part ──

for (const verb of ["apply", "pop"] as const) {
  test(`${verb} Unstaged of a stash holding a file only staged, when git cannot cut it: git's words, nothing applied, the stash kept`, async () => {
    reset();
    const f = fixture();
    const sha = onlyStagedStash(f);
    answer = () => ({ value: "unstaged" });
    const r = redraws();
    const out = await withRepo(f.dir, async (repos, ctx) => {
      const subset = ctx.stashes.subset.bind(ctx.stashes);
      ctx.stashes.subset = async (stash, paths, opts) =>
        opts?.unstaged ? ({ ok: false, stderr: "fatal: could not cut the stash" } as never) : subset(stash, paths, opts);
      return verb === "pop"
        ? stashesView.popStash(repos, sha, r.refresh)
        : stashesView.applyStash(repos, sha, r.refresh);
    });
    assert.deepEqual(out, { kind: "kept" });
    assert.match(said(), /^error: GitStudio: fatal: could not cut the stash$/m);
    assert.equal(r.count(), 1, "redrawn to the list as it is");
    assert.deepEqual(shas(f.git), [sha]);
    assert.equal(status(f.git), "A  c.ts", "only the user's own staged work");
  });
}

test("Pop Unstaged of a stash holding a file only staged, whose drop git refuses after: its changes are back, and the stash is named as kept", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, async (repos, ctx) => {
    ctx.stashes.drop = async () => ({ ok: false, stderr: "error: cannot lock ref 'refs/stash'\n" }) as never;
    return stashesView.popStash(repos, sha, () => {});
  });
  assert.deepEqual(out, { kind: "done" });
  assert.equal(f.read("a.ts"), "a.ts STAGED VERSION\n", "the change came back");
  assert.equal(f.read("b.ts"), "b.ts stashed\n");
  assert.deepEqual(shas(f.git), [sha], "not dropped");
  assert.match(said(), /^warning: GitStudio: its changes are back, but “reverted a” couldn't be dropped — error: cannot lock ref 'refs\/stash'$/m);
});

test("Copy Unstaged of a file only staged, when git cannot cut its plain part: git's words, nothing copied", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const r = redraws();
  const out = await withRepo(f.dir, async (repos, ctx) => {
    const subset = ctx.stashes.subset.bind(ctx.stashes);
    ctx.stashes.subset = async (stash, paths, opts) =>
      opts?.unstaged ? ({ ok: false, stderr: "fatal: no plain part" } as never) : subset(stash, paths, opts);
    return stashesView.copyStashFiles(repos, sha, ["a.ts"], r.refresh);
  });
  assert.deepEqual(out, { kind: "kept" });
  assert.match(said(), /^error: GitStudio: fatal: no plain part$/m);
  assert.equal(f.read("a.ts"), "a.ts base\n", "nothing came back");
  assert.deepEqual(shas(f.git), [sha]);
  assert.equal(r.count(), 1);
});

// ── Looking ──────────────────────────────────────────────────────────────────

test("opening a file the stash no longer holds says so and answers false; nothing is opened", async () => {
  reset();
  const f = fixture();
  f.write("app.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(f.git);
  const opened: unknown[] = [];
  const original = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (...a: unknown[]) => void opened.push(a);
  try {
    const ok = await withRepo(f.dir, (repos) => stashesView.openStashFile(repos, sha, "src/gone.ts"));
    assert.equal(ok, false);
  } finally {
    vscode.commands.executeCommand = original;
  }
  assert.deepEqual(opened, []);
  assert.equal(said(), "info: GitStudio: “src/gone.ts” is no longer in that stash.");
  assert.ok(existsSync(join(f.dir, ".git")));
});
