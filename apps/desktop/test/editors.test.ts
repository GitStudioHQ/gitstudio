import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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

test("~/Applications and the JetBrains Toolbox folder count as app dirs", () => {
  const e = env("darwin", ["/Users/dev/Applications/JetBrains Toolbox/WebStorm.app", "/Users/dev/Applications/Zed.app"]);
  assert.equal(detectEditor(spec("webstorm"), e)?.location, "/Users/dev/Applications/JetBrains Toolbox/WebStorm.app");
  assert.equal(detectEditor(spec("zed"), e)?.via, "app");
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
  const local = "C:\\Users\\dev\\AppData\\Local";
  const cli = env("win32", [join(local, "JetBrains", "Toolbox", "scripts", "webstorm.cmd")], { localAppData: local });
  assert.equal(detectEditor(spec("webstorm"), cli)?.via, "cli");
  const installed = env("win32", [join(local, "Programs/cursor/Cursor.exe")], { localAppData: local });
  const hit = detectEditor(spec("cursor"), installed);
  assert.equal(hit?.via, "path");
  assert.equal(hit?.location, join(local, "Programs/cursor/Cursor.exe"));
  // Program Files entries need the variable to be present at all. (Joined
  // with the host's own separator, as the detector does.)
  const pf = "C:\\Program Files";
  const subl = join(pf, "Sublime Text/sublime_text.exe");
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

test("a macOS app opens through `open -a`, a CLI runs directly", () => {
  assert.deepEqual(commandFor({ via: "app", location: "/Applications/Cursor.app" }, "/repo", "darwin"), {
    cmd: "open",
    args: ["-a", "/Applications/Cursor.app", "/repo"],
    shell: false,
  });
  assert.deepEqual(commandFor({ via: "cli", location: "/usr/local/bin/code" }, "/repo", "darwin"), {
    cmd: "/usr/local/bin/code",
    args: ["/repo"],
    shell: false,
  });
});

test("a Windows .cmd shim needs a shell; an .exe does not", () => {
  assert.equal(commandFor({ via: "cli", location: "C:\\x\\code.cmd" }, "C:\\repo", "win32").shell, true);
  assert.equal(commandFor({ via: "path", location: "C:\\x\\Code.exe" }, "C:\\repo", "win32").shell, false);
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
