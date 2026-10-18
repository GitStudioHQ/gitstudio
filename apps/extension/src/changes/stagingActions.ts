import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import type { LineRange } from "@gitstudio/engine/staging/applyLineChanges";

// What a change in the editor offers to do with itself — the actions behind
// the hover and the CodeLens (#87, reopened). Kept free of the vscode module so
// the rules can be pinned by plain tests.
//
// Why a hover and not the gutter mark: VS Code gives an extension's gutter
// icon no click and no hover. An extension decoration carries only a TEXT
// hover (`hoverMessage`); VS Code's glyph-margin hover reads a separate field
// the extension API never sets. Verified in VS Code 1.142 for #87: resting the
// pointer on the mark, the line number or past the end of the line shows
// nothing; resting it on the changed text shows the hover, in a plain editor
// and on the modified side of a diff, and its links run.

/** What a hover or CodeLens can do to the change it belongs to. */
export type StagingVerb = "stage" | "unstage" | "stageLines" | "unstageLines";

/** Stages or unstages the whole change at a line — the right-click command's engine. */
export const SET_CHANGE_COMMAND = "gitstudio.staging.setChange";
/** Stages or unstages the selected lines of the editor showing a document. */
export const SET_SELECTED_LINES_COMMAND = "gitstudio.staging.setSelectedLines";

export interface SetChangeArgs {
  /** The document, as `Uri.toString()`. */
  uri: string;
  /** 0-based: a line of the change. */
  line: number;
  staged: boolean;
}

export interface SetSelectedLinesArgs {
  uri: string;
  staged: boolean;
}

/**
 * The verbs a change in `state` offers, in the order they are shown. Only what
 * would do something: a staged change cannot be staged, an unstaged one cannot
 * be unstaged. A partly staged change offers both directions — staging stages
 * the rest, unstaging takes back what was staged.
 *
 * The line verbs appear only while a selection touches the change: without one
 * they would mean the same as the whole-change verbs, and say it twice.
 */
export function verbsFor(state: ChangeBlock["state"], selectionTouches: boolean): StagingVerb[] {
  const verbs: StagingVerb[] = [];
  const canStage = state !== "staged";
  const canUnstage = state !== "unstaged";
  if (canStage) verbs.push("stage");
  if (canUnstage) verbs.push("unstage");
  if (selectionTouches && canStage) verbs.push("stageLines");
  if (selectionTouches && canUnstage) verbs.push("unstageLines");
  return verbs;
}

/**
 * Whether any of `ranges` (from selectionLines, of NON-empty selections) reaches
 * `block`. A deletion occupies no working line: it is reached by a range on, or
 * a boundary at, the line it sits above.
 */
export function selectionTouches(block: ChangeBlock, ranges: readonly LineRange[]): boolean {
  const start = block.working.start;
  const end = Math.max(block.working.start, block.working.end);
  return ranges.some((r) => (r.end < r.start ? r.start >= start && r.start <= end : r.start <= end && r.end >= start));
}

/** The command a verb runs, and its one argument. */
export function commandFor(
  verb: StagingVerb,
  uri: string,
  line: number,
): { command: string; args: SetChangeArgs | SetSelectedLinesArgs } {
  switch (verb) {
    case "stage":
      return { command: SET_CHANGE_COMMAND, args: { uri, line, staged: true } };
    case "unstage":
      return { command: SET_CHANGE_COMMAND, args: { uri, line, staged: false } };
    case "stageLines":
      return { command: SET_SELECTED_LINES_COMMAND, args: { uri, staged: true } };
    case "unstageLines":
      return { command: SET_SELECTED_LINES_COMMAND, args: { uri, staged: false } };
  }
}

/** A markdown `command:` link running `command` with `args` as its one argument. */
export function commandLink(command: string, args: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
}

/** Whether a hover link's argument is one this extension wrote (links can be typed into any markdown). */
export function isSetChangeArgs(a: unknown): a is SetChangeArgs {
  const o = a as SetChangeArgs | undefined;
  return !!o && typeof o.uri === "string" && Number.isInteger(o.line) && o.line >= 0 && typeof o.staged === "boolean";
}

export function isSetSelectedLinesArgs(a: unknown): a is SetSelectedLinesArgs {
  const o = a as SetSelectedLinesArgs | undefined;
  return !!o && typeof o.uri === "string" && typeof o.staged === "boolean";
}
