// MCP resources: read-only context an agent can pull in without "calling" a tool
// — the live working-tree status, the branch list, recent history, plus
// templated access to any commit or file. These mirror a subset of the read
// tools but are surfaced as application-driven context (a resource picker) rather
// than model-driven actions.

import type { GitToolHost } from "@gitstudio/ai/gitTools";
import { ErrorCode, RpcError } from "./protocol";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export const RESOURCES: readonly ResourceDescriptor[] = [
  {
    uri: "gitstudio://status",
    name: "working-tree-status",
    title: "Working tree status",
    description: "The current staged, unstaged, and untracked changes in the repository.",
    mimeType: "text/markdown",
  },
  {
    uri: "gitstudio://branches",
    name: "branches",
    title: "Branches",
    description: "Local branches with upstream and ahead/behind counts.",
    mimeType: "text/markdown",
  },
  {
    uri: "gitstudio://log",
    name: "recent-history",
    title: "Recent commit history",
    description: "The 30 most recent commits on the current branch.",
    mimeType: "text/markdown",
  },
];

export const RESOURCE_TEMPLATES: readonly ResourceTemplate[] = [
  {
    uriTemplate: "gitstudio://commit/{sha}",
    name: "commit",
    title: "Commit details",
    description: "Metadata, message, and changed files for a commit (by SHA or ref).",
    mimeType: "text/markdown",
  },
  {
    uriTemplate: "gitstudio://file/{path}",
    name: "file",
    title: "File at HEAD",
    description: "The text content of a tracked file at HEAD.",
    mimeType: "text/plain",
  },
];

function fmtDate(epochSec: number): string {
  if (!epochSec) return "";
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export async function readResource(host: GitToolHost, uri: string): Promise<ResourceContents> {
  const md = (text: string): ResourceContents => ({ uri, mimeType: "text/markdown", text });

  if (uri === "gitstudio://status") {
    const files = await host.status();
    if (files.length === 0) return md("Working tree clean.");
    const lines = files.map((f) => `- ${f.staged ? "staged  " : "unstaged"} \`${f.status}\` ${f.path}`);
    return md(`# Working tree (${files.length} change(s))\n\n${lines.join("\n")}`);
  }
  if (uri === "gitstudio://branches") {
    const branches = await host.branches();
    const lines = branches.map(
      (b) => `- ${b.current ? "**" : ""}${b.name}${b.current ? "**" : ""}${b.upstream ? ` → ${b.upstream}` : ""} (↑${b.ahead} ↓${b.behind})`,
    );
    return md(`# Branches\n\n${lines.join("\n") || "(none)"}`);
  }
  if (uri === "gitstudio://log") {
    const commits = await host.log({ limit: 30 });
    const lines = commits.map((c) => `- \`${c.shortSha}\` ${c.subject} — ${c.author}, ${fmtDate(c.date)}`);
    return md(`# Recent commits\n\n${lines.join("\n") || "(none)"}`);
  }

  const commitMatch = /^gitstudio:\/\/commit\/(.+)$/.exec(uri);
  if (commitMatch) {
    const sha = decodeURIComponent(commitMatch[1]);
    const c = await host.show(sha);
    if (!c) throw new RpcError(ErrorCode.ResourceNotFound, `Commit not found: ${sha}`, { uri });
    const files = c.files.map((f) => `- \`${f.status}\` ${f.path}`).join("\n");
    return md(
      `# ${c.shortSha} ${c.subject}\n\nAuthor: ${c.author} — ${fmtDate(c.date)}\nParents: ${c.parents.join(", ") || "(root)"}\n\n${c.body.trim()}\n\n## Files\n\n${files}`,
    );
  }

  const fileMatch = /^gitstudio:\/\/file\/(.+)$/.exec(uri);
  if (fileMatch) {
    const path = decodeURIComponent(fileMatch[1]);
    const f = await host.readFile(path);
    if (!f) throw new RpcError(ErrorCode.ResourceNotFound, `File not found at HEAD: ${path}`, { uri });
    if (f.binary) return { uri, mimeType: "application/octet-stream", text: `(${path} is binary)` };
    return { uri, mimeType: "text/plain", text: f.text };
  }

  throw new RpcError(ErrorCode.ResourceNotFound, `Unknown resource: ${uri}`, { uri });
}
