import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

// One folder has many spellings, and git uses its own.
//
// git names a worktree by the physical path it resolved when the worktree was
// added: symlinks followed (/var is /private/var on macOS), and on Windows
// the LONG name with forward slashes — C:/Users/runneradmin/AppData/Local/…
// The same folder reaches us from a window's folder, a tab, a test's
// os.tmpdir() — C:\Users\RUNNER~1\AppData\Local\… on a CI runner, an 8.3
// short name no text rule can expand. A folder that is there was always
// resolved on disk; one that is gone was compared as written, so removal()
// answered "not a worktree of this repository" for a worktree git still
// keeps, and the desktop's own `===` and path.resolve compares missed even
// folders that are there.
//
// So every comparison of two folders goes through folderKey/sameFolder, and
// every path SHOWN to a person through nativePath.

/** How a path is read: which system's rules, and how the disk is asked. */
export interface PathRules {
  /** `process.platform` by default; "win32" applies Windows' rules anywhere. */
  platform?: string;
  /**
   * The disk's own spelling of a path that exists — `realpathSync.native` by
   * default, which (like git) gives the long name for an 8.3 short one. It
   * throws for a path that is not there. `null` settles by the text alone.
   */
  realpath?: ((path: string) => string) | null;
}

const pathsOn = (platform: string) => (platform === "win32" ? win32 : posix);

/**
 * The key two paths compare equal by when they name the same folder:
 *
 *   · resolved on disk — through symlinks and 8.3 short names. A folder that
 *     is gone (a worktree whose folder was deleted) is resolved through the
 *     nearest ancestor that is still there, with the rest as written: git
 *     still lists it, under the spelling its parent had when it was made;
 *   · `.` and `..` resolved, the separators unified, no trailing separator;
 *   · case folded where the file system ignores it by default — Windows and
 *     macOS. On Linux `Repo` and `repo` are two folders, and a backslash is
 *     a character in a name, not a separator.
 */
export function folderKey(path: string, rules?: PathRules): string {
  const platform = rules?.platform ?? process.platform;
  const paths = pathsOn(platform);
  const real = rules?.realpath === undefined ? realpathSync.native : rules.realpath;
  const normal = paths.normalize(path);
  let key = real ? onDisk(normal, paths, real) : normal;
  if (platform === "win32") {
    key = key.replace(/\\/g, "/");
  }
  // A trailing separator, but never the root's own ("/", "C:/").
  key = key.replace(/(?<=[^/:])\/+$/, "");
  return platform === "win32" || platform === "darwin" ? key.toLowerCase() : key;
}

/** Whether two paths name the same folder — see folderKey. */
export function sameFolder(a: string, b: string, rules?: PathRules): boolean {
  return folderKey(a, rules) === folderKey(b, rules);
}

/**
 * A path as the system spells it, for a person to read: git's C:/Users/… is
 * C:\Users\… on Windows. Anywhere else it is left exactly as it is.
 */
export function nativePath(path: string, platform: string = process.platform): string {
  return platform === "win32" && path ? win32.normalize(path) : path;
}

/** `path` resolved on disk through the nearest ancestor that exists. */
function onDisk(path: string, paths: typeof posix, real: (p: string) => string): string {
  const rest: string[] = [];
  for (let at = path; ; ) {
    try {
      const found = real(at);
      return rest.length > 0 ? paths.join(found, ...rest) : found;
    } catch {
      const up = paths.dirname(at);
      if (up === at) {
        return path; // nothing of it is there: as written
      }
      rest.unshift(paths.basename(at));
      at = up;
    }
  }
}
