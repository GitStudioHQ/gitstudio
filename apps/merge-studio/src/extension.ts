// Merge Studio: a thin shell over GitStudio's shared merge packages.
//
// This file builds MS_PRODUCT (brand, `jbMerge` ids and settings, support
// links, a modal for its few questions, repositories from VS Code's git
// extension) and hands it to @gitstudio/merge-vscode's registrar, which
// registers the merge editor, the conflicts dashboard, routing, the status
// item, the JetBrains hand-off, the diff panel and the coexistence question.
// What stays here is brand-only: the walkthrough, the context key that
// switches its "Using GitStudio too?" step, and one legacy setting value.
//
// When a GitStudio with this same merge experience is installed with
// `gitstudio.merge.autoOpen` on, GitStudio owns everything automatic (decision
// D4) and Merge Studio says so once; the rule and the notice are merge-vscode's
// (shouldDeferToGitStudio, maybeSayDeferred), and Merge Studio's commands keep
// working. An older GitStudio, without the dashboard, is never deferred to.

import * as vscode from "vscode";
import { hasSharedMergeExperience, shouldDeferToGitStudio, type MergePeerApi } from "@gitstudio/merge-vscode/product";
import { registerMergeExperience } from "@gitstudio/merge-vscode/register";
import { VscodeGitLocator } from "@gitstudio/merge-vscode/vscodeGitLocator";
import {
  MS_DEFERS_CONTEXT_KEY,
  MS_SETTINGS_SECTION,
  MS_WALKTHROUGH_COMMAND,
  MS_WALKTHROUGH_FULL_ID,
  MS_WALKTHROUGH_SHOWN_KEY,
} from "./ids";
import { LateLocator } from "./lateLocator";
import { supportLinks } from "./links";
import { buildMsProduct } from "./msProduct";
import {
  decideWalkthrough,
  GITSTUDIO_AUTO_OPEN_SECTION,
  GITSTUDIO_EXTENSION_ID,
  gitStudioFacts,
  legacySettingUpdates,
  legacyStateUpdates,
  modalAsk,
} from "./shell";

/** The longest a fresh window waits for its repositories before the walkthrough decides. */
const WALKTHROUGH_SETTLE_MS = 5000;

/**
 * What Merge Studio's `activate` returns: what GitStudio reads from it
 * (vscode.extensions.getExtension("gitstudio.merge-studio").exports).
 */
export interface MergeStudioApi {
  readonly mergePeer: MergePeerApi;
}

export function activate(context: vscode.ExtensionContext): MergeStudioApi {
  const locator = new LateLocator();
  context.subscriptions.push(locator);

  const defersTo = (): boolean =>
    shouldDeferToGitStudio(
      gitStudioFacts({
        extension: (id) => vscode.extensions.getExtension(id),
        setting: (section, key) => vscode.workspace.getConfiguration(section).get(key),
      }),
    );

  // What 0.3.4 left in globalState, read before the experience's first scan
  // (a Memento update is visible to get() at once).
  for (const update of legacyStateUpdates((key) => context.globalState.get(key))) {
    void context.globalState.update(update.key, update.value);
  }

  const MS_PRODUCT = buildMsProduct({
    locator,
    defersTo,
    ask: modalAsk((message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items)),
    supportLinks: supportLinks({
      version: String((context.extension.packageJSON as { version?: unknown }).version ?? ""),
      appName: vscode.env.appName,
      appVersion: vscode.version,
      uriScheme: vscode.env.uriScheme,
      platform: `${process.platform} ${process.arch}`,
    }),
  });
  const experience = registerMergeExperience(context, MS_PRODUCT);
  context.subscriptions.push(experience);

  // Repositories arrive when VS Code's git extension is ready; until then the
  // experience runs over an empty locator (commands work, nothing to scan).
  void VscodeGitLocator.create().then((git) => {
    if (git) {
      context.subscriptions.push(git);
      locator.bind(git);
    }
  });

  // The walkthrough's "Choose your merge editor" / "Using GitStudio too?" pair.
  const syncDefersContext = (): void => {
    void vscode.commands.executeCommand("setContext", MS_DEFERS_CONTEXT_KEY, defersTo());
  };
  syncDefersContext();
  context.subscriptions.push(
    vscode.extensions.onDidChange(syncDefersContext),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(GITSTUDIO_AUTO_OPEN_SECTION)) {
        syncDefersContext();
      }
    }),
  );

  registerWalkthrough(context, locator);
  void migrateLegacySettings();
  // GitStudio reads this: a question answered here (or by 0.3.4, counted by
  // legacyStateUpdates above) is not asked again when GitStudio owns it.
  return { mergePeer: experience.peerApi };
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}

function registerWalkthrough(context: vscode.ExtensionContext, locator: LateLocator): void {
  const open = () =>
    vscode.commands.executeCommand("workbench.action.openWalkthrough", MS_WALKTHROUGH_FULL_ID, false);
  context.subscriptions.push(vscode.commands.registerCommand(MS_WALKTHROUGH_COMMAND, open));

  // "Already shown" follows the user to their other machines: it is in
  // MS_PRODUCT.syncedStateKeys, and merge-vscode sets the extension's one sync
  // list (a second setKeysForSync here would replace it).

  if (context.globalState.get<boolean>(MS_WALKTHROUGH_SHOWN_KEY)) {
    return;
  }
  let disposed = false;
  context.subscriptions.push(new vscode.Disposable(() => (disposed = true)));
  void whenRepositoriesSettle(locator, WALKTHROUGH_SETTLE_MS).then(async () => {
    if (disposed) {
      return;
    }
    const decision = decideWalkthrough({
      shown: Boolean(context.globalState.get<boolean>(MS_WALKTHROUGH_SHOWN_KEY)),
      openOnInstall: vscode.workspace.getConfiguration().get("workbench.welcomePage.walkthroughs.openOnInstall"),
      busy: await anyRepositoryBusy(locator),
      gitStudioWalkthroughOnScreen: await gitStudioWalkthroughOpened(),
    });
    if (decision === "open" && !disposed) {
      await context.globalState.update(MS_WALKTHROUGH_SHOWN_KEY, true);
      await open();
    }
  });
}

/**
 * Resolves once the git extension has reported a repository, or after
 * `maxMs` (a window with no repository, or git turned off).
 */
function whenRepositoriesSettle(locator: LateLocator, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      subscription.dispose();
      clearTimeout(timer);
      resolve();
    };
    const subscription = locator.onDidChange(() => {
      if (locator.bound && locator.all().length > 0) finish();
    });
    const timer = setTimeout(finish, maxMs);
  });
}

/** GitStudio (with this merge experience) opened its own walkthrough in this session. */
async function gitStudioWalkthroughOpened(): Promise<boolean> {
  const gs = vscode.extensions.getExtension(GITSTUDIO_EXTENSION_ID);
  if (!gs || !hasSharedMergeExperience(gs.packageJSON)) {
    return false;
  }
  try {
    const api = (gs.isActive ? gs.exports : await gs.activate()) as { mergePeer?: MergePeerApi } | undefined;
    return api?.mergePeer?.walkthroughOpenedThisSession?.() === true;
  } catch {
    return false;
  }
}

/** An operation in progress or unmerged files in any open repository (then the dashboard has the stage). */
async function anyRepositoryBusy(locator: LateLocator): Promise<boolean> {
  const detections = await Promise.all(
    locator.all().map((repo) => repo.ctx.operation.detect().catch(() => ({ kind: "none" as const, unmerged: 0 }))),
  );
  return detections.some((d) => d.kind !== "none" || d.unmerged > 0);
}

async function migrateLegacySettings(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration(MS_SETTINGS_SECTION);
    for (const update of legacySettingUpdates((key) => config.inspect(key))) {
      await config.update(update.key, update.value, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // Best effort: the old value keeps working either way.
  }
}
