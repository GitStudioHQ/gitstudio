import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess, type GitRunWithInputOptions } from "../src/GitProcess";
import { LogProvider, revisionLines } from "../src/LogProvider";
import { removeTempRepo } from "./tmpRepo";

// The graph's branch filter (issue #30): `streamCommits({ revRange: "--all",
// refs })` walks exactly the ticked refs — plus HEAD, which is never optional —
// instead of every branch, tag and remote. These pin what git is handed (the
// contract the hosts rely on) and what a filtered walk returns.
//
// The ticked refs travel on STDIN (`git log --stdin`), not argv: Windows caps a
// command line at 32,767 characters, and "Local only" on a repository with a
// few hundred branches is past it (logRefsMany.test.ts measures that). So the
// recorder below keeps each spawn's stdin beside its argv.

let repo: string;
let proc: RecordingProcess;
let log: LogProvider;

interface Spawn {
  args: string[];
  input: string | undefined;
}

/** A real GitProcess that remembers what every call was handed. */
class RecordingProcess extends GitProcess {
  spawns: Spawn[] = [];
  override stream(args: string[], opts?: GitRunWithInputOptions): AsyncGenerator<string> {
    this.spawns.push({ args: [...args], input: opts?.input });
    return super.stream(args, opts);
  }
  override run(args: string[], opts?: GitRunWithInputOptions) {
    this.spawns.push({ args: [...args], input: opts?.input });
    return super.run(args, opts);
  }
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function commit(file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git("add", ".");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

const shas = async (refs?: string[]): Promise<string[]> => {
  const out: string[] = [];
  for await (const c of log.streamCommits({ revRange: "--all", refs })) out.push(c.sha);
  return out;
};

/** The LAST `git log` this test spawned. */
const lastLog = (): Spawn => {
  const logs = proc.spawns.filter((s) => s.args[0] === "log");
  assert.ok(logs.length > 0, "a git log was spawned");
  return logs[logs.length - 1];
};

/** The revisions a spawn names: everything after the format on argv that is
 *  not an option, then every line of its stdin. `--` and paths never appear
 *  in these calls. */
const revisionsOf = (s: Spawn): string[] => {
  const fmt = s.args.findIndex((a) => a.startsWith("--pretty="));
  const onArgv = s.args.slice(fmt + 1).filter((a) => !a.startsWith("--"));
  const onStdin = (s.input ?? "").split("\n").filter(Boolean);
  return [...onArgv, ...onStdin];
};

let sideTip = "";
let mainTip = "";
let tagged = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-logrefs-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  commit("a.txt", "c0");
  tagged = commit("b.txt", "c1");
  git("tag", "v1");
  git("checkout", "-q", "-b", "side");
  sideTip = commit("side.txt", "on side");
  git("checkout", "-q", "main");
  mainTip = commit("c.txt", "on main");
  proc = new RecordingProcess({ cwd: repo });
  log = new LogProvider(proc);
});

afterEach(() => {
  proc?.dispose();
  removeTempRepo(repo);
});

test("THE CONTRACT: git is handed exactly the ticked refs plus HEAD, and none of the --all expansion", async () => {
  await shas(["refs/heads/side", "refs/tags/v1"]);
  const spawn = lastLog();
  assert.deepEqual(
    revisionsOf(spawn),
    ["refs/heads/side", "refs/tags/v1", "HEAD"],
    "the ticked refs, in order, then HEAD",
  );
  for (const flag of ["--branches", "--tags", "--remotes", "--all"]) {
    assert.ok(!spawn.args.includes(flag), `${flag} must not widen a filtered walk`);
  }
});

test("the ticked refs ride on stdin: argv names no ref at all, and --ignore-missing is read before stdin is", async () => {
  await shas(["refs/heads/side", "refs/tags/v1"]);
  const { args, input } = lastLog();
  assert.equal(input, "refs/heads/side\nrefs/tags/v1\nHEAD\n", "one revision per line, newline-terminated");
  assert.ok(!args.some((a) => a.startsWith("refs/") || a === "HEAD"), `no revision on argv: ${args.join(" ")}`);
  assert.ok(args.includes("--stdin"));
  // git reads stdin the moment it meets --stdin, with the options it has seen
  // so far: --ignore-missing after it would not apply to the refs.
  assert.ok(args.indexOf("--ignore-missing") < args.indexOf("--stdin"));
});

test("a filtered walk shows only the history those refs reach", async () => {
  const only = await shas(["refs/heads/side"]);
  assert.ok(only.includes(sideTip), "the ticked branch's tip is there");
  // HEAD is on main, and HEAD always rides along — so main's tip is there too.
  // What must NOT be there is anything reachable from neither.
  assert.ok(only.includes(mainTip), "HEAD (main) is never filtered out");
  git("checkout", "-q", "side");
  const fromSide = await shas(["refs/tags/v1"]);
  assert.ok(fromSide.includes(tagged), "the ticked tag's commit is there");
  assert.ok(fromSide.includes(sideTip), "…and HEAD, now on side");
  assert.ok(!fromSide.includes(mainTip), "main's tip is reachable from neither the tag nor HEAD, so it is gone");
});

test("HEAD rides along even when detached and ticked nowhere", async () => {
  git("checkout", "-q", "--detach", "HEAD~1");
  const detached = commit("d.txt", "detached work");
  const out = await shas(["refs/tags/v1"]);
  assert.ok(out.includes(detached), "the commit you are sitting on is in the graph");
  assert.deepEqual(revisionsOf(lastLog()).at(-1), "HEAD");
});

test("a ticked ref that no longer exists is skipped, not fatal", async () => {
  // The selection is remembered per repository; a branch in it can be deleted
  // by another tool between sessions. One gone ref must not blank the graph.
  const out = await shas(["refs/heads/deleted-elsewhere", "refs/heads/side"]);
  assert.ok(out.includes(sideTip), "the surviving ref still walks");
  assert.ok(lastLog().args.includes("--ignore-missing"));
});

test("the refs are data: an option-shaped entry cannot widen the walk", async () => {
  // The selection is read back from storage. Both hosts prune it against the
  // live ref list, so this cannot happen today — but on stdin a line starting
  // with "-" is a PSEUDO-OPTION to git 2.42+: a literal "--all" would sweep in
  // refs/notes and refs/stash, the exact thing the "--all" expansion exists to
  // keep out (and on older git it is fatal). A newline inside an entry would
  // smuggle a second line in; ".." would make a range. None of those can be
  // the name of a ref, so none of them reaches git.
  git("checkout", "-q", "side");
  git("notes", "add", "-m", "a note", sideTip);
  const out = await shas(["refs/tags/v1", "--all", "refs/heads/x\n--all", "refs/heads/main..refs/heads/side", "--branches"]);
  assert.ok(out.includes(tagged) && out.includes(sideTip), "the real ref and HEAD still walk");
  assert.ok(!out.includes(mainTip), "main's tip is reachable from neither — a widened walk would have it");
  assert.ok(!out.includes(git("rev-parse", "refs/notes/commits")), "and the notes commit is not history");
  assert.deepEqual(revisionsOf(lastLog()), ["refs/tags/v1", "HEAD"], "only the plain ref name was handed to git");
});

test("revisionLines keeps exactly the names git allows under refs/", () => {
  const kept = [
    "refs/heads/main",
    "refs/heads/feature/x-1.2",
    "refs/remotes/origin/release/1.5",
    "refs/tags/v1.0.0",
    "refs/heads/heads/release",
    "refs/heads/ünïcode",
  ];
  const dropped = [
    "--all",
    "-x",
    "main",
    "heads/release",
    "HEAD",
    "refs/heads/a\n--all",
    "refs/heads/a\r",
    "refs/heads/a b",
    "refs/heads/a..b",
    "refs/heads/a@{1}",
    "refs/heads/a^",
    "refs/heads/a~1",
    "refs/heads/a:b",
    "refs/heads/a*",
    "refs/heads/a?",
    "refs/heads/a[",
    "refs/heads/a\\b",
    "",
  ];
  assert.equal(revisionLines([...kept, ...dropped]), [...kept, "HEAD"].join("\n") + "\n");
  assert.equal(revisionLines(["refs/heads/x"], "^"), "^refs/heads/x\n^HEAD\n", "a prefix negates every line, HEAD included");
  assert.equal(revisionLines([]), "HEAD\n");
});

test("an empty refs list is the unfiltered walk", async () => {
  const all = await shas();
  assert.deepEqual(await shas([]), all);
  const { args, input } = lastLog();
  assert.ok(args.includes("--branches") && args.includes("--tags") && args.includes("--remotes"));
  assert.ok(!args.includes("--ignore-missing"));
  assert.ok(!args.includes("--stdin"));
  assert.equal(input, undefined, "and nothing on stdin");
});

test("walkReaches says whether a filtered walk would reach a commit, without walking it", async () => {
  // HEAD is on main. A walk of v1 alone (plus HEAD, always) reaches the tagged
  // commit and main's tip, and not side's.
  assert.equal(await log.walkReaches(tagged, ["refs/tags/v1"]), true, "the ticked tag's commit");
  assert.equal(await log.walkReaches(mainTip, ["refs/tags/v1"]), true, "HEAD's tip, ticked nowhere");
  assert.equal(await log.walkReaches(sideTip, ["refs/tags/v1"]), false, "side's tip is reachable from neither");
  assert.equal(await log.walkReaches(sideTip, ["refs/heads/side"]), true, "…until side is ticked");
  // The answer agrees with the walk itself, both ways.
  const walked = await shas(["refs/tags/v1"]);
  for (const c of [tagged, mainTip, sideTip]) {
    assert.equal(await log.walkReaches(c, ["refs/tags/v1"]), walked.includes(c), c);
  }
  // A ticked ref that is gone reaches nothing and is not fatal; a sha git
  // cannot resolve answers true, so the caller pages as it always did.
  assert.equal(await log.walkReaches(sideTip, ["refs/heads/deleted-elsewhere", "refs/tags/v1"]), false);
  assert.equal(await log.walkReaches("0".repeat(40), ["refs/tags/v1"]), true);
  // An option-shaped entry is dropped here too, rather than read as an option.
  assert.equal(await log.walkReaches(sideTip, ["refs/tags/v1", "--all"]), false, "--all did not widen the negation");
  const spawn = proc.spawns.filter((s) => s.args[0] === "rev-list").at(-1)!;
  assert.equal(spawn.input, "^refs/tags/v1\n^HEAD\n", "the negated refs ride on stdin");
  assert.ok(spawn.args.includes("--ignore-missing") && spawn.args.includes("--stdin"));
  assert.ok(spawn.args.indexOf("--ignore-missing") < spawn.args.indexOf("--stdin"), "…read after --ignore-missing");
  assert.deepEqual(spawn.args.slice(-2), ["--end-of-options", sideTip], "the sha stays on argv, past the marker");
});

test("paging semantics are unchanged under a filter: skip/maxCount walk the filtered list", async () => {
  const truth = await shas(["refs/heads/side"]);
  const page = async (skip: number, n: number): Promise<string[]> => {
    const out: string[] = [];
    for await (const c of log.streamCommits({
      revRange: "--all",
      refs: ["refs/heads/side"],
      skip,
      maxCount: n,
    })) {
      out.push(c.sha);
    }
    return out;
  };
  const first = await page(0, 2);
  const second = await page(2, 10);
  assert.deepEqual([...first, ...second], truth, "every filtered commit paged in exactly once");
});
