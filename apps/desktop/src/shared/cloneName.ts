// Pure clone-target-name helpers, shared by the main process (cloneBridge
// validates before spawning git) and the renderer (the clone dialog and the
// destination sheet validate live, as the user types). Type-only-adjacent —
// imports nothing host-specific.

/** Derive a folder name from a git URL's last path segment ("repo" from
 *  "https://github.com/owner/repo.git"). Undefined when nothing usable. */
export function deriveNameFromUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, "");
  const seg = trimmed.split(/[\\/:]/).pop() ?? "";
  const name = seg.replace(/\.git$/i, "");
  return name || undefined;
}

/** Why a folder-name override is unusable, or null when it's fine.
 *  An EMPTY name is fine — it means "use the derived name". */
export function validateTargetName(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n.startsWith("-")) return "A folder name can't start with a dash.";
  if (/[\\/]/.test(n)) return "A folder name can't contain path separators.";
  if (n === "." || n === "..") return "That isn't a usable folder name.";
  return null;
}
