// Shared fixture for the snapshotProvider.*.test.ts files: a real temp repo on
// `main`, the Undo envelope (`around`), and a process that runs real git but
// lets a test make ONE chosen command fail — the only way to reach the
// "git refused part-way" branches of restore without breaking the repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitContext } from "../src/GitContext";
import type { GitProcess, GitRunResult } from "../src/GitProcess";
import { SnapshotProvider, type Snapshot } from "../src/SnapshotProvider";
import { removeTempRepo } from "./tmpRepo";

process.env.GIT_EDITOR = "false";
delete process.env.GIT_SEQUENCE_EDITOR;

export const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

export interface SnapRepo {
  dir: string;
  git: (...args: string[]) => string;
  /** Run git that may fail; its exit code and output. */
  tryGit: (...args: string[]) => { code: number; stdout: string; stderr: string };
  commit: (msg: string, file?: string, body?: string) => string;
  write: (file: string, body: string | Buffer) => void;
  read: (file: string) => string;
  ctx: GitContext;
  snap: SnapshotProvider;
  /** A provider over this repo whose git answers `hook(args)` instead, when it returns a result. */
  intercepted: (hook: (args: string[]) => GitRunResult | undefined) => SnapshotProvider;
  dispose: () => void;
}

export function snapRepo(name = "snap"): SnapRepo {
  const dir = mkdtempSync(join(tmpdir(), `gs-snapprov-${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tryGit = (...args: string[]) => {
    try {
      return { code: 0, stdout: execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }
  };
  for (const [k, v] of [
    ["user.email", "u@e.com"],
    ["user.name", "U"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
    ["core.autocrlf", "false"],
    ["advice.detachedHead", "false"],
  ]) {
    git("config", k, v);
  }
  const write = (file: string, body: string | Buffer) => {
    const p = join(dir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    write(file, body);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  const real = ctx.process;
  return {
    dir,
    git,
    tryGit,
    commit,
    write,
    read: (file) => readFileSync(join(dir, file), "utf8"),
    ctx,
    snap: ctx.snapshot,
    intercepted: (hook) => {
      const proc = {
        cwd: real.cwd,
        run: async (args: string[], opts?: Parameters<GitProcess["run"]>[1]) => hook(args) ?? real.run(args, opts),
      } as unknown as GitProcess;
      return new SnapshotProvider(proc);
    },
    dispose: () => {
      ctx.dispose();
      removeTempRepo(dir);
    },
  };
}

/** Run `op` inside a snapshot, the way the Undo envelope does. */
export async function around(
  r: SnapRepo,
  label: string,
  op: () => void | Promise<void>,
  opts?: Parameters<SnapshotProvider["capture"]>[1],
): Promise<Snapshot> {
  const snap = await r.snap.capture(label, opts);
  await op();
  await r.snap.settle(snap);
  return snap;
}

/** A bare repository under tmpdir, standing in for a remote. */
export function bareRemote(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gs-snapprov-remote-"));
  execFileSync("git", ["init", "-q", "--bare", dir], { env: ENV });
  return { dir, dispose: () => removeTempRepo(dir) };
}

export const refused = (stderr: string): GitRunResult => ({ code: 1, stdout: "", stderr });

/** The plan's lines, or its reason when it isn't a restore. */
export function words(p: Awaited<ReturnType<SnapshotProvider["plan"]>>): string[] | string {
  return p.kind === "restore" ? p.lines : `${p.kind}: ${p.kind === "revert" ? p.mode : p.reason}`;
}
