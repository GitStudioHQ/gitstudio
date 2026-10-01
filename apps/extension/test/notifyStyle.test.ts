// One voice for GitStudio's notifications (src/ui/notify.ts).
//
// The same event read several ways: "Push failed: …" from the status bar and
// "GitStudio: push failed — …" from the Changes view for the same push; "No
// active repository.", "No active Git repository." and "GitStudio: no
// repository is open." for the same state; a copied SHA in a toast from blame
// and in the status bar from the graph; and the push review said "3h ago"
// beside a rail saying "3h" for the same commit.
//
// The builders are checked here, and a census over the sources holds every
// door to them. Every file is in it; one known debt is written down below
// (PR_SENTENCES_OWED) rather than left out without a word.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { notice, failed, NO_REPOSITORY, copiedText } = require("../src/ui/notify") as typeof import("../src/ui/notify");
/* eslint-enable @typescript-eslint/no-require-imports */

test("the sentence: GitStudio once, a capital, a full stop", () => {
  assert.equal(notice("no key entered"), "GitStudio: No key entered.");
  assert.equal(notice("GitStudio: no key entered."), "GitStudio: No key entered.", "the prefix never twice");
  assert.equal(notice(notice("Nothing to undo")), "GitStudio: Nothing to undo.", "idempotent");
  assert.equal(notice("Amend commit — done."), "GitStudio: Amend commit — done.");
  assert.equal(notice("Is it pushed?"), "GitStudio: Is it pushed?");
  assert.equal(notice("  spaced  "), "GitStudio: Spaced.");
});

test("the sentence in Chinese: 。？！ end it, so no Latin full stop follows", () => {
  assert.equal(notice("已切到 main。"), "GitStudio: 已切到 main。");
  assert.equal(notice("推完了！"), "GitStudio: 推完了！");
  assert.equal(notice("没问题？"), "GitStudio: 没问题？");
  assert.equal(notice("GitStudio: 草稿已保存。"), "GitStudio: 草稿已保存。", "the prefix never twice");
  assert.equal(notice("没有句号"), "GitStudio: 没有句号.", "a sentence that ends in neither still gets one");
});

test("a failure: the action, then git's reason, whole, on one line", () => {
  assert.equal(
    failed("Push", "rejected: non-fast-forward\nhint: pull first"),
    "GitStudio: Push failed — rejected: non-fast-forward hint: pull first.",
  );
  assert.equal(failed("Pull", ""), "GitStudio: Pull failed.");
  assert.equal(failed("Undo"), "GitStudio: Undo failed.");
  assert.equal(failed("Revert", "\n\nerror: could not revert 1a2b3c4.\n"), "GitStudio: Revert failed — error: could not revert 1a2b3c4.");
  assert.equal(NO_REPOSITORY, "GitStudio: No repository is open.");
  assert.equal(copiedText("1a2b3c4"), "$(check) Copied 1a2b3c4");
});

// ── The census ───────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..", "src");
/**
 * Known debt, not an exemption from the rules: the Pull Requests surface
 * (merged from its own branch) still writes some two dozen toasts as
 * bare sentences — no "GitStudio: ", GitHub's error text on its own, some
 * starting with a branch name that notice() would capitalise. They are held
 * to every other rule here (no "X failed:", NO_REPOSITORY, a copy in the
 * status bar); only the sentence-builder check below skips them until their
 * words are reworked. Shrink this, never widen it.
 */
const PR_SENTENCES_OWED = /^pr\//;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every show*Message( … ) call's argument text, with the file it is in. */
function calls(): { rel: string; args: string }[] {
  const out: { rel: string; args: string }[] = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (rel === "ui/notify.ts") continue;
    const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    for (const m of code.matchAll(/show(?:Warning|Error|Information)Message\(/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      out.push({ rel, args: code.slice(start, i - 1).trim() });
    }
  }
  return out;
}

test("no toast writes its own 'X failed: …' or 'x failed — …': a failure goes through failed()", () => {
  const hits = calls()
    .filter((c) => /failed: |failed —/.test(c.args))
    .map((c) => `${c.rel}: ${c.args.slice(0, 90)}`);
  assert.deepEqual(hits, []);
});

test("'no repository' is one sentence, NO_REPOSITORY, wherever it is said", () => {
  const hits = calls()
    .filter((c) => /no (active )?(git )?repository/i.test(c.args))
    .map((c) => `${c.rel}: ${c.args.slice(0, 90)}`);
  assert.deepEqual(hits, []);
});

test("a copy is confirmed in the status bar, never in a toast", () => {
  const hits = calls().filter((c) => /\bCopied\b/.test(c.args)).map((c) => `${c.rel}: ${c.args.slice(0, 90)}`);
  assert.deepEqual(hits, []);
});

/**
 * The calls whose first argument is not one of the sentence builders, each
 * with the reason. Everything else goes through notice(), failed(),
 * NO_REPOSITORY or a "GitStudio: " literal.
 */
const EXEMPT: { rel: string; args: RegExp; why: string }[] = [
  {
    rel: "git/pausedForUser.ts",
    args: /^message: string, \.\.\.actions: string\[\]$/,
    why: "the PauseNoticeUi adapter's type, not a call",
  },
  {
    rel: "git/pausedForUser.ts",
    args: /^message, RESOLVE_CONFLICTS_ACTION$/,
    why: "announcePause is vscode-free; its one sender (pauseNotice.ts) passes notice()",
  },
  {
    rel: "ai/aiCommands.ts",
    args: /^message,\s*\{ modal: false \},\s*copy,?$/,
    why: "the commit message the AI drafted, offered to copy: the user's words, not GitStudio's (copy is the button's own label, read once so the choice compares it)",
  },
];

test("every toast is built by notice(), failed() or NO_REPOSITORY, or is a 'GitStudio: ' literal", () => {
  // It used to check literals only: a variable, a template starting with
  // one, or git's stderr passed straight through went unread, and the
  // graph's failures ("Cherry-pick failed: error: …"), about twenty branch
  // actions (git's stderr alone) and the rebase refusals were all of those.
  const built = /^(notice\(|failed\(|NO_REPOSITORY\b|l10n\.t\(["'`]GitStudio: )/;
  // A ternary whose two branches are both "GitStudio: " messages still says
  // one, whichever branch runs: the guard reads the branch sentences, not the
  // choice between them.
  const branchy = /\?\s*l10n\.t\(["'`]GitStudio: [\s\S]*:\s*l10n\.t\(["'`]GitStudio: /;
  const seen = new Set<number>();
  const hits = calls()
    .filter((c) => {
      if (PR_SENTENCES_OWED.test(c.rel) || built.test(c.args) || branchy.test(c.args)) return false;
      const i = EXEMPT.findIndex((e) => e.rel === c.rel && e.args.test(c.args.replace(/\s+/g, " ").trim()));
      if (i >= 0) {
        seen.add(i);
        return false;
      }
      return true;
    })
    .map((c) => `${c.rel}: ${c.args.replace(/\s+/g, " ").slice(0, 90)}`);
  assert.deepEqual(hits, []);
  // An exemption that no longer matches anything is removed, not kept.
  assert.deepEqual(EXEMPT.filter((_, i) => !seen.has(i)).map((e) => `${e.rel}: ${e.why}`), []);
});

test("the push review's ages come from the host's one formatter, not a second one in the page", () => {
  const view = readFileSync(join(SRC, "changes", "commitView.ts"), "utf8");
  assert.doesNotMatch(view, /function relTime\(/, "the page has no formatter of its own");
  assert.match(view, /rel: relativeTime\(c\.authorDate\)/, "the host sends each commit's age, as the rail and blame say it");
  // Its rows are the shared commit rows (webview-ui changeRows, the Worktrees
  // view's too): they say the age the host sent, and have no "… ago" of their own.
  const rows = readFileSync(join(SRC, "..", "..", "..", "packages", "webview-ui", "src", "changeRows", "changeRows.ts"), "utf8");
  assert.match(rows, /const when = c\.rel \?\? relTime\(/);
  assert.doesNotMatch(rows, /function relTime\(/);
});
