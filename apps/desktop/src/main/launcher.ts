// The desktop's machine for starting programs the user installed — the AI CLIs
// (`claude`, `codex`, `gemini`) and custom editors. The decisions are
// @gitstudio/git-service/commandLaunch's (pure, tested per platform); this
// supplies the real filesystem, the environment, and the two PATHs this
// process may not have:
//
//   · macOS / Linux: the login shell's. An app opened from the Dock or Finder
//     starts with /usr/bin:/bin:/usr/sbin:/sbin, so anything the user's
//     ~/.zprofile or ~/.zshrc puts on PATH (nvm, a custom bin folder) is
//     invisible to it. Asked of `$SHELL -i -l -c` once, and only after the
//     usual folders came up empty.
//   · Windows: the registry's. A process keeps the Path it was started with,
//     so a CLI installed after the app — or after Explorer, which started the
//     app — is not on it. Read from HKCU/HKLM once, on the same terms.
//
// Tests replace the machine with `setLauncherMachine` (aiBridge.fakes.ts does,
// for every AI test), so nothing here ever looks at the developer's own PATH or
// runs their shell from a test.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import {
  betweenMarks,
  envValue,
  expandWindowsVars,
  findExecutable,
  prepareOn,
  regQueryPath,
  searchDirs,
  spawnOptionsFor,
  splitPathList,
  type LaunchMachine,
  type PreparedLaunch,
} from "@gitstudio/git-service/commandLaunch";

export interface LauncherMachine extends LaunchMachine {
  readText: (p: string) => string | undefined;
  /** PATH entries the login shell (macOS/Linux) or the registry (Windows)
   *  knows and this process may not. Asked at most once per machine. */
  freshPath: () => Promise<string[]>;
  /** Windows: end process `pid` and everything it started; `fallback` when
   *  that cannot be done. (Tests record it; the real one is taskkill.) */
  stopTree?: (pid: number, fallback: () => void) => void;
}

/** What `spawn` needs for one launch. */
export type Launch = PreparedLaunch;

export type LaunchResult =
  | { ok: true; launch: Launch }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "needs-node" | "unrunnable"; found: string };

/** VS Code allows a login shell ten seconds too: nvm and oh-my-zsh together
 *  can take several on a cold start. Only ever paid on a miss, and once. */
const SHELL_TIMEOUT_MS = 10_000;
const MARK = "__GITSTUDIO_PATH__";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** The flags that make `shell` read the user's startup files and run `-c`.
 *  csh and tcsh take `-l` only as their sole flag, and refuse it beside `-c`. */
export function shellFlags(shell: string): string[] {
  return /(?:^|\/)t?csh$/.test(shell) ? ["-i", "-c"] : ["-i", "-l", "-c"];
}

/**
 * Ask a login shell for its PATH. `-i` too: nvm and most PATH edits live in
 * ~/.zshrc, which only an interactive shell reads.
 *
 * The answer is the text between the two markers, taken the moment the
 * second arrives — an rc file that leaves a background job holding stdout
 * would otherwise keep this waiting out the whole timeout. stdin is
 * /dev/null, so an rc that asks a question reads end-of-file. The shell gets a
 * process group of its own, and a timeout kills the whole group: killing only
 * the shell left whatever its rc file had started running.
 */
export function probeShellPath(
  shell: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<string[]> {
  const script = `printf '%s' '${MARK}'; /usr/bin/printenv PATH; printf '%s' '${MARK}'`;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.unref();
      resolve(splitPathList(value, platform));
    };
    try {
      child = spawn(shell, [...shellFlags(shell), script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        // Lets an rc file skip heavy work, as VS Code's VSCODE_RESOLVING_ENVIRONMENT does.
        env: { ...env, GITSTUDIO_RESOLVING_ENVIRONMENT: "1" },
      });
    } catch {
      resolve([]);
      return;
    }
    timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(betweenMarks(out, MARK));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
      const value = betweenMarks(out, MARK);
      if (value !== undefined) finish(value);
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(betweenMarks(out, MARK)));
  });
}

function loginShellPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  return probeShellPath(env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"), env, platform);
}

/** The user's and the machine's Path as the registry holds them now. `reg`
 *  prints in the console's code page, so a non-ASCII folder may come back
 *  garbled; it then simply is not found, and the rest still are. */
function registryPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const root = envValue(env, "SystemRoot", "win32") || "C:\\Windows";
  const reg = win32.join(root, "System32", "reg.exe");
  const query = (key: string) =>
    new Promise<string | undefined>((resolve) => {
      try {
        execFile(reg, ["query", key, "/v", "Path"], { timeout: SHELL_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (err, stdout) =>
          resolve(err ? undefined : regQueryPath(String(stdout ?? ""))),
        );
      } catch {
        resolve(undefined);
      }
    });
  return Promise.all([
    query("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    query("HKCU\\Environment"),
  ]).then((values) => values.flatMap((v) => splitPathList(v === undefined ? undefined : expandWindowsVars(v, env), "win32")));
}

/** How long the login shell's / registry's answer is trusted: a CLI
 *  installed into a new folder meanwhile is found within this, without
 *  a restart. */
export const FRESH_PATH_TTL_MS = 5 * 60_000;

/**
 * `ask`, at most once in `ttlMs` — but an empty answer is never kept: a
 * login shell that timed out on a cold start (nvm, oh-my-zsh) or a `reg`
 * that failed said nothing about the machine, and keeping it reported
 * every CLI on the shell's PATH "isn't installed" until a restart.
 */
export function keptForAWhile(ask: () => Promise<string[]>, ttlMs = FRESH_PATH_TTL_MS, now: () => number = Date.now): () => Promise<string[]> {
  let kept: { at: number; dirs: Promise<string[]> } | undefined;
  return () => {
    if (kept && now() - kept.at < ttlMs) return kept.dirs;
    const entry = { at: now(), dirs: ask().catch((): string[] => []) };
    kept = entry;
    void entry.dirs.then((dirs) => {
      if (dirs.length === 0 && kept === entry) kept = undefined;
    });
    return entry.dirs;
  };
}

function realMachine(): LauncherMachine {
  const platform = process.platform;
  const env = process.env;
  return {
    platform,
    env,
    home: homedir(),
    isFile,
    readText,
    freshPath: keptForAWhile(() => (platform === "win32" ? registryPath(env) : loginShellPath(env, platform))),
  };
}

let machine: LauncherMachine | undefined;

function current(): LauncherMachine {
  return (machine ??= realMachine());
}

/** Tests: run every lookup against `m` (pass undefined for the real machine). */
export function setLauncherMachine(m: LauncherMachine | undefined): void {
  machine = m;
}

/**
 * A lookup for command NAMES (`hx`) and paths (`~/bin/ed`) as a terminal
 * would resolve them: over this process's PATH and the installers' folders,
 * or — `fresh` — over the login shell's / registry's PATH as well (asked at
 * most once in a few minutes, so a caller tries without it first).
 */
export async function programFinder(fresh = false): Promise<(name: string) => string | undefined> {
  const m = current();
  const dirs = searchDirs(m, fresh ? await m.freshPath() : []);
  return (name) => findExecutable(name, dirs, m);
}

/**
 * How to start `name` with `args` here — or why it cannot be. This process's
 * PATH and the installers' folders first; the login shell / registry only when
 * those come up empty.
 */
export async function prepareLaunch(name: string, args: readonly string[]): Promise<LaunchResult> {
  const m = current();
  let r = prepareOn(name, args, m);
  if (!r.ok && (r.plan.kind === "missing" || r.plan.kind === "needs-node")) {
    r = prepareOn(name, args, m, await m.freshPath());
  }
  if (r.ok) return r;
  const plan = r.plan;
  return plan.kind === "missing" ? { ok: false, reason: "missing" } : { ok: false, reason: plan.kind, found: plan.found };
}

/** Spawn options for a prepared launch (cwd and stdio are the caller's). */
export const launchOptions = spawnOptionsFor;

/** taskkill by its full path: the tree, forcibly, with no console of its own. */
function taskkillTree(pid: number, fallback: () => void): void {
  const root = envValue(process.env, "SystemRoot", "win32") || "C:\\Windows";
  try {
    // A taskkill that ran and failed (access denied, the root already gone
    // while a grandchild holds the pipes) still gets the plain kill.
    spawn(win32.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", fallback)
      .on("exit", (code) => {
        if (code !== 0) fallback();
      });
  } catch {
    fallback();
  }
}

/**
 * End a CLI this app started, and what it started. On Windows a CLI is often
 * node.exe under a launcher, running the native program that holds the pipes:
 * killing node.exe alone left that running and the run never reported its
 * end — so the whole tree goes, the way cloneBridge ends a clone. Elsewhere a
 * signal to the child is enough.
 */
export function stopProcess(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals = "SIGTERM"): void {
  const m = current();
  if (m.platform === "win32" && child.pid !== undefined) {
    (m.stopTree ?? taskkillTree)(child.pid, () => child.kill(signal));
    return;
  }
  child.kill(signal);
}
