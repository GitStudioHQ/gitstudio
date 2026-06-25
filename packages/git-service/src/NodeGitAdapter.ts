import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostGitAdapter } from "@gitstudio/host-bridge/git";

const execFileAsync = promisify(execFile);

export interface NodeGitAdapterOptions {
  /** Path to the git binary; defaults to "git". */
  gitPath?: string;
}

/**
 * The default Node implementation of HostGitAdapter. The desktop app reuses
 * this directly; the VS Code extension provides its own backed by vscode.git's
 * discovered binary path. Never imports `vscode`.
 */
export class NodeGitAdapter implements HostGitAdapter {
  private readonly path: string;

  constructor(opts?: NodeGitAdapterOptions) {
    this.path = opts?.gitPath ?? "git";
  }

  gitPath(): string {
    return this.path;
  }

  async discoverRepoRoot(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        this.path,
        ["-C", cwd, "rev-parse", "--show-toplevel"],
        { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      );
      const root = stdout.trim();
      return root.length > 0 ? root : undefined;
    } catch {
      return undefined;
    }
  }
}
