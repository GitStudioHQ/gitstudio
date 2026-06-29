// Backing data for terminal autocomplete: the set of executables on PATH and
// directory listings for path completion. Both are cheap, read-only filesystem
// queries exposed over IPC; nothing here can affect a running command.

import { readdir as readdirAsync } from "node:fs/promises";
import { readdir, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

let pathCommandsPromise: Promise<string[]> | null = null;

/**
 * Names of executables found on $PATH, sorted & de-duplicated. Computed once
 * (asynchronously, so the main process never blocks) and then cached. We list
 * names without stat-ing each one — PATH dirs are overwhelmingly executables and
 * this keeps it fast; over-inclusion is harmless for completion.
 */
export function pathCommands(): Promise<string[]> {
  if (!pathCommandsPromise) pathCommandsPromise = computePathCommands();
  return pathCommandsPromise;
}

async function computePathCommands(): Promise<string[]> {
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const seen = new Set<string>();
  await Promise.all(
    dirs.map(async (dir) => {
      if (!dir) return;
      try {
        for (const name of await readdirAsync(dir)) seen.add(name);
      } catch {
        // unreadable PATH entry — skip
      }
    }),
  );
  return [...seen].sort();
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
