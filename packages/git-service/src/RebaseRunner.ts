import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Drives a `git rebase -i` NON-INTERACTIVELY from a pre-composed plan — no
 * integrated terminal, no `code --wait`, no dependency on any editor CLI being
 * on PATH. This is what makes interactive rebase work identically in the VS Code
 * extension (VS Code, Cursor, VSCodium) and in the desktop app.
 *
 * How it works: git invokes `$GIT_SEQUENCE_EDITOR <git-rebase-todo>` to let the
 * user edit the plan, and `$GIT_EDITOR <msg-file>` for each reword/squash
 * message. We point both at tiny Node installer scripts (run through the host's
 * own binary via ELECTRON_RUN_AS_NODE, so no external `node` is needed) that
 * non-interactively install our composed todo and reword messages.
 *
 * Host-agnostic: the git executable is injected, so nothing here imports vscode
 * or electron.
 */
export interface RebasePlan {
  /** The base ref the rebase runs onto (exclusive), or "--root". */
  base: string;
  /** The full `git-rebase-todo` text to install (see engine serializeRebaseTodo). */
  todo: string;
  /** New commit messages for each `reword` row, in top-to-bottom todo order. */
  rewordMessages: string[];
}

export interface RebaseRunOptions {
  /** The git executable (default "git"). */
  gitPath?: string;
  /**
   * The binary used to run the tiny installer scripts. Defaults to the current
   * process (Electron/extension host) with ELECTRON_RUN_AS_NODE=1.
   */
  nodePath?: string;
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
  opts: RebaseRunOptions = {},
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

    const exe = opts.nodePath ?? process.execPath;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      // git runs these through `sh -c`. Double quotes leave $, ` and \ special,
      // so an install path containing e.g. $(id) would EXECUTE when git launches
      // the sequence editor. Single-quote instead — nothing is special inside
      // single quotes, and an embedded quote is closed/escaped/reopened.
      GIT_SEQUENCE_EDITOR: `${shQuote(exe)} ${shQuote(seqJs)}`,
      GIT_EDITOR: `${shQuote(exe)} ${shQuote(msgJs)}`,
      GS_REBASE_TODO: todoFile,
      GS_REWORD_QUEUE: rewordFile,
    };
    const args = ["rebase", "-i", plan.base];
    const { code, stderr, stdout } = await spawnGit(args, root, env, opts);

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
    if (await rebaseInProgress(root, env, opts)) {
      return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
    }
    return { status: "failed", message: firstLine(stderr) || firstLine(stdout) || "Rebase failed." };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export async function continueRebase(root: string, opts: RebaseRunOptions = {}): Promise<RebaseOutcome> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  const { code, stderr, stdout } = await spawnGit(["rebase", "--continue"], root, env, opts);
  if (code === 0) {
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr) || "Still conflicted." };
  }
  if (await rebaseInProgress(root, env, opts)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
  }
  return { status: "failed", message: firstLine(stderr) || "Continue failed." };
}

/** `git rebase --abort`. */
export async function abortRebaseAt(root: string, opts: RebaseRunOptions = {}): Promise<boolean> {
  const { code } = await spawnGit(
    ["rebase", "--abort"],
    root,
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    opts,
  );
  return code === 0;
}

/** True while a rebase is mid-flight (conflict or `edit` stop) in this repo. */
export async function isRebaseInProgress(root: string, opts: RebaseRunOptions = {}): Promise<boolean> {
  return rebaseInProgress(root, { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, opts);
}

async function rebaseInProgress(
  root: string,
  env: NodeJS.ProcessEnv,
  opts: RebaseRunOptions,
): Promise<boolean> {
  const { stdout } = await spawnGit(["status"], root, env, opts);
  return /rebase in progress|interactive rebase in progress/i.test(stdout);
}

function firstLine(s: string): string {
  return (s || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** Spawn git directly (the shared pool can't carry per-call env). */
/** Milliseconds before a single git step is considered wedged and killed. */
const GIT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * POSIX single-quote a string for a `sh -c` command line. Nothing is special
 * inside single quotes, so this is safe for any path; an embedded quote is
 * emitted as '\'' (close, escaped quote, reopen).
 */
function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function spawnGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: RebaseRunOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // stdin is IGNORED, not inherited/piped. A rebase re-signs commits and may
    // hit a credential helper; with an open stdin git blocks on the prompt
    // forever and this promise never settles, wedging the whole rebase with no
    // way out. Closed stdin + GIT_TERMINAL_PROMPT=0 makes git fail fast instead.
    const child = spawn(opts.gitPath || "git", args, {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { code: number | null; stdout: string; stderr: string }): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Backstop for anything that still wedges (a pinentry GUI nobody answers,
    // a wired-open network fetch). Generous enough not to kill a real rebase.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: null,
        stdout,
        stderr:
          stderr +
          `\ngit timed out after ${Math.round(GIT_STEP_TIMEOUT_MS / 1000)}s and was terminated.`,
      });
    }, GIT_STEP_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ code: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}
