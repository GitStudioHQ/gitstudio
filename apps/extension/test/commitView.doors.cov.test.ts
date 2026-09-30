// The Changes view's other doors, host side, against real repositories: the
// toolbar's and group headers' bulk Stage / Unstage / Discard, folders, the
// per-change ticks of the checkbox model, opening files and diffs (and a
// conflicted row opening in the resolver), the stash rows' actions, the
// commands the view hands on, and the settings and memento it writes.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  answerWith,
  asked,
  commandAnswers,
  commandsRun,
  committedRepo,
  covHost,
  installUris,
  opened,
  resetRecorders,
  said,
  settings,
  settingsWritten,
  type Host,
  type U,
} from "./commitViewCovKit";

installUris();

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  commandAnswers.clear();
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
type R = ReturnType<typeof repo>;
const lines = (s: string) => s.split("\n").filter(Boolean).sort();
const staged = (r: R) => lines(r.git("diff", "--cached", "--name-only"));
const unstaged = (r: R) => lines(r.git("diff", "--name-only"));
const untracked = (r: R) => lines(r.git("ls-files", "--others", "--exclude-standard"));

/** a.txt and b.txt edited, src/c.txt and src/d.txt new and staged-then-edited, new.txt untracked. */
function busyRepo(prefix: string): R {
  const r = repo(prefix);
  r.write("a.txt", "a edited\n");
  r.write("b.txt", "b edited\n");
  r.write("src/c.txt", "c\n");
  r.write("src/d.txt", "d\n");
  r.git("add", "src");
  r.git("commit", "-qm", "src");
  r.write("src/c.txt", "c edited\n");
  r.write("src/d.txt", "d edited\n");
  r.write("new.txt", "untracked\n");
  return r;
}

test("the toolbar's Stage All stages every change, untracked files too", async () => {
  const r = busyRepo("doors-stageall");
  const h = host(r.dir);
  await h.send({ type: "stageAll" });
  assert.deepEqual(staged(r), ["a.txt", "b.txt", "new.txt", "src/c.txt", "src/d.txt"]);
  assert.deepEqual(unstaged(r), []);
});

test("Unstage All takes everything back out of the index, leaving the edits", async () => {
  const r = busyRepo("doors-unstageall");
  r.git("add", "-A");
  const h = host(r.dir);
  await h.send({ type: "unstageAll" });
  assert.deepEqual(staged(r), []);
  assert.deepEqual(unstaged(r), ["a.txt", "b.txt", "src/c.txt", "src/d.txt"]);
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "a edited\n");
});

test("a row's − and a selection's Unstage unstage exactly what they name", async () => {
  const r = busyRepo("doors-unstage");
  r.git("add", "-A");
  const h = host(r.dir);
  await h.send({ type: "unstage", path: "a.txt" });
  assert.deepEqual(staged(r), ["b.txt", "new.txt", "src/c.txt", "src/d.txt"]);
  await h.send({ type: "unstagePaths", paths: ["b.txt", "", "new.txt"] });
  assert.deepEqual(staged(r), ["src/c.txt", "src/d.txt"]);
});

test("a folder's Stage and Unstage move the files under it, and only those", async () => {
  const r = busyRepo("doors-folder");
  const h = host(r.dir);
  await h.send({ type: "stageFolder", paths: ["src/c.txt", "src/d.txt"] });
  assert.deepEqual(staged(r), ["src/c.txt", "src/d.txt"]);
  await h.send({ type: "unstageFolder", paths: ["src/c.txt", "src/d.txt"] });
  assert.deepEqual(staged(r), []);
});

test("Discard All asks once, naming the count, then discards edits AND removes untracked files", async () => {
  const r = busyRepo("doors-discardall");
  const h = host(r.dir);
  await h.send({ type: "discardAll" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Discard all 5 working-tree changes?");
  assert.deepEqual(unstaged(r), []);
  assert.deepEqual(untracked(r), []);
  assert.equal(existsSync(join(r.dir, "new.txt")), false);
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "a\n");
});

test("Discard All dismissed keeps every change", async () => {
  const r = busyRepo("doors-discardall-no");
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "discardAll" });
  assert.deepEqual(unstaged(r), ["a.txt", "b.txt", "src/c.txt", "src/d.txt"]);
  assert.deepEqual(untracked(r), ["new.txt"]);
});

test("Discard All on a clean tree asks nothing", async () => {
  const r = repo("doors-discardall-clean");
  const h = host(r.dir);
  await h.send({ type: "discardAll" });
  assert.equal(asked.length, 0);
});

test("a folder's Discard asks about the folder's files and discards only them", async () => {
  const r = busyRepo("doors-discardfolder");
  const h = host(r.dir);
  await h.send({ type: "discardFolder", paths: ["src/c.txt", "src/d.txt"] });
  assert.equal(asked[0].title, "Discard changes in 2 files?");
  assert.deepEqual(unstaged(r), ["a.txt", "b.txt"]);
});

test("a folder's Discard with nothing in it asks nothing", async () => {
  const r = busyRepo("doors-discardfolder-empty");
  const h = host(r.dir);
  await h.send({ type: "discardFolder", paths: ["", ""] });
  assert.equal(asked.length, 0);
});

test("the checklist's check-all stages every change", async () => {
  const r = busyRepo("doors-checkall");
  const h = host(r.dir);
  await h.send({ type: "stageAllForCommit" });
  assert.deepEqual(staged(r), ["a.txt", "b.txt", "new.txt", "src/c.txt", "src/d.txt"]);
});

test("the Conflicts group's Stage All stages a resolved file and holds back one with markers", async () => {
  const r = repo("doors-stageall-merge");
  r.git("checkout", "-q", "-b", "topic");
  r.write("a.txt", "theirs\n");
  r.write("b.txt", "theirs\n");
  r.git("commit", "-qam", "topic");
  r.git("checkout", "-q", "main");
  r.write("a.txt", "ours\n");
  r.write("b.txt", "ours\n");
  r.git("commit", "-qam", "ours");
  try {
    r.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    /* stops on both */
  }
  r.write("b.txt", "resolved\n");
  const h = host(r.dir);
  await h.send({ type: "stageAll", group: "merge" });
  assert.equal(r.git("diff", "--name-only", "--diff-filter=U").trim(), "a.txt");
  assert.deepEqual(h.all("opFailed").map((m) => m.paths), [["a.txt"]]);
  assert.match(said("warning")[0], /a\.txt/);
});

test("the checkbox model lists every change of a file with its own state, and a tick stages just that change", async () => {
  const r = repo("doors-hunks");
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  r.write("long.txt", body);
  r.git("add", "long.txt");
  r.git("commit", "-qm", "long");
  const edited = body.replace("line 2\n", "line 2 CHANGED\n").replace("line 25\n", "line 25 CHANGED\n");
  r.write("long.txt", edited);
  const h = host(r.dir);
  await h.send({ type: "requestHunks", path: "long.txt" });
  const first = h.last("hunks") as { path: string; hunks: { index: number; start: number; end: number; state: string; preview: string; lineCount: number }[] };
  assert.equal(first.path, "long.txt");
  assert.deepEqual(
    first.hunks.map((x) => [x.start, x.state, x.preview, x.lineCount]),
    [
      [2, "unstaged", "line 2 CHANGED", 1],
      [25, "unstaged", "line 25 CHANGED", 1],
    ],
  );
  await h.send({ type: "stageHunk", path: "long.txt", hunkIndex: 1 });
  const index = r.git("show", ":long.txt");
  assert.match(index, /line 25 CHANGED/);
  assert.doesNotMatch(index, /line 2 CHANGED/, "only the ticked change is staged");
  const after = h.last("hunks") as typeof first;
  assert.deepEqual(after.hunks.map((x) => x.state), ["unstaged", "staged"]);
  // Unticking takes it back out.
  await h.send({ type: "stageHunk", path: "long.txt", hunkIndex: 1 });
  assert.doesNotMatch(r.git("show", ":long.txt"), /CHANGED/);
});

test("a tick on a change that has moved away re-lists the file instead of staging something else", async () => {
  const r = repo("doors-hunks-stale");
  r.write("a.txt", "a changed\n");
  const h = host(r.dir);
  await h.send({ type: "stageHunk", path: "a.txt", hunkIndex: 7 });
  assert.deepEqual(staged(r), []);
  assert.equal((h.last("hunks") as { hunks: unknown[] }).hunks.length, 1);
});

test("a file that cannot be read lists no changes rather than failing", async () => {
  const r = repo("doors-hunks-missing");
  const h = host(r.dir);
  await h.send({ type: "requestHunks", path: "not-there.txt" });
  assert.deepEqual(h.last("hunks"), { type: "hunks", path: "not-there.txt", hunks: [] });
});

test("Open File opens the working-tree file", async () => {
  const r = repo("doors-openfile");
  const h = host(r.dir);
  await h.send({ type: "openFile", path: "a.txt" });
  assert.equal((opened[0] as U).fsPath, join(r.dir, "a.txt"));
  await h.send({ type: "openFile", path: "" });
  assert.equal(opened.length, 1, "no path, nothing opened");
});

test("an unstaged row's diff is the working tree against the index", async () => {
  const r = repo("doors-diff");
  r.write("a.txt", "edited\n");
  const h = host(r.dir);
  await h.send({ type: "openDiff", path: "a.txt", staged: false });
  const diff = commandsRun.find((c) => c.id === "vscode.diff");
  assert.ok(diff, "a diff opened");
  assert.equal(diff.args[2], "a.txt (Working Tree)");
  // The host spells it root + "/" + path, as real VS Code's Uri.file accepts on
  // every OS; the stand-in Uri keeps the spelling, so compare the path itself.
  assert.equal(normalize((diff.args[1] as U).fsPath), join(r.dir, "a.txt"));
});

test("a conflicted row opens in the resolver, not as a diff full of markers", async () => {
  const r = repo("doors-conflict-open");
  r.git("checkout", "-q", "-b", "topic");
  r.write("a.txt", "theirs\n");
  r.git("commit", "-qam", "topic");
  r.git("checkout", "-q", "main");
  r.write("a.txt", "ours\n");
  r.git("commit", "-qam", "ours");
  try {
    r.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    /* stops */
  }
  const resolved: string[] = [];
  const h = host(r.dir, {
    merge: {
      openConflict: async (uri) => {
        resolved.push((uri as U).fsPath);
      },
      showConflicts: async () => {},
      operationVerb: async () => {},
    },
  });
  await h.send({ type: "ready" });
  await h.send({ type: "openDiff", path: "a.txt", staged: false });
  assert.deepEqual(resolved, [join(r.dir, "a.txt")]);
  assert.equal(commandsRun.filter((c) => c.id === "vscode.diff").length, 0);
});

test("the banner's Resolve and Continue / Abort go to the merge experience, and the buttons are released", async () => {
  const r = repo("doors-operation");
  const calls: string[] = [];
  const h = host(r.dir, {
    merge: {
      openConflict: async () => {},
      showConflicts: async (root) => {
        calls.push(`show ${root}`);
      },
      operationVerb: async (verb, root) => {
        calls.push(`${verb} ${root}`);
        throw new Error("refused");
      },
    },
  });
  await h.send({ type: "resolveConflicts" });
  await assert.rejects(h.send({ type: "operation", verb: "abort" }), /refused/);
  await h.idle();
  assert.deepEqual(calls, [`show ${r.dir}`, `abort ${r.dir}`]);
  assert.ok(h.last("operationDone"), "released even when the verb fails");
});

test("the layout choice is remembered, and the next state carries it; nonsense is ignored", async () => {
  const r = repo("doors-layout");
  const h = host(r.dir);
  await h.send({ type: "setLayout", layout: "tree" });
  assert.equal(h.memento.get("gitstudio.commit.layout"), "tree");
  await h.send({ type: "setLayout", layout: "grid" });
  assert.equal(h.memento.get("gitstudio.commit.layout"), "tree");
  await h.send({ type: "ready" });
  assert.equal(h.last("state")?.layout, "tree");
});

test("the staging-model toggle writes the user setting, and anything but checkboxes means split", async () => {
  const r = repo("doors-model");
  const h = host(r.dir);
  await h.send({ type: "setStagingModel", stagingModel: "checkboxes" });
  await h.send({ type: "setStagingModel", stagingModel: "sideways" });
  assert.deepEqual(
    settingsWritten.map((w) => [w.section, w.key, w.value]),
    [
      ["gitstudio", "changes.stagingModel", "checkboxes"],
      ["gitstudio", "changes.stagingModel", "split"],
    ],
  );
});

test("the view's buttons hand on to their commands", async () => {
  const r = repo("doors-commands");
  const h = host(r.dir);
  for (const type of ["openFolder", "openGraph", "reviewChanges", "connectAI", "stashStaged", "stash"]) {
    await h.send({ type });
  }
  await h.send({ type: "stashPaths", paths: ["a.txt", "b.txt"] });
  await h.send({ type: "stashPaths", paths: [] });
  assert.deepEqual(
    commandsRun.map((c) => c.id).filter((id) => id !== "gitstudio.commit.focus"),
    [
      "vscode.openFolder",
      "gitstudio.showCommitGraph",
      "gitstudio.ai.reviewChanges",
      "gitstudio.ai.connect",
      "gitstudio.stash.staged",
      "gitstudio.stash.save",
      "gitstudio.stash.paths",
    ],
  );
  assert.deepEqual(commandsRun.find((c) => c.id === "gitstudio.stash.paths")?.args, [{ paths: ["a.txt", "b.txt"] }]);
});

// ── Stash rows ───────────────────────────────────────────────────────────────

function stashed(prefix: string): { r: R; sha: string } {
  const r = repo(prefix);
  r.write("a.txt", "stashed edit\n");
  r.git("stash", "push", "-q", "-m", "wip on a");
  return { r, sha: r.git("rev-parse", "stash@{0}").trim() };
}

test("a stash's Drop asks, then drops that stash and tells the page it is gone", async () => {
  const { r, sha } = stashed("doors-stash-drop");
  const h = host(r.dir);
  await h.send({ type: "stashAct", sha, action: "drop" });
  assert.match(String(asked[0].title), /^Drop “.*wip on a.*”\?$/);
  assert.equal(r.git("stash", "list").trim(), "");
  assert.deepEqual(h.last("stashPending"), { type: "stashPending", sha, action: "drop" });
  assert.deepEqual(h.last("stashDone"), { type: "stashDone", sha, action: "drop", outcome: { kind: "done" } });
});

test("a stash's Drop dismissed keeps it, and the page puts the row back", async () => {
  const { r, sha } = stashed("doors-stash-keep");
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "stashAct", sha, action: "drop" });
  assert.notEqual(r.git("stash", "list").trim(), "");
  assert.deepEqual(h.last("stashDone")?.outcome, { kind: "kept" });
  assert.equal(h.all("stashPending").length, 0);
});

test("a stash's Create Branch makes the branch with the stash applied on it", async () => {
  const { r, sha } = stashed("doors-stash-branch");
  const h = host(r.dir);
  answerWith(() => "from-stash");
  await h.send({ type: "stashAct", sha, action: "branch" });
  assert.equal(r.git("branch", "--show-current").trim(), "from-stash");
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "stashed edit\n");
  assert.equal(r.git("stash", "list").trim(), "", "dropped once it applied");
  assert.deepEqual(h.last("stashDone")?.outcome, { kind: "done" });
});

test("a stash's Apply and Pop put its changes in the working tree; Pop also drops it", async () => {
  const { r, sha } = stashed("doors-stash-apply");
  const h = host(r.dir);
  await h.send({ type: "stashAct", sha, action: "apply" });
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "stashed edit\n");
  assert.notEqual(r.git("stash", "list").trim(), "", "apply keeps it");
  r.git("checkout", "--", "a.txt");
  await h.send({ type: "stashAct", sha, action: "pop" });
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "stashed edit\n");
  assert.equal(r.git("stash", "list").trim(), "");
});

test("an unknown stash action changes nothing and the row comes back", async () => {
  const { r, sha } = stashed("doors-stash-unknown");
  const h = host(r.dir);
  await h.send({ type: "stashAct", sha, action: "explode" });
  assert.deepEqual(h.last("stashDone"), { type: "stashDone", sha, action: "explode", outcome: { kind: "kept" } });
  assert.notEqual(r.git("stash", "list").trim(), "");
});

test("some of a stash's files copied to Changes land in the working tree; the stash keeps them", async () => {
  const r = repo("doors-stash-copy");
  r.write("a.txt", "A\n");
  r.write("b.txt", "B\n");
  r.git("stash", "push", "-q", "-m", "two files");
  const sha = r.git("rev-parse", "stash@{0}").trim();
  const h = host(r.dir);
  await h.send({ type: "stashFiles", sha, action: "copy", paths: ["b.txt", ""] });
  assert.equal(readFileSync(join(r.dir, "b.txt"), "utf8"), "B\n");
  assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "a\n");
  assert.deepEqual(h.last("stashDone"), { type: "stashDone", sha, action: "copy", paths: ["b.txt"], outcome: { kind: "done" } });
  await h.send({ type: "stashFiles", sha, action: "shred", paths: ["a.txt"] });
  assert.deepEqual(h.last("stashDone")?.outcome, { kind: "kept" }, "an unknown action does nothing");
});

test("Open All Changes of a stash opens one multi-file diff titled by the stash", async () => {
  const r = repo("doors-stash-openall");
  r.write("a.txt", "A\n");
  r.write("b.txt", "B\n");
  r.git("stash", "push", "-q", "-m", "two files");
  const sha = r.git("rev-parse", "stash@{0}").trim();
  commandAnswers.set("vscode.changes", () => undefined);
  const h = host(r.dir);
  await h.send({ type: "stashOpenAll", sha });
  const run = commandsRun.find((c) => c.id === "vscode.changes");
  assert.ok(run);
  assert.match(String(run.args[0]), /^Stash “.*two files.*”$/);
  const resources = run.args[1] as U[][];
  assert.deepEqual(resources.map((x) => x[0].fsPath).sort(), [join(r.dir, "a.txt"), join(r.dir, "b.txt")]);
});

test("Open All Changes of a stash that has gone says so", async () => {
  const r = repo("doors-stash-openall-gone");
  const h = host(r.dir);
  await h.send({ type: "stashOpenAll", sha: "0123456789abcdef0123456789abcdef01234567" });
  assert.deepEqual(said("info"), ["GitStudio: That stash is no longer in the list."]);
});

test("a stash file opens as a diff of what the stash did to it", async () => {
  const { r, sha } = stashed("doors-stash-openfile");
  const h = host(r.dir);
  await h.send({ type: "stashOpenFile", sha, path: "a.txt" });
  const diff = commandsRun.find((c) => c.id === "vscode.diff");
  assert.ok(diff);
  assert.match(String(diff.args[2]), /^a\.txt \(/);
});

// ── Saves, focus, visibility and the settings that repaint ─────────────────

test("a save inside the repository schedules a repaint; one in .git or outside it does not", async () => {
  const { events } = await import("./commitViewCovKit");
  const r = repo("doors-save");
  const h = host(r.dir);
  await h.idle();
  const pending = () => (h.provider as unknown as { externalRefresh?: unknown }).externalRefresh;
  events.save?.({ uri: { scheme: "file", fsPath: join(r.dir, ".git", "COMMIT_EDITMSG") } });
  assert.equal(pending(), undefined, "git's own metadata is not a working-tree edit");
  events.save?.({ uri: { scheme: "untitled", fsPath: join(r.dir, "a.txt") } });
  assert.equal(pending(), undefined, "not a file on disk");
  events.save?.({ uri: { scheme: "file", fsPath: join(r.dir, "..", "elsewhere.txt") } });
  assert.equal(pending(), undefined, "outside the repository");
  const states = h.all("state").length;
  events.save?.({ uri: { scheme: "file", fsPath: join(r.dir, "a.txt") } });
  assert.notEqual(pending(), undefined);
  const deadline = Date.now() + 20_000;
  while (h.all("state").length === states && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
  assert.ok(h.all("state").length > states, "repainted after the save");
});

test("with auto-refresh off, neither a save nor focus schedules anything", async () => {
  const { events } = await import("./commitViewCovKit");
  settings.set("gitstudio.changes.autoRefresh", false);
  const r = repo("doors-save-off");
  const h = host(r.dir);
  const pending = () => (h.provider as unknown as { externalRefresh?: unknown }).externalRefresh;
  events.save?.({ uri: { scheme: "file", fsPath: join(r.dir, "a.txt") } });
  events.focus?.({ focused: true });
  assert.equal(pending(), undefined);
});

test("the window regaining focus asks vscode.git to re-scan before repainting", async () => {
  const { events } = await import("./commitViewCovKit");
  const r = repo("doors-focus");
  let scans = 0;
  const h = host(r.dir, {
    gitRepo: {
      state: { HEAD: { name: "main" }, indexChanges: [], workingTreeChanges: [], mergeChanges: [] },
      status: async () => {
        scans++;
      },
    },
  });
  await h.idle();
  events.focus?.({ focused: false });
  assert.equal((h.provider as unknown as { externalRefresh?: unknown }).externalRefresh, undefined, "losing focus is nothing");
  events.focus?.({ focused: true });
  const deadline = Date.now() + 20_000;
  while (scans === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
  assert.ok(scans >= 1);
});

test("changing the staging model or the AI provider setting repaints; other settings do not", async () => {
  const { events } = await import("./commitViewCovKit");
  const r = repo("doors-config");
  const h = host(r.dir);
  await h.idle();
  const n = h.all("state").length;
  events.config?.({ affectsConfiguration: (k) => k === "editor.fontSize" });
  await h.idle();
  assert.equal(h.all("state").length, n);
  settings.set("gitstudio.changes.stagingModel", "checkboxes");
  events.config?.({ affectsConfiguration: (k) => k === "gitstudio.changes.stagingModel" });
  await h.idle();
  assert.ok(h.all("state").length > n);
  assert.equal(h.last("state")?.stagingModel, "checkboxes");
});

test("the view coming back into sight re-scans and repaints", async () => {
  const r = repo("doors-visible");
  let scans = 0;
  const h = host(r.dir, {
    gitRepo: {
      state: { HEAD: { name: "main" }, indexChanges: [], workingTreeChanges: [], mergeChanges: [] },
      status: async () => {
        scans++;
      },
    },
  });
  await h.idle();
  h.setVisible(false);
  assert.equal(scans, 0, "hiding does nothing");
  h.setVisible(true);
  const deadline = Date.now() + 20_000;
  while (scans === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
  assert.equal(scans, 1);
});
