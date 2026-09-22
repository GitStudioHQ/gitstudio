// Stage a resolved file, and say so only when git actually did.
//
// `GitProcess.run` never throws on a non-zero exit — it resolves with the code
// (memory: desktop-updates-and-clipboard). The GitStudio merge editor used to
// `await run(["add", …])` inside a try and then set `staged = true`, so a
// refused `git add` (a stale index.lock, a path git will not add) was reported
// as "resolved file saved and staged" while the file stayed unmerged
// (PLAN matrix row 21). The exit code is the whole answer.

/** All this needs from a GitProcess. */
export interface GitRunner {
  run(args: string[]): Promise<{ code: number; stderr: string }>;
}

export interface StageResult {
  staged: boolean;
  /** Plain words for why it was not staged. Absent when it was. */
  message?: string;
}

/** `git add -- <rel>` with the exit code checked. Never throws for a git refusal. */
export async function stageResolvedPath(proc: GitRunner, rel: string): Promise<StageResult> {
  let r: { code: number; stderr: string };
  try {
    r = await proc.run(["add", "--", rel]);
  } catch (error) {
    return { staged: false, message: stagingFailed(error instanceof Error ? error.message : String(error)) };
  }
  if (r.code === 0) {
    return { staged: true };
  }
  return { staged: false, message: stagingFailed(firstLine(r.stderr) || `git add exited with ${r.code}`) };
}

function stagingFailed(reason: string): string {
  return `The file is saved, but git could not stage it (${reason}). Stage it with git add before you continue.`;
}

/** git's first non-empty line, without the "fatal: " / "error: " prefix. */
export function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").replace(/^(fatal|error|warning|hint):\s*/i, "");
}
