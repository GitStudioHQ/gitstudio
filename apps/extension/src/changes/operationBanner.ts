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

/**
 * How the banner is drawn — decided here, with the facts, not re-derived by
 * the page. "attention": something is in the way (files still conflicted, or
 * a stop git cannot continue from); "ready": nothing is — a deliberate pause,
 * or every conflict resolved. It was red in every state, so "Every conflict
 * is resolved." read as an error.
 */
export type BannerTone = "attention" | "ready";

export interface OperationBannerData {
  kind: string;
  /** What git is doing, in one line: "Rebasing test onto master". */
  title: string;
  /**
   * Where in it, when git says: "Commit 1 of 3: 1a2b3c4 test change",
   * "2 more queued" — the title's second half, on its own line.
   */
  step?: string;
  /**
   * "test → onto → master", when the operation has a direction the title
   * does not already give (it does whenever it names both sides — then the
   * line only said the title again).
   */
  direction?: string;
  tone: BannerTone;
  /** The banner's codicon: warning, debug-pause (a deliberate stop) or pass (all resolved). */
  icon: "warning" | "debug-pause" | "pass";
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
  /**
   * A rebase: the branch it is rebasing, which its commits land on when it
   * finishes. Absent for a rebase begun on a detached HEAD (git names the
   * commit it started from then, and there is no branch to land on). Set by
   * the host, which checks the name is a branch; the Push button's reason
   * reads it (commitView's detachedPushReason).
   */
  rebaseBranch?: string;
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
  let full = view.title || opChipLabel(view);
  if (!view.title && view.step) {
    full += ` · ${view.step.unit} ${view.step.n} of ${view.step.m}`;
  }
  // "Rebasing test onto master · commit 1 of 3: …" is two things: what is
  // happening, and where it is. One bold run of both wrapped to three lines
  // in a sidebar.
  const cut = full.indexOf(" · ");
  const title = cut > 0 ? full.slice(0, cut) : full;
  const rest = cut > 0 ? full.slice(cut + 3).trim() : "";
  const step = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : undefined;
  const d = view.direction;
  const from = d ? view[d.from].name : "";
  const to = d ? view[d.to].name : "";
  const direction =
    d && from && to && !(title.includes(from) && title.includes(to))
      ? `${from} → ${d.verb} → ${to}`
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

  const blockedStop = !!view.verbs.continue && !view.canContinue;
  const tone: BannerTone = conflicts > 0 || blockedStop ? "attention" : "ready";
  const icon = tone === "attention" ? "warning" : view.pause ? "debug-pause" : "pass";
  const banner: OperationBannerData = {
    kind: view.kind,
    title,
    tone,
    icon,
    conflicts,
    canContinue: view.canContinue,
    // A bare "Cancel" (stash / none) says what it cancels.
    abortLabel: abortLabel(view),
  };
  if (step) banner.step = step;
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
