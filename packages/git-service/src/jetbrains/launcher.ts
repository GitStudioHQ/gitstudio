import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { JetBrainsIdeInfo } from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * Launches a JetBrains IDE's merge or diff window, detached (PLAN §3.5 W5).
 * Host UI (notifications, "Mark Resolved & Stage") stays in the hosts.
 *
 * A port of Merge Studio's launcher (src/jetbrains/launcher.ts):
 * `<ide> merge LOCAL REMOTE [BASE] <output>`, with LOCAL = the YOURS content
 * and REMOTE = the THEIRS content — already mapped through `byRole` by the
 * caller, or the rebase swap reappears inside the IDE — and BASE only when a
 * base exists. The temp files live in one mkdtemp directory that `dispose()`
 * removes; the hosts call it after "Mark Resolved & Stage" (or on cancel),
 * because the IDE reads the files after this returns.
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

/** Open the file's conflict in the IDE's three-way merge window. */
export async function launchJetBrainsMerge(req: JetBrainsMergeRequest): Promise<JetBrainsLaunch> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "gitstudio-jbmerge-"));
    const ext = extname(req.outputPath);
    const stem = basename(req.outputPath, ext) || "file";
    const local = join(dir, `${stem}.LOCAL${ext}`);
    const remote = join(dir, `${stem}.REMOTE${ext}`);
    await writeFile(local, req.yours);
    await writeFile(remote, req.theirs);
    const args = ["merge", local, remote];
    if (req.base !== undefined) {
      const basePath = join(dir, `${stem}.BASE${ext}`);
      await writeFile(basePath, req.base);
      args.push(basePath);
    }
    args.push(req.outputPath);
    return await launch(req.ide, args, dir);
  } catch (err) {
    if (dir) await removeDir(dir);
    return refused(req.ide, err);
  }
}

/** Open two sides in the IDE's diff window (HEAD vs the working copy, or two files). */
export async function launchJetBrainsDiff(req: JetBrainsDiffRequest): Promise<JetBrainsLaunch> {
  let dir: string | undefined;
  try {
    const sidePath = async (s: JetBrainsDiffSide): Promise<string> => {
      if ("path" in s) return s.path;
      dir ??= await mkdtemp(join(tmpdir(), "gitstudio-jbdiff-"));
      const p = join(dir, basename(s.name) || "side");
      await writeFile(p, s.text);
      return p;
    };
    const left = await sidePath(req.left);
    const right = await sidePath(req.right);
    return await launch(req.ide, ["diff", left, right], dir);
  } catch (err) {
    if (dir) await removeDir(dir);
    return refused(req.ide, err);
  }
}

/**
 * Spawn detached and settle on the first of `spawn` / `error` — a missing or
 * non-executable launcher is reported asynchronously, and "launched" must mean
 * the process really started.
 */
function launch(ide: JetBrainsIdeInfo, args: string[], dir: string | undefined): Promise<JetBrainsLaunch> {
  const dispose = once(async () => {
    if (dir) await removeDir(dir);
  });
  // Toolbox's Windows launchers are .cmd scripts, which need a shell — and a
  // shell splits unquoted arguments at spaces, so quote every one.
  const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(ide.command);
  const argv = script ? args.map((a) => `"${a.replace(/"/g, '""')}"`) : args;
  return new Promise((resolveLaunch) => {
    let settled = false;
    const settle = (value: JetBrainsLaunch): void => {
      if (settled) return;
      settled = true;
      resolveLaunch(value);
    };
    try {
      const child = spawn(script ? `"${ide.command}"` : ide.command, argv, {
        detached: true,
        stdio: "ignore",
        shell: script,
        windowsHide: true,
      });
      child.once("error", (err) => {
        void dispose();
        settle({ ok: false, message: `Couldn't launch ${ide.name} — ${err.message}`, dispose });
      });
      child.once("spawn", () => {
        child.unref();
        settle({ ok: true, ...(dir ? { tempDir: dir } : {}), dispose });
      });
    } catch (err) {
      void dispose();
      settle({ ...refused(ide, err), dispose });
    }
  });
}

function refused(ide: JetBrainsIdeInfo, err: unknown): JetBrainsLaunch {
  const why = err instanceof Error ? err.message : String(err);
  return { ok: false, message: `Couldn't launch ${ide.name} — ${why}`, dispose: async () => {} };
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let p: Promise<void> | undefined;
  return () => (p ??= fn());
}

async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort — a temp dir the OS reclaims */
  }
}
