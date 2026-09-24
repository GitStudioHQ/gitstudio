// The listeners behind automatic routing: the active text editor, and VS
// Code's own merge tabs. Every decision is autoRoute.ts's pure table; this
// file only gathers its inputs and carries out the answer.

import * as vscode from "vscode";
import { locate } from "./args";
import {
  activeEditorGate,
  decideActiveEditorRoute,
  decideMergeTabReroute,
  mergeTabResult,
  REROUTE_GUARD_MS,
  ROUTE_GUARD_MS,
} from "./autoRoute";
import { closeTextTabs, type MergeHostCore } from "./host";
import type { JetBrainsUi } from "./jetbrainsUi";

export function registerAutoRoute(
  host: MergeHostCore,
  jetbrains: JetBrainsUi,
  openEmbedded: (uri: vscode.Uri) => Promise<void>,
): vscode.Disposable {
  const recentlyRouted = new Set<string>();
  const recentlyRerouted = new Set<string>();

  const remember = (set: Set<string>, key: string, ms: number) => {
    set.add(key);
    setTimeout(() => set.delete(key), ms);
  };

  const maybeRoute = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    const key = uri.toString();
    const s = host.settings();
    const cheap = {
      scheme: uri.scheme,
      autoOpen: s.autoOpen,
      defers: host.defers(),
      recentlyRouted: recentlyRouted.has(key),
    };
    if (activeEditorGate(cheap)) {
      return;
    }
    const target = locate(host.product.locator, uri);
    let conflicted = false;
    if (target) {
      try {
        conflicted = await target.repo.ctx.conflict.isConflicted(target.rel);
      } catch {
        conflicted = false;
      }
    }
    const ide = conflicted && s.conflictResolver === "jetbrains" ? await jetbrains.detect() : undefined;
    const action = decideActiveEditorRoute({
      ...cheap,
      recentlyRouted: recentlyRouted.has(key),
      exited: host.exitGuard.isSuppressed(key),
      launchedInIde: jetbrains.wasLaunched(key),
      conflicted,
      resolver: s.conflictResolver,
      ideAvailable: Boolean(ide),
    });
    switch (action.kind) {
      case "forget":
        host.exitGuard.clear(key);
        jetbrains.forget(key);
        return;
      case "skip":
        return;
      case "jetbrains":
        remember(recentlyRouted, key, ROUTE_GUARD_MS);
        await jetbrains.merge(uri);
        return;
      case "embedded":
        remember(recentlyRouted, key, ROUTE_GUARD_MS);
        if (action.fallbackNotice) {
          jetbrains.notifyEmbeddedFallback();
        }
        await openEmbedded(uri);
        // One tab per file: a text tab opened pinned (Quick Open) stayed
        // beside the merge editor, as the built-in reroute below never lets
        // it (POLISH A1.3).
        await closeTextTabs(uri);
        return;
    }
  };

  const rerouteTabs = async (): Promise<void> => {
    const s = host.settings();
    if (!s.autoOpen || host.defers()) {
      return; // the table would keep every tab; skip the walk
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const result = mergeTabResult<vscode.Uri>(tab.input);
        if (!result) {
          continue;
        }
        const key = result.toString();
        const ide = s.conflictResolver === "jetbrains" ? await jetbrains.detect() : undefined;
        const action = decideMergeTabReroute({
          autoOpen: s.autoOpen,
          defers: host.defers(),
          recentlyRerouted: recentlyRerouted.has(key),
          exited: host.exitGuard.isSuppressed(key),
          resolver: s.conflictResolver,
          ideAvailable: Boolean(ide),
        });
        if (action.kind === "keep") {
          continue;
        }
        remember(recentlyRerouted, key, REROUTE_GUARD_MS);
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          // already gone
        }
        if (action.to === "jetbrains") {
          await jetbrains.merge(result);
        } else {
          if (action.fallbackNotice) {
            jetbrains.notifyEmbeddedFallback();
          }
          await openEmbedded(result);
        }
      }
    }
  };

  const subs = [
    vscode.window.onDidChangeActiveTextEditor((editor) => void maybeRoute(editor)),
    vscode.window.tabGroups.onDidChangeTabs(() => void rerouteTabs()),
  ];
  void maybeRoute(vscode.window.activeTextEditor);
  void rerouteTabs();
  return vscode.Disposable.from(...subs);
}
