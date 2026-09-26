import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { GitContext } from "@gitstudio/git-service/index";
import {
  checkedOutElsewhere,
  checkedOutElsewhereMessage,
  type ElsewhereDoor,
} from "@gitstudio/git-service/branchElsewhere";
import { refShortName } from "@gitstudio/git-service/checkoutRef";

// The extension's doors for a branch another worktree has checked out — the
// Branches view, the branch menu, the graph's chips, a pull request's
// checkout. Its own module, free of the Worktrees tree view, so the graph's
// actions can use it without loading a TreeItem.

/**
 * Before a checkout or a delete of the local branch `fullName`: when ANOTHER
 * worktree has it checked out, say where — with a button that opens that
 * worktree — and answer true, so the door runs nothing. git would refuse in
 * its own words, and a delete would have asked "Delete branch x?" first.
 */
export async function saidCheckedOutElsewhere(
  ctx: GitContext,
  fullName: string | undefined,
  door: ElsewhereDoor,
): Promise<boolean> {
  if (!fullName) {
    return false;
  }
  let where: string | undefined;
  try {
    where = await checkedOutElsewhere(ctx.process, fullName);
  } catch {
    return false; // git decides, as before
  }
  if (!where) {
    return false;
  }
  const open = "Open Worktree in New Window";
  const folder = where;
  // Its folder gone, there is nothing to open: forgetting it is the way out.
  const gone = !existsSync(folder);
  void vscode.window
    .showWarningMessage(
      `GitStudio: ${checkedOutElsewhereMessage(refShortName(fullName), tildify(folder), door, gone)}`,
      ...(gone ? [] : [open]),
    )
    .then((pick) => {
      if (pick === open) {
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), {
          forceNewWindow: true,
        });
      }
    });
  return true;
}

/** Replace a leading home dir with "~" for compact display. */
export function tildify(p: string): string {
  const home = homedir();
  if (p === home) {
    return "~";
  }
  if (p.startsWith(home + "/")) {
    return "~" + p.slice(home.length);
  }
  return p;
}
