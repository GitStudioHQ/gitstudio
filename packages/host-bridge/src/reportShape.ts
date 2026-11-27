import { userStateOutcome } from "./gitOutcomes";
import { clipForScrub, GIT_REVISION, quotedValues, safeShort, scrub, scrubGitMessage } from "./scrub";

/**
 * What a crash report says about a failure: the parts that help fix it, and
 * nothing else. Shared by both reporters, so they cannot drift.
 *
 * Reports used to carry a failure's text whole — all of git's output, an
 * error's message and its stack with every folder in it — and lean on the
 * scrubber (scrub.ts) to take the names out. A pattern scrubber always misses
 * some, and the Nov 2026 sweep of reports #86–#107 showed what the fixes
 * actually came from: which command, with which options, git's own verdict
 * line, where in our code it was thrown, and the system's error code. So a
 * report now sends those and drops the rest:
 *
 *   - a failed git command: its subcommand and options, never its arguments —
 *     no branch, path, remote or message (gitCommandShape); its exit code; and
 *     git's verdict lines, never its progress, hints, To/From banners, file
 *     lists or follow-on prose (gitVerdict);
 *   - a thrown error: its call frames, each a function and a file NAME with
 *     line and column, never a folder (stackFrames); and Node's error code and
 *     system call (errorFacts) — which survive a translated message;
 *   - and no report at all when the failure is the user's situation rather
 *     than a defect: git's words about their network, credentials or working
 *     tree (gitOutcomes.ts), or a server that could not be reached
 *     (isReportableThrown).
 *
 * Everything kept still goes through the scrubber. The collector
 * (gistudio.dev api/errors.ts) applies the same reduction to older clients'
 * reports, in a hand-kept copy of these rules: change one, change the other.
 */

/** What a failed git command leaves on the error GitProcess throws for it. */
export interface GitFailureFacts {
  args: readonly string[];
  /** null when a signal stopped it. */
  exitCode: number | null;
  /** The signal that stopped it ("SIGKILL"), when one did. */
  signal?: string;
  stderr: string;
}

const FACTS = "gitFailure";

/**
 * Put the facts of a failed git command on the error thrown for it, so a
 * report can be built from them instead of from the message — which is
 * translated in a translated build, and names every branch and path the
 * command was given. Not enumerable: nothing that serialises the error picks
 * up the raw arguments and stderr.
 */
export function attachGitFailure<E extends Error>(err: E, facts: GitFailureFacts): E {
  Object.defineProperty(err, FACTS, { value: facts, enumerable: false, configurable: true, writable: true });
  return err;
}

/** The facts attachGitFailure put on `err`, or undefined. */
export function gitFailureOf(err: unknown): GitFailureFacts | undefined {
  if (!err || typeof err !== "object") return undefined;
  const f = (err as Record<string, unknown>)[FACTS] as Partial<GitFailureFacts> | undefined;
  if (!f || typeof f !== "object" || !Array.isArray(f.args)) return undefined;
  return {
    args: f.args.filter((a): a is string => typeof a === "string"),
    exitCode: typeof f.exitCode === "number" ? f.exitCode : null,
    signal: typeof f.signal === "string" ? f.signal : undefined,
    stderr: typeof f.stderr === "string" ? f.stderr : "",
  };
}

/**
 * The English form GitProcess and SnapshotProvider throw ("git <args> exited
 * with code N: <stderr>", "git <args> failed: <stderr>"), read back into
 * facts — for an error that lost its attached facts (re-thrown as a new
 * Error with the same message). A translated message does not match, and is
 * reported as an ordinary message.
 */
const THROWN_GIT = /^(?:Error: )?git ([\s\S]{1,4000}?) (?:exited with code (-?\d{1,4})|failed)(?:: ([\s\S]*))?$/;

export function gitFailureInText(message: string): GitFailureFacts | undefined {
  const m = THROWN_GIT.exec(clipForScrub(message, 16_000));
  if (!m) return undefined;
  return { args: m[1].split(/\s+/).filter(Boolean), exitCode: m[2] === undefined ? null : Number(m[2]), stderr: m[3] ?? "" };
}

// ── the command ──────────────────────────────────────────────────────────────

/** Subcommands that take a second word, and the second words they take. */
const TWO_WORD = new Set(["stash", "remote", "worktree", "notes", "bisect", "submodule", "sparse-checkout", "lfs", "reflog", "maintenance", "bundle", "commit-graph", "multi-pack-index"]);
const SECOND_WORDS = new Set([
  "push", "pop", "apply", "drop", "list", "show", "save", "clear", "create", "store", "branch", "add", "remove", "rm",
  "rename", "prune", "move", "lock", "unlock", "repair", "set-url", "get-url", "set-head", "set-branches", "update",
  "init", "status", "sync", "foreach", "deinit", "start", "good", "bad", "new", "old", "reset", "skip", "run", "log",
  "expire", "delete", "exists", "set", "get", "unset", "edit", "copy", "append", "merge", "absorbgitdirs", "fetch",
  "pull", "install", "track", "untrack", "verify", "write", "register", "unregister",
]);

/**
 * A git command line with everything the user gave it taken out: the
 * subcommand and its options stay, so a report says WHAT was run ("git log
 * --ignore-missing --branches --tags --remotes HEAD"), and every argument —
 * a branch, a path, a remote, a message, a search — is `<arg>`.
 *
 *   - `--name` stays; `--name=value` keeps the value only when it is a
 *     number (`--max-count=500`), else `--name=…` (`--author=…`);
 *   - a one-letter flag stays (`-m`); anything glued to one does not
 *     (`-Sneedle` is `-S…`);
 *   - `-c key=value` keeps the key; `-C <dir>` never says the directory;
 *   - after `--` everything is a path, said once as `<paths>`;
 *   - git's own revisions (HEAD, ORIG_HEAD, @{u}, HEAD~1) and plain numbers
 *     stay; a run of arguments is said once as `<args>`.
 */
export function gitCommandShape(args: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  // git's own options, before the subcommand.
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-c") {
      out.push("-c", configKey(args[++i]));
    } else if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--exec-path") {
      out.push(a, "<path>");
      i++;
    } else if (a.startsWith("-")) {
      out.push(flag(a));
    } else {
      break;
    }
  }
  if (i < args.length) {
    const sub = args[i++];
    out.push(/^[a-z][a-z0-9-]{0,30}$/.test(sub) ? sub : "<arg>");
    if (TWO_WORD.has(sub) && i < args.length && SECOND_WORDS.has(args[i])) out.push(args[i++]);
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push("--");
      if (i + 1 < args.length) out.push("<paths>");
      break;
    }
    if (a.startsWith("-") && a.length > 1) out.push(flag(a));
    else if (GIT_REVISION.test(a) || /^\d{1,9}$/.test(a)) out.push(a);
    // "<args>" is this function's own word, read back (the collector shapes
    // a shaped command again): unchanged.
    else out.push(a === "<args>" ? "<args>" : "<arg>");
  }
  // A run of arguments is one "<args>": how many branches or paths someone
  // passed is not the failure, and would split one failure into many issues.
  const said: string[] = [];
  for (const w of out) {
    const last = said[said.length - 1];
    if ((w === "<arg>" || w === "<args>") && (last === "<arg>" || last === "<args>")) said[said.length - 1] = "<args>";
    else said.push(w);
  }
  return said.join(" ");
}

function flag(a: string): string {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    const ok = /^--[a-z0-9][a-z0-9-]{0,40}$/.test(name) ? name : "--<option>";
    if (eq < 0) return ok;
    return `${ok}=${/^\d{1,9}$/.test(a.slice(eq + 1)) ? a.slice(eq + 1) : "…"}`;
  }
  if (/^-[A-Za-z]$/.test(a) || /^-\d{1,9}$/.test(a)) return a;
  return /^-[A-Za-z]/.test(a) ? `${a.slice(0, 2)}…` : "-…";
}

/**
 * `-c key=value`: the key, never the value — and of a three-part key only its
 * section and name, since the middle is a branch's or a remote's
 * ("branch.<sub>.merge", "remote.<sub>.url").
 */
function configKey(kv: string | undefined): string {
  const m = /^([A-Za-z][\w.-]{0,60})=/.exec(kv ?? "");
  if (!m) return "<arg>";
  const parts = m[1].split(".");
  return `${parts.length > 2 ? `${parts[0]}.<sub>.${parts[parts.length - 1]}` : m[1]}=…`;
}

// ── git's verdict ────────────────────────────────────────────────────────────

/**
 * The lines in which git (or the ssh under it) says what went wrong. After
 * scrubGitMessage, so a push's " ! [rejected] main -> main (fetch first)" is
 * "! [rejected] <ref> -> <ref> (fetch first)" by now.
 */
const VERDICT =
  /^(?:(?:fatal|error|remote: (?:fatal|error)|ssh|kex_exchange_identification):|CONFLICT \(|! \[|Host key verification failed|Unable to negotiate|Connection (?:closed|reset|timed out|refused)\b|[^\n]{0,80}\bPermission denied \()/;

/** git's words inside a line of someone else's ("Undo couldn't …: fatal: …"). */
const GIT_INSIDE = /[:：\s]((?:fatal|error): [^\n]*)$/;

/**
 * Lines that are never the failure: progress, banners, git's advice, a rebase
 * running the user's command, file lists.
 */
const NOISE =
  /^(?:\s|hint:|remote:|To |From |\*\*|Cloning into|Receiving |Resolving |Counting |Compressing |Writing |Enumerating |Total |Unpacking |Updating |Fast-forward|Already up to date|Auto-merging |Delta compression|POST git-|Your branch |Please |and the repository exists|If you wish to|Otherwise,|You can |Use '|Executing: |Could not execute|Not committing merge|Resolve all conflicts|To abort|and then run|When you have resolved)/;

/** A line git or an app writes starts with a letter; a hook's report often doesn't ("✖ subject may not be empty"). */
const PROSE = /^\p{L}/u;

const MAX_VERDICT_LINES = 4;

/**
 * What git said went wrong, out of everything it printed: its `fatal:` and
 * `error:` lines, a push's rejected-ref lines with their reason, a merge's
 * CONFLICT lines, ssh's refusal — scrubbed, at most four lines. A line of
 * someone else's that carries git's words is cut to git's words: the text in
 * front is a message of ours, whose interpolated names nothing can recognise
 * ("The dropped commit is back, but <branch> isn't: … fatal: …"); the report's
 * `where` already says what was being done.
 *
 * When git said none of those (a message of our own, git in another language,
 * a sentence such as "The previous cherry-pick is now empty"): the first line
 * that is not progress, advice or a hook's report — one line, since what
 * follows is git's advice or a hook's free text. Nothing, when there is none.
 * Idempotent, so the collector can apply it again.
 */
export function gitVerdict(output: string): string {
  if (!output) return "";
  const lines = scrubGitMessage(clipForScrub(output, 4_000))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => (VERDICT.test(l) ? l : (GIT_INSIDE.exec(l)?.[1] ?? l)));
  const verdicts = lines.filter((l) => VERDICT.test(l));
  const kept = verdicts.length > 0 ? verdicts : lines.filter((l) => !NOISE.test(l) && PROSE.test(l)).slice(0, 1);
  return [...new Set(kept)]
    .slice(0, MAX_VERDICT_LINES)
    .map((l) => clipForScrub(l, 200))
    .join("\n")
    .slice(0, 600);
}

// ── where it was thrown ──────────────────────────────────────────────────────

const MAX_FRAMES = 15;

/** V8's frame line (four spaces; a tab in some of VS Code's own stacks). */
const FRAME_LINE = /^(?: {4}|\t)at (.+)$/;

/**
 * An error's call frames, each a function and a file name with its line and
 * column — "at td.readPage (main.js:190:3029)" — and nothing else: no folder
 * (a home, a workspace, an AppImage's mount, another extension's id).
 *
 * Only the frames V8 put there. A stack begins with "<name>: <message>", and
 * a message can hold lines that look like frames — the stderr of a Node hook
 * that crashed under git prints "    at checkInvoice (/Users/…/acme.js:1:2)"
 * — so the header is skipped by its exact text when `err` is given, and
 * otherwise only the block of frames that ends the stack is read.
 */
export function stackFrames(stack: string, err?: { name?: string; message?: string }): string {
  let text = clipForScrub(stack || "", 16_000);
  const head = err?.message ? `${err.name || "Error"}: ${err.message}` : (err?.name ?? "");
  const known = !!err && head !== "" && text.startsWith(head);
  if (known) text = text.slice(head.length);
  const lines = text.split("\n");
  let from = 0;
  if (!known) {
    // The frames that END the stack: V8 writes nothing after them.
    from = lines.length;
    while (from > 0 && (FRAME_LINE.test(lines[from - 1]) || lines[from - 1] === "")) from--;
  }
  const out: string[] = [];
  for (const line of lines.slice(from)) {
    const m = FRAME_LINE.exec(line);
    if (!m) continue;
    out.push(`    at ${m[1].length > 400 ? "<frame>" : frame(m[1].trim())}`);
    if (out.length >= MAX_FRAMES) break;
  }
  return out.join("\n");
}

/** A V8 function name: "fn", "a.b.<computed>", "async fn", "new Fn", "fn [as alias]". No spaces otherwise. */
const FN_NAME = /^(?:async |new )?[\w$.<>[\]]{1,100}(?: \[as [\w$.<>]{1,60}\])?$/;

function frame(body: string): string {
  const open = body.indexOf(" (");
  if (open > 0 && body.endsWith(")")) {
    const fn = body.slice(0, open);
    return `${FN_NAME.test(fn) ? fn : "<fn>"} (${location(body.slice(open + 2, -1))})`;
  }
  return location(body);
}

function location(loc: string): string {
  if (/^node:[\w/.-]{1,80}(?::\d+){0,2}$/.test(loc) || /^(?:<anonymous>|native|index \d{1,4})$/.test(loc)) return loc;
  // The last path segment, by index rather than a regex: an unanchored lazy
  // one is quadratic on a long line with no folder in it.
  const tail = loc.slice(Math.max(loc.lastIndexOf("/"), loc.lastIndexOf("\\")) + 1);
  const at = /(?::\d{1,9}){1,2}$/.exec(tail);
  const name = at ? tail.slice(0, at.index) : tail;
  return `${/^[\w.@-]{1,60}$/.test(name) ? name : "<file>"}${at?.[0] ?? ""}`;
}

/** Whole lines of `s`, as many as fit in `max` characters: a cut frame would read as another. */
function wholeLines(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf("\n", max);
  return cut > 0 ? s.slice(0, cut) : "";
}

// ── the system's words ───────────────────────────────────────────────────────

/**
 * Node's error code ("ENOENT", "EACCES") and the system call it came from
 * ("spawn", "open") — the call only, since Node's `syscall` for a spawn is
 * "spawn <program>". Looked for on the error and on its `cause`, where fetch
 * keeps them. They are the same in every language, unlike the message.
 */
export function errorFacts(err: unknown): { code?: string; syscall?: string } {
  const out: { code?: string; syscall?: string } = {};
  for (const e of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (!e || typeof e !== "object") continue;
    const { code, syscall } = e as { code?: unknown; syscall?: unknown };
    if (!out.code && typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) out.code = code;
    if (!out.syscall && typeof syscall === "string") {
      const verb = /^[a-z][a-z_]{0,20}(?=\s|$)/.exec(syscall)?.[0];
      if (verb) out.syscall = verb;
    }
  }
  return out;
}

/**
 * A server that could not be reached, or whose certificate could not be
 * trusted — the network's state, or a proxy's, never a defect of ours.
 */
const UNREACHABLE = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH",
  "EHOSTDOWN", "ENETUNREACH", "ENETDOWN", "ENETRESET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Whether a thrown error is worth a report: false when it is the user's
 * situation — git's words about their remote, credentials, network or
 * working tree (the classes both reporters already apply to a returned
 * failure; a THROWN one bypassed them), or a server that could not be
 * reached. The user sees the error either way; a report of it is nothing we
 * can fix.
 */
export function isReportableThrown(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // git's classes only on git's words: "Connection closed before the model
  // answered" is not git's network.
  const git = gitFailureOf(err) ?? gitFailureInText(err.message || "");
  const said = git ? git.stderr : GIT_WORDS.test(err.message || "") ? err.message : "";
  if (said && userStateOutcome(said)) return false;
  const { code } = errorFacts(err);
  return !(code && UNREACHABLE.has(code));
}

/** git's prefixes, inside a message of ours that carries its words. */
const GIT_WORDS = /(?:^|\n|: |：)(?:fatal|error|warning|hint): |(?:^|\n)CONFLICT \(/;

/** The errors JavaScript itself raises, whose quoted words are code ("reading
 *  'length'"). Not SyntaxError: JSON.parse's quotes the text it was given. */
const ENGINE_ERRORS = new Set(["TypeError", "ReferenceError", "RangeError"]);

/** A message that starts like one of git's own command lines, in any language. */
const GIT_START = /^(?:Error: )?git ([a-z][a-z0-9-]{0,30})(?= )/;

export interface ThrownReport {
  name: string;
  message: string;
  stack: string;
  code?: string;
  syscall?: string;
}

/**
 * A thrown error as a report carries it.
 *
 *   - a failed git command: "git <shape> exited with code N: <verdict>",
 *     built from the facts GitProcess attached, so it reads the same — and
 *     names nothing — in a translated build;
 *   - a message of ours with git's words in it: git's verdict lines, scrubbed
 *     as git output (the words of ours around them interpolate names);
 *   - a JavaScript error (TypeError …): its first lines, scrubbed — what it
 *     quotes is code;
 *   - anything else (an Error of ours, Node's ENOENT): its first lines,
 *     scrubbed, with every quoted value taken out, since what a message of
 *     ours quotes is the user's: a stash's message, a commit's subject.
 *
 * The stack is call frames only (stackFrames), cut at a whole frame.
 */
export function thrownReport(err: Error): ThrownReport {
  const raw = err.message || "";
  const git = gitFailureOf(err) ?? gitFailureInText(raw);
  let message: string;
  if (git) {
    const how =
      git.exitCode !== null
        ? `exited with code ${git.exitCode}`
        : git.signal
          ? `stopped by ${/^SIG[A-Z0-9]{1,10}$/.test(git.signal) ? git.signal : "a signal"}`
          : "failed";
    const said = gitVerdict(git.stderr);
    message = `git ${gitCommandShape(git.args)} ${how}${said ? `: ${said}` : ""}`;
  } else if (GIT_START.test(raw) && !/^(?:exited|failed)$/.test(GIT_START.exec(raw)?.[1] ?? "")) {
    // A git command line that lost its facts, in a language the English
    // form does not read ("git checkout acme 以代码 1 退出：…"): the
    // subcommand, and git's verdict when its words are there.
    const said = GIT_WORDS.test(raw) ? gitVerdict(raw) : "";
    message = `git ${GIT_START.exec(raw)?.[1]} <args> failed${said ? `: ${said}` : ""}`;
  } else if (GIT_WORDS.test(raw)) {
    message = gitVerdict(raw);
  } else {
    // The first line: what follows in a message of ours is output it carries.
    const first = scrub(clipForScrub(raw.split("\n")[0], 2_000));
    message = ENGINE_ERRORS.has(err.name) ? first : quotedValues(first);
  }
  return {
    name: safeShort(err.name || "Error", 60),
    message: message.slice(0, 500),
    stack: wholeLines(scrub(stackFrames(err.stack || "", err)), 1600),
    ...errorFacts(err),
  };
}
