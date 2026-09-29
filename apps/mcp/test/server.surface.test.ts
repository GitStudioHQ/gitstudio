import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "../src/server";
import { PROMPTS, getPrompt } from "../src/prompts";
import { readResource } from "../src/resources";
import { RpcError } from "../src/protocol";
import type { GitToolHost } from "@gitstudio/ai/gitTools";

// The rest of the MCP surface an agent actually reaches: every prompt's
// expansion (with and without its optional argument), every resource's
// rendered Markdown, and the server's parameter validation and error mapping.

type Overrides = Partial<Record<keyof GitToolHost, unknown>>;

/** A stub host with canned reads; `over` swaps individual methods per test. */
function host(over: Overrides = {}): GitToolHost {
  const base = {
    repoRoot: () => "/tmp/the-repo",
    status: async () => [],
    log: async () => [],
    show: async () => undefined,
    diff: async () => "",
    branches: async () => [],
    head: async () => ({ detached: false, branch: "main", sha: "deadbeef" }),
    stashes: async () => [],
    searchCommits: async () => [],
    readFile: async () => undefined,
    compare: async () => ({ ahead: 0, behind: 0, commits: [], files: [] }),
    stage: async () => ({ ok: true }),
    unstage: async () => ({ ok: true }),
    commit: async () => ({ ok: true }),
    createBranch: async () => ({ ok: true }),
    checkout: async () => ({ ok: true }),
    stashSave: async () => ({ ok: true }),
    discard: async () => ({ ok: true }),
    deleteBranch: async () => ({ ok: true }),
    reset: async () => ({ ok: true }),
  };
  return { ...base, ...over } as unknown as GitToolHost;
}

const req = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

function server(perm: { write: boolean; destructive: boolean }, over: Overrides = {}) {
  return new McpServer({ host: host(over), version: "9.9.9", permissions: perm });
}

// ── prompts ──────────────────────────────────────────────────────────────────

test("every listed prompt expands to exactly one user message, and only listed prompts exist", () => {
  assert.deepEqual(
    PROMPTS.map((p) => p.name),
    ["commit_staged", "review_changes", "release_notes", "explain_branch"],
  );
  for (const p of PROMPTS) {
    const got = getPrompt(p.name, {});
    assert.ok(got, p.name);
    assert.equal(got.description, p.description);
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].role, "user");
    assert.equal(got.messages[0].content.type, "text");
    // The descriptor carries no build function across the wire.
    assert.equal((p as unknown as { build?: unknown }).build, undefined);
  }
  assert.equal(getPrompt("nope", {}), undefined);
});

test("commit_staged defaults to a conventional message and treats a blank style as unset", () => {
  assert.match(getPrompt("commit_staged", {})!.messages[0].content.text, /Write a conventional commit message/);
  assert.match(getPrompt("commit_staged", { style: "   " })!.messages[0].content.text, /Write a conventional commit/);
});

test("review_changes reads the working tree without a base, and compares against a trimmed base with one", () => {
  const wt = getPrompt("review_changes", {})!.messages[0].content.text;
  assert.match(wt, /Call git_status, then git_diff \(no args\)/);
  assert.doesNotMatch(wt, /git_compare/);

  const vs = getPrompt("review_changes", { base: "  develop " })!.messages[0].content.text;
  assert.match(vs, /git_compare with \{"base": "develop"\}/);
  assert.match(vs, /git_diff with \{"base": "develop", "head": "HEAD"\}/);
  assert.match(vs, /safe to merge \/ needs work/);
});

test("release_notes lists recent commits by default, and the range since a ref when given", () => {
  const recent = getPrompt("release_notes", {})!.messages[0].content.text;
  assert.match(recent, /git_log with \{"limit": 50\}/);
  const since = getPrompt("release_notes", { since: "v1.2.0" })!.messages[0].content.text;
  assert.match(since, /git_log with \{"ref": "v1\.2\.0\.\.HEAD", "limit": 200\} to list commits since v1\.2\.0/);
});

test("explain_branch defaults its base to main and honours an explicit one", () => {
  const dflt = getPrompt("explain_branch", {})!.messages[0].content.text;
  assert.match(dflt, /compared to main\./);
  assert.match(dflt, /git_compare with \{"base": "main"\}/);
  const dev = getPrompt("explain_branch", { base: "release/2" })!.messages[0].content.text;
  assert.match(dev, /compared to release\/2\./);
  assert.match(dev, /git_diff \{"base": "release\/2", "head": "HEAD"/);
});

// ── resources ────────────────────────────────────────────────────────────────

test("status: a clean tree says so; changes list staged and unstaged with their code", async () => {
  const clean = await readResource(host(), "gitstudio://status");
  assert.deepEqual(clean, { uri: "gitstudio://status", mimeType: "text/markdown", text: "Working tree clean." });

  const dirty = await readResource(
    host({
      status: async () => [
        { path: "src/a.ts", status: "M", staged: true },
        { path: "b.md", status: "?", staged: false },
      ],
    }),
    "gitstudio://status",
  );
  assert.equal(
    dirty.text,
    "# Working tree (2 change(s))\n\n- staged   `M` src/a.ts\n- unstaged `?` b.md",
  );
});

test("branches: the current one is bold, upstreams and ahead/behind are shown, none says (none)", async () => {
  const r = await readResource(
    host({
      branches: async () => [
        { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 2, subject: "" },
        { name: "topic", current: false, ahead: 0, behind: 0, subject: "" },
      ],
    }),
    "gitstudio://branches",
  );
  assert.equal(r.text, "# Branches\n\n- **main** → origin/main (↑1 ↓2)\n- topic (↑0 ↓0)");
  assert.equal((await readResource(host(), "gitstudio://branches")).text, "# Branches\n\n(none)");
});

test("log: asks for 30 commits and renders sha, subject, author and a UTC minute timestamp", async () => {
  let asked: unknown;
  const r = await readResource(
    host({
      log: async (opts: unknown) => {
        asked = opts;
        return [
          { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "feat: x", author: "Dev", date: 1700000000 },
          { sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "undated", author: "Bot", date: 0 },
        ];
      },
    }),
    "gitstudio://log",
  );
  assert.deepEqual(asked, { limit: 30 });
  assert.equal(
    r.text,
    "# Recent commits\n\n- `aaaaaaa` feat: x — Dev, 2023-11-14 22:13Z\n- `bbbbbbb` undated — Bot, ",
  );
  assert.equal((await readResource(host(), "gitstudio://log")).text, "# Recent commits\n\n(none)");
});

test("commit/{sha}: decodes the ref, and renders parents (or root), body and files", async () => {
  let shown = "";
  const show = async (sha: string) => {
    shown = sha;
    return {
      sha: "c".repeat(40),
      shortSha: "ccccccc",
      subject: "fix: y",
      author: "Dev",
      committer: "Dev",
      date: 1700000000,
      body: "  Longer body.\n",
      parents: sha === "root" ? [] : ["p1", "p2"],
      files: [{ path: "a.ts", status: "M" }],
    };
  };
  const r = await readResource(host({ show }), "gitstudio://commit/feature%2Fx");
  assert.equal(shown, "feature/x");
  assert.equal(
    r.text,
    "# ccccccc fix: y\n\nAuthor: Dev — 2023-11-14 22:13Z\nParents: p1, p2\n\nLonger body.\n\n## Files\n\n- `M` a.ts",
  );
  const root = await readResource(host({ show }), "gitstudio://commit/root");
  assert.match(root.text, /Parents: \(root\)/);
});

test("file/{path}: decodes the path, serves text as text/plain, and never returns binary bytes", async () => {
  const readFile = async (p: string) =>
    p === "dir/a b.ts"
      ? { path: p, text: "const x = 1;\n", truncated: false, binary: false }
      : p === "logo.png"
        ? { path: p, text: "\u0000PNG", truncated: false, binary: true }
        : undefined;
  const txt = await readResource(host({ readFile }), "gitstudio://file/dir%2Fa%20b.ts");
  assert.deepEqual(txt, { uri: "gitstudio://file/dir%2Fa%20b.ts", mimeType: "text/plain", text: "const x = 1;\n" });
  const bin = await readResource(host({ readFile }), "gitstudio://file/logo.png");
  assert.deepEqual(bin, { uri: "gitstudio://file/logo.png", mimeType: "application/octet-stream", text: "(logo.png is binary)" });
});

test("a missing file, a missing commit and an unknown URI are all ResourceNotFound carrying the URI", async () => {
  for (const uri of ["gitstudio://file/gone.ts", "gitstudio://commit/nope", "gitstudio://whatever", "https://x"]) {
    await assert.rejects(readResource(host(), uri), (e: unknown) => {
      assert.ok(e instanceof RpcError, String(e));
      assert.equal(e.code, -32002);
      assert.deepEqual(e.data, { uri });
      return true;
    });
  }
});

// ── server ───────────────────────────────────────────────────────────────────

test("ping answers an empty result", async () => {
  const res: any = await server({ write: false, destructive: false }).handle(req(1, "ping"));
  assert.deepEqual(res.result, {});
  assert.equal(res.id, 1);
});

test("initialize tells the agent which permission mode it is in, naming the repo", async () => {
  const text = async (perm: { write: boolean; destructive: boolean }) =>
    ((await server(perm).handle(req(1, "initialize", {}))) as any).result.instructions as string;
  const ro = await text({ write: false, destructive: false });
  assert.match(ro, /\/tmp\/the-repo/);
  assert.match(ro, /READ-ONLY/);
  const w = await text({ write: true, destructive: false });
  assert.match(w, /Write tools are enabled/);
  assert.match(w, /destructive tools .* are disabled/);
  const d = await text({ write: true, destructive: true });
  assert.match(d, /Write AND destructive tools are enabled/);
  const init: any = await server({ write: false, destructive: false }).handle(req(2, "initialize", {}));
  assert.equal(init.result.serverInfo.version, "9.9.9");
  assert.equal(init.result.protocolVersion, "2025-06-18");
});

test("tools/list annotates destructive tools as destructive once they are enabled", async () => {
  const res: any = await server({ write: true, destructive: true }).handle(req(1, "tools/list"));
  const byName = new Map<string, any>(res.result.tools.map((t: any) => [t.name, t]));
  assert.equal(byName.get("git_reset").annotations.destructiveHint, true);
  assert.equal(byName.get("git_reset").annotations.readOnlyHint, false);
  assert.equal(byName.get("git_status").annotations.destructiveHint, false);
  assert.equal(byName.get("git_status").annotations.openWorldHint, false);
});

test("a gated destructive tool asks for write/destructive access; a gated write tool asks for write only", async () => {
  const s = server({ write: true, destructive: false });
  const reset: any = await s.handle(req(1, "tools/call", { name: "git_reset", arguments: {} }));
  assert.equal(reset.result.isError, true);
  assert.match(reset.result.content[0].text, /enable write\/destructive access/);

  const ro = server({ write: false, destructive: false });
  const commit: any = await ro.handle(req(2, "tools/call", { name: "git_commit" }));
  assert.match(commit.result.content[0].text, /enable write access/);
  assert.doesNotMatch(commit.result.content[0].text, /destructive/);
});

test("tools/call without a string name is InvalidParams", async () => {
  const res: any = await server({ write: false, destructive: false }).handle(req(1, "tools/call", { name: 42 }));
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /requires a string `name`/);
});

test("a tool whose host call throws becomes an error response, never a thrown handle()", async () => {
  const s = server(
    { write: false, destructive: false },
    {
      status: async () => {
        throw new Error("git exploded");
      },
    },
  );
  const res: any = await s.handle(req(7, "tools/call", { name: "git_status", arguments: "not-an-object" }));
  // The shared tools do not catch host failures; the server turns the throw
  // into a JSON-RPC InternalError the agent can read, on the same id.
  assert.equal(res.error.code, -32603);
  assert.equal(res.error.message, "git exploded");
  assert.equal(res.id, 7);
});

test("a non-Error throw from a resource read is still an InternalError reply", async () => {
  const s = server(
    { write: false, destructive: false },
    {
      branches: async () => {
        throw "plain string failure";
      },
    },
  );
  const res: any = await s.handle(req(8, "resources/read", { uri: "gitstudio://branches" }));
  assert.equal(res.error.code, -32603);
  assert.equal(res.error.message, "plain string failure");
});

test("resources/read and prompts/get validate their parameters", async () => {
  const s = server({ write: false, destructive: false });
  const noUri: any = await s.handle(req(1, "resources/read", {}));
  assert.equal(noUri.error.code, -32602);
  assert.match(noUri.error.message, /requires a string `uri`/);

  const noName: any = await s.handle(req(2, "prompts/get", {}));
  assert.equal(noName.error.code, -32602);
  assert.match(noName.error.message, /requires a string `name`/);

  const unknown: any = await s.handle(req(3, "prompts/get", { name: "summon_demon" }));
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown prompt: summon_demon/);

  // Non-object arguments are ignored rather than crashing the expansion.
  const ok: any = await s.handle(req(4, "prompts/get", { name: "explain_branch", arguments: "main" }));
  assert.match(ok.result.messages[0].content.text, /compared to main\./);
});

test("a request without params is handled as if params were empty", async () => {
  const res: any = await server({ write: false, destructive: false }).handle({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  } as any);
  assert.equal(res.result.resources.length, 3);
});
