// The question every commit-applying door asks when git refuses it over the
// user's uncommitted work: Stash & Retry, or Cancel. Asked by bridge.ts for
// every door at once; installed at boot with `installInTheWayAsker()`.

import type { InTheWayInfo } from "../shared/ipc";
import { answerInTheWayWith } from "./bridge";
import { promptChoice, toast } from "./dialogs";
import * as l10n from "@vscode/l10n";

/**
 * The question. True for Stash & Retry.
 *
 * `openRoot` reads which repository is open now. The question is held while
 * that is still the one it was asked in — see promptChoice's `holdWhile`: a
 * refused command can still have refreshed the index (a pull has fetched),
 * and the watcher's refresh that follows re-routes the view, which answered a
 * question asked right after a git write with "Cancel" for the user (the
 * pull's Merge-or-Rebase did exactly that). A switch to another repository
 * does close it, as Cancel: the answer acts on whichever repository is open,
 * and main refuses a retry anywhere but the one the refusal came from.
 */
export async function askStashRetry(
  way: InTheWayInfo,
  message: string | undefined,
  openRoot: () => string | undefined = () => way.root,
): Promise<boolean> {
  const n = way.files.length;
  const askedIn = openRoot();
  const pick = await promptChoice({
    title: l10n.t("Your uncommitted changes are in the way"),
    // main's sentence names the files and what they are in the way of.
    hint: message,
    choices: [
      {
        id: "stash",
        label: l10n.t("Stash & Retry"),
        sub:
          n === 1
            ? l10n.t("Stash it, run it again, and put it back.")
            : l10n.t("Stash these {0} files, run it again, and put them back.", n),
        icon: "archive",
      },
      {
        id: "cancel",
        label: l10n.t("Cancel"),
        sub:
          n === 1
            ? l10n.t("Nothing runs. Commit or stash it yourself first.")
            : l10n.t("Nothing runs. Commit or stash them yourself first."),
        icon: "close",
      },
    ],
    cancelId: "cancel",
    holdWhile: () => askedIn !== undefined && openRoot() === askedIn,
  });
  return pick === "stash";
}

/**
 * Install the question for every door. `openRoot` is the App's view of which
 * repository is open, read each time the question asks whether to hold.
 */
export function installInTheWayAsker(openRoot: () => string | undefined): void {
  answerInTheWayWith(
    (way, message) => askStashRetry(way, message, openRoot),
    // What became of the stashed changes, when it is anything but "back where
    // they were" — neutral, and long enough to read a stash's name.
    (note) => toast(note, "info", 10000),
  );
}
