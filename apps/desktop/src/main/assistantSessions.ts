// The durable home for Assistant chats. Because it lives in the MAIN process and
// persists to disk, a renderer refresh (or a full app restart) doesn't lose your
// conversation: the renderer just re-fetches the transcript, and — for a local
// CLI — reconnects to the still-warm process (or resumes the session by id). One
// chat == one session, regardless of provider.

import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WarmCliSession } from "./warmCliSession";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface ChatSession {
  id: string;
  repoRoot: string;
  connectionId: string;
  title: string;
  turns: ChatTurn[];
  /** Claude Code session id, so the conversation resumes after a full restart. */
  cliSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Keep at most this many chats persisted (most-recent first). */
const MAX_SESSIONS = 60;

export class ConversationStore {
  private sessions = new Map<string, ChatSession>();
  /** chatId → the active warm CLI process (runtime only, never persisted). */
  private warm = new Map<string, { session: WarmCliSession; model?: string }>();
  /** repoRoot → the chat the user last had open there. */
  private currentByRepo = new Map<string, string>();
  private loaded = false;

  private path(): string {
    return join(app.getPath("userData"), "ai-sessions.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.path(), "utf8")) as {
        sessions?: ChatSession[];
        currentByRepo?: Record<string, string>;
      };
      for (const s of raw.sessions ?? []) {
        if (s && s.id) this.sessions.set(s.id, s);
      }
      for (const [repo, id] of Object.entries(raw.currentByRepo ?? {})) {
        this.currentByRepo.set(repo, id);
      }
    } catch {
      /* no sessions yet */
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(app.getPath("userData"), { recursive: true });
      // Newest first, capped — drop the oldest beyond the cap.
      const sessions = [...this.sessions.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSIONS);
      const keep = new Set(sessions.map((s) => s.id));
      for (const id of [...this.sessions.keys()]) {
        if (!keep.has(id)) this.sessions.delete(id);
      }
      await writeFile(
        this.path(),
        JSON.stringify({ sessions, currentByRepo: Object.fromEntries(this.currentByRepo) }, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }

  // ── reads ──

  async list(repoRoot: string): Promise<ChatSession[]> {
    await this.ensureLoaded();
    return [...this.sessions.values()]
      .filter((s) => s.repoRoot === repoRoot)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ChatSession | undefined> {
    await this.ensureLoaded();
    return this.sessions.get(id);
  }

  /** The chat the user last had open in this repo (most recent as a fallback). */
  async current(repoRoot: string): Promise<ChatSession | undefined> {
    await this.ensureLoaded();
    const id = this.currentByRepo.get(repoRoot);
    const cur = id ? this.sessions.get(id) : undefined;
    if (cur && cur.repoRoot === repoRoot) return cur;
    return (await this.list(repoRoot))[0];
  }

  // ── writes ──

  async create(repoRoot: string, connectionId: string, id: string, makeCurrent = true): Promise<ChatSession> {
    await this.ensureLoaded();
    const now = Date.now();
    const s: ChatSession = { id, repoRoot, connectionId, title: "New chat", turns: [], createdAt: now, updatedAt: now };
    this.sessions.set(id, s);
    // Footer AI tabs pass makeCurrent=false so they don't steal the full
    // Assistant's "current chat" (the one it restores on open).
    if (makeCurrent) this.currentByRepo.set(repoRoot, id);
    await this.persist();
    return s;
  }

  async setCurrent(repoRoot: string, id: string): Promise<void> {
    await this.ensureLoaded();
    this.currentByRepo.set(repoRoot, id);
    await this.persist();
  }

  async appendTurn(id: string, turn: ChatTurn): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.turns.push(turn);
    s.updatedAt = turn.at;
    if (s.title === "New chat" && turn.role === "user") {
      s.title = turn.text.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
    }
    await this.persist();
  }

  async setCliSessionId(id: string, cliSessionId: string | undefined): Promise<void> {
    const s = this.sessions.get(id);
    if (s && cliSessionId && s.cliSessionId !== cliSessionId) {
      s.cliSessionId = cliSessionId;
      await this.persist();
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    this.warm.get(id)?.session.dispose();
    this.warm.delete(id);
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) {
      for (const [repo, cur] of this.currentByRepo) {
        if (cur === id) this.currentByRepo.delete(repo);
      }
    }
    await this.persist();
  }

  // ── warm CLI sessions ──

  /**
   * The warm Claude Code process for a chat. Reused while alive; respawned (and
   * resumed by session id) when idle/dead or when the model changes mid-chat.
   */
  warmFor(id: string, opts: { cwd: string | undefined; model?: string; resumeId?: string }): WarmCliSession {
    const existing = this.warm.get(id);
    if (existing && existing.session.warm && existing.model === opts.model) {
      return existing.session;
    }
    // Model changed (or process gone): drop the old one, carry context via resume.
    if (existing) {
      const carry = existing.session.id ?? opts.resumeId;
      existing.session.dispose();
      opts = { ...opts, resumeId: carry };
    }
    const session = new WarmCliSession({
      cwd: opts.cwd,
      model: opts.model,
      resumeId: opts.resumeId,
      onExit: () => {
        // Drop the reference once the process is gone (a later send respawns).
        if (this.warm.get(id)?.session === session) this.warm.delete(id);
      },
    });
    this.warm.set(id, { session, model: opts.model });
    return session;
  }

  /** Kill every warm process (on app quit). */
  disposeAll(): void {
    for (const { session } of this.warm.values()) session.dispose();
    this.warm.clear();
  }
}
