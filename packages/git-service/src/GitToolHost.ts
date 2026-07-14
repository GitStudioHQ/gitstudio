// A GitToolHost implemented over a real GitContext — the bridge between the
// shared AI/MCP git-tool catalog (@gitstudio/ai/gitTools) and the actual repo.
// This is reused verbatim by BOTH the standalone MCP server and the desktop
// app's in-app agent, so the primitive git operations behind every tool are
// written and tested once, here, against the same battle-tested git-service
// providers that power the rest of GitStudio.
//
// Only the TYPE is imported from @gitstudio/ai (no runtime dependency on the
// providers), so this stays a thin, fast adapter.

import type {
  GitToolHost,
  ToolBranch,
  ToolCommit,
  ToolCommitDetail,
  ToolCompare,
  ToolFile,
  ToolStash,
  ToolStatusFile,
  ToolWriteResult,
} from "@gitstudio/ai/gitTools";
import type { GitContext } from "./GitContext";

/** Largest blob the read_file tool will return inline. */
const FILE_CAP_BYTES = 256 * 1024;

/** Reject an argument that could be misread by git as an option flag. */
function safe(arg: string): boolean {
  return arg.length > 0 && !arg.startsWith("-") && !/[\0\n]/.test(arg);
}

function w(r: { ok: boolean; stderr: string }): ToolWriteResult {
  return r.ok ? { ok: true } : { ok: false, message: r.stderr.trim() || "git reported an error." };
}

const UNSAFE: ToolWriteResult = { ok: false, message: "Argument rejected for safety (starts with '-' or contains a control character)." };

export function createGitToolHost(ctx: GitContext): GitToolHost {
  return new GitContextToolHost(ctx);
}

class GitContextToolHost implements GitToolHost {
  constructor(private readonly ctx: GitContext) {}

  repoRoot(): string {
    return this.ctx.root;
  }

  async status(): Promise<ToolStatusFile[]> {
    const r = await this.ctx.process.run(["status", "--porcelain=v1", "-z"]).catch(() => null);
    if (!r || r.code !== 0) {
      return [];
    }
    return parsePorcelain(r.stdout);
  }

  async log(opts: { limit?: number; ref?: string; path?: string }): Promise<ToolCommit[]> {
    const out: ToolCommit[] = [];
    const paths = opts.path && safe(opts.path) ? [opts.path] : undefined;
    const revRange = opts.ref && safe(opts.ref) ? opts.ref : "HEAD";
    try {
      for await (const c of this.ctx.log.streamCommits({ revRange, maxCount: opts.limit ?? 20, paths })) {
        out.push({ sha: c.sha, shortSha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.authorDate });
      }
    } catch {
      /* return what we have */
    }
    return out;
  }

  async show(sha: string): Promise<ToolCommitDetail | undefined> {
    if (!safe(sha)) {
      return undefined;
    }
    let record;
    try {
      for await (const c of this.ctx.log.streamCommits({ revRange: sha, maxCount: 1 })) {
        record = c;
        break;
      }
    } catch {
      return undefined;
    }
    if (!record) {
      return undefined;
    }
    let files: ToolStatusFile[] = [];
    try {
      const changes = await this.ctx.commitDetails.getCommitFiles(record.sha, record.parents[0]);
      files = changes.map((f) => ({ path: f.path, status: f.status, staged: true }));
    } catch {
      files = [];
    }
    return {
      sha: record.sha,
      shortSha: record.sha.slice(0, 7),
      subject: record.subject,
      author: record.author,
      date: record.authorDate,
      body: record.body,
      committer: record.committer,
      parents: record.parents,
      files,
    };
  }

  async diff(opts: { staged?: boolean; path?: string; base?: string; head?: string }): Promise<string> {
    const args = ["diff", "--no-color", "-M"];
    if (opts.base && opts.head) {
      if (!safe(opts.base) || !safe(opts.head)) {
        return "";
      }
      args.push(`${opts.base}..${opts.head}`);
    } else if (opts.staged) {
      args.push("--cached");
    }
    if (opts.path && safe(opts.path)) {
      args.push("--", opts.path);
    }
    const r = await this.ctx.process.run(args).catch(() => null);
    return r && r.code === 0 ? r.stdout : "";
  }

  async branches(): Promise<ToolBranch[]> {
    const SEP = "\x1f";
    const fmt =
      `%(refname:short)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}` +
      `%(upstream:track)${SEP}%(contents:subject)`;
    const r = await this.ctx.process
      .run(["for-each-ref", `--format=${fmt}`, "--sort=-committerdate", "refs/heads"])
      .catch(() => null);
    if (!r || r.code !== 0) {
      return [];
    }
    const branches: ToolBranch[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const [name, head, upstream, track, subject] = line.split(SEP);
      const { ahead, behind } = parseTrack(track ?? "");
      branches.push({ name, current: head === "*", upstream: upstream || undefined, ahead, behind, subject: subject ?? "" });
    }
    return branches;
  }

  async head(): Promise<{ branch?: string; detached: boolean; sha: string }> {
    try {
      const h = await this.ctx.refs.getHead();
      return h.detached ? { detached: true, sha: h.sha } : { detached: false, branch: h.branch, sha: h.sha };
    } catch {
      return { detached: true, sha: "" };
    }
  }

  async stashes(): Promise<ToolStash[]> {
    try {
      return (await this.ctx.stashes.list()).map((s) => ({ ref: s.ref, message: s.message, time: s.time }));
    } catch {
      return [];
    }
  }

  async searchCommits(query: string, limit = 20): Promise<ToolCommit[]> {
    const SEP = "\x1f";
    const REC = "\x1e";
    const r = await this.ctx.process
      .run([
        "log",
        `--max-count=${Math.min(limit, 100)}`,
        "-i",
        `--grep=${query}`,
        `--format=%H${SEP}%an${SEP}%at${SEP}%s${REC}`,
      ])
      .catch(() => null);
    if (!r || r.code !== 0) {
      return [];
    }
    const out: ToolCommit[] = [];
    for (const rec of r.stdout.split(REC)) {
      const line = rec.replace(/^\n/, "");
      if (!line.trim()) {
        continue;
      }
      const [sha, author, at, subject] = line.split(SEP);
      out.push({ sha, shortSha: (sha ?? "").slice(0, 7), author: author ?? "", date: Number(at) || 0, subject: subject ?? "" });
    }
    return out;
  }

  async readFile(path: string, ref = "HEAD"): Promise<ToolFile | undefined> {
    const rel = path.replace(/^\/+/, "");
    if (!rel || !safe(ref) || /[\0\n]/.test(rel)) {
      return undefined;
    }
    const r = await this.ctx.process.run(["show", `${ref}:${rel}`]).catch(() => null);
    if (!r || r.code !== 0) {
      return undefined;
    }
    if (r.stdout.includes("\0")) {
      return { path: rel, text: "", truncated: false, binary: true };
    }
    if (r.stdout.length > FILE_CAP_BYTES) {
      return { path: rel, text: r.stdout.slice(0, FILE_CAP_BYTES), truncated: true, binary: false };
    }
    return { path: rel, text: r.stdout, truncated: false, binary: false };
  }

  async compare(base: string, head: string): Promise<ToolCompare | undefined> {
    if (!safe(base) || !safe(head)) {
      return undefined;
    }
    const commits: ToolCommit[] = [];
    try {
      for await (const c of this.ctx.log.streamCommits({ revRange: `${base}..${head}`, maxCount: 200 })) {
        commits.push({ sha: c.sha, shortSha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.authorDate });
      }
    } catch {
      /* empty */
    }
    let files: ToolStatusFile[] = [];
    const r = await this.ctx.process.run(["diff", "--name-status", "-M", `${base}...${head}`]).catch(() => null);
    if (r && r.code === 0) {
      files = parseNameStatus(r.stdout);
    }
    const behindR = await this.ctx.process.run(["rev-list", "--count", `${head}..${base}`]).catch(() => null);
    const behind = behindR && behindR.code === 0 ? Number(behindR.stdout.trim()) || 0 : 0;
    return { ahead: commits.length, behind, commits, files };
  }

  // ── writes ──

  async stage(paths: string[] | "all"): Promise<ToolWriteResult> {
    if (paths === "all") {
      return this.run(["add", "-A"]);
    }
    if (!paths.every(safe)) {
      return UNSAFE;
    }
    return this.run(["add", "--", ...paths]);
  }

  async unstage(paths: string[] | "all"): Promise<ToolWriteResult> {
    if (paths === "all") {
      return this.run(["reset", "-q"]);
    }
    if (!paths.every(safe)) {
      return UNSAFE;
    }
    return this.run(["reset", "-q", "--", ...paths]);
  }

  async commit(message: string, amend?: boolean): Promise<ToolWriteResult> {
    if (!message.trim() && !amend) {
      return { ok: false, message: "A commit message is required." };
    }
    return w(await this.ctx.staging.commit(message, { amend }));
  }

  async createBranch(name: string, checkout?: boolean): Promise<ToolWriteResult> {
    if (!safe(name)) {
      return UNSAFE;
    }
    return w(await (checkout ? this.ctx.branches.checkoutNew(name) : this.ctx.branches.create(name)));
  }

  async checkout(ref: string): Promise<ToolWriteResult> {
    if (!safe(ref)) {
      return UNSAFE;
    }
    return w(await this.ctx.branches.checkout(ref));
  }

  async stashSave(message?: string, includeUntracked?: boolean): Promise<ToolWriteResult> {
    if (message && /[\0\n]/.test(message)) {
      return UNSAFE;
    }
    return w(await this.ctx.stashes.save({ message, includeUntracked }));
  }

  // ── destructive ──

  async discard(paths: string[]): Promise<ToolWriteResult> {
    if (!paths.every(safe)) {
      return UNSAFE;
    }
    const failures: string[] = [];
    for (const p of paths) {
      const r = await this.ctx.staging.discardChanges(p).catch(() => ({ ok: false, stderr: `discard ${p} failed` }));
      if (!r.ok) {
        failures.push(r.stderr.trim() || p);
      }
    }
    return failures.length ? { ok: false, message: failures.join("; ") } : { ok: true };
  }

  async deleteBranch(name: string, force?: boolean): Promise<ToolWriteResult> {
    if (!safe(name)) {
      return UNSAFE;
    }
    return w(await this.ctx.branches.delete(name, { force }));
  }

  async reset(mode: "soft" | "mixed" | "hard", ref: string): Promise<ToolWriteResult> {
    if (!safe(ref)) {
      return UNSAFE;
    }
    return this.run(["reset", `--${mode}`, ref]);
  }

  private async run(args: string[]): Promise<ToolWriteResult> {
    try {
      const r = await this.ctx.process.run(args);
      return r.code === 0 ? { ok: true } : { ok: false, message: r.stderr.trim() || `git exited ${r.code}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── parsers (local, compact) ─────────────────────────────────────────────────

/** Parse `git status --porcelain=v1 -z` into staged/unstaged tool files. */
function parsePorcelain(stdout: string): ToolStatusFile[] {
  const out: ToolStatusFile[] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) {
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    let path = entry.slice(3);
    // A rename/copy carries the new path here and the OLD path as the next NUL field.
    if (x === "R" || x === "C") {
      i++; // consume (and drop) the old path
    }
    if (x === "?" && y === "?") {
      out.push({ path, status: "?", staged: false });
      continue;
    }
    if (x && x !== " ") {
      out.push({ path, status: x, staged: true });
    }
    if (y && y !== " ") {
      out.push({ path, status: y, staged: false });
    }
  }
  return out;
}

/** Parse `git diff --name-status -M` into tool files (staged=false; just the change). */
function parseNameStatus(stdout: string): ToolStatusFile[] {
  const out: ToolStatusFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const cols = line.split("\t");
    const code = cols[0]?.[0] ?? "?";
    // For R/C the destination path is the last column.
    const path = cols.length >= 3 ? cols[cols.length - 1] : cols[1] ?? "";
    if (path) {
      out.push({ path, status: code, staged: false });
    }
  }
  return out;
}

/** Parse a `%(upstream:track)` token like "[ahead 2, behind 1]". */
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}
