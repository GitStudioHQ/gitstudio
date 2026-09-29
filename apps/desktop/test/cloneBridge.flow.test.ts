import { electron } from "./desktopMainFakeElectron";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { killActiveClones, listGhRepos, pickCloneDir, startClone, targetName } from "../src/main/cloneBridge";
import type { GitHubClient } from "../src/main/githubClient";
import type { CloneProgress } from "../src/shared/ipc";
import { serveOwnSsh } from "../../../scripts/test/no-network-git.mjs";
import { removeTempRepo } from "./tmpRepo";

// Clone, end to end against local repositories (a file:// URL, so git runs its
// real transport and prints real progress), and the checks on what the user
// typed into the clone sheet — each of which the sheet shows inline, so each
// is `expected`. Nothing here reaches a network: the suite's hermetic git
// refuses one, and the one "remote" that hangs is this test's own ssh stand-in.

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) removeTempRepo(d);
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `gitstudio-${prefix}-`));
  made.push(d);
  return d;
}

function sourceRepo(): string {
  const src = temp("clonesrc");
  const git = (...a: string[]): string => execFileSync("git", ["-C", src, ...a], { encoding: "utf8" });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", src]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(src, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return src;
}

// ── the clone sheet's checks ────────────────────────────────────────────────

test("a blank URL, a URL that isn't one, and no destination are refused as the sheet's own states", async () => {
  const progress: CloneProgress[] = [];
  const on = (p: CloneProgress): void => void progress.push(p);
  assert.deepEqual(await startClone({ url: "   ", parentDir: "/x" }, on), {
    ok: false,
    expected: true,
    message: "No repository URL was provided.",
  });
  const ext = await startClone({ url: "ext::sh -c touch% /tmp/pwned", parentDir: "/x" }, on);
  assert.equal(ext.ok, false);
  assert.equal(ext.expected, true);
  assert.match(ext.message ?? "", /unsupported transport/);
  const flag = await startClone({ url: "--upload-pack=touch /tmp/pwned", parentDir: "/x" }, on);
  assert.equal(flag.ok, false);
  assert.equal(flag.expected, true);
  assert.deepEqual(await startClone({ url: "https://example.com/acme/repo.git", parentDir: "" }, on), {
    ok: false,
    expected: true,
    message: "No destination folder was chosen.",
  });
  assert.deepEqual(progress, [], "nothing was started");
});

test("a folder name that cannot be derived or used is refused with the bad-name code", async () => {
  const parent = temp("clonedest");
  const none = await startClone({ url: "/", parentDir: parent }, () => undefined);
  assert.deepEqual(none, { ok: false, code: "bad-name", expected: true, message: "Couldn't derive a folder name from the URL." });
  const dash = await startClone({ url: "https://example.com/a/b.git", parentDir: parent, name: "-rf" }, () => undefined);
  assert.equal(dash.code, "bad-name");
  assert.match(dash.message ?? "", /can't start with a dash/);
  const dots = await startClone({ url: "https://example.com/a/b.git", parentDir: parent, name: ".." }, () => undefined);
  assert.equal(dots.code, "bad-name");
});

test("the folder name is the explicit one, else the URL's last segment without .git", () => {
  assert.equal(targetName({ url: "https://github.com/acme/widgets.git/", parentDir: "/p" }), "widgets");
  assert.equal(targetName({ url: "C:\\src\\Tools.GIT", parentDir: "/p" }), "Tools");
  assert.equal(targetName({ url: "https://github.com/acme/widgets", parentDir: "/p", name: "  mine  " }), "mine");
});

test("a destination that is already there is refused before git runs", async () => {
  const parent = temp("clonedest");
  writeFileSync(join(parent, "taken"), "someone's file\n");
  const res = await startClone({ url: "https://example.com/acme/taken.git", parentDir: parent }, () => undefined);
  assert.equal(res.ok, false);
  assert.equal(res.code, "dest-exists");
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /already exists/);
  assert.equal(readFileSync(join(parent, "taken"), "utf8"), "someone's file\n");
});

test("a destination folder that cannot be created is reported with the reason", async () => {
  const parent = temp("clonedest");
  const file = join(parent, "a-file");
  writeFileSync(file, "not a folder\n");
  const res = await startClone({ url: "https://example.com/acme/x.git", parentDir: join(file, "under") }, () => undefined);
  assert.equal(res.ok, false);
  assert.equal(res.expected, undefined, "mkdir refusing is a real failure");
  assert.match(res.message ?? "", /^Couldn't create /);
});

// ── the clone itself ─────────────────────────────────────────────────────────

test("a clone streams git's progress and resolves with the new repository's path", async () => {
  const src = sourceRepo();
  const parent = temp("clonedest");
  const progress: CloneProgress[] = [];
  const res = await startClone({ url: pathToFileURL(src).href, parentDir: parent, name: "copy" }, (p) => void progress.push(p));
  assert.deepEqual(res, { ok: true, root: join(parent, "copy") });
  assert.equal(readFileSync(join(parent, "copy", "a.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n");
  assert.ok(
    progress.some((p) => /^Cloning into/.test(p.phase)),
    `the opening line is forwarded: ${JSON.stringify(progress)}`,
  );
  const pct = progress.filter((p) => typeof p.percent === "number");
  assert.ok(pct.length > 0, "percent lines are parsed");
  for (const p of pct) {
    assert.ok(p.percent! >= 0 && p.percent! <= 100);
    assert.match(p.phase, /^[A-Za-z ]+$/, "the phase is the words before the colon");
  }
});

test("a clone git refuses fails, leaves no half-made folder, and names no success", async () => {
  const parent = temp("clonedest");
  const missing = join(temp("clonesrc"), "no-repo-here");
  const res = await startClone({ url: pathToFileURL(missing).href, parentDir: parent, name: "copy" }, () => undefined);
  assert.equal(res.ok, false);
  assert.equal(res.root, undefined);
  assert.ok((res.message ?? "").length > 0, "it says something");
  assert.equal(existsSync(join(parent, "copy")), false, "git leaves no half-made folder behind");
});

// The failure message used to be only the LAST stderr line. git explains a
// refused clone over several lines —
//   fatal: '/…/no-repo-here' does not appear to be a git repository
//   fatal: Could not read from remote repository.
//
//   Please make sure you have the correct access rights
//   and the repository exists.
// — so the clone sheet showed "and the repository exists." and nothing else: a
// sentence fragment with the reason cut off. It now keeps the first fatal line.
test("a clone git refuses resolves with git's reason, not the tail of its advice", async () => {
  const parent = temp("clonedest");
  const missing = join(temp("clonesrc"), "no-repo-here");
  const res = await startClone({ url: pathToFileURL(missing).href, parentDir: parent, name: "copy" }, () => undefined);
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /does not appear to be a git repository|Could not read from remote/);
  assert.doesNotMatch(res.message ?? "", /^fatal:/, "the severity prefix is the toast's to show, not the sentence's");
});

test("with no git on PATH the clone says so in words, not ENOENT", async () => {
  const parent = temp("clonedest");
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  try {
    process.env.PATH = temp("empty-path");
    if (saved.Path !== undefined) process.env.Path = process.env.PATH;
    const res = await startClone({ url: "https://example.com/acme/x.git", parentDir: parent }, () => undefined);
    assert.deepEqual(res, { ok: false, message: "git was not found on your PATH." });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Path !== undefined) process.env.Path = saved.Path;
  }
});

test("a clone the OS refuses to start is answered with the reason, not thrown", async () => {
  const parent = temp("clonedest");
  // A NUL cannot be in an argument: spawn throws before any process exists.
  const res = await startClone({ url: "https://example.com/acme/x.git", parentDir: parent, name: "bad\0name" }, () => undefined);
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /null bytes|string without null/i);
});

// Capped: if the kill ever leaves the clone running again, this fails in 30s
// instead of holding a CI runner for six hours (Windows did, until killTree).
test("closing the window kills a clone still in flight instead of orphaning it", { timeout: 30_000 }, async () => {
  const parent = temp("clonedest");
  // An ssh that connects and then waits forever — until git, its parent, goes
  // away and its stdin closes. Forward slashes: git runs it through `sh -c`.
  const node = process.execPath.split("\\").join("/");
  const undo = serveOwnSsh(`"${node}" -e "process.stdin.on('end',()=>process.exit(0));process.stdin.resume()"`);
  try {
    let killed = false;
    const res = await startClone({ url: "ssh://git@example.invalid/acme/slow.git", parentDir: parent }, (p) => {
      // The first line git prints is "Cloning into …": the child is alive.
      if (!killed) {
        killed = true;
        killActiveClones();
      }
    });
    assert.equal(killed, true);
    assert.equal(res.ok, false, "a killed clone is not a finished one");
    assert.ok(res.message, "and it says something");
    // A second teardown has nothing left to kill.
    killActiveClones();
  } finally {
    undo();
  }
});

// ── pickers and lists ────────────────────────────────────────────────────────

test("the clone-folder picker opens at the configured folder and answers the chosen path", async () => {
  electron.dialogAnswer = { canceled: false, filePaths: ["/Users/dev/code"] };
  assert.equal(await pickCloneDir("/Users/dev/GitStudio"), "/Users/dev/code");
  assert.equal(electron.dialogs.at(-1)?.defaultPath, "/Users/dev/GitStudio");
  assert.deepEqual(electron.dialogs.at(-1)?.properties, ["openDirectory", "createDirectory"]);

  electron.dialogAnswer = { canceled: true, filePaths: [] };
  assert.equal(await pickCloneDir(), undefined, "cancel is no folder");
  assert.equal("defaultPath" in (electron.dialogs.at(-1) ?? {}), false);
  electron.dialogAnswer = { canceled: false, filePaths: [] };
  assert.equal(await pickCloneDir(), undefined);
});

function client(repos: unknown[] | undefined, login: string | Error): GitHubClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    requestPaged: async (path: string) => {
      paths.push(path);
      return repos;
    },
    request: async (_method: string, path: string) => {
      paths.push(path);
      if (login instanceof Error) throw login;
      return { login };
    },
  } as unknown as GitHubClient & { paths: string[] };
}

const RAW = [
  {
    full_name: "dev/old-tool",
    name: "old-tool",
    owner: { login: "dev", type: "User" },
    description: "A CLI for widgets",
    private: true,
    clone_url: "https://github.com/dev/old-tool.git",
    ssh_url: "git@github.com:dev/old-tool.git",
    default_branch: "trunk",
    stargazers_count: 3,
    language: "Go",
    pushed_at: "2024-01-01T00:00:00Z",
  },
  {
    full_name: "acme/app",
    name: "app",
    owner: { login: "acme", type: "Organization" },
    description: null,
    fork: true,
    updated_at: "2025-06-01T00:00:00Z",
  },
  {},
];

test("the repository list maps GitHub's shape, marks yours, and sorts newest first", async () => {
  const c = client(RAW, "dev");
  const list = await listGhRepos(c);
  assert.match(c.paths[0], /^\/user\/repos\?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member$/);
  assert.deepEqual(list.map((r) => r.fullName), ["acme/app", "dev/old-tool", ""]);
  const mine = list[1];
  assert.deepEqual(mine, {
    fullName: "dev/old-tool",
    name: "old-tool",
    owner: "dev",
    ownerType: "User",
    mine: true,
    description: "A CLI for widgets",
    private: true,
    fork: false,
    cloneUrl: "https://github.com/dev/old-tool.git",
    sshUrl: "git@github.com:dev/old-tool.git",
    defaultBranch: "trunk",
    stars: 3,
    language: "Go",
    updatedAt: "2024-01-01T00:00:00Z",
  });
  const org = list[0];
  assert.equal(org.ownerType, "Organization");
  assert.equal(org.mine, false);
  assert.equal(org.fork, true);
  assert.equal(org.defaultBranch, "main", "a missing default branch reads as main");
  assert.equal(org.updatedAt, "2025-06-01T00:00:00Z", "updated_at stands in for pushed_at");
});

test("the repository search matches the name or the description, case-insensitively", async () => {
  assert.deepEqual((await listGhRepos(client(RAW, "dev"), "  WIDGETS ")).map((r) => r.fullName), ["dev/old-tool"]);
  assert.deepEqual((await listGhRepos(client(RAW, "dev"), "ACME/")).map((r) => r.fullName), ["acme/app"]);
});

test("when who-am-I fails, nothing is claimed as yours and the list still loads", async () => {
  const list = await listGhRepos(client(RAW, new Error("401")));
  assert.equal(list.length, 3);
  assert.equal(list.some((r) => r.mine), false);
  assert.deepEqual(await listGhRepos(client(undefined, "dev")), [], "no pages is an empty list");
});
