// "Open in <editor>": every editor installed on this machine, detected, and
// the repository root handed to the one you pick.
//
// Detection is deliberately generous about WHERE it looks. An Electron app
// launched from the Dock or Finder inherits a minimal PATH (no ~/.zshrc, no
// Homebrew), so "is `code` on PATH?" answers no on most Macs where VS Code is
// plainly installed. Each editor is therefore found three ways — its app
// bundle in /Applications or ~/Applications, its CLI in the handful of directories those CLIs actually live in, and, on
// Windows, its known install path — and opened by whichever was found: `open
// -a <bundle>` on macOS needs no CLI at all.
//
// The pure parts (catalog, detection against an injected filesystem, the
// command for a pick, how a custom command resolves) are exported and
// unit-tested; `openEditor` takes the OS as a parameter (`EditorLaunchDeps`)
// so what it does when an editor is gone, moved or won't start is tested too.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { app, nativeImage, shell } from "electron";
import * as l10n from "@vscode/l10n";
import { expandHome, hasDirectory, viaCmd } from "@gitstudio/git-service/commandLaunch";
import type { EditorView, OkResult } from "../shared/ipc";
import { programFinder } from "./launcher";
import { missingFolderMessage } from "./repoNotice";

export interface EditorSpec {
  id: string;
  name: string;
  /** macOS app bundle names, in order of preference (without ".app"). */
  apps: string[];
  /** CLI executable names (macOS/Linux; ".cmd" is tried on Windows too). */
  cli: string[];
  /** Windows install paths, relative to %LOCALAPPDATA% ("local:") or
   *  %ProgramFiles% ("pf:"). */
  win: string[];
}

/** Every editor GitStudio knows how to find. Order is the order the Open-in
 *  menu lists them in when nothing else decides. */
export const EDITOR_CATALOG: readonly EditorSpec[] = [
  { id: "vscode", name: "VSCode", apps: ["Visual Studio Code"], cli: ["code"], win: ["local:Programs/Microsoft VS Code/Code.exe", "pf:Microsoft VS Code/Code.exe"] },
  { id: "vscode-insiders", name: "VSCode Insiders", apps: ["Visual Studio Code - Insiders"], cli: ["code-insiders"], win: ["local:Programs/Microsoft VS Code Insiders/Code - Insiders.exe"] },
  { id: "cursor", name: "Cursor", apps: ["Cursor"], cli: ["cursor"], win: ["local:Programs/cursor/Cursor.exe"] },
  { id: "windsurf", name: "Windsurf", apps: ["Windsurf"], cli: ["windsurf"], win: ["local:Programs/Windsurf/Windsurf.exe"] },
  { id: "zed", name: "Zed", apps: ["Zed"], cli: ["zed"], win: ["local:Programs/Zed/Zed.exe"] },
  { id: "sublime", name: "Sublime Text", apps: ["Sublime Text"], cli: ["subl"], win: ["pf:Sublime Text/sublime_text.exe"] },
  { id: "android-studio", name: "Android Studio", apps: ["Android Studio"], cli: ["studio"], win: ["pf:Android/Android Studio/bin/studio64.exe"] },
  { id: "nova", name: "Nova", apps: ["Nova"], cli: ["nova"], win: [] },
  { id: "textmate", name: "TextMate", apps: ["TextMate"], cli: ["mate"], win: [] },
  { id: "bbedit", name: "BBEdit", apps: ["BBEdit"], cli: ["bbedit"], win: [] },
];

/** A user-added editor: any executable that takes a folder, or a command
 *  template with `{path}` in it. */
export interface CustomEditor {
  id: string;
  name: string;
  command: string;
}

/** What a detection found for one catalog entry. */
export interface DetectedEditor {
  id: string;
  name: string;
  via: "app" | "cli" | "path";
  /** The bundle / executable that will be launched. */
  location: string;
}

export interface DetectEnv {
  platform: NodeJS.Platform;
  home: string;
  /** PATH as the process sees it (usually minimal in a GUI app). */
  path: string;
  /** Windows only. */
  localAppData?: string;
  programFiles?: string;
  exists: (p: string) => boolean;
}

/**
 * Join for the platform being DETECTED, not the one we happen to run on.
 *
 * `DetectEnv.platform` is a parameter — the tests drive every branch from any
 * host — but the paths were assembled with node:path's host-native `join`, so
 * asking about darwin from Windows produced `\Users\dev\Applications` and
 * matched nothing. In production the two always agree, which is why this never
 * showed until the suite first ran on a Windows runner.
 */
function joiner(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === "win32" ? win32.join : posix.join;
}

/** And the PATH separator belongs to that platform too. */
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** Directories a CLI can live in beyond the (minimal) PATH of a GUI app. */
function cliDirs(env: DetectEnv): string[] {
  const j = joiner(env.platform);
  const fromPath = env.path ? env.path.split(pathDelimiter(env.platform)).filter(Boolean) : [];
  if (env.platform === "win32") return fromPath;
  return [
    ...fromPath,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/snap/bin",
    j(env.home, ".local", "bin"),
  ];
}

/** Where a macOS app bundle can be. */
function appDirs(env: DetectEnv): string[] {
  const j = joiner(env.platform);
  return ["/Applications", j(env.home, "Applications")];
}

/** Find one editor. App bundle first (needs no CLI), then a CLI — on
 *  Windows, its installed .exe before any CLI. */
export function detectEditor(spec: EditorSpec, env: DetectEnv): DetectedEditor | undefined {
  const j = joiner(env.platform);
  if (env.platform === "darwin") {
    for (const dir of appDirs(env)) {
      for (const app of spec.apps) {
        const p = j(dir, `${app}.app`);
        if (env.exists(p)) return { id: spec.id, name: spec.name, via: "app", location: p };
      }
    }
  }
  if (env.platform === "win32") {
    // The installed .exe opens a folder by itself. What PATH holds is usually
    // the editor's `bin\code.cmd` launcher, which only cmd.exe can run — so
    // it comes second, not first.
    for (const w of spec.win) {
      const [kind, rel] = w.split(/:(.+)/);
      const base = kind === "local" ? env.localAppData : env.programFiles;
      if (!base) continue;
      const p = j(base, rel);
      if (env.exists(p)) return { id: spec.id, name: spec.name, via: "path", location: p };
    }
  }
  // Never an extensionless file on Windows: beside each `code.cmd` sits a
  // `code` POSIX shell script for Git Bash and WSL, which Windows cannot run.
  const exts = env.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of cliDirs(env)) {
    for (const cli of spec.cli) {
      for (const ext of exts) {
        const p = j(dir, cli + ext);
        if (env.exists(p)) return { id: spec.id, name: spec.name, via: "cli", location: p };
      }
    }
  }
  return undefined;
}

export function detectEditors(env: DetectEnv): DetectedEditor[] {
  const out: DetectedEditor[] = [];
  for (const spec of EDITOR_CATALOG) {
    const hit = detectEditor(spec, env);
    if (hit) out.push(hit);
  }
  return out;
}

/** macOS's `open`, by its full path: nothing about it depends on PATH. */
export const OPEN = "/usr/bin/open";

/** A command to start: `verbatim` = Windows, a cmd.exe line already quoted. */
export interface EditorCommand {
  cmd: string;
  args: string[];
  verbatim?: boolean;
}

/** The command that opens `root` in a detected editor. Pure, so the
 *  platform split is pinned by tests rather than by trying it on three OSes. */
export function commandFor(
  target: Pick<DetectedEditor, "via" | "location">,
  root: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): EditorCommand {
  if (platform === "darwin" && target.via === "app") {
    // `open -a <bundle>` launches (or foregrounds) the app with the folder —
    // no CLI needed, and the app handles it the way its own File ▸ Open would.
    return { cmd: OPEN, args: ["-a", target.location, root] };
  }
  if (platform === "win32" && /\.(cmd|bat)$/i.test(target.location)) {
    // A launcher needs cmd.exe. `shell: true` used to run it, and Node then
    // joins the arguments with plain spaces: a folder under "C:\Users\Jane
    // Doe" arrived as two arguments, and one with `&` in its name ran the
    // rest as a command. viaCmd quotes and escapes every argument.
    const line = viaCmd(target.location, [root], env);
    if (line) return { cmd: line.file, args: line.args, verbatim: true };
  }
  return { cmd: target.location, args: [root] };
}

/** One word of a custom command, and whether it was written in quotes. */
interface Word {
  text: string;
  quoted: boolean;
}

function words(command: string): Word[] {
  // Read the way a shell reads quotes: a quoted run may sit INSIDE a word
  // (`--title="My Repo"` is one argument, `--title=My Repo`), and the quotes
  // themselves are never part of it. Splitting `--title="My` from `Repo"`
  // left a quote in an argument, which no cmd.exe line can carry safely.
  return (command.match(/(?:"[^"]*"|[^\s"]+|")+/g) ?? []).map((s) => ({ text: s.replace(/"/g, ""), quoted: s.includes('"') }));
}

/** `{path}` substituted where it is written, else the folder appended. */
function withFolder(parts: string[], root: string): string[] {
  // A replacer FUNCTION: as a replacement string, `$&`, `$'` and `$1` in a
  // folder's name would be read as patterns and the folder arrive rewritten.
  return parts.some((p) => p.includes("{path}")) ? parts.map((p) => p.replace(/\{path\}/g, () => root)) : [...parts, root];
}

/** A custom command: `{path}` substitution when present, else the folder as
 *  the single argument. Split on whitespace outside double quotes. */
export function customCommandFor(command: string, root: string): { cmd: string; args: string[] } {
  const parts = words(command).map((w) => w.text);
  if (parts.length === 0) return { cmd: command, args: [root] };
  const sub = withFolder(parts, root);
  return { cmd: sub[0], args: sub.slice(1) };
}

/** What a custom command resolves to on this machine. */
export type CustomPlan =
  | (EditorCommand & { kind: "run"; program: string })
  /** `bare`: a command NAME, which a PATH might still find; a path is final. */
  | { kind: "missing"; program: string; bare: boolean };

export interface CustomMachine {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** A file or a folder is there. */
  exists: (p: string) => boolean;
  isDir: (p: string) => boolean;
  /** A program name or path → the file it runs, the way a terminal finds it. */
  find: (name: string) => string | undefined;
}

/**
 * How a custom editor's command starts here — the program it names FOUND,
 * not handed to spawn as typed. As typed, two of the commonest entries failed
 * (crash reports "Editors open"):
 *
 *   · a bare name (`hx`, which the form itself suggests) was looked up on the
 *     GUI app's PATH, which on macOS has nothing a user installed — so it is
 *     found the way a terminal would (launcher.ts);
 *   · a path with spaces in it, unquoted (`/Applications/Sublime Text.app/
 *     Contents/SharedSupport/bin/subl`), split at the first space and spawned
 *     `/Applications/Sublime` — so the longest leading run of words that IS a
 *     path on disk is the program.
 *
 * On macOS an `.app` bundle (by path, or by the name it has in /Applications)
 * opens through `open -a`, and on Windows a `.cmd`/`.bat` through a quoted
 * cmd.exe line. Pure: the machine is a parameter.
 */
export function planCustom(command: string, root: string, m: CustomMachine): CustomPlan {
  const ws = words(command);
  if (ws.length === 0) return { kind: "missing", program: command, bare: false };
  const p = joiner(m.platform);
  const looksLikePath = (t: string) => hasDirectory(t, m.platform) || t.startsWith("~");
  const run = (program: string, rest: string[]): CustomPlan => {
    if (m.platform === "darwin" && /\.app\/?$/i.test(program) && m.isDir(program)) {
      // `open -a <app> <files>`: what the app itself is to be given goes after
      // `--args`, or `open` reads `--wait` as one of its own options and
      // refuses. The folder is the file to open, wherever `{path}` was written
      // on its own; written inside a word (`--dir={path}`) it is an argument.
      const files = rest.some((t) => t.includes("{path}")) && !rest.includes("{path}") ? [] : [root];
      const own = rest.filter((t) => t !== "{path}").map((t) => t.replace(/\{path\}/g, () => root));
      return { kind: "run", program, cmd: OPEN, args: ["-a", program, ...files, ...(own.length ? ["--args", ...own] : [])] };
    }
    const args = withFolder(rest, root);
    if (m.platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
      const line = viaCmd(program, args, m.env);
      if (line) return { kind: "run", program, cmd: line.file, args: line.args, verbatim: true };
    }
    return { kind: "run", program, cmd: program, args };
  };
  // The longest unquoted leading run of words that names something on disk.
  if (!ws[0].quoted && looksLikePath(ws[0].text)) {
    for (let k = ws.length; k >= 1; k--) {
      if (ws.slice(1, k).some((w) => w.quoted)) continue;
      const joined = expandHome(ws.slice(0, k).map((w) => w.text).join(" "), m.home, m.platform);
      const bundle = m.platform === "darwin" && /\.app\/?$/i.test(joined) && m.isDir(joined);
      const file = bundle ? joined : m.find(joined);
      if (file) return run(file, ws.slice(k).map((w) => w.text));
    }
    return { kind: "missing", program: ws[0].text, bare: false };
  }
  const first = ws[0].text;
  const rest = ws.slice(1).map((w) => w.text);
  if (ws[0].quoted && looksLikePath(first)) {
    const full = expandHome(first, m.home, m.platform);
    if (m.platform === "darwin" && /\.app\/?$/i.test(full) && m.isDir(full)) return run(full, rest);
    const file = m.find(full);
    return file ? run(file, rest) : { kind: "missing", program: first, bare: false };
  }
  // A bare name. Case is tried as typed, then lower-cased: commands are
  // lower-case by convention, and on a case-sensitive volume `IDEA` is not `idea`.
  const found = m.find(first) ?? (first !== first.toLowerCase() ? m.find(first.toLowerCase()) : undefined);
  if (found) return run(found, rest);
  if (m.platform === "darwin") {
    // An application's own name — "Sublime Text", "Nova" — typed as the command.
    for (let k = ws.length; k >= 1; k--) {
      if (ws.slice(1, k).some((w) => w.quoted)) continue;
      const name = ws.slice(0, k).map((w) => w.text).join(" ").replace(/\.app$/i, "");
      for (const dir of ["/Applications", p(m.home, "Applications")]) {
        const bundle = p(dir, `${name}.app`);
        if (m.isDir(bundle)) return run(bundle, ws.slice(k).map((w) => w.text));
      }
    }
  }
  return { kind: "missing", program: first, bare: true };
}

// ── The OS-touching half ────────────────────────────────────────────────────

export function realDetectEnv(): DetectEnv {
  return {
    platform: process.platform,
    home: homedir(),
    path: process.env.PATH ?? "",
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  };
}

export interface EditorPrefs {
  hidden: string[];
  defaultId?: string;
  custom: CustomEditor[];
}

/** Detection is a few hundred stat() calls — cached, and refreshed on request
 *  (Settings has a "Look again") or after an install is unlikely mid-session. */
let cached: { at: number; list: DetectedEditor[] } | undefined;
const DETECT_TTL_MS = 5 * 60_000;

export function listDetected(force = false): DetectedEditor[] {
  if (!force && cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.list;
  cached = { at: Date.now(), list: detectEditors(realDetectEnv()) };
  return cached.list;
}

/** The renderer's picture: detected + custom, with the user's choices applied. */
export function editorsView(prefs: EditorPrefs, force = false): { editors: EditorView[]; defaultId?: string } {
  const detected = listDetected(force);
  const all: EditorView[] = [
    ...detected.map((d) => ({
      id: d.id,
      name: d.name,
      via: d.via,
      shown: !prefs.hidden.includes(d.id),
      isDefault: false,
      location: d.location,
    })),
    ...prefs.custom.map((c) => ({
      id: c.id,
      name: c.name,
      via: "custom" as const,
      shown: !prefs.hidden.includes(c.id),
      isDefault: false,
      location: c.command,
    })),
  ];
  // The default is the chosen one when it is still around and shown; else the
  // first shown editor, so a fresh install has a working primary button.
  const shown = all.filter((e) => e.shown);
  const chosen = shown.find((e) => e.id === prefs.defaultId) ?? shown[0];
  if (chosen) chosen.isDefault = true;
  return { editors: all, defaultId: chosen?.id };
}

/**
 * The OS's own icon for an editor.
 *
 * `app.getFileIcon` asks the platform for the icon it already shows in Finder,
 * Explorer or the file manager — so the list shows the real VS Code, Cursor and
 * Zed marks without this app shipping (or approximating) anybody's logo.
 * Cached by path: an installed application's icon does not change while we run.
 */
const iconCache = new Map<string, string | undefined>();
const run = promisify(execFile);

/**
 * Pull an embedded PNG out of a macOS `.icns`.
 *
 * `nativeImage.createFromPath` cannot decode icns — it answers with an empty
 * image — and `app.getFileIcon` hands back ONE generic application placeholder
 * for every `.app` on disk, which is how six different editors ended up wearing
 * the same grey square. The container itself is simple: an 8-byte header, then
 * `type(4) length(4) data` chunks whose modern icon types carry PNG bytes
 * verbatim. So read it directly — no converter, no shell, no dependency.
 *
 * Preference order is by RENDERED SIZE, smallest that still covers a retina
 * 20px slot first: shipping a 512px icon over IPC for a 16px menu row is a
 * megabyte of base64 nobody sees.
 */
const ICNS_PREFER = ["ic12", "icp6", "ic11", "ic07", "icp5", "ic08", "ic13", "ic09", "ic14", "ic10"];

export function pngFromIcns(file: string): Buffer | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return undefined;
  }
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "icns") return undefined;
  const found = new Map<string, Buffer>();
  let i = 8;
  while (i + 8 <= buf.length) {
    const type = buf.toString("ascii", i, i + 4);
    const len = buf.readUInt32BE(i + 4);
    if (len < 8 || i + len > buf.length) break;
    const data = buf.subarray(i + 8, i + len);
    // 0x89504E47 is the PNG magic; the older ARGB and JPEG-2000 reps are
    // skipped by this test rather than mis-served as PNG.
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) found.set(type, data);
    i += len;
  }
  return ICNS_PREFER.map((t) => found.get(t)).find(Boolean) ?? [...found.values()][0];
}

/** 64px, which is a retina 32 — the biggest slot any of these icons fills.
 *  Zed's icns carries only 512px and 1024px reps, so shipping the rep verbatim
 *  meant a 218KB data URL for a 16px menu row. */
function shrink(img: Electron.NativeImage): string | undefined {
  if (img.isEmpty()) return undefined;
  return img.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
}

/** Some bundles ship no PNG rep at all — Windsurf's icns is legacy `it32` plus
 *  JPEG-2000, which neither this reader nor nativeImage can decode. `sips` is
 *  part of macOS and reads every rep, so it is the fallback rather than a
 *  missing icon. */
async function icnsViaSips(icns: string): Promise<string | undefined> {
  const out = join(app.getPath("temp"), `gs-icon-${Date.now().toString(36)}.png`);
  try {
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", "128", icns, "--out", out]);
    const url = shrink(nativeImage.createFromPath(out));
    return url;
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(out);
    } catch {
      /* it was never written */
    }
  }
}

/** The icon a macOS application bundle declares in its own Info.plist. */
async function macBundleIcon(bundle: string): Promise<string | undefined> {
  let name: string;
  try {
    const { stdout } = await run("/usr/bin/plutil", [
      "-extract",
      "CFBundleIconFile",
      "raw",
      "-o",
      "-",
      join(bundle, "Contents", "Info.plist"),
    ]);
    name = stdout.trim();
  } catch {
    return undefined;
  }
  if (!name) return undefined;
  // Several bundles ship a dozen document-type icns beside the app's own, and
  // some of those are LARGER, so the name is read rather than guessed.
  const file = name.toLowerCase().endsWith(".icns") ? name : `${name}.icns`;
  const icns = join(bundle, "Contents", "Resources", file);
  const png = pngFromIcns(icns);
  // nativeImage decodes a PNG buffer happily; it is only icns it cannot read.
  if (png) return shrink(nativeImage.createFromBuffer(png));
  return icnsViaSips(icns);
}

async function iconFor(location: string): Promise<string | undefined> {
  if (iconCache.has(location)) return iconCache.get(location);
  let url: string | undefined;
  if (process.platform === "darwin" && location.endsWith(".app")) {
    url = await macBundleIcon(location);
  }
  if (!url) {
    try {
      // Windows and Linux answer this properly; on macOS it is the last resort.
      const img = await app.getFileIcon(location, { size: "normal" });
      url = img.isEmpty() ? undefined : img.toDataURL();
    } catch {
      url = undefined; // a CLI shim, a path that just vanished — the glyph stands in
    }
  }
  iconCache.set(location, url);
  return url;
}

/** Decorate a view with each editor's real icon. Kept out of `editorsView` so
 *  that stays pure and unit-testable. */
export async function withIcons(view: {
  editors: EditorView[];
  defaultId?: string;
}): Promise<{ editors: EditorView[]; defaultId?: string }> {
  await Promise.all(
    view.editors.map(async (e) => {
      // A custom entry is a command line, not an application bundle: there is
      // no icon to ask for, and asking would answer with a generic terminal.
      if (e.via === "custom" || !e.location) return;
      e.icon = await iconFor(e.location);
    }),
  );
  return view;
}

/** The OS, as openEditor uses it — a parameter, so every branch is testable. */
export interface EditorLaunchDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** A file or a folder is there. */
  exists: (p: string) => boolean;
  isDir: (p: string) => boolean;
  /** The detected editors; `force` looks again rather than using the cache. */
  detected: (force: boolean) => DetectedEditor[];
  /** A program lookup (launcher.ts); `fresh` adds the login shell's PATH. */
  finder: (fresh: boolean) => Promise<(name: string) => string | undefined>;
  /** Start a program and let it go: resolves once it has started, or failed to. */
  start: (cmd: string, args: string[], verbatim: boolean) => Promise<{ ok: true } | { ok: false; code?: string; message: string }>;
  /** Run `/usr/bin/open`, waiting briefly for its answer (`code` null: still
   *  running when the wait ended, i.e. it launched something). */
  open: (args: string[]) => Promise<{ code: number | null; stderr: string }>;
}

/** What the user did not set up, and we cannot start: never ours to report. */
const USER_PROGRAM_FAILURES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EISDIR", "ENOTDIR", "UNKNOWN"]);

/**
 * Why a start failed, for a message that keeps reporting. Node's own
 * "spawn <path> EACCES" becomes its code: main.ts's IPC wrapper reads that
 * sentence as Git failing to start (repoNotice.ts) and would say so instead.
 * A refusal thrown before any process existed (a NUL in an argument) has no
 * such sentence, and says more as itself.
 */
function launchReason(failed: { code?: string; message: string }): string {
  return /^spawn\b/.test(failed.message) && failed.code ? failed.code : failed.message;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * Open `root` in the editor `id` (detected, or one the user added).
 *
 * What it does when the editor is not where it was is the point (crash
 * reports "Editors open": "Couldn't launch it: spawn <path> ENOENT"):
 *
 *   · the folder itself is gone → said as that, not as the editor's failure;
 *   · a detected editor's path is checked before it is used — detection is
 *     cached, and an app updated, moved or uninstalled since keeps its old
 *     path there — and looked for again when it is gone; on macOS, an app
 *     LaunchServices still knows by name (moved to a subfolder, Setapp, another
 *     volume) is opened that way;
 *   · a custom command is resolved (planCustom) instead of spawned as typed.
 *
 * What the user's machine or input decides — an editor uninstalled, a custom
 * program not found or not runnable — comes back `expected`, in words, and
 * stays out of the crash reporter. A detected editor that IS there and will
 * not start keeps reporting: that is the case worth hearing about.
 */
export async function openEditor(
  id: string,
  root: string,
  prefs: EditorPrefs,
  deps: EditorLaunchDeps = realEditorDeps(),
): Promise<OkResult> {
  if (!deps.exists(root)) return { ok: false, expected: true, message: missingFolderMessage(root) };
  const custom = prefs.custom.find((c) => c.id === id);
  return custom ? openCustom(custom, root, deps) : openDetected(id, root, deps);
}

/** `open -a <name> <root>` for each name the app goes by; true once one opens. */
async function openByName(names: readonly string[], root: string, deps: EditorLaunchDeps): Promise<boolean> {
  if (deps.platform !== "darwin") return false;
  for (const name of names) {
    const r = await deps.open(["-a", name, root]);
    if (r.code === 0 || r.code === null) return true;
  }
  return false;
}

async function openDetected(id: string, root: string, deps: EditorLaunchDeps): Promise<OkResult> {
  const spec = EDITOR_CATALOG.find((s) => s.id === id);
  let hit = deps.detected(false).find((d) => d.id === id);
  if (!hit || !deps.exists(hit.location)) hit = deps.detected(true).find((d) => d.id === id);
  // An editor that has been uninstalled since it was detected is a state of
  // the machine, not a defect — `expected` keeps it out of the crash reporter
  // (see main/expectedError.ts). A spawn that FAILS still reports: that is the
  // case where we did find the editor and could not start it.
  if (!hit) {
    if (spec && (await openByName(spec.apps, root, deps))) return { ok: true };
    return {
      ok: false,
      expected: true,
      message: l10n.t("That editor isn't installed any more — check Settings ▸ Editors."),
    };
  }
  const c = commandFor(hit, root, deps.platform, deps.env);
  if (c.cmd === OPEN) {
    const r = await deps.open(c.args);
    if (r.code === 0 || r.code === null) return { ok: true };
    return { ok: false, message: l10n.t("macOS couldn't open {0}: {1}", hit.name, firstLine(r.stderr) || String(r.code)) };
  }
  const started = await deps.start(c.cmd, c.args, !!c.verbatim);
  if (started.ok) return { ok: true };
  // The CLI is there and would not start (a launcher whose interpreter is
  // gone, …); the application it belongs to may still open by name.
  if (spec && (await openByName(spec.apps, root, deps))) return { ok: true };
  return { ok: false, message: l10n.t("Couldn't launch it: {0}", launchReason(started)) };
}

async function openCustom(custom: CustomEditor, root: string, deps: EditorLaunchDeps): Promise<OkResult> {
  const machine = (find: (name: string) => string | undefined): CustomMachine => ({
    platform: deps.platform,
    home: deps.home,
    env: deps.env,
    exists: deps.exists,
    isDir: deps.isDir,
    find,
  });
  let plan = planCustom(custom.command, root, machine(await deps.finder(false)));
  // Only then the login shell — asked once, and it costs a moment — and only
  // for a NAME: no PATH changes where a path points.
  if (plan.kind === "missing" && plan.bare) plan = planCustom(custom.command, root, machine(await deps.finder(true)));
  if (plan.kind === "missing") {
    return {
      ok: false,
      expected: true,
      message: l10n.t("Couldn't find {0}, the program {1} runs. Write its full path in Settings ▸ Editors.", plan.program, custom.name),
    };
  }
  if (plan.cmd === OPEN) {
    const r = await deps.open(plan.args);
    if (r.code === 0 || r.code === null) return { ok: true };
    return {
      ok: false,
      expected: true,
      message: l10n.t("macOS couldn't open {0}: {1}", custom.name, firstLine(r.stderr) || String(r.code)),
    };
  }
  const started = await deps.start(plan.cmd, plan.args, !!plan.verbatim);
  if (started.ok) return { ok: true };
  if (started.code && USER_PROGRAM_FAILURES.has(started.code)) {
    return {
      ok: false,
      expected: true,
      message: l10n.t("{0} couldn't start {1}. Check that it's a program this account can run.", custom.name, plan.program),
    };
  }
  return { ok: false, message: l10n.t("Couldn't launch it: {0}", launchReason(started)) };
}

const OPEN_WAIT_MS = 10_000;

/** Run `/usr/bin/open` and wait for its exit: it hands the launch to
 *  LaunchServices and returns at once, with a non-zero code and a sentence on
 *  stderr when the app cannot be found or opened. */
function runOpen(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stderr });
    };
    let child;
    try {
      child = spawn(OPEN, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.once("error", (e) => {
      stderr ||= e.message;
      finish(-1);
    });
    child.once("close", (code) => finish(code ?? -1));
    timer = setTimeout(() => {
      child.unref();
      finish(null);
    }, OPEN_WAIT_MS);
  });
}

/** Start a GUI program detached from this one. */
function startDetached(cmd: string, args: string[], verbatim: boolean): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        // Only for the cmd.exe line: hiding a GUI program's start-up window
        // can keep its first window hidden.
        ...(verbatim ? { windowsVerbatimArguments: true, windowsHide: true } : {}),
      });
      child.once("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code, message: e.message }));
      // `spawn` reports a missing executable asynchronously; give it a beat.
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve({ ok: false, code: typeof err?.code === "string" ? err.code : undefined, message: err instanceof Error ? err.message : String(e) });
    }
  });
}

export function realEditorDeps(): EditorLaunchDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    detected: (force) => listDetected(force),
    finder: (fresh) => programFinder(fresh),
    start: startDetached,
    open: runOpen,
  };
}

/** Finder / Explorer / the file manager, on the repository folder. */
export function revealRoot(root: string): void {
  shell.showItemInFolder(root);
}
