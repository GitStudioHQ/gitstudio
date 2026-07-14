import type { GitProcess, GitRunOptions } from "./GitProcess";

/** A configured remote with its fetch + push URLs. */
export interface RemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface RemoteOpResult {
  ok: boolean;
  stderr: string;
}

export interface RemoteFetchOptions extends GitRunOptions {
  prune?: boolean;
  /** `--all` — fetch from every remote (ignores `remote`). */
  all?: boolean;
}

/**
 * `git remote` management: list/add/remove/rename/set-url/prune/fetch.
 * Pure git CLI — never imports `vscode`.
 */
export class RemoteOps {
  constructor(private proc: GitProcess) {}

  /** `git remote -v` parsed into {name, fetchUrl, pushUrl}. */
  async list(opts?: GitRunOptions): Promise<RemoteEntry[]> {
    const r = await this.proc.run(["remote", "-v"], { signal: opts?.signal });
    if (r.code !== 0) {
      return [];
    }
    return parseRemoteVerbose(r.stdout);
  }

  /** `git remote add <name> <url>`. */
  async add(
    name: string,
    url: string,
    opts?: GitRunOptions,
  ): Promise<RemoteOpResult> {
    const r = await this.proc.run(["remote", "add", name, url], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git remote remove <name>`. */
  async remove(name: string, opts?: GitRunOptions): Promise<RemoteOpResult> {
    const r = await this.proc.run(["remote", "remove", name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git remote rename <old> <neu>`. */
  async rename(
    old: string,
    neu: string,
    opts?: GitRunOptions,
  ): Promise<RemoteOpResult> {
    const r = await this.proc.run(["remote", "rename", old, neu], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git remote set-url <name> <url>`. */
  async setUrl(
    name: string,
    url: string,
    opts?: GitRunOptions,
  ): Promise<RemoteOpResult> {
    const r = await this.proc.run(["remote", "set-url", name, url], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git remote prune <name>` — drop stale remote-tracking refs. */
  async prune(name: string, opts?: GitRunOptions): Promise<RemoteOpResult> {
    const r = await this.proc.run(["remote", "prune", name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git fetch [<remote>] [--prune] [--all]`. */
  async fetch(
    remote?: string,
    opts?: RemoteFetchOptions,
  ): Promise<RemoteOpResult> {
    const args = ["fetch"];
    if (opts?.all) {
      args.push("--all");
    } else if (remote) {
      args.push(remote);
    }
    if (opts?.prune) {
      args.push("--prune");
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}

/**
 * Parse `git remote -v`, whose lines are `<name>\t<url> (fetch|push)`. We keep
 * the most recent fetch + push URL per remote.
 */
export function parseRemoteVerbose(text: string): RemoteEntry[] {
  const byName = new Map<string, RemoteEntry>();
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, name, url, kind] = match;
    const entry = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") {
      entry.fetchUrl = url;
    } else {
      entry.pushUrl = url;
    }
    byName.set(name, entry);
  }
  return Array.from(byName.values());
}
