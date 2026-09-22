import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { setSpawnAuditSink, type AuditedSpawn } from "../src/spawnAudit";
import { removeTempRepo } from "./tmpRepo";

// "Local only" on a repository with a lot of branches (issue #30's filter).
//
// The ticked refs used to be spliced into git's argv. Windows' CreateProcess
// takes a command line of at most 32,767 characters, so at ~40 characters a
// branch name the walk stopped spawning at roughly 800 branches: the graph
// showed an error instead of history, on exactly the repositories that most
// needed the filter. They go on stdin now (`git log --stdin`).
//
// This builds a real repository with several thousand branches and walks all
// of them. macOS and Linux allow far longer command lines, so the old path
// would not FAIL here — what it would do is hand git a command line many times
// Windows' limit, and that is measured: the length of every argv this package
// actually spawns, taken from the spawn audit, which records the argv exactly
// as it reaches the OS.

const WINDOWS_CMDLINE_MAX = 32_767;
const BRANCHES = 3_000;

let repo: string;
let ctx: GitContext;
let base = "";
let head = "";
/** Branch full name → the commit it points at, one fan-out commit each. */
const tips = new Map<string, string>();

function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

/** How long a command line Windows would build from this argv: each argument,
 *  quoted when it has whitespace or a quote, joined by single spaces. */
function commandLineLength(bin: string, args: readonly string[]): number {
  return [bin, ...args].reduce((n, a) => n + a.length + (/[\s"]/.test(a) ? 2 : 0), 0) + args.length;
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-manyrefs-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "gc.auto", "0"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  base = git(["rev-parse", "HEAD"]);
  // Thousands of branches, each on its own commit off `base`, in one
  // fast-import — the realistic shape of a team repository's "Local only":
  // long, namespaced names.
  let stream = "";
  for (let i = 0; i < BRANCHES; i++) {
    const n = String(i).padStart(4, "0");
    const ref = `refs/heads/team-platform/feature/a-reasonably-descriptive-branch-name-${n}`;
    const msg = `work ${n}\n`;
    stream +=
      `commit ${ref}\nmark :${i + 1}\n` +
      `committer Dev <dev@example.com> ${1_700_000_000 + i} +0000\n` +
      `data ${Buffer.byteLength(msg)}\n${msg}from ${base}\n\n`;
  }
  git(["fast-import", "--quiet"], stream);
  for (const line of git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/team-platform"]).split("\n")) {
    const [ref, sha] = line.split(" ");
    tips.set(ref, sha);
  }
  // HEAD moves on past base, so "HEAD always rides along" is visible too.
  writeFileSync(join(repo, "f.txt"), "main\n");
  git(["commit", "-q", "-am", "main moves on"]);
  head = git(["rev-parse", "HEAD"]);
  ctx = new GitContext({ root: repo });
});

after(() => {
  setSpawnAuditSink(undefined);
  ctx?.dispose();
  removeTempRepo(repo);
});

/** Run `fn` and return every spawn this package made while it ran. */
async function audited<T>(fn: () => Promise<T>): Promise<{ value: T; spawns: AuditedSpawn[] }> {
  const spawns: AuditedSpawn[] = [];
  setSpawnAuditSink((s) => void spawns.push(s));
  try {
    return { value: await fn(), spawns };
  } finally {
    setSpawnAuditSink(undefined);
  }
}

const walk = async (refs: string[]): Promise<string[]> => {
  const out: string[] = [];
  for await (const c of ctx.log.streamCommits({ revRange: "--all", refs })) out.push(c.sha);
  return out;
};

test("the fixture is what it claims: thousands of branches, and names long enough to matter", () => {
  assert.equal(tips.size, BRANCHES);
  const refs = [...tips.keys()];
  // What the old code spliced into argv: the whole selection plus HEAD, after
  // the fixed options. Far past Windows' limit — at this name length the
  // ceiling was ~430 branches, and at a 40-character name ~800.
  const oldArgv = ["log", "--parents", "--date-order", "--pretty=format:…", "--ignore-missing", "--end-of-options", ...refs, "HEAD"];
  const oldLength = commandLineLength("git", oldArgv);
  assert.ok(oldLength > WINDOWS_CMDLINE_MAX * 5, `the argv path would build a ${oldLength}-character command line`);
});

test("Local only over thousands of branches: the walk spawns a SHORT command line and returns every branch's history", async () => {
  const refs = [...tips.keys()];
  const { value: shas, spawns } = await audited(() => walk(refs));
  const logs = spawns.filter((s) => s.args.includes("log"));
  assert.equal(logs.length, 1, "one git log");
  const length = commandLineLength(logs[0].bin, logs[0].args);
  assert.ok(
    length < 1_000,
    `the spawned command line is ${length} characters — it must not grow with the selection (Windows stops at ${WINDOWS_CMDLINE_MAX})`,
  );
  assert.ok(!logs[0].args.some((a) => a.startsWith("refs/")), "no ref rides on argv");
  // …and the walk is right: every ticked branch's commit, base, and HEAD.
  const expected = new Set([...tips.values(), base, head]);
  assert.equal(shas.length, expected.size, "nothing missing, nothing extra");
  assert.deepEqual(new Set(shas), expected);
});

test("a subset walks exactly that subset, and a gone ref among thousands is skipped", async () => {
  const all = [...tips.keys()];
  const picked = all.filter((_, i) => i % 7 === 0);
  const shas = new Set(await walk([...picked, "refs/heads/deleted-long-ago"]));
  const expected = new Set([...picked.map((r) => tips.get(r)!), base, head]);
  assert.deepEqual(shas, expected);
});

test("walkReaches over thousands of refs stays short on argv and answers both ways", async () => {
  const all = [...tips.keys()];
  const target = all[1234];
  const others = all.filter((r) => r !== target);
  const { value: reached, spawns } = await audited(() => ctx.log.walkReaches(tips.get(target)!, all));
  assert.equal(reached, true, "ticked, so reached");
  const revList = spawns.find((s) => s.args.includes("rev-list"))!;
  const length = commandLineLength(revList.bin, revList.args);
  assert.ok(length < 1_000, `rev-list's command line is ${length} characters`);
  assert.equal(await ctx.log.walkReaches(tips.get(target)!, others), false, "every OTHER branch ticked: not reached");
});
