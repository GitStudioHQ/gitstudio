// What the Command Palette offers, read from package.json and pinned.
//
//   · no two entries a user can see share a title ("GitStudio: Show Commit
//     Graph" was listed twice, for two commands doing the same thing);
//   · no placeholder: "GitStudio: Welcome" answered "The full Git suite is
//     coming online" — it now opens Get Started, and is not listed beside it;
//   · nothing dead: Refresh Commits / Refresh Branches refresh views that are
//     no longer mounted;
//   · the operation verbs (Continue / Skip / Abort, Abort Rebase) only while
//     something IS stopped — with nothing in progress each one only said
//     "There is nothing to continue";
//   · the process audit only while the audit is on (it is empty otherwise).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Command {
  command: string;
  title: string;
  category?: string;
}
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { commands: Command[]; menus: { commandPalette: { command: string; when?: string }[] } };
};
const palette = new Map(pkg.contributes.menus.commandPalette.map((e) => [e.command, e.when]));
/** A command is listed unless its palette entry says `when: false`. */
const listed = (id: string): boolean => palette.get(id) !== "false";
const src = (p: string): string => readFileSync(join(__dirname, "..", "src", p), "utf8");

test("no two commands a user can see in the palette share a title", () => {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const c of pkg.contributes.commands) {
    if (!listed(c.command)) continue;
    const title = `${c.category ?? ""}: ${c.title}`;
    const other = seen.get(title);
    if (other) dupes.push(`${title} — ${other} and ${c.command}`);
    else seen.set(title, c.command);
  }
  assert.deepEqual(dupes, []);
});

test("'Welcome' is no placeholder: it opens Get Started, and only Get Started is listed", () => {
  assert.equal(listed("gitstudio.showWelcome"), false);
  assert.equal(listed("gitstudio.openWalkthrough"), true);
  assert.doesNotMatch(src("extension.ts"), /coming online/);
  assert.match(
    src("extension.ts"),
    /registerCommand\("gitstudio\.showWelcome", \(\) =>\s*vscode\.commands\.executeCommand\("gitstudio\.openWalkthrough"\)/,
  );
});

test("the retired Commits / Branches views' refresh commands are not listed", () => {
  assert.equal(listed("gitstudio.refreshCommits"), false);
  assert.equal(listed("gitstudio.refreshBranches"), false);
});

test("the operation verbs are listed only while an operation is stopped", () => {
  for (const id of [
    "gitstudio.operation.continue",
    "gitstudio.operation.skip",
    "gitstudio.operation.abort",
    "gitstudio.abortRebase",
  ]) {
    assert.match(palette.get(id) ?? "", /\bgitstudio\.operationInProgress\b/, id);
  }
  // …and something sets that key: the merge experience's watcher, which
  // already scans every repository for a stopped operation.
  assert.match(src("merge/gitstudioMerge.ts"), /operationContextKey: "gitstudio\.operationInProgress"/);
});

test("the process audit is listed only while the audit is on", () => {
  assert.match(palette.get("gitstudio.debug.showProcessAudit") ?? "", /config\.gitstudio\.debug\.logChildProcesses/);
});
