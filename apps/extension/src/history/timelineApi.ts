import * as vscode from "vscode";

// The Timeline API is finalized in the VS Code runtime (since 1.46) but the
// pinned `@types/vscode@1.74.0` ships these definitions only as a proposed
// `.d.ts` that isn't bundled. We declare the minimal shapes we use here so the
// provider is statically typed while still binding to the real runtime API.
//
// Mirrors the public `vscode.TimelineProvider` contract — see the VS Code API
// docs for `TimelineProvider`, `Timeline`, and `TimelineItem`.

export interface TimelineOptions {
  /** A provider-defined cursor for paging older items. */
  cursor?: string;
  /** The maximum number of items, or a timestamp/id to page from. */
  limit?: number | { timestamp: number; id?: string };
}

export interface TimelinePaging {
  /** The cursor to pass back in to fetch the next (older) page. */
  cursor: string | undefined;
}

export interface Timeline {
  readonly paging?: TimelinePaging;
  items: TimelineItem[];
}

export interface TimelineChangeEvent {
  /** The uri whose timeline changed, or undefined for all. */
  uri?: vscode.Uri;
  /** Reset the whole timeline rather than appending. */
  reset?: boolean;
}

export interface TimelineItem {
  timestamp: number;
  label: string;
  id?: string;
  iconPath?: vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri };
  description?: string;
  detail?: string | vscode.MarkdownString;
  command?: vscode.Command;
  contextValue?: string;
  accessibilityInformation?: vscode.AccessibilityInformation;
}

/** The runtime `TimelineItem` constructor, fetched off the vscode namespace. */
interface TimelineItemCtor {
  new (label: string, timestamp: number): TimelineItem;
}

/** Constructs a runtime TimelineItem (the class lives on the vscode namespace). */
export function createTimelineItem(label: string, timestamp: number): TimelineItem {
  const ctor = (vscode as unknown as { TimelineItem: TimelineItemCtor })
    .TimelineItem;
  return new ctor(label, timestamp);
}

export interface TimelineProvider {
  onDidChange?: vscode.Event<TimelineChangeEvent | undefined>;
  readonly id: string;
  readonly label: string;
  provideTimeline(
    uri: vscode.Uri,
    options: TimelineOptions,
    token: vscode.CancellationToken,
  ): Timeline | Thenable<Timeline>;
}

/**
 * Registers a TimelineProvider against the runtime API (absent from the pinned
 * proposed typings). Returns a Disposable.
 */
export function registerTimelineProvider(
  scheme: string | string[],
  provider: TimelineProvider,
): vscode.Disposable {
  const ws = vscode.workspace as unknown as {
    registerTimelineProvider(
      scheme: string | string[],
      provider: TimelineProvider,
    ): vscode.Disposable;
  };
  return ws.registerTimelineProvider(scheme, provider);
}
