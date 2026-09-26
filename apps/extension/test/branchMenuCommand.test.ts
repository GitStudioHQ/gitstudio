import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The branch menu from the keyboard. It opened only from the branch pill and
// the status-bar item, both needing the mouse: no command in the palette and
// nothing to bind a key to. "GitStudio: Branches…" is that command — shown
// while a repository is open, and doing exactly what the status bar does.

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const manifest = JSON.parse(read("../package.json")) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus: { commandPalette: { command: string; when?: string }[] };
  };
};
const ID = "gitstudio.branches.open";

test("'GitStudio: Branches…' is in the palette while a repository is open", () => {
  const cmd = manifest.contributes.commands.find((c) => c.command === ID);
  assert.ok(cmd, `${ID} is contributed`);
  assert.equal(`${cmd.category}: ${cmd.title}`, "GitStudio: Branches…");
  const shown = manifest.contributes.menus.commandPalette.filter((m) => m.command === ID);
  assert.deepEqual(shown, [{ command: ID, when: "gitstudio.hasRepo" }]);
});

test("the command opens the Changes view's branch menu, as the status bar does", () => {
  const src = read("../src/extension.ts");
  const at = src.indexOf(`registerCommand("${ID}"`);
  assert.ok(at > 0, `${ID} is registered in extension.ts`);
  // The handler is the next arrow function: it calls the view's openBranchMenu.
  const handler = src.slice(at, src.indexOf(")", src.indexOf("openBranchMenu(", at)) + 1);
  assert.match(handler, /^registerCommand\("gitstudio\.branches\.open", \(\) =>\s+commitProvider\.openBranchMenu\(\)$/);
});
