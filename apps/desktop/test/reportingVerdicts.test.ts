// Both halves of the crash-report contract, driven through the real handlers.
//
// main.ts wraps every IPC handler in `handle()`, and `handle()` decides what is
// filed with exactly two functions: a handler that RETURNS is judged by
// `reportableResultMessage`, one that THROWS by `isExpectedError`. `filed()`
// below is that decision, line for line, so every case here is the verdict the
// shipped app would reach — not a paraphrase of it.
//
// The lens is the one the report-triage branch has to hold on both sides:
//
//   · nothing that is OUR defect went quiet — a git command that failed, a
//     GitHub answer we did not expect, a request our own renderer built wrong;
//   · nothing that is a state the USER is in still files — each of the states
//     reports #12–#17 were filed from, rebuilt here (with invented names).
//
// Everything that reaches git reads a pinned, empty config (hermeticGit).

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempRepo } from "./tmpRepo";
import { HERMETIC_GIT_CONFIG } from "./hermeticGit";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { GitHubClient } from "../src/main/githubClient";
import { listRepoDir } from "../src/main/github/repoBrowse";
import { getProjectBoard, listProjects } from "../src/main/github/projects";
import { installMcp, type McpRuntime } from "../src/main/mcpConfig";
import { openGitHubRepo } from "../src/main/ghRepoOpen";
import { isExpectedError, reportableResultMessage } from "../src/main/expectedError";
import { pullVerdict } from "../src/renderer/pullFlow";

/**
 * What main.ts's `handle()` files for one call: the message it would send to
 * the collector, or undefined when it sends nothing. Mirrors the wrapper:
 * a returned result goes through `reportableResultMessage`, a thrown one is
 * filed unless `isExpectedError` says it is a condition.
 */
async function filed(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    return reportableResultMessage(await run());
  } catch (err) {
    return isExpectedError(err) ? undefined : err instanceof Error ? err.message : String(err);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "gs-verdicts-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8" });

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

/**
 * A clone whose branch and upstream both rewrote the same line of base.txt,
 * with nothing fetched yet — so a merge or a rebase of the two stops.
 */
function collidingClone(): { root: string; remote: string; work: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(scratch, "pull-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  const s = at(seed);
  identify(s);
  writeFileSync(join(seed, "base.txt"), "base\n");
  s("add", ".");
  s("commit", "-qm", "base");
  s("push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, work]);
  const git = at(work);
  identify(git);
  writeFileSync(join(seed, "base.txt"), "theirs\n");
  s("commit", "-qam", "theirs");
  s("push", "-q", "origin", "main");
  writeFileSync(join(work, "base.txt"), "mine\n");
  git("commit", "-qam", "mine");
  return { root, remote, work, git };
}

async function bridgeOn(work: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(work);
  return new GitBridge(repos);
}

/** Answer every fetch with this status and body, for the length of `run`. */
async function servedBy<T>(
  status: number,
  body: string,
  run: (client: GitHubClient) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    return await run(new GitHubClient(() => "ghp_test"));
  } finally {
    globalThis.fetch = real;
  }
}

const json = (v: unknown): string => JSON.stringify(v);

function runtime(over: Partial<McpRuntime> = {}): McpRuntime {
  return {
    packaged: false,
    execPath: process.execPath,
    resourcesPath: join(scratch, "no-resources"),
    mainDir: join(scratch, "no-dist", "main"),
    userData: join(scratch, "userData"),
    ...over,
  };
}

test("filed() is still what handle() does", async () => {
  // Everything below leans on `filed()` mirroring main.ts's wrapper. If the
  // wrapper grows another judgement, this is where the mirror goes stale.
  const main = await readFile(fileURLToPath(new URL("../src/main/main.ts", import.meta.url)), "utf8");
  const start = main.indexOf("function handle<C extends IpcChannel>(");
  assert.ok(start >= 0, "main.ts still registers IPC through handle()");
  const body = main.slice(start, main.indexOf("\nfunction ", start + 1));
  const code = body
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.match(code, /const failure = reportableResultMessage\(result\);\s*if \(failure\) \{\s*ErrorReporter\.current\?\.captureGitError\(/);
  assert.match(code, /if \(!isExpectedError\(err\)\) \{\s*ErrorReporter\.current\?\.captureError\(/);
  assert.equal((code.match(/ErrorReporter\.current\?\.capture/g) ?? []).length, 2, "exactly the two filing paths");
});

// ── Our defects: each of these must be filed ─────────────────────────────────

test("defect: a pull mode no dialog offers is filed", async () => {
  const { work } = collidingClone();
  const bridge = await bridgeOn(work);
  const msg = await filed(() => bridge.syncPull({ mode: "octopus" as never }));
  assert.equal(msg, "That isn't a way to reconcile a pull.");
});

test("defect: a pull whose git command fails for a reason the app has no answer for is filed", async () => {
  // The remote this clone tracks is gone. Not a divergence, not a stop — git's
  // own failure, carried through with its own words.
  const { remote, work } = collidingClone();
  removeTempRepo(remote);
  const bridge = await bridgeOn(work);
  const msg = await filed(() => bridge.syncPull());
  assert.match(msg ?? "", /does not appear to be a git repository|Could not read from remote/i);
});

test("defect: a git config write that fails is filed, repository open or not", async () => {
  // The identity card's backend. git config writes by lock + rename; a config
  // path whose parent is a FILE fails that lock on every platform (a read-only
  // directory does not, on Windows).
  const notADir = join(mkdtempSync(join(scratch, "cfg-")), "not-a-dir");
  writeFileSync(notADir, "");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(notADir, "gitconfig");
  try {
    const { work } = collidingClone();
    for (const bridge of [await bridgeOn(work), new GitBridge(new RepoStore([]))]) {
      const msg = await filed(() => bridge.setGitIdentity({ name: "Pat Example", email: "pat@example.com" }));
      assert.ok(msg && msg.length > 0, "a git config that did not write is news");
    }
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("defect: a restore point the app itself made but cannot use is filed", async () => {
  const { work } = collidingClone();
  const bridge = await bridgeOn(work);
  const msg = await filed(() => bridge.discardUndo({ sha: "--output=/tmp/x", paths: ["base.txt"] }));
  assert.equal(msg, "That restore point is not usable.");
});

test("defect: GitHub answers we did not expect are filed", async () => {
  // A 422 that merely MENTIONS an empty repository is a request we built wrong.
  assert.match(
    (await servedBy(422, json({ message: "Repository is empty." }), (c) =>
      filed(() => listRepoDir(c, "acme/widgets", "")),
    )) ?? "",
    /empty/i,
  );
  // A 404 that is not the empty-repository sentence: a path we built wrong.
  assert.equal(
    await servedBy(404, json({ message: "Not Found" }), (c) => filed(() => listRepoDir(c, "acme/widgets", "src"))),
    "Not Found",
  );
  // A 200 whose body is not JSON at all.
  assert.ok(
    await servedBy(200, "<html>upstream proxy</html>", (c) => filed(() => listRepoDir(c, "acme/widgets", ""))),
    "a malformed success body is ours to hear about",
  );
});

test("policy, not a verdict of this file: a GitHub 5xx is GitHub's health, and is not filed", async () => {
  // githubErrors.ts decided this before the triage branch, on purpose: an
  // outage is not ours to fix, and everyone on the service at once would file
  // it. Pinned so that changing it is a decision, not a drift.
  const msg = await servedBy(502, json({ message: "Server Error" }), (c) =>
    filed(() => listRepoDir(c, "acme/widgets", "")),
  );
  assert.equal(msg, undefined);
});

test("defect: a GraphQL NOT_FOUND about an id WE sent, or an error with no type, is filed", async () => {
  const byId = await servedBy(
    200,
    json({
      data: { node: null },
      errors: [
        { type: "NOT_FOUND", path: ["node"], message: "Could not resolve to a node with the global id of 'PVT_bogus'." },
      ],
    }),
    (c) => filed(() => getProjectBoard(c, "acme", "widgets", "PVT_bogus")),
  );
  assert.match(byId ?? "", /global id of 'PVT_bogus'/);
  const schema = await servedBy(
    200,
    json({ errors: [{ message: "Field 'projectsV3' doesn't exist on type 'Repository'" }] }),
    (c) => filed(() => listProjects(c, "acme", "widgets")),
  );
  assert.match(schema ?? "", /projectsV3/);
});

test("defect: Agent Access in a shipped build that lost its server, or asked for a client we do not list, is filed", async () => {
  const packaged = runtime({ packaged: true, resourcesPath: join(scratch, "empty-resources") });
  const missing = await filed(async () => installMcp(undefined, { client: "cursor", write: false, destructive: false }, packaged));
  assert.match(missing ?? "", /missing its MCP server/);
  const unknown = await filed(async () =>
    installMcp(undefined, { client: "not-a-client", write: false, destructive: false }, packaged),
  );
  assert.equal(unknown, "Unknown client: not-a-client.");
});

test("defect: opening a GitHub repository with a name the renderer built wrong is filed", async () => {
  // Every door onto ghrepo:open passes a full name that came from GitHub (a
  // search hit, a list row) or from a route that only parses owner/repo. A
  // name with no slash is therefore a request we built wrong, never something
  // the user typed — and the crash report is the only way we would hear of it.
  const msg = await filed(() =>
    openGitHubRepo("widgets", new RepoStore([]), () => undefined, join(scratch, "managed")),
  );
  assert.equal(msg, "That doesn't look like an owner/repo name.");
});

// ── The users' states: none of these may be filed ────────────────────────────

test("#12: a diverged pull asks, and files nothing", async () => {
  const { work } = collidingClone();
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPull();
  assert.ok(r.diverged);
  assert.equal(await filed(async () => r), undefined);
});

test("#12: a merge or a rebase that stops on conflicts files nothing", async () => {
  for (const mode of ["merge", "rebase"] as const) {
    const { work } = collidingClone();
    const bridge = await bridgeOn(work);
    const r = await bridge.syncPull({ mode });
    assert.equal(r.stopped?.operation, mode);
    assert.equal(await filed(async () => r), undefined, `${mode} stop`);
  }
});

test("#12: pressing Pull again over a merge that is still unresolved files nothing, and asks nothing", async () => {
  // The stop lands the user in Changes — but the top bar still says "Pull 1",
  // because HEAD has not moved. Pressing it runs `git pull --ff-only`, which
  // git refuses (128, "Pulling is not possible because you have unmerged
  // files"). That refusal used to be read as a DIVERGENCE: the dialog asked
  // "merge or rebase?", and either answer failed the same way — as git's
  // terminal hint, in red, filed as a crash. The user is mid-merge; that is a
  // state, and the answer is to finish it.
  const { work, git } = collidingClone();
  const bridge = await bridgeOn(work);
  assert.ok((await bridge.syncPull({ mode: "merge" })).stopped, "precondition: stopped");

  const again = await bridge.syncPull();
  assert.equal(again.diverged, undefined, "no merge-or-rebase question over a merge already under way");
  assert.equal(await filed(async () => again), undefined);
  assert.match(again.message ?? "", /merge/i);
  assert.doesNotMatch(again.message ?? "", /hint:|git add|Pulling is not possible/);

  // The same, for a door that already carries a mode.
  for (const mode of ["merge", "rebase"] as const) {
    assert.equal(await filed(() => bridge.syncPull({ mode })), undefined, `pull --${mode} over the merge`);
  }

  // Resolved and staged, but the merge not yet committed: git refuses again
  // ("You have not concluded your merge").
  writeFileSync(join(work, "base.txt"), "both\n");
  git("add", "base.txt");
  const concluded = await bridge.syncPull();
  assert.equal(concluded.diverged, undefined);
  assert.equal(await filed(async () => concluded), undefined, "merge resolved, not committed");
});

test("#12: pressing Pull again over a rebase that is still stopped files nothing", async () => {
  const { work, git } = collidingClone();
  const bridge = await bridgeOn(work);
  assert.ok((await bridge.syncPull({ mode: "rebase" })).stopped, "precondition: stopped");
  assert.equal(await filed(() => bridge.syncPull()), undefined, "conflicts still in the index");
  // Resolved and staged, `rebase --continue` not yet run: HEAD is detached,
  // and git answers "You are not currently on a branch".
  writeFileSync(join(work, "base.txt"), "both\n");
  git("add", "base.txt");
  assert.equal(await filed(() => bridge.syncPull()), undefined, "rebase resolved, not continued");
});

test("a pull on a detached HEAD files nothing, and says there is no branch to pull into", async () => {
  // A commit or a tag checked out: git fetches, then prints terminal advice
  // ("You are not currently on a branch… git pull <remote> <branch>"). The
  // user's state, said in the app's words — the same engine fact the
  // extension's status bar settles with a "Check Out a Branch…" offer.
  const { work, git } = collidingClone();
  git("checkout", "-q", "--detach", "HEAD");
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPull();
  assert.equal(r.ok, false);
  assert.equal(await filed(async () => r), undefined);
  assert.match(r.message ?? "", /no branch to pull into/);
  assert.doesNotMatch(r.message ?? "", /git pull|<remote>|git-pull\(1\)/);
});

test("a pull the user's uncommitted work is in the way of files nothing, says so, and lands on Changes", async () => {
  // The commonest refusal a Pull meets: an edit to a file the incoming commits
  // change (merge / fast-forward), or ANY edit when the pull rebases. git's
  // "error: Your local changes to the following files would be overwritten by
  // merge … Please commit your changes or stash them before you merge.
  // Aborting" went out in red — after "Updating a..b" and the fetch's own
  // lines — and was filed as a crash.
  const cases: Array<[string, (git: (...a: string[]) => string, work: string) => void, { mode?: "rebase" } | undefined]> = [
    ["an edit the fast-forward would overwrite", (git, work) => {
      git("reset", "-q", "--hard", "HEAD~1");
      writeFileSync(join(work, "base.txt"), "editing\n");
    }, undefined],
    ["any edit, when the answer was rebase", (_git, work) => {
      writeFileSync(join(work, "notes.txt"), "untracked is fine\n");
      writeFileSync(join(work, "base.txt"), "mine, still editing\n");
    }, { mode: "rebase" }],
  ];
  for (const [label, arrange, opts] of cases) {
    const { work, git } = collidingClone();
    arrange(git, work);
    const bridge = await bridgeOn(work);
    const r = await bridge.syncPull(opts);
    assert.equal(r.ok, false, label);
    assert.equal(await filed(async () => r), undefined, `${label}: nothing filed`);
    assert.equal(r.dirty?.files, 1, label);
    assert.match(r.message ?? "", /uncommitted changes to base\.txt/, label);
    // …and it is answerable: the renderer asks Stash & Retry or Cancel about
    // exactly these files (main/inTheWay.ts, renderer/bridge.ts).
    assert.match(r.message ?? "", /Stash it and try again, or commit it first\./, label);
    assert.deepEqual(r.inTheWay, { kind: "pull", files: ["base.txt"], root: realpathSync(work) }, label);
    assert.doesNotMatch(r.message ?? "", /error:|Aborting|Updating|->|Please commit/, `${label}: not git's lines`);
    const v = pullVerdict({ result: r, cancelled: false }, "Pull failed.");
    assert.equal(v.kind, "blocked", `${label}: settled in Changes, where the work is committed or stashed`);
  }
});

test("#12 again, for a user who took git's advice: pull.ff=only on a diverged branch asks, and files nothing", async () => {
  // `git config pull.ff only` is one of the three lines git's divergence advice
  // suggests. With it set, a mode-less pull is --ff-only, and a diverged branch
  // came back as git's "Diverging branches can't be fast-forwarded" hint wall,
  // in red, filed as a crash — report #12, through the config.
  const { work, git } = collidingClone();
  git("config", "pull.ff", "only");
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPull();
  assert.ok(r.diverged, JSON.stringify(r));
  assert.equal(await filed(async () => r), undefined);
  assert.doesNotMatch(r.message ?? "", /hint:|fast-forward/i);
});

test("#13: browsing a repository with no commits files nothing", async () => {
  for (const [status, message] of [
    [404, "This repository is empty."],
    [409, "Git Repository is empty."],
  ] as const) {
    const msg = await servedBy(status, json({ message }), (c) => filed(() => listRepoDir(c, "acme/fresh", "")));
    assert.equal(msg, undefined, `${status} ${message}`);
  }
});

test("#14/#17: the projects of a repository GitHub cannot resolve file nothing", async () => {
  const msg = await servedBy(
    200,
    json({
      data: { repository: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repository"],
          message: "Could not resolve to a Repository with the name 'acme-private/billing-pipeline'.",
        },
      ],
    }),
    (c) => filed(() => listProjects(c, "acme-private", "billing-pipeline")),
  );
  assert.equal(msg, undefined);
});

test("#15: the git identity card with no repository open files nothing — because it works", async () => {
  // The identity is GLOBAL (`git config --global`); it has nothing to do with
  // which repository is open. Refusing it with "No repository open." and
  // marking that refusal expected silenced the report and kept the defect:
  // the card showed blank fields and would not save until a repository was
  // opened, which on a fresh install is exactly when a user sets it.
  writeFileSync(HERMETIC_GIT_CONFIG, "");
  const bridge = new GitBridge(new RepoStore([]));
  const saved = await bridge.setGitIdentity({ name: "Pat Example", email: "pat@example.com" });
  assert.equal(await filed(async () => saved), undefined);
  assert.equal(saved.ok, true, saved.message);
  assert.deepEqual(await bridge.gitIdentity(), { name: "Pat Example", email: "pat@example.com" });
  writeFileSync(HERMETIC_GIT_CONFIG, "");
});

test("#16: Agent Access in a dev tree with no server bundled files nothing", async () => {
  const dev = runtime({ packaged: false });
  const msg = await filed(async () => installMcp(undefined, { client: "cursor", write: false, destructive: false }, dev));
  assert.equal(msg, undefined);
});

test("the fixture is real: the clone and its upstream have each moved", async () => {
  const { git } = collidingClone();
  git("fetch", "-q");
  assert.equal(git("rev-list", "--left-right", "--count", "HEAD...@{u}").trim(), "1\t1");
});
