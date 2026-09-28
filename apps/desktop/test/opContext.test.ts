import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { MergeSettingsStore, sanitize } from "../src/main/mergeSettings";
import { DEFAULT_MERGE_SETTINGS } from "@gitstudio/host-bridge/conflictsProtocol";
import { removeTempRepo } from "./tmpRepo";

// The desktop main process's half of merge parity (PLAN §4 P2, W6): the
// channels the S0 contract declared, answered by the SAME OperationProvider /
// ConflictOps the VS Code hosts use, plus Settings ▸ Merge persisted here.

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true" };

function repo(name: string): { root: string; git: (...a: string[]) => string; tryGit: (...a: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), `gs-opctx-${name}-`));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const tryGit = (...a: string[]): void => {
    try {
      execFileSync("git", a, { cwd: root, env, stdio: "ignore" });
    } catch {
      /* the stop is the point */
    }
  };
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  git("config", "merge.conflictStyle", "diff3");
  return { root, git, tryGit };
}

/** The reporter's repository (issue #12), stopped in `git rebase main`. */
function reporter(): ReturnType<typeof repo> & { mine: string } {
  const r = repo("reporter");
  writeFileSync(join(r.root, "f.txt"), "one\ntwo\nthree\nfour\nfive\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
  r.git("checkout", "-q", "-b", "test");
  writeFileSync(join(r.root, "f.txt"), "one\ntwo\nthree-test\nfour\nfive\n");
  r.git("commit", "-qam", "test change");
  const mine = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "main");
  writeFileSync(join(r.root, "f.txt"), "one\ntwo\nthree-main\nfour\nfive\n");
  r.git("commit", "-qam", "main change");
  r.git("checkout", "-q", "test");
  r.tryGit("rebase", "main");
  return { ...r, mine };
}

async function bridgeFor(root: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos);
}

// ── The channels exist, and are labelled ────────────────────────────────────

test("main.ts registers every merge-parity channel, each with an Output-tab label", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main/main.ts", import.meta.url)), "utf8");
  const channels = [
    "conflict:state",
    "conflict:takeRole",
    "conflict:restore",
    "conflict:delete",
    "op:continue",
    "op:skip",
    "op:abort",
    "merge:settings",
    "merge:setSettings",
  ];
  for (const c of channels) {
    assert.ok(main.includes(`handle("${c}"`), `${c} has a handler`);
    assert.ok(main.includes(`"${c}": "`), `${c} has an actionLabel name`);
  }
});

// ── conflict:* ──────────────────────────────────────────────────────────────

test("conflict:state is the dashboard's git half, and conflict:takeRole resolves in role terms", async () => {
  const r = reporter();
  try {
    const b = await bridgeFor(r.root);
    let snap = await b.conflictState();
    assert.equal(snap.op.kind, "rebase");
    assert.equal(snap.op.title, `Rebasing test onto main · commit 1 of 1: ${r.mine.slice(0, 7)} test change`);
    assert.deepEqual(snap.files, [{ path: "f.txt", status: "pending", shape: "text" }]);

    const took = await b.conflictTakeRole({ path: "f.txt", role: "yours" });
    assert.equal(took.ok, true, took.message);
    assert.equal(readFileSync(join(r.root, "f.txt"), "utf8").split("\n")[2], "three-test", "Yours = the commit being replayed");
    snap = await b.conflictState();
    assert.deepEqual(snap.files, [{ path: "f.txt", status: "resolved", choice: "yours", shape: "text" }]);
    assert.equal(snap.resolved, 1);

    const back = await b.conflictRestore({ path: "f.txt" });
    assert.equal(back.ok, true, back.message);
    assert.equal((await b.conflictState()).files[0].status, "pending");

    const bad = await b.conflictTakeRole({ path: "f.txt", role: "mine" as never });
    assert.equal(bad.ok, false, "a role that is not a role is refused, not guessed");
  } finally {
    removeTempRepo(r.root);
  }
});

test("main.ts: the watcher drops the conflict-state cache, and follows a linked worktree's git dirs", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main/main.ts", import.meta.url)), "utf8");
  const at = main.indexOf("new RepoWatcher(");
  assert.ok(at > 0, "the watcher is created in main.ts");
  const block = main.slice(at, at + 900);
  assert.match(block, /bridge\.invalidateConflictState\(\)/, "every watcher event invalidates the cached conflict:state");
  assert.match(block, /gitWatchDirs\(ctx\)[\s\S]*watchGitDirs\(dirs\)/, "the git dirs come from --git-path and are watched");
});

test("conflict:state answers a repaint from memory until git moves (P3 → P2: keep it cheap)", async () => {
  // The renderer reads conflict:state on EVERY Changes repaint while an
  // operation is stopped — and a snapshot is a dozen git processes (the
  // operation's names and gates, the listing, attributes). The answer only
  // changes when git does, which the watcher and our own verbs both know.
  const r = reporter();
  try {
    const repos = new RepoStore([]);
    await repos.open(r.root);
    const b = new GitBridge(repos);
    let runs = 0;
    repos.onGitRun = () => {
      runs++;
    };
    const first = await b.conflictState();
    assert.ok(runs > 0, "precondition: the first read asks git");
    runs = 0;
    const again = await b.conflictState();
    assert.equal(runs, 0, "a repaint's read costs no git at all");
    assert.deepEqual(again, first);

    // The watcher saw git move (a terminal `git add`): the next read is fresh.
    r.git("add", "f.txt");
    b.invalidateConflictState();
    runs = 0;
    const afterAdd = await b.conflictState();
    assert.ok(runs > 0, "invalidated: read again");
    assert.equal(afterAdd.files[0].status, "resolved");

    // Our own verb moves git too, and must never be answered from before it.
    await b.conflictRestore({ path: "f.txt" });
    assert.equal((await b.conflictState()).files[0].status, "pending", "a verb's result is never a stale read");
  } finally {
    removeTempRepo(r.root);
  }
});

test("conflict:delete settles a both-deleted file; conflict:takeSide no longer deletes it by accident", async () => {
  const r = repo("dd");
  try {
    writeFileSync(join(r.root, "doomed.txt"), "contents\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "side");
    r.git("mv", "doomed.txt", "theirs.txt");
    r.git("commit", "-qm", "they rename it");
    r.git("checkout", "-q", "main");
    r.git("mv", "doomed.txt", "ours.txt");
    r.git("commit", "-qm", "we rename it");
    r.tryGit("merge", "side");
    const b = await bridgeFor(r.root);
    const m = await b.conflictModel("doomed.txt");
    assert.equal(m?.shape, "both-deleted");
    assert.equal(m?.bothDeleted, true);
    const legacy = await b.conflictTakeSide({ path: "doomed.txt", side: "ours" });
    assert.equal(legacy.ok, false, "there is no side to take");
    assert.equal(legacy.expected, true);
    const del = await b.conflictDelete({ path: "doomed.txt" });
    assert.equal(del.ok, true, del.message);
    assert.equal(r.git("ls-files", "-u", "--", "doomed.txt").trim(), "");
    assert.equal(existsSync(join(r.root, "doomed.txt")), false);
  } finally {
    removeTempRepo(r.root);
  }
});

// ── op:* ────────────────────────────────────────────────────────────────────

test("op:continue walks the reporter's rebase to the end, keeping the commit", async () => {
  const r = reporter();
  try {
    const b = await bridgeFor(r.root);
    const blocked = await b.opContinue({});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.refused, "blocked");
    assert.equal(blocked.expected, true, "a refusal is a condition, not a crash report");
    assert.equal(blocked.view.continueBlocked, "f.txt still has conflicts");

    await b.conflictTakeRole({ path: "f.txt", role: "yours" });
    const out = await b.opContinue({});
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase complete");
    assert.equal(r.git("log", "--format=%s", "main..test").trim(), "test change");
    assert.equal((await b.opState()).kind, null);
  } finally {
    removeTempRepo(r.root);
  }
});

test("op:continue refuses to silently drop an emptied commit until confirmDrop", async () => {
  const r = reporter();
  try {
    const b = await bridgeFor(r.root);
    await b.conflictTakeRole({ path: "f.txt", role: "theirs" }); // main's line: the commit is now empty
    const refused = await b.opContinue({});
    assert.equal(refused.refused, "confirm-drop");
    assert.equal(refused.expected, true);
    assert.equal(refused.view.willDrop?.subject, "test change");
    assert.equal(existsSync(join(r.root, ".git", "rebase-merge")), true, "nothing ran");
    const out = await b.opContinue({ confirmDrop: true });
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "--format=%s", "main..test").trim(), "", "dropped — because the user said so");
  } finally {
    removeTempRepo(r.root);
  }
});

test("op:abort and op:skip use the operation's own verbs", async () => {
  const r = reporter();
  try {
    const b = await bridgeFor(r.root);
    const skip = await b.opSkip();
    assert.equal(skip.refused, "not-allowed", "the merge backend never offers Skip");
    const out = await b.opAbort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase aborted");
    assert.equal(r.git("rev-parse", "HEAD").trim(), r.mine);
    assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/test");
    const nothing = await b.opAbort();
    assert.equal(nothing.refused, "not-allowed");
    assert.equal(nothing.expected, true);
  } finally {
    removeTempRepo(r.root);
  }
});

test("a merge continued through op:continue (and merge:continue) leaves no '# Conflicts:' in its message", async () => {
  for (const via of ["op", "legacy"] as const) {
    const r = repo(`msg-${via}`);
    try {
      writeFileSync(join(r.root, "f.txt"), "base\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "base");
      r.git("checkout", "-q", "-b", "side");
      writeFileSync(join(r.root, "f.txt"), "side\n");
      r.git("commit", "-qam", "side");
      r.git("checkout", "-q", "main");
      writeFileSync(join(r.root, "f.txt"), "main\n");
      r.git("commit", "-qam", "main");
      r.tryGit("merge", "side");
      writeFileSync(join(r.root, "f.txt"), "resolved\n");
      r.git("add", "f.txt");
      const b = await bridgeFor(r.root);
      const out = via === "op" ? await b.opContinue({}) : await b.mergeContinue();
      assert.equal(out.ok, true, out.message);
      const msg = r.git("log", "-1", "--format=%B");
      assert.equal(msg.trim(), "Merge branch 'side'", `${via}: git's conflict list is stripped`);
    } finally {
      removeTempRepo(r.root);
    }
  }
});

// ── Settings ▸ Merge ────────────────────────────────────────────────────────

test("merge settings: defaults (auto-apply OFF), persisted, and only valid values stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-merge-settings-"));
  try {
    const store = await MergeSettingsStore.load(dir);
    assert.deepEqual(store.get(), DEFAULT_MERGE_SETTINGS);
    assert.equal(store.get().autoApplyNonConflicting, false, "JetBrains' own default");
    const next = await store.update({ autoApplyNonConflicting: true });
    assert.equal(next.autoApplyNonConflicting, true);
    const reloaded = await MergeSettingsStore.load(dir);
    assert.deepEqual(reloaded.get(), next, "survives a restart");

    const junk = await reloaded.update({ autoApplyNonConflicting: "yes" as never });
    assert.deepEqual(junk, next, "invalid values are ignored, not stored");
    writeFileSync(join(dir, "merge-settings.json"), "{ not json");
    assert.deepEqual((await MergeSettingsStore.load(dir)).get(), DEFAULT_MERGE_SETTINGS, "a broken file falls back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settings file from before the external-IDE hand-off was removed loads cleanly, its old keys dropped", async () => {
  // Someone who had chosen the IDE still has its keys on disk. They mean
  // nothing now: they are not carried into the settings, not written back,
  // and conflicts and diffs open in the app's own editors.
  const dir = mkdtempSync(join(tmpdir(), "gs-merge-settings-"));
  try {
    const old = {
      autoApplyNonConflicting: true,
      conflictResolver: "jetbrains",
      diffTool: "jetbrains",
      preferredIde: "goland",
      jetbrainsPath: "/Applications/GoLand.app/Contents/MacOS/goland",
    };
    writeFileSync(join(dir, "merge-settings.json"), JSON.stringify(old));
    const store = await MergeSettingsStore.load(dir);
    assert.deepEqual(store.get(), { autoApplyNonConflicting: true });
    assert.deepEqual(sanitize(old, DEFAULT_MERGE_SETTINGS), { autoApplyNonConflicting: true });
    await store.update({ autoApplyNonConflicting: false });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "merge-settings.json"), "utf8")), { autoApplyNonConflicting: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
