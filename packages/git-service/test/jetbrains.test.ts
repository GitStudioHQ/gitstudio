import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateJetBrainsIde } from "../src/jetbrains/locator";
import { launchJetBrainsDiff, launchJetBrainsMerge } from "../src/jetbrains/launcher";
import { reporterRepo } from "./opRepo";

// W5 (PLAN §3.5): the JetBrains hand-off. The locator is Merge Studio's plus
// the places the desktop already looks (Toolbox scripts, ~/Applications/
// JetBrains Toolbox, Windows install folders), driven entirely through an
// injected filesystem so every platform is tested from any host. The launcher
// is exercised for real against a fake IDE that records what it was given.

function fs(files: string[], dirs: Record<string, string[]> = {}) {
  const set = new Set(files);
  return { exists: (p: string) => set.has(p), listDir: (p: string) => dirs[p] ?? [] };
}

// ── Locator ─────────────────────────────────────────────────────────────────

test("macOS: an app bundle in /Applications, launched through the binary inside it", async () => {
  const hit = await locateJetBrainsIde({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/dev",
    ...fs(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]),
  });
  assert.deepEqual(hit, { id: "webstorm", name: "WebStorm", command: "/Applications/WebStorm.app/Contents/MacOS/webstorm" });
});

test("macOS: JetBrains Toolbox — its scripts folder and its own Applications folder", async () => {
  const scripts = await locateJetBrainsIde({
    platform: "darwin",
    env: { PATH: "" },
    homeDir: "/Users/dev",
    ...fs(["/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/idea"]),
  });
  assert.equal(scripts?.id, "intellij");
  assert.equal(scripts?.name, "IntelliJ IDEA");
  const apps = await locateJetBrainsIde({
    platform: "darwin",
    env: {},
    homeDir: "/Users/dev",
    ...fs(["/Users/dev/Applications/JetBrains Toolbox/PyCharm Professional Edition.app/Contents/MacOS/pycharm"]),
  });
  assert.equal(apps?.id, "pycharm");
});

test("search order: the default list, unless an IDE is preferred", async () => {
  const both = fs(["/Applications/GoLand.app/Contents/MacOS/goland", "/Applications/WebStorm.app/Contents/MacOS/webstorm"]);
  const auto = await locateJetBrainsIde({ platform: "darwin", env: {}, homeDir: "/h", ...both });
  assert.equal(auto?.id, "webstorm", "WebStorm comes first in JETBRAINS_IDES");
  const preferred = await locateJetBrainsIde({ platform: "darwin", env: {}, homeDir: "/h", preferred: "goland", ...both });
  assert.equal(preferred?.id, "goland");
  const missing = await locateJetBrainsIde({ platform: "darwin", env: {}, homeDir: "/h", preferred: "rider", ...both });
  assert.equal(missing?.id, "webstorm", "a preferred IDE that is not installed falls back to the list");
});

test("PATH is searched, with the platform's own separator", async () => {
  const hit = await locateJetBrainsIde({
    platform: "linux",
    env: { PATH: "/opt/a:/opt/b" },
    homeDir: "/home/dev",
    ...fs(["/opt/b/clion"]),
  });
  assert.equal(hit?.command, "/opt/b/clion");
});

test("the explicit path wins — a launcher, or a macOS bundle looked inside", async () => {
  const script = await locateJetBrainsIde({
    platform: "darwin",
    env: {},
    homeDir: "/h",
    explicitPath: "/opt/tools/webstorm.sh",
    ...fs(["/opt/tools/webstorm.sh", "/Applications/GoLand.app/Contents/MacOS/goland"]),
  });
  assert.deepEqual(script, { id: "custom", name: "WebStorm", command: "/opt/tools/webstorm.sh" });
  const bundle = await locateJetBrainsIde({
    platform: "darwin",
    env: {},
    homeDir: "/h",
    explicitPath: "/Applications/GoLand.app",
    ...fs(["/Applications/GoLand.app/Contents/MacOS/goland"]),
  });
  assert.deepEqual(bundle, { id: "custom", name: "GoLand", command: "/Applications/GoLand.app/Contents/MacOS/goland" });
  const gone = await locateJetBrainsIde({
    platform: "darwin",
    env: {},
    homeDir: "/h",
    explicitPath: "/nowhere/idea",
    ...fs(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]),
  });
  assert.equal(gone?.id, "webstorm", "a stale explicit path does not hide an installed IDE");
});

test("Windows: Toolbox's .cmd scripts, and the newest Program Files install", async () => {
  const toolbox = await locateJetBrainsIde({
    platform: "win32",
    env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
    homeDir: "C:\\Users\\dev",
    ...fs(["C:\\Users\\dev\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\webstorm.cmd"]),
  });
  assert.equal(toolbox?.command, "C:\\Users\\dev\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\webstorm.cmd");
  const pf = await locateJetBrainsIde({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    homeDir: "C:\\Users\\dev",
    ...fs(
      [
        "C:\\Program Files\\JetBrains\\WebStorm 2023.3.1\\bin\\webstorm64.exe",
        "C:\\Program Files\\JetBrains\\WebStorm 2024.2\\bin\\webstorm64.exe",
        "C:\\Program Files\\JetBrains\\JetBrains Rider 2024.1\\bin\\rider64.exe",
      ],
      { "C:\\Program Files\\JetBrains": ["WebStorm 2023.3.1", "JetBrains Rider 2024.1", "WebStorm 2024.2"] },
    ),
  });
  assert.equal(pf?.command, "C:\\Program Files\\JetBrains\\WebStorm 2024.2\\bin\\webstorm64.exe");
  const rider = await locateJetBrainsIde({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    homeDir: "C:\\Users\\dev",
    preferred: "rider",
    ...fs(["C:\\Program Files\\JetBrains\\JetBrains Rider 2024.1\\bin\\rider64.exe"], {
      "C:\\Program Files\\JetBrains": ["JetBrains Rider 2024.1"],
    }),
  });
  assert.equal(rider?.id, "rider");
});

test("Linux: Toolbox scripts and a tarball under /opt", async () => {
  const toolbox = await locateJetBrainsIde({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    homeDir: "/home/dev",
    ...fs(["/home/dev/.local/share/JetBrains/Toolbox/scripts/pycharm"]),
  });
  assert.equal(toolbox?.id, "pycharm");
  const opt = await locateJetBrainsIde({
    platform: "linux",
    env: {},
    homeDir: "/home/dev",
    ...fs(["/opt/pycharm-2024.1/bin/pycharm.sh"], { "/opt": ["pycharm-2023.2", "pycharm-2024.1"] }),
  });
  assert.equal(opt?.command, "/opt/pycharm-2024.1/bin/pycharm.sh");
});

test("nothing installed: undefined", async () => {
  assert.equal(await locateJetBrainsIde({ platform: "darwin", env: { PATH: "/usr/bin" }, homeDir: "/h", ...fs([]) }), undefined);
});

// ── Launcher (a real spawn of a fake IDE) ───────────────────────────────────

/** A fake IDE: records its arguments and every file argument's contents. */
function fakeIde(): { dir: string; command: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-fake-ide-"));
  const command = join(dir, "webstorm");
  const log = join(dir, "ide.log");
  writeFileSync(
    command,
    `#!/bin/sh
out="${log}"
{
  printf 'ARG %s\\n' "$@"
  for a in "$@"; do if [ -f "$a" ]; then printf 'FILE %s\\n' "$a"; cat "$a"; printf '<EOF>\\n'; fi; done
} > "$out.tmp" && mv "$out.tmp" "$out"
`,
  );
  chmodSync(command, 0o755);
  return { dir, command, log };
}

async function waitFor(path: string, ms = 5000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the fake IDE never wrote ${path}`);
}

function parseLog(log: string): { args: string[]; files: Record<string, string> } {
  const args = [...log.matchAll(/^ARG (.*)$/gm)].map((m) => m[1]);
  const files: Record<string, string> = {};
  for (const m of log.matchAll(/^FILE (.*)\n([\s\S]*?)<EOF>$/gm)) files[m[1]] = m[2];
  return { args, files };
}

const posixOnly = process.platform === "win32" ? "the fake IDE is a shell script" : false;

test("merge: `<ide> merge LOCAL REMOTE BASE <output>` with LOCAL = Yours, and dispose removes the temp files", { skip: posixOnly }, async () => {
  const ide = fakeIde();
  const work = mkdtempSync(join(tmpdir(), "gs-jb-work-"));
  try {
    const output = join(work, "f.txt");
    writeFileSync(output, "<<<<<<< conflicted working copy\n");
    const launch = await launchJetBrainsMerge({
      ide: { id: "webstorm", name: "WebStorm", command: ide.command },
      outputPath: output,
      yours: "YOURS\n",
      theirs: "THEIRS\n",
      base: "BASE\n",
    });
    assert.equal(launch.ok, true, launch.message);
    assert.ok(launch.tempDir && existsSync(launch.tempDir));
    const { args, files } = parseLog(await waitFor(ide.log));
    const t = launch.tempDir!;
    assert.deepEqual(args, ["merge", join(t, "f.LOCAL.txt"), join(t, "f.REMOTE.txt"), join(t, "f.BASE.txt"), output]);
    assert.equal(files[join(t, "f.LOCAL.txt")], "YOURS\n");
    assert.equal(files[join(t, "f.REMOTE.txt")], "THEIRS\n");
    assert.equal(files[join(t, "f.BASE.txt")], "BASE\n");
    await launch.dispose();
    assert.equal(existsSync(t), false, "the temp files are gone");
    await launch.dispose(); // idempotent
  } finally {
    rmSync(ide.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("merge without a base passes no BASE file", { skip: posixOnly }, async () => {
  const ide = fakeIde();
  const work = mkdtempSync(join(tmpdir(), "gs-jb-work-"));
  try {
    const output = join(work, "new.ts");
    const launch = await launchJetBrainsMerge({
      ide: { id: "webstorm", name: "WebStorm", command: ide.command },
      outputPath: output,
      yours: "a\n",
      theirs: "b\n",
    });
    assert.equal(launch.ok, true);
    const { args } = parseLog(await waitFor(ide.log));
    assert.equal(args.length, 4);
    assert.equal(args[3], output);
    await launch.dispose();
  } finally {
    rmSync(ide.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("the reporter's rebase reaches the IDE the right way round: LOCAL is test's line", { skip: posixOnly }, async () => {
  const r = reporterRepo();
  const ide = fakeIde();
  try {
    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    const sides = await ctx.conflictOps.readSides("f.txt");
    const launch = await launchJetBrainsMerge({
      ide: { id: "webstorm", name: "WebStorm", command: ide.command },
      outputPath: join(r.root, "f.txt"),
      yours: sides.yours,
      theirs: sides.theirs,
      base: sides.hasBase ? sides.base : undefined,
    });
    const { files } = parseLog(await waitFor(ide.log));
    assert.equal(files[join(launch.tempDir!, "f.LOCAL.txt")].split("\n")[2], "three-test");
    assert.equal(files[join(launch.tempDir!, "f.REMOTE.txt")].split("\n")[2], "three-master");
    await launch.dispose();
  } finally {
    r.cleanup();
    rmSync(ide.dir, { recursive: true, force: true });
  }
});

test("diff: a text side becomes a temp file, a path side is passed as-is", { skip: posixOnly }, async () => {
  const ide = fakeIde();
  const work = mkdtempSync(join(tmpdir(), "gs-jb-work-"));
  try {
    const right = join(work, "f.txt");
    writeFileSync(right, "working\n");
    const launch = await launchJetBrainsDiff({
      ide: { id: "webstorm", name: "WebStorm", command: ide.command },
      left: { text: "head\n", name: "f.HEAD.txt" },
      right: { path: right },
    });
    assert.equal(launch.ok, true, launch.message);
    const { args, files } = parseLog(await waitFor(ide.log));
    assert.deepEqual(args, ["diff", join(launch.tempDir!, "f.HEAD.txt"), right]);
    assert.equal(files[join(launch.tempDir!, "f.HEAD.txt")], "head\n");
    await launch.dispose();
    assert.equal(existsSync(launch.tempDir!), false);
  } finally {
    rmSync(ide.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("a launcher that cannot start is reported, and leaves no temp files", async () => {
  const before = readdirSync(tmpdir()).filter((d) => d.startsWith("gitstudio-jbmerge-")).length;
  const launch = await launchJetBrainsMerge({
    ide: { id: "webstorm", name: "WebStorm", command: join(tmpdir(), "no-such-ide-here") },
    outputPath: join(tmpdir(), "f.txt"),
    yours: "a",
    theirs: "b",
  });
  assert.equal(launch.ok, false);
  assert.match(launch.message ?? "", /^Couldn't launch WebStorm — /);
  await launch.dispose();
  await new Promise((r) => setTimeout(r, 50));
  const after = readdirSync(tmpdir()).filter((d) => d.startsWith("gitstudio-jbmerge-")).length;
  assert.ok(after <= before, "the temp directory was removed");
});
