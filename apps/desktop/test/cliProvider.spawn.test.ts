// The local-CLI provider: how GitStudio talks to an installed `claude`, `codex`
// or `gemini` in print mode, using the CLI's own login instead of an API key.
//
// Every CLI here is a scripted FakeChild (aiBridge.fakes.ts) — never a real
// binary. What is pinned is what the user sees: the text that streams into the
// panel, the error that explains why nothing did, and that Cancel stops the
// process rather than leaving it running.

import { onNextSpawn, resetSpawns, spawned, throwOnNextSpawn, until } from "./aiBridge.fakes";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { CliProvider, CLI_SPECS, cliSpecFor, detectCli, withThinking } from "../src/main/cliProvider";

beforeEach(() => resetSpawns());

function provider(preset: string, resolve: (tier?: string) => string | undefined = () => undefined, cwd = "/repo") {
  return new CliProvider({ preset, cwd, resolveModel: resolve as never, label: `L ${preset}` });
}

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

// ── Claude Code: streamed JSON events ─────────────────────────────────────────

test("Claude Code streams token deltas live and the answer is their concatenation", async () => {
  onNextSpawn((c) => {
    c.json({ type: "system", subtype: "init", session_id: "s1" });
    c.json(delta("Hello"));
    // A line split across two chunks is reassembled before it is parsed.
    const line = JSON.stringify(delta(", world")) + "\n";
    c.out(line.slice(0, 10));
    c.out(line.slice(10));
    c.json({ type: "result", result: "Hello, world (final)" });
    void c.exit(0);
  });
  const seen: string[] = [];
  const out = await provider("claude-code", () => "sonnet").streamText(
    [{ role: "user", content: "hi" }],
    (d) => seen.push(d),
  );
  assert.deepEqual(seen, ["Hello", ", world"], "deltas arrive as they stream");
  assert.equal(out, "Hello, world", "token deltas win over the final result");

  const c = spawned[0];
  assert.equal(c.command, "claude");
  assert.equal(c.options?.cwd, "/repo", "runs inside the open repository");
  assert.deepEqual(c.args.slice(0, 4), ["-p", "--strict-mcp-config", "--model", "sonnet"]);
  assert.ok(c.args.includes("stream-json") && c.args.includes("--include-partial-messages"));
  assert.equal(c.args.at(-1), "hi", "the prompt is the last argument");
});

test("with no token deltas, Claude Code's final result is the answer", async () => {
  onNextSpawn((c) => {
    c.out("not json at all\n\n");
    c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta" } } });
    c.json({ type: "result", result: "\u001b[1mDone.\u001b[0m" });
    void c.exit(0);
  });
  const r = await provider("claude-code").chat([{ role: "user", content: "x" }]);
  assert.equal(r.text, "Done.", "ANSI escapes are stripped from the fallback");
  assert.equal(r.stopReason, "stop");
  assert.deepEqual(r.toolCalls, [], "a CLI exposes no tool calls");
  assert.ok(!spawned[0].args.includes("--model"), "no model flag when none resolves");
});

test("a completed assistant message is the fallback answer when no result line comes", async () => {
  onNextSpawn((c) => {
    c.json({
      type: "assistant",
      message: { content: [{ type: "text", text: "Part A. " }, { type: "tool_use" }, { type: "text", text: "Part B." }] },
    });
    c.json({ type: "assistant", message: { content: [{ type: "tool_use" }] } });
    void c.exit(1);
  });
  const r = await provider("claude-code").chat([{ role: "user", content: "x" }]);
  assert.equal(r.text, "Part A. Part B.", "a non-zero exit after a real answer still answers");
});

test("a failed Claude Code run names the command, the exit code and the last stderr lines", async () => {
  onNextSpawn((c) => {
    c.err("warming up\nline 2\nline 3\nError: not logged in\n");
    void c.exit(2);
  });
  await assert.rejects(provider("claude-code").chat([{ role: "user", content: "x" }]), (e: Error) => {
    assert.match(e.message, /`claude` exited with code 2: line 2 line 3 Error: not logged in/);
    assert.ok(!/warming up/.test(e.message), "only the last three stderr lines");
    return true;
  });
});

test("a failed run with a silent stderr ends its message with a full stop", async () => {
  onNextSpawn((c) => void c.exit(3));
  await assert.rejects(provider("claude-code").chat([{ role: "user", content: "x" }]), /`claude` exited with code 3\.$/);
});

// ── plain stdout CLIs ─────────────────────────────────────────────────────────

test("Codex's stdout is the answer, stripped of colour codes", async () => {
  onNextSpawn((c) => {
    c.out("\u001b[32mfeat:\u001b[0m add ");
    c.out("the thing\n");
    void c.exit(0);
  });
  const seen: string[] = [];
  const out = await provider("codex", () => "gpt-5").streamText([{ role: "user", content: "q" }], (d) => seen.push(d));
  assert.equal(out, "feat: add the thing");
  assert.deepEqual(seen, ["feat: add ", "the thing\n"]);
  assert.deepEqual(spawned[0].args, ["exec", "--model", "gpt-5", "q"]);
});

test("an empty answer streams as null, not as an empty string", async () => {
  onNextSpawn((c) => {
    c.out("   \n");
    void c.exit(0);
  });
  assert.equal(await provider("gemini-cli").streamText([{ role: "user", content: "q" }], () => {}), null);
  assert.deepEqual(spawned[0].args, ["-p", "q"]);
});

test("a plain CLI that exits non-zero rejects with its stderr", async () => {
  onNextSpawn((c) => {
    c.out("partial");
    c.err("quota exceeded\n");
    void c.exit(1);
  });
  await assert.rejects(provider("gemini-cli").chat([{ role: "user", content: "q" }]), /`gemini` exited with code 1: quota exceeded/);
});

test("an explicit model id beats the tier, and the thinking directive rides on the prompt", async () => {
  const tiers: (string | undefined)[] = [];
  onNextSpawn((c) => void c.exit(0));
  await provider("gemini-cli", (t) => {
    tiers.push(t);
    return "tier-model";
  }).chat([{ role: "user", content: "q" }], { modelId: "exact-model", thinking: "extended" });
  assert.deepEqual(tiers, [], "the tier resolver is not consulted when an id is given");
  assert.deepEqual(spawned[0].args.slice(0, 3), ["-p", "--model", "exact-model"]);
  assert.match(spawned[0].args[3], /^q\n\nThink hard/);
});

test("the conversation is flattened: system first, assistant turns labelled", async () => {
  onNextSpawn((c) => void c.exit(0));
  await provider("codex").chat([
    { role: "system", content: "Be brief." },
    { role: "user", content: "What changed?" },
    { role: "assistant", content: "Two files." },
    { role: "tool", content: "ignored", toolCallId: "t", name: "n" },
    { role: "user", content: "Which?" },
  ] as never);
  assert.equal(spawned[0].args.at(-1), "Be brief.\n\nWhat changed?\n\nAssistant: Two files.\n\nWhich?");
});

test("without a system message the prompt is just the conversation", async () => {
  onNextSpawn((c) => void c.exit(0));
  await provider("codex").chat([{ role: "user", content: "Only this" }]);
  assert.equal(spawned[0].args.at(-1), "Only this");
});

// ── failures to start, and cancelling ─────────────────────────────────────────

test("an unknown preset is refused before anything is spawned", async () => {
  await assert.rejects(provider("nope").chat([{ role: "user", content: "q" }]), /Unknown local CLI: nope\./);
  assert.equal(spawned.length, 0);
});

test("a CLI that is not installed says so, with how to install it", async () => {
  onNextSpawn((c) => c.fail("ENOENT"));
  await assert.rejects(provider("codex").chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.match(e.message, /The `codex` CLI isn't installed or not on PATH/);
    assert.ok(e.message.includes(CLI_SPECS.codex.install));
    return true;
  });
});

test("any other start failure carries the system's reason", async () => {
  onNextSpawn((c) => c.fail("EACCES", "permission denied"));
  await assert.rejects(provider("claude-code").chat([{ role: "user", content: "q" }]), /`claude` failed to start: permission denied/);
});

test("a spawn that throws is reported as a launch failure", async () => {
  throwOnNextSpawn(new Error("bad cwd"));
  await assert.rejects(provider("codex").chat([{ role: "user", content: "q" }]), /Couldn't launch `codex`\./);
});

test("cancelling mid-answer kills the CLI and resolves with what streamed so far", async () => {
  const ctrl = new AbortController();
  onNextSpawn((c) => {
    c.json(delta("partial"));
    setImmediate(() => ctrl.abort());
  });
  const seen: string[] = [];
  const out = await provider("claude-code").streamText([{ role: "user", content: "q" }], (d) => seen.push(d), {
    signal: ctrl.signal,
  });
  assert.equal(spawned[0].killSignal, "SIGTERM", "the process is terminated, not left running");
  assert.deepEqual(seen, ["partial"]);
  assert.equal(out, "partial");
});

test("a request that is already cancelled kills the CLI at once and does not fail", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await provider("codex").chat([{ role: "user", content: "q" }], { signal: ctrl.signal });
  assert.equal(spawned[0].killed, true);
  assert.equal(r.text, "", "a cancelled plain CLI resolves empty rather than as an error");
});

test("a cancelled streaming run that produced nothing resolves empty rather than failing", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const out = await provider("claude-code").streamText([{ role: "user", content: "q" }], () => {}, { signal: ctrl.signal });
  assert.equal(out, null);
});

// ── helpers ───────────────────────────────────────────────────────────────────

test("withThinking asks for depth, for brevity, or leaves the prompt alone", () => {
  assert.equal(withThinking("P", "extended"), "P\n\nThink hard and reason carefully before you answer.");
  assert.equal(withThinking("P", "off"), "P\n\nAnswer directly and concisely, without extended reasoning.");
  assert.equal(withThinking("P", "auto"), "P");
  assert.equal(withThinking("P"), "P");
});

test("cliSpecFor knows the three CLIs and nothing else", () => {
  assert.equal(cliSpecFor("claude-code")?.command, "claude");
  assert.equal(cliSpecFor("codex")?.command, "codex");
  assert.equal(cliSpecFor("gemini-cli")?.command, "gemini");
  assert.equal(cliSpecFor("openai"), undefined);
});

test("the provider reports its label and that it cannot call tools", () => {
  const p = provider("codex");
  assert.equal(p.label, "L codex");
  assert.equal(p.supportsTools, false);
  assert.equal(p.id, "cli");
});

// ── detectCli ────────────────────────────────────────────────────────────────

test("detectCli reports an installed CLI and the first line of its version", async () => {
  onNextSpawn((c) => {
    c.out("1.2.3 (Claude Code)\nextra\n");
    void c.exit(0);
  });
  assert.deepEqual(await detectCli("claude"), { ok: true, version: "1.2.3 (Claude Code)" });
  assert.deepEqual(spawned[0].args, ["--version"]);
});

test("detectCli reports a CLI whose --version fails as not ok", async () => {
  onNextSpawn((c) => void c.exit(127));
  assert.deepEqual(await detectCli("codex"), { ok: false, version: undefined });
});

test("detectCli reports a missing CLI as not ok", async () => {
  onNextSpawn((c) => c.fail("ENOENT"));
  assert.deepEqual(await detectCli("gemini"), { ok: false });
});

test("detectCli reports a spawn that throws as not ok", async () => {
  throwOnNextSpawn(new Error("EINVAL"));
  assert.deepEqual(await detectCli("claude"), { ok: false });
});

test("detectCli gives up on a CLI that hangs, after four seconds, and kills it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    onNextSpawn(() => {}); // never answers --version
    const result = detectCli("claude");
    await until(() => spawned.length === 1, "the probe to start");
    mock.timers.tick(3999);
    assert.equal(spawned[0].killed, false, "not yet");
    mock.timers.tick(1);
    assert.deepEqual(await result, { ok: false });
    assert.equal(spawned[0].killSignal, "SIGKILL");
  } finally {
    mock.timers.reset();
  }
});
