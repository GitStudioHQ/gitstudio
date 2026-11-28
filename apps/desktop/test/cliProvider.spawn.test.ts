// The local-CLI provider: how GitStudio talks to an installed `claude`, `codex`
// or `gemini` in print mode, using the CLI's own login instead of an API key.
//
// Every CLI here is a scripted FakeChild (aiBridge.fakes.ts) — never a real
// binary. What is pinned is what the user sees: the text that streams into the
// panel, the error that explains why nothing did, and that Cancel stops the
// process rather than leaving it running.

import { FAKE_BIN, FAKE_ROOT, fakeMachine, onNextSpawn, resetSpawns, spawned, throwOnNextSpawn, until, useMachine } from "./aiBridge.fakes";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliProvider, CliUnavailableError, CLI_SPECS, cliSpecFor, detectCli, recentTurns, withThinking } from "../src/main/cliProvider";
import { isExpectedError } from "../src/main/expectedError";

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
  assert.equal(c.stdinText, "hi", "the prompt arrives on stdin");
  assert.ok(!c.args.includes("hi"), "and never as an argument");
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
  assert.deepEqual(spawned[0].args, ["exec", "--model", "gpt-5", "-"], "`-`: codex reads the instructions from stdin");
  assert.equal(spawned[0].stdinText, "q");
});

test("an empty answer streams as null, not as an empty string", async () => {
  onNextSpawn((c) => {
    c.out("   \n");
    void c.exit(0);
  });
  assert.equal(await provider("gemini-cli").streamText([{ role: "user", content: "q" }], () => {}), null);
  assert.deepEqual(spawned[0].args, [], "no prompt argument: gemini runs a piped stdin once");
  assert.equal(spawned[0].stdinText, "q");
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
  assert.deepEqual(spawned[0].args, ["--model", "exact-model"]);
  assert.match(spawned[0].stdinText, /^q\n\nThink hard/);
});

test("the conversation is flattened: system first, then every turn labelled with whose it is", async () => {
  onNextSpawn((c) => void c.exit(0));
  await provider("codex").chat([
    { role: "system", content: "Be brief." },
    { role: "user", content: "What changed?" },
    { role: "assistant", content: "Two files." },
    { role: "tool", content: "ignored", toolCallId: "t", name: "n" },
    { role: "user", content: "Which?" },
  ] as never);
  assert.equal(spawned[0].stdinText, "Be brief.\n\nUser: What changed?\n\nAssistant: Two files.\n\nUser: Which?");
});

test("without a system message the prompt is just the conversation", async () => {
  onNextSpawn((c) => void c.exit(0));
  await provider("codex").chat([{ role: "user", content: "Only this" }]);
  assert.equal(spawned[0].stdinText, "Only this", "a lone request is not labelled");
});

// ── failures to start, and cancelling ─────────────────────────────────────────

test("an unknown preset is refused before anything is spawned", async () => {
  await assert.rejects(provider("nope").chat([{ role: "user", content: "q" }]), /Unknown local CLI: nope\./);
  assert.equal(spawned.length, 0);
});

test("a CLI that is not installed says so, with how to install it — before anything is spawned", async () => {
  useMachine(fakeMachine({ isFile: () => false }));
  await assert.rejects(provider("codex").chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.match(e.message, /The `codex` CLI isn't installed or not on PATH/);
    assert.ok(e.message.includes(CLI_SPECS.codex.install));
    assert.ok(e instanceof CliUnavailableError && isExpectedError(e), "the user's setup, not a crash");
    return true;
  });
  assert.equal(spawned.length, 0);
});

test("a CLI that vanishes between being found and starting still says it isn't installed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gs-cli-cwd-"));
  try {
    onNextSpawn((c) => c.fail("ENOENT"));
    await assert.rejects(provider("codex", undefined, cwd).chat([{ role: "user", content: "q" }]), (e: Error) => {
      assert.match(e.message, /The `codex` CLI isn't installed or not on PATH/);
      assert.ok(isExpectedError(e));
      return true;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a CLI started in a repository folder that is gone says the folder is gone", async () => {
  // Node says "spawn <cli> ENOENT" for a missing working directory too.
  const gone = join(tmpdir(), "gs-cli-gone-" + process.pid + "-" + Date.now());
  onNextSpawn((c) => c.fail("ENOENT"));
  await assert.rejects(provider("claude-code", undefined, gone).chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.match(e.message, /is not there any more/);
    assert.ok(e.message.includes(gone));
    assert.ok(isExpectedError(e));
    return true;
  });
});

test("Node's 'spawn <path> EACCES' is passed on as its code, not as a sentence about Git", async () => {
  // main.ts's IPC wrapper reads "spawn … EACCES" in a result as Git failing to
  // start (repoNotice.ts) and would put THAT in front of the user.
  onNextSpawn((c) => c.fail("EACCES"));
  await assert.rejects(provider("gemini-cli").chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.equal(e.message, "`gemini` failed to start: EACCES");
    assert.ok(!isExpectedError(e), "a CLI we found and could not start is worth hearing about");
    return true;
  });
});

// ── found the way a terminal would find it ───────────────────────────────────

test("a CLI only the login shell's PATH has is found there, and runs with that PATH", async () => {
  const dir = `${FAKE_ROOT}/nvm/versions/node/v22/bin`;
  let asked = 0;
  useMachine(
    fakeMachine({
      env: { PATH: "/usr/bin:/bin" },
      isFile: (p) => p === `${dir}/claude`,
      freshPath: async () => {
        asked++;
        return [dir, "/usr/bin"];
      },
    }),
  );
  onNextSpawn((c) => {
    c.json({ type: "result", result: "ok" });
    void c.exit(0);
  });
  assert.equal((await provider("claude-code").chat([{ role: "user", content: "q" }])).text, "ok");
  assert.equal(spawned[0].file, `${dir}/claude`);
  const env = spawned[0].options?.env as NodeJS.ProcessEnv;
  assert.ok(env.PATH?.startsWith(`${dir}:`), `its own folder leads PATH, so \`env node\` finds its Node: ${env.PATH}`);
  assert.equal(asked, 1);
});

test("the login shell is not asked when the usual folders have the CLI", async () => {
  let asked = 0;
  useMachine(fakeMachine({ freshPath: async () => (asked++, []) }));
  onNextSpawn((c) => void c.exit(0));
  await provider("codex").chat([{ role: "user", content: "q" }]);
  assert.equal(asked, 0);
  assert.equal(spawned[0].file, `${FAKE_BIN}/codex`);
});

const WIN_NPM = "C:\\gs-fake-machine\\npm";
const WIN_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;

/** A Windows machine where the CLI was installed with `npm install -g`. */
function windowsNpmMachine(files: string[]) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return fakeMachine({
    platform: "win32",
    env: { Path: `C:\\Windows\\system32;${WIN_NPM}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    home: "C:\\gs-fake-machine\\home",
    isFile: (p) => set.has(p.toLowerCase()),
    readText: (p) => (p.toLowerCase() === `${WIN_NPM}\\claude.cmd`.toLowerCase() ? WIN_SHIM : undefined),
  });
}

test("Windows: an npm-installed Claude Code runs as node + its script, never through a shell", async () => {
  // Crash report "Ai chatSend" (Windows): a bare spawn("claude") cannot find
  // npm's claude.cmd, and Node refuses to run a .cmd without a shell.
  const script = `${WIN_NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  useMachine(windowsNpmMachine([`${WIN_NPM}\\claude.cmd`, script, `${WIN_NPM}\\node.exe`]));
  onNextSpawn((c) => {
    c.json({ type: "result", result: "hi" });
    void c.exit(0);
  });
  const prompt = "line one\nline two";
  assert.equal((await provider("claude-code").chat([{ role: "user", content: prompt }])).text, "hi");
  const c = spawned[0];
  assert.equal(c.file, `${WIN_NPM}\\node.exe`);
  assert.equal(c.args[0], script, "the script the launcher would have run");
  assert.equal(c.stdinText, prompt, "the prompt arrives whole on stdin, newlines and all");
  assert.notEqual(c.options?.windowsVerbatimArguments, true, "no cmd.exe line was built");
});

test("Windows: an npm launcher with no Node.js anywhere says what is missing, as the user's setup", async () => {
  useMachine(windowsNpmMachine([`${WIN_NPM}\\claude.cmd`, `${WIN_NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]));
  await assert.rejects(provider("claude-code").chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.match(e.message, /runs on Node\.js/);
    assert.ok(isExpectedError(e));
    return true;
  });
  assert.equal(spawned.length, 0);
});

test("Windows: Claude Code's native claude.exe in ~\\.local\\bin is found though PATH predates it", async () => {
  const exe = "C:\\gs-fake-machine\\home\\.local\\bin\\claude.exe";
  useMachine(windowsNpmMachine([exe]));
  onNextSpawn((c) => void c.exit(0));
  await provider("claude-code").chat([{ role: "user", content: "q" }]);
  assert.equal(spawned[0].file, exe);
});

test("any other start failure carries the system's reason", async () => {
  onNextSpawn((c) => c.fail("EACCES", "permission denied"));
  await assert.rejects(provider("claude-code").chat([{ role: "user", content: "q" }]), /`claude` failed to start: permission denied/);
});

test("a spawn that throws is said as what the OS refused — not as 'install it' — and reports", async () => {
  // E2BIG for an over-long command line used to land here and read "Couldn't
  // launch `codex`. Install the Codex CLI…", filed as a crash.
  throwOnNextSpawn(Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }));
  await assert.rejects(provider("codex").chat([{ role: "user", content: "q" }]), (e: Error) => {
    assert.equal(e.message, "`codex` failed to start: E2BIG");
    assert.ok(!e.message.includes(CLI_SPECS.codex.install));
    assert.ok(!isExpectedError(e));
    return true;
  });
});

test("a prompt far past every command-line limit reaches the CLI whole, on stdin", async () => {
  // Windows caps a command line at 32,767 characters and Linux one argument
  // at 128 KiB; an explained diff or a chat's history passes both.
  const big = "x".repeat(300_000);
  onNextSpawn((c) => {
    c.out("done");
    void c.exit(0);
  });
  assert.equal((await provider("codex").chat([{ role: "user", content: big }])).text, "done");
  assert.equal(spawned[0].stdinText.length, big.length);
  assert.ok(spawned[0].args.every((a) => a.length < 100), "nothing long in argv");
});

test("every CLI launch hides its console window on Windows", async () => {
  onNextSpawn((c) => void c.exit(0));
  await provider("gemini-cli").chat([{ role: "user", content: "q" }]);
  assert.equal((spawned[0].options as { windowsHide?: boolean }).windowsHide, true);
});

test("Windows: Cancel ends the CLI's whole process tree, not just the launcher's Node", async () => {
  // An npm launcher runs node.exe, which runs the native CLI holding the
  // pipes; killing node.exe alone left the run going and `close` never came.
  const exe = "C:\\gs-fake-machine\\home\\.local\\bin\\codex.exe";
  const trees: number[] = [];
  useMachine({
    ...windowsNpmMachine([exe]),
    stopTree: (pid) => {
      trees.push(pid);
      void spawned.find((c) => c.pid === pid)?.exit(1);
    },
  });
  const ctrl = new AbortController();
  onNextSpawn((c) => {
    c.out("partial");
    setImmediate(() => ctrl.abort());
  });
  const out = await provider("codex").streamText([{ role: "user", content: "q" }], () => {}, { signal: ctrl.signal });
  assert.equal(out, "partial");
  assert.deepEqual(trees, [spawned[0].pid], "taskkill /T was asked for the tree");
  assert.equal(spawned[0].killed, false, "rather than a plain kill of the direct child");
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

test("a request that is already cancelled starts nothing and does not fail", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await provider("codex").chat([{ role: "user", content: "q" }], { signal: ctrl.signal });
  assert.equal(spawned.length, 0, "no process is started just to be killed");
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

test("detectCli reports a CLI that is nowhere as not ok, with why, without starting anything", async () => {
  useMachine(fakeMachine({ isFile: () => false }));
  const r = await detectCli("claude", CLI_SPECS["claude-code"].install);
  assert.equal(r.ok, false);
  assert.ok(r.reason instanceof CliUnavailableError);
  assert.match(r.reason.message, /isn't installed[\s\S]*Install Claude Code/);
  assert.equal(spawned.length, 0);
});

test("detectCli asks the CLI it would really run — the one the login shell's PATH has", async () => {
  const dir = `${FAKE_ROOT}/opt/bin`;
  useMachine(fakeMachine({ isFile: (p) => p === `${dir}/gemini`, freshPath: async () => [dir] }));
  onNextSpawn((c) => {
    c.out("0.9.0\n");
    void c.exit(0);
  });
  assert.deepEqual(await detectCli("gemini"), { ok: true, version: "0.9.0" });
  assert.equal(spawned[0].file, `${dir}/gemini`);
});

test("detectCli reports a spawn that throws as not ok", async () => {
  throwOnNextSpawn(new Error("EINVAL"));
  assert.deepEqual(await detectCli("claude"), { ok: false });
});

// ── a chat's history, for a CLI with no session of its own ───────────────────

test("a CLI chat carries the most recent turns that fit, and says the rest were left out", () => {
  const turn = (role: "user" | "assistant", n: number) => ({ role, content: `${role}-${n}:`.padEnd(10_000, "x") });
  const history = [turn("user", 1), turn("assistant", 1), turn("user", 2), turn("assistant", 2), turn("user", 3), turn("assistant", 3)];
  const kept = recentTurns(history, 24_000);
  assert.equal(kept[0].role, "system", "the model is told earlier turns are missing");
  assert.deepEqual(kept.slice(1).map((t) => t.content.slice(0, 12)), ["user-3:xxxxx", "assistant-3:"]);
  assert.ok(kept.slice(1).reduce((n, t) => n + t.content.length, 0) <= 24_000);
  assert.deepEqual(recentTurns(history.slice(0, 2), 24_000), history.slice(0, 2), "a short chat goes whole");
  const huge = recentTurns([{ role: "assistant", content: "y".repeat(50_000) + "END" }], 1_000);
  assert.equal(huge[1].content.length, 1_000);
  assert.ok(huge[1].content.endsWith("END"), "a newest turn too long by itself keeps its end");
  // Cut on a character: an emoji is two UTF-16 units, and a tail starting on
  // the second one arrives as U+FFFD.
  const emoji = recentTurns([{ role: "user", content: "\u{1F600}".repeat(1_000) }], 1_000);
  assert.doesNotMatch(emoji[1].content.slice(1), /^[\uDC00-\uDFFF]/, "no half an emoji at the cut");
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
