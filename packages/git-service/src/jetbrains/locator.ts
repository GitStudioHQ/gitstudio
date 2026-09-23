import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
  JETBRAINS_IDES,
  type JetBrainsIdeId,
  type JetBrainsIdeInfo,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * Finds an installed JetBrains IDE to hand a merge or diff to (PLAN §3.5 W5).
 *
 * A port of Merge Studio's locator (src/jetbrains/locator.ts: explicit path
 * first, then `preferred`, then the JETBRAINS_IDES order; PATH, then the macOS
 * app bundles) plus the places the desktop's editor detection already knows
 * (apps/desktop/src/main/editors.ts): JetBrains Toolbox's shell-script folder
 * on every platform, ~/Applications/JetBrains Toolbox, the usual CLI folders a
 * GUI app's minimal PATH leaves out, and the Windows install folders — so
 * detection is no longer macOS-and-PATH only.
 *
 * Every filesystem question goes through `exists` / `listDir`, so the whole
 * search is unit-tested per platform from any host.
 */

export interface LocateJetBrainsOptions {
  /** The `preferredIde` setting; "auto" / absent searches JETBRAINS_IDES order. */
  preferred?: JetBrainsIdeId | "auto";
  /** The `jetbrainsPath` setting; used as-is when it exists (id "custom"). */
  explicitPath?: string;
  /** Overrides for tests (default: the running process's). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Test seam: is there a FILE at this path? */
  exists?: (path: string) => boolean;
  /** Test seam: the entries of a directory ([] when unreadable). */
  listDir?: (path: string) => string[];
}

interface IdeSpec {
  id: JetBrainsIdeId;
  /** Launcher / in-bundle binary name ("idea" for IntelliJ). */
  bin: string;
  /** macOS bundle names, without ".app". */
  apps: string[];
  /** Windows install-folder prefixes under %ProgramFiles%\JetBrains ("WebStorm 2024.1"). */
  winDirs: string[];
  /**
   * Launcher names a snap install puts in /snap/bin when they differ from
   * `bin` (the edition is part of the snap's name).
   */
  snap?: string[];
}

const SPECS: Record<JetBrainsIdeId, IdeSpec> = {
  webstorm: { id: "webstorm", bin: "webstorm", apps: ["WebStorm"], winDirs: ["WebStorm"] },
  pycharm: {
    id: "pycharm",
    bin: "pycharm",
    apps: ["PyCharm", "PyCharm Professional", "PyCharm Professional Edition", "PyCharm Community", "PyCharm Community Edition", "PyCharm CE"],
    winDirs: ["PyCharm"],
    snap: ["pycharm-professional", "pycharm-community", "pycharm-educational"],
  },
  intellij: {
    id: "intellij",
    bin: "idea",
    apps: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA Community Edition", "IntelliJ IDEA CE"],
    winDirs: ["IntelliJ IDEA"],
    snap: ["intellij-idea-ultimate", "intellij-idea-community", "intellij-idea-educational"],
  },
  phpstorm: { id: "phpstorm", bin: "phpstorm", apps: ["PhpStorm"], winDirs: ["PhpStorm"] },
  goland: { id: "goland", bin: "goland", apps: ["GoLand"], winDirs: ["GoLand"] },
  clion: { id: "clion", bin: "clion", apps: ["CLion"], winDirs: ["CLion"] },
  rider: { id: "rider", bin: "rider", apps: ["Rider"], winDirs: ["JetBrains Rider", "Rider"] },
  rubymine: { id: "rubymine", bin: "rubymine", apps: ["RubyMine"], winDirs: ["RubyMine"] },
  datagrip: { id: "datagrip", bin: "datagrip", apps: ["DataGrip"], winDirs: ["DataGrip"] },
};

/** The IDE to launch, or undefined when none is installed. */
export async function locateJetBrainsIde(
  opts: LocateJetBrainsOptions = {},
): Promise<JetBrainsIdeInfo | undefined> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const exists = opts.exists ?? fileExists;
  const listDir = opts.listDir ?? readDir;
  const j = platform === "win32" ? win32.join : posix.join;

  // 1. The explicit setting wins whenever it points at something real.
  const explicit = opts.explicitPath?.trim();
  if (explicit) {
    const cmd = resolveExplicit(explicit, platform, exists, j);
    // Named from the launcher found (`idea.sh` is IntelliJ IDEA even inside
    // a folder called "idea-IU-2024.2"), else from what was chosen.
    if (cmd) return { id: "custom", name: knownName(cmd) ?? nameFromPath(explicit), command: cmd };
  }

  // 2. The preferred IDE first, then the default order.
  const order: JetBrainsIdeId[] =
    opts.preferred && opts.preferred !== "auto"
      ? [opts.preferred, ...JETBRAINS_IDES.map((i) => i.id).filter((id) => id !== opts.preferred)]
      : JETBRAINS_IDES.map((i) => i.id);

  const cliDirs = cliFolders(platform, env, home, j);
  for (const id of order) {
    const spec = SPECS[id];
    const name = JETBRAINS_IDES.find((i) => i.id === id)?.name ?? id;
    const hit =
      findCli(spec, platform, cliDirs, exists, j) ??
      (platform === "darwin" ? findBundle(spec, home, exists, j) : undefined) ??
      (platform === "win32" ? findWindowsInstall(spec, env, exists, listDir, j) : undefined) ??
      (platform === "linux" ? findLinuxInstall(spec, home, exists, listDir, j) : undefined);
    if (hit) return { id, name, command: hit };
  }
  return undefined;
}

/**
 * A path the user chose: a launcher, or an install FOLDER we look inside — a
 * macOS bundle (`Contents/MacOS/<bin>`, with or without its ".app" showing),
 * or a Linux / Windows install (`bin/<bin>.sh`, `bin/<bin>64.exe`, …).
 * Picking the IDE's folder in a folder chooser is the natural thing to do;
 * only a FILE used to count, so that choice was silently ignored.
 */
function resolveExplicit(
  p: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
  j: (...parts: string[]) => string,
): string | undefined {
  if (exists(p)) return p;
  const dir = p.replace(/[\\/]+$/, "");
  if (!dir) return undefined;
  for (const spec of Object.values(SPECS)) {
    const inner =
      platform === "darwin"
        ? [j(dir, "Contents", "MacOS", spec.bin)]
        : platform === "win32"
          ? [j(dir, "bin", `${spec.bin}64.exe`), j(dir, "bin", `${spec.bin}.exe`), j(dir, "bin", `${spec.bin}.cmd`)]
          : [j(dir, "bin", `${spec.bin}.sh`), j(dir, "bin", spec.bin)];
    for (const candidate of inner) {
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function nameFromPath(p: string): string {
  return knownName(p) ?? (cleanBase(p) || "JetBrains IDE");
}

function cleanBase(p: string): string {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(app|exe|cmd|bat|sh)$/i, "").replace(/64$/, "");
}

/** The product name when the path's last part names a known IDE or launcher. */
function knownName(p: string): string | undefined {
  const clean = cleanBase(p).toLowerCase();
  return JETBRAINS_IDES.find(
    (i) =>
      i.name.toLowerCase() === clean ||
      SPECS[i.id].bin === clean ||
      (SPECS[i.id].snap ?? []).includes(clean),
  )?.name;
}

/** PATH plus the folders a GUI app's minimal PATH leaves out (Toolbox scripts first). */
function cliFolders(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  j: (...parts: string[]) => string,
): string[] {
  const delim = platform === "win32" ? ";" : ":";
  const fromPath = (env.PATH ?? env.Path ?? "").split(delim).filter(Boolean);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return [...fromPath, ...(local ? [j(local, "JetBrains", "Toolbox", "scripts")] : [])];
  }
  return [
    ...fromPath,
    j(home, "Library", "Application Support", "JetBrains", "Toolbox", "scripts"),
    j(home, ".local", "share", "JetBrains", "Toolbox", "scripts"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/snap/bin",
    j(home, ".local", "bin"),
  ];
}

function findCli(
  spec: IdeSpec,
  platform: NodeJS.Platform,
  dirs: string[],
  exists: (p: string) => boolean,
  j: (...parts: string[]) => string,
): string | undefined {
  const exts = platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
  // A snap's launcher carries the edition in its name ("pycharm-professional").
  const names = platform === "linux" ? [spec.bin, ...(spec.snap ?? [])] : [spec.bin];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const p = j(dir, name + ext);
        if (exists(p)) return p;
      }
    }
  }
  return undefined;
}

/** /Applications, ~/Applications and Toolbox's own app folder: the binary INSIDE the bundle. */
function findBundle(
  spec: IdeSpec,
  home: string,
  exists: (p: string) => boolean,
  j: (...parts: string[]) => string,
): string | undefined {
  for (const base of ["/Applications", j(home, "Applications"), j(home, "Applications", "JetBrains Toolbox")]) {
    for (const app of spec.apps) {
      const p = j(base, `${app}.app`, "Contents", "MacOS", spec.bin);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/** %ProgramFiles%\JetBrains\<Product> <version>\bin\<bin>64.exe — the newest version wins. */
function findWindowsInstall(
  spec: IdeSpec,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  listDir: (p: string) => string[],
  j: (...parts: string[]) => string,
): string | undefined {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA ? j(env.LOCALAPPDATA, "Programs") : undefined]
    .filter((x): x is string => !!x)
    .map((r) => j(r, "JetBrains"));
  for (const root of roots) {
    const dirs = listDir(root)
      .filter((d) => spec.winDirs.some((w) => d === w || d.startsWith(`${w} `)))
      .sort(compareVersionsDesc);
    for (const d of dirs) {
      for (const exe of [`${spec.bin}64.exe`, `${spec.bin}.exe`]) {
        const p = j(root, d, "bin", exe);
        if (exists(p)) return p;
      }
    }
  }
  return undefined;
}

/** A tarball install under /opt or ~ (…/bin/<bin>.sh) — Toolbox scripts cover the rest. */
function findLinuxInstall(
  spec: IdeSpec,
  home: string,
  exists: (p: string) => boolean,
  listDir: (p: string) => string[],
  j: (...parts: string[]) => string,
): string | undefined {
  for (const root of ["/opt", home]) {
    const dirs = listDir(root)
      .filter((d) => d.toLowerCase().startsWith(spec.bin) || spec.winDirs.some((w) => d.startsWith(w)))
      .sort(compareVersionsDesc);
    for (const d of dirs) {
      const p = j(root, d, "bin", `${spec.bin}.sh`);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/** "WebStorm 2024.2" before "WebStorm 2023.3.1": numeric runs compared as numbers. */
function compareVersionsDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
