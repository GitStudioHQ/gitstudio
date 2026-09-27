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
// door to them. The Pull Requests, Stashes and Worktrees surfaces are being
// rebuilt on their own branches and are left out of the census for now.

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

test("a failure: the action, then git's reason — its first line", () => {
  assert.equal(failed("Push", "rejected: non-fast-forward\nhint: pull first"), "GitStudio: Push failed — rejected: non-fast-forward.");
  assert.equal(failed("Pull", ""), "GitStudio: Pull failed.");
  assert.equal(failed("Undo"), "GitStudio: Undo failed.");
  assert.equal(failed("Revert", "\n\nerror: could not revert 1a2b3c4.\n"), "GitStudio: Revert failed — error: could not revert 1a2b3c4.");
  assert.equal(NO_REPOSITORY, "GitStudio: No repository is open.");
  assert.equal(copiedText("1a2b3c4"), "$(check) Copied 1a2b3c4");
});

// ── The census ───────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..", "src");
const OWNED_ELSEWHERE = /^(pr\/|views\/stashes|views\/worktrees)/;

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
    if (OWNED_ELSEWHERE.test(rel) || rel === "ui/notify.ts") continue;
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

test("no toast says 'X failed: …': a failure goes through failed()", () => {
  const hits = calls().filter((c) => /failed: /.test(c.args)).map((c) => `${c.rel}: ${c.args.slice(0, 90)}`);
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

test("a toast written out as text starts with GitStudio:", () => {
  // A literal (or a template starting with text) must carry the prefix; a
  // variable is the caller's sentence and is checked where it is built.
  const hits = calls()
    .filter((c) => /^["'`]/.test(c.args) && !/^["'`]GitStudio: /.test(c.args))
    .map((c) => `${c.rel}: ${c.args.slice(0, 90)}`);
  assert.deepEqual(hits, []);
});

test("the push review's ages come from the host's one formatter, not a second one in the page", () => {
  const view = readFileSync(join(SRC, "changes", "commitView.ts"), "utf8");
  assert.doesNotMatch(view, /function relTime\(/, "the page has no formatter of its own");
  assert.match(view, /rel: relativeTime\(c\.authorDate\)/, "the host sends each commit's age, as the rail and blame say it");
  assert.match(view, /meta\.textContent = c\.author \+ \(c\.rel \? " · " \+ c\.rel : ""\)/);
});
