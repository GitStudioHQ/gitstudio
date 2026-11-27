// The login-shell PATH probe (launcher.ts), against stand-in shells: small
// /bin/sh scripts in a temp folder that behave like the rc files that broke
// it. Never the developer's own shell, and never their rc files.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptForAWhile, probeShellPath, shellFlags } from "../src/main/launcher";

const posixOnly = process.platform === "win32" && "a POSIX login shell is a macOS/Linux matter";
const dir = mkdtempSync(join(tmpdir(), "gs-shell-probe-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in shell: `body` runs first, then the probe's own script (the last argument). */
function shell(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nfor a; do s="$a"; done\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const ENV = { PATH: "/gs-probe/bin:/usr/bin:/bin", HOME: dir };

async function until(cond: () => boolean, what: string, capMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("csh and tcsh are not asked for -l beside -c, which they refuse", () => {
  assert.deepEqual(shellFlags("/bin/tcsh"), ["-i", "-c"]);
  assert.deepEqual(shellFlags("/usr/local/bin/csh"), ["-i", "-c"]);
  assert.deepEqual(shellFlags("/bin/zsh"), ["-i", "-l", "-c"]);
  assert.deepEqual(shellFlags("/opt/homebrew/bin/fish"), ["-i", "-l", "-c"]);
});

test("the PATH is the answer the moment it arrives, whatever the rc file left running", { skip: posixOnly }, async () => {
  // A background job holding stdout kept the probe waiting out its whole
  // timeout though the answer had already come.
  const sh = shell("zsh", '( sleep 3; echo late ) &\nsh -c "$s"');
  const start = Date.now();
  const path = await probeShellPath(sh, ENV, "darwin", 8_000);
  assert.deepEqual(path, ["/gs-probe/bin", "/usr/bin", "/bin"]);
  assert.ok(Date.now() - start < 2_500, `answered in ${Date.now() - start} ms`);
});

test("an rc file that asks a question reads end-of-file instead of hanging", { skip: posixOnly }, async () => {
  const sh = shell("bash", 'read -r answer\nsh -c "$s"');
  const start = Date.now();
  assert.deepEqual(await probeShellPath(sh, ENV, "linux", 8_000), ["/gs-probe/bin", "/usr/bin", "/bin"]);
  assert.ok(Date.now() - start < 2_500);
});

test("a shell that hangs is given up on, and what its rc file started goes with it", { skip: posixOnly }, async () => {
  const pidFile = join(dir, "rc-child.pid");
  const sh = shell("hangs", `sleep 30 &\necho $! > "${pidFile}"\nwait`);
  const path = await probeShellPath(sh, ENV, "darwin", 600);
  assert.deepEqual(path, [], "no answer");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await until(() => !alive(pid), "the rc file's child to be killed with the shell");
});

test("a csh-family shell gets the flags it accepts, and answers", { skip: posixOnly }, async () => {
  const sh = shell("tcsh", 'for a; do [ "$a" = "-l" ] && { echo "Unknown option: -l" >&2; exit 1; }; done\nsh -c "$s"');
  assert.deepEqual(await probeShellPath(sh, ENV, "darwin", 8_000), ["/gs-probe/bin", "/usr/bin", "/bin"]);
});

test("review #162: the login shell's PATH is asked again after an empty answer, and after a while", async () => {
  const answers: string[][] = [[], ["/gs-probe/nvm/bin"], ["/gs-probe/new/bin"]];
  let asked = 0;
  let clock = 0;
  const fresh = keptForAWhile(async () => answers[asked++] ?? [], 60_000, () => clock);
  assert.deepEqual(await fresh(), [], "a cold shell that timed out says nothing");
  assert.deepEqual(await fresh(), ["/gs-probe/nvm/bin"], "so the next lookup asks again");
  assert.deepEqual(await fresh(), ["/gs-probe/nvm/bin"], "an answer is kept");
  assert.equal(asked, 2);
  clock += 60_000;
  assert.deepEqual(await fresh(), ["/gs-probe/new/bin"], "for a while, not for good");
  // a lookup that throws is an empty answer, not a rejected one, and not kept
  let threw = 0;
  const failing = keptForAWhile(async () => {
    if (threw++ === 0) throw new Error("reg failed");
    return ["C:\\gs-probe"];
  });
  assert.deepEqual(await failing(), []);
  assert.deepEqual(await failing(), ["C:\\gs-probe"]);
});
