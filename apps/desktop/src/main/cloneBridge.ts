// Clone / browse-repos backend.
//
// CONTRACT (keep these signatures — main.ts depends on them):
//  • pickCloneDir(): native folder picker for the clone *parent* directory.
//  • startClone(req, onProgress): runs `git clone --progress`, parses the
//    progress lines to CloneProgress (forwarded via onProgress → clone:progress
//    event), and resolves with the absolute repo path on success.
//  • listGhRepos(client, search?): the signed-in user's clonable repos via the
//    GitHub REST API (GET /user/repos, owner+collaborator+org, sorted by recency),
//    optionally filtered by `search`.

import { dialog } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { CloneProgress, CloneRequest, CloneResult, GhRepoBrief } from "../shared/ipc";
import type { GitHubClient } from "./githubClient";
import { ALLOWED_PROTOCOLS, validateCloneUrl } from "./cloneUrl";

/** In-flight `git clone` children, so they can be killed on app/window teardown
 *  rather than orphaned (a long clone would otherwise keep running after quit). */
const activeClones = new Set<ReturnType<typeof spawn>>();

/** Terminate any running clone — called when the window closes / app quits. */
export function killActiveClones(): void {
  for (const child of activeClones) {
    child.kill("SIGTERM");
  }
  activeClones.clear();
}

/** Native "choose a folder" dialog; returns the absolute path or undefined. */
export async function pickCloneDir(): Promise<string | undefined> {
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose a folder to clone into",
  });
  return r.canceled || !r.filePaths[0] ? undefined : r.filePaths[0];
}

/** Derive the target folder name from an explicit override or the URL's last segment. */
function targetName(req: CloneRequest): string {
  const explicit = req.name?.trim();
  if (explicit) return explicit;
  // Strip a trailing slash, then a trailing ".git", and take the last path segment.
  const trimmed = req.url.trim().replace(/\/+$/, "");
  const seg = trimmed.split(/[\\/]/).pop() ?? "";
  return seg.replace(/\.git$/i, "");
}


/** A progress line looks like "Receiving objects:  42% (…)" — sometimes "remote: " prefixed. */
const PERCENT_RE = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/;

/** Clone `req.url` into `req.parentDir/<name>`, streaming progress. */
export async function startClone(
  req: CloneRequest,
  onProgress: (p: CloneProgress) => void,
): Promise<CloneResult> {
  const url = req.url?.trim();
  if (!url) {
    return { ok: false, message: "No repository URL was provided." };
  }
  const urlError = validateCloneUrl(url);
  if (urlError) {
    return { ok: false, message: urlError };
  }
  if (!req.parentDir) {
    return { ok: false, message: "No destination folder was chosen." };
  }
  const name = targetName(req);
  if (!name) {
    return { ok: false, message: "Couldn't derive a folder name from the URL." };
  }
  // A target dir starting with "-" would be read by git as an option, not a path.
  if (name.startsWith("-")) {
    return { ok: false, message: "Couldn't derive a safe folder name from the URL." };
  }

  return new Promise<CloneResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "git",
        ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "clone", "--progress", "--", url, name],
        {
          cwd: req.parentDir,
          // Never block the clone waiting on an interactive credential prompt
          // (it would hang the UI), and constrain the transports git may use.
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS,
          },
        },
      );
    } catch (err) {
      resolve({ ok: false, message: messageOf(err) });
      return;
    }

    activeClones.add(child);
    let lastStderr = "";
    let settled = false;
    const finish = (r: CloneResult) => {
      if (settled) return;
      settled = true;
      activeClones.delete(child);
      resolve(r);
    };

    // git writes its progress to stderr; the carriage-return updates arrive as a
    // single growing line, so split on both \n and \r and keep the dangling tail.
    let buf = "";
    const emitLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      lastStderr = text;
      const m = PERCENT_RE.exec(text);
      if (m) {
        onProgress({ phase: m[1].trim(), percent: Number(m[2]), raw: text });
      } else if (!/\(\d+\/\d+\)/.test(text)) {
        // Forward informative, non-counter lines sparingly (e.g. "Cloning into …").
        onProgress({ phase: text, raw: text });
      }
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const p of parts) emitLine(p);
    });

    child.on("error", (err) => {
      finish({ ok: false, message: messageOf(err) });
    });

    child.on("close", (code) => {
      if (buf.trim()) emitLine(buf);
      if (code === 0) {
        finish({ ok: true, root: join(req.parentDir, name) });
      } else {
        finish({ ok: false, message: lastStderr || `git clone exited ${code}` });
      }
    });
  });
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("ENOENT") ? "git was not found on your PATH." : m;
}

interface RawGhRepo {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  clone_url?: string;
  ssh_url?: string;
  default_branch?: string;
  stargazers_count?: number;
  language?: string | null;
  pushed_at?: string;
  updated_at?: string;
}

/** List the signed-in user's clonable GitHub repositories. */
export async function listGhRepos(client: GitHubClient, search?: string): Promise<GhRepoBrief[]> {
  const repos = await client.request<RawGhRepo[]>(
    "GET",
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  );
  let out: GhRepoBrief[] = (repos ?? []).map((r) => ({
    fullName: r.full_name ?? "",
    name: r.name ?? "",
    owner: r.owner?.login ?? "",
    description: r.description ?? null,
    private: !!r.private,
    fork: !!r.fork,
    cloneUrl: r.clone_url ?? "",
    sshUrl: r.ssh_url ?? "",
    defaultBranch: r.default_branch ?? "main",
    stars: r.stargazers_count ?? 0,
    language: r.language ?? null,
    updatedAt: r.pushed_at ?? r.updated_at ?? "",
  }));

  const q = search?.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }

  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}
