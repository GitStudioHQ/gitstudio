import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { MergeSettingsStore, sanitize } from "../src/main/mergeSettings";
import { DEFAULT_MERGE_SETTINGS, type MergeSettings } from "@gitstudio/host-bridge/conflictsProtocol";
import { removeTempRepo } from "./tmpRepo";

// The desktop main process's half of merge parity (PLAN §4 P2, W6): the 13
// channels the S0 contract declared, answered by the SAME OperationProvider /
// ConflictOps the VS Code hosts use, plus Settings ▸ Merge persisted here
// (the main process spawns jetbrainsPath, so it must not take it from the
// renderer per call).

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

async function bridgeFor(root: string, settings?: MergeSettings): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos, undefined, settings ? { get: () => settings } : undefined);
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
    "jetbrains:detect",
    "jetbrains:merge",
    "jetbrains:diff",
    "jetbrains:markResolved",
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
    const next = await store.update({
      autoApplyNonConflicting: true,
      conflictResolver: "jetbrains",
      preferredIde: "goland",
      jetbrainsPath: "  /opt/idea/bin/idea.sh  ",
    });
    assert.equal(next.autoApplyNonConflicting, true);
    assert.equal(next.jetbrainsPath, "/opt/idea/bin/idea.sh");
    const reloaded = await MergeSettingsStore.load(dir);
    assert.deepEqual(reloaded.get(), next, "survives a restart");

    const junk = await reloaded.update({
      diffTool: "vim" as never,
      preferredIde: "notepad" as never,
      autoApplyNonConflicting: "yes" as never,
      jetbrainsPath: 42 as never,
    });
    assert.deepEqual(junk, next, "invalid values are ignored, not stored");
    writeFileSync(join(dir, "merge-settings.json"), "{ not json");
    assert.deepEqual((await MergeSettingsStore.load(dir)).get(), DEFAULT_MERGE_SETTINGS, "a broken file falls back");
    assert.deepEqual(sanitize({ conflictResolver: "webview" }, DEFAULT_MERGE_SETTINGS).conflictResolver, "embedded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── jetbrains:* (a fake IDE — never a real one) ─────────────────────────────

function fakeIde(): { dir: string; command: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-opctx-ide-"));
  const command = join(dir, "idea");
  const log = join(dir, "ide.log");
  writeFileSync(
    command,
    `#!/bin/sh\n{ printf 'ARG %s\\n' "$@"; for a in "$@"; do [ -f "$a" ] && { printf 'FILE %s\\n' "$a"; cat "$a"; printf '<EOF>\\n'; }; done; } > "${log}.tmp" && mv "${log}.tmp" "${log}"\n`,
  );
  chmodSync(command, 0o755);
  return { dir, command, log };
}

async function waitFor(p: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(p)) return readFileSync(p, "utf8");
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`never written: ${p}`);
}

const posixOnly = process.platform === "win32" ? "the fake IDE is a shell script" : false;

test("jetbrains:merge hands the IDE Yours as LOCAL during a rebase; markResolved stages and cleans up", { skip: posixOnly }, async () => {
  const r = reporter();
  const ide = fakeIde();
  try {
    const settings: MergeSettings = { ...DEFAULT_MERGE_SETTINGS, jetbrainsPath: ide.command };
    const b = await bridgeFor(r.root, settings);
    const found = await b.jetbrainsDetect();
    assert.deepEqual(found, { id: "custom", name: "IntelliJ IDEA", command: ide.command });

    const opened = await b.jetbrainsMerge({ path: "f.txt" });
    assert.equal(opened.ok, true, opened.message);
    const log = await waitFor(ide.log);
    const args = [...log.matchAll(/^ARG (.*)$/gm)].map((m) => m[1]);
    assert.equal(args[0], "merge");
    assert.equal(args[4], realpathSync(join(r.root, "f.txt")), "the output is the real file");
    const local = new RegExp(`^FILE ${args[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)<EOF>$`, "m").exec(log)?.[1];
    assert.equal(local?.split("\n")[2], "three-test", "LOCAL is the reporter's own line");
    const tempDir = join(args[1], "..");
    assert.equal(existsSync(tempDir), true);

    // The IDE left markers: marking it resolved must refuse, not settle them.
    const refused = await b.jetbrainsMarkResolved({ path: "f.txt" });
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /conflict markers/);
    // The IDE wrote a clean result.
    writeFileSync(join(r.root, "f.txt"), "one\ntwo\nthree-test\nfour\nfive\n");
    const done = await b.jetbrainsMarkResolved({ path: "f.txt" });
    assert.equal(done.ok, true, done.message);
    assert.equal(r.git("ls-files", "-u").trim(), "");
    assert.equal(existsSync(tempDir), false, "LOCAL / REMOTE / BASE are gone");
    const snap = await b.conflictState();
    assert.equal(snap.files[0].choice, "merged");
  } finally {
    removeTempRepo(r.root);
    rmSync(ide.dir, { recursive: true, force: true });
  }
});

test("jetbrains:merge refuses a file with no text to merge, and a path outside the repo", async () => {
  const r = repo("jb-bin");
  const ide = fakeIde();
  try {
    const bin = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.alloc(32, n)]);
    writeFileSync(join(r.root, "a.png"), bin(0));
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "side");
    writeFileSync(join(r.root, "a.png"), bin(1));
    r.git("commit", "-qam", "side");
    r.git("checkout", "-q", "main");
    writeFileSync(join(r.root, "a.png"), bin(2));
    r.git("commit", "-qam", "main");
    r.tryGit("merge", "side");
    const b = await bridgeFor(r.root, { ...DEFAULT_MERGE_SETTINGS, jetbrainsPath: ide.command });
    const out = await b.jetbrainsMerge({ path: "a.png" });
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.match(out.message ?? "", /no text to merge/);
    assert.equal((await b.jetbrainsMerge({ path: "../x" })).ok, false);
    assert.equal(existsSync(ide.log), false, "the IDE was never launched");
  } finally {
    removeTempRepo(r.root);
    rmSync(ide.dir, { recursive: true, force: true });
  }
});

test("jetbrains:merge passes the Apply's guards: no non-UTF-8 text, no folder that leads outside", { skip: posixOnly }, async () => {
  // The IDE writes its result to the real file — the same write the embedded
  // Apply (conflict:resolve) guards. Two twins it lacked: the sides travel as
  // strings (a Latin-1 file reached the IDE as U+FFFD and was saved that way),
  // and only a lexical containment check stood between the output path and a
  // conflicted folder since replaced by a link to somewhere else.
  const r = repo("jb-guards");
  const ide = fakeIde();
  const outside = mkdtempSync(join(tmpdir(), "gs-opctx-outside-"));
  try {
    const put = (rel: string, data: string | Buffer): void => {
      mkdirSync(join(r.root, rel, ".."), { recursive: true });
      writeFileSync(join(r.root, rel), data);
    };
    const latin1 = (s: string): Buffer => Buffer.from(s, "latin1");
    put("menu.txt", latin1("café\nthé\n"));
    put("sub/f.txt", "one\ntwo\nthree\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "side");
    put("menu.txt", latin1("café side\nthé\n"));
    put("sub/f.txt", "one\ntwo\nthree-side\n");
    r.git("commit", "-qam", "side");
    r.git("checkout", "-q", "main");
    put("menu.txt", latin1("café main\nthé\n"));
    put("sub/f.txt", "one\ntwo\nthree-main\n");
    r.git("commit", "-qam", "main");
    r.tryGit("merge", "side");
    writeFileSync(join(outside, "f.txt"), "OUTSIDE\n");
    rmSync(join(r.root, "sub"), { recursive: true, force: true });
    symlinkSync(outside, join(r.root, "sub"));

    const b = await bridgeFor(r.root, { ...DEFAULT_MERGE_SETTINGS, jetbrainsPath: ide.command });
    const menu = await b.jetbrainsMerge({ path: "menu.txt" });
    assert.equal(menu.ok, false);
    assert.equal(menu.expected, true);
    assert.match(menu.message ?? "", /isn't UTF-8 text/);
    const linked = await b.jetbrainsMerge({ path: "sub/f.txt" });
    assert.equal(linked.ok, false);
    assert.match(linked.message ?? "", /resolves outside the repository/);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(existsSync(ide.log), false, "the IDE was never launched");
    assert.equal(readFileSync(join(outside, "f.txt"), "utf8"), "OUTSIDE\n");
  } finally {
    removeTempRepo(r.root);
    rmSync(ide.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
