// Pure git-ref-name helpers, shared by the main process (so a bad name is
// refused with a sentence rather than raw stderr) and the renderer (so the
// branch prompts validate live, as you type).
//
// Ported from the extension's DLG_VALIDATORS.refName and DLG_SANITIZE.refName
// so the two products say the same thing about the same mistake. Node-free and
// dependency-free — the same contract `cloneName.ts` keeps.

/** Why git would refuse this name, or null when it would accept it. */
export function refNameProblem(v: string): string | null {
  if (!v.trim()) return "Required.";
  if (/\s/.test(v)) return "Cannot contain spaces.";
  if (/^[-.]|[.]{2}|[~^:?*[\\]|[.]$|[/]$|@\{/.test(v)) return "Not a valid git ref name.";
  if (v === "@") return "Not a valid git ref name.";
  return null;
}

/** Characters git will not take in a ref, plus the ASCII control range. */
const ILLEGAL = new RegExp("[\\u0000-\\u001f\\u007f~^:?*\\[\\\\]", "g");

/**
 * Turn free text into a name git will accept, or "" when nothing survives.
 *
 * The point of this is the paste: people name a branch by pasting a ticket
 * title — "SPS-1234 ALA baLa 12/02/21 something" — and git refuses it. Rather
 * than only saying no, the prompt can offer the repaired form.
 */
export function sanitizeRefName(v: string): string {
  let s = v
    .replace(ILLEGAL, "-")
    .replace(/@\{/g, "-")
    .replace(/\s+/g, "-")
    // A date like 12/02/21 would otherwise become a THREE-LEVEL hierarchy —
    // refs/heads/12/02/21 — and git then refuses any other ref that needs `12`
    // or `12/02` to be a file, because they have become directories.
    .replace(/(\d)\/(\d)/g, "$1-$2")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-");
  s = s
    .split("/")
    .map((part) =>
      part
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .replace(/\.lock$/i, "")
        .replace(/^-+/, "")
        .replace(/-+$/, ""),
    )
    .filter(Boolean)
    .join("/");
  return s === "@" ? "" : s;
}
