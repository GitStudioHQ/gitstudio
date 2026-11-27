// "Open in <editor>" when the editor is not where it was, or was typed the way
// a terminal would understand it — crash reports "Editors open":
// "Couldn't launch it: spawn <path> ENOENT" (an absolute path that was not
// there) and "spawn <NAME> ENOENT" (a bare command name).
//
// openEditor takes the OS as a parameter: every program here is a fake, the
// filesystem is a set, and nothing is started.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPEN,
  openEditor,
  planCustom,
  type CustomMachine,
  type DetectedEditor,
  type EditorLaunchDeps,
  type EditorPrefs,
} from "../src/main/editors";
import { reportableResultMessage } from "../src/main/expectedError";

const ROOT = "/Users/dev/src/widgets";

// ── planCustom: what a custom command resolves to ─────────────────────────────

function mac(files: string[], dirs: string[] = [], over: Partial<CustomMachine> = {}): CustomMachine {
  const f = new Set(files);
  const d = new Set(dirs);
  return {
    platform: "darwin",
    home: "/Users/dev",
    env: {},
    exists: (p) => f.has(p) || d.has(p),
    isDir: (p) => d.has(p),
    // A bare name is found in /opt/homebrew/bin; a path where it says.
    find: (name) => {
      const p = name.startsWith("/") ? name : `/opt/homebrew/bin/${name}`;
      return f.has(p) ? p : undefined;
    },
    ...over,
  };
}

test("a bare command name is FOUND, not handed to spawn as typed", () => {
  // `hx {path}` is the form's own example; a Dock-launched app's PATH has no
  // Homebrew, so spawn("hx") was ENOENT on most Macs that have Helix.
  assert.deepEqual(planCustom("hx {path}", ROOT, mac(["/opt/homebrew/bin/hx"])), {
    kind: "run",
    program: "/opt/homebrew/bin/hx",
    cmd: "/opt/homebrew/bin/hx",
    args: [ROOT],
  });
});

test("a name typed in capitals is tried lower-cased too, for a case-sensitive volume", () => {
  const plan = planCustom("ACMEEDIT", ROOT, mac(["/opt/homebrew/bin/acmeedit"]));
  assert.equal(plan.kind === "run" && plan.cmd, "/opt/homebrew/bin/acmeedit");
});

test("an unquoted path with spaces is the longest run of words that exists", () => {
  // Split at the first space, this spawned "/Applications/Sublime" — ENOENT.
  const subl = "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl";
  assert.deepEqual(planCustom(`${subl} -n {path}`, ROOT, mac([subl])), {
    kind: "run",
    program: subl,
    cmd: subl,
    args: ["-n", ROOT],
  });
  assert.deepEqual(planCustom(subl, ROOT, mac([subl])), { kind: "run", program: subl, cmd: subl, args: [ROOT] });
});

test("a quoted path is taken as written, and ~ is the home folder", () => {
  const ed = "/Users/dev/bin/my ed";
  assert.equal(planCustom(`"~/bin/my ed" --wait`, ROOT, mac([ed])).kind, "run");
  const plan = planCustom(`"~/bin/my ed" --wait`, ROOT, mac([ed]));
  assert.deepEqual(plan.kind === "run" && plan.args, ["--wait", ROOT]);
});

test("an application bundle — by path, or by the name it has in /Applications — opens with `open -a`", () => {
  const bundle = "/Applications/Acme Editor.app";
  assert.deepEqual(planCustom(bundle, ROOT, mac([], [bundle])), {
    kind: "run",
    program: bundle,
    cmd: OPEN,
    args: ["-a", bundle, ROOT],
  });
  assert.deepEqual(planCustom("Acme Editor", ROOT, mac([], [bundle])), {
    kind: "run",
    program: bundle,
    cmd: OPEN,
    args: ["-a", bundle, ROOT],
  });
  const mine = "/Users/dev/Applications/Acme Editor.app";
  assert.equal(planCustom("Acme Editor.app", ROOT, mac([], [mine])).kind === "run", true, "~/Applications too");
});

test("a folder whose name has `$&` or `$'` in it reaches the editor as it is", () => {
  // A replacement STRING reads those as patterns: "a$&b" arrived as "a{path}b".
  const hx = mac(["/opt/homebrew/bin/hx"]);
  for (const root of ["/Users/dev/a$&b", "/Users/dev/x$'y", "/Users/dev/$1 two"]) {
    const plan = planCustom("hx --dir={path} {path}", root, hx);
    assert.deepEqual(plan.kind === "run" && plan.args, [`--dir=${root}`, root], root);
  }
});

test("an app bundle with arguments of its own passes them after `--args`, which `open` requires", () => {
  const bundle = "/Applications/Acme Editor.app";
  const m = mac([], [bundle]);
  assert.deepEqual(planCustom(`"${bundle}" --new-window {path}`, ROOT, m), {
    kind: "run",
    program: bundle,
    cmd: OPEN,
    args: ["-a", bundle, ROOT, "--args", "--new-window"],
  });
  assert.deepEqual(planCustom(`"${bundle}" --wait`, ROOT, m), {
    kind: "run",
    program: bundle,
    cmd: OPEN,
    args: ["-a", bundle, ROOT, "--args", "--wait"],
  }, "the folder is still the file to open");
  assert.deepEqual(planCustom(`"${bundle}" --dir={path}`, ROOT, m), {
    kind: "run",
    program: bundle,
    cmd: OPEN,
    args: ["-a", bundle, "--args", `--dir=${ROOT}`],
  }, "written inside an argument, the folder is that argument");
});

test("a program that is nowhere is named back, not spawned", () => {
  assert.deepEqual(planCustom("ACMEEDIT {path}", ROOT, mac([])), { kind: "missing", program: "ACMEEDIT", bare: true });
  assert.deepEqual(planCustom("/usr/local/bin/gone --wait", ROOT, mac([])), { kind: "missing", program: "/usr/local/bin/gone", bare: false });
  assert.deepEqual(planCustom("bin/relative", ROOT, mac([])), { kind: "missing", program: "bin/relative", bare: false });
});

test("on Windows a custom .cmd runs through a quoted cmd.exe line", () => {
  const m: CustomMachine = {
    platform: "win32",
    home: "C:\\Users\\dev",
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    exists: () => false,
    isDir: () => false,
    find: (name) => (name === "ed" ? "C:\\Tools\\ed.cmd" : undefined),
  };
  assert.deepEqual(planCustom("ed --open {path}", "C:\\My Repos\\w&x", m), {
    kind: "run",
    program: "C:\\Tools\\ed.cmd",
    cmd: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\Tools\\ed.cmd ^"--open^" ^"C:\\My^ Repos\\w^&x^""'],
    verbatim: true,
  });
});

// ── openEditor: what happens, and what reaches the crash reporter ─────────────

interface Calls {
  started: Array<{ cmd: string; args: string[]; verbatim: boolean }>;
  opened: string[][];
  detections: boolean[];
  finders: boolean[];
}

function deps(over: Partial<EditorLaunchDeps> & { files?: string[]; dirs?: string[] } = {}): { deps: EditorLaunchDeps; calls: Calls } {
  const calls: Calls = { started: [], opened: [], detections: [], finders: [] };
  const files = new Set([ROOT, ...(over.files ?? [])]);
  const dirs = new Set([ROOT, ...(over.dirs ?? [])]);
  const d: EditorLaunchDeps = {
    platform: "darwin",
    home: "/Users/dev",
    env: {},
    exists: (p) => files.has(p) || dirs.has(p),
    isDir: (p) => dirs.has(p),
    detected: () => [],
    finder: async () => () => undefined,
    start: async () => ({ ok: true }),
    open: async () => ({ code: 0, stderr: "" }),
    ...over,
  };
  const wrapped: EditorLaunchDeps = {
    ...d,
    detected: (force) => (calls.detections.push(force), d.detected(force)),
    finder: async (fresh) => (calls.finders.push(fresh), d.finder(fresh)),
    start: async (cmd, args, verbatim) => (calls.started.push({ cmd, args, verbatim }), d.start(cmd, args, verbatim)),
    open: async (args) => (calls.opened.push(args), d.open(args)),
  };
  return { deps: wrapped, calls };
}

const NO_PREFS: EditorPrefs = { hidden: [], custom: [] };
const custom = (command: string): EditorPrefs => ({ hidden: [], custom: [{ id: "custom-1", name: "Acme Edit", command }] });
const vscodeCli = (location: string): DetectedEditor => ({ id: "vscode", name: "VSCode", via: "cli", location });

test("a repository folder that is gone is said as that, before any editor is tried", async () => {
  const { deps: d, calls } = deps({ exists: () => false });
  const r = await openEditor("vscode", "/Users/dev/src/moved", NO_PREFS, d);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /The folder \/Users\/dev\/src\/moved is not there any more/);
  assert.equal(r.expected, true);
  assert.equal(calls.started.length + calls.opened.length, 0);
});

test("a detected editor whose path has gone since detection is looked for again", async () => {
  // Detection is cached: an app updated, moved or removed since keeps its
  // old path there, and spawning it was "spawn <path> ENOENT".
  const { deps: d, calls } = deps({
    platform: "linux",
    files: ["/snap/bin/code"],
    detected: (force) => [vscodeCli(force ? "/snap/bin/code" : "/usr/local/bin/code")],
  });
  const r = await openEditor("vscode", ROOT, NO_PREFS, d);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.detections, [false, true]);
  assert.deepEqual(calls.started, [{ cmd: "/snap/bin/code", args: [ROOT], verbatim: false }]);
});

test("an editor gone from where it was found opens by name if macOS still knows it elsewhere", async () => {
  const { deps: d, calls } = deps({ detected: () => [] });
  const r = await openEditor("vscode", ROOT, NO_PREFS, d);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.opened, [["-a", "Visual Studio Code", ROOT]]);
});

test("an editor uninstalled since is said in words, and is not a crash", async () => {
  const { deps: d } = deps({ detected: () => [], open: async () => ({ code: 1, stderr: "Unable to find application named 'Visual Studio Code'" }) });
  const r = await openEditor("vscode", ROOT, NO_PREFS, d);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /That editor isn't installed any more/);
  assert.equal(r.expected, true);
  assert.equal(reportableResultMessage(r), undefined);
});

test("an app bundle that is there opens with `open -a`, and `open`'s refusal is said and reported", async () => {
  const app = "/Applications/Cursor.app";
  const ok = deps({ dirs: [app], detected: () => [{ id: "cursor", name: "Cursor", via: "app", location: app }] });
  assert.deepEqual(await openEditor("cursor", ROOT, NO_PREFS, ok.deps), { ok: true });
  assert.deepEqual(ok.calls.opened, [["-a", app, ROOT]]);

  const refused = deps({
    dirs: [app],
    detected: () => [{ id: "cursor", name: "Cursor", via: "app", location: app }],
    open: async () => ({ code: 1, stderr: "The application cannot be opened for an unexpected reason\n" }),
  });
  const r = await openEditor("cursor", ROOT, NO_PREFS, refused.deps);
  assert.equal(r.ok, false);
  assert.equal(r.message, "macOS couldn't open Cursor: The application cannot be opened for an unexpected reason");
  assert.ok(reportableResultMessage(r), "a bundle that is there and will not open is worth hearing about");
});

test("a detected CLI that is there and will not start falls back to its app by name on macOS", async () => {
  const { deps: d, calls } = deps({
    files: ["/usr/local/bin/code"],
    detected: () => [vscodeCli("/usr/local/bin/code")],
    start: async () => ({ ok: false, code: "ENOENT", message: "spawn /usr/local/bin/code ENOENT" }),
  });
  assert.deepEqual(await openEditor("vscode", ROOT, NO_PREFS, d), { ok: true });
  assert.deepEqual(calls.opened, [["-a", "Visual Studio Code", ROOT]]);
});

test("a detected CLI that will not start, with nothing to fall back to, reports — by its code", async () => {
  const { deps: d } = deps({
    platform: "linux",
    files: ["/usr/bin/code"],
    detected: () => [vscodeCli("/usr/bin/code")],
    start: async () => ({ ok: false, code: "EACCES", message: "spawn /usr/bin/code EACCES" }),
  });
  const r = await openEditor("vscode", ROOT, NO_PREFS, d);
  assert.equal(r.ok, false);
  assert.equal(r.message, "Couldn't launch it: EACCES");
  assert.equal(r.expected, undefined);
  // Never Node's "spawn <path> EACCES": main.ts reads that shape as Git
  // failing to start and would say THAT to the user (repoNotice.ts).
  assert.doesNotMatch(r.message ?? "", /spawn/);
  assert.ok(reportableResultMessage(r));
});

test("Windows: a detected .cmd launcher starts through cmd.exe with the line pre-quoted", async () => {
  const { deps: d, calls } = deps({
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    files: ["C:\\tools\\code.cmd", "C:\\src\\my repo"],
    detected: () => [vscodeCli("C:\\tools\\code.cmd")],
  });
  assert.deepEqual(await openEditor("vscode", "C:\\src\\my repo", NO_PREFS, d), { ok: true });
  assert.deepEqual(calls.started, [
    { cmd: "C:\\Windows\\system32\\cmd.exe", args: ["/d", "/s", "/c", '"C:\\tools\\code.cmd ^"C:\\src\\my^ repo^""'], verbatim: true },
  ]);
});

test("a custom command name the GUI PATH lacks is found on the login shell's PATH", async () => {
  // Crash report: "spawn <NAME> ENOENT" — a bare name, spawned as typed.
  const found = "/Users/dev/Library/acme/bin/ACMEEDIT";
  const { deps: d, calls } = deps({
    files: [found],
    finder: async (fresh) => (name) => (fresh && name === "ACMEEDIT" ? found : undefined),
  });
  assert.deepEqual(await openEditor("custom-1", ROOT, custom("ACMEEDIT"), d), { ok: true });
  assert.deepEqual(calls.finders, [false, true], "the login shell only after the usual folders came up empty");
  assert.deepEqual(calls.started, [{ cmd: found, args: [ROOT], verbatim: false }]);
});

test("a custom program that is nowhere says which, and where to fix it — not a crash", async () => {
  const { deps: d, calls } = deps();
  const r = await openEditor("custom-1", ROOT, custom("ACMEEDIT {path}"), d);
  assert.equal(r.ok, false);
  assert.equal(r.message, "Couldn't find ACMEEDIT, the program Acme Edit runs. Write its full path in Settings ▸ Editors.");
  assert.equal(r.expected, true);
  assert.equal(reportableResultMessage(r), undefined);
  assert.equal(calls.started.length, 0);
});

test("a custom PATH to a program that is gone is answered without asking the login shell", async () => {
  // No PATH changes where a path points; the shell is only for names.
  const { deps: d, calls } = deps();
  const r = await openEditor("custom-1", ROOT, custom("/usr/local/bin/gone {path}"), d);
  assert.equal(r.message, "Couldn't find /usr/local/bin/gone, the program Acme Edit runs. Write its full path in Settings ▸ Editors.");
  assert.equal(r.expected, true);
  assert.deepEqual(calls.finders, [false]);
});

test("a custom program that is there and will not run is the user's to fix, said in words", async () => {
  const prog = "/Users/dev/bin/acme";
  const { deps: d } = deps({
    files: [prog],
    finder: async () => (name) => (name === prog ? prog : undefined),
    start: async () => ({ ok: false, code: "EACCES", message: `spawn ${prog} EACCES` }),
  });
  const r = await openEditor("custom-1", ROOT, custom(prog), d);
  assert.equal(r.ok, false);
  assert.equal(r.message, `Acme Edit couldn't start ${prog}. Check that it's a program this account can run.`);
  assert.equal(r.expected, true);
});

test("a custom command that is an app bundle opens it with `open -a`", async () => {
  const bundle = "/Applications/Acme Editor.app";
  const { deps: d, calls } = deps({ dirs: [bundle] });
  assert.deepEqual(await openEditor("custom-1", ROOT, custom(bundle), d), { ok: true });
  assert.deepEqual(calls.opened, [["-a", bundle, ROOT]]);
  assert.equal(calls.started.length, 0);
});
