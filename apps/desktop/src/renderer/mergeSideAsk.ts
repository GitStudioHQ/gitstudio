// The question a cherry-pick or revert of a MERGE commit asks first: which
// side. git refuses either without `-m`, and main answers such a request with
// the merge's parents (`mergeSides`); bridge.ts asks this for every door at
// once and sends the request again with `mainline`. The same question, in the
// same words, as the extension's (apps/extension/src/graph/commitActions.ts).
//
// For a cherry-pick, `-m 1` applies what the merge brought in — its changes
// against the branch it was merged into — the usual intent, offered first. For
// a revert, `-m 1` keeps the branch the merge was made ON ("undo this merge").
// Every parent is offered, not just two: an octopus merge has three or more.

import type { MergeSides } from "../shared/ipc";
import { answerMergeSidesWith } from "./bridge";
import { promptChoice, type ChoiceOption } from "./dialogs";
import * as l10n from "@vscode/l10n";

const short = (sha: string): string => sha.slice(0, 7);

/** The parent number (from 1) to take the merge against, or undefined for Cancel. */
export async function askMergeSide(
  action: "cherry-pick" | "revert",
  sha: string,
  sides: MergeSides,
  openRoot: () => string | undefined = () => undefined,
): Promise<number | undefined> {
  const parents = sides.parents;
  if (parents.length < 2) return undefined;
  const pair = parents.length === 2;
  const pick = action === "cherry-pick";
  const label = (i: number): string =>
    pick
      ? pair
        ? i === 0
          ? l10n.t("Apply the changes that were merged in")
          : l10n.t("Apply the changes of the branch it was merged into")
        : l10n.t("Against parent {0}", i + 1)
      : pair
        ? i === 0
          ? l10n.t("Keep the branch this was merged into")
          : l10n.t("Keep the branch that was merged in")
        : l10n.t("Keep parent {0}", i + 1);
  const choices: ChoiceOption[] = parents.map((p, i) => ({
    id: String(i + 1),
    label: label(i),
    sub:
      short(p.sha) +
      (p.subject
        ? ` · ${p.subject}`
        : i === 0
          ? ` · ${l10n.t("The first parent — usually what you want.")}`
          : ""),
    icon: i === 0 ? "git-branch" : "git-merge",
  }));
  const askedIn = openRoot();
  const chosen = await promptChoice({
    title: pick ? l10n.t("Cherry-pick the merge {0}", short(sha)) : l10n.t("Revert the merge {0}", short(sha)),
    hint: pick
      ? pair
        ? l10n.t("A merge has two sides, so git needs to know which side's changes to apply.")
        : l10n.t("This merge has {0} parents. Which one should its changes be taken against?", parents.length)
      : pair
        ? l10n.t("A merge has two sides, so git needs to know which one to keep.")
        : l10n.t("This merge has {0} parents. Which one should be kept as the mainline?", parents.length),
    choices,
    // The dialog's own Cancel button (and Escape) answer this: not a choice.
    cancelId: "cancel",
    // Held while the repository it was asked in is still the one in front,
    // as the in-the-way question is (see askStashRetry).
    holdWhile: () => askedIn !== undefined && openRoot() === askedIn,
  });
  const n = Number(chosen);
  // An id outside the parents cannot happen — they are made just above — but
  // falling back to 1 would take the merge against the WRONG side: cancel.
  return Number.isInteger(n) && n >= 1 && n <= parents.length ? n : undefined;
}

/** Install the question for every door that cherry-picks or reverts. */
export function installMergeSideAsker(openRoot: () => string | undefined): void {
  answerMergeSidesWith((action, sha, sides) => askMergeSide(action, sha, sides, openRoot));
}
