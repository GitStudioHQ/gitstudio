// The doors behind the Changes view's Stashes group, driven as the group
// drives them, against real git: Copy to Changes and Move to Changes for some
// of a stash's files, a file's diff, and the palette's way to a stash.
//
// The state table (packages/git-service/test/stashFiles.test.ts has the git
// half — every kind of file, HEAD moved, the list renumbered):
//   A  copy some files · move some files · move every file (a Pop) · open a
//      file's diff · pick a stash from the palette
//   L  clean · an edit of the user's to a picked file (asked, never
//      overwritten; Cancel changes nothing; Stash & Retry keeps both) · staged
//      changes of the user's under a stash's staged file (the staging question)
//   S  the stash dropped while a question is open · a stash pushed while it is
//      open · a stash another tool stored · a file already moved out
//   W  two worktrees sharing one list
//
// vscodeStub.cjs stands in for VS Code; the dialog host answers each question
// as the cell says and records it.

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
  commands: { executeCommand: (...args: unknown[]) => Promise<unknown> };
  Uri: Record<string, unknown>;
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec, DialogResult } from "../src/ui/dialogs";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-stashes-in-changes-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-stashes-in-changes-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let answer: (spec: DialogSpec) => DialogResult | undefined = () => undefined;
let asked: DialogSpec[] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    return answer(spec);
  },
});

function reset(): void {
  asked = [];
  vscode.__said.length = 0;
  answer = () => undefined;
}

interface Fixture {
  dir: string;
  git: (...a: string[]) => string;
  write: (f: string, s: string) => void;
  read: (f: string) => string | null;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(scratch, "repo-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const write = (f: string, s: string): void => writeFileSync(join(dir, f), s);
  const read = (f: string): string | null => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
  for (const f of ["a.ts", "b.ts", "c.ts", "old.md"]) write(f, `${f} base\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { dir, git, write, read };
}

/** A stash of edits to a.ts and b.ts, a staged rename old.md → new.md and an untracked n.ts. */
function stashFour(f: Fixture, message = "four"): string {
  f.write("a.ts", "a.ts stashed\n");
  f.write("b.ts", "b.ts stashed\n");
  f.git("mv", "old.md", "new.md");
  f.write("n.ts", "n.ts new\n");
  f.git("stash", "push", "-q", "-u", "-m", message);
  return shas(f)[0];
}

const shas = (f: Fixture): string[] => f.git("stash", "list", "--format=%H").split("\n").filter(Boolean);
const status = (f: Fixture): string => f.git("status", "--porcelain").replace(/\n$/, "");
const said = (): string => vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n");

async function withRepo<T>(dir: string, fn: (repos: never, ctx: InstanceType<typeof GitContext>) => Promise<T>): Promise<T> {
  const ctx = new GitContext({ root: dir });
  const entry = { ctx, root: dir };
  const repos = { getActive: () => entry, getAll: () => [entry], getUndoLedger: () => undefined } as never;
  try {
    return await fn(repos, ctx);
  } finally {
    ctx.dispose();
  }
}

const filesOf = async (dir: string, sha: string): Promise<string[]> =>
  withRepo(dir, async (_r, ctx) => ((await ctx.stashes.files(sha)) ?? []).map((x) => x.path));

// ── Copy to Changes ──────────────────────────────────────────────────────────

test("copy: the picked files come back as stashed, and the stash keeps every file", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  const out = await withRepo(f.dir, (repos) => stashesView.copyStashFiles(repos, sha, ["a.ts", "n.ts"], () => {}));
  assert.deepEqual(out, { kind: "done" });
  assert.equal(status(f), " M a.ts\n?? n.ts");
  assert.deepEqual(shas(f), [sha], "the stash is untouched");
  assert.deepEqual(await filesOf(f.dir, sha), ["a.ts", "b.ts", "n.ts", "new.md"]);
  assert.match(said(), /^status: \$\(check\) Copied 2 files to Changes$/m);
});

// ── Move to Changes ──────────────────────────────────────────────────────────

test("move: the picked files come back and leave the stash; the rest stays where the stash was", async () => {
  reset();
  const f = fixture();
  f.write("c.ts", "older\n");
  f.git("stash", "push", "-q", "-m", "older");
  const sha = stashFour(f);
  f.write("c.ts", "newer\n");
  f.git("stash", "push", "-q", "-m", "newer");
  const [newer, , older] = shas(f);
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "done");
  const rest = out.kind === "done" ? out.rest : undefined;
  assert.ok(rest && rest !== sha, "what is left is a new stash");
  assert.deepEqual(shas(f), [newer, rest, older], "in the moved stash's place");
  assert.equal(f.git("stash", "list", "--format=%gs").split("\n")[1], "On main: four", "under its message");
  assert.deepEqual(await filesOf(f.dir, rest!), ["b.ts", "n.ts", "new.md"]);
  assert.equal(status(f), " M a.ts");
  assert.match(said(), /^status: \$\(check\) Moved 1 file to Changes$/m);
});

test("move a rename by its new name: both of its names come out, and neither is left in the stash", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["new.md"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(status(f), "R  old.md -> new.md");
  assert.deepEqual(await filesOf(f.dir, shas(f)[0]), ["a.ts", "b.ts", "n.ts"]);
});

test("move every file: that is a Pop — the stash is gone and everything is back", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  const out = await withRepo(f.dir, (repos) =>
    stashesView.moveStashFiles(repos, sha, ["a.ts", "b.ts", "n.ts", "new.md"], () => {}),
  );
  assert.deepEqual(out, { kind: "done" });
  assert.deepEqual(shas(f), []);
  assert.equal(status(f), " M a.ts\n M b.ts\nR  old.md -> new.md\n?? n.ts", "staging and all");
});

test("move over an edit of the user's to that file: asked, and Cancel changes nothing at all", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  f.write("a.ts", "mine\n");
  const before = status(f);
  answer = () => ({ value: "cancel" });
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.deepEqual(out, { kind: "kept" });
  const q = asked.find((s) => s.kind === "pick");
  assert.equal(q?.title, "Your uncommitted changes are in the way");
  assert.match(q?.hint ?? "", /a\.ts/);
  assert.equal(status(f), before, "nothing written");
  assert.equal(f.read("a.ts"), "mine\n");
  assert.deepEqual(shas(f), [sha], "the stash is whole");
  assert.deepEqual(await filesOf(f.dir, sha), ["a.ts", "b.ts", "n.ts", "new.md"]);
});

test("move over an edit of the user's, Stash & Retry: the file comes out, and the user's edit is kept and said where", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  f.write("a.ts", "mine\n");
  answer = (spec) => (spec.kind === "pick" ? { value: "stash" } : undefined);
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("a.ts"), "a.ts stashed\n", "the stash's version is in Changes");
  // git will not put the user's edit back over the file that came in, so
  // Stash & Retry keeps it in its own stash — never overwritten, and said.
  const list = f.git("stash", "list", "--format=%H %gs").trim().split("\n");
  const kept = list.find((l) => / GitStudio: /.test(l));
  assert.ok(kept, `the user's edit is in a stash of its own: ${list.join(" | ")}`);
  assert.equal(f.git("show", `${kept!.split(" ")[0]}:a.ts`), "mine\n");
  assert.match(said(), /^warning: GitStudio: .*stash/m);
  // The moved stash's rest is still in the list, without a.ts.
  const rest = list.map((l) => l.split(" ")[0]).find((s) => s !== kept!.split(" ")[0]);
  assert.deepEqual(await filesOf(f.dir, rest!), ["b.ts", "n.ts", "new.md"]);
});

test("move a file the stash had staged over staged work of the user's: the staging question, and Cancel changes nothing", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "a.ts staged in the stash\n");
  f.git("add", "a.ts");
  f.write("b.ts", "b.ts stashed\n");
  f.git("stash", "push", "-q", "-m", "staged a");
  const [sha] = shas(f);
  f.write("c.ts", "mine, staged\n");
  f.git("add", "c.ts");
  const before = status(f);
  answer = () => ({ value: "cancel" });
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.deepEqual(out, { kind: "kept" });
  const q = asked.find((s) => s.kind === "pick");
  assert.equal(q?.title, "Move the file without its staging?");
  assert.match(q?.hint ?? "", /^“a\.ts” was staged in “staged a”/);
  assert.equal(status(f), before);
  assert.deepEqual(shas(f), [sha]);

  // …and Move Unstaged brings it back unstaged, out of the stash.
  reset();
  answer = () => ({ value: "unstaged" });
  const moved = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(moved.kind, "done");
  assert.equal(status(f), " M a.ts\nM  c.ts");
  assert.deepEqual(await filesOf(f.dir, shas(f)[0]), ["b.ts"]);
});

// ── Without its staging: a file the stash holds only staged ──────────────────
//
// a.ts was staged, then put back in the working tree before the stash was
// made: the stash's working copy of it is the base, and its change lives only
// in the stash's index. A plain apply restores working copies — so without
// its staging nothing of a.ts came back, and a Move then took it out of the
// stash anyway. The cells: Move, Copy, Pop, Apply, each answered "without
// staging" over staged work of the user's (c.ts).

/** A stash of a.ts (only staged) and b.ts (an edit), with c.ts staged by the user after. */
function onlyStagedStash(f: Fixture): string {
  f.write("a.ts", "a.ts STAGED VERSION\n");
  f.git("add", "a.ts");
  f.write("a.ts", "a.ts base\n");
  f.write("b.ts", "b.ts stashed\n");
  f.git("stash", "push", "-q", "-m", "reverted a");
  const [sha] = shas(f);
  f.write("c.ts", "mine, staged\n");
  f.git("add", "c.ts");
  return sha;
}

/** The "without staging" choice's words, from the question asked. */
const unstagedChoice = (): string => {
  const q = asked.find((s) => s.kind === "pick");
  const c = q && q.kind === "pick" ? q.choices.find((x) => x.id === "unstaged") : undefined;
  return `${c?.label ?? "(none)"}: ${c?.description ?? ""}`;
};

test("only staged, Move Unstaged: its staged change comes back as an unstaged one, and leaves the stash", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("a.ts"), "a.ts STAGED VERSION\n", "the change came back");
  assert.equal(status(f), " M a.ts\nM  c.ts", "unstaged, and the user's staged work as it was");
  assert.deepEqual(await filesOf(f.dir, shas(f)[0]), ["b.ts"]);
  assert.match(said(), /^status: \$\(check\) Moved 1 file to Changes$/m);
  assert.match(unstagedChoice(), /^Move Unstaged: Its changes come back unstaged and leave the stash\.$/, "nothing is lost, so nothing is said lost");
});

test("only staged, Copy Unstaged: its staged change comes back as an unstaged one, and the stash keeps it", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, (repos) => stashesView.copyStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("a.ts"), "a.ts STAGED VERSION\n");
  assert.equal(status(f), " M a.ts\nM  c.ts");
  assert.deepEqual(shas(f), [sha], "the stash is untouched");
  assert.match(said(), /^status: \$\(check\) Copied 1 file to Changes$/m);
});

test("only staged, Pop Unstaged of the whole stash: every change comes back, and the stash is dropped", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, (repos) => stashesView.popStash(repos, sha, () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("a.ts"), "a.ts STAGED VERSION\n");
  assert.equal(f.read("b.ts"), "b.ts stashed\n");
  assert.equal(status(f), " M a.ts\n M b.ts\nM  c.ts");
  assert.deepEqual(shas(f), [], "popped");
  assert.match(unstagedChoice(), /^Pop Unstaged: Its changes come back unstaged and the stash is dropped\.$/);
});

test("only staged, Apply Unstaged of the whole stash: every change comes back, and the stash is kept as it was", async () => {
  reset();
  const f = fixture();
  const sha = onlyStagedStash(f);
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, (repos) => stashesView.applyStash(repos, sha, () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("a.ts"), "a.ts STAGED VERSION\n");
  assert.equal(status(f), " M a.ts\n M b.ts\nM  c.ts");
  assert.deepEqual(shas(f), [sha]);
  assert.deepEqual(await filesOf(f.dir, sha), ["a.ts", "b.ts"]);
});

// Without --index git brings every change back unstaged but a new file and a
// rename's new name, which it adds back staged. In the real Cursor the
// question said "Its changes come back unstaged" and layout.css came back
// staged. Now: where all a stash had staged is new files, staged as they
// are, the plain apply IS the apply with its staging — nothing is asked;
// otherwise the words name what git adds back staged.
test("all it had staged is a new file: nothing is asked, and it all comes back as it was stashed", async () => {
  for (const pop of [false, true]) {
    reset();
    const f = fixture();
    f.write("fresh.ts", "fresh\n");
    f.git("add", "fresh.ts");
    f.write("b.ts", "b.ts stashed\n");
    f.git("stash", "push", "-q", "-m", "with a new file");
    const [sha] = shas(f);
    f.write("c.ts", "mine, staged\n");
    f.git("add", "c.ts");
    answer = () => undefined;
    const out = await withRepo(f.dir, (repos) => (pop ? stashesView.popStash : stashesView.applyStash)(repos, sha, () => {}));
    assert.equal(out.kind, "done");
    assert.equal(asked.filter((q) => q.kind === "pick").length, 0, "no question: it would change nothing");
    const lines = status(f).split("\n");
    for (const l of ["A  fresh.ts", " M b.ts", "M  c.ts"]) assert.ok(lines.includes(l), `${l}: ${lines.join(" | ")}`);
    assert.deepEqual(shas(f), pop ? [] : [sha]);
  }
});

test("a new file and a staged edit: the question says git adds the new file back staged — and git does", async () => {
  for (const pop of [false, true]) {
    reset();
    const f = fixture();
    f.write("fresh.ts", "fresh\n");
    f.write("a.ts", "a.ts staged in the stash\n");
    f.git("add", "fresh.ts", "a.ts");
    f.write("b.ts", "b.ts stashed\n");
    f.git("stash", "push", "-q", "-m", "with a new file");
    const [sha] = shas(f);
    f.write("c.ts", "mine, staged\n");
    f.git("add", "c.ts");
    answer = () => ({ value: "unstaged" });
    const out = await withRepo(f.dir, (repos) => (pop ? stashesView.popStash : stashesView.applyStash)(repos, sha, () => {}));
    assert.equal(out.kind, "done");
    assert.match(
      unstagedChoice(),
      pop
        ? /^Pop Unstaged: Its changes come back unstaged, but for a new file, which git adds back staged, and the stash is dropped\.$/
        : /^Apply Unstaged: Its changes come back unstaged, but for a new file, which git adds back staged\. The stash is kept, staging and all\.$/,
    );
    const lines = status(f).split("\n");
    for (const l of ["A  fresh.ts", " M a.ts", " M b.ts", "M  c.ts"]) assert.ok(lines.includes(l), `${l}: ${lines.join(" | ")}`);
  }
});

test("a staged rename: the question says git adds the renamed file back staged — and git does", async () => {
  reset();
  const f = fixture();
  f.git("mv", "b.ts", "b2.ts");
  f.write("a.ts", "a.ts staged in the stash\n");
  f.git("add", "a.ts");
  f.git("stash", "push", "-q", "-m", "renamed b");
  const [sha] = shas(f);
  f.write("c.ts", "mine, staged\n");
  f.git("add", "c.ts");
  answer = () => ({ value: "unstaged" });
  const out = await withRepo(f.dir, (repos) => stashesView.applyStash(repos, sha, () => {}));
  assert.equal(out.kind, "done");
  assert.match(unstagedChoice(), /^Apply Unstaged: Its changes come back unstaged, but for a renamed file, which git adds back staged\. The stash is kept, staging and all\.$/);
  const lines = status(f).split("\n");
  for (const l of ["A  b2.ts", " M a.ts", "M  c.ts"]) assert.ok(lines.includes(l), `${l}: ${lines.join(" | ")}`);
});

test("staged, then edited again: without its staging the staged version is lost — and the question says so", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "a.ts staged\n");
  f.git("add", "a.ts");
  f.write("a.ts", "a.ts staged\nand edited after\n");
  f.write("b.ts", "b.ts stashed\n");
  f.git("stash", "push", "-q", "-m", "partly staged a");
  const [sha] = shas(f);
  f.write("c.ts", "mine, staged\n");
  f.git("add", "c.ts");
  answer = () => ({ value: "cancel" });
  await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.match(unstagedChoice(), /^Move Unstaged: Its changes come back unstaged and leave the stash\. It was staged and then changed again, so its staged version is not kept\.$/);
  reset();
  answer = () => ({ value: "cancel" });
  await withRepo(f.dir, (repos) => stashesView.popStash(repos, sha, () => {}));
  assert.match(unstagedChoice(), /^Pop Unstaged: Its changes come back unstaged and the stash is dropped\. Where a file was staged and then changed again, its staged version is not kept\.$/);
  assert.deepEqual(shas(f), [sha], "cancelled: nothing ran");
});

// ── The list moving while a question is open ─────────────────────────────────

test("the stash dropped while the question is open: nothing runs, the user's edit is untouched, it says so", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  f.write("a.ts", "mine\n");
  answer = () => {
    f.git("stash", "drop", "-q"); // another tool, meanwhile
    return { value: "stash" };
  };
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "gone");
  assert.equal(f.read("a.ts"), "mine\n");
  assert.equal(status(f), " M a.ts");
  assert.deepEqual(shas(f), []);
  assert.match(said(), /no longer in the list/);
});

test("a stash pushed while the question is open: the picked stash is the one moved from, and the rest keeps its place", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  f.write("a.ts", "mine\n");
  answer = () => {
    f.write("c.ts", "someone else's\n");
    f.git("stash", "push", "-q", "-m", "pushed meanwhile");
    return { value: "cancel" };
  };
  await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.deepEqual(shas(f).slice(1), [sha], "cancelled: the picked stash is untouched, one down");
  // Again, with nothing in the way: the picked stash is stash@{1} now.
  reset();
  f.git("checkout", "--", "a.ts");
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["b.ts"], () => {}));
  assert.equal(out.kind, "done");
  const [top, rest] = shas(f);
  assert.equal(f.git("log", "-1", "--format=%s", top).trim(), "On main: pushed meanwhile", "the newer stash is left alone");
  assert.deepEqual(await filesOf(f.dir, rest), ["a.ts", "n.ts", "new.md"]);
  assert.equal(f.read("b.ts"), "b.ts stashed\n");
});

test("a file that is no longer in the stash: said, and nothing runs", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f);
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["gone.ts"], () => {}));
  assert.deepEqual(out, { kind: "kept" });
  assert.match(said(), /those files are no longer in the stash/);
  assert.equal(status(f), "");
});

// ── Stashes other tools make ─────────────────────────────────────────────────

test("a stash another tool stored (git's autostash) moves like any other", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "auto a\n");
  f.write("b.ts", "auto b\n");
  const made = f.git("stash", "create", "autostash").trim();
  f.git("reset", "-q", "--hard");
  f.git("stash", "store", "-m", "autostash", made);
  const [sha] = shas(f);
  const out = await withRepo(f.dir, (repos) => stashesView.moveStashFiles(repos, sha, ["b.ts"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(f.read("b.ts"), "auto b\n");
  assert.equal(f.git("stash", "list", "--format=%gs").trim(), "autostash");
});

// ── Two worktrees, one list ──────────────────────────────────────────────────

test("worktrees: a stash made in one is moved out in the other — into that worktree only", async () => {
  reset();
  const f = fixture();
  const sha = stashFour(f, "made in main");
  const other = join(mkdtempSync(join(scratch, "wt-")), "side");
  f.git("worktree", "add", "-q", "-b", "side", other);
  const out = await withRepo(other, (repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(out.kind, "done");
  assert.equal(readFileSync(join(other, "a.ts"), "utf8"), "a.ts stashed\n");
  assert.equal(status(f), "", "the main worktree is not touched");
  assert.deepEqual(await filesOf(f.dir, shas(f)[0]), ["b.ts", "n.ts", "new.md"], "and its list holds the rest");
});

// ── A file's diff ────────────────────────────────────────────────────────────

test("a file's diff: both sides read by the stash's sha, per kind; a binary file opens nothing and says why", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "a.ts staged\n");
  f.git("add", "a.ts");
  f.write("a.ts", "a.ts working\n");
  f.git("rm", "-q", "b.ts");
  writeFileSync(join(f.dir, "logo.bin"), Buffer.from([0, 1, 2]));
  f.git("mv", "old.md", "new.md");
  f.write("n.ts", "n\n");
  f.git("stash", "push", "-q", "-u", "-m", "kinds");
  const [sha] = shas(f);
  const calls: unknown[][] = [];
  vscode.commands.executeCommand = async (...args: unknown[]) => void calls.push(args);
  vscode.Uri.from = (parts: { path: string; query: string }) => parts;
  const side = (u: unknown) => {
    const q = new URLSearchParams((u as { query: string }).query);
    return `${q.get("rev")}:${q.get("at") ?? (u as { path: string }).path.slice(1)}`;
  };
  const open = async (path: string, staged = false) => {
    calls.length = 0;
    const ok = await withRepo(f.dir, (repos) => stashesView.openStashFile(repos, sha, path, staged));
    const [cmd, left, right, title, opts] = calls[0] ?? [];
    return { ok, cmd, left: left && side(left), right: right && side(right), title, opts };
  };
  const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const m = await open("a.ts");
  assert.equal(m.cmd, "vscode.diff");
  assert.deepEqual([m.left, m.right], [`${sha}^1:a.ts`, `${sha}:a.ts`]);
  assert.equal(m.title, "a.ts (before ↔ stashed in “kinds”)");
  assert.deepEqual(m.opts, { preview: true, preserveFocus: true });
  const st = await open("a.ts", true);
  assert.deepEqual([st.left, st.right], [`${sha}^1:a.ts`, `${sha}^2:a.ts`]);
  assert.equal(st.title, "a.ts (before ↔ staged in “kinds”)");
  const d = await open("b.ts");
  assert.deepEqual([d.left, d.right], [`${sha}^1:b.ts`, `${EMPTY}:b.ts`]);
  const r = await open("new.md");
  assert.deepEqual([r.left, r.right], [`${sha}^1:old.md`, `${sha}:new.md`], "a rename reads its old name before");
  const u = await open("n.ts");
  assert.deepEqual([u.left, u.right], [`${EMPTY}:n.ts`, `${sha}^3:n.ts`], "an untracked file, from the third parent");
  const b = await open("logo.bin");
  assert.equal(b.cmd, undefined, "no text diff of binary content");
  assert.match(said(), /“logo\.bin” is a binary file, so there is no text to compare/);
  // Gone from the list: false, for the view to redraw without it.
  f.git("stash", "drop", "-q");
  assert.equal((await open("a.ts")).ok, false);
});

// ── A stash git named ────────────────────────────────────────────────────────

test("a stash made without a message is named in words, never quotes inside quotes: Drop's question, Undo's labels", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "x\n");
  f.write("b.ts", "y\n");
  f.git("stash", "push", "-q");
  const [sha] = shas(f);
  const labels: string[] = [];
  const ledger = { runWithUndo: async (_a: unknown, label: string, run: () => Promise<unknown>) => (labels.push(label), run()) };
  const withLedger = <T>(fn: (repos: never) => Promise<T>): Promise<T> =>
    withRepo(f.dir, (repos) => fn({ ...(repos as object), getUndoLedger: () => ledger } as never));
  // Drop: asked, and backed out of.
  await withLedger((repos) => stashesView.dropStash(repos, sha, () => {}));
  assert.equal(asked[0]?.title, "Drop “WIP: base”?");
  // Move one file out: the Undo label.
  const moved = await withLedger((repos) => stashesView.moveStashFiles(repos, sha, ["a.ts"], () => {}));
  assert.equal(moved.kind, "done");
  // Pop what is left.
  const [rest] = shas(f);
  f.git("checkout", "--", "a.ts");
  await withLedger((repos) => stashesView.popStash(repos, rest, () => {}));
  assert.deepEqual(labels, ["Move 1 file out of “WIP: base”", "Pop “WIP: base”"]);
  for (const words of [asked[0]?.title ?? "", ...labels]) {
    assert.doesNotMatch(words, /“[^”]*“/, `no quotes inside quotes: ${words}`);
  }
});

// ── The palette ──────────────────────────────────────────────────────────────

test("the palette asks which stash, in words, and never by stash@{n}", async () => {
  reset();
  const f = fixture();
  f.write("a.ts", "x\n");
  f.git("stash", "push", "-q", "-m", "first words");
  f.write("b.ts", "y\n");
  f.git("stash", "push", "-q");
  const [auto, typed] = shas(f);
  answer = (spec) => (spec.kind === "pick" ? { value: typed } : undefined);
  const picked = await withRepo(f.dir, (repos) => stashesView.pickStash(repos, "Apply"));
  assert.equal(picked, typed);
  const q = asked[0];
  assert.ok(q && q.kind === "pick");
  assert.equal(q.title, "Apply which stash?");
  assert.deepEqual(
    q.choices.map((c) => [c.id, c.label, c.description]),
    [
      [auto, "WIP: base", "1 file"],
      [typed, "first words", "1 file"],
    ],
  );
  assert.ok(q.choices.every((c) => !/stash@\{/.test(`${c.label} ${c.detail ?? ""}`)));
  // None: said, nothing asked.
  reset();
  f.git("stash", "clear");
  assert.equal(await withRepo(f.dir, (repos) => stashesView.pickStash(repos, "Pop")), undefined);
  assert.equal(asked.length, 0);
  assert.match(said(), /there are no stashes/);
});
