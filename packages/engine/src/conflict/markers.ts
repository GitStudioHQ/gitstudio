// Pure (vscode-free) parser for git conflict markers. Used as a fallback when
// the git index stages (:1:/:2:/:3:) are unavailable, and as the basis for
// headless unit tests.

export interface ParsedConflicts {
  /** True if at least one conflict block was found. */
  hasConflicts: boolean;
  /** True if blocks used diff3 style (i.e. included a `|||||||` base section). */
  isDiff3: boolean;
  /** Reconstructed "ours" version (HEAD / current side). */
  ours: string;
  /** Reconstructed common ancestor; only meaningful when `isDiff3`. */
  base: string;
  /** Reconstructed "theirs" version (incoming side). */
  theirs: string;
}

const START = /^<{7}(\s|$)/; // <<<<<<<
const BASE = /^\|{7}(\s|$)/; // ||||||| (diff3 only)
const SEP = /^={7}(\s|$)/; // =======
const END = /^>{7}(\s|$)/; // >>>>>>>

type Section = "common" | "ours" | "base" | "theirs";

/**
 * Reconstructs the ours/base/theirs versions from a file body that still
 * contains conflict markers. Lines outside conflict blocks belong to all three
 * versions; lines inside are routed to the current side.
 */
export function parseConflictMarkers(text: string): ParsedConflicts {
  const lines = text.split("\n");
  const ours: string[] = [];
  const base: string[] = [];
  const theirs: string[] = [];

  let section: Section = "common";
  let hasConflicts = false;
  let isDiff3 = false;

  for (const line of lines) {
    if (START.test(line)) {
      section = "ours";
      hasConflicts = true;
      continue;
    }
    if (section !== "common" && BASE.test(line)) {
      section = "base";
      isDiff3 = true;
      continue;
    }
    if (section !== "common" && SEP.test(line)) {
      section = "theirs";
      continue;
    }
    if (section !== "common" && END.test(line)) {
      section = "common";
      continue;
    }

    switch (section) {
      case "common":
        ours.push(line);
        base.push(line);
        theirs.push(line);
        break;
      case "ours":
        ours.push(line);
        break;
      case "base":
        base.push(line);
        break;
      case "theirs":
        theirs.push(line);
        break;
    }
  }

  return {
    hasConflicts,
    isDiff3,
    ours: ours.join("\n"),
    base: base.join("\n"),
    theirs: theirs.join("\n"),
  };
}
