import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "../src/server";
import type { GitToolHost } from "@gitstudio/ai/gitTools";
import type { JsonRpcSuccess } from "../src/protocol";

/** A stub host whose read tools return canned data and whose writes record calls. */
function stubHost(calls: string[]): GitToolHost {
  const noop = async () => {
    return [] as never;
  };
  return {
    repoRoot: () => "/tmp/repo",
    status: async () => [{ path: "a.ts", status: "M", staged: false }],
    log: async () => [{ sha: "deadbeef0", shortSha: "deadbee", subject: "feat: x", author: "Dev", date: 1700000000 }],
    show: async (sha) =>
      sha === "missing"
        ? undefined
        : { sha, shortSha: sha.slice(0, 7), subject: "s", author: "Dev", date: 1, body: "", committer: "Dev", parents: [], files: [] },
    diff: async () => "diff --git a b",
    branches: async () => [{ name: "main", current: true, ahead: 0, behind: 0, subject: "feat: x" }],
    head: async () => ({ detached: false, branch: "main", sha: "deadbeef" }),
    stashes: noop,
    searchCommits: async () => [],
    readFile: async (p) => (p === "a.ts" ? { path: p, text: "hi", truncated: false, binary: false } : undefined),
    compare: async () => ({ ahead: 0, behind: 0, commits: [], files: [] }),
    stage: async () => {
      calls.push("stage");
      return { ok: true };
    },
    unstage: async () => ({ ok: true }),
    commit: async (m) => {
      calls.push(`commit:${m}`);
      return { ok: true };
    },
    createBranch: async () => ({ ok: true }),
    checkout: async () => ({ ok: true }),
    stashSave: async () => ({ ok: true }),
    discard: async () => {
      calls.push("discard");
      return { ok: true };
    },
    deleteBranch: async () => ({ ok: true }),
    reset: async () => ({ ok: true }),
  };
}

function makeServer(perm: { write: boolean; destructive: boolean }) {
  const calls: string[] = [];
  const server = new McpServer({ host: stubHost(calls), version: "test", permissions: perm });
  return { server, calls };
}

const req = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

test("initialize echoes a supported protocol version and advertises capabilities", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res = (await server.handle(req(1, "initialize", { protocolVersion: "2025-06-18" }))) as JsonRpcSuccess;
  const result = res.result as Record<string, any>;
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.capabilities.tools);
  assert.ok(result.capabilities.resources);
  assert.ok(result.capabilities.prompts);
  assert.equal(result.serverInfo.name, "gitstudio-mcp");
  assert.match(result.instructions, /READ-ONLY/);
});

test("initialize falls back to the server version for an unknown protocol", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res = (await server.handle(req(1, "initialize", { protocolVersion: "1.0.0" }))) as JsonRpcSuccess;
  assert.equal((res.result as any).protocolVersion, "2025-06-18");
});

test("notifications get no response", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res, null);
});

test("tools/list exposes only read tools in read-only mode, with annotations", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res = (await server.handle(req(2, "tools/list"))) as JsonRpcSuccess;
  const tools = (res.result as any).tools as any[];
  assert.ok(tools.length > 0);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true), "all read-only");
  assert.ok(tools.some((t) => t.name === "git_status"));
  assert.ok(!tools.some((t) => t.name === "git_commit"), "no write tools");
  const status = tools.find((t) => t.name === "git_status");
  assert.ok(status.inputSchema && status.description);
});

test("tools/list adds write tools but not destructive when write is enabled", async () => {
  const { server } = makeServer({ write: true, destructive: false });
  const tools = ((await server.handle(req(2, "tools/list"))) as JsonRpcSuccess).result as any;
  const names = tools.tools.map((t: any) => t.name);
  assert.ok(names.includes("git_commit"));
  assert.ok(!names.includes("git_reset"), "destructive still gated");
});

test("tools/call runs a read tool and returns text content", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res = (await server.handle(req(3, "tools/call", { name: "git_status", arguments: {} }))) as JsonRpcSuccess;
  const result = res.result as any;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /a\.ts/);
  assert.ok(result.structuredContent, "structured payload present");
});

test("tools/call on a gated write tool returns a guiding error, not execution", async () => {
  const { server, calls } = makeServer({ write: false, destructive: false });
  const res = (await server.handle(req(4, "tools/call", { name: "git_commit", arguments: { message: "x" } }))) as JsonRpcSuccess;
  const result = res.result as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disabled/);
  assert.equal(calls.length, 0, "commit must not run");
});

test("tools/call executes a write tool when permitted", async () => {
  const { server, calls } = makeServer({ write: true, destructive: false });
  const res = (await server.handle(req(5, "tools/call", { name: "git_commit", arguments: { message: "feat: y" } }))) as JsonRpcSuccess;
  assert.equal((res.result as any).isError, false);
  assert.ok(calls.includes("commit:feat: y"));
});

test("unknown tool yields a JSON-RPC InvalidParams error", async () => {
  const { server } = makeServer({ write: true, destructive: true });
  const res: any = await server.handle(req(6, "tools/call", { name: "git_nope", arguments: {} }));
  assert.equal(res.error.code, -32602);
});

test("resources/list, templates, and read work", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const list = ((await server.handle(req(7, "resources/list"))) as JsonRpcSuccess).result as any;
  assert.ok(list.resources.some((r: any) => r.uri === "gitstudio://status"));
  const templates = ((await server.handle(req(8, "resources/templates/list"))) as JsonRpcSuccess).result as any;
  assert.ok(templates.resourceTemplates.some((t: any) => t.uriTemplate === "gitstudio://commit/{sha}"));
  const read = ((await server.handle(req(9, "resources/read", { uri: "gitstudio://status" }))) as JsonRpcSuccess).result as any;
  assert.match(read.contents[0].text, /a\.ts/);
  const file = ((await server.handle(req(10, "resources/read", { uri: "gitstudio://file/a.ts" }))) as JsonRpcSuccess).result as any;
  assert.equal(file.contents[0].text, "hi");
});

test("resources/read on a missing resource returns ResourceNotFound", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res: any = await server.handle(req(11, "resources/read", { uri: "gitstudio://commit/missing" }));
  assert.equal(res.error.code, -32002);
});

test("prompts/list and prompts/get expand a workflow", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const list = ((await server.handle(req(12, "prompts/list"))) as JsonRpcSuccess).result as any;
  assert.ok(list.prompts.some((p: any) => p.name === "commit_staged"));
  const get = ((await server.handle(req(13, "prompts/get", { name: "commit_staged", arguments: { style: "concise" } }))) as JsonRpcSuccess).result as any;
  assert.match(get.messages[0].content.text, /concise/);
  assert.equal(get.messages[0].role, "user");
});

test("unknown method yields MethodNotFound", async () => {
  const { server } = makeServer({ write: false, destructive: false });
  const res: any = await server.handle(req(14, "totally/bogus"));
  assert.equal(res.error.code, -32601);
});
