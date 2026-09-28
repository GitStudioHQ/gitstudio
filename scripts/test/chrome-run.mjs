// Running a headless Chrome from a test, and ending it — on every system.
//
// On Windows, Chrome's helpers (renderer, GPU, utility) inherit its stdout
// and stderr. Killing chrome.exe leaves them running, holding those pipes
// open, so a caller that waits for the pipes to close — execFile's callback
// does — waits forever, and a test file whose Chrome was "closed" cannot
// exit: the Windows CI leg hung for six hours on a different test each run.
// Here a run ends when Chrome itself exits (its output is complete by then),
// and a kill takes the whole process tree.

import { spawn, spawnSync } from "node:child_process";

/**
 * End a Chrome and everything it started. Windows: taskkill /T takes the
 * tree; elsewhere its helpers leave with it.
 * @param {import("node:child_process").ChildProcess} proc
 */
export function killChromeTree(proc) {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

/**
 * Run Chrome to the end — a --dump-dom page, say — and bring back its
 * stdout. Resolves when Chrome exits (or `timeout` ms pass: then it is
 * killed, tree and all, and `err` says so); never waits on pipes a helper
 * still holds.
 * @param {string} chrome
 * @param {readonly string[]} args
 * @param {{ timeout?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, err?: Error }>}
 */
export function runChrome(chrome, args, opts = {}) {
  const timeout = opts.timeout ?? 60_000;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const proc = spawn(chrome, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const errs = [];
    let size = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // What a helper still holds is not ours to wait for.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8"), err });
    };
    proc.stdout?.on("data", (d) => {
      size += d.length;
      if (size <= maxBuffer) out.push(d);
    });
    proc.stderr?.on("data", (d) => errs.push(d));
    proc.on("error", (e) => finish(e));
    // Its own output is written before it exits: give the pipe a moment to
    // drain, then stop. (A helper outliving it is let go: its tree is gone
    // with it, and its end of the pipe is closed on ours.)
    proc.on("exit", (code, signal) => {
      setTimeout(() => finish(code === 0 ? undefined : new Error(`chrome exited ${signal ?? code}`)), 250);
    });
    proc.on("close", (code, signal) => finish(code === 0 ? undefined : new Error(`chrome exited ${signal ?? code}`)));
    const timer = setTimeout(() => {
      killChromeTree(proc);
      finish(new Error(`chrome timed out after ${timeout}ms`));
    }, timeout);
  });
}
