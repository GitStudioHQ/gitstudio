// The Changes view's host as the rest of the extension sees it: the dialogs it
// renders for every command (DialogHost), the state it paints from vscode.git's
// live Repository when one is attached — the lists, the branch, the counts and
// the activity-bar badge — the diffs that state opens, and its public doors
// (requestState, stashesChanged, openBranchMenu).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  answerWith,
  change,
  commandsRun,
  committedRepo,
  covHost,
  installUris,
  resetRecorders,
  said,
  settings,
  Status,
  vs,
  type FakeGitRepoState,
  type Host,
  type U,
} from "./commitViewCovKit";

installUris();

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  settings.clear();
  answerWith(() => "ok");
});

function host(root: string, opts?: Parameters<typeof covHost>[1]): Host {
  const h = covHost(root, opts);
  cleanups.push(h.dispose);
  return h;
}
function repo(prefix: string) {
  const r = committedRepo(prefix);
  cleanups.push(r.done);
  return r;
}
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

test("a dialog is posted to the page and resolves with the answer and the options checked", async () => {
  const r = repo("host-dialog");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  const spec = { kind: "confirm", title: "Remove it?", message: "Gone for good.", confirmLabel: "Remove" };
  const answer = h.provider.show(spec as never);
  await until(() => h.all("dialog").length > 0);
  const posted = h.last("dialog") as { dialogId: string; spec: unknown };
  assert.deepEqual(posted.spec, spec);
  // An answer for no dialog, or one already settled, changes nothing.
  await h.send({ type: "dialogResult", dialogId: "nope", dialogValue: "ok" });
  await h.send({ type: "dialogResult", dialogValue: "ok" });
  await h.send({ type: "dialogResult", dialogId: posted.dialogId, dialogValue: "ok", dialogOptions: ["also", 3, "branch"] });
  assert.deepEqual(await answer, { value: "ok", options: ["also", "branch"] });
});

test("a dialog dismissed on the page resolves undefined; one answered without options carries only the value", async () => {
  const r = repo("host-dialog-dismiss");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  const first = h.provider.show({ kind: "input", title: "Name?" } as never);
  await until(() => h.all("dialog").length === 1);
  await h.send({ type: "dialogResult", dialogId: (h.last("dialog") as { dialogId: string }).dialogId });
  assert.equal(await first, undefined);
  const second = h.provider.show({ kind: "input", title: "Name?" } as never);
  await until(() => h.all("dialog").length === 2);
  await h.send({ type: "dialogResult", dialogId: (h.last("dialog") as { dialogId: string }).dialogId, dialogValue: "x" });
  assert.deepEqual(await second, { value: "x" });
});

test("a view VS Code disposes settles its open dialogs as dismissed, so no command hangs on them", async () => {
  const r = repo("host-dialog-disposed");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  const pending = h.provider.show({ kind: "confirm", title: "Still there?" } as never);
  await until(() => h.all("dialog").length === 1);
  h.disposeView();
  assert.equal(await pending, undefined);
});

test("a dialog the webview never received is not waited for", async () => {
  const r = repo("host-dialog-dropped");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  (h.view as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } }).webview.postMessage = async () => false;
  assert.equal(await h.provider.show({ kind: "confirm", title: "Lost" } as never), undefined);
});

test("a dialog asked while the view is hidden reveals it first", async () => {
  const r = repo("host-dialog-hidden");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  h.view.visible = false;
  const pending = h.provider.show({ kind: "confirm", title: "Where am I?" } as never);
  await until(() => h.all("dialog").length === 1);
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.commit.focus"));
  await h.send({ type: "dialogResult", dialogId: (h.last("dialog") as { dialogId: string }).dialogId, dialogValue: "ok" });
  assert.deepEqual(await pending, { value: "ok" });
});

// ── State from vscode.git ────────────────────────────────────────────────────

function attached(root: string, state: Partial<FakeGitRepoState>): { state: FakeGitRepoState; status: () => Promise<void> } {
  return {
    state: { indexChanges: [], workingTreeChanges: [], mergeChanges: [], ...state },
    status: async () => {},
  };
}

test("with vscode.git attached, the lists, branch and counts come from its live state, untracked files folded in", async () => {
  const r = repo("host-attached");
  const gitRepo = attached(r.dir, {
    HEAD: { name: "main", upstream: { remote: "origin", name: "main" }, ahead: 2, behind: 3 },
    indexChanges: [change(r.dir, "a.txt", Status.INDEX_MODIFIED), change(r.dir, "src/new.ts", Status.INDEX_ADDED)],
    workingTreeChanges: [change(r.dir, "b.txt", Status.MODIFIED)],
    untrackedChanges: [change(r.dir, "notes.md", Status.UNTRACKED)],
  });
  const h = host(r.dir, { gitRepo });
  await h.send({ type: "ready" });
  const s = h.last("state") as Record<string, unknown>;
  assert.equal(s.hasRepo, true);
  assert.deepEqual(s.staged, [
    { path: "a.txt", status: "M" },
    { path: "src/new.ts", status: "A" },
  ]);
  assert.deepEqual(s.unstaged, [
    { path: "b.txt", status: "M" },
    { path: "notes.md", status: "U" },
  ]);
  assert.equal(s.stagedCount, 2);
  assert.equal(s.branch, "main");
  assert.equal(s.detached, false);
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
  assert.equal(s.unpushed, 2, "with an upstream, the push count is `ahead`");
  assert.equal(s.canPublish, true);
  assert.deepEqual(h.view.badge, {
    value: 4,
    tooltip: "GitStudio — 4 changed files · 3 incoming commits to pull",
  });
});

test("a detached HEAD from vscode.git shows the short commit, and has nothing to publish", async () => {
  const r = repo("host-attached-detached");
  const sha = r.git("rev-parse", "HEAD").trim();
  const h = host(r.dir, { gitRepo: attached(r.dir, { HEAD: { commit: sha } }) });
  await h.send({ type: "ready" });
  const s = h.last("state") as Record<string, unknown>;
  assert.equal(s.branch, sha.slice(0, 7));
  assert.equal(s.detached, true);
  assert.equal(s.canPublish, false);
  assert.equal(s.unpushed, 0);
  assert.match(String(s.detachedReason), /^HEAD is detached/);
});

test("one changed file badges in the singular; the badge setting off leaves a zero badge, never a stale number", async () => {
  const r = repo("host-badge");
  const gitRepo = attached(r.dir, {
    HEAD: { name: "main", upstream: { remote: "origin", name: "main" }, ahead: 0, behind: 1 },
    workingTreeChanges: [change(r.dir, "b.txt", Status.MODIFIED)],
    indexChanges: [change(r.dir, "b.txt", Status.INDEX_MODIFIED)],
  });
  const h = host(r.dir, { gitRepo });
  await h.send({ type: "ready" });
  assert.deepEqual(h.view.badge, {
    value: 1,
    tooltip: "GitStudio — 1 changed file · 1 incoming commit to pull",
  });
  settings.set("gitstudio.changesBadge", false);
  await h.send({ type: "ready" });
  assert.deepEqual(h.view.badge, { value: 0, tooltip: "" });
});

test("with several repositories open, the state names this one and where it lives", async () => {
  const r = repo("host-multi");
  const other = repo("host-multi-other");
  const h = host(r.dir, { others: [other.dir] });
  await h.send({ type: "ready" });
  const s = h.last("state") as Record<string, unknown>;
  assert.equal(s.repoCount, 2);
  assert.equal(typeof s.repoName, "string");
  assert.ok(String(s.repoName).length > 0);
  assert.ok(s.repoPath !== undefined, "a path is shown once there is more than one");
});

test("with no repository, the state says so and carries no lists", async () => {
  const r = repo("host-norepo");
  const h = host(r.dir, { noRepo: true });
  await h.send({ type: "ready" });
  const s = h.last("state") as Record<string, unknown>;
  assert.equal(s.hasRepo, false);
  assert.equal(s.discovering, false);
  assert.deepEqual(s.staged, []);
  assert.deepEqual(s.stashes, []);
});

test("a staged row with vscode.git attached diffs HEAD against the index", async () => {
  const r = repo("host-diff-staged");
  const h = host(r.dir, {
    gitRepo: attached(r.dir, { HEAD: { name: "main" }, indexChanges: [change(r.dir, "a.txt", Status.INDEX_MODIFIED)] }),
  });
  await h.send({ type: "openDiff", path: "a.txt", staged: true });
  await until(() => commandsRun.some((c) => c.id === "vscode.diff"));
  const d = commandsRun.find((c) => c.id === "vscode.diff")!;
  assert.equal(d.args[2], "a.txt (Staged)");
});

test("a conflicted row with vscode.git attached opens in the resolver; without the resolver, as a merge diff", async () => {
  const r = repo("host-diff-merge");
  const state = { HEAD: { name: "main" }, mergeChanges: [change(r.dir, "a.txt", Status.BOTH_MODIFIED)] };
  const opened: string[] = [];
  const h = host(r.dir, {
    gitRepo: attached(r.dir, state),
    merge: {
      openConflict: async (uri) => {
        opened.push((uri as U).fsPath);
      },
      showConflicts: async () => {},
      operationVerb: async () => {},
    },
  });
  await h.send({ type: "openDiff", path: "a.txt", staged: false });
  assert.deepEqual(opened, [join(r.dir, "a.txt")]);
  const plain = host(r.dir, { gitRepo: attached(r.dir, state) });
  await plain.send({ type: "openDiff", path: "a.txt", staged: false });
  await until(() => commandsRun.some((c) => c.id === "vscode.diff"));
  assert.equal(commandsRun.find((c) => c.id === "vscode.diff")!.args[2], "a.txt (Working Tree vs HEAD)");
});

test("a diff opened at a change scrolls there once the editor exists, clamped to the file", async () => {
  const r = repo("host-reveal");
  const revealed: number[] = [];
  const RealRange = (vs as unknown as Record<string, unknown>).Range;
  const RealSelection = (vs as unknown as Record<string, unknown>).Selection;
  Object.assign(vs as unknown as Record<string, unknown>, {
    Range: class {
      start: { line: number };
      constructor(line: number) {
        this.start = { line };
      }
    },
    Selection: class {
      constructor(public anchor: unknown) {}
    },
  });
  vs.window.activeTextEditor = {
    document: { lineCount: 3 },
    revealRange: (range: { start: { line: number } }) => revealed.push(range.start.line),
    selection: undefined,
  };
  try {
    const h = host(r.dir);
    await h.send({ type: "openDiff", path: "a.txt", staged: false, line: 99 });
    await until(() => revealed.length > 0);
    assert.deepEqual(revealed, [2]);
  } finally {
    Object.assign(vs as unknown as Record<string, unknown>, { Range: RealRange, Selection: RealSelection });
    delete vs.window.activeTextEditor;
  }
});

// ── Public doors ─────────────────────────────────────────────────────────────

test("requestState and stashesChanged repaint; a stash made elsewhere shows up in the list", async () => {
  const r = repo("host-public");
  const h = host(r.dir);
  await h.send({ type: "ready" });
  const n = h.all("state").length;
  h.provider.requestState();
  await until(() => h.all("state").length > n);
  await h.idle();
  r.write("a.txt", "stash me\n");
  r.git("stash", "push", "-q", "-m", "made elsewhere");
  h.provider.stashesChanged();
  await until(() => ((h.last("state")?.stashes as unknown[]) ?? []).length === 1);
  await h.idle();
  const rows = h.last("state")?.stashes as { message?: string }[];
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0]), /made elsewhere/);
});

test("openBranchMenu reveals the view and tells the page to open its branch menu", async () => {
  const r = repo("host-branchmenu");
  const h = host(r.dir);
  await h.provider.openBranchMenu();
  assert.ok(commandsRun.some((c) => c.id === "gitstudio.commit.focus"));
  assert.ok(h.last("openBranchMenu"));
  assert.deepEqual(said("error"), []);
});
