// Shared set-up for the AiBridge tests: a fresh Electron userData folder, a
// real throwaway repository, a recorder for what the bridge sends to the
// renderer, and a scripted OpenAI-compatible model behind globalThis.fetch.
//
// Import AFTER ./aiBridge.fakes (which must be the first import of the file).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUserData } from "./aiBridge.fakes";
import { AiBridge } from "../src/main/aiBridge";
import { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

/** Folders to remove when the test ends. */
const cleanups: string[] = [];

export function cleanupAll(): void {
  for (const d of cleanups.splice(0)) removeTempRepo(d);
}

/**
 * A fresh userData folder. Seeded with an empty settings file unless `bare`:
 * a bridge that starts with NO file shares EMPTY_AI_SETTINGS.connections (see
 * the skipped BUG test in aiBridge.settings.test.ts), so one test's connections
 * would leak into the next.
 */
export function freshUserData(bare = false): string {
  const dir = mkdtempSync(join(tmpdir(), "gs-ai-bridge-"));
  cleanups.push(dir);
  setUserData(dir);
  if (!bare) writeFileSync(join(dir, "ai-settings.json"), JSON.stringify({ connections: [] }));
  return dir;
}

/** A repository with one commit ("initial": a.txt), identity configured. */
export function makeRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "gs-ai-repo-"));
  cleanups.push(root);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "a.txt"), "alpha\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return { root, git };
}

export interface Sent {
  event: string;
  data: Record<string, unknown>;
}

export async function makeBridge(repoRoot?: string): Promise<{ bridge: AiBridge; sent: Sent[]; repos: RepoStore }> {
  const repos = new RepoStore([]);
  if (repoRoot) await repos.open(repoRoot);
  const sent: Sent[] = [];
  const bridge = new AiBridge(repos, ((event: string, data: Record<string, unknown>) => sent.push({ event, data })) as never);
  return { bridge, sent, repos };
}

// ── a scripted model ──────────────────────────────────────────────────────────

export interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model?: string;
    stream?: boolean;
    messages?: { role: string; content: string | null; tool_calls?: unknown[] }[];
    [k: string]: unknown;
  };
  signal?: AbortSignal;
}

/** One model turn: text, and optionally tool calls. */
export interface Turn {
  content?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  finish?: string;
}

export type Reply = Turn | Response | ((req: ModelRequest) => Turn | Response | Promise<Turn | Response>);

export interface FakeModel {
  /** Every chat request (the non-streaming ones the provider falls back to). */
  chats: ModelRequest[];
  /** Every request of any kind, in order. */
  all: ModelRequest[];
  /** Replies for the next chat requests, in order. */
  replies: Reply[];
  /** Responses for the next STREAMING requests (else they get an empty body). */
  streams: Response[];
  /** The reply to `/models` listings. */
  models: Response | (() => Response) | undefined;
  restore(): void;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
  else Object.assign(out, h);
  return out;
}

/**
 * Replace globalThis.fetch with a model that answers from `replies`.
 *
 * A streaming request (`stream: true`) is answered with an EMPTY body, which
 * the OpenAI-compatible provider handles by falling back to one ordinary chat
 * turn — so every model turn is exactly one entry in `chats`.
 */
export function fakeModel(): FakeModel {
  const saved = globalThis.fetch;
  const m: FakeModel = {
    chats: [],
    all: [],
    replies: [],
    streams: [],
    models: undefined,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req: ModelRequest = {
      url,
      headers: headersOf(init),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      signal: init?.signal ?? undefined,
    };
    m.all.push(req);
    if (/\/models$/.test(url)) {
      const r = typeof m.models === "function" ? m.models() : m.models;
      return r ?? new Response("{}", { status: 404 });
    }
    if (req.body.stream) return m.streams.shift() ?? new Response(null, { status: 200 });
    m.chats.push(req);
    let reply = m.replies.shift() ?? { content: "" };
    if (typeof reply === "function") reply = await reply(req);
    if (reply instanceof Response) return reply;
    const toolCalls = (reply.toolCalls ?? []).map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: reply.content ?? "", tool_calls: toolCalls.length ? toolCalls : undefined },
            finish_reason: reply.finish ?? (toolCalls.length ? "tool_calls" : "stop"),
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return m;
}

/** The text of every message in a chat request, joined — to look for content. */
export function promptText(req: ModelRequest): string {
  return (req.body.messages ?? []).map((x) => x.content ?? "").join("\n");
}

/** A server-sent-events body streaming `deltas` as OpenAI-style content chunks. */
export function sse(deltas: string[]): Response {
  const body =
    deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
