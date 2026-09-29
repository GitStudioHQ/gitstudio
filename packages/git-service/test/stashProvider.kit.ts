// Shared by the stashProvider.* / stashRestore.* / conflictOps.* /
// changesInTheWay.* coverage tests: a GitProcess that runs real git but lets a
// test answer chosen commands itself — the one way to reach the "git could not
// say" and "git refused" branches real git will not produce on demand.

import { GitProcess, type GitRunResult } from "../src/GitProcess";

export type Answer = GitRunResult | undefined;

/** A rule sees the argv (and stdin, when there is one); a result replaces git's, undefined runs git. */
export type Rule = (args: string[], input?: string) => Answer | Promise<Answer>;

export interface Tapped {
  proc: GitProcess;
  /** Every argv asked for, in order (answered by a rule or by git). */
  ran: string[][];
  dispose(): void;
}

/** A process over `cwd` whose commands go through `rule` first. With no `cwd`, every command must be answered. */
export function tap(cwd: string | undefined, rule: Rule): Tapped {
  const real = cwd ? new GitProcess({ cwd }) : undefined;
  const ran: string[][] = [];
  const proc = {
    // Read by the operation core (stoppedIn), which resolves git paths against it.
    cwd: cwd ?? "",
    run: async (args: string[], opts?: { signal?: AbortSignal; input?: string; env?: Record<string, string> }) => {
      ran.push(args);
      const canned = await rule(args, opts?.input);
      if (canned) return canned;
      if (!real) throw new Error(`unanswered git ${args.join(" ")}`);
      return real.run(args, opts);
    },
  } as unknown as GitProcess;
  return { proc, ran, dispose: () => real?.dispose() };
}

export const ok = (stdout = ""): GitRunResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "fatal: refused", code = 1): GitRunResult => ({ code, stdout: "", stderr });

/** The argv as one string, for matching. */
export const cmd = (args: readonly string[]): string => args.join(" ");
