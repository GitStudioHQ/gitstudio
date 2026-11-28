import { test } from "node:test";
import assert from "node:assert/strict";
import { join, win32 } from "node:path";
import {
  EDITOR_CATALOG,
  commandFor,
  customCommandFor,
  detectEditor,
  detectEditors,
  editorsView,
  type DetectEnv,
} from "../src/main/editors";

// "Open in <editor>": detection against a fake filesystem, the command each
// platform runs, and the view Settings edits. No real editor is touched.

function env(platform: NodeJS.Platform, present: string[], extra: Partial<DetectEnv> = {}): DetectEnv {
  const set = new Set(present);
  return {
    platform,
    home: platform === "win32" ? "C:\\Users\\dev" : "/Users/dev",
    path: "",
    exists: (p) => set.has(p),
    ...extra,
  };
}

const spec = (id: string) => {
  const s = EDITOR_CATALOG.find((e) => e.id === id);
  assert.ok(s, `catalog has ${id}`);
  return s;
};

test("a macOS app bundle is found without any CLI on PATH", () => {
  const e = env("darwin", ["/Applications/Cursor.app"]);
  const hit = detectEditor(spec("cursor"), e);
  assert.deepEqual(hit, { id: "cursor", name: "Cursor", via: "app", location: "/Applications/Cursor.app" });
  assert.equal(detectEditor(spec("vscode"), e), undefined);
});

test("~/Applications counts as an app dir", () => {
  const e = env("darwin", ["/Users/dev/Applications/Zed.app"]);
  assert.equal(detectEditor(spec("zed"), e)?.location, "/Users/dev/Applications/Zed.app");
  assert.equal(detectEditor(spec("zed"), e)?.via, "app");
});

test("Open in lists none of the IntelliJ-platform IDEs any more", () => {
  // The owner's call when the external-IDE merge hand-off went: GitStudio no
  // longer names or launches those IDEs anywhere.
  const ids = EDITOR_CATALOG.map((s) => s.id);
  for (const gone of ["webstorm", "intellij", "pycharm", "goland", "phpstorm", "rider", "clion", "rubymine", "rustrover", "fleet"]) {
    assert.ok(!ids.includes(gone), `${gone} is still in the catalog`);
  }
  assert.ok(ids.includes("vscode") && ids.includes("cursor"), "VS Code and Cursor stay");
});

test("a CLI in Homebrew's bin is found even with a minimal PATH", () => {
  const e = env("linux", ["/opt/homebrew/bin/code"]);
  assert.deepEqual(detectEditor(spec("vscode"), e), {
    id: "vscode",
    name: "VSCode",
    via: "cli",
    location: "/opt/homebrew/bin/code",
  });
});

test("PATH entries are searched first, in order", () => {
  const e = env("linux", ["/home/dev/bin/code", "/usr/local/bin/code"], { path: "/home/dev/bin:/usr/bin" });
  assert.equal(detectEditor(spec("vscode"), e)?.location, "/home/dev/bin/code");
});

test("Windows finds the .cmd shim, then the known install path", () => {
  // win32.join, not the host's join: the detector builds paths for the platform
  // it was ASKED about, so describing a Windows filesystem from macOS has to use
  // Windows separators or the fake `exists` set never matches. This test used the
  // host's separator and only agreed with the detector by accident, on a host
  // that happened to be the same platform.
  const local = "C:\\Users\\dev\\AppData\\Local";
  const cli = env("win32", [win32.join("C:\\tools", "code.cmd")], { localAppData: local, path: "C:\\tools" });
  assert.equal(detectEditor(spec("vscode"), cli)?.via, "cli");
  const installed = env("win32", [win32.join(local, "Programs/cursor/Cursor.exe")], { localAppData: local });
  const hit = detectEditor(spec("cursor"), installed);
  assert.equal(hit?.via, "path");
  assert.equal(hit?.location, win32.join(local, "Programs/cursor/Cursor.exe"));
  // Program Files entries need the variable to be present at all.
  const pf = "C:\\Program Files";
  const subl = win32.join(pf, "Sublime Text/sublime_text.exe");
  assert.equal(detectEditor(spec("sublime"), env("win32", [subl])), undefined);
  assert.equal(detectEditor(spec("sublime"), env("win32", [subl], { programFiles: pf }))?.via, "path");
});

test("detectEditors keeps the catalog order", () => {
  const e = env("darwin", ["/Applications/Zed.app", "/Applications/Visual Studio Code.app", "/Applications/Cursor.app"]);
  assert.deepEqual(
    detectEditors(e).map((d) => d.id),
    ["vscode", "cursor", "zed"],
  );
});

test("a macOS app opens through `open -a` (by its full path), a CLI runs directly", () => {
  assert.deepEqual(commandFor({ via: "app", location: "/Applications/Cursor.app" }, "/repo", "darwin"), {
    cmd: "/usr/bin/open",
    args: ["-a", "/Applications/Cursor.app", "/repo"],
  });
  assert.deepEqual(commandFor({ via: "cli", location: "/usr/local/bin/code" }, "/repo", "darwin"), {
    cmd: "/usr/local/bin/code",
    args: ["/repo"],
  });
});

test("a Windows .cmd launcher runs through a quoted cmd.exe line; an .exe runs directly", () => {
  // `shell: true` used to run it, and Node joins a shell's arguments with
  // plain spaces: "C:\\Users\\Jane Doe\\…" reached the editor as two
  // arguments, and a folder named with `&` ran the rest as a command.
  const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(commandFor({ via: "cli", location: "C:\\x\\code.cmd" }, "C:\\Users\\Jane Doe\\a&b", "win32", env), {
    cmd: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\x\\code.cmd ^"C:\\Users\\Jane^ Doe\\a^&b^""'],
    verbatim: true,
  });
  assert.deepEqual(commandFor({ via: "path", location: "C:\\x\\Code.exe" }, "C:\\My Repo", "win32", env), {
    cmd: "C:\\x\\Code.exe",
    args: ["C:\\My Repo"],
  });
});

test("Windows prefers the installed .exe to the .cmd launcher on PATH", () => {
  const local = "C:\\Users\\dev\\AppData\\Local";
  const exe = win32.join(local, "Programs/Microsoft VS Code/Code.exe");
  const both = env("win32", [win32.join("C:\\tools", "code.cmd"), exe], { localAppData: local, path: "C:\\tools" });
  assert.deepEqual(detectEditor(spec("vscode"), both), { id: "vscode", name: "VSCode", via: "path", location: exe });
});

test("Windows never takes the extensionless shell script that sits beside a .cmd", () => {
  const e = env("win32", [win32.join("C:\\tools", "cursor")], { path: "C:\\tools" });
  assert.equal(detectEditor(spec("cursor"), e), undefined);
});

test("a custom command substitutes {path} or appends the folder", () => {
  assert.deepEqual(customCommandFor("emacsclient -n {path}", "/repo"), { cmd: "emacsclient", args: ["-n", "/repo"] });
  assert.deepEqual(customCommandFor("/usr/local/bin/hx", "/repo"), { cmd: "/usr/local/bin/hx", args: ["/repo"] });
  assert.deepEqual(customCommandFor('"C:\\Program Files\\Ed\\ed.exe" --open {path}', "C:\\repo"), {
    cmd: "C:\\Program Files\\Ed\\ed.exe",
    args: ["--open", "C:\\repo"],
  });
  // A path with a space must reach the editor as ONE argument.
  assert.deepEqual(customCommandFor("code", "/Users/dev/My Repo"), { cmd: "code", args: ["/Users/dev/My Repo"] });
  // Quotes inside a word, as a shell reads them: one argument, no quote left
  // in it (a quote inside an argument can't be carried on a cmd.exe line).
  assert.deepEqual(customCommandFor('ed --title="My Repo" {path}', "/repo"), { cmd: "ed", args: ["--title=My Repo", "/repo"] });
});

test("the view hides what Settings hid and defaults to the chosen, else the first shown", () => {
  // editorsView reads the real machine through listDetected, so exercise the
  // preference logic through what it does with a custom-only set of prefs.
  const prefs = {
    hidden: ["custom-a"],
    defaultId: "custom-b",
    custom: [
      { id: "custom-a", name: "Helix", command: "hx" },
      { id: "custom-b", name: "Emacs", command: "emacsclient -n {path}" },
    ],
  };
  const v = editorsView(prefs, true);
  const a = v.editors.find((e) => e.id === "custom-a");
  const b = v.editors.find((e) => e.id === "custom-b");
  assert.equal(a?.shown, false);
  assert.equal(a?.isDefault, false);
  assert.equal(b?.shown, true);
  assert.equal(b?.isDefault, true);
  assert.equal(b?.via, "custom");
  assert.equal(v.defaultId, "custom-b");

  // The chosen default is hidden → the first SHOWN one takes over.
  const v2 = editorsView({ ...prefs, hidden: ["custom-b"] }, true);
  const shown = v2.editors.filter((e) => e.shown);
  assert.ok(shown.length >= 1);
  assert.equal(v2.defaultId, shown[0].id);
  assert.equal(shown.filter((e) => e.isDefault).length, 1);
});
