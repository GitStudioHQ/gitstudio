// The graph host (graphPanel.ts) driven for real: a scripted webview says
// what the page would say, the host answers from a REAL temporary repository,
// and each test reads what it posted back, what git now says, and what the
// user was told. `vscode` and the dialogs are graphPanel.kit.ts's stand-ins.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, normalize } from "node:path";
import * as kit from "./graphPanel.kit";
import { repoChange } from "../src/git/repoChange";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");
const { CommitPanelViewProvider } = require("../src/graph/commitPanelView") as typeof import("../src/graph/commitPanelView");
const { CommitsGraphViewProvider } = require("../src/graph/commitsGraphView") as typeof import("../src/graph/commitsGraphView");
const { RefFilterStore, setRefFilterStore } = require("../src/graph/refFilterStore") as typeof import("../src/graph/refFilterStore");
const { setAuthorAvatarResolver, GitHubAuthorAvatars } = require("../src/graph/authorAvatars") as typeof import("../src/graph/authorAvatars");
const { UNCOMMITTED_SHA } = require("@gitstudio/git-service/index") as typeof import("@gitstudio/git-service/index");
const { EMPTY_TREE } = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");

const EXT = kit.Uri.file("/ext");

interface Entry {
  root: string;
  ctx: unknown;
  repo?: { state: Record<string, unknown[]> };
}

/** A RepoManager as much as the graph host reads, with a change event a test fires. */
function reposFor(active: Entry | undefined, ledger?: unknown) {
  const listeners = new Set<(e: unknown) => void>();
  return {
    onDidChange: (fn: (e: unknown) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire: (e: unknown) => [...listeners].forEach((l) => l(e)),
    listeners,
    getActive: () => active,
    getAll: () => (active ? [active] : []),
    isDiscovering: () => false,
    getUndoLedger: () => ledger,
    findByPath: () => active,
  };
}

interface Opened {
  w: kit.FakeWebview;
  host: InstanceType<typeof CommitGraphPanel>;
  repos: ReturnType<typeof reposFor>;
  /** Wait for the n-th message of `type` (1-based) and return it. */
  nth(type: string, n: number): Promise<Record<string, any>>;
  count(type: string): number;
  last(type: string): Record<string, any> | undefined;
}

function open(entry: Entry | undefined, opts: { ready?: boolean; sidebar?: boolean; ledger?: unknown } = {}): Opened {
  const w = kit.fakeWebview();
  const repos = reposFor(entry, opts.ledger);
  const host = CommitGraphPanel.forView(w as never, repos as never, EXT as never, { sidebar: opts.sidebar });
  if (opts.ready !== false) w.send({ type: "ready" });
  const of = (type: string) => w.posted.filter((m) => m.type === type);
  return {
    w,
    host,
    repos,
    count: (type) => of(type).length,
    last: (type) => of(type).at(-1),
    nth: (type, n) => kit.until(() => of(type)[n - 1], `${type} #${n} (posted: ${w.posted.map((m) => m.type).join(", ")})`),
  };
}

const live: { dispose(): void }[] = [];
afterEach(() => {
  // Every disposal runs, and the records reset, even if one of them throws.
  while (live.length) {
    try {
      live.pop()!.dispose();
    } catch {
      /* a failed cleanup must not leak this test's records into the next */
    }
  }
  kit.resetRecords();
  setRefFilterStore(undefined);
  setAuthorAvatarResolver(undefined);
});

/** A repository: base ← one ← two (main, HEAD), `feature` at two, tag v1 at one. */
function history() {
  const r = kit.mkRepo();
  live.push(r);
  const base = r.commit("base", "base.txt");
  const one = r.commit("one", "one.txt");
  r.git("tag", "v1");
  const two = r.commit("two", "two.txt", "two\nlines\n");
  r.git("branch", "feature");
  return { r, base, one, two, entry: { root: r.dir, ctx: r.ctx } as Entry };
}

function track<T extends { host: { dispose(): void } }>(o: T): T {
  live.push(o.host);
  return o;
}

const rowShas = (init: Record<string, any>) => init.rows.map((row: { sha: string }) => row.sha);

// ── The first page ───────────────────────────────────────────────────────────

test("ready: the graph is the repository's history, HEAD first, with a chip for every ref and the picker's list", async () => {
  const { r, base, one, two, entry } = history();
  const g = track(open(entry));
  const init = await g.nth("graphInit", 1);
  assert.deepEqual(rowShas(init), [two, one, base]);
  assert.equal(init.head, two);
  assert.equal(init.hasMore, false);
  assert.equal(init.refFilter, null);
  assert.deepEqual(
    init.rows[0].refs.map((x: { fullName: string; kind: string }) => `${x.kind}:${x.fullName}`),
    ["currentHead:refs/heads/main", "head:refs/heads/feature"],
  );
  assert.deepEqual(init.rows[1].refs.map((x: { fullName: string }) => x.fullName), ["refs/tags/v1"]);
  assert.equal(init.rows[0].subject, "two");
  assert.equal(init.rows[0].author, "Test Person");
  assert.deepEqual(
    init.refList.map((e: { fullName: string }) => e.fullName).sort(),
    ["refs/heads/feature", "refs/heads/main", "refs/tags/v1"],
  );
  // Which commits may be dragged: every unpushed one, with `feature` offered
  // to carry along (main is the branch being rebased, so never).
  const chain = await g.nth("rebaseChain", 1);
  assert.deepEqual(chain.shas, [two, one, base]);
  assert.deepEqual(chain.branches, { [two]: ["feature"] });
  void r;
});

test("a refresh re-sends the rows but leaves out a ref list the page already has", async () => {
  const { r, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "refresh" });
  const second = await g.nth("graphInit", 2);
  assert.equal(second.refList, undefined, "unchanged list: not sent again");
  r.git("branch", "newer");
  g.w.send({ type: "refresh" });
  const third = await g.nth("graphInit", 3);
  assert.ok(third.refList.some((e: { fullName: string }) => e.fullName === "refs/heads/newer"), "a changed list rides along");
  // A reloaded page has nothing: the next init carries the list whole.
  g.w.send({ type: "ready" });
  const fourth = await g.nth("graphInit", 4);
  assert.ok(Array.isArray(fourth.refList));
});

test("a repository with no commits yet is an empty graph, not an error", async () => {
  const r = kit.mkRepo();
  live.push(r);
  const g = track(open({ root: r.dir, ctx: r.ctx }));
  const init = await g.nth("graphInit", 1);
  assert.deepEqual(init.rows, []);
  assert.equal(init.head, "");
  assert.ok(!init.noRepo);
  assert.equal(g.count("graphError"), 0);
});

test("a git that cannot read the log at all is an error with its reason, not an empty history", async () => {
  const r = kit.mkRepo();
  live.push(r);
  r.commit("x");
  // A HEAD git cannot parse: the folder stops being a repository to git.
  const { GitContext } = require("@gitstudio/git-service/GitContext");
  require("node:fs").writeFileSync(join(r.dir, ".git", "HEAD"), "garbage\n");
  const ctx = new GitContext({ root: r.dir });
  live.push(ctx);
  const g = track(open({ root: r.dir, ctx }));
  const err = await g.nth("graphError", 1);
  assert.match(err.message, /fatal: not a git repository/, "git's own reason, for the Retry placeholder");
  assert.equal(g.count("graphInit"), 0);
});

// ── Paging ───────────────────────────────────────────────────────────────────

/** `n` more commits on main in one git process (fast-import), each touching nothing. */
function manyCommits(r: kit.Repo, n: number): void {
  const parent = r.git("rev-parse", "HEAD");
  let stream = "";
  for (let i = 1; i <= n; i++) {
    stream += `commit refs/heads/main\nmark :${i}\ncommitter T <t@t.t> ${1_700_000_000 + i} +0000\ndata ${`c${i}`.length}\nc${i}\n`;
    stream += i === 1 ? `from ${parent}\n\n` : `from :${i - 1}\n\n`;
  }
  execFileSync("git", ["fast-import", "--quiet", "--force"], { cwd: r.dir, input: stream });
}

test("a long history pages: the first page is small, loadMore appends the rest and says when history ends", async () => {
  const r = kit.mkRepo();
  live.push(r);
  r.commit("root");
  manyCommits(r, 159); // 160 commits: one first page of 150, then 10
  const g = track(open({ root: r.dir, ctx: r.ctx }));
  const init = await g.nth("graphInit", 1);
  assert.equal(init.rows.length, 150);
  assert.equal(init.hasMore, true);
  g.w.send({ type: "loadMore" });
  const more = await g.nth("graphAppend", 1);
  assert.equal(more.rows.length, 10);
  assert.equal(more.hasMore, false);
  assert.equal(more.rows.at(-1).subject, "root");
  // Nothing more to load: a further request posts nothing.
  g.w.send({ type: "loadMore" });
  g.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  await g.nth("commitContains", 1);
  assert.equal(g.count("graphAppend"), 1);
});

test("a history of exactly one page tells the page it ended, rather than leaving it loading forever", async () => {
  const r = kit.mkRepo();
  live.push(r);
  r.commit("root");
  manyCommits(r, 149);
  const g = track(open({ root: r.dir, ctx: r.ctx }));
  assert.equal((await g.nth("graphInit", 1)).hasMore, true);
  g.w.send({ type: "loadMore" });
  const end = await g.nth("graphAppend", 1);
  assert.deepEqual(end.rows, []);
  assert.equal(end.hasMore, false);
});

test("revealing a commit below the loaded page pages toward it, then selects it", async () => {
  const r = kit.mkRepo();
  live.push(r);
  const root = r.commit("root");
  manyCommits(r, 159);
  const g = track(open({ root: r.dir, ctx: r.ctx }));
  await g.nth("graphInit", 1);
  g.host.reveal(root);
  const shown = await g.nth("revealCommit", 1);
  assert.equal(shown.sha, root);
  assert.equal(g.count("graphAppend"), 1, "the page holding it was loaded first");
  const details = await g.nth("commitDetails", 1);
  assert.equal(details.details.subject, "root");
  assert.equal(g.host.selectedSha, root);
  assert.equal(g.host.detailsOpen, true);
});

// ── Selecting a commit: the details pane ─────────────────────────────────────

test("selecting a commit posts its details: identity, message, refs and the files it changed", async () => {
  const { r, one, two, entry } = history();
  r.git("commit", "--amend", "-qm", "two\n\nthe body");
  const amended = r.git("rev-parse", "HEAD");
  r.git("branch", "-f", "feature", amended);
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "selectCommit", sha: amended });
  const d = (await g.nth("commitDetails", 1)).details;
  assert.equal(d.kind, "commit");
  assert.equal(d.sha, amended);
  assert.equal(d.shortSha, amended.slice(0, 7));
  assert.deepEqual(d.parents, [one]);
  assert.equal(d.subject, "two");
  assert.equal(d.body.trim(), "the body");
  assert.equal(d.author, "Test Person");
  assert.equal(d.hasRemote, false);
  assert.deepEqual(JSON.parse(JSON.stringify(d.files)), [{ path: "two.txt", status: "A", additions: 2, deletions: 0 }]);
  assert.deepEqual(d.refs.map((x: { fullName: string }) => x.fullName), ["refs/heads/main", "refs/heads/feature"]);
  assert.equal(g.host.selectedSha, amended);
  void two;
});

test("a commit that is not a row is read from git on demand; a sha git does not know has no details", async () => {
  const { r, entry } = history();
  r.git("checkout", "-q", "-b", "elsewhere");
  const hidden = r.commit("hidden");
  r.git("checkout", "-q", "main");
  r.git("branch", "-D", "elsewhere"); // unreachable: not in `--all`
  const g = track(open(entry));
  const init = await g.nth("graphInit", 1);
  assert.ok(!rowShas(init).includes(hidden));
  g.w.send({ type: "openCommit", sha: hidden });
  assert.equal((await g.nth("commitDetails", 1)).details.subject, "hidden");
  g.w.send({ type: "selectCommit", sha: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal((await g.nth("commitDetails", 2)).details, null);
});

test("the CHANGES column: one reply for the visible rows, the Uncommitted row left out", async () => {
  const { base, two, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "requestStats", shas: [two, UNCOMMITTED_SHA, base] });
  const reply = await g.nth("rowStats", 1);
  assert.deepEqual(reply.stats, [
    { sha: two, files: 1, additions: 2, deletions: 0 },
    { sha: base, files: 1, additions: 1, deletions: 0 },
  ]);
  // Only the synthetic row: nothing to ask git, nothing posted.
  g.w.send({ type: "requestStats", shas: [UNCOMMITTED_SHA] });
  g.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  await g.nth("commitContains", 1);
  assert.equal(g.count("rowStats"), 1);
});

test("'in N branches': the branches that contain the commit, echoed with its sha", async () => {
  const { r, one, entry } = history();
  r.git("checkout", "-q", "-b", "later", one);
  r.git("checkout", "-q", "main");
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "requestContains", sha: one });
  const got = await g.nth("commitContains", 1);
  assert.equal(got.sha, one);
  assert.equal(got.truncated, false);
  assert.deepEqual([...got.branches].map(String).sort(), ["feature", "later", "main"]);
  g.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  const wip = await g.nth("commitContains", 2);
  assert.deepEqual(wip.branches, []);
});

// ── The Uncommitted changes row ──────────────────────────────────────────────

const change = (root: string, file: string, status: number, originalFile?: string) => ({
  uri: kit.Uri.file(join(root, file)),
  originalUri: kit.Uri.file(join(root, originalFile ?? file)),
  status,
});
// vscode.git's Status: INDEX_ADDED 1, INDEX_RENAMED 3, MODIFIED 5, UNTRACKED 7.

test("a dirty tree gets an Uncommitted changes row on HEAD, and its details list staged then unstaged files", async () => {
  const { r, two, entry } = history();
  const state = {
    indexChanges: [change(r.dir, "new.txt", 1), change(r.dir, "renamed.txt", 3, "one.txt")],
    workingTreeChanges: [change(r.dir, "two.txt", 5)],
    untrackedChanges: [change(r.dir, "loose.txt", 7)],
    mergeChanges: [],
  };
  const g = track(open({ ...entry, repo: { state } }));
  const init = await g.nth("graphInit", 1);
  assert.equal(init.rows[0].sha, UNCOMMITTED_SHA);
  assert.equal(init.rows[0].subject, "Uncommitted changes");
  assert.equal(init.rows[1].sha, two);
  g.w.send({ type: "selectCommit", sha: UNCOMMITTED_SHA });
  const d = (await g.nth("commitDetails", 1)).details;
  assert.equal(d.kind, "wip");
  assert.deepEqual(d.parents, [two]);
  assert.equal(d.stagedCount, 2);
  assert.deepEqual(
    d.files.map((f: { path: string; status: string; oldPath?: string }) => [f.path, f.status, f.oldPath ?? null]),
    [
      ["new.txt", "A", null],
      ["renamed.txt", "R", "one.txt"],
      ["two.txt", "M", null],
      ["loose.txt", "U", null],
    ],
  );

  // Only the working tree moved and the row stays: just its details refresh.
  state.workingTreeChanges.push(change(r.dir, "base.txt", 5));
  g.repos.fire(repoChange(["workingTree"]));
  const again = (await g.nth("commitDetails", 2)).details;
  assert.equal(again.files.length, 5);
  assert.equal(g.count("graphInit"), 1, "no reload for a working-tree change");

  // The tree went clean: the row goes, which moves every lane — a reload.
  for (const k of Object.keys(state)) (state as Record<string, unknown[]>)[k].length = 0;
  g.repos.fire(repoChange(["workingTree"]));
  const reloaded = await g.nth("graphInit", 2);
  assert.equal(reloaded.rows[0].sha, two);
});

test("a ref move reloads the graph after the debounce", async () => {
  const { r, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  r.git("tag", "later");
  g.repos.fire(repoChange(["refs"]));
  const init = await g.nth("graphInit", 2);
  assert.ok(init.refList.some((e: { fullName: string }) => e.fullName === "refs/tags/later"));
});

// ── The commit menu ──────────────────────────────────────────────────────────

test("right-click: the refs on the row come first, then what git says this commit allows", async () => {
  const { one, two, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "contextMenu", sha: two, x: 10, y: 20 });
  const menu = await g.nth("commitMenu", 1);
  assert.equal(menu.title, `${two.slice(0, 7)} · two`);
  assert.equal(menu.x, 10);
  const ids = menu.items.map((i: { id: string }) => i.id).filter(Boolean);
  // main is where HEAD is: not offered. feature is.
  assert.deepEqual(ids.slice(0, 2), ["ref:refs/heads/feature", "checkout"]);
  assert.ok(ids.includes("drop"), "HEAD's own line can be dropped from");
  // The keyboard's menu key: the same menu, near the row.
  g.w.send({ type: "action", sha: one });
  const kb = await g.nth("commitMenu", 2);
  assert.equal(kb.x, -1);
  assert.equal(kb.items[0].id, "ref:refs/tags/v1");
});

test("right-click on a selection: the several-commit menu, and the pane's summary asks the same", async () => {
  const { one, two, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "contextMenu", sha: two, shas: [two, one], x: 1, y: 1 });
  const menu = await g.nth("commitMenu", 1);
  assert.equal(menu.title, "2 commits selected");
  assert.deepEqual(menu.shas, [two, one]);
  const ids = menu.items.map((i: { id: string }) => i.id).filter(Boolean);
  assert.deepEqual(ids, ["cherryPickMany", "revertMany", "squashMany", "dropMany", "compareTwo", "copyShas"]);
  g.w.send({ type: "selectCommits", shas: [two, one] });
  const summary = await g.nth("commitsSummary", 1);
  assert.deepEqual(summary.shas, [two, one]);
  assert.deepEqual(summary.items.map((i: { id: string }) => i.id).filter(Boolean), ids);
  assert.equal(g.host.selectedSha, undefined, "no one commit is showing");
});

test("a menu item runs against the repository, and the graph reloads to show it", async () => {
  const { r, one, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  kit.dialog.input = "topic";
  g.w.send({ type: "commitMenuAction", sha: one, id: "branch" });
  const init = await g.nth("graphInit", 2);
  assert.equal(r.git("rev-parse", "topic"), one);
  assert.ok(init.rows[1].refs.some((x: { fullName: string }) => x.fullName === "refs/heads/topic"));
  assert.match(kit.asked[0].title, new RegExp(`Create branch at ${one.slice(0, 7)}`));
  assert.match(kit.asked[0].text, /^one — /, "the prompt names the commit by its subject");
});

test("the chip's Checkout switches to the branch by its full name", async () => {
  const { r, one, entry } = history();
  r.git("branch", "-f", "feature", one);
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "checkoutRef", sha: one, fullName: "refs/heads/feature" });
  await kit.until(() => r.git("rev-parse", "--abbrev-ref", "HEAD") === "feature", "HEAD on feature");
  await g.nth("graphInit", 2);
});

test("Start Interactive Rebase Here and Open in Graph hand off to their commands", async () => {
  const { one, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "commitMenuAction", sha: one, id: "interactiveRebase" });
  g.w.send({ type: "openInGraph", sha: one });
  g.w.send({ type: "commitAction", action: "interactive-rebase", sha: one });
  await kit.until(() => kit.ran.length >= 3, "three commands");
  assert.deepEqual(
    kit.ran.map((c) => [c.command, c.args[0]]),
    [
      ["gitstudio.startInteractiveRebase", one],
      ["gitstudio.revealCommitInGraph", one],
      ["gitstudio.startInteractiveRebase", one],
    ],
  );
});

test("the several-commit menu's Copy SHAs copies them, one per line, and changes nothing", async () => {
  const { one, two, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "commitMenuAction", sha: two, shas: [two, one], id: "copyShas" });
  await kit.until(() => kit.clip.text, "clipboard");
  assert.equal(kit.clip.text, `${two}\n${one}`);
});

test("a several-commit rewrite runs and reloads: Drop 2 commits leaves the others", async () => {
  const { r, base, entry } = history();
  const three = r.commit("three", "three.txt");
  const two = r.git("rev-parse", "HEAD~1");
  const one = r.git("rev-parse", "HEAD~2");
  r.git("branch", "-f", "feature", base);
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  kit.dialog.confirm = true;
  g.w.send({ type: "commitMenuAction", sha: two, shas: [two, one], id: "dropMany" });
  await g.nth("graphInit", 2);
  assert.deepEqual(r.git("log", "--format=%s").split("\n"), ["three", "base"]);
  void three;
});

// ── The details pane's toolbar ───────────────────────────────────────────────

test("details toolbar: Copy SHA, Tag and an unknown action", async () => {
  const { r, one, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "commitAction", action: "copy-sha", sha: one });
  await kit.until(() => kit.clip.text === one, "sha copied");
  kit.dialog.input = "v0.1";
  g.w.send({ type: "commitAction", action: "tag", sha: one });
  await g.nth("graphInit", 2);
  assert.equal(r.git("rev-parse", "v0.1^{commit}"), one);
  g.w.send({ type: "commitAction", action: "no-such-action", sha: one });
  g.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  await g.nth("commitContains", 1);
  assert.equal(kit.asked.length, 1, "the unknown action asked nothing");
});

test("details toolbar on the Uncommitted row: Stash goes to the stash command, anything else to Changes", async () => {
  const { entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "commitAction", action: "stash", sha: UNCOMMITTED_SHA });
  g.w.send({ type: "commitAction", action: "commit", sha: UNCOMMITTED_SHA });
  await kit.until(() => kit.ran.length >= 2, "two commands");
  assert.deepEqual(kit.ran.map((c) => c.command), ["gitstudio.stash.save", "gitstudio.commit.focus"]);
});

test("Open on Remote: said plainly with no remote; the commit's page on GitHub with one", async () => {
  const { r, one, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "commitAction", action: "open-remote", sha: one });
  const note = await kit.until(() => kit.said.find((s) => s.kind === "info"), "the reason");
  assert.match(note.text, /no remote/);
  assert.deepEqual(kit.opened, []);
  r.git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  g.w.send({ type: "commitAction", action: "open-remote", sha: one });
  await kit.until(() => kit.opened.length, "opened");
  assert.deepEqual(kit.opened, [`https://github.com/acme/widgets/commit/${one}`]);
});

test("Copy from the pane copies the text and says so, shortening a sha", async () => {
  const { two, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "copyText", text: two });
  await kit.until(() => kit.clip.text === two, "copied");
  const status = await kit.until(() => kit.said.find((s) => s.kind === "status"), "status");
  assert.match(status.text, new RegExp(two.slice(0, 7)));
  assert.ok(!status.text.includes(two), "a long value is shortened in the notice");
});

// ── Opening a changed file ───────────────────────────────────────────────────

const diffs = () => kit.ran.filter((c) => c.command === "vscode.diff");
const sideOf = (u: any) => ({ scheme: u.scheme, rev: new URLSearchParams(u.query).get("rev"), path: u.path });

test("opening a commit's file diffs it against the commit's first parent — a root commit against nothing", async () => {
  const { base, one, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "openFile", sha: one, path: "one.txt", status: "A" });
  g.w.send({ type: "openFile", sha: base, path: "dir/base.txt", status: "M" });
  await kit.until(() => diffs().length >= 2, "two diffs");
  const [a, b] = diffs();
  assert.deepEqual(sideOf(a.args[0]), { scheme: "gitstudio-rev", rev: EMPTY_TREE, path: "/one.txt" });
  assert.deepEqual(sideOf(a.args[1]), { scheme: "gitstudio-rev", rev: one, path: "/one.txt" });
  assert.equal(a.args[2], `one.txt (${one.slice(0, 7)})`);
  assert.equal(sideOf(b.args[0]).rev, EMPTY_TREE, "the root commit's parent side is the empty tree");
  assert.equal(b.args[2], `base.txt (${base.slice(0, 7)})`);
});

test("opening an uncommitted file: HEAD against the file on disk, nothing on the side a status says is absent", async () => {
  const { r, entry } = history();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "openFile", sha: UNCOMMITTED_SHA, path: "two.txt", wip: true, status: "M" });
  g.w.send({ type: "openFile", sha: UNCOMMITTED_SHA, path: "new.txt", wip: true, status: "A" });
  g.w.send({ type: "openFile", sha: UNCOMMITTED_SHA, path: "gone.txt", wip: true, status: "D" });
  g.w.send({ type: "openFile", sha: UNCOMMITTED_SHA, path: "now.txt", oldPath: "was.txt", wip: true, status: "R" });
  await kit.until(() => diffs().length >= 4, "four diffs");
  const [m, a, d, ren] = diffs();
  assert.equal(sideOf(m.args[0]).rev, "HEAD");
  assert.equal(m.args[1].scheme, "file");
  // Spelled root + "/" + path, as real VS Code's Uri.file accepts on every OS;
  // the stand-in Uri keeps the spelling, so compare the path itself.
  assert.equal(normalize(m.args[1].fsPath), join(r.dir, "two.txt"));
  assert.equal(m.args[2], "two.txt (HEAD ↔ Working Tree)");
  assert.equal(sideOf(a.args[0]).rev, EMPTY_TREE);
  assert.equal(sideOf(d.args[1]).rev, EMPTY_TREE);
  assert.match(ren.args[0].query, /at=was\.txt/, "HEAD's side of a rename is read under its old name");
});

// ── Revealing ────────────────────────────────────────────────────────────────

test("a reveal before the rows land waits for them; the details dock opens on it", async () => {
  const { one, entry } = history();
  const g = track(open(entry, { ready: false }));
  g.host.reveal(one);
  assert.equal(g.w.posted.length, 0);
  g.w.send({ type: "ready" });
  const shown = await g.nth("revealCommit", 1);
  assert.equal(shown.sha, one);
  assert.equal((await g.nth("commitDetails", 1)).details.sha, one);
  assert.equal(g.host.detailsOpen, true);
  g.w.send({ type: "detailsVisibility", open: false });
  assert.equal(g.host.detailsOpen, false);
});

// ── The branch filter ────────────────────────────────────────────────────────

/** main: base ← one ← two; side: base ← s1 (side only). */
function forked() {
  const h = history();
  h.r.git("checkout", "-q", "-b", "side", h.base);
  const s1 = h.r.commit("s1", "s1.txt");
  h.r.git("checkout", "-q", "main");
  return { ...h, s1 };
}

test("without a store, picking branches walks only them — and the Uncommitted row needs HEAD among them", async () => {
  const { r, s1, base, two, entry } = forked();
  const state = { workingTreeChanges: [change(r.dir, "two.txt", 5)] };
  const g = track(open({ ...entry, repo: { state } }));
  assert.equal((await g.nth("graphInit", 1)).rows[0].sha, UNCOMMITTED_SHA);
  g.w.send({ type: "setRefFilter", refs: ["refs/heads/side"] });
  const init = await g.nth("graphInit", 2);
  assert.deepEqual(init.refFilter, ["refs/heads/side"]);
  assert.deepEqual(rowShas(init), [s1, base], "no WIP row: HEAD's branch is not walked");
  g.w.send({ type: "setRefFilter", refs: [] });
  const all = await g.nth("graphInit", 3);
  assert.equal(all.refFilter, null);
  assert.ok(rowShas(all).includes(two));
});

test("with a store: the filter is remembered per repository, a gone branch is pruned, and every surface reloads", async () => {
  const { r, s1, base, entry } = forked();
  const mem = new Map<string, unknown>();
  const store = new RefFilterStore({ get: (k: string) => mem.get(k) as never, update: async (k: string, v: unknown) => void mem.set(k, v) });
  setRefFilterStore(store);
  await store.set(r.dir, ["refs/heads/side", "refs/heads/gone"]);
  const g = track(open(entry));
  const init = await g.nth("graphInit", 1);
  assert.deepEqual(init.refFilter, ["refs/heads/side"]);
  assert.deepEqual(rowShas(init), [s1, base]);
  assert.deepEqual(store.get(r.dir), ["refs/heads/side"], "the gone branch is forgotten");
  // A second surface over the same repository follows a change made in the first.
  const other = track(open(entry));
  await other.nth("graphInit", 1);
  g.w.send({ type: "setRefFilter", refs: null });
  assert.equal((await g.nth("graphInit", 2)).refFilter, null);
  assert.equal((await other.nth("graphInit", 2)).refFilter, null);
  assert.equal(store.get(r.dir), null);
});

test("a reveal the filter hides shows the details and offers the way in; Show all branches clears it and selects the row", async () => {
  const { two, entry } = forked();
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "setRefFilter", refs: ["refs/heads/side"] });
  await g.nth("graphInit", 2);
  kit.notifyAnswer.fn = (s) => (s.items.includes("Show all branches") ? "Show all branches" : undefined);
  g.host.reveal(two);
  assert.equal((await g.nth("revealCommit", 1)).sha, two);
  const offer = await kit.until(() => kit.said.find((s) => /hidden by the branch filter/.test(s.text)), "the offer");
  assert.equal(offer.text, `GitStudio: ${two.slice(0, 7)} is hidden by the branch filter.`);
  // The branch offered is one that contains it — the current one first.
  assert.deepEqual(offer.items, ["Add main to the filter", "Show all branches"]);
  const all = await g.nth("graphInit", 3);
  assert.equal(all.refFilter, null);
  assert.equal((await g.nth("revealCommit", 2)).sha, two, "the reveal is replayed once the row exists");
});

test("…and Add <branch> to the filter keeps the selection and adds a branch that contains the commit", async () => {
  const { r, s1, entry } = forked();
  r.git("branch", "-D", "feature");
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "setRefFilter", refs: ["refs/heads/main"] });
  await g.nth("graphInit", 2);
  kit.notifyAnswer.fn = (s) => s.items.find((i) => i.startsWith("Add "));
  g.host.reveal(s1);
  const init = await g.nth("graphInit", 3);
  assert.deepEqual([...init.refFilter].sort(), ["refs/heads/main", "refs/heads/side"]);
  assert.ok(rowShas(init).includes(s1));
});

// ── Drag to reorder ──────────────────────────────────────────────────────────

test("dropping a dragged commit rebases the branch into the new order", async () => {
  const { r, base, one, two, entry } = history();
  r.git("branch", "-D", "feature");
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  kit.dialog.pick = "go";
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: false });
  await kit.until(() => kit.said.find((s) => s.text.includes("Reordered")), "reordered");
  assert.deepEqual(r.git("log", "--format=%s").split("\n"), ["one", "two", "base"]);
  assert.equal(kit.asked[0].title, "Reorder 3 commits?");
  await g.nth("graphInit", 2);
});

test("a reorder with branches pointing into the range asks whether they come along", async () => {
  const { r, base, one, two, entry } = history();
  r.git("branch", "-f", "feature", one);
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  kit.dialog.pick = "carry";
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: true });
  await kit.until(() => kit.said.find((s) => s.text.includes("Reordered")), "reordered");
  assert.equal(kit.asked[0].text, "feature point into this range.");
  assert.deepEqual(kit.asked[0].choices!.map((c) => c.id), ["carry", "only", "no"]);
  // feature followed "one" onto its rewritten copy, now the tip.
  assert.equal(r.git("rev-parse", "feature"), r.git("rev-parse", "HEAD"));
  assert.equal(r.git("log", "-1", "--format=%s", "feature"), "one");
});

test("a reorder is refused when history moved during the drag, and when the tree is dirty; the same order does nothing", async () => {
  const { r, base, one, two, entry } = history();
  r.git("branch", "-D", "feature");
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  g.w.send({ type: "reorderCommits", order: [one, two], updateRefs: false });
  await kit.until(() => kit.said.find((s) => /history changed while you were dragging/.test(s.text)), "stale drag");
  await g.nth("graphInit", 2);
  g.w.send({ type: "reorderCommits", order: [two, one, base], updateRefs: false });
  r.write("two.txt", "dirty\n");
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: false });
  await kit.until(() => kit.said.find((s) => /clean working tree/.test(s.text)), "dirty refusal");
  assert.equal(kit.asked.length, 0, "nothing was asked for either");
  assert.deepEqual(r.git("log", "--format=%s").split("\n"), ["two", "one", "base"]);
});

test("a reorder that conflicts leaves the rebase for the user, and a second drag is refused until it is done", async () => {
  const r = kit.mkRepo();
  live.push(r);
  const base = r.commit("base", "f.txt", "a\n");
  const one = r.commit("one", "f.txt", "b\n");
  const two = r.commit("two", "f.txt", "c\n");
  const g = track(open({ root: r.dir, ctx: r.ctx }));
  await g.nth("graphInit", 1);
  kit.dialog.pick = "go";
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: false });
  const paused = await kit.until(() => kit.said.find((s) => /conflict/.test(s.text)), "paused");
  assert.equal(paused.kind, "warning");
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: false });
  await kit.until(() => kit.said.find((s) => /already in progress/.test(s.text)), "refused");
  r.git("rebase", "--abort");
  assert.deepEqual(r.git("log", "--format=%s").split("\n"), ["two", "one", "base"]);
});

test("a cancelled reorder question rewrites nothing", async () => {
  const { r, base, one, two, entry } = history();
  r.git("branch", "-D", "feature");
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  kit.dialog.pick = "no";
  g.w.send({ type: "reorderCommits", order: [one, two, base], updateRefs: false });
  await kit.until(() => kit.asked.length, "asked");
  g.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  await g.nth("commitContains", 1);
  assert.deepEqual(r.git("log", "--format=%s").split("\n"), ["two", "one", "base"]);
});

// ── Author photos ────────────────────────────────────────────────────────────

test("author photos land after the rows when a resolver has any; none is no message", async () => {
  const { entry } = history();
  setAuthorAvatarResolver({ resolve: async () => ({ "t@t.t": "https://avatars.example/t.png" }) });
  const g = track(open(entry));
  await g.nth("graphInit", 1);
  assert.deepEqual((await g.nth("authorAvatars", 1)).avatars, { "t@t.t": "https://avatars.example/t.png" });
  setAuthorAvatarResolver({ resolve: async () => ({}) });
  const quiet = track(open(entry));
  await quiet.nth("rebaseChain", 1);
  quiet.w.send({ type: "requestContains", sha: UNCOMMITTED_SHA });
  await quiet.nth("commitContains", 1);
  assert.equal(quiet.count("authorAvatars"), 0);
});

test("GitHubAuthorAvatars: nothing without a connection; the user's own photo by their email, and the repo's authors", async () => {
  const { r, entry } = history();
  r.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  const calls: string[] = [];
  const api = {
    currentLogin: async () => ({ login: "me", avatarUrl: "https://a/me.png" }),
    commitAuthorAvatars: async (owner: string, repo: string) => {
      calls.push(`${owner}/${repo}`);
      return { "other@x.y": "https://a/other.png" };
    },
  };
  const repos = reposFor(entry);
  let connected = false;
  const resolver = new GitHubAuthorAvatars(api as never, repos as never, async () => connected);
  assert.deepEqual(await resolver.resolve(entry as never), {});
  assert.deepEqual(calls, [], "no connection: GitHub is not asked");
  connected = true;
  assert.deepEqual(await resolver.resolve(entry as never), {}, "a resolved map is cached for a while");
  const fresh = new GitHubAuthorAvatars(api as never, repos as never, async () => true);
  assert.deepEqual(await fresh.resolve(entry as never), {
    "t@t.t": "https://a/me.png",
    "other@x.y": "https://a/other.png",
  });
  assert.deepEqual(calls, ["acme/widgets"]);
});

// ── Where the graph is hosted ────────────────────────────────────────────────

test("the editor-tab graph: one panel, focused rather than duplicated, revealing a commit, gone when closed", async () => {
  const { one, entry } = history();
  const repos = reposFor(entry);
  assert.equal(CommitGraphPanel.isOpen, false);
  CommitGraphPanel.show(repos as never, EXT as never);
  assert.equal(CommitGraphPanel.isOpen, true);
  assert.equal(kit.panels.length, 1);
  const panel = kit.panels[0];
  assert.equal(panel.viewType, "gitstudio.commitGraph");
  assert.match(panel.webview.html, /webview:\/ext\/dist\/webview\/graph\.js/);
  CommitGraphPanel.revealCommit(repos as never, EXT as never, one);
  assert.equal(kit.panels.length, 1, "not a second panel");
  assert.equal(panel.revealed, 1);
  panel.webview.send({ type: "ready" });
  await kit.until(() => panel.webview.posted.find((m) => m.type === "revealCommit" && m.sha === one), "revealed");
  panel.dispose();
  assert.equal(CommitGraphPanel.isOpen, false);
});

function fakeView(visible = true) {
  const disposed = new kit.Emitter<void>();
  const v = {
    webview: kit.fakeWebview(),
    visible,
    shown: 0,
    show: () => {
      v.shown++;
    },
    onDidDispose: disposed.event,
    close: () => disposed.fire(),
  };
  return v;
}

test("the bottom panel: a reveal before the view exists focuses it and lands once it resolves; a repeat is not re-sent", async () => {
  const { one, two, entry } = history();
  const provider = new CommitPanelViewProvider(reposFor(entry) as never, EXT as never);
  live.push(provider);
  await provider.reveal(one);
  assert.deepEqual(kit.ran.map((c) => c.command), ["gitstudio.commitPanel.focus"]);
  const view = fakeView();
  provider.resolveWebviewView(view as never, {} as never, {} as never);
  assert.match(view.webview.html, /data-layout="side"/);
  view.webview.send({ type: "ready" });
  await kit.until(() => view.webview.posted.find((m) => m.type === "revealCommit"), "revealed");
  assert.equal(provider.selectedSha, one);
  await provider.reveal(one);
  assert.equal(view.webview.posted.filter((m) => m.type === "revealCommit").length, 1, "already showing it");
  view.visible = false;
  await provider.reveal(two);
  assert.equal(view.shown, 1, "a hidden panel is brought forward");
  await kit.until(() => view.webview.posted.find((m) => m.type === "revealCommit" && m.sha === two), "second reveal");
  await provider.show();
  assert.equal(kit.ran.at(-1)!.command, "gitstudio.commitPanel.focus");
  view.close();
  assert.equal(provider.selectedSha, undefined);
});

test("the Commits rail: the sidebar bundle, and a reveal focuses the view whether or not it has resolved", async () => {
  const { one, entry } = history();
  const provider = new CommitsGraphViewProvider(reposFor(entry) as never, EXT as never);
  live.push(provider);
  await provider.reveal(one);
  const view = fakeView();
  provider.resolveWebviewView(view as never, {} as never, {} as never);
  assert.match(view.webview.html, /graph-sidebar\.js/);
  view.webview.send({ type: "ready" });
  await kit.until(() => view.webview.posted.find((m) => m.type === "revealCommit" && m.sha === one), "pending reveal");
  await provider.reveal(one);
  assert.deepEqual(kit.ran.map((c) => c.command), ["gitstudio.commits.focus", "gitstudio.commits.focus"]);
  await kit.until(() => view.webview.posted.filter((m) => m.type === "revealCommit").length === 2, "second reveal");
  view.close();
});
