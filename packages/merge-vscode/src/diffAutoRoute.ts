import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { twoFileState, DiffPanel } from "./diffPanel";
import type { MergeHostCore } from "./host";

const SETTING = "useAsDefaultDiffViewer";
const GITSTUDIO_SETTING = `gitstudio.merge.${SETTING}`;

/** Stable VS Code APIs expose diff tabs, but not a custom diff-editor provider. */
export function registerDiffAutoRoute(host: MergeHostCore): vscode.Disposable {
  let disposed = false;
  let pending = Promise.resolve();
  let visited = new WeakMap<vscode.Tab, string>();

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

  const route = async (tab: vscode.Tab, input: vscode.TabInputTextDiff): Promise<void> => {
    const current = (): boolean => present(tab) &&
      tab.input instanceof vscode.TabInputTextDiff && identity(tab.input) === identity(input);
    if (disposed || !enabled() || !current()) {
      return;
    }
    const { original, modified } = input;
    // Resolve the actual revisions, including virtual Git/extension documents,
    // before replacing anything. Never substitute HEAD for the original URI.
    await Promise.all([
      vscode.workspace.openTextDocument(original),
      vscode.workspace.openTextDocument(modified),
    ]);
    if (disposed || !enabled() || !current()) {
      return;
    }
    const state = twoFileState(original, modified);
    state.title = tab.label;
    state.rightEditable = modified.scheme === "untitled" ||
      vscode.workspace.fs.isWritableFileSystem(modified.scheme) === true;
    state.keepRightDocumentOpen = state.rightEditable;
    await DiffPanel.create(host, state, {
      viewColumn: tab.group.viewColumn,
      preserveFocus: !tab.isActive || !tab.group.isActive,
    });
    // A dirty tab owns Save/Discard prompts. Keep it until the user saves or
    // closes it, rather than implicitly discarding edits during redirection.
    if (!disposed && enabled() && current() && !tab.isDirty) {
      await vscode.window.tabGroups.close(tab, true);
    }
  };

  const enqueue = (tabs: readonly vscode.Tab[]): void => {
    if (disposed || !enabled()) {
      return;
    }
    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff) || visited.get(tab) === identity(tab.input)) {
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
