// MS_PRODUCT: what is Merge Studio's in the shared merge experience — ids,
// brand, settings under `jbMerge`, the dashboard's support links, how a
// question is asked, and where repositories come from. Everything else (the
// merge editor, the conflicts dashboard, routing, the JetBrains hand-off, the
// diff panel, the coexistence question) is @gitstudio/merge-vscode, the code
// GitStudio runs too.
//
// vscode-free at runtime (only vscode-free modules are imported): extension.ts
// supplies the parts that touch the editor, so the product itself is
// unit-tested.

import {
  hasSharedMergeExperience,
  type AskSpec,
  type MergeProduct,
  type RepoLocator,
  type SidesTipFacts,
} from "@gitstudio/merge-vscode/product";
import {
  MS_COEXISTENCE_PROMPT_KEY,
  MS_IDE_CONTEXT_KEY,
  MS_MERGE_COMMANDS,
  MS_MERGE_VIEW_TYPES,
  MS_OUTDATED_GITSTUDIO_NOTICE_KEY,
  MS_SETTINGS_SECTION,
  MS_STATUS_ITEM_ID,
  MS_WALKTHROUGH_SHOWN_KEY,
} from "./ids";
import { GITSTUDIO_DEFERRAL, GITSTUDIO_EXTENSION_ID } from "./shell";

export interface MsProductParts {
  locator: RepoLocator;
  ask(spec: AskSpec): Promise<boolean>;
  /** D4: merge-vscode's shouldDeferToGitStudio over the current facts. */
  defersTo(): boolean;
  supportLinks: { label: string; url: string }[];
  /** POLISH A5.9: this activation is an upgrade from 0.3.4 (setUpSidesTip). */
  sidesTip?: SidesTipFacts;
}

export function buildMsProduct(parts: MsProductParts): MergeProduct {
  return {
    key: "merge-studio",
    brand: { name: "Merge Studio", mark: "merge-studio" },
    displayName: "Merge Studio",
    settingsSection: MS_SETTINGS_SECTION,
    viewTypes: MS_MERGE_VIEW_TYPES,
    commands: MS_MERGE_COMMANDS,
    ideAvailableContextKey: MS_IDE_CONTEXT_KEY,
    statusItemId: MS_STATUS_ITEM_ID,
    coexistencePromptKey: MS_COEXISTENCE_PROMPT_KEY,
    supportLinks: parts.supportLinks,
    locator: parts.locator,
    ask: parts.ask,
    defersTo: parts.defersTo,
    // D4, said once: "GitStudio is installed, so GitStudio opens your conflicts…"
    deferral: GITSTUDIO_DEFERRAL,
    ...(parts.sidesTip ? { sidesTip: parts.sidesTip } : {}),
    // GitStudio: its answer to the coexistence question counts here, and a
    // GitStudio 1.13.0 (no dashboard, rebase sides swapped) that races this
    // one is named once (POLISH A5.1, skew-a).
    peer: {
      extensionId: GITSTUDIO_EXTENSION_ID,
      displayName: "GitStudio",
      sharedMerge: hasSharedMergeExperience,
      outdatedNoticeKey: MS_OUTDATED_GITSTUDIO_NOTICE_KEY,
    },
    // Follows the user to their other machines, with the shared answers
    // (merge-vscode sets the extension's one sync list).
    syncedStateKeys: [MS_WALKTHROUGH_SHOWN_KEY],
    // No runWithUndo: Merge Studio has no undo ledger of its own; a resolved
    // file is undone from the dashboard (hold to undo). No openChangesEmbedded
    // or compareSingle: Open Changes and a one-file Compare use the embedded
    // diff against HEAD, as 0.3.4 did.
  };
}
