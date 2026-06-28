// The desktop's AI layer: owns the user's model connections, runs the inline ✨
// tasks and the Assistant agent, and brokers the MCP "Agent Access" config.
//
// It is the ONLY place API keys live: each connection's key is encrypted at rest
// with Electron safeStorage (userData/ai-keys/<id>.bin) and never crosses to the
// renderer — the renderer only ever sees a redacted AiConnectionView. All model
// traffic runs here in the main process (Node fetch), so there's no CORS and no
// secret in a web context. Everything degrades silently: with no usable
// connection the ✨ affordances and the Assistant simply stay hidden; git is
// never gated or blocked by AI.

import { app, safeStorage } from "electron";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_AGENT_CONFIG,
  EMPTY_AI_SETTINGS,
  PROVIDER_PRESETS,
  connectionFromPreset,
  generateChangelog,
  generateCommitMessage,
  generatePrDescription,
  explainConflict,
  explainDiff,
  isConnectionUsable,
  knownModels,
  makeProvider,
  pickConnection,
  resolveModelId,
  reviewDiff,
  runAgent,
  selectTools,
  suggestBranchNames,
  summarizeChanges,
  type AiSettings,
  type Connection,
  type GitTool,
  type Provider,
} from "@gitstudio/ai/index";
import { createGitToolHost } from "@gitstudio/git-service/index";
import { mcpInfo, installMcp } from "./mcpConfig";
import { CliProvider, cliSpecFor, detectCli, withThinking } from "./cliProvider";
import { ConversationStore, type ChatSession } from "./assistantSessions";
import type { RepoStore } from "./repoStore";
import type {
  AgentConfig,
  AgentConfirmAnswer,
  AgentRunRequest,
  AiConnectionPatch,
  AiConnectionView,
  AiDone,
  AiModelOption,
  AiPresetView,
  AiSettingsView,
  AiTaskInput,
  AiTaskName,
  AiTestResult,
  ChatSendRequest,
  ChatSummary,
  ChatView,
  IpcEvents,
  McpInfo,
  McpInstallRequest,
} from "../shared/ipc";

type Send = <E extends keyof IpcEvents>(event: E, data: IpcEvents[E]) => void;

/** How long the agent waits for the user to approve a write before giving up. */
const CONFIRM_TIMEOUT_MS = 120_000;

export class AiBridge {
  private settings: AiSettings = { ...EMPTY_AI_SETTINGS };
  private loaded = false;
  /** In-memory decrypted key cache, keyed by connection id. */
  private readonly keyCache = new Map<string, string>();
  /** In-flight requests → their AbortController (for ai:cancel). */
  private readonly aborts = new Map<string, AbortController>();
  /** Pending agent write-confirmations → their resolver. */
  private readonly confirms = new Map<string, (approved: boolean) => void>();
  /** Cached CLI-availability per preset (is `claude`/`codex`/`gemini` installed?). */
  private readonly cliDetect = new Map<string, boolean>();
  /** Persisted Assistant chats + their warm CLI processes (survive refresh). */
  private readonly chats = new ConversationStore();

  constructor(
    private readonly repos: RepoStore,
    private readonly send: Send,
  ) {}

  // ── persistence ────────────────────────────────────────────────────────────

  private settingsPath(): string {
    return join(app.getPath("userData"), "ai-settings.json");
  }
  private keyPath(id: string): string {
    return join(app.getPath("userData"), "ai-keys", `${id}.bin`);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.settingsPath(), "utf8");
      const parsed = JSON.parse(raw) as AiSettings;
      if (parsed && Array.isArray(parsed.connections)) {
        this.settings = parsed;
      }
    } catch {
      // No settings yet — start empty.
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(this.settingsPath(), JSON.stringify(this.settings, null, 2));
    } catch {
      // Best-effort; never block a UI action on persistence.
    }
  }

  // ── keys (encrypted at rest) ─────────────────────────────────────────────────

  private hasKeyFile(id: string): boolean {
    return existsSync(this.keyPath(id));
  }

  private async loadKey(id: string): Promise<string | undefined> {
    if (this.keyCache.has(id)) {
      return this.keyCache.get(id);
    }
    try {
      const buf = await readFile(this.keyPath(id));
      const key = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString("utf8");
      this.keyCache.set(id, key);
      return key;
    } catch {
      return undefined;
    }
  }

  private async storeKey(id: string, key: string): Promise<void> {
    await mkdir(join(app.getPath("userData"), "ai-keys"), { recursive: true });
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, "utf8");
    await writeFile(this.keyPath(id), data);
    this.keyCache.set(id, key);
  }

  private async deleteKey(id: string): Promise<void> {
    this.keyCache.delete(id);
    try {
      await unlink(this.keyPath(id));
    } catch {
      // already gone
    }
  }

  // ── views ────────────────────────────────────────────────────────────────────

  private connView(conn: Connection): AiConnectionView {
    const hasKey = this.hasKeyFile(conn.id);
    // For a CLI connection, "usable" means the binary was detected on PATH
    // (defaults to optimistic `true` until the first detection completes).
    const usable =
      conn.wire === "cli"
        ? this.cliDetect.get(conn.preset) ?? true
        : isConnectionUsable(conn, hasKey);
    return {
      id: conn.id,
      label: conn.label,
      preset: conn.preset,
      wire: conn.wire,
      baseUrl: conn.baseUrl,
      models: { ...conn.models },
      needsKey: conn.needsKey,
      local: conn.local === true,
      hasKey,
      usable,
    };
  }

  /** Probe each distinct CLI preset in use so the settings view shows real status. */
  private async refreshCliDetection(): Promise<void> {
    const presets = new Set(
      this.settings.connections.filter((c) => c.wire === "cli").map((c) => c.preset),
    );
    await Promise.all(
      [...presets].map(async (preset) => {
        const spec = cliSpecFor(preset);
        if (spec) {
          const { ok } = await detectCli(spec.command);
          this.cliDetect.set(preset, ok);
        }
      }),
    );
  }

  private agentConfig() {
    return { ...DEFAULT_AGENT_CONFIG, ...(this.settings.agent ?? {}) };
  }

  private view(): AiSettingsView {
    const connections = this.settings.connections.map((c) => this.connView(c));
    return {
      connections,
      defaultId: this.settings.defaultId,
      enabled: connections.some((c) => c.usable),
      agent: this.agentConfig(),
    };
  }

  async setAgentConfig(patch: Partial<AgentConfig>): Promise<AiSettingsView> {
    await this.ensureLoaded();
    this.settings.agent = { ...this.agentConfig(), ...patch };
    await this.persist();
    return this.view();
  }

  /**
   * The models the connection's provider offers — propagated to the in-app
   * picker so the user picks a real model directly (no manual setup). HTTP
   * providers are queried live (`/models`); CLIs and any failures fall back to a
   * known catalog. The connection's own configured models are always included.
   */
  async listModels(connectionId?: string): Promise<AiModelOption[]> {
    await this.ensureLoaded();
    const conn =
      (connectionId ? this.settings.connections.find((c) => c.id === connectionId) : undefined) ??
      pickConnection(this.settings);
    if (!conn) {
      return [];
    }
    const ids: string[] = [];
    // Always offer whatever the connection already has configured.
    for (const t of ["mid", "deep", "fast"] as const) {
      const m = conn.models[t]?.trim();
      if (m) ids.push(m);
    }
    if (conn.wire !== "cli") {
      const live = await this.fetchModels(conn).catch(() => []);
      ids.push(...live);
    }
    ids.push(...knownModels(conn.preset));
    // Dedupe, preserving order (configured + live first, then known).
    const seen = new Set<string>();
    const out: AiModelOption[] = [];
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id });
      }
    }
    return out;
  }

  /** Live-query a HTTP provider's model list (best-effort, short timeout). */
  private async fetchModels(conn: Connection): Promise<string[]> {
    const base = conn.baseUrl.replace(/\/+$/, "");
    const isAnthropic = conn.wire === "anthropic";
    const url = isAnthropic ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> = {};
    const key = await this.loadKey(conn.id);
    if (isAnthropic) {
      if (!key) return [];
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        data?: Array<{ id?: string; name?: string }>;
        models?: Array<{ id?: string; name?: string }>;
      };
      const list = json.data ?? json.models ?? [];
      return list.map((m) => m.id ?? m.name ?? "").filter((s): s is string => s.length > 0);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async getSettings(): Promise<AiSettingsView> {
    await this.ensureLoaded();
    await this.refreshCliDetection();
    return this.view();
  }

  catalog(): AiPresetView[] {
    return PROVIDER_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      blurb: p.blurb,
      wire: p.wire,
      baseUrl: p.baseUrl,
      needsKey: p.needsKey,
      local: p.local === true,
      keyUrl: p.keyUrl,
      icon: p.icon,
      note: p.note,
      models: { ...p.models },
    }));
  }

  // ── connection CRUD ──────────────────────────────────────────────────────────

  async addConnection(presetId: string): Promise<AiSettingsView> {
    await this.ensureLoaded();
    const conn = connectionFromPreset(presetId, randomUUID());
    this.settings.connections.push(conn);
    if (!this.settings.defaultId) {
      this.settings.defaultId = conn.id;
    }
    await this.persist();
    return this.view();
  }

  async updateConnection(patch: AiConnectionPatch): Promise<AiSettingsView> {
    await this.ensureLoaded();
    const conn = this.settings.connections.find((c) => c.id === patch.id);
    if (conn) {
      if (typeof patch.label === "string") conn.label = patch.label;
      if (typeof patch.baseUrl === "string") conn.baseUrl = patch.baseUrl;
      if (patch.models) conn.models = { ...patch.models };
      await this.persist();
    }
    return this.view();
  }

  async removeConnection(id: string): Promise<AiSettingsView> {
    await this.ensureLoaded();
    this.settings.connections = this.settings.connections.filter((c) => c.id !== id);
    if (this.settings.defaultId === id) {
      this.settings.defaultId = this.settings.connections[0]?.id;
    }
    await this.deleteKey(id);
    await this.persist();
    return this.view();
  }

  async setDefault(id: string): Promise<AiSettingsView> {
    await this.ensureLoaded();
    if (this.settings.connections.some((c) => c.id === id)) {
      this.settings.defaultId = id;
      await this.persist();
    }
    return this.view();
  }

  async setKey(id: string, key: string): Promise<AiSettingsView> {
    await this.ensureLoaded();
    if (key.trim().length === 0) {
      await this.deleteKey(id);
    } else {
      await this.storeKey(id, key.trim());
    }
    return this.view();
  }

  async test(id: string): Promise<AiTestResult> {
    await this.ensureLoaded();
    const conn = this.settings.connections.find((c) => c.id === id);
    if (!conn) {
      return { ok: false, message: "Connection not found." };
    }
    // CLI connections: just confirm the binary is installed (don't spend quota).
    if (conn.wire === "cli") {
      const spec = cliSpecFor(conn.preset);
      if (!spec) {
        return { ok: false, message: "Unknown local CLI." };
      }
      const { ok, version } = await detectCli(spec.command);
      this.cliDetect.set(conn.preset, ok);
      return ok
        ? { ok: true, message: `Found \`${spec.command}\`${version ? ` (${version})` : ""}.` }
        : { ok: false, message: `\`${spec.command}\` isn't installed or not on PATH. ${spec.install}` };
    }
    const provider = this.providerFor(conn);
    try {
      const r = await provider.chat(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { model: "fast", maxTokens: 16 },
      );
      const model = resolveModelId(conn, "fast") ?? "model";
      if (r.text.trim().length > 0 || r.stopReason === "stop") {
        return { ok: true, message: `Connected — ${model} responded.`, model };
      }
      return { ok: false, message: "The model returned an empty response." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── provider resolution ──────────────────────────────────────────────────────

  private providerFor(conn: Connection): Provider {
    if (conn.wire === "cli") {
      return new CliProvider({
        preset: conn.preset,
        cwd: this.repos.current()?.root,
        resolveModel: (tier) => resolveModelId(conn, tier ?? "mid"),
        label: `${conn.label}${conn.models.mid ? ` · ${conn.models.mid}` : ""}`,
      });
    }
    return makeProvider(conn, () => this.loadKey(conn.id));
  }

  private async resolveProvider(connectionId?: string, task?: string): Promise<{ provider: Provider; conn: Connection } | undefined> {
    await this.ensureLoaded();
    let conn: Connection | undefined;
    if (connectionId) {
      conn = this.settings.connections.find((c) => c.id === connectionId);
    }
    conn ??= pickConnection(this.settings, task);
    if (!conn) {
      return undefined;
    }
    if (!isConnectionUsable(conn, this.hasKeyFile(conn.id))) {
      return undefined;
    }
    return { provider: this.providerFor(conn), conn };
  }

  // ── one-shot tasks ───────────────────────────────────────────────────────────

  async runTask(requestId: string, task: AiTaskName, input: AiTaskInput): Promise<AiDone> {
    const resolved = await this.resolveProvider(input.connectionId, task);
    if (!resolved) {
      return { requestId, ok: false, message: "No AI model is connected. Add one in Settings ▸ AI." };
    }
    const ctx = this.repos.getContext();
    if (!ctx) {
      return { requestId, ok: false, message: "No repository is open." };
    }
    const host = createGitToolHost(ctx);
    const abort = new AbortController();
    this.aborts.set(requestId, abort);
    const onDelta = (delta: string) => this.send("ai:delta", { requestId, delta });
    const taskCtx = { signal: abort.signal, onDelta };

    try {
      const { provider } = resolved;
      let text: string | null = null;
      switch (task) {
        case "commitMessage": {
          const diff = input.diff ?? (await host.diff({ staged: true }));
          if (!diff.trim()) {
            return { requestId, ok: false, message: "Nothing is staged to summarize." };
          }
          const recent = input.commits ?? (await host.log({ limit: 10 })).map((c) => c.subject);
          text = await generateCommitMessage(provider, diff, { recentSubjects: recent, ctx: taskCtx });
          break;
        }
        case "explainDiff": {
          const diff = input.diff ?? (await this.gatherDiff(host, input));
          text = await explainDiff(provider, diff, taskCtx);
          break;
        }
        case "summarizeChanges": {
          const diff = input.diff ?? (await this.gatherDiff(host, input));
          text = await summarizeChanges(provider, diff, taskCtx);
          break;
        }
        case "prDescription": {
          const base = input.base ?? "main";
          const cmp = input.commits ? undefined : await host.compare(base, "HEAD");
          const commits = input.commits ?? (cmp?.commits ?? []).map((c) => c.subject);
          const diff = input.diff ?? (await host.diff({ base, head: "HEAD" }));
          text = await generatePrDescription(provider, commits, diff, taskCtx);
          break;
        }
        case "reviewDiff": {
          const diff = input.diff ?? (await this.gatherDiff(host, input));
          text = await reviewDiff(provider, diff, taskCtx);
          break;
        }
        case "explainConflict": {
          const conflict = input.conflict ?? (await this.gatherConflict(input.path));
          if (!conflict) {
            return { requestId, ok: false, message: "Couldn't read the conflict." };
          }
          text = await explainConflict(provider, conflict, taskCtx);
          break;
        }
        case "changelog": {
          const base = input.base;
          const range = base ? `${base}..HEAD` : "HEAD";
          const commits = input.commits ?? (await host.log({ ref: range, limit: 200 })).map((c) => c.subject);
          text = await generateChangelog(provider, commits, { ctx: taskCtx });
          break;
        }
        case "branchName": {
          text = await suggestBranchNames(provider, input.description ?? "", taskCtx);
          break;
        }
        default:
          return { requestId, ok: false, message: `Unknown task: ${task}` };
      }
      if (text === null) {
        return { requestId, ok: false, message: "The model returned nothing." };
      }
      return { requestId, ok: true, text };
    } catch (err) {
      return { requestId, ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.aborts.delete(requestId);
    }
  }

  private async gatherDiff(host: ReturnType<typeof createGitToolHost>, input: AiTaskInput): Promise<string> {
    if (input.sha) {
      // The commit's diff vs its first parent.
      return host.diff({ base: `${input.sha}^`, head: input.sha, path: input.path });
    }
    if (input.base) {
      return host.diff({ base: input.base, head: "HEAD", path: input.path });
    }
    // Default: the unstaged working-tree diff (fall back to staged if empty).
    const working = await host.diff({ path: input.path });
    return working.trim() ? working : host.diff({ staged: true, path: input.path });
  }

  private async gatherConflict(path?: string): Promise<{ path: string; base?: string; ours: string; theirs: string } | undefined> {
    const ctx = this.repos.getContext();
    if (!ctx || !path) {
      return undefined;
    }
    const read = async (stage: number): Promise<string> => {
      const r = await ctx.process.run(["show", `:${stage}:${path}`]).catch(() => null);
      return r && r.code === 0 ? r.stdout : "";
    };
    const ours = await read(2);
    const theirs = await read(3);
    if (!ours && !theirs) {
      return undefined;
    }
    const base = await read(1);
    return { path, base: base || undefined, ours, theirs };
  }

  cancel(requestId: string): void {
    this.aborts.get(requestId)?.abort();
    this.aborts.delete(requestId);
    // Deny any pending confirmations for this request so the agent unwinds.
    for (const [callId, resolve] of this.confirms) {
      if (callId.startsWith(requestId)) {
        resolve(false);
        this.confirms.delete(callId);
      }
    }
  }

  // ── agent ────────────────────────────────────────────────────────────────────

  async runAgentTask(req: AgentRunRequest): Promise<AiDone> {
    const { requestId } = req;
    const resolved = await this.resolveProvider(req.connectionId, "agent");
    if (!resolved) {
      return { requestId, ok: false, message: "No AI model is connected. Add one in Settings ▸ AI." };
    }
    const ctx = this.repos.getContext();
    if (!ctx) {
      return { requestId, ok: false, message: "Open a repository first." };
    }
    const host = createGitToolHost(ctx);
    const tools = selectTools({ write: req.allowWrite, destructive: req.allowDestructive });
    const abort = new AbortController();
    this.aborts.set(requestId, abort);

    try {
      const cfg = this.agentConfig();
      const result = await runAgent(req.goal, {
        provider: resolved.provider,
        host,
        tools,
        model: req.model ?? cfg.model,
        modelId: req.modelId ?? cfg.modelId,
        thinking: req.thinking ?? cfg.thinking,
        signal: abort.signal,
        onTextDelta: (delta) => this.send("ai:delta", { requestId, delta }),
        onEvent: (e) => {
          this.send("ai:agentEvent", {
            requestId,
            kind: e.type,
            text: "text" in e ? e.text : undefined,
            tool: "name" in e ? e.name : undefined,
            args: e.type === "tool_call" ? e.args : undefined,
            isError: e.type === "tool_result" ? e.isError : undefined,
            callId: "id" in e ? e.id : undefined,
          });
        },
        confirm: (tool, args) => this.awaitConfirm(requestId, tool, args),
      });
      return { requestId, ok: result.stopped !== "error", text: result.text };
    } catch (err) {
      return { requestId, ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.aborts.delete(requestId);
    }
  }

  /** Ask the renderer to approve a write/destructive tool, resolving on its answer. */
  private awaitConfirm(requestId: string, tool: GitTool, args: Record<string, unknown>): Promise<boolean> {
    const callId = `${requestId}:${randomUUID()}`;
    this.send("ai:confirmRequest", {
      requestId,
      callId,
      tool: tool.name,
      title: tool.title,
      summary: summarizeArgs(tool, args),
      mode: tool.mode === "destructive" ? "destructive" : "write",
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.confirms.delete(callId);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      this.confirms.set(callId, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });
    });
  }

  confirmAnswer(answer: AgentConfirmAnswer): void {
    const resolve = this.confirms.get(answer.callId);
    if (resolve) {
      this.confirms.delete(answer.callId);
      resolve(answer.approved);
    }
  }

  // ── MCP "Agent Access" ───────────────────────────────────────────────────────

  mcpInfo(): McpInfo {
    return mcpInfo(this.repos.current()?.root);
  }

  mcpInstall(req: McpInstallRequest): { ok: boolean; message: string } {
    return installMcp(this.repos.current()?.root, req);
  }

  // ── Assistant chats (persisted sessions) ─────────────────────────────────────

  private static chatView(s: ChatSession): ChatView {
    return {
      id: s.id,
      title: s.title,
      connectionId: s.connectionId,
      turns: s.turns.map((t) => ({ role: t.role, text: t.text })),
    };
  }

  async chatList(): Promise<ChatSummary[]> {
    const root = this.repos.current()?.root;
    if (!root) return [];
    return (await this.chats.list(root)).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
  }

  async chatGet(id: string): Promise<ChatView | undefined> {
    const s = await this.chats.get(id);
    return s ? AiBridge.chatView(s) : undefined;
  }

  async chatCurrent(): Promise<ChatView | undefined> {
    const root = this.repos.current()?.root;
    if (!root) return undefined;
    const s = await this.chats.current(root);
    return s ? AiBridge.chatView(s) : undefined;
  }

  async chatNew(): Promise<ChatView | undefined> {
    await this.ensureLoaded();
    const root = this.repos.current()?.root;
    const conn = pickConnection(this.settings);
    if (!root || !conn) return undefined;
    const s = await this.chats.create(root, conn.id, randomUUID());
    return AiBridge.chatView(s);
  }

  async chatSetCurrent(id: string): Promise<void> {
    const root = this.repos.current()?.root;
    if (root) await this.chats.setCurrent(root, id);
  }

  async chatDelete(id: string): Promise<void> {
    await this.chats.delete(id);
  }

  /** Send a message in a chat — warm CLI session for a CLI provider, multi-turn agent for HTTP. */
  async chatSend(req: ChatSendRequest): Promise<AiDone> {
    const { chatId, requestId } = req;
    const session = await this.chats.get(chatId);
    if (!session) {
      return { requestId, ok: false, message: "This chat no longer exists." };
    }
    const resolved = await this.resolveProvider(session.connectionId, "agent");
    if (!resolved) {
      return { requestId, ok: false, message: "No AI model is connected. Add one in Settings ▸ AI." };
    }
    const ctx = this.repos.getContext();
    if (!ctx) {
      return { requestId, ok: false, message: "Open a repository first." };
    }
    const cfg = this.agentConfig();
    const abort = new AbortController();
    this.aborts.set(requestId, abort);
    // History (prior turns) is captured BEFORE we append this user message.
    const history = session.turns.map((t) => ({ role: t.role, content: t.text }));
    await this.chats.appendTurn(chatId, { role: "user", text: req.goal, at: Date.now() });

    try {
      if (resolved.conn.wire === "cli") {
        const model = req.modelId ?? resolveModelId(resolved.conn, cfg.model);
        const warm = this.chats.warmFor(chatId, { cwd: ctx.root, model, resumeId: session.cliSessionId });
        const prompt = withThinking(req.goal, req.thinking ?? cfg.thinking);
        let acc = "";
        const text = await warm.send(prompt, {
          onDelta: (d) => {
            acc += d;
            this.send("ai:delta", { requestId, delta: d });
          },
          signal: abort.signal,
        });
        await this.chats.setCliSessionId(chatId, warm.id);
        const final = (text || acc).trim();
        await this.chats.appendTurn(chatId, { role: "assistant", text: final, at: Date.now() });
        return { requestId, ok: true, text: final };
      }

      const host = createGitToolHost(ctx);
      const tools = selectTools({ write: req.allowWrite, destructive: req.allowDestructive });
      const result = await runAgent(req.goal, {
        provider: resolved.provider,
        host,
        tools,
        model: cfg.model,
        modelId: req.modelId ?? cfg.modelId,
        thinking: req.thinking ?? cfg.thinking,
        history,
        signal: abort.signal,
        onTextDelta: (delta) => this.send("ai:delta", { requestId, delta }),
        onEvent: (e) => {
          this.send("ai:agentEvent", {
            requestId,
            kind: e.type,
            text: "text" in e ? e.text : undefined,
            tool: "name" in e ? e.name : undefined,
            args: e.type === "tool_call" ? e.args : undefined,
            isError: e.type === "tool_result" ? e.isError : undefined,
            callId: "id" in e ? e.id : undefined,
          });
        },
        confirm: (tool, args) => this.awaitConfirm(requestId, tool, args),
      });
      await this.chats.appendTurn(chatId, { role: "assistant", text: result.text, at: Date.now() });
      return { requestId, ok: result.stopped !== "error", text: result.text };
    } catch (err) {
      return { requestId, ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.aborts.delete(requestId);
    }
  }

  /** Kill warm CLI processes (called on app quit). */
  dispose(): void {
    this.chats.disposeAll();
  }
}

/** A short, human-readable summary of what a tool call will do, for the confirm UI. */
function summarizeArgs(tool: GitTool, args: Record<string, unknown>): string {
  switch (tool.name) {
    case "git_commit":
      return `Commit staged changes:\n“${String(args.message ?? "").split("\n")[0]}”`;
    case "git_stage":
      return args.all ? "Stage all changes." : `Stage: ${asList(args.paths)}`;
    case "git_unstage":
      return args.all ? "Unstage everything." : `Unstage: ${asList(args.paths)}`;
    case "git_create_branch":
      return `Create branch “${String(args.name ?? "")}”${args.checkout ? " and switch to it" : ""}.`;
    case "git_checkout":
      return `Switch to “${String(args.ref ?? "")}”.`;
    case "git_stash_save":
      return `Stash working-tree changes${args.message ? ` (“${String(args.message)}”)` : ""}.`;
    case "git_discard":
      return `Permanently discard changes to: ${asList(args.paths)}`;
    case "git_delete_branch":
      return `Delete branch “${String(args.name ?? "")}”${args.force ? " (force)" : ""}.`;
    case "git_reset":
      return `Reset (${String(args.mode ?? "")}) to ${String(args.ref ?? "")}.`;
    default:
      return `${tool.title}: ${JSON.stringify(args)}`;
  }
}

function asList(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
}
