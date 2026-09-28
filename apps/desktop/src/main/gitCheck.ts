// Is Git there?
//
// The desktop app runs the git that is installed on the machine — it does not
// bundle one — so a machine without it can do nothing. Before this, nothing
// asked. Every git call failed at spawn with Node's "spawn git ENOENT"; a
// folder you opened was declared "a Git repository, but Git can't read it — its
// .git folder may be damaged" (cannotOpenNotice reads git's silence as the
// repository's fault); and the tabs your last session had open were dropped as
// "gone or no longer Git repositories", then saved that way, so installing Git
// brought back an empty window. On macOS the usual case is not even a missing
// file: /usr/bin/git is a stub that runs Apple's Command Line Tools, and says
// so on stderr when they are not installed (or were broken by an OS update).
//
// So the app asks once, early, and the window shows what to do about it
// (renderer/noGit.ts). A "Check again" asks again.
//
// One more thing it does. An app opened from the Dock or Finder does not get
// your shell's PATH — on macOS it is /usr/bin:/bin:/usr/sbin:/sbin — and a
// Windows process keeps the PATH it started with, so Git installed while the
// app is open is not on it. Either way `git` can fail while a perfectly good
// Git sits where every installer puts it. When the git on PATH does not work,
// those places are tried, and a Git found there is put at the front of this
// process's PATH, so every `git` the app spawns from then on runs it.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { GitAvailability } from "../shared/ipc";

/** Paths spelled for the platform in question, whichever one runs this. */
const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** What running `<git> --version` answered. */
export interface GitRunAnswer {
  /** The process could not be started at all (ENOENT and friends). */
  spawnFailed?: boolean;
  /** Exit code; null when it was killed (the timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitProbeDeps {
  /** Run `<bin> --version`. */
  run?: (bin: string) => Promise<GitRunAnswer>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** The absolute places to look when `git` on PATH does not work. */
  candidates?: string[];
}

const TIMEOUT_MS = 10_000;

function runVersion(bin: string): Promise<GitRunAnswer> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
      if (e && typeof e.code === "string") {
        // A string code is a spawn failure (ENOENT, EACCES), not an exit code.
        resolve({ spawnFailed: true, code: null, stdout: "", stderr: e.message });
        return;
      }
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/** Where installers put git, for when `git` on PATH does not work. */
export function gitCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const { join } = win32;
    const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].filter((r): r is string => !!r);
    const out = roots.map((r) => join(r, "Git", "cmd", "git.exe"));
    // Git for Windows' per-user install, and Scoop's shim.
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"));
    if (env.USERPROFILE) out.push(join(env.USERPROFILE, "scoop", "shims", "git.exe"));
    return [...new Set(out)];
  }
  if (platform === "darwin") {
    // Homebrew on Apple silicon, then Homebrew on Intel and the git-scm.com
    // installer's link, then MacPorts.
    return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git"];
  }
  return ["/usr/bin/git", "/usr/local/bin/git"];
}

/** macOS's /usr/bin/git stub explaining that Apple's developer tools are missing. */
const XCODE_STUB = /xcode-select|xcrun|CommandLineTools|developer tools/i;

/** The version out of `git version 2.39.5 (Apple Git-154)`, or undefined. */
function versionOf(stdout: string): string | undefined {
  return /git version\s+(\S+)/i.exec(stdout)?.[1];
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  ).slice(0, 300);
}

/**
 * Find a git that works: the one on PATH, else one where installers put it
 * (which then joins the front of `env.PATH`). Never throws.
 */
export async function probeGit(deps: GitProbeDeps = {}): Promise<GitAvailability> {
  const run = deps.run ?? runVersion;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;

  const onPath = await run("git").catch(
    (e: unknown): GitRunAnswer => ({ spawnFailed: true, code: null, stdout: "", stderr: String(e) }),
  );
  const version = onPath.code === 0 ? versionOf(onPath.stdout) : undefined;
  if (version) return { ok: true, version };

  // Why the git on PATH did not do: the answer if nothing else is found.
  const said = firstLine(`${onPath.stderr}\n${onPath.stdout}`);
  const failure: GitAvailability = onPath.spawnFailed
    ? { ok: false, reason: "missing", platform }
    : platform === "darwin" && XCODE_STUB.test(`${onPath.stderr}\n${onPath.stdout}`)
      ? { ok: false, reason: "xcode", platform, ...(said ? { detail: said } : {}) }
      : { ok: false, reason: "broken", platform, ...(said ? { detail: said } : {}) };

  for (const candidate of deps.candidates ?? gitCandidates(platform, env)) {
    if (!exists(candidate)) continue;
    const answer = await run(candidate).catch(
      (e: unknown): GitRunAnswer => ({ spawnFailed: true, code: null, stdout: "", stderr: String(e) }),
    );
    const found = answer.code === 0 ? versionOf(answer.stdout) : undefined;
    if (!found) continue;
    // Every `git` this process spawns from here on resolves to it. (On
    // Windows `env.PATH` reads and writes the `Path` variable, whatever its
    // case.)
    const paths = pathsFor(platform);
    env.PATH = [paths.dirname(candidate), env.PATH].filter(Boolean).join(paths.delimiter);
    return { ok: true, version: found };
  }
  return failure;
}

let cached: Promise<GitAvailability> | undefined;

/**
 * The app's answer: probed once, then kept — `recheck` probes again. What the
 * launch restore, the window and a failed open all ask.
 */
export function gitAvailability(recheck = false): Promise<GitAvailability> {
  if (!cached || recheck) cached = probeGit();
  return cached;
}
