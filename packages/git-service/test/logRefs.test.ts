import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

// The graph's branch filter (issue #30): `streamCommits({ revRange: "--all",
// refs })` walks exactly the ticked refs — plus HEAD, which is never optional —
// instead of every branch, tag and remote. These pin the argv git is handed
// (the contract the hosts rely on) and what a filtered walk returns.

let repo: string;
let ctx: GitContext;
let spawns: string[][] = [];

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
  for await (const c of ctx.log.streamCommits({ revRange: "--all", refs })) out.push(c.sha);
  return out;
};

/** The argv of the LAST `git log` this test spawned. */
const lastLog = (): string[] => {
  const logs = spawns.filter((a) => a.includes("log"));
  assert.ok(logs.length > 0, "a git log was spawned");
  return logs[logs.length - 1];
};

/** The revisions a `git log` argv names: everything after the format that is
 *  not an option. `--` and paths never appear in these calls. */
const revisionsOf = (argv: string[]): string[] => {
  const fmt = argv.findIndex((a) => a.startsWith("--pretty="));
  return argv.slice(fmt + 1).filter((a) => !a.startsWith("--"));
};

let sideTip = "";
let mainTip = "";
let tagged = "";

beforeEach(() => {
  spawns = [];
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
  ctx = new GitContext({ root: repo, onRun: (e) => void spawns.push([...e.args]) });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

test("THE CONTRACT: the argv names exactly the ticked refs plus HEAD, and none of the --all expansion", async () => {
  await shas(["refs/heads/side", "refs/tags/v1"]);
  const argv = lastLog();
  assert.deepEqual(
    revisionsOf(argv),
    ["refs/heads/side", "refs/tags/v1", "HEAD"],
    "the ticked refs, in order, then HEAD",
  );
  for (const flag of ["--branches", "--tags", "--remotes", "--all"]) {
    assert.ok(!argv.includes(flag), `${flag} must not widen a filtered walk`);
  }
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
  assert.ok(lastLog().includes("--ignore-missing"));
});

test("the refs are data: an option-shaped entry cannot widen the walk", async () => {
  // The selection is read back from storage and spliced into an argv. Both
  // hosts prune it against the live ref list, so this cannot happen today —
  // but a literal "--all" that slipped through used to be taken as the option
  // and swept in refs/notes and refs/stash, the exact thing the "--all"
  // expansion exists to keep out. Past --end-of-options it is a revision that
  // does not exist, which --ignore-missing turns into nothing.
  git("checkout", "-q", "side");
  git("notes", "add", "-m", "a note", sideTip);
  const out = await shas(["refs/tags/v1", "--all"]);
  assert.ok(out.includes(tagged) && out.includes(sideTip), "the real ref and HEAD still walk");
  assert.ok(!out.includes(mainTip), "main's tip is reachable from neither — a widened walk would have it");
  assert.ok(!out.includes(git("rev-parse", "refs/notes/commits")), "and the notes commit is not history");
  const argv = lastLog();
  const marker = argv.indexOf("--end-of-options");
  assert.ok(marker > 0, "the argv carries --end-of-options");
  assert.ok(marker < argv.indexOf("refs/tags/v1"), "…before the first ref");
  assert.ok(argv.indexOf("--ignore-missing") < marker, "…and after --ignore-missing, which must precede it to apply");
});

test("an empty refs list is the unfiltered walk", async () => {
  const all = await shas();
  assert.deepEqual(await shas([]), all);
  const argv = lastLog();
  assert.ok(argv.includes("--branches") && argv.includes("--tags") && argv.includes("--remotes"));
  assert.ok(!argv.includes("--ignore-missing"));
});

test("paging semantics are unchanged under a filter: skip/maxCount walk the filtered list", async () => {
  const truth = await shas(["refs/heads/side"]);
  const page = async (skip: number, n: number): Promise<string[]> => {
    const out: string[] = [];
    for await (const c of ctx.log.streamCommits({
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
