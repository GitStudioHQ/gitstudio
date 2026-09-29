// The file- and line-history surfaces (src/history/*) against real
// repositories: which diff each one opens — for which commit, under which
// names, with which title — and what each says when there is nothing to show.
//
//  · resolveActiveFile: the active editor's file → its (innermost) repository;
//  · FileTimelineProvider: the Timeline's pages of a file's commits, a rename
//    read under the old name, a refresh only when commits can have changed;
//  · RevisionNavigator: Open Changes, Open File at Revision, Back / Forward
//    through a file's history (from the working file or a revision diff);
//  · showLineHistory: the commits that touched the selected lines;
//  · showReflog: every position HEAD held, and a branch made at one of them;
//  · timelineApi: the runtime Timeline bindings.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as Record<string, unknown> & {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
  commands: Record<string, unknown>;
};

interface FakeUri {
  scheme: string;
  path: string;
  query: string;
  fsPath: string;
  toString(): string;
}
const Uri = {
  file: (p: string): FakeUri => ({ scheme: "file", path: p, query: "", fsPath: p, toString: () => `file://${p}` }),
  from: (o: { scheme: string; path: string; query?: string }): FakeUri => ({
    scheme: o.scheme,
    path: o.path,
    query: o.query ?? "",
    fsPath: o.path,
    toString: () => `${o.scheme}:${o.path}?${o.query ?? ""}`,
  }),
  joinPath: (u: FakeUri, ...parts: string[]) => Uri.file([u.fsPath, ...parts].join("/")),
};
class EventEmitter<T> {
  listeners: ((v: T) => void)[] = [];
  disposed = false;
  event = (l: (v: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => void this.listeners.splice(this.listeners.indexOf(l), 1) };
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) l(v);
  }
  dispose(): void {
    this.disposed = true;
  }
}
class ThemeIcon {
  constructor(readonly id: string) {}
}
class MarkdownString {
  value = "";
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}
class TimelineItem {
  id?: string;
  description?: string;
  iconPath?: unknown;
  contextValue?: string;
  detail?: MarkdownString;
  command?: { title: string; command: string; arguments: unknown[] };
  constructor(
    readonly label: string,
    readonly timestamp: number,
  ) {}
}
class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}
const registeredTimelines: { scheme: unknown; provider: unknown }[] = [];
Object.assign(vscode, {
  Uri,
  EventEmitter,
  ThemeIcon,
  MarkdownString,
  TimelineItem,
  Range,
  TextEditorRevealType: { InCenter: 2 },
  ProgressLocation: { Window: 10 },
  workspace: {
    registerTimelineProvider: (scheme: unknown, provider: unknown) => {
      registeredTimelines.push({ scheme, provider });
      return { dispose() {} };
    },
  },
});
const progress: string[] = [];
vscode.window.withProgress = async (opts: { title: string }, task: () => Promise<unknown>) => {
  progress.push(opts.title);
  return task();
};
const diffs: { left: FakeUri; right: FakeUri; title: string }[] = [];
vscode.commands.executeCommand = async (id: string, ...args: unknown[]) => {
  if (id === "vscode.diff") diffs.push({ left: args[0] as FakeUri, right: args[1] as FakeUri, title: args[2] as string });
  return undefined;
};

const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { resolveActiveFile } = require("../src/history/historyContext") as typeof import("../src/history/historyContext");
const { FileTimelineProvider, FILE_HISTORY_SOURCE, FILE_HISTORY_ITEM_CONTEXT } =
  require("../src/history/fileTimelineProvider") as typeof import("../src/history/fileTimelineProvider");
const { RevisionNavigator } = require("../src/history/revisionNavigation") as typeof import("../src/history/revisionNavigation");
const { showLineHistory } = require("../src/history/lineHistory") as typeof import("../src/history/lineHistory");
const { showReflog } = require("../src/history/reflog") as typeof import("../src/history/reflog");
const { createTimelineItem, registerTimelineProvider } =
  require("../src/history/timelineApi") as typeof import("../src/history/timelineApi");
const { fromRevisionUri, toRevisionUri } =
  require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { repoChange } = require("../src/git/repoChange") as typeof import("../src/git/repoChange");
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-history-cov-")));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let seq = 0;
/** A repository whose f.txt has three commits (v1, v2, v3), each with its own author time. */
function fixture(dir = join(scratch, `r${++seq}`)) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  let t = 1_700_000_000;
  const commit = (msg: string, file: string, body: string) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    const date = `@${(t += 60)} +0000`;
    execFileSync("git", ["commit", "-qm", msg], {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  contexts.push(ctx);
  const entry = { root: dir, ctx };
  const changed = new EventEmitter<unknown>();
  const repos = { getActive: () => entry, getAll: () => [entry], onDidChange: changed.event } as never;
  return { dir, git, commit, ctx, entry, repos, changed };
}
type Fx = ReturnType<typeof fixture>;

/** f.txt through three commits: "line1\n" → "+ line2" → "+ line3"; the shas newest first. */
function threeCommits(f: Fx): string[] {
  const s1 = f.commit("v1 add f", "f.txt", "line1\n");
  const s2 = f.commit("v2 [with] *markdown*", "f.txt", "line1\nline2\n");
  const s3 = f.commit("v3", "f.txt", "line1\nline2\nline3\n");
  return [s3, s2, s1];
}

/** The working file `rel` of `root`, as VS Code names it (forward slashes, as the path helpers join). */
const fileUri = (root: string, rel: string) => Uri.file(`${root}/${rel}`);

function edit(uri: FakeUri | undefined, selection?: { start: number; end: number }) {
  const reveals: { range: Range; how: unknown }[] = [];
  vscode.window.activeTextEditor = uri
    ? {
        document: { uri, lineCount: 3 },
        selection: { start: { line: selection?.start ?? 0 }, end: { line: selection?.end ?? 0 } },
        revealRange: (range: Range, how: unknown) => void reveals.push({ range, how }),
      }
    : undefined;
  return reveals;
}

function said(kind: string): string[] {
  return vscode.__said.filter((s) => s.kind === kind).map((s) => s.message);
}
function reset(): void {
  vscode.__said.length = 0;
  diffs.length = 0;
  asked = [];
  answer = () => undefined;
}
const side = (u: FakeUri) => (u.scheme === "file" ? { file: u.fsPath } : fromRevisionUri(u as never));
const noCancel = { onCancellationRequested: () => ({ dispose() {} }) } as never;

// ── historyContext ───────────────────────────────────────────────────────────

test("the active file resolves to its innermost repository, and a path relative to it", () => {
  const outer = fixture();
  const inner = fixture(join(outer.dir, "vendor", "lib"));
  const repos = { getAll: () => [outer.entry, inner.entry] } as never;
  reset();
  edit(fileUri(inner.dir, "src/a.ts"));
  const got = resolveActiveFile(repos);
  assert.equal(got?.entry, inner.entry, "the nested repository, not the one around it");
  assert.equal(got?.rel, "src/a.ts");
  edit(fileUri(outer.dir, "README.md"));
  assert.equal(resolveActiveFile(repos)?.entry, outer.entry);
  edit(Uri.file(inner.dir));
  assert.deepEqual(resolveActiveFile(repos)?.rel, "", "the repository folder itself is its own root");
  assert.deepEqual(said("info"), []);
});

test("no file editor, or a file in no repository: the user is told, nothing resolves", () => {
  const f = fixture();
  reset();
  edit(undefined);
  assert.equal(resolveActiveFile(f.repos), undefined);
  edit(Uri.from({ scheme: "untitled", path: "Untitled-1" }));
  assert.equal(resolveActiveFile(f.repos), undefined);
  edit(Uri.file(join(scratch, "elsewhere.txt")));
  assert.equal(resolveActiveFile(f.repos), undefined);
  assert.deepEqual(said("info"), [
    "GitStudio: Open a file in a Git repository first.",
    "GitStudio: Open a file in a Git repository first.",
    "GitStudio: This file is not inside an open Git repository.",
  ]);
});

// historyContext.ts and fileTimelineProvider.ts each used to test "is this
// file inside the repository" with `dir + "/"`. On Windows both VS Code's
// editor fsPath and a repository's root (repo.rootUri.fsPath) use backslashes —
// "c:\\work\\repo\\f.txt" never started with "c:\\work\\repo/" — so File
// History, Line History, Open Changes / Back / Forward and the Timeline all
// said the file was not in a repository. Both now go through util/repoScope.ts,
// which is separator-tolerant, and slice the relative path rather than asking
// the running platform's path.relative — so these hold on every OS.
test("a Windows path inside a Windows repository root resolves", () => {
  const entry = { root: "c:\\work\\repo", ctx: {} };
  vscode.window.activeTextEditor = {
    document: { uri: { scheme: "file", fsPath: "c:\\work\\repo\\src\\a.ts", path: "/c:/work/repo/src/a.ts", query: "" } },
  };
  const got = resolveActiveFile({ getAll: () => [entry] } as never);
  assert.equal(got?.entry, entry);
  assert.equal(got?.rel, "src/a.ts");
  // …and the boundary is still a boundary: a sibling whose name merely begins
  // with the root's is not inside it.
  const sibling = { root: "c:\\work\\rep", ctx: {} };
  assert.equal(resolveActiveFile({ getAll: () => [sibling] } as never), undefined);
});

test("the Timeline reads a Windows path's history under its forward-slashed repository path", async () => {
  const asked: string[] = [];
  const entry = {
    root: "c:\\work\\repo",
    ctx: { history: { fileHistory: async (rel: string) => (asked.push(rel), []) } },
  };
  const p = new FileTimelineProvider({ getAll: () => [entry], onDidChange: () => ({ dispose() {} }) } as never);
  const uri = { scheme: "file", fsPath: "c:\\work\\repo\\src\\a.ts", path: "/c:/work/repo/src/a.ts", query: "" };
  assert.deepEqual(await p.provideTimeline(uri as never, {}, noCancel), { items: [], paging: undefined });
  assert.deepEqual(asked, ["src/a.ts"], "the file was found inside the repository and its history asked for");
  p.dispose();
});

// ── timelineApi ─────────────────────────────────────────────────────────────

test("the Timeline bindings reach the runtime API", () => {
  const item = createTimelineItem("subject", 1234);
  assert.ok(item instanceof TimelineItem);
  assert.equal(item.label, "subject");
  assert.equal(item.timestamp, 1234);
  const provider = { id: "p", label: "P", provideTimeline: () => ({ items: [] }) };
  registerTimelineProvider(["file", "vscode-remote"], provider);
  assert.deepEqual(registeredTimelines.pop(), { scheme: ["file", "vscode-remote"], provider });
});

// ── FileTimelineProvider ─────────────────────────────────────────────────────

test("the Timeline pages a file's commits newest first, each opening that commit's change to the file", async () => {
  const f = fixture();
  const [, s2, s1] = threeCommits(f);
  f.git("commit", "--amend", "-q", "--no-edit", "-m", "v3", "-m", "a body with <b>html</b>");
  const s3b = f.git("rev-parse", "HEAD");
  const p = new FileTimelineProvider(f.repos);
  assert.equal(p.id, FILE_HISTORY_SOURCE);
  const page1 = await p.provideTimeline(fileUri(f.dir, "f.txt") as never, { limit: 2 }, noCancel);
  assert.deepEqual(page1.items.map((i) => i.label), ["v3", "v2 [with] *markdown*"]);
  assert.deepEqual(page1.paging, { cursor: "2" }, "one more commit to page to");
  const [top, second] = page1.items as unknown as TimelineItem[];
  assert.equal(top.id, s3b);
  assert.equal(top.timestamp, 1_700_000_180 * 1000);
  assert.equal(top.description, `T · ${s3b.slice(0, 7)}`);
  assert.equal(top.contextValue, FILE_HISTORY_ITEM_CONTEXT);
  assert.deepEqual(top.iconPath, new ThemeIcon("git-commit"));
  assert.match(top.detail?.value ?? "", /a body with \\<b\\>html\\<\/b\\>/, "the body is shown, markdown-escaped");
  assert.match(second.detail?.value ?? "", /\*\*v2 \\\[with\\\] \\\*markdown\\\*\*\*/, "the subject is bold and escaped");
  assert.match(second.detail?.value ?? "", /\nT <t@example\\\.com>\n/, "author and email");
  assert.equal(second.command?.command, "vscode.diff");
  const [left, right, title] = second.command!.arguments as [FakeUri, FakeUri, string];
  assert.deepEqual(side(left), { root: f.dir, rev: `${s2}~1`, relPath: "f.txt", readPath: "f.txt" });
  assert.deepEqual(side(right), { root: f.dir, rev: s2, relPath: "f.txt", readPath: "f.txt" });
  assert.equal(title, `f.txt (${s2.slice(0, 7)})`);

  const page2 = await p.provideTimeline(fileUri(f.dir, "f.txt") as never, { limit: 2, cursor: "2" }, noCancel);
  assert.deepEqual(page2.items.map((i) => i.id), [s1]);
  assert.equal(page2.paging, undefined, "the oldest page has nothing after it");
  const all = await p.provideTimeline(fileUri(f.dir, "f.txt") as never, { cursor: "garbage" }, noCancel);
  assert.equal(all.items.length, 3, "a cursor that isn't a count starts from the top, default page");
  p.dispose();
});

test("a commit older than a rename is diffed under the name the file had then", async () => {
  const f = fixture();
  const old = f.commit("add old", "old.txt", "a\nb\nc\nd\n");
  f.git("mv", "old.txt", "new.txt");
  f.git("commit", "-qm", "rename");
  const p = new FileTimelineProvider(f.repos);
  const t = await p.provideTimeline(fileUri(f.dir, "new.txt") as never, {}, noCancel);
  const item = (t.items as unknown as TimelineItem[]).find((i) => i.id === old);
  assert.ok(item, "the history follows the rename");
  const [left, right] = item.command!.arguments as [FakeUri, FakeUri];
  assert.equal(side(right).relPath, "new.txt", "today's name on the tab");
  assert.equal((side(right) as { readPath: string }).readPath, "old.txt", "read where the file really was");
  assert.equal((side(left) as { readPath: string }).readPath, "old.txt");
});

test("the Timeline is empty outside a repository, for the repository itself, and when the read fails or is cancelled", async () => {
  const f = fixture();
  threeCommits(f);
  const p = new FileTimelineProvider(f.repos);
  const empty = async (u: FakeUri, token = noCancel) => (await p.provideTimeline(u as never, {}, token)).items.length;
  assert.equal(await empty(Uri.from({ scheme: "untitled", path: "x" })), 0);
  assert.equal(await empty(Uri.file(join(scratch, "nowhere.txt"))), 0);
  assert.equal(await empty(Uri.file(f.dir)), 0, "the root is not a file");
  const cancelled = { onCancellationRequested: (cb: () => void) => (cb(), { dispose() {} }) } as never;
  assert.equal(await empty(fileUri(f.dir, "f.txt"), cancelled), 0, "cancelled before git answered");
  const broken = { root: f.dir, ctx: { history: { fileHistory: async () => Promise.reject(new Error("git died")) } } };
  const p2 = new FileTimelineProvider({ getAll: () => [broken], onDidChange: () => ({ dispose() {} }) } as never);
  assert.deepEqual(await p2.provideTimeline(fileUri(f.dir, "f.txt") as never, {}, noCancel), { items: [] });
});

test("the Timeline refreshes when commits can have changed — never for a save", () => {
  const f = fixture();
  const p = new FileTimelineProvider(f.repos);
  const fired: unknown[] = [];
  p.onDidChange((e) => void fired.push(e));
  f.changed.fire(repoChange(["workingTree"]));
  assert.deepEqual(fired, [], "a saved file changes no commit");
  f.changed.fire(repoChange(["refs"]));
  f.changed.fire(repoChange(["operation"]));
  f.changed.fire(undefined);
  assert.deepEqual(fired, [
    { uri: undefined, reset: true },
    { uri: undefined, reset: true },
    { uri: undefined, reset: true },
  ]);
  p.dispose();
  f.changed.fire(repoChange(["refs"]));
  assert.equal(fired.length, 3, "a disposed provider stops listening");
});

// ── RevisionNavigator ────────────────────────────────────────────────────────

test("Open Changes diffs HEAD against the working file", async () => {
  const f = fixture();
  threeCommits(f);
  const nav = new RevisionNavigator(f.repos);
  reset();
  edit(fileUri(f.dir, "f.txt"));
  await nav.openChanges();
  assert.equal(diffs.length, 1);
  assert.deepEqual(side(diffs[0].left), { root: f.dir, rev: "HEAD", relPath: "f.txt", readPath: "f.txt" });
  assert.deepEqual(side(diffs[0].right), { file: `${f.dir}/f.txt` });
  assert.equal(diffs[0].title, "f.txt (HEAD ↔ Working Tree)");
  edit(undefined);
  await nav.openChanges();
  assert.equal(diffs.length, 1, "no file, no diff");
  nav.dispose();
});

test("Open File at Revision offers the file's history and opens the picked commit's change", async () => {
  const f = fixture();
  const [s3, s2] = threeCommits(f);
  const nav = new RevisionNavigator(f.repos);
  reset();
  edit(fileUri(f.dir, "f.txt"));
  answer = (spec) => (spec.kind === "pick" ? spec.choices[1].id : undefined);
  await nav.openFileAtRevision();
  const pick = asked[0];
  assert.equal(pick?.title, "Open f.txt at Revision");
  assert.ok(pick.kind === "pick");
  assert.deepEqual(pick.choices.map((c) => c.detail), [s3, s2].map((s) => s.slice(0, 7)).concat(pick.choices[2].detail!));
  assert.equal(diffs.length, 1);
  assert.equal(side(diffs[0].right).rev, s2);
  assert.equal(side(diffs[0].left).rev, `${s2}~1`);
  assert.equal(diffs[0].title, `f.txt (${s2.slice(0, 7)})`);

  // …and Back continues from where the pick left off.
  await nav.navigateBack();
  assert.equal(side(diffs[1].right).rev, f.git("rev-parse", "HEAD~2"));

  answer = () => undefined;
  await nav.openFileAtRevision();
  answer = (spec) => (spec.kind === "pick" ? "7" : undefined);
  await nav.openFileAtRevision();
  assert.equal(diffs.length, 2, "dismissed, or a choice that isn't there: nothing opens");
});

test("Open File at Revision: a file with no history, or history git can't read, says so", async () => {
  const f = fixture();
  threeCommits(f);
  writeFileSync(join(f.dir, "new.txt"), "untracked\n");
  const nav = new RevisionNavigator(f.repos);
  reset();
  edit(fileUri(f.dir, "new.txt"));
  await nav.openFileAtRevision();
  assert.deepEqual(said("info"), ["GitStudio: No history for new.txt."]);
  const broken = { root: f.dir, ctx: { history: { fileHistory: async () => Promise.reject(new Error("bad object")) } } };
  const nav2 = new RevisionNavigator({ getAll: () => [broken] } as never);
  await nav2.openFileAtRevision();
  assert.equal(said("error").length, 1);
  assert.match(said("error")[0], /File history/);
  assert.match(said("error")[0], /bad object/);
  await nav2.navigateBack();
  assert.equal(diffs.length, 0, "Back over an unreadable history does nothing");
  edit(undefined);
  await nav.openFileAtRevision();
  assert.equal(diffs.length, 0);
});

test("Back and Forward walk the file's history one commit at a time, and stop at either end", async () => {
  const f = fixture();
  const [s3, s2, s1] = threeCommits(f);
  const nav = new RevisionNavigator(f.repos);
  reset();
  edit(fileUri(f.dir, "f.txt"));
  await nav.navigateForward();
  assert.deepEqual(said("info"), ["GitStudio: Already at the newest revision."]);
  await nav.navigateBack();
  await nav.navigateBack();
  await nav.navigateBack();
  assert.deepEqual(diffs.map((d) => side(d.right).rev), [s3, s2, s1]);
  await nav.navigateBack();
  assert.deepEqual(said("info").slice(1), ["GitStudio: Already at the oldest revision."]);
  await nav.navigateForward();
  assert.equal(side(diffs[3].right).rev, s2);

  // From a revision diff, the walk is anchored on that diff's commit.
  reset();
  const fresh = new RevisionNavigator(f.repos);
  await fresh.navigateBack(toRevisionUri(f.dir, s2.slice(0, 10), "f.txt") as never);
  assert.equal(side(diffs[0].right).rev, s1, "one older than the diff being looked at");
  await fresh.navigateForward(toRevisionUri(f.dir, s2, "f.txt") as never);
  assert.equal(side(diffs[1].right).rev, s3);

  // A revision of a repository no longer open falls back to the active editor.
  edit(undefined);
  await fresh.navigateBack(toRevisionUri(join(scratch, "gone"), s2, "f.txt") as never);
  assert.equal(diffs.length, 2);
  // A file with no commits: nothing to walk.
  writeFileSync(join(f.dir, "u.txt"), "u\n");
  edit(fileUri(f.dir, "u.txt"));
  await fresh.navigateBack();
  assert.equal(diffs.length, 2);
});

// ── showLineHistory ──────────────────────────────────────────────────────────

test("Line History lists the commits that touched the selected lines and opens each, until dismissed", async () => {
  const f = fixture();
  const [, s2] = threeCommits(f);
  reset();
  progress.length = 0;
  const reveals = edit(fileUri(f.dir, "f.txt"), { start: 1, end: 1 }); // line 2
  let round = 0;
  answer = (spec) => (spec.kind === "pick" && round++ === 0 ? spec.choices[0].id : undefined);
  await showLineHistory(f.repos);
  assert.deepEqual(progress, ["Loading line history (2–2)…"]);
  assert.equal(asked.length, 2, "the list re-opens after each diff");
  const pick = asked[0];
  assert.equal(pick.title, "Line History — f.txt · line 2");
  assert.ok(pick.kind === "pick");
  assert.deepEqual(pick.choices.map((c) => c.label), ["v2 [with] *markdown*"], "only the commit that wrote line 2");
  assert.equal(diffs.length, 1);
  assert.equal(side(diffs[0].right).rev, s2);
  assert.equal(side(diffs[0].left).rev, `${s2}~1`);
  assert.equal(diffs[0].title, `f.txt (${s2.slice(0, 7)})`);
  assert.equal(reveals.length, 1);
  assert.deepEqual(reveals[0].range, new Range(1, 0, 1, 0));
  assert.equal(reveals[0].how, 2);
});

test("Line History over a range reaches back through a rename, under the old name", async () => {
  const f = fixture();
  const first = f.commit("add old", "old.txt", "a\nb\nc\nd\n");
  f.git("mv", "old.txt", "new.txt");
  f.git("commit", "-qm", "rename");
  f.commit("edit d", "new.txt", "a\nb\nc\nD\n");
  reset();
  edit(fileUri(f.dir, "new.txt"), { start: 0, end: 3 });
  answer = (spec) => {
    if (spec.kind !== "pick") return undefined;
    const i = spec.choices.findIndex((c) => c.label === "add old");
    return asked.length === 1 ? String(i) : undefined;
  };
  await showLineHistory(f.repos);
  assert.equal(asked[0].title, "Line History — new.txt · lines 1–4");
  assert.equal(diffs.length, 1);
  const right = side(diffs[0].right) as { rev: string; relPath: string; readPath: string };
  assert.equal(right.rev, first);
  assert.equal(right.relPath, "new.txt");
  assert.equal(right.readPath, "old.txt", "read under the name it had in that commit");
});

test("Line History: no lines' history, a git error, or no file — each says so or does nothing", async () => {
  const f = fixture();
  threeCommits(f);
  reset();
  const none = { root: f.dir, ctx: { history: { lineHistory: async () => [] } } };
  edit(fileUri(f.dir, "f.txt"), { start: 0, end: 2 });
  await showLineHistory({ getAll: () => [none] } as never);
  assert.deepEqual(said("info"), ["GitStudio: No history for lines 1–3 of f.txt."]);
  const broken = { root: f.dir, ctx: { history: { lineHistory: async () => Promise.reject(new Error("bad range")) } } };
  await showLineHistory({ getAll: () => [broken] } as never);
  assert.match(said("error")[0] ?? "", /Line history.*bad range/);
  // The file's own history unreadable: the commit is diffed under today's name.
  const [s3] = threeCommits(fixture());
  const partly = {
    root: f.dir,
    ctx: {
      history: {
        lineHistory: async () => [{ sha: s3, shortSha: s3.slice(0, 7), subject: "v3", author: "T", authorDate: 0 }],
        fileHistory: async () => Promise.reject(new Error("no follow")),
      },
    },
  };
  let rounds = 0;
  answer = (spec) => (spec.kind === "pick" && rounds++ === 0 ? "0" : undefined);
  await showLineHistory({ getAll: () => [partly] } as never);
  assert.equal(diffs.length, 1);
  assert.deepEqual(side(diffs[0].right), { root: f.dir, rev: s3, relPath: "f.txt", readPath: "f.txt" });
  reset();
  edit(undefined);
  await showLineHistory(f.repos);
  assert.equal(asked.length, 0, "no file: nothing asked");
});

// ── showReflog ───────────────────────────────────────────────────────────────

test("the reflog lists every position HEAD held; a branch made at one brings a lost commit back", async () => {
  const f = fixture();
  const [s3, s2] = threeCommits(f);
  f.git("reset", "-q", "--hard", "HEAD~1"); // v3 is now reachable only from the reflog
  reset();
  answer = (spec) => {
    if (spec.kind === "pick" && spec.title === "Reflog — Time Machine") {
      return spec.choices.find((c) => c.label === "commit: v3")?.id;
    }
    if (spec.kind === "pick") return "branch";
    if (spec.kind === "input") return "rescued";
    return undefined;
  };
  await showReflog(f.repos);
  const list = asked[0];
  assert.ok(list.kind === "pick");
  assert.match(list.choices[0].label, /^reset: moving to HEAD~1$/, "newest first");
  assert.match(list.choices[0].description ?? "", /^HEAD@\{0\} · /);
  assert.equal(list.choices[0].detail, s2.slice(0, 7));
  const recover = asked[1];
  assert.match(recover.title, /^Recover — HEAD@\{1\} \([0-9a-f]{7}\)$/);
  assert.ok(recover.kind === "pick");
  assert.deepEqual(recover.choices.map((c) => c.id), ["branch", "checkout", "reset", "copySha"]);
  assert.equal(f.git("rev-parse", "rescued"), s3, "the branch points at the commit the reset lost");
  assert.equal(f.git("rev-parse", "HEAD"), s2, "and HEAD stayed where it was");
});

test("the reflog: no repository, an empty reflog, git refusing, or a dismissed choice", async () => {
  reset();
  await showReflog({ getActive: () => undefined } as never);
  assert.deepEqual(said("info"), ["GitStudio: No repository is open."]);

  const f = fixture();
  reset();
  await showReflog(f.repos);
  assert.equal(said("error").length, 1, "an unborn branch has no reflog git will show");
  assert.match(said("error")[0], /Reflog/);

  threeCommits(f);
  rmSync(join(f.dir, ".git", "logs"), { recursive: true, force: true });
  reset();
  await showReflog(f.repos);
  assert.deepEqual(said("info"), ["GitStudio: The reflog is empty."]);

  const g = fixture();
  threeCommits(g);
  const head = g.git("rev-parse", "HEAD");
  reset();
  await showReflog(g.repos); // dismissed at the list
  answer = (spec) => (spec.kind === "pick" && spec.title === "Reflog — Time Machine" ? "999" : undefined);
  await showReflog(g.repos); // a choice not in the list
  answer = (spec) => (spec.kind === "pick" && spec.title === "Reflog — Time Machine" ? "0" : undefined);
  await showReflog(g.repos); // dismissed at the recovery actions
  assert.equal(asked.length, 4);
  assert.equal(g.git("rev-parse", "HEAD"), head);
  assert.equal(g.git("branch", "--format=%(refname:short)"), "main", "nothing created");
});
