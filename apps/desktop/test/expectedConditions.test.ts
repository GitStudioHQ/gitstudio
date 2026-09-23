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
import ts from "typescript";
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
    re: /couldn't derive a (safe )?folder name|couldn't be read as JSON/i,
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
  "Nothing to save.":
    "conflict:resolve's content is the merge editor's Result text, which is always a string — " +
    "even an empty file is \"\". A request without one is one our renderer built wrong, and the " +
    "report is how we would hear of it.",
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
  "That doesn't look like an owner/repo name.":
    "ghrepo:open's full name comes from a repository GitHub listed, or from a repo page whose route " +
    "only parses owner/repo — nobody types it, so one without both halves is a request built wrong.",
  "The rebase plan had no commits in it.":
    "rebase:apply's rows are the commits the Rebase view drew, and it offers Start rebase only over " +
    "them; a plan with no rows at all is a request built wrong.",
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

interface Site {
  file: string;
  line: number;
  /** The message as text — quotes dropped, a `+` chain joined, a same-file
   *  `const` followed — or its source when it is computed (`err.message`). */
  message: string;
  expected: boolean;
}

/**
 * Every object literal in `src` that says `ok: false`, with its message and
 * whether it carries `expected` — read from the TypeScript PARSER, not the text.
 *
 * This used to be a hand-written scanner over the characters: brace matching,
 * comment blanking, string skipping. It had no idea what a regex literal was,
 * so the first `/"[^"]*"|\S+/g` in a file opened a "string" at its quote and
 * everything after it was misread. editors.ts has exactly that regex above its
 * three refusals, and the census was blind to all three — "That editor isn't
 * installed any more" could lose its `expected` and the census stayed green.
 * The parser also answers, with one rule each, the shapes the scanner could
 * only approximate: comments (not in the tree at all), casts, spreads of an
 * object literal, shorthand `message`, a message kept in a `const`, a `+`
 * chain that mixes quote styles, and `expected: undefined`.
 */
function okFalseSites(rel: string, src: string): Site[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  // Same-file constants, so `message: NO_REPO` reads as what NO_REPO says.
  const consts = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      consts.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const sites: Site[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const own = ownProperties(n);
      const ok = own.get("ok");
      if (ok && literalValue(ok.value) === false) {
        const message = own.get("message");
        sites.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(ok.at.getStart(sf)).line + 1,
          message: message ? textOf(message.value, sf, consts) : "",
          expected: marksExpected(own.get("expected")?.value),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/** Strip the wrappers that do not change a value: parentheses, `as`, `satisfies`, `!`. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * An object literal's OWN properties, as the runtime sees them: in order, a
 * later one replacing an earlier one, and a spread of another object LITERAL
 * contributing its properties in place. A spread of anything else (a call, a
 * variable, a conditional) is opaque and contributes nothing the census can
 * vouch for — so it can never be what marks a result `expected`.
 */
function ownProperties(
  obj: ts.ObjectLiteralExpression,
): Map<string, { value: ts.Expression; at: ts.Node }> {
  const out = new Map<string, { value: ts.Expression; at: ts.Node }>();
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = unwrap(p.expression);
      if (ts.isObjectLiteralExpression(inner)) {
        for (const [k, v] of ownProperties(inner)) out.set(k, v);
      }
      continue;
    }
    const name =
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNoSubstitutionTemplateLiteral(p.name))
        ? p.name.text
        : undefined;
    if (!name) continue;
    if (ts.isPropertyAssignment(p)) out.set(name, { value: p.initializer, at: p });
    else if (ts.isShorthandPropertyAssignment(p)) out.set(name, { value: p.name, at: p });
  }
  return out;
}

/**
 * The value of an expression when it is a literal (or `!` of one, or
 * `undefined` / `void 0`) — `undefined` when it is computed at runtime.
 */
function literalValue(e: ts.Expression): unknown {
  const x = unwrap(e);
  switch (x.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
      return false;
    case ts.SyntaxKind.NullKeyword:
      return null;
  }
  if (ts.isIdentifier(x) && x.text === "undefined") return undefined;
  if (ts.isVoidExpression(x)) return undefined;
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
    const v = literalValue(x.operand);
    return v === COMPUTED ? COMPUTED : !v;
  }
  return COMPUTED;
}
const COMPUTED = Symbol("computed");

/**
 * Whether a result really carries the `expected` flag: the wrapper tests
 * `expected === true`, so a literal counts only when it IS `true`. A literal
 * that is anything else (`false`, `undefined`, `(false)`, `!1`, `"true"`)
 * leaves the result reportable. A computed value (`out.status === "stopped"`)
 * is a decision the site made, and counts.
 */
function marksExpected(value: ts.Expression | undefined): boolean {
  if (!value) return false;
  const v = literalValue(value);
  return v === COMPUTED || v === true;
}

/**
 * The message as the user reads it, for matching against the phrase list and
 * REVIEWED / PAYLOAD_REFUSALS: a string's text, a template with its `${…}`
 * spelled as written, a `+` chain joined, and a same-file constant followed.
 * Anything else — `err.message`, a conditional — is its source text.
 */
function textOf(e: ts.Expression, sf: ts.SourceFile, consts: Map<string, ts.Expression>, depth = 0): string {
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isTemplateExpression(x)) return x.getText(sf).slice(1, -1);
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return textOf(x.left, sf, consts, depth + 1) + textOf(x.right, sf, consts, depth + 1);
  }
  if (ts.isIdentifier(x) && depth < 5) {
    const init = consts.get(x.text);
    if (init) return textOf(init, sf, consts, depth + 1);
  }
  return x.getText(sf);
}

/** Whitespace-normalised message text, for matching + REVIEWED. */
function plain(message: string): string {
  return message.replace(/\s+/g, " ").trim();
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
    // Twelve: eleven in gitBridge and one in githubBridge's prCheckout, which
    // the first pass of this sweep missed and this census found. There were
    // thirteen until the identity card stopped needing a repository at all —
    // #15 was filed from THAT site, and the fix there was to make the request
    // work, not to keep refusing it quietly (see reportingVerdicts.test.ts).
    marked.filter((m) => /^No repository open\.$/.test(m)).length >= 12,
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
    // The wrapper tests `=== true`: a literal that is not `true` never is.
    "expected: undefined": `const r = { ok: false, expected: undefined, message: ${guard} };`,
    "expected: (false)": `const r = { ok: false, expected: (false), message: ${guard} };`,
    "expected: !1": `const r = { ok: false, expected: !1, message: ${guard} };`,
    "a later spread that unmarks it": `const r = { ok: false, expected: true, message: ${guard}, ...{ expected: false } };`,
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

test("the census reads what the parser reads — regexes, shorthand, constants, `+` chains", () => {
  // The census used to scan characters, and a regex literal with a quote in it
  // opened a "string" that swallowed the rest of the file. editors.ts has one
  // (`/"[^"]*"|\S+/g`) above its three refusals, and all three were invisible:
  // "That editor isn't installed any more" could lose `expected` with the
  // census still green. Each shape below compiles, and each hid a message.
  const seen: Record<string, string> = {
    "after a regex with a quote": `const re = /"[^"]*"|\\S+/g;\nconst r = { ok: false, message: "No repository open." };`,
    "after a regex with slash-star": `const re = /a\\/*/;\nconst r = { ok: false, message: "No repository open." };`,
    "shorthand message": `const message = "No repository open.";\nconst r = { ok: false, message };`,
    "a message kept in a const": `const NO_REPO = "No repository open.";\nconst r = { ok: false, message: NO_REPO };`,
    "a + chain mixing quotes": 'const r = { ok: false, message: "No repository " + `open.` };',
    "a quoted key": `const r = { ok: false, "message": "No repository open." };`,
  };
  for (const [how, src] of Object.entries(seen)) {
    const [site] = okFalseSites("probe.ts", src);
    assert.ok(site, `${how}: the census must see this ok:false`);
    assert.equal(plain(site.message), "No repository open.", `${how}: and read its words`);
    assert.equal(site.expected, false, how);
  }
});

test("the census sees every refusal in the files it has been blind to", async () => {
  // Pinned by name: if a file's refusals drop out of the census again, the
  // phrase check above passes over them in silence.
  const editors = (await allSites()).filter((s) => s.file === "editors.ts").map((s) => plain(s.message));
  assert.ok(
    editors.some((m) => /That editor isn't installed any more/.test(m)),
    `editors.ts's refusals are missing from the census: ${JSON.stringify(editors)}`,
  );
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
