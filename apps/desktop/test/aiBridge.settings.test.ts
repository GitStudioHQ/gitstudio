// Settings ▸ AI: the user's model connections, their keys, the model picker,
// and "Test connection".
//
// What is pinned is what the user and the renderer rely on: connections
// survive a restart; a key is stored encrypted, never shown back and never in
// the settings file; a connection is "usable" only when a request could work;
// the model picker offers configured, live and known models once each; and
// Test says why a connection does not work. Models are a fake fetch, the CLIs
// scripted FakeChilds — nothing leaves the machine.

import { onNextSpawn, resetSpawns, spawned } from "./aiBridge.fakes";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, fakeModel, freshUserData, makeBridge, type FakeModel } from "./aiBridge.harness";

let userData: string;
let model: FakeModel;
beforeEach(() => {
  userData = freshUserData();
  model = fakeModel();
  resetSpawns();
});
afterEach(() => {
  model.restore();
  cleanupAll();
});

const settingsFile = () => JSON.parse(readFileSync(join(userData, "ai-settings.json"), "utf8"));

test("with nothing configured the AI features stay off", async () => {
  userData = freshUserData(true);
  assert.equal(existsSync(join(userData, "ai-settings.json")), false, "no settings file at all");
  const { bridge } = await makeBridge();
  const v = await bridge.getSettings();
  assert.deepEqual(v.connections, []);
  assert.equal(v.enabled, false);
  assert.equal(v.defaultId, undefined);
  assert.equal(v.agent.model, "mid", "agent defaults are filled in");
  assert.equal(v.agent.permission, "read");
});

// AiBridge used to start from `{ ...EMPTY_AI_SETTINGS }` — a SHALLOW copy — so
// until a settings file was read, `settings.connections` WAS the shared
// EMPTY_AI_SETTINGS.connections array exported by @gitstudio/ai, and
// addConnection() pushed into that module constant.
test("a bridge with no settings file does not leak its connections into the next one", async () => {
  userData = freshUserData(true);
  const { bridge } = await makeBridge();
  await bridge.addConnection("ollama");
  userData = freshUserData(true);
  const { bridge: other } = await makeBridge();
  assert.deepEqual((await other.getSettings()).connections, [], "a different profile starts empty");
});

test("the first connection becomes the default, and connections survive a restart", async () => {
  const { bridge } = await makeBridge();
  const v1 = await bridge.addConnection("ollama");
  const v2 = await bridge.addConnection("openai");
  const [ollama, openai] = v2.connections;
  assert.equal(v1.defaultId, ollama.id);
  assert.equal(v2.defaultId, ollama.id, "adding another does not move the default");
  assert.equal(ollama.preset, "ollama");
  assert.equal(ollama.local, true);
  assert.equal(ollama.usable, true, "a local server needs no key");
  assert.equal(openai.needsKey, true);
  assert.equal(openai.usable, false, "a keyed provider without its key is not usable");
  assert.equal(v2.enabled, true, "one usable connection turns the features on");

  const { bridge: restarted } = await makeBridge();
  const v3 = await restarted.getSettings();
  assert.deepEqual(v3.connections.map((c) => c.id), [ollama.id, openai.id]);
  assert.equal(v3.defaultId, ollama.id);
});

test("editing a connection changes only what was sent", async () => {
  const { bridge } = await makeBridge();
  const { connections } = await bridge.addConnection("ollama");
  const id = connections[0].id;
  let v = await bridge.updateConnection({ id, label: "Home box" });
  assert.equal(v.connections[0].label, "Home box");
  assert.equal(v.connections[0].baseUrl, "http://localhost:11434/v1", "untouched");
  v = await bridge.updateConnection({ id, baseUrl: "http://127.0.0.1:9/v1", models: { fast: "a", mid: "b", deep: "c" } });
  assert.equal(v.connections[0].baseUrl, "http://127.0.0.1:9/v1");
  assert.deepEqual(v.connections[0].models, { fast: "a", mid: "b", deep: "c" });
  assert.equal(settingsFile().connections[0].label, "Home box", "persisted");

  const before = JSON.stringify(await bridge.getSettings());
  await bridge.updateConnection({ id: "missing", label: "x" });
  assert.equal(JSON.stringify(await bridge.getSettings()), before, "an unknown id changes nothing");
});

test("the default can only be a connection that exists", async () => {
  const { bridge } = await makeBridge();
  await bridge.addConnection("ollama");
  const { connections } = await bridge.addConnection("lmstudio");
  let v = await bridge.setDefault(connections[1].id);
  assert.equal(v.defaultId, connections[1].id);
  v = await bridge.setDefault("stale-id");
  assert.equal(v.defaultId, connections[1].id);
});

test("removing the default connection promotes the next one and deletes its key", async () => {
  const { bridge } = await makeBridge();
  const a = (await bridge.addConnection("openai")).connections[0].id;
  const b = (await bridge.addConnection("ollama")).connections[1].id;
  await bridge.setKey(a, "sk-secret-a");
  let v = await bridge.removeConnection(a);
  assert.deepEqual(v.connections.map((c) => c.id), [b]);
  assert.equal(v.defaultId, b);
  // Re-adding under the same id is impossible; prove the key file is gone.
  const secretsDir = join(userData, "secrets");
  assert.ok(!readdirSync(secretsDir).some((f) => f.startsWith(a)), "the key is deleted with the connection");
  v = await bridge.removeConnection(b);
  assert.equal(v.defaultId, undefined, "nothing left to default to");
});

test("a key makes a keyed connection usable, and is never shown or written in plain text", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("openai")).connections[0].id;
  const v = await bridge.setKey(id, "  sk-live-1234567890  ");
  assert.equal(v.connections[0].hasKey, true);
  assert.equal(v.connections[0].usable, true);
  assert.ok(!JSON.stringify(v).includes("sk-live"), "the renderer's view carries no key");
  assert.ok(!readFileSync(join(userData, "ai-settings.json"), "utf8").includes("sk-live"));
  for (const f of readdirSync(join(userData, "secrets"))) {
    assert.ok(!readFileSync(join(userData, "secrets", f), "utf8").includes("sk-live"), `${f} is encrypted`);
  }

  // The key is used — trimmed — as the bearer token for the provider.
  model.replies.push({ content: "OK" });
  await bridge.test(id);
  assert.equal(model.chats[0].headers.Authorization, "Bearer sk-live-1234567890");

  const cleared = await bridge.setKey(id, "   ");
  assert.equal(cleared.connections[0].hasKey, false, "a blank key removes the stored one");
  assert.equal(cleared.connections[0].usable, false);
});

test("a pre-1.4 keyring blob is never read, and is deleted on the way", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("openai")).connections[0].id;
  const legacy = join(userData, "ai-keys", `${id}.bin`);
  mkdirSync(join(userData, "ai-keys"), { recursive: true });
  writeFileSync(legacy, "keyring-encrypted-bytes");
  const v = await bridge.getSettings();
  assert.equal(v.connections[0].hasKey, false, "a leftover blob does not count as a key");
  assert.equal(v.connections[0].usable, false);

  // Asking for the key (the model list does) drops the blob unread.
  await bridge.listModels(id);
  assert.equal(existsSync(legacy), false);

  writeFileSync(legacy, "again");
  await bridge.setKey(id, "sk-new");
  assert.equal(existsSync(legacy), false, "entering a key supersedes the blob");
});

test("the catalog lists every preset for the Add menu", async () => {
  const { bridge } = await makeBridge();
  const cat = bridge.catalog();
  const ids = cat.map((p) => p.id);
  for (const id of ["anthropic", "openai", "claude-code", "codex", "ollama"]) assert.ok(ids.includes(id), id);
  const cc = cat.find((p) => p.id === "claude-code")!;
  assert.equal(cc.wire, "cli");
  assert.equal(cc.local, true);
  assert.equal(cc.needsKey, false);
  const anthropic = cat.find((p) => p.id === "anthropic")!;
  assert.equal(anthropic.local, false);
  assert.deepEqual(anthropic.models, { fast: "claude-haiku-4-5", mid: "claude-sonnet-4-6", deep: "claude-opus-4-8" });
});

test("agent settings merge over the defaults and persist", async () => {
  const { bridge } = await makeBridge();
  let v = await bridge.setAgentConfig({ thinking: "extended" });
  assert.equal(v.agent.thinking, "extended");
  assert.equal(v.agent.model, "mid");
  v = await bridge.setAgentConfig({ permission: "write", modelId: "gpt-x" });
  assert.equal(v.agent.thinking, "extended", "earlier choices are kept");
  assert.deepEqual(settingsFile().agent, { model: "mid", thinking: "extended", permission: "write", modelId: "gpt-x" });
});

test("a corrupt or foreign settings file starts empty instead of failing", async () => {
  writeFileSync(join(userData, "ai-settings.json"), JSON.stringify({ connections: "nope" }));
  let { bridge } = await makeBridge();
  assert.deepEqual((await bridge.getSettings()).connections, []);
  writeFileSync(join(userData, "ai-settings.json"), "{{{");
  ({ bridge } = await makeBridge());
  assert.deepEqual((await bridge.getSettings()).connections, []);
});

test("a settings write that fails never fails the action", async () => {
  const file = join(userData, "blocked");
  writeFileSync(file, "");
  // userData is a file: mkdir/writeFile underneath fail.
  const { setUserData } = await import("./aiBridge.fakes");
  setUserData(file);
  const { bridge } = await makeBridge();
  const v = await bridge.addConnection("ollama");
  assert.equal(v.connections.length, 1, "kept in memory for this run");
});

// ── local CLIs ───────────────────────────────────────────────────────────────

test("a CLI connection shows as usable only when its binary is found", async () => {
  const { bridge } = await makeBridge();
  await bridge.addConnection("claude-code");
  onNextSpawn((c) => {
    c.out("2.0.1 (Claude Code)\n");
    void c.exit(0);
  });
  let v = await bridge.getSettings();
  assert.equal(spawned[0].command, "claude");
  assert.deepEqual(spawned[0].args, ["--version"]);
  assert.equal(v.connections[0].usable, true);
  assert.equal(v.enabled, true);

  onNextSpawn((c) => c.fail("ENOENT"));
  v = await bridge.getSettings();
  assert.equal(v.connections[0].usable, false, "not installed");
  assert.equal(v.enabled, false);
});

test("Test on a CLI connection only checks the binary — it spends no quota", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("codex")).connections[0].id;
  onNextSpawn((c) => {
    c.out("codex-cli 0.9\n");
    void c.exit(0);
  });
  assert.deepEqual(await bridge.test(id), { ok: true, message: "Found `codex` (codex-cli 0.9)." });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["--version"], "never a prompt");

  onNextSpawn((c) => void c.exit(0));
  assert.deepEqual(await bridge.test(id), { ok: true, message: "Found `codex`." }, "no version line");

  onNextSpawn((c) => c.fail("ENOENT"));
  const missing = await bridge.test(id);
  assert.equal(missing.ok, false);
  assert.equal(missing.expected, true, "a missing CLI is the user's setup, not our defect");
  assert.match(missing.message, /`codex` isn't installed or not on PATH\. Install the Codex CLI/);
  assert.equal(spawned.length, 3);
  onNextSpawn((c) => void c.exit(0));
  assert.equal((await bridge.getSettings()).connections[0].usable, true, "getSettings probes again, and it is back");
  assert.equal(spawned.length, 4);
});

test("Test on a CLI preset the app does not know says so", async () => {
  writeFileSync(
    join(userData, "ai-settings.json"),
    JSON.stringify({
      connections: [{ id: "m", label: "Mystery", preset: "mystery-cli", wire: "cli", baseUrl: "", models: { fast: "", mid: "", deep: "" }, needsKey: false }],
    }),
  );
  const { bridge } = await makeBridge();
  assert.deepEqual(await bridge.test("m"), { ok: false, message: "Unknown local CLI." });
  assert.equal(spawned.length, 0);
});

// ── Test on an HTTP connection ────────────────────────────────────────────────

test("Test on an HTTP connection asks the fast model for a one-word reply", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("ollama")).connections[0].id;
  model.replies.push({ content: "OK" });
  const r = await bridge.test(id);
  assert.deepEqual(r, { ok: true, message: "Connected — llama3.2 responded.", model: "llama3.2" });
  const req = model.chats[0];
  assert.equal(req.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(req.body.model, "llama3.2", "the fast tier");
  assert.equal(req.body.max_tokens, 16);
  assert.match(String(req.body.messages?.[0].content), /Reply with exactly: OK/);
});

test("Test reports an empty reply, and a model that stopped cleanly with no text still counts", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("ollama")).connections[0].id;
  model.replies.push({ content: "", finish: "length" });
  assert.deepEqual(await bridge.test(id), { ok: false, message: "The model returned an empty response." });
  model.replies.push({ content: "", finish: "stop" });
  assert.equal((await bridge.test(id)).ok, true);
});

test("Test explains a rejected key in the provider's words", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("openai")).connections[0].id;
  await bridge.setKey(id, "sk-bad");
  model.replies.push(new Response("{}", { status: 401 }));
  const r = await bridge.test(id);
  assert.equal(r.ok, false);
  assert.match(r.message, /api\.openai\.com rejected the API key \(HTTP 401\)/);
});

test("Test on a connection removed a moment ago is an expected condition", async () => {
  const { bridge } = await makeBridge();
  assert.deepEqual(await bridge.test("gone"), { ok: false, expected: true, message: "Connection not found." });
});

// ── the model picker ─────────────────────────────────────────────────────────

test("with no connection the model picker is empty", async () => {
  const { bridge } = await makeBridge();
  assert.deepEqual(await bridge.listModels(), []);
});

test("the model picker offers configured models, then live ones, then known ones — once each", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("openai")).connections[0].id;
  await bridge.setKey(id, "sk-k");
  model.models = new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-live-1" }, { name: "named-model" }, {}] }));
  const ids = (await bridge.listModels(id)).map((m) => m.id);
  // configured: mid gpt-4o, deep gpt-4o (dup), fast gpt-4o-mini
  assert.deepEqual(ids, ["gpt-4o", "gpt-4o-mini", "gpt-live-1", "named-model", "o3", "o3-mini"]);
  const listing = model.all.find((r) => r.url.endsWith("/models"))!;
  assert.equal(listing.url, "https://api.openai.com/v1/models");
  assert.equal(listing.headers.Authorization, "Bearer sk-k");
});

test("a keyless server is listed without an Authorization header, from a `models` array", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("ollama")).connections[0].id;
  await bridge.updateConnection({ id, baseUrl: "http://localhost:11434/v1///" });
  model.models = new Response(JSON.stringify({ models: [{ name: "qwen3" }] }));
  const ids = (await bridge.listModels()).map((m) => m.id);
  assert.deepEqual(ids, ["qwen2.5-coder", "qwen2.5-coder:32b", "llama3.2", "qwen3"], "the default connection is used");
  const listing = model.all.find((r) => r.url.endsWith("/models"))!;
  assert.equal(listing.url, "http://localhost:11434/v1/models", "trailing slashes trimmed");
  assert.equal(listing.headers.Authorization, undefined);
});

test("Anthropic's model list needs the key, sent as x-api-key", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("anthropic")).connections[0].id;
  model.models = new Response(JSON.stringify({ data: [{ id: "claude-live" }] }));
  let ids = (await bridge.listModels(id)).map((m) => m.id);
  assert.equal(model.all.length, 0, "no key: no request");
  assert.deepEqual(ids, ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]);

  await bridge.setKey(id, "sk-ant");
  ids = (await bridge.listModels(id)).map((m) => m.id);
  const listing = model.all[0];
  assert.equal(listing.url, "https://api.anthropic.com/v1/models");
  assert.equal(listing.headers["x-api-key"], "sk-ant");
  assert.equal(listing.headers["anthropic-version"], "2023-06-01");
  assert.ok(ids.includes("claude-live"));
});

test("a failing or unreachable model list falls back to the known catalog", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("ollama")).connections[0].id;
  model.models = new Response("oops", { status: 500 });
  assert.deepEqual((await bridge.listModels(id)).map((m) => m.id), ["qwen2.5-coder", "qwen2.5-coder:32b", "llama3.2"]);
  model.models = () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual((await bridge.listModels(id)).map((m) => m.id), ["qwen2.5-coder", "qwen2.5-coder:32b", "llama3.2"]);
  model.models = new Response("not json");
  assert.equal((await bridge.listModels(id)).length, 3);
});

test("a CLI connection's models come from the known catalog, with no request", async () => {
  const { bridge } = await makeBridge();
  const id = (await bridge.addConnection("claude-code")).connections[0].id;
  assert.deepEqual((await bridge.listModels(id)).map((m) => m.id), ["sonnet", "opus", "haiku"]);
  assert.equal(model.all.length, 0);
  assert.equal(spawned.length, 0);
});
