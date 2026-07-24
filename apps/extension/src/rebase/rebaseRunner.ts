import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Drives a `git rebase -i` NON-INTERACTIVELY from a pre-composed plan — no
 * integrated terminal, no `code --wait`, no dependency on any editor CLI being
 * on PATH. This is what makes interactive rebase work identically in VS Code,
 * Cursor, and VSCodium (the old launcher hard-coded `code --wait` and silently
 * failed everywhere else).
 *
 * How it works: git invokes `$GIT_SEQUENCE_EDITOR <git-rebase-todo>` to let the
 * user edit the plan, and `$GIT_EDITOR <msg-file>` for each reword/squash
 * message. We point both at tiny Node installer scripts (run through the
 * extension host's own binary via ELECTRON_RUN_AS_NODE, so no external `node` is
 * needed) that non-interactively install our composed todo and reword messages.
 */
export interface RebasePlan {
  /** The base ref the rebase runs onto (exclusive), or "--root". */
  base: string;
  /** The full `git-rebase-todo` text to install (see engine serializeRebaseTodo). */
  todo: string;
  /** New commit messages for each `reword` row, in top-to-bottom todo order. */
  rewordMessages: string[];
}

export type RebaseOutcome =
  | { status: "done" }
  /** git stopped mid-rebase — a conflict, or an `edit` row. Needs the user. */
  | { status: "stopped"; reason: "conflict" | "edit" | "unknown"; message: string }
  | { status: "failed"; message: string };

const SEQ_INSTALLER = `const fs=require("fs");fs.writeFileSync(process.argv[process.argv.length-1],fs.readFileSync(process.env.GS_REBASE_TODO,"utf8"));`;

// The message installer: a squash group's combined message (git marks it with
// "# This is a combination of N commits.") is accepted as-is; a reword gets the
// next queued message. Rewords are 1:1 with editor calls and processed in todo
// order, so a simple queue index stays aligned.
const MSG_INSTALLER = `const fs=require("fs");const t=process.argv[process.argv.length-1];const c=fs.readFileSync(t,"utf8");
if(/^# This is a combination of \\d+ commits/m.test(c))process.exit(0);
try{const q=JSON.parse(fs.readFileSync(process.env.GS_REWORD_QUEUE,"utf8"));const sp=process.env.GS_REWORD_QUEUE+".idx";let i=0;try{i=parseInt(fs.readFileSync(sp,"utf8"),10)||0}catch(_){}
const m=q[i];if(typeof m==="string"&&m.trim())fs.writeFileSync(t,m.endsWith("\\n")?m:m+"\\n");fs.writeFileSync(sp,String(i+1));}catch(_){}
process.exit(0);`;

/** Run the composed plan. Resolves with the outcome; never throws for git errors. */
export async function runRebasePlan(
  root: string,
  plan: RebasePlan,
): Promise<RebaseOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstudio-rebase-"));
  const seqJs = path.join(dir, "seq.js");
  const msgJs = path.join(dir, "msg.js");
  const todoFile = path.join(dir, "todo");
  const rewordFile = path.join(dir, "reword.json");
  try {
    fs.writeFileSync(seqJs, SEQ_INSTALLER);
    fs.writeFileSync(msgJs, MSG_INSTALLER);
    fs.writeFileSync(todoFile, plan.todo);
    fs.writeFileSync(rewordFile, JSON.stringify(plan.rewordMessages ?? []));

    const exe = process.execPath;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_SEQUENCE_EDITOR: `"${exe}" "${seqJs}"`,
      GIT_EDITOR: `"${exe}" "${msgJs}"`,
      GS_REBASE_TODO: todoFile,
      GS_REWORD_QUEUE: rewordFile,
    };
    const args = ["rebase", "-i", plan.base];
    const { code, stderr, stdout } = await spawnGit(args, root, env);

    if (code === 0) {
      return { status: "done" };
    }
    const blob = `${stdout}\n${stderr}`;
    if (/could not apply|CONFLICT|Merge conflict|needs merge|fix conflicts/i.test(blob)) {
      return { status: "stopped", reason: "conflict", message: firstLine(stderr) || "Rebase paused on a conflict." };
    }
    if (/Stopped at .*edit|You can amend the commit now/i.test(blob)) {
      return { status: "stopped", reason: "edit", message: "Rebase paused for editing." };
    }
    // Still mid-rebase? Treat as a stop the user must resolve rather than a hard fail.
    if (await rebaseInProgress(root, env)) {
      return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
    }
    return { status: "failed", message: firstLine(stderr) || firstLine(stdout) || "Rebase failed." };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export async function continueRebase(root: string): Promise<RebaseOutcome> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  const { code, stderr, stdout } = await spawnGit(["rebase", "--continue"], root, env);
  if (code === 0) {
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr) || "Still conflicted." };
  }
  if (await rebaseInProgress(root, env)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
  }
  return { status: "failed", message: firstLine(stderr) || "Continue failed." };
}

/** `git rebase --abort`. */
export async function abortRebaseAt(root: string): Promise<boolean> {
  const { code } = await spawnGit(["rebase", "--abort"], root, { ...process.env, GIT_OPTIONAL_LOCKS: "0" });
  return code === 0;
}

async function rebaseInProgress(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await spawnGit(["status"], root, env);
  return /rebase in progress|interactive rebase in progress/i.test(stdout);
}

function firstLine(s: string): string {
  return (s || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** Spawn git directly (the shared pool can't carry per-call env). */
function spawnGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const gitPath = vscode.workspace.getConfiguration("git").get<string>("path") || "git";
    const child = spawn(gitPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
