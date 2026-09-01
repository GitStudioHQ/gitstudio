// The in-app navigation history, reachable from a view.
//
// The history itself lives on `App` (renderer.ts: navHistory/navPos), because
// only `routeView` knows when a navigation happens. But a detail page needs two
// things from it that it had no way to ask for:
//
//   · "take me back" — a POP, stepping over an entry
//   · "what is behind me" — so the button can say where it goes
//
// Without those, every `.det-back` did `nav(view, {list:true})`, which is a
// PUSH. Measured on the shipping build: after pressing back, FORWARD is
// disabled — proof that the press appended an entry instead of stepping over
// one. So the control that should restore your place was the one destroying it,
// on every detail page in the app. And because `SectionTarget.from` was
// `{view, label}`, it could only ever name a LIST: the mechanism structurally
// could not say "return to Pull Request #106", which is why leaving a PR for a
// pipeline and pressing back landed in the Actions list.
//
// This module is the bridge, not a second history. `App` installs itself once;
// views ask through here.

import type { SectionTarget } from "./views/common";

export interface NavEntry {
  view: string;
  target?: SectionTarget;
  /** What to call this place in a back button: "Pull Request #106". */
  label?: string;
}

interface NavStackImpl {
  /** Step back one entry. False when there is nothing behind. */
  back: () => boolean;
  /** The entry behind the current one, if any. */
  prev: () => NavEntry | undefined;
  /** Name the CURRENT entry, once the page knows its own identity. */
  label: (label: string) => void;
}

let impl: NavStackImpl | undefined;

/** Called once by App. */
export function installNavStack(next: NavStackImpl): void {
  impl = next;
}

/**
 * Where Back goes, or undefined when this page was the first thing on screen
 * (a deep link, a fresh launch, a restored session).
 */
export function navPrev(): NavEntry | undefined {
  return impl?.prev();
}

/** Step back. Returns false when there is nothing to step back to, and the
 *  caller should use its own fallback — see `detailPage`'s `homeLabel`. */
export function navPop(): boolean {
  return impl?.back() ?? false;
}

/**
 * Name the page currently on screen, so the NEXT page's back button can say
 * where it leads. Pages call this once they know their identity — a PR knows it
 * is "#106" only after its data arrives.
 */
export function setPageLabel(label: string): void {
  impl?.label(label);
}

/** Human name for a view id, for a back button with nothing better to say. */
const VIEW_LABELS: Record<string, string> = {
  changes: "Changes",
  graph: "Commits",
  branches: "Branches",
  code: "Code",
  compare: "Compare",
  rebase: "Rebase",
  issues: "Issues",
  prs: "Pull requests",
  actions: "Actions",
  releases: "Releases",
  orgs: "Organizations",
  projects: "Projects",
  gists: "Gists",
  notifications: "Inbox",
  mywork: "My Work",
  explore: "Explore",
  settings: "Settings",
  assistant: "Assistant",
  commit: "Commit",
  joblog: "Job log",
  releasenew: "Release composer",
  issuenew: "Issue composer",
};

/** The label a back button should show for an entry. */
export function entryLabel(e: NavEntry | undefined, fallback: string): string {
  if (!e) return fallback;
  return e.label || VIEW_LABELS[e.view] || fallback;
}
