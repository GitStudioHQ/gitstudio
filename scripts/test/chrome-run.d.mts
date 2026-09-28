// Types for chrome-run.mjs, for the TypeScript launchers and tests that import it.

import type { ChildProcess } from "node:child_process";

/** End a Chrome and everything it started (Windows: its whole process tree). */
export declare function killChromeTree(proc: ChildProcess): void;
/**
 * Run Chrome to the end and bring back its stdout; resolves when Chrome exits
 * (or `timeout` ms pass: then it is killed, tree and all, and `err` says so).
 */
export declare function runChrome(
  chrome: string,
  args: readonly string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string; err?: Error }>;
