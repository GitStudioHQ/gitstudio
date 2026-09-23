// The branch-filter half of a `graphInit` (issue #30), applied the same way by
// every surface that receives one: the editor-area graph's webview entry, the
// sidebar rail's, and the desktop's GraphMount. Three copies of two lines is
// how one of them ends up treating an absent list as an empty one.

import type {
  GraphInitMessage,
  GraphRefEntry,
  GraphRefFilter,
  RefPreset,
} from "@gitstudio/host-bridge/graphProtocol";

/** What a graph surface keeps for its Branches picker. */
export interface RefPickerState {
  refFilter: GraphRefFilter;
  refPreset?: RefPreset;
  refList: GraphRefEntry[];
}

/**
 * Take a graphInit's filter, and its ref list WHEN IT CARRIES ONE.
 *
 * A host sends the list only when it changed since the last one it sent (the
 * list is every branch and tag — a megabyte on a repository with ten thousand
 * tags — and a refresh or a filter change almost never alters it). Absent is
 * "unchanged", never "empty": reading it as `[]` would empty the picker, and
 * a ref the filter had hidden could then never be ticked back in.
 */
export function applyGraphInitRefs(
  target: RefPickerState,
  message: Pick<GraphInitMessage, "refFilter" | "refPreset" | "refList">,
): void {
  target.refFilter = message.refFilter ?? null;
  // Every graphInit says which preset, if any — absent is "none", unlike the
  // list: a hand-picked selection after a preset must unlight it.
  target.refPreset = message.refPreset;
  if (message.refList) target.refList = message.refList;
}
