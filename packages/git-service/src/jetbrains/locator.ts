import type {
  JetBrainsIdeId,
  JetBrainsIdeInfo,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * Finds an installed JetBrains IDE to hand a merge or diff to (PLAN §3.5 W5).
 *
 * S0 contract seed: the signature is the contract; the body is a STUB that
 * finds nothing. P2 ports Merge Studio's locator (src/jetbrains/locator.ts:
 * explicit path first, then `preferred`, then the JETBRAINS_IDES order, on
 * PATH and in /Applications + ~/Applications) and adds the desktop's Toolbox
 * and Windows install directories (apps/desktop/src/main/editors.ts:124-145).
 */

export interface LocateJetBrainsOptions {
  /** The `preferredIde` setting; "auto" / absent searches JETBRAINS_IDES order. */
  preferred?: JetBrainsIdeId | "auto";
  /** The `jetbrainsPath` setting; used as-is when it exists (id "custom"). */
  explicitPath?: string;
  /** Overrides for tests (default: the running process's). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** The IDE to launch, or undefined when none is installed. S0 STUB — P2: none. */
export async function locateJetBrainsIde(
  _opts: LocateJetBrainsOptions = {},
): Promise<JetBrainsIdeInfo | undefined> {
  return undefined;
}
