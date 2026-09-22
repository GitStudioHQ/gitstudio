// The automatic-routing decision table (PLAN §3.7 W14, matrix rows 2–4, 6, 44).
//
// Two routes send a conflicted file into the product's resolver without being
// asked:
//   1. the ACTIVE-EDITOR route — a conflicted file becomes the active text
//      editor (Merge Studio's model; GitStudio used to open EVERY conflicted
//      file as its own tab instead);
//   2. the BUILT-IN TAB REROUTE — VS Code opens its own 3-way merge editor for
//      a conflicted file (git.mergeEditor), and we replace that tab.
//
// Both are pure functions of their inputs so every row of the table is a unit
// test; the listeners that feed them live in autoRouteHost.ts.
//
// One `autoOpen` meaning gates both routes AND the dashboard auto-show. The
// exit guard gates both routes (Merge Studio's reroute ignored it). D4:
// `defers` (another product owns automatic behaviour) gates both.

import type { MergeSettings } from "@gitstudio/host-bridge/conflictsProtocol";

export type SkipReason =
  | "auto-open-off"
  | "deferred"
  | "not-a-file"
  | "just-routed"
  | "exited"
  | "launched-in-ide";

export type RouteAction =
  /** Leave the file where it is. */
  | { kind: "skip"; reason: SkipReason }
  /** Not conflicted (any more): lift the exit guard and the "launched in IDE" memory. */
  | { kind: "forget" }
  /** Open the embedded merge editor. `fallbackNotice`: the IDE was wanted but none is installed. */
  | { kind: "embedded"; fallbackNotice: boolean }
  /** Hand the conflict to the installed JetBrains IDE. */
  | { kind: "jetbrains" };

export interface ActiveEditorInput {
  /** The document's URI scheme; only "file" documents are routed. */
  scheme: string;
  autoOpen: boolean;
  /** D4: another product owns automatic behaviour. */
  defers: boolean;
  /** Routed within the last ROUTE_GUARD_MS (focus bounces must not re-open it). */
  recentlyRouted: boolean;
  /** The user exited the viewer for this file. */
  exited: boolean;
  /** The IDE was already launched for this file this session. */
  launchedInIde: boolean;
  /** Whether git reports the file unmerged. Only asked when the cheap gates pass. */
  conflicted: boolean;
  resolver: MergeSettings["conflictResolver"];
  ideAvailable: boolean;
}

/** How long a routed file is left alone, so an editor focus bounce cannot re-open it. */
export const ROUTE_GUARD_MS = 1500;

/** How long a rerouted built-in tab's file is left alone. */
export const REROUTE_GUARD_MS = 3000;

/**
 * The cheap gates, before asking git whether the file is conflicted. The host
 * only spends a git call when this returns undefined.
 */
export function activeEditorGate(
  i: Omit<ActiveEditorInput, "conflicted" | "exited" | "launchedInIde" | "resolver" | "ideAvailable">,
): RouteAction | undefined {
  if (!i.autoOpen) {
    return { kind: "skip", reason: "auto-open-off" };
  }
  if (i.defers) {
    return { kind: "skip", reason: "deferred" };
  }
  if (i.scheme !== "file") {
    return { kind: "skip", reason: "not-a-file" };
  }
  if (i.recentlyRouted) {
    return { kind: "skip", reason: "just-routed" };
  }
  return undefined;
}

/** What to do with a conflicted-or-not file that just became the active editor. */
export function decideActiveEditorRoute(i: ActiveEditorInput): RouteAction {
  const gate = activeEditorGate(i);
  if (gate) {
    return gate;
  }
  if (!i.conflicted) {
    return { kind: "forget" };
  }
  if (i.exited) {
    return { kind: "skip", reason: "exited" };
  }
  if (i.resolver === "jetbrains" && i.ideAvailable) {
    return i.launchedInIde
      ? { kind: "skip", reason: "launched-in-ide" }
      : { kind: "jetbrains" };
  }
  return { kind: "embedded", fallbackNotice: i.resolver === "jetbrains" };
}

export interface MergeTabInput {
  autoOpen: boolean;
  defers: boolean;
  /** This file's built-in tab was rerouted within REROUTE_GUARD_MS. */
  recentlyRerouted: boolean;
  /** The user exited OUR viewer for this file — they chose the built-in one. */
  exited: boolean;
  resolver: MergeSettings["conflictResolver"];
  ideAvailable: boolean;
}

export type RerouteAction =
  | { kind: "keep"; reason: "auto-open-off" | "deferred" | "just-rerouted" | "exited" }
  /** Close the built-in tab and open ours. */
  | { kind: "reroute"; to: "embedded" | "jetbrains"; fallbackNotice: boolean };

/** What to do with VS Code's own 3-way merge tab for a file. */
export function decideMergeTabReroute(i: MergeTabInput): RerouteAction {
  if (!i.autoOpen) {
    return { kind: "keep", reason: "auto-open-off" };
  }
  if (i.defers) {
    return { kind: "keep", reason: "deferred" };
  }
  if (i.recentlyRerouted) {
    return { kind: "keep", reason: "just-rerouted" };
  }
  if (i.exited) {
    return { kind: "keep", reason: "exited" };
  }
  if (i.resolver === "jetbrains" && i.ideAvailable) {
    return { kind: "reroute", to: "jetbrains", fallbackNotice: false };
  }
  return { kind: "reroute", to: "embedded", fallbackNotice: i.resolver === "jetbrains" };
}

/**
 * Duck-types VS Code's built-in merge tab (TabInputTextMerge): it uniquely
 * carries input1 / input2 / result URIs. Typed structurally so the package
 * does not need a vscode API newer than the extensions' engines floor.
 */
export function mergeTabResult<U>(input: unknown): U | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const i = input as { input1?: U; input2?: U; result?: U };
  return i.result && i.input1 && i.input2 ? i.result : undefined;
}
