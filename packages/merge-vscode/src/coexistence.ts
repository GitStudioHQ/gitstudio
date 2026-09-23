// The question about VS Code's own merge UI (PLAN matrix row 5; POLISH A5.2).
//
// VS Code's built-in 3-way merge editor (`git.mergeEditor`) and the
// merge-conflict extension's CodeLens and decorations compete with ours for
// the same file. The product asks whether to turn them off:
//
// - in BOTH products at the FIRST CONFLICT — someone who never merges is never
//   asked (Merge Studio used to ask with a modal at first activation);
// - NON-modally, as a toast with three answers — never a modal, never the
//   Changes view's in-view dialog popped from a background scan (it could
//   collide with a dialog already open there);
// - recorded ONLY after an explicit answer: "Turn them off" and "Don't ask
//   again" are remembered (and synced); "Not now" and a dismissal are not, so
//   the question comes back at the next conflict. It used to be recorded
//   before it was shown, so a question that never appeared was never asked;
// - reversibly: the values it changes are saved first, and "<Brand>: Restore
//   VS Code's Merge Editor" writes them back (the confirmation toast offers it
//   as Undo too).
//
// Nothing is asked when nothing competes, or while another product owns the
// automatic behaviour (D4). A product standing down says so instead, once
// (maybeSayDeferred).

import * as vscode from "vscode";
import type { MergeHostCore } from "./host";
import { COMPETING_BUILT_INS, competingBuiltIns, type MergeProduct } from "./product";

const TURN_OFF = "Turn them off";
const NOT_NOW = "Not now";
const NEVER = "Don't ask again";

/** Products with the question on screen right now (scans call in quick succession). */
const onScreen = new WeakSet<object>();

/** globalState key holding the values "Turn them off" replaced. */
function previousKey(promptKey: string): string {
  return `${promptKey}.previous`;
}

/**
 * Every globalState key of this product that follows the user to their other
 * machines: the product's own (its walkthrough, …) and the answers kept here.
 * VS Code keeps ONE list per extension and each setKeysForSync call replaces
 * it, so registerMergeExperience sets this whole list once; nothing else may
 * call setKeysForSync (it used to be called here with only these two keys,
 * which dropped Merge Studio's walkthrough key from sync at the first conflict).
 */
export function syncedKeys(product: MergeProduct): string[] {
  return [
    ...new Set([
      ...(product.syncedStateKeys ?? []),
      product.coexistencePromptKey,
      previousKey(product.coexistencePromptKey),
      ...(product.deferral ? [product.deferral.noticeKey] : []),
    ]),
  ];
}

export async function maybeOfferCoexistence(host: MergeHostCore): Promise<void> {
  const { context, product } = host;
  if (
    onScreen.has(context) ||
    host.defers() ||
    context.globalState.get<boolean>(product.coexistencePromptKey)
  ) {
    return;
  }
  const config = vscode.workspace.getConfiguration();
  if (competingBuiltIns((key) => config.get(key)).length === 0) {
    return;
  }
  onScreen.add(context);
  let choice: string | undefined;
  try {
    choice = await host.notify(
      "info",
      "conflicted files now open in its merge editor. Turn off VS Code's own merge editor and conflict " +
        "highlights so they don't open alongside it? You can switch back any time with " +
        `"${product.displayName}: Restore VS Code's Merge Editor".`,
      TURN_OFF,
      NOT_NOW,
      NEVER,
    );
  } finally {
    onScreen.delete(context);
  }
  if (choice === NEVER) {
    await context.globalState.update(product.coexistencePromptKey, true);
    return;
  }
  if (choice !== TURN_OFF) {
    return; // "Not now", or dismissed: nothing is remembered.
  }
  // What the user had, so Restore can put it back exactly (a value they had
  // set themselves stays theirs; an unset one goes back to VS Code's default).
  const previous: Record<string, unknown> = {};
  for (const { key } of COMPETING_BUILT_INS) {
    previous[key] = config.inspect(key)?.globalValue ?? null;
  }
  await context.globalState.update(previousKey(product.coexistencePromptKey), previous);
  // All three, stated explicitly — `git.mergeEditor` is off by default today,
  // and an explicit value keeps it off if that default ever changes.
  for (const { key, off } of COMPETING_BUILT_INS) {
    await config.update(key, off, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update(product.coexistencePromptKey, true);
  void host.notify("info", "VS Code's own merge editor and conflict highlights are off.", "Undo").then((c) => {
    if (c === "Undo") {
      void restoreBuiltIns(host);
    }
  });
}

const OK = "OK";

/**
 * D4, said once (POLISH A5.8): the first conflict at which this product
 * stands down, it tells the user who opens their conflicts instead, that its
 * own commands still work, and offers to have it the other way round — which
 * sets the owner's `autoOpen` to false (user settings), so this product takes
 * the automatic behaviour back at once.
 *
 * Remembered AS IT IS SAID. It is information, not a question: nothing hangs
 * on an answer, and a notice left in the notification center (VS Code moves
 * an unanswered toast there after a while) must not come back at every
 * session. The button still works from the center, whenever it is pressed.
 * (The coexistence QUESTION is the opposite: remembered only once answered.)
 *
 * @returns true when the user handed the automatic behaviour back.
 */
export async function maybeSayDeferred(host: MergeHostCore): Promise<boolean> {
  const { context, product } = host;
  const deferral = product.deferral;
  if (!deferral || context.globalState.get<boolean>(deferral.noticeKey)) {
    return false;
  }
  // Set before the first await (a Memento's value is visible at once), so a
  // second scan in the same moment finds it and says nothing.
  const remembered = context.globalState.update(deferral.noticeKey, true);
  const takeOver = `Let ${product.displayName} open conflicts`;
  const choice = await host.notify(
    "info",
    `${deferral.owner} is installed, so ${deferral.owner} opens your conflicts, with the same merge editor and ` +
      `Conflicts dashboard. ${product.displayName}'s own commands still work.`,
    OK,
    takeOver,
  );
  await remembered;
  if (choice !== takeOver) {
    return false;
  }
  await vscode.workspace
    .getConfiguration(deferral.handBack.section)
    .update(deferral.handBack.key, false, vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * `autoOpen` was just turned off: the product no longer opens conflicted
 * files, so the built-ins it switched off are worth having back. Offered only
 * when this product is the one that switched them off.
 */
export async function offerRestoreAfterAutoOpenOff(host: MergeHostCore): Promise<void> {
  const { context, product } = host;
  if (host.settings().autoOpen) return;
  if (!context.globalState.get(previousKey(product.coexistencePromptKey))) return;
  const restore = "Restore";
  const choice = await host.notify(
    "info",
    "automatic opening is off. Turn VS Code's own merge editor and conflict highlights back on?",
    restore,
  );
  if (choice === restore) {
    await restoreBuiltIns(host);
  }
}

/**
 * "<Brand>: Restore VS Code's Merge Editor": write back what "Turn them off"
 * replaced; with nothing saved, remove the user-level values so VS Code's own
 * defaults apply.
 */
export async function restoreBuiltIns(host: MergeHostCore): Promise<void> {
  const { context, product } = host;
  const config = vscode.workspace.getConfiguration();
  const saved = context.globalState.get<Record<string, unknown>>(previousKey(product.coexistencePromptKey));
  for (const { key } of COMPETING_BUILT_INS) {
    const value = saved && key in saved ? saved[key] : null;
    await config.update(key, value === null ? undefined : value, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update(previousKey(product.coexistencePromptKey), undefined);
  void host.notify("info", "VS Code's own merge editor and conflict highlights are as they were.");
}
