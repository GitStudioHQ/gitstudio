import type { JetBrainsIdeInfo } from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * Launches a JetBrains IDE's merge or diff window, detached (PLAN §3.5 W5).
 * Host UI (notifications, "Mark Resolved & Stage") stays in the hosts.
 *
 * S0 contract seed: the request / result shapes are the contract; the bodies
 * are STUBS that refuse without spawning anything. P2 ports Merge Studio's
 * launcher (src/jetbrains/launcher.ts:54-193):
 * `<ide> merge LOCAL REMOTE [BASE] <output>` with LOCAL = the YOURS content and
 * REMOTE = the THEIRS content (already mapped through `byRole` by the caller,
 * or the swap reappears inside the IDE), BASE only when a base exists; temp
 * files in one mkdtemp dir that `dispose()` removes.
 */

export interface JetBrainsMergeRequest {
  ide: JetBrainsIdeInfo;
  /** The real working-tree file the IDE writes the result to (absolute). */
  outputPath: string;
  /** Yours content → the LOCAL file (left in the IDE). */
  yours: string | Uint8Array;
  /** Theirs content → the REMOTE file (right in the IDE). */
  theirs: string | Uint8Array;
  /** Base content → the BASE file; omit when the conflict has no base. */
  base?: string | Uint8Array;
}

/** One side of a diff: a file on disk, or text written to a temp file named `name`. */
export type JetBrainsDiffSide = { path: string } | { text: string; name: string };

export interface JetBrainsDiffRequest {
  ide: JetBrainsIdeInfo;
  left: JetBrainsDiffSide;
  right: JetBrainsDiffSide;
}

/** A launched (or refused) IDE window. */
export interface JetBrainsLaunch {
  /** The process was spawned. The IDE's own result arrives later, out of band. */
  ok: boolean;
  /** Plain words when it could not launch ("Couldn't launch WebStorm — …"). */
  message?: string;
  /** Where LOCAL / REMOTE / BASE (or the diff's temp sides) were written. */
  tempDir?: string;
  /** Remove the temp files — after the host's "Mark Resolved & Stage" (or cancel). Idempotent. */
  dispose(): Promise<void>;
}

/** S0 STUB — P2: refuses without spawning. */
export async function launchJetBrainsMerge(req: JetBrainsMergeRequest): Promise<JetBrainsLaunch> {
  return notYet(req.ide);
}

/** S0 STUB — P2: refuses without spawning. */
export async function launchJetBrainsDiff(req: JetBrainsDiffRequest): Promise<JetBrainsLaunch> {
  return notYet(req.ide);
}

function notYet(ide: JetBrainsIdeInfo): JetBrainsLaunch {
  return {
    ok: false,
    message: `Opening ${ide.name} is not available yet.`,
    dispose: async () => {},
  };
}
