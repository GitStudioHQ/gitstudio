// The Changes view's operation banner, as data (PLAN §3.7 W15, matrix row 38):
// what is stopped, where, and Continue / Skip / Abort with the operation's own
// verbs — plus "Resolve Conflicts…" while files are unmerged. Built from
// OperationProvider (view + detect), never from git's prose. vscode-free, so
// the banner's content is unit-tested; the webview only renders it.

/** Structural slices of OperationView / OperationDetection (no import needed). */
export interface BannerView {
  kind: string;
  title: string;
  step?: { n: number; m: number; unit: string };
  commit?: { sha: string; subject: string };
  yours: { name: string };
  theirs: { name: string };
  direction?: { from: "yours" | "theirs"; verb: string; to: "yours" | "theirs" };
  verbs: { continue?: string; skip?: string; abort: string };
  canContinue: boolean;
  canSkip: boolean;
  continueBlocked?: string;
  willDrop?: { sha: string; subject: string; branch: string };
  pause?: { detail: string };
}

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

const FALLBACK_TITLES: Record<string, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "rebase-merge-step": "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
  am: "Applying patches (git am)",
  stash: "Applying a stash",
  none: "Unresolved conflicts",
};

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
  let title = view.title || FALLBACK_TITLES[view.kind] || "Operation in progress";
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
    note = `Continuing leaves ${view.willDrop.sha.slice(0, 7)} “${view.willDrop.subject}” out of ${view.willDrop.branch}: your resolution left it with no changes.`;
  } else if (!view.canContinue && view.continueBlocked) {
    note = view.continueBlocked;
  } else if (view.canContinue && view.verbs.continue) {
    note = "Every conflict is resolved.";
  }

  const banner: OperationBannerData = {
    kind: view.kind,
    title,
    conflicts,
    canContinue: view.canContinue,
    abortLabel: view.verbs.abort,
  };
  if (direction) banner.direction = direction;
  if (note) banner.note = note;
  if (view.verbs.continue) banner.continueLabel = view.verbs.continue;
  if (!view.canContinue && view.continueBlocked) banner.continueBlocked = view.continueBlocked;
  // Skip is shown only where git names it as the way out.
  if (view.canSkip && view.verbs.skip) banner.skipLabel = view.verbs.skip;
  return banner;
}
