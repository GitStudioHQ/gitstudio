// The legacy conflict-type note, decided ONE way for every host.
//
// The extensions and the desktop each derived it on their own: the desktop
// called a modify/delete, a file added on one side and a file deleted on both
// "content", the extensions called the one-sided add "deleted-by-us" and the
// double delete "unknown". The same conflict, three names. Stated in ROLE
// terms, in git's own words (`git status`: "deleted by us", "added by them",
// "both deleted"): "us" is Yours, whichever stage that is.

import type { ConflictShape, SideRole } from "@gitstudio/host-bridge/conflictsProtocol";
import type { ConflictType, VersionsSource } from "@gitstudio/host-bridge/protocol";

export interface ConflictTypeInput {
  shape?: ConflictShape;
  /** modify-delete / added-one-side: the role with NO version of the file. */
  missingRole?: SideRole;
  hasBase: boolean;
  source?: VersionsSource;
}

export function conflictTypeFor(input: ConflictTypeInput): ConflictType {
  if (input.source === "none") return "unknown";
  switch (input.shape) {
    case "added-both":
      return "add-add";
    case "both-deleted":
      return "deleted-by-both";
    case "modify-delete":
      return input.missingRole === "yours" ? "deleted-by-us" : "deleted-by-them";
    case "added-one-side":
      // The role that HAS the file added it.
      return input.missingRole === "yours" ? "added-by-them" : "added-by-us";
    default:
      return input.hasBase ? "content" : "add-add";
  }
}
