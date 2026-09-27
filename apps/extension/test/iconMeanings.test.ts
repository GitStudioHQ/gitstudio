// One symbol, one meaning.
//
// codicon-checklist meant three things within the Changes view and the editor
// title — Review changes with AI, switch to the checkbox model, and Stage with
// Ticks — and codicon-list-selection meant both the staged/unstaged model and
// the Compare panel's unified diff. A symbol a person learns in one place
// must not do something else in the next.
//
// The census reads the icons each control actually wears, from the shipped
// templates and the manifest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");
const changes = readFileSync(join(SRC, "changes", "commitView.ts"), "utf8");
const compare = readFileSync(join(SRC, "compare", "comparePanel.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { commands: { command: string; icon?: string }[] };
};

/** The codicon inside the element with this id (the first, or the one with `cls`). */
function glyph(text: string, id: string, cls?: string): string {
  const start = text.indexOf(`id="${id}"`);
  assert.ok(start > 0, `${id} exists`);
  const end = text.indexOf("</button>", start);
  const inner = text.slice(start, end);
  const re = cls
    ? new RegExp(`codicon codicon-([a-z0-9-]+) ${cls}\\b`)
    : /codicon codicon-([a-z0-9-]+)/;
  const m = re.exec(inner);
  assert.ok(m, `${id} wears a codicon${cls ? " (" + cls + ")" : ""}`);
  return m[1];
}
const commandIcon = (id: string) =>
  (pkg.contributes.commands.find((c) => c.command === id)?.icon ?? "").replace(/^\$\((.*)\)$/, "$1");

test("each action wears its own symbol; one meaning shares one", () => {
  const meanings: Record<string, string> = {
    "review changes with AI": glyph(changes, "review"),
    "work with ticks (checkbox model)": glyph(changes, "model-toggle", "to-checks"),
    "work with Staged / Unstaged": glyph(changes, "model-toggle", "to-split"),
    "generate a commit message": glyph(changes, "generate"),
    "unified diff": glyph(compare, "diff-unified"),
    "side-by-side diff": glyph(compare, "diff-split"),
  };
  const byIcon = new Map<string, string[]>();
  for (const [meaning, icon] of Object.entries(meanings)) {
    byIcon.set(icon, [...(byIcon.get(icon) ?? []), meaning]);
  }
  const shared = [...byIcon].filter(([, ms]) => ms.length > 1).map(([icon, ms]) => `${icon}: ${ms.join(" / ")}`);
  assert.deepEqual(shared, [], "one symbol, several meanings");
  // Stage with Ticks (the editor title) IS the checkbox model's meaning: the same symbol.
  assert.equal(commandIcon("gitstudio.stageWithTicks"), meanings["work with ticks (checkbox model)"]);
  assert.equal(meanings["review changes with AI"], "code-review");
  assert.equal(meanings["unified diff"], "diff-single");
  assert.equal(meanings["side-by-side diff"], "diff-sidebyside");
});
