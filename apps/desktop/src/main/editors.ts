// "Open in <editor>": every editor installed on this machine, detected, and
// the repository root handed to the one you pick.
//
// Detection is deliberately generous about WHERE it looks. An Electron app
// launched from the Dock or Finder inherits a minimal PATH (no ~/.zshrc, no
// Homebrew), so "is `code` on PATH?" answers no on most Macs where VS Code is
// plainly installed. Each editor is therefore found three ways — its app
// bundle in /Applications or ~/Applications (also JetBrains Toolbox's folder),
// its CLI in the handful of directories those CLIs actually live in, and, on
// Windows, its known install path — and opened by whichever was found: `open
// -a <bundle>` on macOS needs no CLI at all.
//
// The pure parts (catalog, detection against an injected filesystem, the
// command for a pick) are exported and unit-tested; only `openEditor` and
// `revealRoot` touch the OS.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { app, nativeImage, shell } from "electron";
import type { EditorView } from "../shared/ipc";

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

const jb = (id: string, name: string, cli: string, more: string[] = []): EditorSpec => ({
  id,
  name,
  apps: [name, ...more],
  cli: [cli],
  win: [],
});

/** Every editor GitStudio knows how to find. Order is the order the Open-in
 *  menu lists them in when nothing else decides. */
export const EDITOR_CATALOG: readonly EditorSpec[] = [
  { id: "vscode", name: "VSCode", apps: ["Visual Studio Code"], cli: ["code"], win: ["local:Programs/Microsoft VS Code/Code.exe", "pf:Microsoft VS Code/Code.exe"] },
  { id: "vscode-insiders", name: "VSCode Insiders", apps: ["Visual Studio Code - Insiders"], cli: ["code-insiders"], win: ["local:Programs/Microsoft VS Code Insiders/Code - Insiders.exe"] },
  { id: "cursor", name: "Cursor", apps: ["Cursor"], cli: ["cursor"], win: ["local:Programs/cursor/Cursor.exe"] },
  { id: "windsurf", name: "Windsurf", apps: ["Windsurf"], cli: ["windsurf"], win: ["local:Programs/Windsurf/Windsurf.exe"] },
  { id: "zed", name: "Zed", apps: ["Zed"], cli: ["zed"], win: ["local:Programs/Zed/Zed.exe"] },
  { id: "sublime", name: "Sublime Text", apps: ["Sublime Text"], cli: ["subl"], win: ["pf:Sublime Text/sublime_text.exe"] },
  jb("webstorm", "WebStorm", "webstorm"),
  jb("intellij", "IntelliJ IDEA", "idea", ["IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"]),
  jb("pycharm", "PyCharm", "pycharm", ["PyCharm CE", "PyCharm Professional"]),
  jb("goland", "GoLand", "goland"),
  jb("phpstorm", "PhpStorm", "phpstorm"),
  jb("rider", "Rider", "rider"),
  jb("clion", "CLion", "clion"),
  jb("rubymine", "RubyMine", "rubymine"),
  jb("rustrover", "RustRover", "rustrover"),
  jb("fleet", "Fleet", "fleet"),
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

/** Directories a CLI can live in beyond the (minimal) PATH of a GUI app. */
function cliDirs(env: DetectEnv): string[] {
  const fromPath = env.path ? env.path.split(delimiter).filter(Boolean) : [];
  if (env.platform === "win32") {
    return [
      ...fromPath,
      ...(env.localAppData ? [join(env.localAppData, "JetBrains", "Toolbox", "scripts")] : []),
    ];
  }
  return [
    ...fromPath,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/snap/bin",
    join(env.home, ".local", "bin"),
    join(env.home, "Library", "Application Support", "JetBrains", "Toolbox", "scripts"),
    join(env.home, ".local", "share", "JetBrains", "Toolbox", "scripts"),
  ];
}

/** Where a macOS app bundle can be. */
function appDirs(env: DetectEnv): string[] {
  return [
    "/Applications",
    join(env.home, "Applications"),
    join(env.home, "Applications", "JetBrains Toolbox"),
  ];
}

/** Find one editor. App bundle first (needs no CLI), then a CLI, then a
 *  Windows install path. */
export function detectEditor(spec: EditorSpec, env: DetectEnv): DetectedEditor | undefined {
  if (env.platform === "darwin") {
    for (const dir of appDirs(env)) {
      for (const app of spec.apps) {
        const p = join(dir, `${app}.app`);
        if (env.exists(p)) return { id: spec.id, name: spec.name, via: "app", location: p };
      }
    }
  }
  const exts = env.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of cliDirs(env)) {
    for (const cli of spec.cli) {
      for (const ext of exts) {
        const p = join(dir, cli + ext);
        if (env.exists(p)) return { id: spec.id, name: spec.name, via: "cli", location: p };
      }
    }
  }
  if (env.platform === "win32") {
    for (const w of spec.win) {
      const [kind, rel] = w.split(/:(.+)/);
      const base = kind === "local" ? env.localAppData : env.programFiles;
      if (!base) continue;
      const p = join(base, rel);
      if (env.exists(p)) return { id: spec.id, name: spec.name, via: "path", location: p };
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

/** The command that opens `root` in a detected editor. Pure, so the
 *  platform split is pinned by tests rather than by trying it on three OSes. */
export function commandFor(
  target: Pick<DetectedEditor, "via" | "location">,
  root: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[]; shell: boolean } {
  if (platform === "darwin" && target.via === "app") {
    // `open -a <bundle>` launches (or foregrounds) the app with the folder —
    // no CLI needed, and the app handles it the way its own File ▸ Open would.
    return { cmd: "open", args: ["-a", target.location, root], shell: false };
  }
  const isScript = /\.(cmd|bat)$/i.test(target.location);
  return { cmd: target.location, args: [root], shell: platform === "win32" && isScript };
}

/** A custom command: `{path}` substitution when present, else the folder as
 *  the single argument. Split on whitespace outside double quotes. */
export function customCommandFor(command: string, root: string): { cmd: string; args: string[] } {
  const parts = (command.match(/"[^"]*"|\S+/g) ?? []).map((s) => s.replace(/^"|"$/g, ""));
  if (parts.length === 0) return { cmd: command, args: [root] };
  if (parts.some((p) => p.includes("{path}"))) {
    const sub = parts.map((p) => p.replace(/\{path\}/g, root));
    return { cmd: sub[0], args: sub.slice(1) };
  }
  return { cmd: parts[0], args: [...parts.slice(1), root] };
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
 * JetBrains marks without this app shipping (or approximating) anybody's logo.
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

export async function openEditor(
  id: string,
  root: string,
  prefs: EditorPrefs,
): Promise<{ ok: boolean; message?: string }> {
  const custom = prefs.custom.find((c) => c.id === id);
  let cmd: string;
  let args: string[];
  let useShell = false;
  if (custom) {
    ({ cmd, args } = customCommandFor(custom.command, root));
  } else {
    const hit = listDetected().find((d) => d.id === id) ?? listDetected(true).find((d) => d.id === id);
    if (!hit) return { ok: false, message: "That editor isn't installed any more — check Settings ▸ Editors." };
    ({ cmd, args, shell: useShell } = commandFor(hit, root, process.platform));
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: useShell });
      child.once("error", (e) => resolve({ ok: false, message: `Couldn't launch it: ${e.message}` }));
      // `spawn` reports a missing executable asynchronously; give it a beat.
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Finder / Explorer / the file manager, on the repository folder. */
export function revealRoot(root: string): void {
  shell.showItemInFolder(root);
}
