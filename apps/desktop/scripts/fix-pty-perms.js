// Restore the executable bit on node-pty's Unix `spawn-helper` after install.
//
// node-pty's published prebuilds ship `spawn-helper` (a tiny Mach-O/ELF binary
// node-pty execs via posix_spawn to fork the PTY). Depending on the package
// manager / hoisting, npm can extract it WITHOUT the execute bit — and then the
// first `pty.spawn()` fails with the opaque "posix_spawnp failed.", which the
// integrated terminal surfaces as "Could not start a terminal session."
//
// This runs as a `postinstall` hook so the bit is restored on every install,
// for both `npm run dev` and the file electron-builder copies into the packaged
// app (asarUnpack keeps node-pty out of the asar, preserving these perms). It's
// a no-op on Windows (ConPTY/winpty need no helper) and tolerant of node-pty not
// being installed yet.

const fs = require("fs");
const path = require("path");

if (process.platform === "win32") process.exit(0);

/** Locate the installed node-pty package dir, tolerating workspace hoisting. */
function findNodePty() {
  try {
    // Resolves through the same algorithm the app uses at runtime.
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    // Fallbacks for the hoisted (repo-root) and local layouts.
    for (const rel of ["../../../node_modules/node-pty", "../node_modules/node-pty"]) {
      const dir = path.resolve(__dirname, rel);
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    }
    return undefined;
  }
}

const ptyDir = findNodePty();
if (!ptyDir) {
  // Nothing to fix (e.g. deps not installed yet); don't fail the install.
  process.exit(0);
}

// Every place node-pty may load the helper from: each prebuilt platform dir and
// a from-source build. We chmod whatever exists rather than guessing the host.
const prebuilds = path.join(ptyDir, "prebuilds");
const candidates = [];
if (fs.existsSync(prebuilds)) {
  for (const entry of fs.readdirSync(prebuilds)) {
    candidates.push(path.join(prebuilds, entry, "spawn-helper"));
  }
}
candidates.push(path.join(ptyDir, "build", "Release", "spawn-helper"));
candidates.push(path.join(ptyDir, "build", "Debug", "spawn-helper"));

let fixed = 0;
for (const helper of candidates) {
  if (!fs.existsSync(helper)) continue;
  try {
    fs.chmodSync(helper, 0o755);
    fixed++;
  } catch (err) {
    console.warn(`[fix-pty-perms] could not chmod ${helper}: ${err.message}`);
  }
}

if (fixed > 0) {
  console.log(`[fix-pty-perms] made ${fixed} node-pty spawn-helper binary(ies) executable`);
}
