import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { closesWithoutPrompt, twoFileState, DiffPanel } from "./diffPanel";
import type { MergeHostCore } from "./host";
import { isOwnDiff } from "./ownDiffs";
import type { MergePeerApi } from "./product";

const SETTING = "useAsDefaultDiffViewer";
const GITSTUDIO_SETTING = `gitstudio.merge.${SETTING}`;

/**
 * The schemes a routed diff may have: files, Compare with Saved, and Git's
 * and GitStudio's revisions on either side; an unsaved buffer on the right
 * only. A diff of anything else stays in VS Code's diff editor, because that
 * editor is where its owner's actions live: a pull request's review threads
 * (GitStudio's own `gitstudio-pr`, GitHub Pull Requests), AI edit review,
 * Settings Sync conflicts, other extensions' revisions with their own
 * toolbar. An untitled LEFT side (Compare New Untitled Text Files) stays
 * native too: the comparison's left side is read-only, and there the user
 * means to type into both.
 */
export const ROUTABLE_SCHEMES: ReadonlySet<string> = new Set([
  "file",
  "vscode-remote",
  "showModifications",
  "git",
  "gitstudio-rev",
]);
const ROUTABLE_RIGHT_SCHEMES: ReadonlySet<string> = new Set([...ROUTABLE_SCHEMES, "untitled"]);

/** Stable VS Code APIs expose diff tabs, but not a custom diff-editor provider. */
export function registerDiffAutoRoute(host: MergeHostCore): vscode.Disposable {
  let disposed = false;
  let pending = Promise.resolve();
  let visited = new WeakMap<vscode.Tab, string>();
  /** Diff tabs the product opened from its own views (ownDiffs.ts): never routed, even after a settings change. */
  const ownTabs = new WeakMap<vscode.Tab, string>();
  /**
   * Comparisons standing in for a preview tab, at most one per editor group:
   * the next preview in that group replaces an untouched one, as VS Code's
   * preview does. One the user opened for keeps never becomes one.
   */
  const standIns = new Set<DiffPanel>();
  const kept = new WeakSet<DiffPanel>();

  const enabled = (): boolean => {
    if (!vscode.workspace.getConfiguration(host.product.settingsSection).get<boolean>(SETTING, false)) {
      return false;
    }
    if (host.product.key !== "merge-studio") {
      return true;
    }
    const peer = vscode.extensions.getExtension("gitstudio.gitstudio");
    const configuration = peer?.packageJSON?.contributes?.configuration;
    const sections = Array.isArray(configuration) ? configuration : [configuration];
    const peerSupportsRouting = sections.some((section) => section?.properties?.[GITSTUDIO_SETTING]);
    return !peerSupportsRouting ||
      !vscode.workspace.getConfiguration("gitstudio.merge").get<boolean>(SETTING, false);
  };

  const present = (tab: vscode.Tab): boolean =>
    vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab));

  const identity = (input: vscode.TabInputTextDiff): string =>
    `${input.original.toString()}\u0000${input.modified.toString()}`;

  /**
   * A diff opened by this product's own views, or, for Merge Studio, by
   * GitStudio's (which it asks through GitStudio's API: an older GitStudio
   * without `ownsDiff` cannot say, and its diffs are routed).
   */
  const ownDiff = (input: vscode.TabInputTextDiff): boolean => {
    const original = input.original.toString();
    const modified = input.modified.toString();
    if (isOwnDiff(original, modified)) {
      return true;
    }
    if (host.product.key !== "merge-studio") {
      return false;
    }
    const peer = vscode.extensions.getExtension("gitstudio.gitstudio");
    const api = peer?.isActive ? (peer.exports as { mergePeer?: MergePeerApi } | undefined) : undefined;
    return api?.mergePeer?.ownsDiff?.(original, modified) === true;
  };

  const routable = (input: vscode.TabInputTextDiff): boolean =>
    ROUTABLE_SCHEMES.has(input.original.scheme) && ROUTABLE_RIGHT_SCHEMES.has(input.modified.scheme);

  /**
   * Whether to leave keyboard focus where it is. The API cannot see focus,
   * so the native tab's own signals stand in: one in a background group, or
   * not in front, never had it; a preview tab is what a single click in a
   * list opens without moving focus (Source Control, Explorer, Timeline);
   * and another text editor being active means it kept focus.
   */
  const keepFocus = (tab: vscode.Tab, input: vscode.TabInputTextDiff, preview: boolean): boolean => {
    if (!tab.isActive || !tab.group.isActive || preview) {
      return true;
    }
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    return active !== undefined && active !== input.modified.toString() && active !== input.original.toString();
  };

  /** A routed preview replaces the untouched stand-in of its group; a routed non-preview is kept. */
  const settlePreview = (panel: DiffPanel, preview: boolean): void => {
    if (!preview) {
      kept.add(panel);
      standIns.delete(panel);
      return;
    }
    if (kept.has(panel) || standIns.has(panel)) {
      return; // a preview click on a comparison already open: VS Code just shows it
    }
    for (const other of [...standIns]) {
      if (other.touched) {
        standIns.delete(other); // edited (now kept) or closed
      } else if (other.viewColumn === panel.viewColumn) {
        standIns.delete(other);
        other.close();
      }
    }
    standIns.add(panel);
  };

  const route = async (tab: vscode.Tab, input: vscode.TabInputTextDiff): Promise<void> => {
    const current = (): boolean => present(tab) &&
      tab.input instanceof vscode.TabInputTextDiff && identity(tab.input) === identity(input);
    if (disposed || !enabled() || !current()) {
      return;
    }
    const { original, modified } = input;
    // Resolve the actual revisions, including virtual Git/extension documents,
    // before replacing anything. Never substitute HEAD for the original URI.
    // One that cannot be read as text (binary, too large, gone) stays in VS
    // Code's tab, which already shows what it can: nothing to report.
    try {
      await Promise.all([
        vscode.workspace.openTextDocument(original),
        vscode.workspace.openTextDocument(modified),
      ]);
    } catch {
      return;
    }
    if (disposed || !enabled() || !current()) {
      return;
    }
    const state = twoFileState(original, modified);
    state.title = tab.label;
    state.rightEditable = modified.scheme === "untitled" ||
      vscode.workspace.fs.isWritableFileSystem(modified.scheme) === true;
    state.keepRightDocumentOpen = state.rightEditable;
    // Read now, not before loading: a double click pins the tab meanwhile.
    const preview = tab.isPreview;
    const panel = await DiffPanel.create(host, state, {
      viewColumn: tab.group.viewColumn,
      preserveFocus: keepFocus(tab, input, preview),
    });
    settlePreview(panel, preview);
    // A dirty tab owns Save/Discard prompts unless VS Code would close it
    // without asking. Keep it until the user saves or closes it, rather than
    // raising a prompt nobody asked for (whose "Don't Save" reverts).
    if (!disposed && enabled() && current() && (!tab.isDirty || closesWithoutPrompt(tab, original, modified))) {
      await vscode.window.tabGroups.close(tab, true);
    }
  };

  const enqueue = (tabs: readonly vscode.Tab[]): void => {
    if (disposed) {
      return;
    }
    // Own diffs are noted even while routing is off, so turning it on later
    // never takes one of them over.
    const on = enabled();
    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff) || ownTabs.get(tab) === identity(tab.input)) {
        continue;
      }
      if (ownDiff(tab.input)) {
        ownTabs.set(tab, identity(tab.input));
        continue;
      }
      // Only the tab in front of its group: a background tab (restored at
      // startup, or open when the setting is turned on) is routed when it is
      // brought forward, so routing never reorders a group or changes what
      // it shows.
      if (!on || !tab.isActive || !routable(tab.input) || visited.get(tab) === identity(tab.input)) {
        continue;
      }
      const input = tab.input;
      visited.set(tab, identity(input));
      pending = pending.then(() => route(tab, input)).catch((error: unknown) => {
        void host.notify("error", l10n.t("couldn't load the diff — {0}", error instanceof Error ? error.message : String(error)));
      });
    }
  };

  const scan = (): void => enqueue(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
  const subscriptions = [
    vscode.window.tabGroups.onDidChangeTabs((event) => enqueue([...event.opened, ...event.changed])),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${host.product.settingsSection}.${SETTING}`) ||
          event.affectsConfiguration(GITSTUDIO_SETTING)) {
        visited = new WeakMap();
        scan();
      }
    }),
    vscode.extensions.onDidChange(scan),
  ];
  scan();
  return new vscode.Disposable(() => {
    disposed = true;
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });
}
