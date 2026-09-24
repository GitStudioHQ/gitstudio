// The in-the-way state table, desktop column: every commit-applying door ×
// every state of the user's working tree, through the REAL bridge methods
// against real git.
//
//   door:  revert · cherry-pick · merge · rebase onto · checkout a branch ·
//          stash apply · stash pop (a plain stash, and one made with -u) · pull
//   state: clean · a tracked edit in the way · the same edit on the very line
//          the door changes (it conflicts coming back) · an untracked file in
//          the way · an edit elsewhere
//
// Per cell: said plainly when refused (the files, `expected`, nothing filed,
// NOTHING changed — HEAD, the bytes on disk, the stash list), and Stash &
// Retry does the door's work and gives the user's bytes back exactly — in the
// file, or conflicted in it and kept in the stash, or kept in the stash — and
// says which. A door fed a genuine failure still reports.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { CommitActionResult } from "../src/shared/ipc";

const scratch = mkdtempSync(join(tmpdir(), "gs-intheway-table-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "t"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
  ]) {
    g("config", k, v);
  }
}

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");
const plain = LINES("line 0", 0);

type Door =
  | "revert"
  | "cherry-pick"
  | "merge"
  | "rebase"
  | "checkout"
  | "stash apply"
  | "stash pop"
  | "stash apply -u"
  | "stash pop -u"
  | "pull"
  | "pull --rebase";
type State = "clean" | "edit in the way" | "edit on its line" | "untracked in the way" | "edit elsewhere";

/**
 * base:    a.txt b.txt d.txt e.txt
 * feature: "feature changes a, adds n"   a.txt line 0, + n.txt
 * main:    "main changes b, removes d"   b.txt line 0, - d.txt     ← HEAD
 * origin/main (not yet fetched): main + "theirs"  a.txt line 0, + n.txt
 * stash@{0} (stash doors): a.txt line 2 — and, made with -u, an untracked n.txt
 *
 * So every door writes a.txt line 0 and creates n.txt, except the revert,
 * which writes b.txt line 0 and recreates d.txt. e.txt nothing touches.
 */
function fixture(door: Door): { dir: string; git: (...a: string[]) => string } {
  const base = mkdtempSync(join(scratch, "cell-"));
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  identify(git);
  for (const f of ["a.txt", "b.txt", "e.txt"]) writeFileSync(join(dir, f), plain);
  writeFileSync(join(dir, "d.txt"), "d\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  writeFileSync(join(dir, "n.txt"), "from feature\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature changes a, adds n");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), LINES("main", 0));
  git("rm", "-q", "d.txt");
  git("commit", "-q", "-am", "main changes b, removes d");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");
  const seed = join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  const s = at(seed);
  identify(s);
  writeFileSync(join(seed, "a.txt"), LINES("theirs", 0));
  writeFileSync(join(seed, "n.txt"), "from theirs\n");
  s("add", ".");
  s("commit", "-q", "-m", "theirs");
  s("push", "-q", "origin", "main");
  if (door.startsWith("stash")) {
    writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
    if (door.endsWith("-u")) {
      writeFileSync(join(dir, "n.txt"), "from the stash\n");
      git("stash", "push", "-q", "-u", "-m", "the one asked for");
    } else {
      git("stash", "push", "-q", "-m", "the one asked for");
    }
  }
  return { dir, git };
}

/** The file a door writes, the line it writes, and the file it creates. */
function targets(door: Door): { file: string; line: number; creates: string } {
  if (door === "revert") return { file: "b.txt", line: 0, creates: "d.txt" };
  if (door.startsWith("stash")) return { file: "a.txt", line: 2, creates: "n.txt" };
  return { file: "a.txt", line: 0, creates: "n.txt" };
}

/** Put the user's work in place; what they wrote, by path. */
function arrange(dir: string, door: Door, state: State): Record<string, string> {
  const t = targets(door);
  const mine: Record<string, string> = {};
  const put = (f: string, s: string): void => {
    writeFileSync(join(dir, f), s);
    mine[f] = s;
  };
  // The revert's file starts from main's b.txt; every other door's from base's a.txt.
  const start = door === "revert" ? LINES("main", 0) : plain;
  if (state === "edit in the way") put(t.file, start.replace("line 6\n", "mine\n"));
  if (state === "edit on its line") put(t.file, LINES("mine", t.line));
  if (state === "untracked in the way") put(t.creates, "my own untracked file\n");
  if (state === "edit elsewhere") put("e.txt", plain.replace("line 6\n", "mine\n"));
  return mine;
}

async function bridgeOn(dir: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(dir);
  return new GitBridge(repos);
}

function run(bridge: GitBridge, door: Door, git: (...a: string[]) => string, stashFirst?: string): Promise<CommitActionResult> {
  const sf = stashFirst ? { stashFirst } : {};
  switch (door) {
    case "revert":
      return bridge.commitAction({ action: "revert", sha: git("rev-parse", "main").trim(), ...sf });
    case "cherry-pick":
      return bridge.commitAction({ action: "cherry-pick", sha: git("rev-parse", "feature").trim(), ...sf });
    case "merge":
      return bridge.branchMerge({ fullName: "refs/heads/feature", ...sf });
    case "rebase":
      return bridge.branchRebase({ fullName: "refs/heads/feature", ...sf });
    case "checkout":
      return bridge.commitAction({
        action: "checkout-ref",
        sha: "feature",
        name: "feature",
        fullName: "refs/heads/feature",
        refKind: "head",
        ...sf,
      });
    case "stash apply":
    case "stash apply -u":
      return bridge.stashApply(stashFirst ? { ref: "stash@{0}", stashFirst } : "stash@{0}");
    case "stash pop":
    case "stash pop -u":
      return bridge.stashPop(stashFirst ? { ref: "stash@{0}", stashFirst } : "stash@{0}");
    case "pull":
      return bridge.syncPull(stashFirst ? { stashFirst } : undefined);
    case "pull --rebase":
      return bridge.syncPull({ mode: "rebase", ...sf });
  }
}

/** Did the door's work happen? */
function didIt(door: Door, dir: string, git: (...a: string[]) => string): boolean {
  const subject = git("log", "-1", "--format=%s").trim();
  switch (door) {
    case "revert":
      return subject.startsWith("Revert ");
    case "cherry-pick":
      return subject === "feature changes a, adds n";
    case "merge":
      return git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length === 3;
    case "rebase":
      return git("merge-base", "--is-ancestor", "feature", "HEAD").length === 0 && subject === "main changes b, removes d";
    case "checkout":
      return git("symbolic-ref", "--short", "HEAD").trim() === "feature";
    case "stash apply":
    case "stash pop":
    case "stash apply -u":
    case "stash pop -u":
      return readFileSync(join(dir, "a.txt"), "utf8").includes("stashed\n");
    case "pull":
    case "pull --rebase":
      return subject === "theirs";
  }
}

type Snapshot = { head: string; status: string; stashes: string; files: Record<string, string | null> };
function snapshot(dir: string, git: (...a: string[]) => string): Snapshot {
  const files: Record<string, string | null> = {};
  for (const f of ["a.txt", "b.txt", "d.txt", "e.txt", "n.txt"]) {
    files[f] = existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null;
  }
  return {
    head: git("rev-parse", "HEAD").trim(),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
    stashes: git("stash", "list", "--format=%H"),
    files,
  };
}

const DOORS: Door[] = ["revert", "cherry-pick", "merge", "rebase", "checkout", "stash apply", "stash pop", "stash apply -u", "stash pop -u", "pull"];
const STATES: State[] = ["clean", "edit in the way", "edit on its line", "untracked in the way", "edit elsewhere"];

/** What each cell should come to: asked (or not), and after Stash & Retry, where the user's bytes are. */
function expectation(door: Door, state: State): { asks: boolean; after?: "restored" | "conflicted" | "kept" } {
  if (state === "clean") return { asks: false };
  if (state === "edit elsewhere") return door === "rebase" ? { asks: true, after: "restored" } : { asks: false };
  if (state === "untracked in the way") {
    // Plain stashes create nothing, so nothing untracked is in their way.
    if (door === "stash apply" || door === "stash pop") return { asks: false };
    return { asks: true, after: "kept" };
  }
  if (door.startsWith("stash")) return { asks: true, after: "kept" }; // git won't pop over what the stash brought in
  return { asks: true, after: state === "edit on its line" ? "conflicted" : "restored" };
}

for (const door of DOORS) {
  for (const state of STATES) {
    test(`${door} × ${state}`, async () => {
      const { dir, git } = fixture(door);
      const mine = arrange(dir, door, state);
      const bridge = await bridgeOn(dir);
      const want = expectation(door, state);
      const before = snapshot(dir, git);
      const first = await run(bridge, door, git);
      assert.equal(reportableResultMessage(first), undefined, `nothing is filed: ${first.message}`);
      if (!want.asks) {
        assert.equal(first.inTheWay, undefined, `not asked: ${first.message}`);
        assert.equal(first.ok, true, `done: ${first.message}`);
        assert.ok(didIt(door, dir, git), "the door's work happened");
        for (const [f, s] of Object.entries(mine)) assert.equal(readFileSync(join(dir, f), "utf8"), s, `${f}: the user's bytes, untouched`);
        return;
      }
      assert.equal(first.ok, false);
      assert.equal(first.expected, true);
      assert.ok(first.inTheWay, `asked: ${first.message}`);
      assert.deepEqual(first.inTheWay.files, Object.keys(mine).sort(), "exactly the user's files — nothing of git's");
      assert.deepEqual(snapshot(dir, git), before, "refused: NOTHING changed — HEAD, the files on disk, the stash list");

      const again = await run(bridge, door, git, first.inTheWay.root);
      assert.equal(reportableResultMessage(again), undefined, `the retry files nothing: ${again.message}`);
      assert.ok(didIt(door, dir, git), `the retry did the door's work: ${again.message}`);
      const ours = git("stash", "list", "--format=%H %s").split("\n").filter((l) => /GitStudio: before/.test(l));
      if (want.after === "restored") {
        assert.equal(again.ok, true, again.message);
        assert.equal(again.stashNote, undefined);
        // The door's version of the file, with the user's line 6 back on it.
        for (const f of Object.keys(mine)) {
          assert.equal(readFileSync(join(dir, f), "utf8"), git("show", `HEAD:${f}`).replace("line 6\n", "mine\n"), `${f}: the user's bytes, back exactly`);
        }
        assert.equal(git("status", "--porcelain", "--", ...Object.keys(mine)).slice(0, 2), " M", "uncommitted, unstaged, as it was");
        assert.deepEqual(ours, [], "no stash of ours left behind");
      } else if (want.after === "conflicted") {
        assert.match(again.stashNote ?? "", /conflict/, "said: they conflict with what came in");
        assert.equal(ours.length, 1, "and kept in the stash");
        for (const [f, s] of Object.entries(mine)) {
          const now = readFileSync(join(dir, f), "utf8");
          assert.match(now, /^<<<<<<< /m, `${f}: conflicted`);
          assert.ok(now.includes(s.split("\n").find((l) => l.startsWith("mine"))!), `${f}: with the user's line in it`);
        }
      } else {
        assert.match(again.stashNote ?? "", /kept in the stash/, "said: kept in the stash");
        assert.equal(ours.length, 1, "kept in the stash");
        const sha = ours[0].split(" ")[0];
        let third: string[] = [];
        try {
          third = git("ls-tree", "-r", "--name-only", `${sha}^3`, "--").split("\n").filter(Boolean);
        } catch {
          // no untracked half
        }
        for (const [f, s] of Object.entries(mine)) {
          const kept = third.includes(f) ? git("show", `${sha}^3:${f}`) : git("show", `${sha}:${f}`);
          assert.equal(kept, s, `${f}: the user's bytes, exactly, in the stash`);
        }
      }
    });
  }
}

// ── the index's own shapes: a staged rename, and a staged deletion ──────────
//
// Every door that needs the index to match HEAD (a pick, a revert, a true
// merge, a rebase, a rebasing pull) is refused over these wherever they are.
// A rename is a deletion and an addition, and a staged deletion is a path
// `git stash push` will not take — so Stash & Retry must stash both names,
// and give the index back exactly as it was.

const INDEX_DOORS: Door[] = ["revert", "cherry-pick", "merge", "rebase", "pull --rebase"];
const INDEX_STATES: { name: string; arrange: (git: (...a: string[]) => string) => void; status: string }[] = [
  { name: "a staged rename", arrange: (git) => git("mv", "e.txt", "e2.txt"), status: "R  e.txt -> e2.txt" },
  { name: "a staged deletion", arrange: (git) => git("rm", "-q", "e.txt"), status: "D  e.txt" },
];

// A staged edit in the way BESIDE a staged edit elsewhere: the doors that carry
// the one elsewhere (a switch, a fast-forward pull) must give BOTH back staged.
// `git stash pop --index` refuses while anything else is staged, and the
// fallback put the edit back unstaged. (A stash applied merges into the
// index, so a staged edit is never in its way.)
for (const door of ["checkout", "pull"] as Door[]) {
  test(`${door} × a staged edit in the way, beside a staged edit elsewhere: both come back staged`, async () => {
    const { dir, git } = fixture(door);
    const t = targets(door);
    const mine = plain.replace("line 6\n", "mine\n");
    writeFileSync(join(dir, t.file), mine);
    writeFileSync(join(dir, "e.txt"), plain.replace("line 4\n", "elsewhere\n"));
    git("add", t.file, "e.txt");
    const bridge = await bridgeOn(dir);
    const first = await run(bridge, door, git);
    assert.deepEqual(first.inTheWay?.files, [t.file], `asked about ${t.file} alone: ${first.message}`);
    const again = await run(bridge, door, git, first.inTheWay!.root);
    assert.equal(reportableResultMessage(again), undefined, `the retry files nothing: ${again.message}`);
    assert.ok(didIt(door, dir, git), `done: ${again.message}`);
    assert.equal(git("status", "--porcelain", "--", "e.txt").trimEnd(), "M  e.txt", "the one elsewhere, still staged");
    if (!door.startsWith("stash")) {
      assert.equal(git("status", "--porcelain", "--", t.file).trimEnd(), "M  " + t.file, "the one in the way, staged again");
      assert.equal(git("show", `:${t.file}`), git("show", `HEAD:${t.file}`).replace("line 6\n", "mine\n"));
    }
  });
}

for (const door of INDEX_DOORS) {
  for (const state of INDEX_STATES) {
    test(`${door} × ${state.name} elsewhere: asked, and Stash & Retry does it and gives the index back exactly`, async () => {
      const { dir, git } = fixture(door === "pull --rebase" ? "pull" : door);
      state.arrange(git);
      const bridge = await bridgeOn(dir);
      const first = await run(bridge, door, git);
      assert.equal(reportableResultMessage(first), undefined, `nothing is filed: ${first.message}`);
      assert.ok(first.inTheWay, `asked: ${first.message}`);
      assert.ok(first.inTheWay.files.includes("e.txt"), `the old name is in the way too: ${first.inTheWay.files}`);
      const again = await run(bridge, door, git, first.inTheWay.root);
      assert.equal(reportableResultMessage(again), undefined, `the retry files nothing: ${again.message}`);
      assert.equal(again.ok, true, again.message);
      assert.ok(didIt(door === "pull --rebase" ? "pull" : door, dir, git), "done");
      assert.equal(git("status", "--porcelain", "--", "e.txt", "e2.txt").trimEnd(), state.status, "staged, as it was");
      assert.deepEqual(git("stash", "list").split("\n").filter((l) => /GitStudio: before/.test(l)), [], "no stash left behind");
    });
  }
}
