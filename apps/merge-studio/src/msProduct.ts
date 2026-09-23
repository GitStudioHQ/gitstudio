// MS_PRODUCT: what is Merge Studio's in the shared merge experience — ids,
// brand, settings under `jbMerge`, the dashboard's support links, how a
// question is asked, and where repositories come from. Everything else (the
// merge editor, the conflicts dashboard, routing, the JetBrains hand-off, the
// diff panel, the coexistence question) is @gitstudio/merge-vscode, the code
// GitStudio runs too.
//
// vscode-free at runtime (type-only imports): extension.ts supplies the parts
// that touch the editor, so the product itself is unit-tested.

import type { AskSpec, MergeProduct, RepoLocator } from "@gitstudio/merge-vscode/product";
import {
  MS_COEXISTENCE_PROMPT_KEY,
  MS_IDE_CONTEXT_KEY,
  MS_MERGE_COMMANDS,
  MS_MERGE_VIEW_TYPES,
  MS_SETTINGS_SECTION,
  MS_STATUS_ITEM_ID,
} from "./ids";

export interface MsProductParts {
  locator: RepoLocator;
  ask(spec: AskSpec): Promise<boolean>;
  /** D4: merge-vscode's shouldDeferToGitStudio over the current facts. */
  defersTo(): boolean;
  supportLinks: { label: string; url: string }[];
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
    // No runWithUndo: Merge Studio has no undo ledger of its own; a resolved
    // file is undone from the dashboard (hold to undo). No openChangesEmbedded
    // or compareSingle: Open Changes and a one-file Compare use the embedded
    // diff against HEAD, as 0.3.4 did.
  };
}
