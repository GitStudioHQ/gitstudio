// Finding and starting a program the USER installed — an AI CLI, an editor's
// launcher — the way their terminal would, from an app that does not have
// their terminal's environment.
//
// A bare `spawn("claude")` fails where a terminal succeeds for three reasons,
// and each one has reached users as "isn't installed" about a program that is:
//
//   1. A GUI app's PATH is not the shell's. Started from the Dock or Finder,
//      macOS hands it /usr/bin:/bin:/usr/sbin:/sbin — none of ~/.local/bin
//      (Claude Code's installer), Homebrew, or npm's global bin.
//   2. Windows looks for `.com`/`.exe` only. npm, pnpm and Scoop install a
//      CLI as a `.cmd` launcher, which `spawn` without a shell cannot find
//      (ENOENT) and, given the full name, refuses to run (EINVAL, since Node's
//      fix for CVE-2024-27980). A shell is not the answer: cmd.exe cannot
//      carry a prompt with newlines in it, and its quoting is where command
//      injection lives. So the launcher is READ instead, and what it runs —
//      a script under Node, or an .exe — is started directly.
//   3. Windows keeps the PATH a process started with, so a CLI installed while
//      the app (or Explorer, which started it) was running is not on it.
//
// This file is the pure half: platform, environment and filesystem are all
// injected, so every branch — Windows included — is decided by tests on any
// host. The hosts (desktop main process, extension) supply the machine.

import { posix, win32 } from "node:path";

export interface LaunchMachine {
  platform: NodeJS.Platform;
  /** The process environment: PATH (Windows `Path`), PATHEXT, APPDATA, … */
  env: NodeJS.ProcessEnv;
  home: string;
  /** A regular file is there (a directory is not a program). */
  isFile: (p: string) => boolean;
  /** A text file's contents, or undefined when it cannot be read. */
  readText?: (p: string) => string | undefined;
}

/** Paths spelled for the platform in question, whichever one runs this. */
export const pathsFor = (platform: NodeJS.Platform): typeof posix => (platform === "win32" ? win32 : posix);

/** An environment variable, by name, ignoring case on Windows (`Path`, `ComSpec`). */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** A PATH-style list split into its directories (quotes Windows allows stripped). */
export function splitPathList(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** Directories in order, each once — case-insensitively on Windows. Relative
 *  entries are dropped: a GUI app's working directory is not a place anyone
 *  put a program, and searching it is how a planted binary gets run. */
export function uniqueDirs(dirs: readonly string[], platform: NodeJS.Platform): string[] {
  const p = pathsFor(platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || !p.isAbsolute(d)) continue;
    const key = platform === "win32" ? p.normalize(d).replace(/\\+$/, "").toLowerCase() : p.normalize(d).replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Where installers put command-line programs, beyond PATH — the directories a
 * terminal's PATH has and a GUI app's does not. Generic package-manager and
 * per-user bin folders only: what a CLI is called is the caller's business.
 */
export function wellKnownBinDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const p = pathsFor(platform);
  if (platform === "win32") {
    const get = (n: string) => envValue(env, n, platform);
    const profile = get("USERPROFILE") || home;
    const roaming = get("APPDATA") || (profile ? p.join(profile, "AppData", "Roaming") : undefined);
    const local = get("LOCALAPPDATA") || (profile ? p.join(profile, "AppData", "Local") : undefined);
    const programFiles = get("ProgramFiles");
    return [
      profile && p.join(profile, ".local", "bin"), // Claude Code's native installer
      roaming && p.join(roaming, "npm"), // npm's global bin
      local && p.join(local, "pnpm"),
      profile && p.join(profile, ".bun", "bin"),
      local && p.join(local, "Volta", "bin"),
      profile && p.join(profile, "scoop", "shims"),
      get("NVM_SYMLINK"), // nvm-windows' current Node
      programFiles && p.join(programFiles, "nodejs"),
    ].filter((d): d is string => !!d);
  }
  const shared = [
    p.join(home, ".local", "bin"),
    p.join(home, ".claude", "local"), // Claude Code's older per-user install
    "/opt/homebrew/bin",
    "/usr/local/bin",
    p.join(home, ".npm-global", "bin"),
    p.join(home, ".bun", "bin"),
    p.join(home, ".volta", "bin"),
    p.join(home, ".yarn", "bin"),
  ];
  if (platform === "darwin") {
    return [...shared, p.join(home, "Library", "pnpm"), "/opt/local/bin", "/usr/bin", "/bin"];
  }
  return [...shared, p.join(home, ".local", "share", "pnpm"), "/home/linuxbrew/.linuxbrew/bin", "/snap/bin", "/usr/bin", "/bin"];
}

/** The only extensions Windows itself runs as a program from PATH that are
 *  worth starting. `.js`/`.vbs` from PATHEXT would open in Windows Script Host. */
const WIN_RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const listed = (envValue(env, "PATHEXT", "win32") ?? "")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => WIN_RUNNABLE.includes(e));
  return listed.length > 0 ? [...new Set(listed)] : WIN_RUNNABLE;
}

/** True when `name` names a place (`./x`, `/usr/bin/x`, `C:\x`), not a bare command. */
export function hasDirectory(name: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /[\\/]/.test(name) : name.includes("/");
}

/** `~/bin/x` → `<home>/bin/x`; anything else unchanged. */
export function expandHome(name: string, home: string, platform: NodeJS.Platform): string {
  const p = pathsFor(platform);
  if (name === "~") return home;
  if (/^~[\\/]/.test(name)) return p.join(home, name.slice(2));
  return name;
}

/**
 * The file `name` runs: itself when it is a path, else the first match in
 * `dirs` — on Windows trying PATHEXT's runnable extensions per directory, the
 * order Windows uses, and never an extensionless file (npm puts a POSIX shell
 * script beside each `.cmd`; it is not runnable here).
 */
export function findExecutable(name: string, dirs: readonly string[], m: LaunchMachine): string | undefined {
  const p = pathsFor(m.platform);
  const win = m.platform === "win32";
  const candidates = (base: string): string[] => {
    if (!win) return [base];
    if (WIN_RUNNABLE.includes(p.extname(base).toLowerCase())) return [base];
    return windowsExtensions(m.env).map((e) => base + e);
  };
  if (hasDirectory(name, m.platform)) {
    const full = expandHome(name, m.home, m.platform);
    // A relative path means nothing to an app whose working directory is "/".
    if (!p.isAbsolute(full)) return undefined;
    return candidates(full).find((c) => m.isFile(c));
  }
  for (const dir of uniqueDirs(dirs, m.platform)) {
    for (const c of candidates(p.join(dir, name))) {
      if (m.isFile(c)) return c;
    }
  }
  return undefined;
}

/** What a Windows `.cmd` launcher really starts. */
export interface CmdShimTarget {
  /** A JavaScript entry point the launcher runs under Node. */
  script?: string;
  /** An executable the launcher runs directly. */
  exe?: string;
  /** Another launcher it hands over to — Yarn v1's global bin points at the
   *  `.cmd` in its own `node_modules\.bin`. */
  cmd?: string;
}

/**
 * Read the launcher npm, pnpm and Yarn write for a package's bin
 * (`cmd-shim`). Every generation of it names its target as a quoted path off
 * the launcher's own folder — `"%dp0%\node_modules\pkg\cli.js"` (npm 7+),
 * `"%~dp0\..\pkg\cli.js"` (pnpm, older npm) — and runs it either under Node
 * (`node.exe` beside it, else `node` on PATH) or, for a native bin, as is.
 * Yarn v1's global launcher names another launcher (`…\.bin\x.cmd`), which
 * planFor then reads in turn.
 * Undefined for anything else: a hand-written batch file, a bash shim.
 */
export function parseCmdShim(text: string, shimPath: string): CmdShimTarget | undefined {
  const dir = win32.dirname(shimPath);
  const quoted = [...text.matchAll(/"(?:%dp0%|%~dp0)([^"]*)"/gi)].map((m) => m[1]);
  // The candidate Node runtimes are named the same way; they are not targets.
  const targets = quoted.filter((rest) => !/(?:^|[\\/])node(?:\.exe)?$/i.test(rest));
  const last = targets.at(-1);
  if (last === undefined || last.trim() === "") return undefined;
  const target = win32.normalize(win32.join(dir, last));
  const ext = win32.extname(target).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { exe: target };
  if (ext === ".cmd" || ext === ".bat") return { cmd: target };
  // Runs under Node if the launcher names it: `node`, `"%dp0%\node.exe"`,
  // `%~dp0node.exe` — but not `node_modules` or `ELECTRON_RUN_AS_NODE`.
  const underNode = /(?:^|[^a-z_])node(?:\.exe)?\b/i.test(text) && /\.(?:js|cjs|mjs)$|^[^.]*$/i.test(win32.basename(target));
  return underNode ? { script: target } : undefined;
}

// ── cmd.exe, when nothing better will do ─────────────────────────────────────
//
// The rules cross-spawn uses (and has been hardened over years of reports):
// every cmd.exe metacharacter is caret-escaped, the arguments are quoted the
// way MSVCRT unquotes them, and the line goes through `cmd /d /s /c "…"` with
// Node's own quoting switched off so it arrives exactly as built.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** The program part of a cmd.exe line. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/** One argument of a cmd.exe line. `doubleEscape` for npm's `.bin` launchers,
 *  which hand their arguments through a second cmd.exe parse. */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(CMD_META, "^$1");
  return doubleEscape ? a.replace(CMD_META, "^$1") : a;
}

/** Run a `.cmd`/`.bat` through cmd.exe without letting any argument become
 *  syntax. Undefined when an argument cannot be carried safely: cmd.exe ends
 *  its line at a newline, so a prompt with one would be cut short — or worse,
 *  run as a second command; and a launcher re-parses its `%*`, so a `"` inside
 *  an argument would close the quoting this line built and leave `& | < >`
 *  after it live. Windows paths never contain one; user text never comes here
 *  (prompts go on stdin). */
export function viaCmd(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; verbatim: true } | undefined {
  if (args.some((a) => /[\r\n\0"]/.test(a))) return undefined;
  const comspec = envValue(env, "ComSpec", "win32") || "cmd.exe";
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [escapeCmdCommand(win32.normalize(file)), ...args.map((a) => escapeCmdArgument(a, double))].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

// ── the plan ─────────────────────────────────────────────────────────────────

export type LaunchPlan =
  /** Start `file` with `args`. `verbatim` = Windows: pass the line as built. */
  | { kind: "run"; file: string; args: string[]; verbatim?: boolean; found: string }
  /** Nothing by that name anywhere a terminal would look. */
  | { kind: "missing" }
  /** Found a launcher whose program runs on Node.js, and no Node.js. */
  | { kind: "needs-node"; found: string }
  /** Found it, and it cannot be started without mangling its arguments. */
  | { kind: "unrunnable"; found: string };

/** How to start `name` with `args`, searching `dirs`. */
export function planLaunch(name: string, args: readonly string[], dirs: readonly string[], m: LaunchMachine): LaunchPlan {
  const found = findExecutable(name, dirs, m);
  return found ? planFor(found, args, dirs, m) : { kind: "missing" };
}

/** How many launchers deep a launcher chain is followed (Yarn's is two). */
const MAX_SHIM_DEPTH = 4;

/** How to start a program already found at `found`. */
export function planFor(found: string, args: readonly string[], dirs: readonly string[], m: LaunchMachine): LaunchPlan {
  return planShim(found, found, args, dirs, m, 0);
}

function planShim(
  found: string,
  launcher: string,
  args: readonly string[],
  dirs: readonly string[],
  m: LaunchMachine,
  depth: number,
): LaunchPlan {
  if (m.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(launcher)) {
    return { kind: "run", file: launcher, args: [...args], found };
  }
  const text = m.readText?.(launcher);
  const shim = text === undefined ? undefined : parseCmdShim(text, launcher);
  if (shim?.cmd) {
    if (!m.isFile(shim.cmd)) return { kind: "missing" };
    if (depth < MAX_SHIM_DEPTH) return planShim(found, shim.cmd, args, dirs, m, depth + 1);
  }
  if (shim?.exe) {
    // A launcher left behind by a package that has since been removed.
    if (!m.isFile(shim.exe)) return { kind: "missing" };
    return { kind: "run", file: shim.exe, args: [...args], found };
  }
  if (shim?.script) {
    if (!m.isFile(shim.script)) return { kind: "missing" };
    // node.exe beside the launcher first (the launcher's own rule), then any
    // node.EXE — a `node.cmd` would bring back the very problem this solves.
    const beside = win32.join(win32.dirname(launcher), "node.exe");
    const node = m.isFile(beside) ? beside : findExecutable("node.exe", dirs, m);
    if (!node) return { kind: "needs-node", found };
    return { kind: "run", file: node, args: [shim.script, ...args], found };
  }
  const cmd = viaCmd(launcher, args, m.env);
  return cmd ? { kind: "run", ...cmd, found } : { kind: "unrunnable", found };
}

/**
 * The environment to start a found program in: the caller's, with the
 * program's own folder first on PATH and `more` after it — so a script whose
 * first line is `#!/usr/bin/env node` finds the Node it was installed with,
 * and what the program itself runs (git, a language server) is found the way
 * it would be from a terminal. On Windows the existing `Path` key is reused:
 * a second key differing only in case is undefined behaviour.
 */
export function launchEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  front: readonly string[],
  more: readonly string[] = [],
): NodeJS.ProcessEnv {
  const key = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const dirs = uniqueDirs([...front, ...splitPathList(env[key], platform), ...more], platform);
  return { ...env, [key]: dirs.join(platform === "win32" ? ";" : ":") };
}

/** Where to look on `m`: its PATH, the installers' folders, then `extra`
 *  (what the host learned from a login shell or the registry). */
export function searchDirs(m: LaunchMachine, extra: readonly string[] = []): string[] {
  return uniqueDirs(
    [...splitPathList(envValue(m.env, "PATH", m.platform), m.platform), ...wellKnownBinDirs(m.platform, m.env, m.home), ...extra],
    m.platform,
  );
}

/** Everything `spawn` needs to start a found program. */
export interface PreparedLaunch {
  file: string;
  args: string[];
  /** Where the program was found (for messages). */
  found: string;
  env: NodeJS.ProcessEnv;
  /** Windows: the cmd.exe line is pre-quoted; pass it as is, without a console. */
  verbatim?: boolean;
}

/** `planLaunch` over `searchDirs`, with the environment to start it in. */
export function prepareOn(
  name: string,
  args: readonly string[],
  m: LaunchMachine,
  extra: readonly string[] = [],
): { ok: true; launch: PreparedLaunch } | { ok: false; plan: Exclude<LaunchPlan, { kind: "run" }> } {
  const dirs = searchDirs(m, extra);
  const plan = planLaunch(name, args, dirs, m);
  if (plan.kind !== "run") return { ok: false, plan };
  return {
    ok: true,
    launch: {
      file: plan.file,
      args: plan.args,
      found: plan.found,
      env: launchEnv(m.env, m.platform, [pathsFor(m.platform).dirname(plan.found)], dirs),
      ...(plan.verbatim ? { verbatim: true } : {}),
    },
  };
}

/**
 * Spawn options for a prepared CLI launch (cwd and stdio are the caller's).
 * `windowsHide` always: these are console programs, and without it Windows
 * gives each one a console window of its own — which flashes, or stays open
 * for a warm session, where closing it kills the session.
 */
export function spawnOptionsFor(l: PreparedLaunch): { env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean; windowsHide: true } {
  return l.verbatim ? { env: l.env, windowsVerbatimArguments: true, windowsHide: true } : { env: l.env, windowsHide: true };
}

// ── what the host reads back from the shell or the registry ──────────────────

/** The text between two copies of `mark` (rc-file chatter around it ignored). */
export function betweenMarks(output: string, mark: string): string | undefined {
  const i = output.indexOf(mark);
  const j = output.lastIndexOf(mark);
  if (i < 0 || j <= i) return undefined;
  const v = output.slice(i + mark.length, j).trim();
  return v || undefined;
}

/** The `Path` value out of `reg query <key> /v Path`. */
export function regQueryPath(output: string): string | undefined {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output);
  return m?.[1] || undefined;
}

/** `%USERPROFILE%\.local\bin` → the variable's value; an unknown one stays. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name, "win32") ?? whole);
}
