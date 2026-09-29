// The Assistant's chats live in the main process and on disk, so a renderer
// refresh — or a full restart — never loses a conversation. These pin what a
// user relies on: the chat list per repository, which chat reopens, the title
// a chat earns from its first message, the cap on what is kept, and that a
// local CLI chat keeps (or resumes) ONE warm `claude` process.
//
// Electron's userData is a temp folder and `claude` a scripted FakeChild
// (aiBridge.fakes.ts).

import { onEverySpawn, resetSpawns, setUserData, spawned, until, type FakeChild } from "./aiBridge.fakes";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/main/assistantSessions";
import { removeTempRepo } from "./tmpRepo";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gs-ai-sessions-"));
  setUserData(dir);
  resetSpawns();
});
afterEach(() => removeTempRepo(dir));

const onDisk = () =>
  JSON.parse(readFileSync(join(dir, "ai-sessions.json"), "utf8")) as {
    sessions: { id: string; title: string; turns: unknown[]; cliSessionId?: string }[];
    currentByRepo: Record<string, string>;
  };

test("a new chat is persisted, listed for its repository only, and becomes current", async () => {
  const store = new ConversationStore();
  const a = await store.create("/r1", "conn-1", "chat-a");
  assert.equal(a.title, "New chat");
  assert.deepEqual(a.turns, []);
  await store.create("/r2", "conn-1", "chat-b");

  assert.deepEqual((await store.list("/r1")).map((s) => s.id), ["chat-a"]);
  assert.equal((await store.current("/r1"))?.id, "chat-a");
  assert.equal((await store.get("chat-b"))?.repoRoot, "/r2");
  assert.equal(await store.get("nope"), undefined);

  const disk = onDisk();
  assert.deepEqual(disk.sessions.map((s) => s.id).sort(), ["chat-a", "chat-b"]);
  assert.deepEqual(disk.currentByRepo, { "/r1": "chat-a", "/r2": "chat-b" });
});

test("a footer tab's chat does not steal the Assistant's current chat", async () => {
  const store = new ConversationStore();
  await store.create("/r", "c", "main-chat");
  await store.create("/r", "c", "footer-chat", false);
  assert.equal((await store.current("/r"))?.id, "main-chat");
  await store.setCurrent("/r", "footer-chat");
  assert.equal((await store.current("/r"))?.id, "footer-chat");
});

test("with no remembered chat, the most recently updated one reopens", async () => {
  const store = new ConversationStore();
  await store.create("/r", "c", "old", false);
  await store.create("/r", "c", "new", false);
  await store.appendTurn("old", { role: "user", text: "bump", at: Date.now() + 10_000 });
  assert.equal((await store.current("/r"))?.id, "old", "updatedAt decides, not creation order");
  assert.deepEqual((await store.list("/r")).map((s) => s.id), ["old", "new"]);
  assert.equal(await store.current("/elsewhere"), undefined);
});

test("a current chat remembered for another repository is not reopened here", async () => {
  writeFileSync(
    join(dir, "ai-sessions.json"),
    JSON.stringify({
      sessions: [
        { id: "x", repoRoot: "/other", connectionId: "c", title: "t", turns: [], createdAt: 1, updatedAt: 1 },
        { id: "y", repoRoot: "/r", connectionId: "c", title: "t", turns: [], createdAt: 1, updatedAt: 2 },
      ],
      currentByRepo: { "/r": "x" },
    }),
  );
  const store = new ConversationStore();
  assert.equal((await store.current("/r"))?.id, "y");
});

test("a chat's first user message becomes its title, collapsed and cut to 60 characters", async () => {
  const store = new ConversationStore();
  await store.create("/r", "c", "t1");
  await store.appendTurn("t1", { role: "assistant", text: "Hi there", at: 1 });
  assert.equal((await store.get("t1"))?.title, "New chat", "an assistant turn never names the chat");
  const long = "Why   does\nthe build " + "x".repeat(80);
  await store.appendTurn("t1", { role: "user", text: long, at: 2 });
  const title = (await store.get("t1"))!.title;
  assert.equal(title, long.slice(0, 60).replace(/\s+/g, " ").trim());
  assert.ok(!/\s{2}|\n/.test(title));
  await store.appendTurn("t1", { role: "user", text: "second question", at: 3 });
  assert.equal((await store.get("t1"))!.title, title, "only the first message names it");
  assert.equal((await store.get("t1"))!.turns.length, 3);
  assert.equal((await store.get("t1"))!.updatedAt, 3);

  await store.create("/r", "c", "blank");
  await store.appendTurn("blank", { role: "user", text: "   ", at: 4 });
  assert.equal((await store.get("blank"))!.title, "New chat", "a blank message leaves the default title");
});

test("appending to or naming a session for a chat that is gone does nothing", async () => {
  const store = new ConversationStore();
  await store.appendTurn("ghost", { role: "user", text: "x", at: 1 });
  await store.setCliSessionId("ghost", "s");
  assert.equal(await store.get("ghost"), undefined);
});

test("the CLI session id is persisted so the conversation resumes after a restart", async () => {
  const store = new ConversationStore();
  await store.create("/r", "c", "chat");
  await store.setCliSessionId("chat", "claude-sess-1");
  assert.equal(onDisk().sessions[0].cliSessionId, "claude-sess-1");
  await store.setCliSessionId("chat", undefined);
  assert.equal(onDisk().sessions[0].cliSessionId, "claude-sess-1", "an unknown id never erases the known one");

  const reopened = new ConversationStore();
  assert.equal((await reopened.get("chat"))?.cliSessionId, "claude-sess-1");
  assert.equal((await reopened.current("/r"))?.id, "chat", "and the current chat is remembered");
});

test("deleting a chat forgets it everywhere, including as the current chat", async () => {
  const store = new ConversationStore();
  await store.create("/r", "c", "gone");
  await store.create("/r", "c", "kept", false);
  await store.delete("gone");
  assert.equal(await store.get("gone"), undefined);
  assert.equal((await store.current("/r"))?.id, "kept", "falls back to what is left");
  assert.deepEqual(onDisk().currentByRepo, {});
  assert.deepEqual(onDisk().sessions.map((s) => s.id), ["kept"]);
  await store.delete("never-existed");
  assert.deepEqual(onDisk().sessions.map((s) => s.id), ["kept"]);
});

test("only the 60 most recent chats are kept", async () => {
  const store = new ConversationStore();
  for (let i = 0; i < 62; i++) {
    await store.create("/r", "c", `c${i}`, false);
    await store.appendTurn(`c${i}`, { role: "user", text: `m${i}`, at: 1000 + i });
  }
  const kept = await store.list("/r");
  assert.equal(kept.length, 60);
  assert.ok(!kept.some((s) => s.id === "c0" || s.id === "c1"), "the two oldest are dropped");
  assert.equal(kept[0].id, "c61");
  assert.equal(onDisk().sessions.length, 60);
});

test("an unreadable sessions file starts empty rather than failing", async () => {
  writeFileSync(join(dir, "ai-sessions.json"), "{ not json");
  const store = new ConversationStore();
  assert.deepEqual(await store.list("/r"), []);
  writeFileSync(join(dir, "ai-sessions.json"), JSON.stringify({ sessions: [null, { title: "no id" }] }));
  assert.deepEqual(await new ConversationStore().list("/r"), [], "entries without an id are skipped");
});

test("a failed write never fails the action", async () => {
  // userData is a FILE, so mkdir/writeFile fail underneath.
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "");
  setUserData(file);
  const store = new ConversationStore();
  const s = await store.create("/r", "c", "chat");
  assert.equal(s.id, "chat");
  assert.equal((await store.get("chat"))?.id, "chat", "kept in memory");
});

// ── warm CLI processes ────────────────────────────────────────────────────────

/** Every spawned `claude` answers each message and reports session `sid`. */
function claudeAnswering(sid: string) {
  onEverySpawn((c: FakeChild) => {
    c.json({ type: "system", session_id: sid });
    c.onStdinLine(() => {
      c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } });
      c.json({ type: "result" });
    });
  });
}

test("a chat's warm process is reused while alive and the model is unchanged", async () => {
  claudeAnswering("s1");
  const store = new ConversationStore();
  const w1 = store.warmFor("chat", { cwd: "/r", model: "sonnet" });
  await w1.send("hi", { onDelta: () => {} });
  const w2 = store.warmFor("chat", { cwd: "/r", model: "sonnet" });
  assert.equal(w2, w1, "same session object");
  assert.equal(spawned.length, 1);
  store.disposeAll();
  assert.equal(spawned[0].killed, true, "quitting kills every warm process");
});

test("switching model mid-chat replaces the process and carries the conversation over", async () => {
  claudeAnswering("s-carry");
  const store = new ConversationStore();
  const w1 = store.warmFor("chat", { cwd: "/r", model: "sonnet", resumeId: "older" });
  await w1.send("hi", { onDelta: () => {} });
  const w2 = store.warmFor("chat", { cwd: "/r", model: "opus" });
  assert.notEqual(w2, w1);
  assert.equal(spawned[0].killed, true, "the old model's process is stopped");
  await w2.send("again", { onDelta: () => {} });
  const args = spawned[1].args;
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--resume") + 1], "s-carry", "resumes the session the old process had");
  store.disposeAll();
});

test("a process that went away is replaced, resuming the persisted id when it never learned one", async () => {
  onEverySpawn(undefined);
  const store = new ConversationStore();
  const w1 = store.warmFor("chat", { cwd: "/r", model: "m" });
  assert.equal(w1.warm, false, "never started");
  claudeAnswering("fresh");
  const w2 = store.warmFor("chat", { cwd: "/r", model: "m", resumeId: "persisted" });
  assert.notEqual(w2, w1);
  await w2.send("q", { onDelta: () => {} });
  const args = spawned[0].args;
  assert.equal(args[args.indexOf("--resume") + 1], "persisted");
  store.disposeAll();
});

test("when a warm process exits the store drops it, and the next ask builds a new one", async () => {
  onEverySpawn((c) => {
    c.onStdinLine(() => {
      c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "bye" } } });
      void c.exit(0);
    });
  });
  const store = new ConversationStore();
  const w1 = store.warmFor("chat", { cwd: "/r" });
  assert.equal(await w1.send("q", { onDelta: () => {} }), "bye");
  await until(() => !w1.warm, "the process to be gone");
  const w2 = store.warmFor("chat", { cwd: "/r" });
  assert.notEqual(w2, w1);
  store.disposeAll();
});

test("deleting a chat kills its warm process", async () => {
  claudeAnswering("s");
  const store = new ConversationStore();
  await store.create("/r", "c", "chat");
  await store.warmFor("chat", { cwd: "/r" }).send("q", { onDelta: () => {} });
  await store.delete("chat");
  assert.equal(spawned[0].killed, true);
});
