import { spawn } from "node:child_process";
import { auditSpawn } from "./spawnAudit";
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
  /**
   * New commit messages, keyed by the commit each belongs to.
   *
   * REQUIRED, and there is deliberately no positional alternative. A `rewords?`
   * that fell back to a bare list left the extension on the old shape while the
   * installer had moved to sha lookup — and the shim minted `{sha: ""}`, which
   * `startsWith("")` matches for EVERY commit: every reword got the first
   * message and commits nobody reworded were renamed. An optional field is how
   * a half-done migration hides from the compiler.
   */
  rewords: Array<{ sha: string; message: string }>;
}

export interface RebaseRunOptions {
  /** The git executable (default "git"). */
  gitPath?: string;
  /**
   * Observer for each git invocation this runner makes, so the host can show
   * them wherever it shows its other git commands.
   *
   * Without it a rebase's commands are invisible to the desktop's Output tab —
   * the surface the app itself calls "what the user reads, copies and pastes
   * into bug reports". A `rebase --continue` that fails then leaves nothing
   * anywhere: git's explanation of which paths still need `git add` reaches a
   * one-line toast and is then unrecoverable.
   */
  onRun?: (event: {
    args: string[];
    durationMs: number;
    exitCode: number | null;
    failed: boolean;
    stderr?: string;
  }) => void;
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
 *
 * An entry must carry a REAL key (>= 4 hex chars). `"".startsWith("")` is true
 * and so is `anySha.startsWith("")`, so an unkeyed entry matches every commit
 * there is — which turned a compatibility shim into a wildcard that renamed
 * commits nobody had reworded.
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
    const hit=q.find(function(e){return e&&typeof e.sha==="string"&&e.sha.length>=4&&(e.sha.startsWith(sha)||sha.startsWith(e.sha));});
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
 * git's own state directory for the rebase in progress, or undefined.
 *
 * This is where the queue LIVES once a rebase has paused — and it is the whole
 * fence. git creates this directory when a rebase starts and deletes it when
 * the rebase ends, however it ends and whoever ends it: `--abort` from a
 * terminal, the extension's own abort command, `--quit`, completion. Anything
 * inside it has exactly the rebase's lifetime, enforced by git.
 *
 * The previous attempt STAMPED the queue with `onto` + `orig-head` and compared
 * on resume. That does not fence, because an abort RESTORES those values: the
 * next rebase of the same branch onto the same base produces a byte-identical
 * stamp, so an abandoned draft matched perfectly. Measured, with the stamp in
 * place: "FINAL log: ABANDONED-DRAFT | m2 | m1". A lifetime we try to describe
 * is a lifetime we get wrong; a lifetime git already manages is free.
 */
function rebaseStateDir(gitDir: string): string | undefined {
  const merge = path.join(gitDir, "rebase-merge");
  try {
    if (fs.statSync(merge).isDirectory()) return merge;
  } catch {
    /* not the merge backend */
  }
  // `rebase-apply` is NOT only a rebase. `git am` uses the same directory, and
  // git tells them apart by a marker file inside it: `applying` for am,
  // `rebasing` for a rebase on the apply backend. Treating the directory alone
  // as proof reported an interrupted `git am` as a paused rebase, and every
  // control the app then offered — Continue, Skip, Abort — runs `git rebase`,
  // which refuses. (The prose check this replaced got that right by accident:
  // git says "You are in the middle of an am session", which never matched.)
  const apply = path.join(gitDir, "rebase-apply");
  try {
    if (fs.statSync(apply).isDirectory() && !fs.existsSync(path.join(apply, "applying"))) {
      return apply;
    }
  } catch {
    /* not the apply backend either */
  }
  return undefined;
}

/** Where a PAUSED rebase's queue and installer live: inside git's state dir. */
function pausedPaths(
  gitDir: string,
): { dir: string; queue: string; installer: string } | undefined {
  const state = rebaseStateDir(gitDir);
  if (!state) return undefined;
  return {
    dir: gitDir,
    queue: path.join(state, "gitstudio-reword-queue.json"),
    installer: path.join(state, "gitstudio-reword-msg.js"),
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
  for (const f of [p.queue, charPath(p.queue), p.installer]) {
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
): Promise<{
  env: NodeJS.ProcessEnv;
  paths?: { dir: string; queue: string; installer: string };
  commentChar: string;
}> {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
  const git = await rewordPaths(root, opts);
  // ONLY from inside git's own rebase state directory. That location is the
  // fence: git deletes the directory when the rebase ends, however it ends and
  // whoever ends it, so a queue there cannot outlive its rebase and cannot be
  // seen by the next one. Nothing here has to guess a lifetime.
  const paths = git && pausedPaths(git.dir);
  if (!paths || !fs.existsSync(paths.queue) || !fs.existsSync(paths.installer)) {
    return { env: base, commentChar: "#" };
  }
  const exe = opts.nodePath ?? process.execPath;
  let commentChar = "#";
  try {
    const c = fs.readFileSync(charPath(paths.queue), "utf8").trim();
    if (c.length === 1) commentChar = c;
  } catch {
    /* an older queue, or none — the default is right for ordinary messages */
  }
  return {
    paths,
    commentChar,
    env: {
      ...base,
      ELECTRON_RUN_AS_NODE: "1",
      GIT_EDITOR: `${shQuote(exe)} ${shQuote(paths.installer)}`,
      GS_REWORD_QUEUE: paths.queue,
      GS_GIT_DIR: paths.dir,
    },
  };
}

/**
 * Config every rebase invocation carries.
 *
 * `core.commentChar=auto` because the user's reword message goes to git through
 * the EDITOR channel, where `--cleanup=default` strips every line that begins
 * with the comment character. A body line like `#123` was deleted from the
 * stored message without a word, and a message that STARTS with one became
 * empty — which git treats as "abort this commit", wedging the rebase. `auto`
 * makes git pick a character that begins no line in the message, so nothing of
 * the user's is a comment.
 *
 * NOT `commit.cleanup=whitespace`: MSG_INSTALLER deliberately leaves a squash
 * group's combined message alone, and that message is git's own boilerplate,
 * which only `cleanup=default` strips. Changing the character moves git's
 * boilerplate with it; changing the cleanup mode leaves the boilerplate in the
 * commit.
 */
function rebaseConfig(commentChar: string): string[] {
  return ["-c", `core.commentChar=${commentChar}`];
}

/** Where the chosen comment character is remembered for `--continue`/`--skip`. */
function charPath(queue: string): string {
  return queue + ".commentchar";
}

/**
 * A comment character that begins no line in any message we are about to
 * install.
 *
 * `auto` is not enough: git chooses when it PREPARES the message file, from the
 * text that is in it then — and MSG_INSTALLER overwrites that file afterwards.
 * So git decided on `#` from the ORIGINAL message and stripped the user's `#`
 * lines from ours. We know every message up front, so choose from those.
 *
 * Falls back to `#`, which is no worse than not trying.
 */
function pickCommentChar(messages: readonly string[]): string {
  const starts = new Set<string>();
  for (const m of messages) {
    for (const line of m.split("\n")) {
      const c = line.trimStart()[0];
      if (c) starts.add(c);
    }
  }
  for (const c of [";", "@", "!", "$", "%", "^", "&", "*", "+", "=", "~", "|", ":", "?"]) {
    if (!starts.has(c)) return c;
  }
  return "#";
}

/** Run the composed plan. Resolves with the outcome; never throws for git errors. */
export async function runRebasePlan(
  root: string,
  plan: RebasePlan,
  opts: RebaseRunOptions = {},
): Promise<RebaseOutcome> {
  // Refuse BEFORE writing anything.
  //
  // git will refuse this run itself ("there is already a rebase-merge
  // directory") — but only after we have already written the new plan's reword
  // queue, and the pause path then handed that queue to the rebase ALREADY in
  // flight, overwriting the messages the user actually typed. Measured: a
  // second plan that git never started still renamed the commit —
  // "FINAL log: SECOND-DRAFT | m2 | m1" — while the outcome shown was git's
  // "It seems that there is already a rebase-merge directory", which reads as
  // "nothing happened".
  if (await rebaseInProgress(root, { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, opts)) {
    return {
      status: "failed",
      message: "A rebase is already in progress — continue or abort it before starting another.",
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstudio-rebase-"));
  const seqJs = path.join(dir, "seq.js");
  const todoFile = path.join(dir, "todo");
  // The reword queue and its installer live in `.git`, NOT here: they have to
  // outlive this process so `--continue` after a conflict can still install the
  // messages the user typed. See rewordPaths.
  const rw = await rewordPaths(root, opts);
  const rewords = plan.rewords;
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
    // Chosen from the messages this run will install, and remembered for the
    // `--continue` that may follow.
    const commentChar = pickCommentChar(rewords.map((r) => r.message));
    if (rw) {
      try {
        fs.writeFileSync(charPath(rewordFile), commentChar);
      } catch {
        /* the default is still correct for messages with no leading hash */
      }
    }
    const args = [...rebaseConfig(commentChar), "rebase", "-i", plan.base];
    const { code, stderr, stdout } = await spawnGit(args, root, env, opts);

    /**
     * A pause, not an ending.
     *
     * Hand the queue to GIT to look after: moved inside `rebase-merge/`, it
     * lives exactly as long as the rebase does, and an abort from anywhere —
     * a terminal, the extension, `--quit` — takes it with the directory. That
     * is the whole fence; there is nothing for us to stamp or compare.
     */
    const paused = (
      reason: "conflict" | "edit" | "unknown",
      message: string,
    ): RebaseOutcome => {
      const inRebase = rw && pausedPaths(rw.dir);
      if (rw && inRebase) {
        try {
          fs.renameSync(rw.queue, inRebase.queue);
          fs.renameSync(rw.installer, inRebase.installer);
        } catch {
          // Could not hand it over — then do NOT leave it lying in .git, where
          // the next rebase of this branch would find it.
          clearRewordQueue(rw);
        }
      } else {
        clearRewordQueue(rw);
      }
      return { status: "stopped", reason, message };
    };

    if (code === 0) {
      // Exit 0 is NOT the same as finished. `git rebase -i` exits 0 when it
      // stops at an `edit` row — the user asked for that pause — and taking it
      // as "done" toasted "Rebase complete." over a detached, mid-rebase repo
      // AND deleted the queue this whole mechanism exists to preserve, so every
      // reword below the `edit` row then committed with its original message.
      if (await rebaseInProgress(root, env, opts)) {
        return paused("edit", "Rebase paused for editing.");
      }
      clearRewordQueue(rw);
      return { status: "done" };
    }
    const blob = `${stdout}\n${stderr}`;
    if (/could not apply|CONFLICT|Merge conflict|needs merge|fix conflicts/i.test(blob)) {
      return paused("conflict", firstLine(stderr, stdout) || "Rebase paused on a conflict.");
    }
    // No `Stopped at .*edit` branch here on purpose.
    //
    // "You can amend the commit now" is the generic hint git prints after ANY
    // failed commit during a rebase — a `commit-msg` hook rejecting the
    // message, an empty message, a failed GPG sign. Matching it reported every
    // one of those as "Rebase paused for editing." and threw away git's own
    // explanation, which is the only thing that says what to fix. The guard
    // below already answers correctly: it reports a stop only when a rebase is
    // genuinely live, and carries git's words when it does.
    // Still mid-rebase? Treat as a stop the user must resolve rather than a hard fail.
    if (await rebaseInProgress(root, env, opts)) {
      return paused("unknown", firstLine(stderr, stdout) || "Rebase paused.");
    }
    // A hard failure ends the rebase; a STOP does not, and its queue must
    // survive for the `--continue` that follows.
    clearRewordQueue(rw);
    return { status: "failed", message: firstLine(stderr, stdout) || "Rebase failed." };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export async function continueRebase(root: string, opts: RebaseRunOptions = {}): Promise<RebaseOutcome> {
  // GIT_EDITOR was "true" here — a no-op — so every reword AFTER the stop point
  // committed with its original message, and the app said "Rebase continued."
  const { env, paths, commentChar } = await resumeEnv(root, opts);
  const { code, stderr, stdout } = await spawnGit([...rebaseConfig(commentChar), "rebase", "--continue"], root, env, opts);
  if (code === 0) {
    // Exit 0 with a rebase still in flight is the next `edit` stop, not the end
    // — and clearing the queue there would drop every reword below it.
    if (await rebaseInProgress(root, env, opts)) {
      return { status: "stopped", reason: "edit", message: "Rebase paused for editing." };
    }
    clearRewordQueue(paths);
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr, stdout) || "The rebase is still stopped." };
  }
  if (await rebaseInProgress(root, env, opts)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr, stdout) || "Rebase paused." };
  }
  clearRewordQueue(paths);
  return { status: "failed", message: firstLine(stderr, stdout) || "Continue failed." };
}

/**
 * `git rebase --skip`, honouring any remaining rewords for the same reason
 * `--continue` does: skipping one commit does not make the messages queued for
 * the ones after it disappear.
 */
export async function skipRebase(root: string, opts: RebaseRunOptions = {}): Promise<RebaseOutcome> {
  const { env, paths, commentChar } = await resumeEnv(root, opts);
  const { code, stderr, stdout } = await spawnGit([...rebaseConfig(commentChar), "rebase", "--skip"], root, env, opts);
  if (code === 0) {
    if (await rebaseInProgress(root, env, opts)) {
      return { status: "stopped", reason: "edit", message: "Rebase paused for editing." };
    }
    clearRewordQueue(paths);
    return { status: "done" };
  }
  const blob = `${stdout}\n${stderr}`;
  if (/could not apply|CONFLICT|needs merge/i.test(blob)) {
    return { status: "stopped", reason: "conflict", message: firstLine(stderr, stdout) || "The rebase is still stopped." };
  }
  if (await rebaseInProgress(root, env, opts)) {
    return { status: "stopped", reason: "unknown", message: firstLine(stderr, stdout) || "Rebase paused." };
  }
  clearRewordQueue(paths);
  return { status: "failed", message: firstLine(stderr, stdout) || "Skip failed." };
}

/** `git rebase --abort`. */
/**
 * Abort, reporting WHY when it fails.
 *
 * `abortRebaseAt` answers a bare boolean, so the caller had nothing to show but
 * a canned "Couldn't abort the rebase." — while git's own explanation (a locked
 * index, an unmerged path it will not discard) was thrown away. That is the
 * same laundering this codebase has fixed in three other places.
 */
export async function abortRebase(
  root: string,
  opts: RebaseRunOptions = {},
): Promise<RebaseOutcome> {
  const { code, stderr, stdout } = await spawnGit(
    ["rebase", "--abort"],
    root,
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    opts,
  );
  if (code === 0) {
    clearRewordQueue(await rewordPaths(root, opts));
    return { status: "done" };
  }
  return {
    status: "failed",
    message: firstLine(stderr, stdout) || "Couldn't abort the rebase.",
  };
}

/** Boolean form, for callers that only branch on success. */
export async function abortRebaseAt(root: string, opts: RebaseRunOptions = {}): Promise<boolean> {
  const { code } = await spawnGit(
    ["rebase", "--abort"],
    root,
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    opts,
  );
  // ONLY on success. A failed abort has changed nothing about the rebase, so it
  // must not change the queue either — destroying the messages while the rebase
  // is still live is the worst of both. git's own `--abort` removes
  // `rebase-merge/` and the queue inside it; this only sweeps up a staging copy
  // left by a run that never reached a pause.
  if (code === 0) clearRewordQueue(await rewordPaths(root, opts));
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
  // Ask the FILESYSTEM, not git's prose.
  //
  // This ran `git status` and grepped it for "rebase in progress". git
  // translates that sentence — a French git says "rebasage interactif en
  // cours", a German one "Interaktives Rebase im Gange" — and the message
  // catalogs ship with the standard package. So on any non-English git the
  // answer was always `false`, which silently disabled every guard built on it:
  // an `edit` stop was reported as a completed rebase, and the reword queue was
  // deleted with it.
  //
  // The state directory is the same fact without the language, and cheaper than
  // `git status` on a large working tree.
  const { code, stdout } = await spawnGit(["rev-parse", "--absolute-git-dir"], root, env, opts);
  const gitDir = stdout.trim();
  if (code !== 0 || !gitDir) return false;
  return rebaseStateDir(gitDir) !== undefined;
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
function firstLine(...streams: string[]): string {
  const lines = streams
    .join("\n")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    // `hint:` lines are git's advice ABOUT the problem, and it puts them first:
    // taking one gave the user "hint: Resolve all conflicts manually, mark them
    // as resolved with" — a sentence cut mid-clause, telling them to fix
    // conflicts that in the emptied-patch case do not exist. `Applying:` is
    // progress noise for the same reason `Rebasing (n/m)` is.
    .filter((l) => l.length > 0 && !/^(hint|Applying):/i.test(l));
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
    const startedAt = Date.now();
    // stdin is IGNORED, not inherited/piped. A rebase re-signs commits and may
    // hit a credential helper; with an open stdin git blocks on the prompt
    // forever and this promise never settles, wedging the whole rebase with no
    // way out. Closed stdin + GIT_TERMINAL_PROMPT=0 makes git fail fast instead.
    const childEnv: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", ...env };
    // This is the call that hands git GIT_EDITOR/GIT_SEQUENCE_EDITOR pointing at
    // the HOST's own binary (ELECTRON_RUN_AS_NODE) — the audit records it.
    auditSpawn({ bin: opts.gitPath || "git", args, cwd, env: childEnv });
    const child = spawn(opts.gitPath || "git", args, {
      cwd,
      env: childEnv,
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
      try {
        opts.onRun?.({
          args,
          durationMs: Date.now() - startedAt,
          exitCode: r.code,
          failed: r.code !== 0,
          stderr: r.code !== 0 ? r.stderr.slice(0, 4000) : undefined,
        });
      } catch {
        /* an observer must never break the command it is observing */
      }
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
