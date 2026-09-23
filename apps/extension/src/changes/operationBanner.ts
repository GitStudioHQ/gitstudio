// The Changes view's operation banner, as data (PLAN §3.7 W15, matrix row 38):
// what is stopped, where, and Continue / Skip / Abort with the operation's own
// verbs — plus "Resolve Conflicts…" while files are unmerged. Built from
// OperationProvider (view + detect), never from git's prose. vscode-free, so
// the banner's content is unit-tested; the webview only renders it.

//
// Its WORDS come from the phrasing module the dashboard, the merge shell and
// the desktop use (webview-ui conflicts/opText), so the same stop reads the
// same here and one click away in the dashboard.

import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  abortLabel,
  continueBlockedText,
  opChipLabel,
  willDropText,
} from "@gitstudio/webview-ui/conflicts/opText";

/** The operation the banner describes (OperationProvider.view()). */
export type BannerView = OperationView;

export interface OperationBannerData {
  kind: string;
  /** One line: what git is doing ("Rebasing test onto master · commit 1 of 3: …"). */
  title: string;
  /** "test → onto → master", when the operation has a direction. */
  direction?: string;
  /** Why the user is here and what Continue will do, in plain words. */
  note?: string;
  /** Files still unmerged. */
  conflicts: number;
  continueLabel?: string;
  canContinue: boolean;
  /** Why Continue is disabled (its tooltip, and the note). */
  continueBlocked?: string;
  skipLabel?: string;
  abortLabel: string;
}

/**
 * The banner for the repository's state, or undefined when nothing is stopped
 * and nothing is unmerged.
 */
export function operationBanner(
  view: BannerView,
  detected: { kind: string; unmerged: number },
): OperationBannerData | undefined {
  if (detected.kind === "none" && detected.unmerged === 0 && view.kind === "none") {
    return undefined;
  }
  const conflicts = detected.unmerged;
  let title = view.title || opChipLabel(view);
  if (!view.title && view.step) {
    title += ` · ${view.step.unit} ${view.step.n} of ${view.step.m}`;
  }
  const d = view.direction;
  const direction =
    d && view[d.from].name && view[d.to].name
      ? `${view[d.from].name} → ${d.verb} → ${view[d.to].name}`
      : undefined;

  let note: string | undefined;
  if (view.pause) {
    note = view.pause.detail;
  } else if (conflicts > 0) {
    note = conflicts === 1 ? "1 file has conflicts to resolve." : `${conflicts} files have conflicts to resolve.`;
  } else if (view.willDrop) {
    note = willDropText(view);
  } else if (!view.canContinue && view.verbs.continue && continueBlockedText(view, conflicts)) {
    note = continueBlockedText(view, conflicts);
  } else if (view.canContinue && view.verbs.continue) {
    note = "Every conflict is resolved.";
  }

  const banner: OperationBannerData = {
    kind: view.kind,
    title,
    conflicts,
    canContinue: view.canContinue,
    // A bare "Cancel" (stash / none) says what it cancels.
    abortLabel: abortLabel(view),
  };
  if (direction) banner.direction = direction;
  if (note) banner.note = note;
  if (view.verbs.continue) banner.continueLabel = view.verbs.continue;
  // The reason is also given when git sent none — an emptied stop's disabled
  // Continue otherwise said nothing about why.
  const blocked = !view.canContinue ? continueBlockedText(view, conflicts) : "";
  if (view.verbs.continue && blocked) banner.continueBlocked = blocked;
  // Skip is shown only where git names it as the way out.
  if (view.canSkip && view.verbs.skip) banner.skipLabel = view.verbs.skip;
  return banner;
}
