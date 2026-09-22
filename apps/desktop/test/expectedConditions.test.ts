// Which `ok:false` answers are allowed to file a crash report.
//
// main.ts wraps every IPC handler and reports any result that comes back
// `ok:false` carrying a message — the desktop analog of the extension's
// showGitError. That is right for a git command that failed for a reason worth
// knowing about, and wrong for the far larger set of refusals that are not
// failures at all: no repository open, nothing staged, a stash that is gone, a
// feature this build does not carry. Reports #15 ("Set identity" / "No
// repository open.") and #16 ("Ai mcpInstall" / "The MCP server isn't built
// yet") were both of the second kind, and both arrived as crashes.
//
// `expected: true` on the result is how a handler says "this is a condition,
// not a defect". The renderer shows the same `message` for the same refusal;
// what it also does, at twenty-odd call sites, is paint that message neutral
// rather than red — `r.expected ? "info" : "error"`. That is the same
// judgement said to the user, and the two tests at the bottom of this file pin
// the line: `expected` may retone a message, and must never swallow one.
//
// This is a CENSUS over the main-process source, for the same reason
// destructiveGuards and gitBridgeArgGuards are: the mechanism is present and
// correct, and the defect is the next call site that forgets to use it. A new
// `ok:false` whose message is one of the known guard shapes fails here until it
// is either marked `expected` or listed in REVIEWED with the reason it is a
// real failure.
//
// The extension has no twin of this: its reporter fires only from
// showGitError(), which is reached only after a git command exits non-zero, and
// its handful of `ok:false` values (stashesWebview's stale-list flag,
// gitBrain's Test-connection answer, commitView's `commitDone` messages) never
// reach ErrorReporter at all. There is nothing there to mark.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { reportableResultMessage } from "../src/main/expectedError";

const ROOT = fileURLToPath(new URL("../src/main", import.meta.url));

/**
 * The message shapes that mean "you are simply in this state".
 *
 * Deliberately phrase-based and narrow. A census that matched "anything with a
 * message" would be a rewrite of the reporter, not a guard on it — the point is
 * that these particular, already-seen classes cannot silently regrow.
 */
const GUARD_CLASSES: Array<{ name: string; re: RegExp }> = [
  { name: "no repository open", re: /no repository (is )?open|open a repository first/i },
  {
    name: "nothing selected, staged, or entered",
    re: /\bnothing (is |to )|\bno (files|lines|changes|commits) (to |selected)|\bno destination folder\b|\bno repository URL\b/i,
  },
  {
    name: "the thing it names is gone",
    re: /\bno longer (exists|in |on )|\bconnection not found\b/i,
  },
  {
    name: "not built, installed, or bundled in this build",
    re: /isn't (built|installed|bundled)|aren't available in this build|isn't installed or not on PATH|updates are disabled/i,
  },
  {
    name: "nothing configured to do it with",
    re: /no (AI )?model is connected|not connected to GitHub/i,
  },
  {
    name: "no update in that state",
    re: /no update is waiting|no downloaded update|updater not ready/i,
  },
  {
    name: "a field the user has not filled in yet",
    re: /is required\.|needs a title|write a comment first|enter a name and an email|needs both a name and an email|can't start with/i,
  },
  { name: "the destination is already taken", re: /already exists/i },
  {
    name: "a credential the user has to fix",
    re: /didn't work — make sure|token is invalid or expired/i,
  },
  {
    name: "unusable input from the user",
    re: /couldn't derive a (safe )?folder name|doesn't look like an owner\/repo name|couldn't be read as JSON/i,
  },
];

/**
 * Sites whose message reads like a condition but which must keep reporting,
 * with the reason. "It felt noisy" is not a reason.
 */
const REVIEWED: Record<string, string> = {
  "Nothing to apply in the selection.":
    "this exact sentence WAS the symptom of a real bug — stageLines matched the " +
    "selection against the wrong side of the diff and said this about a line " +
    "plainly on screen (see the comment above it). A report here is how we would " +
    "hear that it has come back.",
  "Found a clone at ${hitRoot}, but it couldn't be opened.":
    "we found a repository and then failed to open it — that is a defect, not a state.",
  "Cloned to ${result.root}, but it couldn't be opened.":
    "same: the clone succeeded, so failing to open it is ours.",
};

/**
 * The other side of the line: refusals that only OUR OWN code can cause.
 *
 * Each of these answers a request no control in the app can build — a mode
 * that is not one of the dialog's two buttons, a ref or path the renderer
 * failed to validate, a task or client id that is not in our own table. When
 * one fires, a door is sending garbage, and the crash report is the only way we
 * would ever hear about it. So they are the one place `expected` must NEVER go,
 * however ordinary the sentence reads: "That isn't a way to reconcile a pull."
 * was marked expected when it was written, which would have hidden exactly the
 * renderer bug it exists to catch.
 *
 * Key = the message as the census reads it; value = why only a defect reaches it.
 */
const PAYLOAD_REFUSALS: Record<string, string> = {
  "That isn't a way to reconcile a pull.":
    "sync:pull's mode comes from the divergence dialog's two buttons; anything else is a malformed request.",
  "That value isn't a valid git reference.":
    "every ref the renderer sends is one it listed; a dash-led or empty one is a request built wrong.",
  "That isn't a usable file path.":
    "every path the renderer sends is one git listed; an empty or NUL-bearing one is a request built wrong.",
  "Unknown task: ${task}": "ai:task names come from our own AiTaskName union.",
  "Unknown local CLI.": "CLI presets come from our own catalog.",
  "Unknown client: ${req.client}.": "MCP client ids come from our own client list.",
};

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Index every `{ … }` in a TypeScript source, skipping the braces inside
 * strings, template literals and comments.
 *
 * Line windows are not good enough here: an `ok:false` object and its `message`
 * are often five lines apart, and the next refusal starts two lines after that.
 * Matching the actual literal is what makes "this object carries `expected`"
 * a question with one answer.
 */
function braceSpans(src: string): Array<{ open: number; close: number }> {
  const spans: Array<{ open: number; close: number }> = [];
  const stack: number[] = [];
  // Inside a template literal, `${` re-enters code; remember how deep the brace
  // stack was when each template opened so its closing `}` is matched right.
  const templates: number[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "`") {
      templates.push(stack.length);
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          templates.pop();
          i++;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          // Hand the expression back to the main loop.
          stack.push(i + 1);
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (c === "}") {
      const open = stack.pop();
      if (open !== undefined) spans.push({ open, close: i });
      i++;
      // Closing a `${` puts us back inside the template it interrupted.
      if (templates.length && templates[templates.length - 1] === stack.length) {
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === "`") {
            templates.pop();
            i++;
            break;
          }
          if (src[i] === "$" && src[i + 1] === "{") {
            stack.push(i + 1);
            i += 2;
            break;
          }
          i++;
        }
      }
      continue;
    }
    i++;
  }
  return spans;
}

interface Site {
  file: string;
  line: number;
  message: string;
  expected: boolean;
}

/**
 * `src` with every comment blanked to spaces — same length, same newlines, so
 * offsets and line numbers still point into the real file.
 *
 * Prose ABOUT a result is not a result. A doc comment reading "answers
 * `{ ok: false, diverged }`" used to be counted as a site: its innermost
 * enclosing braces are the whole class body, so the census judged the class —
 * its first `message:` anywhere, and whether the word "expected" appeared
 * anywhere in it.
 */
function blankComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const skipQuoted = (q: string): void => {
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  const code = (stopAtClose: boolean): void => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        const e = src.indexOf("\n", i);
        const end = e < 0 ? src.length : e;
        blank(i, end);
        i = end;
      } else if (c === "/" && n === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e < 0 ? src.length : e + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        skipQuoted(c);
      } else if (c === "`") {
        // A template's text is not code, but each `${…}` inside it is.
        i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") i += 2;
          else if (src[i] === "$" && src[i + 1] === "{") {
            i += 2;
            code(true);
            i++;
          } else i++;
        }
        i++;
      } else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (stopAtClose && depth === 0) return;
          depth--;
        }
        i++;
      }
    }
  };
  code(false);
  return out.join("");
}

/** Every object literal in `src` that says `ok: false`, with its message. */
function okFalseSites(rel: string, src: string): Site[] {
  const spans = braceSpans(src);
  const sites: Site[] = [];
  for (const m of blankComments(src).matchAll(/\bok:\s*false\b/g)) {
    const at = m.index;
    // The innermost literal containing this `ok: false`.
    let best: { open: number; close: number } | undefined;
    for (const s of spans) {
      if (s.open < at && at < s.close && (!best || s.open > best.open)) best = s;
    }
    if (!best) continue;
    const body = src.slice(best.open, best.close + 1);
    const key = /(^|[\s,{(])message:\s*/.exec(body);
    let message = "";
    if (key) {
      // The message expression runs to the comma or brace that ends this
      // property — at the literal's own depth, so a template's `${…}` and a
      // nested object stay part of it. Quotes and backticks are skipped whole:
      // half these messages contain a comma ("Found a clone at ${root}, but…"),
      // and stopping at it silently truncated the text the phrases match on.
      const start = key.index + key[0].length;
      let depth = 0;
      let j = start;
      for (; j < body.length; j++) {
        const ch = body[j];
        if (ch === '"' || ch === "'" || ch === "`") {
          j++;
          while (j < body.length && body[j] !== ch) j += body[j] === "\\" ? 2 : 1;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (depth === 0) break;
          depth--;
        } else if (ch === "," && depth === 0) break;
      }
      message = body.slice(start, j).trim();
    }
    sites.push({
      file: rel,
      line: src.slice(0, at).split("\n").length,
      message,
      expected: marksExpected(body),
    });
  }
  return sites;
}

/**
 * Whether an object literal (its source, braces included) really carries the
 * `expected` flag — as one of its OWN properties, with a value that is not
 * `false`.
 *
 * The census used to ask only whether the word "expected" appeared anywhere
 * in the literal, so it could be satisfied by things that leave the result
 * reportable at runtime: a comment (`/* not expected *\/`), `expected: false`,
 * a type in a cast (`...({} as { expected: true })`), or the word inside the
 * message itself. Each of those put report #15 straight back while the census
 * stayed green. A conditional (`expected: out.status === "stopped"`) is a
 * decision the site made, so it counts.
 */
function marksExpected(body: string): boolean {
  return topLevelProps(body).some((p) => /^expected\s*:\s*(?!false\b)\S/.test(p));
}

/** An object literal's own top-level properties, with comments dropped and
 *  nested literals, calls, casts and strings kept whole inside theirs. */
function topLevelProps(body: string): string[] {
  const inner = body.slice(1, -1);
  const props: string[] = [];
  let depth = 0;
  let cur = "";
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    const next = inner[j + 1];
    if (ch === "/" && next === "/") {
      const end = inner.indexOf("\n", j);
      j = end < 0 ? inner.length : end;
      cur += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = inner.indexOf("*/", j + 2);
      j = end < 0 ? inner.length : end + 1;
      cur += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let k = j + 1;
      while (k < inner.length && inner[k] !== ch) k += inner[k] === "\\" ? 2 : 1;
      cur += inner.slice(j, k + 1);
      j = k;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      props.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) props.push(cur.trim());
  return props;
}

/** Strip the quotes/backticks off a message expression, for matching + REVIEWED. */
function plain(message: string): string {
  return message
    .replace(/^[`"']|[`"']$/g, "")
    .replace(/`\s*\+\s*\n?\s*`/g, "")
    .replace(/"\s*\+\s*\n?\s*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function allSites(): Promise<Site[]> {
  const out: Site[] = [];
  for (const file of await tsFiles(ROOT)) {
    out.push(...okFalseSites(relative(ROOT, file), await readFile(file, "utf8")));
  }
  return out;
}

test("every ok:false that is a condition rather than a defect says so", async () => {
  const unmarked: string[] = [];
  for (const site of await allSites()) {
    if (site.expected || !site.message) continue;
    const text = plain(site.message);
    if (REVIEWED[text]) continue;
    const hit = GUARD_CLASSES.find((g) => g.re.test(text));
    if (hit) {
      unmarked.push(`${site.file}:${site.line}  [${hit.name}]  ${text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    unmarked,
    [],
    "these ok:false results describe a state the user can simply be in, but the IPC wrapper in " +
      "main.ts will file a crash report for each one. Add `expected: true` to the result (the user " +
      "reads the same message; it stops being painted red), or list the message in REVIEWED with " +
      "the reason it is a real failure:\n" +
      unmarked.join("\n"),
  );
});

test("the census actually sees the results it claims to check", async () => {
  // A census that matches nothing passes forever.
  const sites = await allSites();
  assert.ok(
    sites.length >= 200,
    `expected to find the ok:false results, found ${sites.length} — has the result shape changed?`,
  );
  const withMessage = sites.filter((s) => s.message).length;
  assert.ok(withMessage >= 100, `found only ${withMessage} ok:false results carrying a message`);
  // The two the reports came in on, by name, so a rename cannot quietly empty
  // the census of exactly the cases it was written for.
  const marked = sites.filter((s) => s.expected).map((s) => plain(s.message));
  assert.ok(
    // 13, not 12: twelve in gitBridge and one in githubBridge's prCheckout,
    // which the first pass of this sweep missed and this census found.
    marked.filter((m) => /^No repository open\.$/.test(m)).length >= 13,
    "report #15's message is no longer marked expected at every site",
  );
  assert.ok(
    marked.some((m) => /MCP server isn't built yet/.test(m)),
    "report #16's message is no longer marked expected",
  );
});

test("only a real `expected` property satisfies the census — not a comment, a cast, or `false`", () => {
  // Each of these compiles, and each leaves the result REPORTABLE at runtime:
  // the IPC wrapper reads `result.expected === true`, not the source text. A
  // census that any of them could satisfy would let report #15 come back with
  // the test still green.
  const guard = `"No repository open."`;
  const notMarked: Record<string, string> = {
    "a block comment": `const r = { ok: false, /* expected: true */ message: ${guard} };`,
    "a line comment": `const r = {\n  ok: false,\n  // expected — see #15\n  message: ${guard},\n};`,
    "expected: false": `const r = { ok: false, expected: false, message: ${guard} };`,
    "a type in a cast": `const r = { ok: false, ...({} as { expected: true }), message: ${guard} };`,
    "the word in the message": `const r = { ok: false, message: "Not expected: no repository open." };`,
  };
  for (const [how, src] of Object.entries(notMarked)) {
    const [site] = okFalseSites("probe.ts", src);
    assert.ok(site, `${how}: the census should see this ok:false at all`);
    assert.equal(site.expected, false, `${how} must not count as \`expected\``);
  }

  const marked: Record<string, string> = {
    "expected: true": `const r = { ok: false, expected: true, message: ${guard} };`,
    "on its own line": `const r = {\n  ok: false,\n  changed: false,\n  expected: true,\n  message: ${guard},\n};`,
    "a decision the site made": `const r = { ok: false, expected: out.status === "stopped", message: m };`,
  };
  for (const [how, src] of Object.entries(marked)) {
    const [site] = okFalseSites("probe.ts", src);
    assert.equal(site?.expected, true, `${how} is a real flag`);
  }

  // And prose ABOUT a result is not a result: this doc comment used to be
  // counted as a site whose "literal" was the whole class body.
  const prose =
    "class A {\n" +
    "  /** Answers `{ ok: false, diverged }` when both sides have moved. */\n" +
    "  m() {\n" +
    '    return { ok: true, message: "No repository open." };\n' +
    "  }\n" +
    "}\n";
  assert.deepEqual(okFalseSites("probe.ts", prose), [], "a comment mentioning ok: false is not a site");
});

test("a genuine git failure still reports", async () => {
  // The other half of the contract. Marking conditions must not turn into
  // marking everything: a non-zero git command is exactly what the reporter
  // exists for.
  const stillReporting = (await allSites()).filter(
    (s) => !s.expected && s.message && /stderr/.test(s.message),
  );
  assert.ok(
    stillReporting.length >= 8,
    `only ${stillReporting.length} ok:false results still report a git stderr — the sweep has gone too far`,
  );
});

test("the reviewed list has not gone stale", async () => {
  const messages = new Set((await allSites()).map((s) => plain(s.message)));
  for (const text of Object.keys(REVIEWED)) {
    assert.ok(messages.has(text), `REVIEWED lists a message that no longer exists: ${text}`);
  }
});

test("a refusal only a malformed request can produce is never marked expected", async () => {
  const sites = await allSites();
  const hidden = sites
    .filter((s) => s.expected && PAYLOAD_REFUSALS[plain(s.message)])
    .map((s) => `${s.file}:${s.line}  ${plain(s.message)}`);
  assert.deepEqual(
    hidden,
    [],
    "these refusals can only be reached by a request our own renderer built wrong, so they must " +
      "reach the crash reporter — remove `expected` from them:\n" +
      hidden.join("\n"),
  );
  // And the list is about real sites, so it cannot pass by describing nothing.
  const messages = new Set(sites.map((s) => plain(s.message)));
  for (const text of Object.keys(PAYLOAD_REFUSALS)) {
    assert.ok(messages.has(text), `PAYLOAD_REFUSALS lists a message that no longer exists: ${text}`);
  }
  // The two lists answer opposite questions; a message on both is a mistake.
  for (const text of Object.keys(PAYLOAD_REFUSALS)) {
    assert.ok(!REVIEWED[text], `${text} is on both lists`);
    assert.ok(
      !GUARD_CLASSES.some((g) => g.re.test(text)),
      `${text} reads like a condition to the census's own phrase list — reword it or move it`,
    );
  }
});

// ── What `expected` is allowed to change in the renderer ─────────────────────

/**
 * `expected` is not only the reporter's flag: twenty-odd renderer call sites
 * read it to pick a toast's TONE (`r.expected ? "info" : "error"`), which is
 * the same judgement said to the user — a state is not painted red. Marking a
 * refusal therefore turns its toast neutral, and that is the contract working.
 *
 * What it must NEVER do is make the app silent. One call site uses `expected`
 * to SUPPRESS the toast entirely, and it is reviewed: a cancelled file picker
 * has nothing to say. A second one, added without noticing, would mean a
 * handler could be marked here and a user would be told nothing at all about a
 * command that did not run.
 */
const RENDERER = fileURLToPath(new URL("../src/renderer", import.meta.url));

const SUPPRESSING_SITES: Record<string, string> = {
  "views/releases.ts":
    "release:uploadAssets marks a cancelled native file picker expected, and a " +
    "cancelled picker is a non-event — there is nothing to tell the user.",
};

test("`expected` may retone a message, never swallow it", async () => {
  const found: string[] = [];
  for (const file of await tsFiles(RENDERER)) {
    const rel = relative(RENDERER, file);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!/!\s*\w+\.expected\b/.test(line)) return;
      if (SUPPRESSING_SITES[rel]) return;
      found.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    found,
    [],
    "this call site uses `expected` to decide whether to say anything at all. A main-process " +
      "handler marked `expected` to keep it out of the crash reporter would then refuse a command " +
      "in total silence. Show the message and let `expected` pick the tone, or add the file to " +
      "SUPPRESSING_SITES with the reason silence is right:\n" +
      found.join("\n"),
  );
});

test("the renderer still reads `expected` for tone", async () => {
  // The other direction: if these reads disappear, marking a condition would
  // start painting it red again and this file's REVIEWED reasoning goes stale.
  let tone = 0;
  for (const file of await tsFiles(RENDERER)) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (/\.expected \? "info" : "error"/.test(line)) tone++;
    }
  }
  assert.ok(tone >= 15, `only ${tone} renderer sites tone a toast by \`expected\` — has the shape changed?`);
});

// ── The wrapper's own rule, tested directly ──────────────────────────────────

test("a handled failure carrying a message is reported", () => {
  assert.equal(
    reportableResultMessage({ ok: false, changed: false, message: "merge conflict" }),
    "merge conflict",
  );
});

test("`expected` suppresses the report and nothing else", () => {
  assert.equal(
    reportableResultMessage({
      ok: false,
      changed: false,
      expected: true,
      message: "No repository open.",
    }),
    undefined,
  );
  // The renderer reads `message`, and it is untouched — that is the whole point
  // of marking the result rather than swallowing it.
  const result = { ok: false, changed: false, expected: true, message: "No repository open." };
  assert.equal(result.message, "No repository open.");
});

test("an ok:true result, or one with no message, is never reported", () => {
  assert.equal(reportableResultMessage({ ok: true, changed: true }), undefined);
  assert.equal(reportableResultMessage({ ok: false, changed: false }), undefined);
  assert.equal(reportableResultMessage({ ok: false, changed: false, message: "   " }), undefined);
  for (const v of [undefined, null, "nope", 0, true]) {
    assert.equal(reportableResultMessage(v), undefined);
  }
});

test("`expected: false` is not a way to be expected", () => {
  assert.equal(
    reportableResultMessage({ ok: false, expected: false, message: "git push failed" }),
    "git push failed",
  );
});
