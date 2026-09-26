// The Stashes view's operations, driven as the view drives them, against real
// git — the defects the stashes audit found broken:
//
//   · Drop, Pop and Create Branch acted on `stash@{n}`, a POSITION. The
//     confirm (or the name prompt) has no time limit, and a stash pushed
//     meanwhile — a pull's autostash, Stash & Retry, a terminal — renumbered
//     the list, so the old number named another stash. Each cell here pushes
//     a stash WHILE the question is up and checks the one the user picked is
//     the one acted on.
//   · The stash dialog listed a partly staged (`MM`) file twice; unticking one
//     of its rows still stashed it.
//   · Apply and Pop brought staged changes back unstaged — and a pop dropped
//     the only copy of a staged version that differed from the file.
//   · A stash's document was read by `stash@{n}`, so after a renumbering an
//     open diff re-read as another stash.
//
// vscodeStub.cjs stands in for VS Code; the dialog host answers each question
// as the cell says.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  workspace: Record<string, unknown>;
  languages: Record<string, unknown>;
  Uri: Record<string, unknown>;
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec, DialogResult } from "../src/ui/dialogs";

// Hermetic git: an empty global config, no system one.
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-stashes-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-stashes-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** What each question is answered with; `asked` records every spec. */
let answer: (spec: DialogSpec) => Promise<DialogResult | undefined> | DialogResult | undefined = () => undefined;
let asked: DialogSpec[] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    return answer(spec);
  },
});

function fixture(): { dir: string; git: (...a: string[]) => string; write: (f: string, s: string) => void; read: (f: string) => string } {
  const dir = mkdtempSync(join(scratch, "repo-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

const shas = (git: (...a: string[]) => string): string[] =>
  git("stash", "list", "--format=%H").split("\n").filter((l) => l.length > 0);
const status = (git: (...a: string[]) => string): string => git("status", "--porcelain").replace(/\n$/, "");

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

function reset(): void {
  asked = [];
  vscode.__said.length = 0;
  answer = () => undefined;
}

// ── Addressed by sha, across a renumbering ──────────────────────────────────

test("Drop: a stash pushed while the confirm is up does not make it drop another stash", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "the one I picked\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  answer = (spec) => {
    // While the question is up, something else stashes (a pull's autostash,
    // Stash & Retry, a terminal): the picked stash is stash@{1} now.
    write("other.ts", "someone else's work\n");
    git("stash", "push", "-q", "-m", "pushed meanwhile");
    return spec.kind === "confirm" ? { value: "ok" } : undefined;
  };
  // The row was drawn when the picked stash was stash@{0}.
  await withRepo(dir, (repos) => stashesView.dropStash(repos, "stash@{0}", () => {}));
  const left = git("stash", "list", "--format=%s").trim();
  assert.equal(left, "On main: pushed meanwhile", "the stash pushed meanwhile is kept");
  assert.ok(!shas(git).includes(picked), "the picked stash is the one dropped");
  const confirm = asked.find((s) => s.kind === "confirm");
  assert.equal(confirm?.title, "Drop “On main: picked”?", "the question names the stash by its message");
});

test("Drop by sha: a stash that has left the list is said, and nothing is dropped", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "gone\n");
  git("stash", "push", "-q", "-m", "gone");
  const [gone] = shas(git);
  git("stash", "drop", "-q");
  write("app.ts", "kept\n");
  git("stash", "push", "-q", "-m", "kept");
  answer = () => ({ value: "ok" });
  await withRepo(dir, (repos) => stashesView.dropStash(repos, gone, () => {}));
  assert.equal(asked.length, 0, "nothing is asked about a stash that is not there");
  assert.equal(git("stash", "list", "--format=%s").trim(), "On main: kept");
  assert.match(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^info: GitStudio: That stash is no longer in the list/m);
});

test("Create Branch: a stash pushed while the name is typed does not make it branch from another", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("app.ts", "the one I picked\n");
  git("stash", "push", "-q", "-m", "picked");
  answer = (spec) => {
    write("other.ts", "someone else's work\n");
    git("stash", "push", "-q", "-m", "pushed meanwhile");
    return spec.kind === "input" ? { value: "from-picked" } : undefined;
  };
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, "stash@{0}", () => {}));
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "from-picked");
  assert.equal(read("app.ts"), "the one I picked\n", "the picked stash is the one applied");
  assert.equal(git("stash", "list", "--format=%s").trim(), "On main: pushed meanwhile", "…and the one dropped");
});

test("the stash document reads the stash by sha, not by the number in its name", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "picked\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  write("app.ts", "pushed later\n");
  git("stash", "push", "-q", "-m", "pushed later"); // picked is stash@{1}; stash@{0} is another
  const text = await withRepo(dir, (repos) =>
    new stashesView.StashDiffContentProvider(repos as never).provideTextDocumentContent({
      path: `/${encodeURIComponent("stash@{0}")}.diff`,
      query: new URLSearchParams({ root: dir, sha: picked }).toString(),
    } as never),
  );
  assert.match(text, /^\+picked$/m, text);
  assert.doesNotMatch(text, /pushed later/);
});

test("a click previews the stash and leaves the keyboard in the list; Enter moves it", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "x\n");
  git("stash", "push", "-q", "-m", "x");
  const [sha] = shas(git);
  const shown: { preserveFocus?: boolean; preview?: boolean }[] = [];
  const opened: string[] = [];
  // Just enough of VS Code to see what is opened, and how.
  vscode.Uri.from = (parts: { query: string }) => parts;
  vscode.workspace.openTextDocument = async (uri: { query: string }) => {
    opened.push(String(new URLSearchParams(uri.query).get("sha")));
    return {};
  };
  vscode.languages.setTextDocumentLanguage = async () => ({});
  vscode.window.showTextDocument = async (_doc: unknown, opts: { preserveFocus?: boolean; preview?: boolean }) => {
    shown.push(opts);
    return {};
  };
  await withRepo(dir, async (repos) => {
    assert.equal(await stashesView.showStash(repos, sha), true);
    assert.equal(await stashesView.showStash(repos, sha, true), true);
  });
  assert.deepEqual(opened, [sha, sha], "opened by its full sha");
  assert.deepEqual(shown, [{ preview: true, preserveFocus: true }, { preview: true, preserveFocus: false }]);

  // Clicked after it left the list: said, nothing opened, and the answer tells
  // the view to redraw the list without it.
  git("stash", "drop", "-q");
  const gone = await withRepo(dir, (repos) => stashesView.showStash(repos, sha));
  assert.equal(gone, false);
  assert.equal(opened.length, 2, "nothing more opened");
  // Only looked at: "so nothing was changed" answers a question nobody asked.
  const said = vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n");
  assert.match(said, /^info: GitStudio: That stash is no longer in the list\.$/m);
  assert.doesNotMatch(said, /nothing was changed/);
});

// ── One row per file ────────────────────────────────────────────────────────

test("the stash dialog lists a partly staged file once, and unticking it keeps it out of the stash", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("util.ts", "export const a = 2;\n");
  git("add", "util.ts");
  write("util.ts", "export const a = 3;\n"); // MM util.ts
  write("new.ts", "new\n"); // ?? new.ts
  answer = (spec) => {
    if (spec.kind !== "multiPick") return undefined;
    // What the dialog does: untick the FIRST util.ts row, hand back every
    // id still ticked, in order.
    const choices = spec.choices.map((c) => ({ ...c }));
    const first = choices.find((c) => c.id === "f:util.ts");
    if (first) first.picked = false;
    return { value: choices.filter((c) => c.picked).map((c) => c.id) };
  };
  await withRepo(dir, (repos) => stashesView.saveStash(repos, () => {}));
  const dialog = asked.find((s) => s.kind === "multiPick");
  assert.ok(dialog && dialog.kind === "multiPick");
  const fileRows = dialog.choices.filter((c) => c.id.startsWith("f:")).map((c) => c.id);
  assert.deepEqual(fileRows, ["f:util.ts", "f:new.ts"], "one row per file");
  assert.equal(dialog.title, "Stash 2 files");
  assert.equal(status(git), "MM util.ts", "the unticked file stayed, staged and unstaged halves both");
  assert.equal(read("util.ts"), "export const a = 3;\n");
  assert.equal(git("show", "stash@{0}^3:new.ts"), "new\n", "the ticked file went into the stash");
  assert.equal(status(git).includes("new.ts"), false, "and out of the working tree");
});

// ── Applied with its staging ────────────────────────────────────────────────

/** util.ts stashed staged as `a = 2`, working copy `a = 3`. */
function stashMM(f: ReturnType<typeof fixture>): string {
  f.write("util.ts", "export const a = 2;\n");
  f.git("add", "util.ts");
  f.write("util.ts", "export const a = 3;\n");
  f.git("stash", "push", "-q", "-m", "staged and not");
  return shas(f.git)[0];
}

for (const verb of ["apply", "pop"] as const) {
  const press = (repos: never, stash: string): Promise<void> =>
    verb === "pop" ? stashesView.popStash(repos, stash, () => {}) : stashesView.applyStash(repos, stash, () => {});

  test(`${verb}: a stash with a staged part comes back staged — the staged version kept`, async () => {
    reset();
    const f = fixture();
    const sha = stashMM(f);
    await withRepo(f.dir, (repos) => press(repos, sha));
    assert.equal(status(f.git), "MM util.ts");
    assert.equal(f.git("show", ":util.ts"), "export const a = 2;\n");
    assert.equal(f.read("util.ts"), "export const a = 3;\n");
    assert.deepEqual(shas(f.git), verb === "pop" ? [] : [sha]);
    assert.equal(asked.length, 0, "nothing to ask");
  });

  test(`${verb}: over staged changes of the user's it asks first, and Cancel changes nothing`, async () => {
    reset();
    const f = fixture();
    const sha = stashMM(f);
    f.write("other.ts", "mine, staged\n");
    f.git("add", "other.ts");
    const before = status(f.git);
    answer = () => ({ value: "cancel" });
    await withRepo(f.dir, (repos) => press(repos, sha));
    assert.equal(asked[0]?.title, `${verb === "pop" ? "Pop" : "Apply"} the stash without its staging?`);
    assert.equal(status(f.git), before, "the user's staged change is still staged, nothing applied");
    assert.deepEqual(shas(f.git), [sha]);
    assert.doesNotMatch(vscode.__said.map((s) => s.kind).join(" "), /error/);
  });

  test(`${verb}: over staged changes of the user's, "${verb === "pop" ? "Pop" : "Apply"} Unstaged" runs it without, their staging kept`, async () => {
    reset();
    const f = fixture();
    const sha = stashMM(f);
    f.write("other.ts", "mine, staged\n");
    f.git("add", "other.ts");
    answer = () => ({ value: "unstaged" });
    await withRepo(f.dir, (repos) => press(repos, sha));
    assert.equal(status(f.git), "M  other.ts\n M util.ts");
    assert.equal(f.read("util.ts"), "export const a = 3;\n");
    assert.deepEqual(shas(f.git), verb === "pop" ? [] : [sha]);
  });

  test(`${verb}: a staged half that no longer applies at HEAD is asked about, never dropped silently`, async () => {
    reset();
    const f = fixture();
    const sha = stashMM(f);
    f.write("util.ts", "export const a = 7;\n");
    f.git("commit", "-q", "-am", "HEAD moves under the staged file");
    answer = () => ({ value: "cancel" });
    await withRepo(f.dir, (repos) => press(repos, sha));
    assert.equal(asked.length, 1, asked.map((s) => s.title).join(" | "));
    assert.equal(asked[0].title, `${verb === "pop" ? "Pop" : "Apply"} the stash without its staging?`);
    assert.equal(status(f.git), "", "nothing changed");
    assert.deepEqual(shas(f.git), [sha], "the stash is kept");
    assert.doesNotMatch(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^error:|conflicts in index/m);
  });
}

// ── Create Branch, through the door ─────────────────────────────────────────
//
// `git stash branch` switches to the stash's base and only then applies the
// stash. Over an edit to a file the stash changes, git switched, refused, and
// left the user on the new branch with the stash unapplied — said as git's
// error in red. Now what is in its way is asked before git runs, like Apply's
// and Pop's: Stash & Retry, or Cancel.

test("Create Branch over an edit in its way asks Stash & Retry; Cancel leaves the user where they were", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("app.ts", "stashed\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  write("app.ts", "mine\n");
  answer = (spec) => (spec.kind === "input" ? { value: "from-picked" } : spec.kind === "pick" ? { value: "cancel" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  const question = asked.find((s) => s.kind === "pick");
  assert.equal(question?.title, "Your uncommitted changes are in the way", asked.map((s) => s.title).join(" | "));
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "main", "not left on a new branch");
  assert.equal(git("branch", "--list", "from-picked"), "", "no branch was made");
  assert.equal(read("app.ts"), "mine\n");
  assert.deepEqual(shas(git), [picked]);
  assert.doesNotMatch(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^error:/m);
});

test("Create Branch: Stash & Retry makes the branch from the stash, and the edit comes back", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("app.ts", "stashed\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  write("other.ts", "other, committed on\n");
  git("commit", "-q", "-am", "HEAD moves on");
  write("other.ts", "other, committed on\n// mine\n");
  answer = (spec) => (spec.kind === "input" ? { value: "from-picked" } : spec.kind === "pick" ? { value: "stash" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "from-picked");
  assert.equal(read("app.ts"), "stashed\n", "the stash applied on it");
  assert.ok(!shas(git).includes(picked), "and dropped");
  const mine = read("other.ts").includes("// mine") ||
    git("stash", "list", "--format=%H %s").split("\n").some((l) =>
      l.includes("GitStudio: before") && git("show", `${l.split(" ")[0]}:other.ts`).includes("// mine"));
  assert.ok(mine, "the edit that was in the way survives");
});

test("Create Branch: the question says what the changes are in the way of — the branch, not applying the stash", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "stashed\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  write("other.ts", "other, committed on\n");
  git("commit", "-q", "-am", "HEAD moves on");
  write("other.ts", "mine\n"); // in the way of the switch; the stash never touches it
  answer = (spec) => (spec.kind === "input" ? { value: "from-picked" } : spec.kind === "pick" ? { value: "cancel" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  const hint = String(asked.find((s) => s.kind === "pick")?.hint ?? "");
  assert.match(hint, /^Your uncommitted changes to other\.ts are in the way of creating the branch “from-picked” from the stash/, hint);
  assert.doesNotMatch(hint, /applying the stash/, hint);
});

// `git stash branch` always applies with --index: for a stash that holds
// staged changes, git resets the index before it merges and refuses over ANY
// staged change — after the switch. The user was left on the new branch, their
// staged change unstaged, the stash unapplied, and git's error in red.
test("Create Branch from a stash with staged changes, over staged work of yours anywhere: asked first, and Stash & Retry makes it", async () => {
  reset();
  const { dir, git, write, read } = fixture();
  write("util.ts", "export const a = 2;\n");
  git("add", "util.ts");
  write("util.ts", "export const a = 3;\n");
  git("stash", "push", "-q", "-m", "staged and not");
  const [picked] = shas(git);
  write("other.ts", "mine, staged\n");
  git("add", "other.ts");

  answer = (spec) => (spec.kind === "input" ? { value: "from-picked" } : spec.kind === "pick" ? { value: "cancel" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  assert.ok(asked.some((s) => s.kind === "pick"), asked.map((s) => s.title).join(" | "));
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "main", "Cancel: not left on a new branch");
  assert.equal(git("branch", "--list", "from-picked"), "");
  assert.equal(status(git), "M  other.ts", "still staged");
  assert.deepEqual(shas(git), [picked]);
  assert.doesNotMatch(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^error:/m);

  reset();
  answer = (spec) => (spec.kind === "input" ? { value: "from-picked" } : spec.kind === "pick" ? { value: "stash" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "from-picked");
  assert.equal(git("show", ":util.ts"), "export const a = 2;\n", "the stash's staged version, staged");
  assert.equal(read("util.ts"), "export const a = 3;\n");
  assert.equal(git("show", ":other.ts"), "mine, staged\n", "yours, back and staged");
  assert.deepEqual(shas(git), []);
  assert.doesNotMatch(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^error:/m);
});

test("Create Branch with a name a branch already has is said as that, and nothing runs", async () => {
  reset();
  const { dir, git, write } = fixture();
  write("app.ts", "stashed\n");
  git("stash", "push", "-q", "-m", "picked");
  const [picked] = shas(git);
  answer = (spec) => (spec.kind === "input" ? { value: "main" } : undefined);
  await withRepo(dir, (repos) => stashesView.branchFromStash(repos, picked, () => {}));
  assert.match(vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n"), /^warning: GitStudio: A branch named “main” already exists\.$/m);
  assert.deepEqual(shas(git), [picked]);
  assert.equal(status(git), "");
});
