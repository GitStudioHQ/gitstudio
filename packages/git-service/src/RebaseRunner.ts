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
  /** Positional form — see rebasePlan.ts. Kept for callers not yet migrated. */
  rewordMessages: string[];
  /** Reword messages keyed by commit. Preferred: a positional queue cannot
   *  survive a pause, and a persisted positional queue is actively dangerous. */
  rewords?: Array<{ sha: string; message: string }>;
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
/**
 * The message installer, run as GIT_EDITOR.
 *
 * It chooses the message BY SHA, read from git's own `rebase-merge/done` —
 * whose last line is the todo command currently executing, written before the
 * editor launches.
 *
 * It used to pop by CALL COUNT from an index sidecar. That is only correct
 * while nothing interrupts the run, and two things do:
 *
 *   · A pause. `git rebase --continue` opens the editor for the commit that
 *     stopped WHATEVER its verb — a conflicted `pick` gets an editor call too —
 *     so a counter handed it the next reword's text, putting a message on a
 *     commit nobody reworded and shifting every later one.
 *   · A queue that outlives its rebase. Keyed by position, a leftover queue
 *     applies to whatever rebase runs next; keyed by SHA it cannot, because a
 *     foreign rebase's shas are not in it. That property is what makes it safe
 *     to persist the queue at all, which is what fixes the pause.
 *
 * A squash group's combined message (git marks it "# This is a combination of
 * N commits.") is left alone, as before.
 */
const MSG_INSTALLER = `const fs=require("fs");const path=require("path");
const t=process.argv[process.argv.length-1];const c=fs.readFileSync(t,"utf8");
if(/^# This is a combination of \\d+ commits/m.test(c))process.exit(0);
try{
  const q=JSON.parse(fs.readFileSync(process.env.GS_REWORD_QUEUE,"utf8"));
  const gd=process.env.GS_GIT_DIR||"";
  let sha="";
  for(const d of ["rebase-merge","rebase-apply"]){
    try{
      const done=fs.readFileSync(path.join(gd,d,"done"),"utf8").split("\\n").filter(function(l){return l.trim()});
      const last=done[done.length-1]||"";
      const m=/^\\s*(?:[a-z-]+)\\s+([0-9a-fA-F]{4,40})\\b/.exec(last);
      if(m){sha=m[1];break;}
    }catch(_){}
  }
  if(sha){
    const hit=q.find(function(e){return e&&typeof e.sha==="string"&&(e.sha.startsWith(sha)||sha.startsWith(e.sha));});
    if(hit&&typeof hit.message==="string"&&hit.message.trim()){
      fs.writeFileSync(t,hit.message.endsWith("\\n")?hit.message:hit.message+"\\n");
    }
  }
}catch(_){}
process.exit(0);`;

/**
 * Where the reword queue and its installer live while a rebase is in flight.
 *
 * Inside `.git`, not a temp dir: the queue has to outlive the `git rebase -i`
 * process so that `--continue` after a conflict can still install the messages
 * the user typed. Before this they died with that process, and every reword
 * after the stop point committed with its ORIGINAL message while the app
 * reported success.
 *
 * `.git` and not os.tmpdir() because it is keyed to the repository by
 * construction, it is not shared between repos, and it goes away when the repo
 * does. Resolved through git so a worktree or submodule (where `.git` is a
 * FILE) lands in the right place.
 */
async function rewordPaths(
  root: string,
  opts: RebaseRunOptions,
): Promise<{ dir: string; queue: string; installer: string } | undefined> {
  const { code, stdout } = await spawnGit(
    ["rev-parse", "--absolute-git-dir"],
    root,
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    opts,
  );
  const dir = stdout.trim();
  if (code !== 0 || !dir) return undefined;
  return {
    dir,
    queue: path.join(dir, "gitstudio-reword-queue.json"),
    installer: path.join(dir, "gitstudio-reword-msg.js"),
  };
}

/**
 * Forget the queue. Safe to call when there is none.
 *
 * Synchronous on purpose: this runs on the paths that report the rebase
 * FINISHED, and "finished" has to mean the queue is already gone — not that a
 * callback will get to it. Errors are swallowed; failing to delete scratch
 * state is not a result the caller can act on.
 */
function clearRewordQueue(p: { queue: string; installer: string } | undefined): void {
  if (!p) return;
  for (const f of [p.queue, p.installer]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* nothing to do about it */
    }
  }
}

/**
 * The environment a `--continue` / `--skip` needs so the remaining rewords are
 * still installed. Returns the plain env when there is no queue to honour.
 */
async function resumeEnv(
  root: string,
  opts: RebaseRunOptions,
): Promise<{ env: NodeJS.ProcessEnv; paths?: { dir: string; queue: string; installer: string } }> {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
  const paths = await rewordPaths(root, opts);
  if (!paths || !fs.existsSync(paths.queue) || !fs.existsSync(paths.installer)) {
    return { env: base };
  }
  const exe = opts.nodePath ?? process.execPath;
  return {
    paths,
    env: {
      ...base,
      ELECTRON_RUN_AS_NODE: "1",
      GIT_EDITOR: `${shQuote(exe)} ${shQuote(paths.installer)}`,
      GS_REWORD_QUEUE: paths.queue,
      GS_GIT_DIR: paths.dir,
    },
  };
}

/** Run the composed plan. Resolves with the outcome; never throws for git errors. */
export async function runRebasePlan(
  root: string,
  plan: RebasePlan,
  opts: RebaseRunOptions = {},
): Promise<RebaseOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstudio-rebase-"));
  const seqJs = path.join(dir, "seq.js");
  const todoFile = path.join(dir, "todo");
  // The reword queue and its installer live in `.git`, NOT here: they have to
  // outlive this process so `--continue` after a conflict can still install the
  // messages the user typed. See rewordPaths.
  const rw = await rewordPaths(root, opts);
  const rewords =
    plan.rewords ?? (plan.rewordMessages ?? []).map((message) => ({ sha: "", message }));
  const msgJs = rw?.installer ?? path.join(dir, "msg.js");
  const rewordFile = rw?.queue ?? path.join(dir, "reword.json");
  try {
    fs.writeFileSync(seqJs, SEQ_INSTALLER);
    fs.writeFileSync(msgJs, MSG_INSTALLER);
    fs.writeFileSync(todoFile, plan.todo);
    fs.writeFileSync(rewordFile, JSON.stringify(rewords));

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
      // The installer reads `<git-dir>/rebase-merge/done` to learn WHICH commit
      // git is asking about.
      GS_GIT_DIR: rw?.dir ?? "",
    };
    const args = ["rebase", "-i", plan.base];
    const { code, stderr, stdout } = await spawnGit(args, root, env, opts);

    if (code === 0) {
      clearRewordQueue(rw);
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
    // A hard failure ends the rebase; a STOP does not, and its queue must
    // survive for the `--continue` that follows.
    clearRewordQueue(rw);
    return { status: "failed", message: firstLine(stderr) || firstLine(stdout) || "Rebase failed." };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export async function continueRebase(root: string, opts: RebaseRunOptions = {}): Promise<RebaseOutcome> {
  // GIT_EDITOR was "true" here — a no-op — so every reword AFTER the stop point
  // committed with its original message, and the app said "Rebase continued."
  const { env, paths } = await resumeEnv(root, opts);
  const { code, stderr, stdout } = await spawnGit(["rebase", "--continue"], root, env, opts);
  if (code === 0) {
    clearRewordQueue(paths);
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr) || "Still conflicted." };
  }
  if (await rebaseInProgress(root, env, opts)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
  }
  clearRewordQueue(paths);
  return { status: "failed", message: firstLine(stderr) || "Continue failed." };
}

/**
 * `git rebase --skip`, honouring any remaining rewords for the same reason
 * `--continue` does: skipping one commit does not make the messages queued for
 * the ones after it disappear.
 */
export async function skipRebase(root: string, opts: RebaseRunOptions = {}): Promise<RebaseOutcome> {
  const { env, paths } = await resumeEnv(root, opts);
  const { code, stderr, stdout } = await spawnGit(["rebase", "--skip"], root, env, opts);
  if (code === 0) {
    clearRewordQueue(paths);
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr) || "Still conflicted." };
  }
  if (await rebaseInProgress(root, env, opts)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr) || "Rebase paused." };
  }
  clearRewordQueue(paths);
  return { status: "failed", message: firstLine(stderr) || "Skip failed." };
}

/** `git rebase --abort`. */
export async function abortRebaseAt(root: string, opts: RebaseRunOptions = {}): Promise<boolean> {
  const { code } = await spawnGit(
    ["rebase", "--abort"],
    root,
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    opts,
  );
  // The plan is gone; so are the messages composed for it. (Keying by SHA means
  // a queue left behind by some path that does not reach here is inert rather
  // than dangerous — but leaving litter in `.git` is still litter.)
  clearRewordQueue(await rewordPaths(root, opts));
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

/**
 * The line worth showing the user out of git's output.
 *
 * Not literally the first one. git writes rebase progress to stderr as
 * carriage-return-separated "Rebasing (1/4)" updates, so a naive first line
 * reported "Successfully rebased and updated refs/heads/main." as the message
 * of a FAILED rebase — the reassuring half of output that also contained
 * "error: update_ref failed ... cannot lock ref".
 *
 * So: split on CR as well as LF, prefer a line that announces a problem, and
 * fall back to the first line that is not progress noise.
 */
function firstLine(s: string): string {
  const lines = (s || "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const problem = lines.find((l) =>
    /^(error|fatal|warning):|could not|cannot |failed to|CONFLICT/i.test(l),
  );
  if (problem) {
    return problem;
  }
  return lines.find((l) => !/^Rebasing \(\d+\/\d+\)$/.test(l)) ?? "";
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
