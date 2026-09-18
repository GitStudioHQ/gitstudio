// Where a new branch starts, and the words the New-branch dialog uses for it.
//
// Node-free and separate from the flow that opens the dialog, so the copy and
// the defaults can be unit-tested without a browser — the graph and commit-page
// entry points live inside web components, where a synthetic-event check would
// pass on a broken build. Same split as `cloneName.ts` and `refName.ts`.

/** Where a new branch starts, and how the dialog talks about it. */
export interface BranchStart {
  /** What git is given as the start point. Omitted means HEAD. */
  ref?: string;
  /** How the dialog names it: "main", "origin/fix/log", "a1b2c3d". */
  label: string;
  kind: "head" | "branch" | "remote" | "tag" | "commit";
  /** Short sha, when known — appended to the hint. */
  sha?: string;
  /** A commit subject, used by `kind: "commit"`. */
  subject?: string;
  /** HEAD is detached (only meaningful for kind "head"). */
  detached?: boolean;
  /** The branch you are standing on, for the "you stay on X" toast. */
  current?: string;
}

export interface BranchStartCopy {
  title: string;
  hint: string;
  /** The name to pre-fill: "feature/x" from "origin/feature/x", else "". */
  seed: string;
  /** Whether "Switch to it after creating" starts ticked. */
  switchByDefault: boolean;
}

/**
 * The dialog's words for a start point.
 *
 * Pure, so the copy and the defaults can be unit-tested without a browser —
 * which is the only way the commit entry points get covered at all, since their
 * menus live inside web components a synthetic event cannot honestly drive.
 */
export function branchStartCopy(s: BranchStart): BranchStartCopy {
  const at = s.sha ? ` (${s.sha})` : "";
  switch (s.kind) {
    case "branch":
      return {
        title: `New branch from ${s.label}`,
        hint: `Starts at ${s.label}${at}.`,
        seed: "",
        switchByDefault: true,
      };
    case "remote":
      return {
        title: `New branch from ${s.label}`,
        hint: `Starts at ${s.label}${at}. The new branch tracks it.`,
        // "origin/feature/x" names the branch "feature/x" — the same promise
        // the remote row's "Check out here" already makes.
        seed: s.label.split("/").slice(1).join("/"),
        switchByDefault: true,
      };
    case "tag":
      return {
        title: `New branch from ${s.label}`,
        hint: `Starts at the tag ${s.label}${at}.`,
        seed: "",
        switchByDefault: true,
      };
    case "commit":
      return {
        title: `New branch at ${s.sha ?? s.label}`,
        hint: s.subject ? `${s.subject} — the branch starts here.` : "The branch starts at this commit.",
        seed: "",
        // Naming a point in history is bookmarking, not moving — the same
        // answer the extension gives at a commit.
        switchByDefault: false,
      };
    case "head":
    default:
      return {
        title: "New branch",
        hint: s.detached
          ? `Starts at the commit you have checked out${at}.`
          : `Starts at ${s.label}${at} — where you are now.`,
        seed: "",
        switchByDefault: true,
      };
  }
}
