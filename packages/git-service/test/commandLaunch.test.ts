// Finding and starting a program the user installed, per platform, from any
// host: the platform, the environment and the filesystem are all fakes. No
// program is run.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betweenMarks,
  escapeCmdArgument,
  expandWindowsVars,
  findExecutable,
  launchEnv,
  parseCmdShim,
  planFor,
  planLaunch,
  prepareOn,
  regQueryPath,
  searchDirs,
  spawnOptionsFor,
  splitPathList,
  uniqueDirs,
  viaCmd,
  wellKnownBinDirs,
  type LaunchMachine,
} from "../src/commandLaunch";

function machine(platform: NodeJS.Platform, files: Record<string, string> | string[], over: Partial<LaunchMachine> = {}): LaunchMachine {
  const map = Array.isArray(files) ? Object.fromEntries(files.map((f) => [f, ""])) : files;
  const win = platform === "win32";
  return {
    platform,
    env: win ? { Path: "", PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" } : { PATH: "" },
    home: win ? "C:\\Users\\dev" : "/Users/dev",
    // Windows paths are case-insensitive; the fake is too.
    isFile: (p) => (win ? Object.keys(map).some((k) => k.toLowerCase() === p.toLowerCase()) : p in map),
    readText: (p) => map[p],
    ...over,
  };
}

// npm 7+'s launcher for a package bin (cmd-shim), verbatim but for the package.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\widgets-cli\\bin\\cli.js" %*
`;

// pnpm's (@zkochan/cmd-shim): the target one folder up, `%~dp0` spelled inline.
const PNPM_SHIM = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules"
) ELSE (
  @SET "NODE_PATH=%NODE_PATH%;C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\global\\5\\node_modules\\widgets-cli\\bin\\cli.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\..\\global\\5\\node_modules\\widgets-cli\\bin\\cli.js" %*
)
`;

// A native bin: cmd-shim runs the .exe itself, no Node involved.
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\widgets-cli\\bin\\widgets.exe"   %*
`;

// An editor's own launcher: Electron run as Node on its CLI script. Not a
// package shim, and must not be read as one.
const EDITOR_LAUNCHER = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\Widgets.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
`;

const NPM = "C:\\Users\\dev\\AppData\\Roaming\\npm";

// ── PATH lists and folders ───────────────────────────────────────────────────

test("a PATH list splits on the platform's separator and loses Windows' quotes", () => {
  assert.deepEqual(splitPathList('C:\\a;"C:\\Program Files\\b";;C:\\c', "win32"), ["C:\\a", "C:\\Program Files\\b", "C:\\c"]);
  assert.deepEqual(splitPathList("/usr/bin::/opt/homebrew/bin", "darwin"), ["/usr/bin", "/opt/homebrew/bin"]);
  assert.deepEqual(splitPathList(undefined, "linux"), []);
});

test("folders are searched once each, case-blind on Windows, and never relative ones", () => {
  assert.deepEqual(uniqueDirs(["C:\\Tools", "c:\\tools\\", "bin", ".", "D:\\x"], "win32"), ["C:\\Tools", "D:\\x"]);
  assert.deepEqual(uniqueDirs(["/usr/bin", "/usr/bin/", ".", "node_modules/.bin", "/Usr/bin"], "darwin"), ["/usr/bin", "/Usr/bin"]);
});

test("the installers' folders a GUI app's PATH lacks are searched on every platform", () => {
  const win = wellKnownBinDirs("win32", { USERPROFILE: "C:\\Users\\dev", APPDATA: `C:\\Users\\dev\\AppData\\Roaming` }, "C:\\Users\\dev");
  assert.ok(win.includes("C:\\Users\\dev\\.local\\bin"), "Claude Code's native installer");
  assert.ok(win.includes(NPM), "npm's global bin");
  const mac = wellKnownBinDirs("darwin", {}, "/Users/dev");
  for (const d of ["/Users/dev/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]) assert.ok(mac.includes(d), d);
  const linux = wellKnownBinDirs("linux", {}, "/home/dev");
  for (const d of ["/home/dev/.local/bin", "/usr/local/bin", "/snap/bin"]) assert.ok(linux.includes(d), d);
});

test("searchDirs reads Windows' PATH whatever case its name has", () => {
  const m = machine("win32", [], { env: { Path: "C:\\tools" } });
  assert.equal(searchDirs(m)[0], "C:\\tools");
  assert.ok(searchDirs(m, ["E:\\fresh"]).includes("E:\\fresh"), "and what the registry added comes after");
});

// ── finding the program ──────────────────────────────────────────────────────

test("on macOS and Linux the first PATH folder that has it wins", () => {
  const m = machine("darwin", ["/b/widgets", "/a/widgets"]);
  assert.equal(findExecutable("widgets", ["/a", "/b"], m), "/a/widgets");
  assert.equal(findExecutable("nope", ["/a", "/b"], m), undefined);
});

test("on Windows each folder is tried in PATHEXT order, and an .exe beats a .cmd beside it", () => {
  const m = machine("win32", ["C:\\a\\widgets.cmd", "C:\\a\\widgets.exe", "C:\\b\\widgets.exe"]);
  assert.equal(findExecutable("widgets", ["C:\\a", "C:\\b"], m), "C:\\a\\widgets.exe");
  const onlyCmd = machine("win32", ["C:\\a\\widgets.cmd", "C:\\b\\widgets.exe"]);
  assert.equal(findExecutable("widgets", ["C:\\a", "C:\\b"], onlyCmd), "C:\\a\\widgets.cmd", "the first folder wins, as Windows decides");
});

test("on Windows an extensionless file or a .js is never the program", () => {
  // npm writes a POSIX shell script with no extension beside each .cmd, and
  // PATHEXT lists .JS, which Windows Script Host would open.
  const m = machine("win32", ["C:\\a\\widgets", "C:\\a\\widgets.js"]);
  assert.equal(findExecutable("widgets", ["C:\\a"], m), undefined);
});

test("a path is checked where it says, ~ is the home folder, and a relative one is nowhere", () => {
  const m = machine("darwin", ["/opt/widgets/bin/w", "/Users/dev/bin/w"]);
  assert.equal(findExecutable("/opt/widgets/bin/w", [], m), "/opt/widgets/bin/w");
  assert.equal(findExecutable("~/bin/w", [], m), "/Users/dev/bin/w");
  assert.equal(findExecutable("bin/w", ["/Users/dev"], m), undefined);
  const win = machine("win32", ["C:\\Tools\\w.exe"]);
  assert.equal(findExecutable("C:\\Tools\\w", [], win), "C:\\Tools\\w.exe", "Windows adds the extension to a path too");
});

// ── Windows launchers ────────────────────────────────────────────────────────

test("npm's launcher is read for the script it runs under Node", () => {
  assert.deepEqual(parseCmdShim(NPM_SHIM, `${NPM}\\widgets.cmd`), { script: `${NPM}\\node_modules\\widgets-cli\\bin\\cli.js` });
});

test("pnpm's launcher is read the same way, its `..` resolved", () => {
  const shim = "C:\\Users\\dev\\AppData\\Local\\pnpm\\bin\\widgets.cmd";
  assert.deepEqual(parseCmdShim(PNPM_SHIM, shim), {
    script: "C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\widgets-cli\\bin\\cli.js",
  });
});

test("a launcher for a native bin names the .exe to run", () => {
  assert.deepEqual(parseCmdShim(EXE_SHIM, `${NPM}\\widgets.cmd`), { exe: `${NPM}\\node_modules\\widgets-cli\\bin\\widgets.exe` });
});

test("an editor's own launcher and a hand-written batch file are not package launchers", () => {
  assert.equal(parseCmdShim(EDITOR_LAUNCHER, "C:\\Program Files\\Widgets\\bin\\widgets.cmd"), undefined);
  assert.equal(parseCmdShim("@echo off\r\nstart widgets.exe %*\r\n", "C:\\x\\w.cmd"), undefined);
});

test("an npm-installed CLI runs as node.exe + its script, never through cmd.exe", () => {
  const m = machine("win32", {
    [`${NPM}\\widgets.cmd`]: NPM_SHIM,
    [`${NPM}\\node_modules\\widgets-cli\\bin\\cli.js`]: "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  });
  const plan = planLaunch("widgets", ["-p", "line one\nline two"], [NPM, "C:\\Program Files\\nodejs"], m);
  assert.deepEqual(plan, {
    kind: "run",
    file: "C:\\Program Files\\nodejs\\node.exe",
    args: [`${NPM}\\node_modules\\widgets-cli\\bin\\cli.js`, "-p", "line one\nline two"],
    found: `${NPM}\\widgets.cmd`,
  });
});

test("node.exe beside the launcher is the launcher's own first choice", () => {
  const m = machine("win32", {
    [`${NPM}\\widgets.cmd`]: NPM_SHIM,
    [`${NPM}\\node_modules\\widgets-cli\\bin\\cli.js`]: "",
    [`${NPM}\\node.exe`]: "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  });
  const plan = planFor(`${NPM}\\widgets.cmd`, [], ["C:\\Program Files\\nodejs"], m);
  assert.equal(plan.kind === "run" && plan.file, `${NPM}\\node.exe`);
});

test("a node.cmd is not a Node to run a script with: that is the problem being solved", () => {
  const m = machine("win32", {
    [`${NPM}\\widgets.cmd`]: NPM_SHIM,
    [`${NPM}\\node_modules\\widgets-cli\\bin\\cli.js`]: "",
    "C:\\shims\\node.cmd": "",
  });
  assert.deepEqual(planFor(`${NPM}\\widgets.cmd`, [], ["C:\\shims"], m), { kind: "needs-node", found: `${NPM}\\widgets.cmd` });
});

test("a launcher whose package is gone is a program that is not installed", () => {
  const m = machine("win32", { [`${NPM}\\widgets.cmd`]: NPM_SHIM, [`${NPM}\\node.exe`]: "" });
  assert.deepEqual(planFor(`${NPM}\\widgets.cmd`, [], [], m), { kind: "missing" });
  const exe = machine("win32", { [`${NPM}\\widgets.cmd`]: EXE_SHIM });
  assert.deepEqual(planFor(`${NPM}\\widgets.cmd`, [], [], exe), { kind: "missing" });
});

test("a launcher that names an .exe starts the .exe", () => {
  const m = machine("win32", { [`${NPM}\\widgets.cmd`]: EXE_SHIM, [`${NPM}\\node_modules\\widgets-cli\\bin\\widgets.exe`]: "" });
  const plan = planFor(`${NPM}\\widgets.cmd`, ["--version"], [], m);
  assert.deepEqual(plan, { kind: "run", file: `${NPM}\\node_modules\\widgets-cli\\bin\\widgets.exe`, args: ["--version"], found: `${NPM}\\widgets.cmd` });
});

test("any other batch file goes through cmd.exe, every argument quoted and escaped", () => {
  const m = machine("win32", { "C:\\Tools\\w.cmd": "@echo off\r\nwidgets.exe %*\r\n" }, { env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
  const plan = planFor("C:\\Tools\\w.cmd", ["C:\\Users\\Jane Doe\\a&b"], [], m);
  assert.deepEqual(plan, {
    kind: "run",
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\Tools\\w.cmd ^"C:\\Users\\Jane^ Doe\\a^&b^""'],
    verbatim: true,
    found: "C:\\Tools\\w.cmd",
  });
});

test("an argument cmd.exe cannot carry — a newline — is refused, not cut short", () => {
  const m = machine("win32", { "C:\\Tools\\w.cmd": "@echo off\r\nwidgets.exe %*\r\n" });
  assert.deepEqual(planFor("C:\\Tools\\w.cmd", ["one\ntwo"], [], m), { kind: "unrunnable", found: "C:\\Tools\\w.cmd" });
  assert.equal(viaCmd("C:\\Tools\\w.cmd", ["a\rb"], {}), undefined);
});

test("cmd.exe arguments: quotes and trailing backslashes survive MSVCRT's unquoting", () => {
  assert.equal(escapeCmdArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeCmdArgument("C:\\dir\\"), '^"C:\\dir\\\\^"');
  assert.equal(escapeCmdArgument("100%"), '^"100^%^"', "a percent sign never expands a variable");
});

test("on macOS and Linux a found program simply runs", () => {
  const m = machine("darwin", ["/opt/homebrew/bin/widgets"]);
  assert.deepEqual(planLaunch("widgets", ["a b"], ["/opt/homebrew/bin"], m), {
    kind: "run",
    file: "/opt/homebrew/bin/widgets",
    args: ["a b"],
    found: "/opt/homebrew/bin/widgets",
  });
});

// ── the environment it starts in ─────────────────────────────────────────────

test("the program's own folder leads its PATH, so `#!/usr/bin/env node` finds the Node beside it", () => {
  const env = launchEnv({ PATH: "/usr/bin:/bin", HOME: "/Users/dev" }, "darwin", ["/Users/dev/.nvm/bin"], ["/usr/bin", "/opt/homebrew/bin"]);
  assert.equal(env.PATH, "/Users/dev/.nvm/bin:/usr/bin:/bin:/opt/homebrew/bin");
  assert.equal(env.HOME, "/Users/dev", "the rest of the environment is kept");
});

test("on Windows the existing Path key is reused, never doubled in another case", () => {
  const env = launchEnv({ Path: "C:\\Windows;C:\\Tools", Other: "1" }, "win32", ["C:\\tools"], ["D:\\x"]);
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === "PATH"), ["Path"]);
  assert.equal(env.Path, "C:\\tools;C:\\Windows;D:\\x");
});

test("prepareOn hands back the file, its arguments and its environment together", () => {
  const m = machine("linux", ["/home/dev/.local/bin/widgets"], { home: "/home/dev", env: { PATH: "/usr/bin" } });
  const r = prepareOn("widgets", ["-v"], m);
  assert.ok(r.ok);
  assert.equal(r.launch.file, "/home/dev/.local/bin/widgets");
  assert.deepEqual(r.launch.args, ["-v"]);
  assert.ok(r.launch.env.PATH?.startsWith("/home/dev/.local/bin:/usr/bin"));
  const miss = prepareOn("nope", [], m);
  assert.deepEqual(miss, { ok: false, plan: { kind: "missing" } });
});

// ── what the host reads back ─────────────────────────────────────────────────

test("the login shell's PATH is read between the markers, whatever the rc files print", () => {
  const out = "Last login: today\n\u001b[1mwelcome\u001b[0m\n__M__/Users/dev/.nvm/bin:/usr/bin\n__M__goodbye\n";
  assert.equal(betweenMarks(out, "__M__"), "/Users/dev/.nvm/bin:/usr/bin");
  assert.equal(betweenMarks("no markers here", "__M__"), undefined);
});

test("the registry's Path is read from `reg query` and its variables expanded", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools;%NOPE%\\x\r\n\r\n";
  const raw = regQueryPath(out);
  assert.equal(raw, "%USERPROFILE%\\.local\\bin;C:\\Tools;%NOPE%\\x");
  assert.equal(expandWindowsVars(raw!, { userprofile: "C:\\Users\\dev" }), "C:\\Users\\dev\\.local\\bin;C:\\Tools;%NOPE%\\x");
  assert.equal(regQueryPath("ERROR: The system was unable to find the specified registry key or value."), undefined);
});

// ── review follow-ups ────────────────────────────────────────────────────────

const YARN = "C:\\Users\\dev\\AppData\\Local\\Yarn";
const YARN_OUTER = `${YARN}\\bin\\widgets.cmd`;
const YARN_INNER = `${YARN}\\Data\\global\\node_modules\\.bin\\widgets.cmd`;
const YARN_SCRIPT = `${YARN}\\Data\\global\\node_modules\\widgets-cli\\bin\\cli.js`;

test("Yarn's global launcher hands over to another launcher, which is read in turn", () => {
  const outer = '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\widgets.cmd" %*\r\n';
  assert.deepEqual(parseCmdShim(outer, YARN_OUTER), { cmd: YARN_INNER });
  const m = machine("win32", {
    [YARN_OUTER]: outer,
    [YARN_INNER]: PNPM_SHIM.replace(/\\\.\.\\global\\5\\node_modules/g, "\\.."),
    [YARN_SCRIPT]: "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  });
  assert.deepEqual(planFor(YARN_OUTER, ["-p"], ["C:\\Program Files\\nodejs"], m), {
    kind: "run",
    file: "C:\\Program Files\\nodejs\\node.exe",
    args: [YARN_SCRIPT, "-p"],
    found: YARN_OUTER,
  });
});

test("a launcher chain is followed a few levels, never round in a circle", () => {
  const loop = '@"%~dp0\\w.cmd" %*\r\n';
  const m = machine("win32", { "C:\\x\\w.cmd": loop });
  const plan = planFor("C:\\x\\w.cmd", ["-v"], [], m);
  assert.equal(plan.kind, "run");
  assert.equal(plan.kind === "run" && plan.verbatim, true, "after a bounded depth it is run through cmd.exe like any batch file");
});

test("a launcher whose inner launcher is gone is a program that is not installed", () => {
  const m = machine("win32", { [YARN_OUTER]: '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\widgets.cmd" %*\r\n' });
  assert.deepEqual(planFor(YARN_OUTER, [], [], m), { kind: "missing" });
});

test("a `\"` in an argument is never put on a cmd.exe line: a launcher re-parses it and `&` would run", () => {
  assert.equal(viaCmd("C:\\Tools\\w.cmd", ['say "hi & calc'], {}), undefined);
  const m = machine("win32", { "C:\\Tools\\w.cmd": "@echo off\r\nwidgets.exe %*\r\n" });
  assert.deepEqual(planFor("C:\\Tools\\w.cmd", ['x"y'], [], m), { kind: "unrunnable", found: "C:\\Tools\\w.cmd" });
});

test("a Node named `%~dp0node.exe`, with no separator, is still not the target", () => {
  const shim = '@"%~dp0node.exe" "%~dp0node_modules\\foo\\cli.js" %*';
  assert.deepEqual(parseCmdShim(shim, "C:\\x\\foo.cmd"), { script: "C:\\x\\node_modules\\foo\\cli.js" });
  assert.deepEqual(parseCmdShim('@"%~dp0node.exe" %*', "C:\\x\\n.cmd"), undefined);
});

test("every prepared CLI launch hides its console on Windows", () => {
  assert.equal(spawnOptionsFor({ file: "a", args: [], found: "a", env: {} }).windowsHide, true);
  assert.equal(spawnOptionsFor({ file: "a", args: [], found: "a", env: {}, verbatim: true }).windowsHide, true);
});
