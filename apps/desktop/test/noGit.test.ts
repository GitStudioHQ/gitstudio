// A machine without Git. The desktop app runs the git that is installed (it
// bundles none), and without it every view failed on its own with "spawn git
// ENOENT", a folder you opened was called damaged, and the tabs your last
// session had open were dropped as gone — and saved that way. Three halves:
// finding git (main/gitCheck.ts), keeping the session when it is missing
// (RepoStore), and what the window says (renderer/noGitHelp.ts; the screen
// itself is driven in the harness: a-machine-without-git-is-told-how-to-get-it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gitCandidates, probeGit, type GitRunAnswer } from "../src/main/gitCheck";
import { RepoStore } from "../src/main/repoStore";
import { cannotOpenNotice, gitMissingNotice } from "../src/main/repoNotice";
import { gitInstallHelp } from "../src/renderer/noGitHelp";
import type { GitContext } from "@gitstudio/git-service/index";

const ENOENT: GitRunAnswer = { spawnFailed: true, code: null, stdout: "", stderr: "spawn git ENOENT" };
const works = (version: string): GitRunAnswer => ({ code: 0, stdout: `git version ${version}\n`, stderr: "" });
const XCODE_STUB: GitRunAnswer = {
  code: 1,
  stdout: "",
  stderr:
    "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n",
};

/** A machine: what each binary answers, and which files exist. */
function machine(answers: Record<string, GitRunAnswer>, files: string[] = Object.keys(answers)) {
  const ran: string[] = [];
  return {
    ran,
    run: async (bin: string) => {
      ran.push(bin);
      return answers[bin] ?? ENOENT;
    },
    exists: (p: string) => files.includes(p),
  };
}

// ── finding git ──────────────────────────────────────────────────────────────

test("git on the PATH that answers is used as it is, and nothing else is looked at", async () => {
  const m = machine({ git: works("2.46.0") });
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  assert.deepEqual(await probeGit({ ...m, platform: "darwin", env }), { ok: true, version: "2.46.0" });
  assert.deepEqual(m.ran, ["git"]);
  assert.equal(env.PATH, "/usr/bin:/bin", "the PATH is left alone");
});

test("no git at all is 'missing' — on every platform, with no detail to quote", async () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const m = machine({}, []);
    assert.deepEqual(await probeGit({ ...m, platform, env: {} }), { ok: false, reason: "missing", platform });
  }
});

test("macOS's /usr/bin/git stub without the Command Line Tools is its own answer, quoted", async () => {
  const m = machine({ git: XCODE_STUB }, []);
  const r = await probeGit({ ...m, platform: "darwin", env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "xcode");
  assert.match(r.ok === false ? (r.detail ?? "") : "", /^xcrun: error: invalid active developer path/);
  // …but the same words elsewhere are not the Mac's stub.
  const other = await probeGit({ ...machine({ git: XCODE_STUB }, []), platform: "linux", env: {} });
  assert.equal(other.ok === false && other.reason, "broken");
});

test("a git that runs and fails is 'broken', with the first thing it said", async () => {
  const m = machine({ git: { code: 127, stdout: "", stderr: "\ngit: error while loading shared libraries: libpcre2-8.so.0\nmore\n" } }, []);
  assert.deepEqual(await probeGit({ ...m, platform: "linux", env: {} }), {
    ok: false,
    reason: "broken",
    platform: "linux",
    detail: "git: error while loading shared libraries: libpcre2-8.so.0",
  });
});

test("an app opened from the Dock misses Homebrew's git; it is found there and put first on the PATH", async () => {
  // The stub fails (no Command Line Tools), Homebrew's git is fine.
  const m = machine({ git: XCODE_STUB, "/opt/homebrew/bin/git": works("2.47.1") });
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  assert.deepEqual(await probeGit({ ...m, platform: "darwin", env }), { ok: true, version: "2.47.1" });
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "every later `git` resolves to it");
});

test("Git installed on Windows while the app was open is found where the installer put it", async () => {
  // The process keeps the PATH it started with, so `git` is still not on it.
  const exe = "C:\\Program Files\\Git\\cmd\\git.exe";
  const m = machine({ [exe]: works("2.47.0.windows.1") });
  const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\system32", ProgramFiles: "C:\\Program Files" };
  assert.deepEqual(await probeGit({ ...m, platform: "win32", env }), { ok: true, version: "2.47.0.windows.1" });
  assert.equal(env.PATH, "C:\\Program Files\\Git\\cmd;C:\\Windows\\system32");
});

test("a candidate that is there but does not run is passed over, and the first failure is what is said", async () => {
  const m = machine({ git: ENOENT, "/usr/bin/git": { code: 1, stdout: "", stderr: "nope" }, "/usr/local/bin/git": works("2.1.0") });
  const env: NodeJS.ProcessEnv = { PATH: "/bin" };
  assert.deepEqual(await probeGit({ ...m, platform: "linux", env }), { ok: true, version: "2.1.0" });
  assert.deepEqual(m.ran, ["git", "/usr/bin/git", "/usr/local/bin/git"]);
  const none = machine({ git: ENOENT, "/usr/bin/git": { code: 1, stdout: "", stderr: "nope" } });
  assert.deepEqual(await probeGit({ ...none, platform: "linux", env: {} }), { ok: false, reason: "missing", platform: "linux" });
});

test("where installers put git, per platform", () => {
  assert.deepEqual(
    gitCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
      USERPROFILE: "C:\\Users\\ada",
    }),
    [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
      "C:\\Users\\ada\\scoop\\shims\\git.exe",
    ],
  );
  assert.deepEqual(gitCandidates("darwin", {}), ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git"]);
  assert.deepEqual(gitCandidates("linux", {}), ["/usr/bin/git", "/usr/local/bin/git"]);
});

test("on this machine, the real probe finds the real git", async () => {
  const real = /git version\s+(\S+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }))?.[1];
  assert.deepEqual(await probeGit({ candidates: [] }), { ok: true, version: real });
});

// ── keeping the session ──────────────────────────────────────────────────────

/** A store whose "repositories" are any path under /r/ — while git works. */
function store(git: { works: boolean }) {
  return new RepoStore([], {
    discover: async (cwd) => (git.works && cwd.startsWith("/r/") ? cwd : undefined),
    realpath: (p) => p,
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
    gitReady: async () => git.works,
  });
}

test("a launch without git keeps the tabs it could not open, and saves them as they were", async () => {
  const git = { works: false };
  const s = store(git);
  const { dropped } = await s.restore(["/r/a", "/r/b"], "/r/b");
  assert.deepEqual(dropped, [], "nothing is called gone: the folders are fine, git is missing");
  assert.deepEqual(s.state().tabs, [], "none can open without git");
  assert.deepEqual(s.serialize().open, ["/r/a", "/r/b"], "the session is saved as it was");
  assert.equal(s.serialize().current, "/r/b");
  // Git arrives (the window's Check again): the tabs come back, the same one in front.
  git.works = true;
  assert.deepEqual(await s.resumeDeferredRestore(), []);
  assert.deepEqual(s.state().tabs.map((t) => t.root), ["/r/a", "/r/b"]);
  assert.equal(s.state().active, "/r/b");
  assert.equal(await s.resumeDeferredRestore(), undefined, "and only once");
});

test("with git working, a folder that is gone is still dropped and named", async () => {
  const s = store({ works: true });
  const { dropped } = await s.restore(["/r/a", "/gone/b"], "/r/a");
  assert.deepEqual(dropped, ["/gone/b"]);
  assert.deepEqual(s.serialize().open, ["/r/a"]);
  assert.equal(await s.resumeDeferredRestore(), undefined, "nothing was held back");
});

test("a folder opened while git is missing is not called damaged", () => {
  for (const reason of ["missing", "xcode", "broken"] as const) {
    const n = gitMissingNotice({ ok: false, reason, platform: "darwin", ...(reason === "broken" ? { detail: "boom" } : {}) });
    assert.equal(n.kind, "warn");
    assert.match(n.message, /^GitStudio can't open repositories without Git\./);
    assert.doesNotMatch(n.message, /damaged|not inside a Git repository/);
  }
  assert.match(gitMissingNotice({ ok: false, reason: "xcode", platform: "darwin" }).message, /xcode-select --install/);
  assert.match(gitMissingNotice({ ok: false, reason: "broken", platform: "linux", detail: "boom" }).message, /\("boom"\)/);
  // The notice it replaces, for contrast: about the folder, which is the wrong thing to blame.
  assert.match(cannotOpenNotice("/r/x", { dotGitAbove: () => "/r/x/.git", canRead: () => true, isFolder: () => true, ownedByOtherUser: () => false }).message, /damaged/);
});

// ── what the window says ─────────────────────────────────────────────────────

test("each platform is told its own way to get Git", () => {
  const commands = (platform: string) =>
    gitInstallHelp({ ok: false, reason: "missing", platform }).ways.flatMap((w) => (w.command ? [w.command] : []));
  assert.deepEqual(commands("darwin"), ["xcode-select --install", "brew install git"]);
  assert.deepEqual(commands("win32"), ["winget install --id Git.Git -e --source winget"]);
  assert.deepEqual(commands("linux"), ["sudo apt install git", "sudo dnf install git", "sudo pacman -S git", "sudo zypper install git"]);
  const win = gitInstallHelp({ ok: false, reason: "missing", platform: "win32" });
  assert.match(win.ways[0].label, /git-scm\.com/);
  assert.equal(win.download.label, "Download Git for Windows");
  assert.equal(win.download.url, "https://git-scm.com/downloads");
});

test("the title says which problem it is, and a broken git's own words are kept", () => {
  assert.equal(gitInstallHelp({ ok: false, reason: "missing", platform: "linux" }).title, "Git isn't installed");
  const xcode = gitInstallHelp({ ok: false, reason: "xcode", platform: "darwin", detail: "xcrun: error" });
  assert.equal(xcode.title, "Git needs Apple's Command Line Tools");
  assert.equal(xcode.detail, "xcrun: error");
  assert.equal(xcode.ways[0].command, "xcode-select --install");
  const broken = gitInstallHelp({ ok: false, reason: "broken", platform: "win32", detail: "exit 128" });
  assert.equal(broken.title, "Git isn't working");
  assert.equal(broken.detail, "exit 128");
  assert.equal(gitInstallHelp({ ok: false, reason: "missing", platform: "darwin" }).detail, undefined);
});
