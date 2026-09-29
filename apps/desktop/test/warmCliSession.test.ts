// A warm Claude Code session: one `claude` process kept alive per chat, fed
// messages over stdin and streaming answers back — so the second message in a
// chat does not pay the cold start again, and a restart resumes the same
// conversation by session id.
//
// `claude` is a scripted FakeChild (aiBridge.fakes.ts), never the real CLI.

import { FakeChild, configureNextChild, onNextSpawn, resetSpawns, spawned, until } from "./aiBridge.fakes";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { WarmCliSession } from "../src/main/warmCliSession";

beforeEach(() => resetSpawns());

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

/** A `claude` that answers every user message with `reply(content)` deltas. */
function answering(reply: (content: string, n: number) => string[], sessionId = "sess-1") {
  return (c: FakeChild) => {
    let n = 0;
    c.json({ type: "system", subtype: "init", session_id: sessionId });
    c.onStdinLine((line) => {
      const msg = JSON.parse(line) as { message: { content: string } };
      for (const d of reply(msg.message.content, n++)) c.json(delta(d));
      c.json({ type: "result", result: "ignored when deltas streamed", session_id: sessionId });
    });
  };
}

test("a message is written to stdin as stream-json and its answer streams back", async () => {
  onNextSpawn(answering((m) => ["You said: ", m]));
  const s = new WarmCliSession({ cwd: "/repo", model: "opus" });
  try {
    assert.equal(s.warm, false, "nothing is running before the first message");
    const seen: string[] = [];
    const out = await s.send("hello", { onDelta: (d) => seen.push(d) });
    assert.equal(out, "You said: hello");
    assert.deepEqual(seen, ["You said: ", "hello"]);

    const c = spawned[0];
    assert.equal(c.command, "claude");
    assert.equal(c.options?.cwd, "/repo");
    assert.deepEqual(c.args.slice(0, 4), ["-p", "--strict-mcp-config", "--model", "opus"]);
    assert.ok(!c.args.includes("--resume"), "a brand-new chat resumes nothing");
    for (const f of ["--input-format", "--output-format", "--include-partial-messages"]) assert.ok(c.args.includes(f), f);
    assert.deepEqual(JSON.parse(c.stdinLines[0]), { type: "user", message: { role: "user", content: "hello" } });
    assert.equal(s.id, "sess-1", "the session id is learned from the stream");
    assert.equal(s.warm, true, "and the process stays alive for the next message");
  } finally {
    s.dispose();
  }
});

test("the second message reuses the SAME process — that is what makes it warm", async () => {
  onNextSpawn(answering((m, n) => [`#${n} ${m}`]));
  const s = new WarmCliSession({ cwd: undefined });
  try {
    assert.equal(await s.send("one", { onDelta: () => {} }), "#0 one");
    assert.equal(await s.send("two", { onDelta: () => {} }), "#1 two");
    assert.equal(spawned.length, 1, "one process for both messages");
    assert.ok(!spawned[0].args.includes("--model"), "no model flag when the chat has none");
  } finally {
    s.dispose();
  }
});

test("a second message while the first is still answering is refused", async () => {
  onNextSpawn(() => {}); // never answers
  const s = new WarmCliSession({ cwd: undefined });
  const first = s.send("slow", { onDelta: () => {} });
  await assert.rejects(s.send("impatient", { onDelta: () => {} }), /still answering the previous message/);
  s.dispose();
  await assert.rejects(first, /Session cancelled\./, "disposing fails the turn in flight");
});

test("with no token deltas, the completed assistant message is streamed once and returned", async () => {
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.out("garbage line\n");
      c.json({ type: "assistant", message: { content: [{ type: "text", text: "\u001b[2mFull\u001b[0m" }, { type: "text", text: " answer" }] } });
      c.json({ type: "assistant", message: { content: [{ type: "tool_use" }] } });
      c.json({ type: "result", result: "x" });
    });
  });
  const s = new WarmCliSession({ cwd: undefined });
  try {
    const seen: string[] = [];
    const out = await s.send("q", { onDelta: (d) => seen.push(d) });
    assert.deepEqual(seen, ["Full answer"], "ANSI stripped from what is shown");
    assert.equal(out, "\u001b[2mFull\u001b[0m answer".trim());
  } finally {
    s.dispose();
  }
});

test("a delta that is not text is ignored", async () => {
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta" } } });
      c.json(delta("ok"));
      c.json({ type: "result" });
    });
  });
  const s = new WarmCliSession({ cwd: undefined });
  try {
    assert.equal(await s.send("q", { onDelta: () => {} }), "ok");
  } finally {
    s.dispose();
  }
});

test("cancelling a turn kills the process and fails the turn; the next message respawns and resumes", async () => {
  const ctrl = new AbortController();
  onNextSpawn((c) => {
    c.json({ type: "system", session_id: "sess-A" });
    c.onStdinLine(() => {
      c.json(delta("thinking…"));
      setImmediate(() => ctrl.abort());
    });
  });
  const exits: number[] = [];
  const s = new WarmCliSession({ cwd: undefined, onExit: () => exits.push(1) });
  try {
    await assert.rejects(s.send("long job", { onDelta: () => {}, signal: ctrl.signal }), /Session cancelled\./);
    assert.equal(spawned[0].killSignal, "SIGTERM");
    assert.equal(s.warm, false);
    await until(() => exits.length === 1, "the killed process to report its exit");

    onNextSpawn(answering(() => ["back"], "sess-A"));
    assert.equal(await s.send("again", { onDelta: () => {} }), "back");
    assert.equal(spawned.length, 2, "a fresh process");
    const args = spawned[1].args;
    assert.equal(args[args.indexOf("--resume") + 1], "sess-A", "resuming the conversation it had");
  } finally {
    s.dispose();
  }
});

// With a signal that is ALREADY aborted, send() used to run onAbort → dispose()
// — ending stdin and killing the process — and then still write the message to
// that ended stdin. A Writable reports a write after end as an 'error' EVENT,
// not a throw, so the try/catch never saw it and nothing listened for it: an
// uncaught exception in the main process. AiBridge.chatSend can reach this when
// ai:cancel lands while it is awaiting appendTurn, just before warm.send().
test("an already-aborted signal cancels the turn immediately", async () => {
  onNextSpawn(() => {});
  const ctrl = new AbortController();
  ctrl.abort();
  const s = new WarmCliSession({ cwd: undefined });
  await assert.rejects(s.send("q", { onDelta: () => {}, signal: ctrl.signal }), /Session cancelled\./);
  assert.equal(spawned[0].killed, true);
});

test("after a restart the first spawn resumes the persisted session id", async () => {
  onNextSpawn(answering(() => ["hi"], "persisted-9"));
  const s = new WarmCliSession({ cwd: undefined, resumeId: "persisted-9" });
  try {
    await s.send("q", { onDelta: () => {} });
    const args = spawned[0].args;
    assert.equal(args[args.indexOf("--resume") + 1], "persisted-9");
  } finally {
    s.dispose();
  }
});

test("a process that dies mid-turn after streaming resolves with what it said", async () => {
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.json(delta("half an answer "));
      void c.exit(1);
    });
  });
  const exited: boolean[] = [];
  const s = new WarmCliSession({ cwd: undefined, onExit: () => exited.push(true) });
  assert.equal(await s.send("q", { onDelta: () => {} }), "half an answer");
  assert.deepEqual(exited, [true], "the owner is told the process is gone");
  assert.equal(s.warm, false);
});

test("a process that dies mid-turn after a completed message resolves with that message", async () => {
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.json({ type: "assistant", message: { content: [{ type: "text", text: "final words" }] } });
      void c.exit(0);
    });
  });
  const s = new WarmCliSession({ cwd: undefined });
  assert.equal(await s.send("q", { onDelta: () => {} }), "final words");
});

test("a process that dies mid-turn having said nothing fails the turn", async () => {
  onNextSpawn((c) => {
    c.onStdinLine(() => {
      c.err("fatal: something broke\n"); // logged by the CLI, not shown as an answer
      void c.exit(1);
    });
  });
  const s = new WarmCliSession({ cwd: undefined });
  await assert.rejects(s.send("q", { onDelta: () => {} }), /ended unexpectedly/);
});

test("a missing `claude` says it isn't installed", async () => {
  onNextSpawn((c) => c.fail("ENOENT"));
  const s = new WarmCliSession({ cwd: undefined });
  try {
    await assert.rejects(s.send("q", { onDelta: () => {} }), /The `claude` CLI isn't installed or not on PATH\./);
  } finally {
    s.dispose();
  }
});

test("any other start failure surfaces as itself", async () => {
  onNextSpawn((c) => c.fail("EACCES", "permission denied"));
  const s = new WarmCliSession({ cwd: undefined });
  try {
    await assert.rejects(s.send("q", { onDelta: () => {} }), /permission denied/);
  } finally {
    s.dispose();
  }
});

test("a stdin that cannot be written fails the turn instead of hanging", async () => {
  onNextSpawn(() => {});
  configureNextChild((c) => {
    c.stdin.write = () => {
      throw new Error("write EPIPE");
    };
  });
  const s = new WarmCliSession({ cwd: undefined });
  try {
    await assert.rejects(s.send("q", { onDelta: () => {} }), /write EPIPE/);
    // Not left "busy": the next message is attempted (and fails the same way),
    // rather than refused as if the first were still answering.
    await assert.rejects(s.send("again", { onDelta: () => {} }), /write EPIPE/);
    assert.equal(spawned.length, 1);
  } finally {
    s.dispose();
  }
});

test("an idle session disposes its process after five minutes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    onNextSpawn(answering(() => ["done"]));
    const s = new WarmCliSession({ cwd: undefined });
    assert.equal(await s.send("q", { onDelta: () => {} }), "done");
    assert.equal(s.warm, true);
    mock.timers.tick(5 * 60 * 1000 - 1);
    assert.equal(s.warm, true, "still warm just before the idle limit");
    mock.timers.tick(1);
    assert.equal(s.warm, false, "disposed at the limit");
    assert.equal(spawned[0].killSignal, "SIGTERM");
  } finally {
    mock.timers.reset();
  }
});

test("disposing an idle session is safe and repeatable", () => {
  const s = new WarmCliSession({ cwd: undefined });
  s.dispose();
  s.dispose();
  assert.equal(s.warm, false);
  assert.equal(s.id, undefined);
});
