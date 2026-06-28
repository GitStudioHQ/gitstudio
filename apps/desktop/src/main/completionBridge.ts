// Backing data for terminal autocomplete: the set of executables on PATH and
// directory listings for path completion. Both are cheap, read-only filesystem
// queries exposed over IPC; nothing here can affect a running command.

import { readdir, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

let pathCommandsCache: string[] | null = null;

/** Executables found on $PATH, sorted & de-duplicated. Computed once, then cached. */
export function pathCommands(): string[] {
  if (pathCommandsCache) return pathCommandsCache;
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable PATH entry — skip
    }
    for (const name of entries) {
      if (seen.has(name)) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0)) {
          seen.add(name);
        }
      } catch {
        // broken symlink / race — ignore
      }
    }
  }
  pathCommandsCache = [...seen].sort();
  return pathCommandsCache;
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export interface DirEntryWire {
  name: string;
  isDir: boolean;
}

/**
 * List the directory implied by `dir` (relative to `cwd`), for path completion.
 * `dir` is the already-typed directory portion (e.g. "src/", "./", "~/", "/abs/").
 * Returns up to `limit` entries; errors degrade to an empty list.
 */
export function listDir(cwd: string, dir: string, limit = 1000): Promise<DirEntryWire[]> {
  return new Promise((res) => {
    const expanded = expandHome(dir || ".");
    const target = isAbsolute(expanded) ? expanded : resolve(cwd || homedir(), expanded || ".");
    readdir(target, { withFileTypes: true }, (err, ents) => {
      if (err) {
        res([]);
        return;
      }
      const out: DirEntryWire[] = [];
      for (const e of ents) {
        if (out.length >= limit) break;
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          try {
            isDir = statSync(join(target, e.name)).isDirectory();
          } catch {
            isDir = false;
          }
        }
        out.push({ name: e.name, isDir });
      }
      res(out);
    });
  });
}
