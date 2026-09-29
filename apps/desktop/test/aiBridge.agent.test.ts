// The Assistant: the agent run (ai:agentRun), the approval gate in front of
// every write, and the persisted chats (ai:chat*) — over an HTTP model that
// calls git tools, and over a warm local `claude`.
//
// What is pinned is what a user relies on: a write happens only after they
// approve it (and never after they deny, cancel, or walk away); the tool steps
// stream to the renderer; a chat remembers its turns and hands them back to
// the model; a local CLI chat pays the cold start once and resumes after.
//
// Real throwaway repository; fake fetch model; scripted FakeChild `claude`.

import { onEverySpawn, onNextSpawn, resetSpawns, spawned, until, type FakeChild } from "./aiBridge.fakes";
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeArgs } from "../src/main/aiBridge";
import { cleanupAll, fakeModel, freshUserData, makeBridge, makeRepo, type FakeModel, type Sent } from "./aiBridge.harness";

let model: FakeModel;
let userData: string;
beforeEach(() => {
  userData = freshUserData();
  model = fakeModel();
  resetSpawns();
});
afterEach(() => {
  model.restore();
  cleanupAll();
});

async function setup(preset = "ollama") {
  const repo = makeRepo();
  const b = await makeBridge(repo.root);
  const connId = (await b.bridge.addConnection(preset)).connections[0].id;
  return { ...repo, ...b, connId };
}

const events = (sent: Sent[], kind?: string) =>
  sent.filter((s) => s.event === "ai:agentEvent" && (!kind || s.data.kind === kind)).map((s) => s.data);
const confirms = (sent: Sent[]) => sent.filter((s) => s.event === "ai:confirmRequest").map((s) => s.data);
const staged = (git: (...a: string[]) => string) => git("diff", "--cached", "--name-only").trim();

// ── agent runs ────────────────────────────────────────────────────────────────

test("the agent reads the repo with a tool, and every step streams to the renderer", async () => {
  const { bridge, root, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  model.replies.push(
    { content: "Let me look.", toolCalls: [{ id: "c1", name: "git_status", args: {} }] },
    { content: "One file changed: a.txt." },
  );
  const r = await bridge.runAgentTask({ requestId: "q1", goal: "what changed?", allowWrite: false, allowDestructive: false });
  assert.deepEqual(r, { requestId: "q1", ok: true, text: "One file changed: a.txt." });

  const call = events(sent, "tool_call")[0];
  assert.equal(call.tool, "git_status");
  assert.equal(call.callId, "c1");
  assert.deepEqual(call.args, {});
  const result = events(sent, "tool_result")[0];
  assert.equal(result.isError, false);
  assert.match(String(result.text), /a\.txt/, "the tool ran against the real repository");
  assert.equal(events(sent, "done").length, 1);
  assert.ok(events(sent).every((e) => e.requestId === "q1"));

  // The tool's output went back to the model on the next turn.
  const second = model.chats[1].body.messages!;
  assert.ok(second.some((m) => m.role === "tool" && /a\.txt/.test(String(m.content))));
  assert.equal(confirms(sent).length, 0, "a read needs no approval");
  // A read-only run offers no write tools at all.
  const tools = (model.chats[0].body.tools as { function: { name: string } }[]).map((t) => t.function.name);
  assert.ok(tools.includes("git_status") && !tools.includes("git_stage") && !tools.includes("git_reset"));
});

test("the run uses the requested tier, or an explicit model id over it", async () => {
  const { bridge } = await setup();
  model.replies.push({ content: "a" }, { content: "b" });
  await bridge.runAgentTask({ requestId: "t", goal: "g", allowWrite: false, allowDestructive: false, model: "fast" });
  assert.equal(model.chats[0].body.model, "llama3.2");
  await bridge.runAgentTask({ requestId: "t2", goal: "g", allowWrite: false, allowDestructive: false, modelId: "custom:7b" });
  assert.equal(model.chats[1].body.model, "custom:7b");
});

test("a write waits for approval, says what it will do, and happens once approved", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  model.replies.push({ toolCalls: [{ id: "w1", name: "git_stage", args: { paths: ["a.txt"] } }] }, { content: "Staged." });
  const run = bridge.runAgentTask({ requestId: "w", goal: "stage it", allowWrite: true, allowDestructive: false });
  await until(() => confirms(sent).length === 1, "the approval request");

  const ask = confirms(sent)[0];
  assert.equal(ask.requestId, "w");
  assert.equal(ask.tool, "git_stage");
  assert.equal(ask.mode, "write");
  assert.equal(ask.summary, "Stage: a.txt");
  assert.match(String(ask.callId), /^w:/, "the call id is scoped to its request");
  assert.equal(staged(git), "", "nothing is staged while the user decides");

  bridge.confirmAnswer({ callId: String(ask.callId), approved: true });
  const r = await run;
  assert.equal(r.ok, true);
  assert.equal(staged(git), "a.txt", "approved: the write really happened");
});

test("a denied write does not happen, and the model is told", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  model.replies.push({ toolCalls: [{ id: "w1", name: "git_stage", args: { all: true } }] }, { content: "Okay, left it." });
  const run = bridge.runAgentTask({ requestId: "d", goal: "stage", allowWrite: true, allowDestructive: false });
  await until(() => confirms(sent).length === 1, "the approval request");
  assert.equal(confirms(sent)[0].summary, "Stage all changes.");
  bridge.confirmAnswer({ callId: String(confirms(sent)[0].callId), approved: false });
  bridge.confirmAnswer({ callId: String(confirms(sent)[0].callId), approved: true }); // a late second answer is ignored
  const r = await run;
  assert.equal(r.text, "Okay, left it.");
  assert.equal(staged(git), "", "denied: nothing staged");
  assert.equal(events(sent, "tool_denied").length, 1);
});

test("a destructive tool asks in destructive mode and spells out the loss", async () => {
  const { bridge, root, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "precious edit\n");
  model.replies.push({ toolCalls: [{ id: "x", name: "git_discard", args: { paths: ["a.txt"] } }] }, { content: "Kept." });
  const run = bridge.runAgentTask({ requestId: "z", goal: "discard", allowWrite: true, allowDestructive: true });
  await until(() => confirms(sent).length === 1, "the approval request");
  const ask = confirms(sent)[0];
  assert.equal(ask.mode, "destructive");
  assert.match(String(ask.summary), /can't be undone/);
  bridge.confirmAnswer({ callId: String(ask.callId), approved: false });
  await run;
  assert.equal(readFileSync(join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "precious edit\n", "the edit survives");
});

test("cancelling a run while it waits for approval denies the write", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  model.replies.push({ toolCalls: [{ id: "w1", name: "git_stage", args: { paths: ["a.txt"] } }] }, { content: "never asked" });
  const run = bridge.runAgentTask({ requestId: "cx", goal: "stage", allowWrite: true, allowDestructive: false });
  await until(() => confirms(sent).length === 1, "the approval request");
  bridge.cancel("cx");
  const r = await run;
  assert.equal(r.text, "", "the run stops rather than answering");
  assert.equal(staged(git), "");
  assert.equal(model.chats.length, 1, "the model is not asked again after a cancel");
  // Approving after the cancel is too late.
  bridge.confirmAnswer({ callId: String(confirms(sent)[0].callId), approved: true });
  assert.equal(staged(git), "");
});

test("an approval nobody answers is denied after two minutes", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  model.replies.push({ toolCalls: [{ id: "w1", name: "git_stage", args: { paths: ["a.txt"] } }] }, { content: "Timed out, left it." });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = bridge.runAgentTask({ requestId: "to", goal: "stage", allowWrite: true, allowDestructive: false });
    await until(() => confirms(sent).length === 1, "the approval request");
    mock.timers.tick(119_999);
    await new Promise((r) => setImmediate(r));
    assert.equal(model.chats.length, 1, "still waiting just before the limit");
    mock.timers.tick(1);
    const r = await run;
    assert.equal(r.text, "Timed out, left it.");
    assert.equal(staged(git), "", "no answer is a no");
    assert.equal(events(sent, "tool_denied").length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a model failure ends the run as not ok, with the reason as an event", async () => {
  const { bridge, sent } = await setup();
  model.replies.push(new Response("", { status: 429 }));
  const r = await bridge.runAgentTask({ requestId: "e", goal: "g", allowWrite: false, allowDestructive: false });
  assert.equal(r.ok, false);
  assert.match(String(events(sent, "error")[0].text), /rate limit/);
});

test("the agent needs a model and an open repository", async () => {
  const repo = makeRepo();
  const { bridge } = await makeBridge(repo.root);
  const req = { requestId: "n", goal: "g", allowWrite: false, allowDestructive: false };
  assert.deepEqual(await bridge.runAgentTask(req), {
    requestId: "n",
    ok: false,
    expected: true,
    message: "No AI model is connected. Add one in Settings ▸ AI.",
  });
  const { bridge: noRepo } = await makeBridge();
  await noRepo.addConnection("ollama");
  assert.deepEqual(await noRepo.runAgentTask(req), { requestId: "n", ok: false, expected: true, message: "Open a repository first." });
});

// ── chats ─────────────────────────────────────────────────────────────────────

test("with no repository there are no chats, and none can be started", async () => {
  const { bridge } = await makeBridge();
  await bridge.addConnection("ollama");
  assert.deepEqual(await bridge.chatList(), []);
  assert.equal(await bridge.chatCurrent(), undefined);
  assert.equal(await bridge.chatNew(), undefined);
  await bridge.chatSetCurrent("anything"); // harmless
});

test("with no model a chat cannot be started", async () => {
  const repo = makeRepo();
  const { bridge } = await makeBridge(repo.root);
  assert.equal(await bridge.chatNew(), undefined);
});

test("chats are created, listed, reopened and deleted per repository", async () => {
  const { bridge, connId } = await setup();
  const a = (await bridge.chatNew())!;
  assert.deepEqual(a, { id: a.id, title: "New chat", connectionId: connId, turns: [] });
  const footer = (await bridge.chatNew(false))!;
  assert.equal((await bridge.chatCurrent())?.id, a.id, "a footer chat does not take over");
  await bridge.chatSetCurrent(footer.id);
  assert.equal((await bridge.chatCurrent())?.id, footer.id);
  const list = await bridge.chatList();
  assert.deepEqual(list.map((c) => c.id).sort(), [a.id, footer.id].sort());
  assert.ok(list.every((c) => typeof c.updatedAt === "number" && c.title === "New chat"));
  assert.equal((await bridge.chatGet(a.id))?.id, a.id);
  await bridge.chatDelete(a.id);
  assert.equal(await bridge.chatGet(a.id), undefined);
  assert.equal(await bridge.chatGet("never"), undefined);
});

test("an HTTP chat keeps its turns and hands the history back to the model", async () => {
  const { bridge } = await setup();
  const chat = (await bridge.chatNew())!;
  model.replies.push({ content: "Hi! How can I help?" }, { content: "You asked me to say hi." });

  const r1 = await bridge.chatSend({ chatId: chat.id, requestId: "m1", goal: "say hi", allowWrite: false, allowDestructive: false });
  assert.deepEqual(r1, { requestId: "m1", ok: true, text: "Hi! How can I help?" });
  const r2 = await bridge.chatSend({ chatId: chat.id, requestId: "m2", goal: "what did I ask?", allowWrite: false, allowDestructive: false });
  assert.equal(r2.text, "You asked me to say hi.");

  const second = model.chats[1].body.messages!.filter((m) => m.role !== "system");
  assert.deepEqual(
    second.map((m) => [m.role, m.content]),
    [
      ["user", "say hi"],
      ["assistant", "Hi! How can I help?"],
      ["user", "what did I ask?"],
    ],
    "the earlier turns come first, the new message last",
  );
  const view = (await bridge.chatGet(chat.id))!;
  assert.equal(view.title, "say hi", "the first message names the chat");
  assert.deepEqual(view.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);

  // Persisted: a fresh bridge (an app restart) sees the same transcript.
  const { bridge: restarted } = await makeBridge();
  assert.equal((await restarted.chatGet(chat.id))?.turns.length, 4);
});

test("an HTTP chat can run approved writes like the agent", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "changed\n");
  const chat = (await bridge.chatNew())!;
  model.replies.push({ toolCalls: [{ id: "s", name: "git_stage", args: { paths: ["a.txt"] } }] }, { content: "Done." });
  const run = bridge.chatSend({ chatId: chat.id, requestId: "cw", goal: "stage a", allowWrite: true, allowDestructive: false, modelId: "m-x", thinking: "off" });
  await until(() => confirms(sent).length === 1, "the approval request");
  bridge.confirmAnswer({ callId: String(confirms(sent)[0].callId), approved: true });
  assert.equal((await run).text, "Done.");
  assert.equal(staged(git), "a.txt");
  assert.equal(model.chats[0].body.model, "m-x");
  assert.equal(events(sent, "tool_call")[0].tool, "git_stage");
});

test("a failed HTTP chat turn is reported and the user's message is kept", async () => {
  const { bridge } = await setup();
  const chat = (await bridge.chatNew())!;
  model.replies.push(new Response("", { status: 401 }));
  const r = await bridge.chatSend({ chatId: chat.id, requestId: "f", goal: "hello", allowWrite: false, allowDestructive: false });
  assert.equal(r.ok, false);
  assert.equal((await bridge.chatGet(chat.id))!.turns[0].text, "hello");
});

test("sending to a chat that is gone, or with no model, or no repository, is refused", async () => {
  const { bridge, repos, root } = await setup();
  const msg = { requestId: "x", goal: "g", allowWrite: false, allowDestructive: false };
  assert.deepEqual(await bridge.chatSend({ ...msg, chatId: "gone" }), {
    requestId: "x",
    ok: false,
    expected: true,
    message: "This chat no longer exists.",
  });

  const chat = (await bridge.chatNew())!;
  repos.closeTab((await repos.current())?.root ?? root);
  assert.deepEqual(await bridge.chatSend({ ...msg, chatId: chat.id }), {
    requestId: "x",
    ok: false,
    expected: true,
    message: "Open a repository first.",
  });

  await bridge.removeConnection(chat.connectionId);
  assert.equal((await bridge.chatSend({ ...msg, chatId: chat.id })).message, "No AI model is connected. Add one in Settings ▸ AI.");
  assert.equal(model.chats.length, 0);
});

// ── chats over a warm local `claude` ─────────────────────────────────────────

/** A `claude` that streams `answer(n)` for its n-th message, as session `sid`. */
function claude(sid: string, answer: (content: string, n: number) => string) {
  return (c: FakeChild) => {
    let n = 0;
    c.json({ type: "system", subtype: "init", session_id: sid });
    c.onStdinLine((line) => {
      const content = (JSON.parse(line) as { message: { content: string } }).message.content;
      const text = answer(content, n++);
      for (const part of text.split(/(?<= )/)) {
        c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part } } });
      }
      c.json({ type: "result", session_id: sid });
    });
  };
}

test("a Claude Code chat boots once, then answers warm, and remembers its session", async () => {
  const { bridge, sent } = await setup("claude-code");
  onEverySpawn(claude("cc-sess-1", (m, n) => `answer ${n} to ${m.split("\n")[0]}`));
  const chat = (await bridge.chatNew())!;
  try {
    const r1 = await bridge.chatSend({ chatId: chat.id, requestId: "c1", goal: "first", allowWrite: false, allowDestructive: false });
    assert.deepEqual(r1, { requestId: "c1", ok: true, text: "answer 0 to first" });
    const status = events(sent, "status");
    assert.deepEqual(status.map((e) => e.text), ["Loading the agent"], "a cold start says it is loading");
    assert.deepEqual(
      sent.filter((s) => s.event === "ai:delta" && s.data.requestId === "c1").map((s) => s.data.delta).join(""),
      "answer 0 to first",
    );
    const c = spawned[0];
    assert.equal(c.args[c.args.indexOf("--model") + 1], "sonnet", "the configured tier's model");
    assert.ok(c.options?.cwd && /gs-ai-repo-/.test(c.options.cwd), "runs in the repository");

    const r2 = await bridge.chatSend({ chatId: chat.id, requestId: "c2", goal: "second", allowWrite: false, allowDestructive: false, thinking: "extended" });
    assert.equal(r2.text, "answer 1 to second");
    assert.equal(spawned.length, 1, "the same process answered — warm");
    assert.equal(events(sent, "status").length, 1, "no second Loading");
    assert.match(JSON.parse(c.stdinLines[1]).message.content, /^second\n\nThink hard/, "the thinking directive rides on the message");

    const disk = JSON.parse(readFileSync(join(userData, "ai-sessions.json"), "utf8"));
    const saved = disk.sessions.find((s: { id: string }) => s.id === chat.id);
    assert.equal(saved.cliSessionId, "cc-sess-1", "persisted, so a restart resumes it");
    assert.deepEqual(saved.turns.map((t: { text: string }) => t.text), ["first", "answer 0 to first", "second", "answer 1 to second"]);

    // Switching model mid-chat restarts the process, resuming the conversation.
    await bridge.chatSend({ chatId: chat.id, requestId: "c3", goal: "third", allowWrite: false, allowDestructive: false, modelId: "opus" });
    assert.equal(spawned.length, 2);
    const a2 = spawned[1].args;
    assert.equal(a2[a2.indexOf("--model") + 1], "opus");
    assert.equal(a2[a2.indexOf("--resume") + 1], "cc-sess-1");
    assert.equal(spawned[0].killed, true);
  } finally {
    bridge.dispose();
  }
  assert.ok(spawned.every((c) => c.killed), "quitting the app kills every warm process");
});

test("a Claude Code chat whose CLI is missing reports it", async () => {
  const { bridge } = await setup("claude-code");
  onNextSpawn((c) => c.fail("ENOENT"));
  const chat = (await bridge.chatNew())!;
  const r = await bridge.chatSend({ chatId: chat.id, requestId: "m", goal: "hi", allowWrite: false, allowDestructive: false });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /The `claude` CLI isn't installed or not on PATH\./);
  bridge.dispose();
});

test("cancelling a Claude Code chat turn stops the process and reports the cancel", async () => {
  const { bridge } = await setup("claude-code");
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "working" } } });
    });
  });
  const chat = (await bridge.chatNew())!;
  const run = bridge.chatSend({ chatId: chat.id, requestId: "cc", goal: "long", allowWrite: false, allowDestructive: false });
  await until(() => spawned.length === 1 && spawned[0].stdinLines.length === 1, "the message to reach claude");
  bridge.cancel("cc");
  const r = await run;
  assert.deepEqual(r, { requestId: "cc", ok: false, message: "Session cancelled." });
  assert.equal(spawned[0].killSignal, "SIGTERM");
  bridge.dispose();
});

// ── what the approval asks ────────────────────────────────────────────────────

test("each write tool's approval says what it will do in the user's terms", () => {
  const t = (name: string) => ({ name, title: `T:${name}`, mode: "write" }) as unknown as Parameters<typeof summarizeArgs>[0];
  assert.equal(summarizeArgs(t("git_commit"), { message: "feat: x\n\nlong body" }), "Commit staged changes:\n“feat: x”", "the subject line only");
  assert.equal(summarizeArgs(t("git_commit"), {}), "Commit staged changes:\n“”");
  assert.equal(summarizeArgs(t("git_unstage"), { all: true }), "Unstage everything.");
  assert.equal(summarizeArgs(t("git_unstage"), { paths: ["a", "b"] }), "Unstage: a, b");
  assert.equal(summarizeArgs(t("git_stage"), { paths: "single" }), "Stage: single", "a lone string is shown as-is");
  assert.equal(summarizeArgs(t("git_create_branch"), { name: "feat/x", checkout: true }), "Create branch “feat/x” and switch to it.");
  assert.equal(summarizeArgs(t("git_create_branch"), { name: "feat/x" }), "Create branch “feat/x”.");
  assert.equal(summarizeArgs(t("git_checkout"), { ref: "main" }), "Switch to “main”.");
  assert.equal(summarizeArgs(t("git_stash_save"), { message: "wip" }), "Stash working-tree changes (“wip”).");
  assert.equal(summarizeArgs(t("git_stash_save"), {}), "Stash working-tree changes.");
  assert.match(summarizeArgs(t("git_reset"), { ref: "HEAD~1" }), /\(mixed reset\)/, "no mode reads as git's default");
});
