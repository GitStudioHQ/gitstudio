import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandTracking } from "../src/renderer/terminalCommands";

// A minimal fake of the xterm.js Terminal surface CommandTracking depends on:
// it captures the OSC handlers so a test can drive the 133/633 sequences a real
// shell would emit, and exposes a tiny scrollback buffer for output extraction.
function fakeTerm() {
  const osc = new Map<number, (d: string) => boolean>();
  let cursor = 0;
  const lines: string[] = [];
  const term = {
    parser: {
      registerOscHandler(id: number, cb: (d: string) => boolean) {
        osc.set(id, cb);
        return { dispose() {} };
      },
    },
    registerMarker(off = 0) {
      return { line: cursor + off, isDisposed: false, dispose() {} };
    },
    registerDecoration() {
      const element = { className: "", title: "" };
      return { element, onRender(cb: () => void) { cb(); }, dispose() {} };
    },
    scrollToLine() {},
    buffer: {
      active: {
        get length() {
          return lines.length;
        },
        getLine(i: number) {
          return { translateToString: () => lines[i] ?? "" };
        },
      },
    },
  };
  return {
    term,
    osc: (id: number, d: string) => osc.get(id)?.(d),
    at: (n: number) => {
      cursor = n;
    },
    push: (s: string) => {
      lines.push(s);
    },
  };
}

/** Drive one full command cycle the way the shell hooks do. */
function runCommand(
  f: ReturnType<typeof fakeTerm>,
  cmd: string,
  cwd: string,
  exit: number,
  output: string[],
) {
  f.osc(133, "A"); // prompt start (precmd) — anchors the dot at the prompt line
  f.osc(633, `P;Cwd=${cwd}`);
  f.osc(633, `E;${cmd}`);
  f.at(f.term.buffer.active.length); // output begins below the prompt
  f.osc(133, "C");
  for (const line of output) f.push(line);
  f.osc(133, `D;${exit}`); // command done (next precmd)
}

test("tracks a command's text, cwd, exit code, and completion", () => {
  const f = fakeTerm();
  const t = new CommandTracking(f.term as never, { write: () => {} });
  t.attach();

  f.push("$ npm test"); // the prompt line (buffer index 0)
  runCommand(f, "npm test", "/repo", 0, ["ok 1", "ok 2"]);

  const cmds = t.commands();
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].commandLine, "npm test");
  assert.equal(cmds[0].cwd, "/repo");
  assert.equal(cmds[0].exitCode, 0);
  assert.equal(cmds[0].state, "done");
  assert.equal(cmds[0].decoration?.element?.className, "term-cmd-dot is-ok");
});

test("a non-zero exit marks the dot as an error", () => {
  const f = fakeTerm();
  const t = new CommandTracking(f.term as never, { write: () => {} });
  t.attach();
  f.push("$ false");
  runCommand(f, "false", "/repo", 1, []);
  assert.equal(t.commands()[0].exitCode, 1);
  assert.match(t.commands()[0].decoration?.element?.className ?? "", /is-error/);
});

test("the initial precmd D before any command is a safe no-op", () => {
  const f = fakeTerm();
  const t = new CommandTracking(f.term as never, { write: () => {} });
  t.attach();
  f.osc(133, "D;0"); // shell startup emits D before the first prompt
  assert.equal(t.commands().length, 0);
  f.osc(133, "A"); // first real prompt
  assert.equal(t.commands().length, 0); // still nothing until a command runs
});

test("navigation selects across commands and re-run writes to the PTY", () => {
  const writes: string[] = [];
  const f = fakeTerm();
  const t = new CommandTracking(f.term as never, { write: (d) => writes.push(d) });
  t.attach();
  f.push("$ a");
  runCommand(f, "cmd-a", "/repo", 0, ["a out"]);
  f.push("$ b");
  runCommand(f, "cmd-b", "/repo", 0, ["b out"]);

  t.selectPrev(); // from nothing selected, step back → last command
  assert.equal(t.selected()?.commandLine, "cmd-b");
  t.selectPrev();
  assert.equal(t.selected()?.commandLine, "cmd-a");

  t.rerun();
  assert.equal(writes.at(-1), "cmd-a\r");
});

test("copyOutput extracts the buffer region a command produced", async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (s: string) => void calls.push(s) } },
    configurable: true,
  });

  const f = fakeTerm();
  const t = new CommandTracking(f.term as never, { write: () => {} });
  t.attach();
  f.push("$ ls"); // index 0: prompt
  runCommand(f, "ls", "/repo", 0, ["file-a", "file-b"]); // indices 1,2: output

  await t.copyOutput(t.commands()[0]);
  assert.equal(calls.at(-1), "file-a\nfile-b");
});
