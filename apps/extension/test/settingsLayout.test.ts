// GitStudio's settings in the Settings editor: titled groups in an order that
// starts with what people change, and the ids people have in their
// settings.json exactly as they were.
//
// It was one flat "GitStudio" list with no order, so the Settings editor
// sorted it by key and showed fourteen AI settings first, with the Changes
// view's staging model somewhere among the blame gutter options.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { configuration: unknown };
};

interface Category {
  id?: string;
  title?: string;
  order?: number;
  properties: Record<string, { default?: unknown; order?: number }>;
}

/**
 * Every setting id and default as 1.14.0 shipped them. Grouping moves where a
 * setting is SHOWN; an id that changed would silently drop what a user set.
 */
const SHIPPED: Record<string, unknown> = {
  "gitstudio.debug.logChildProcesses": false,
  "gitstudio.fetch.prune": true,
  "gitstudio.blame.inlineEnabled": true,
  "gitstudio.blame.statusBarEnabled": true,
  "gitstudio.changesBadge": true,
  "gitstudio.changes.stagingModel": "split",
  "gitstudio.changes.autoRefresh": true,
  "gitstudio.blame.clickOpensCommit": true,
  "gitstudio.blame.gutter.fields": ["date", "author"],
  "gitstudio.blame.gutter.nameStyle": "fullName",
  "gitstudio.blame.gutter.colors": "order",
  "gitstudio.blame.showDiffOnHover": true,
  "gitstudio.blame.heatmap": true,
  "gitstudio.merge.autoOpen": true,
  "gitstudio.merge.autoApplyNonConflicting": false,
  "gitstudio.merge.conflictResolver": "embedded",
  "gitstudio.merge.diffTool": "embedded",
  "gitstudio.merge.preferredIde": "auto",
  "gitstudio.merge.jetbrainsPath": "",
  "gitstudio.commit.signoffByDefault": false,
  "gitstudio.worktrees.prefixWithProjectName": false,
  "gitstudio.ai.provider": "auto",
  "gitstudio.ai.openai.baseUrl": "https://api.openai.com/v1",
  "gitstudio.ai.openai.modelFast": "gpt-4o-mini",
  "gitstudio.ai.openai.modelMid": "gpt-4o-mini",
  "gitstudio.ai.openai.modelDeep": "gpt-4o",
  "gitstudio.ai.anthropicModelFast": "claude-haiku-4-5",
  "gitstudio.ai.anthropicModelMid": "claude-sonnet-4-6",
  "gitstudio.ai.anthropicModelDeep": "claude-opus-4-8",
  "gitstudio.ai.commitStyle": "conventional",
  "gitstudio.ai.reviewPrompt": "",
  "gitstudio.ai.cliAgent": "",
  "gitstudio.ai.cliModel": "",
  "gitstudio.pr.defaultMergeMethod": "squash",
  "gitstudio.errorReporting.enabled": true,
  "gitstudio.errorReporting.endpoint": "https://gitstudio.dev/api/errors",
  "gitstudio.staging.showGutterState": true,
  "gitstudio.staging.clickGutterToggles": false,
  "gitstudio.statusBar.showGraph": true,
  "gitstudio.statusBar.showTerminal": true,
};

const categories = (): Category[] => {
  const c = pkg.contributes.configuration;
  assert.ok(Array.isArray(c), "the settings are grouped into categories");
  return c as Category[];
};

test("every shipped setting keeps its id and its default, in exactly one group", () => {
  const seen = new Map<string, number>();
  for (const c of categories()) {
    for (const [id, schema] of Object.entries(c.properties)) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (id in SHIPPED) assert.deepEqual(schema.default, SHIPPED[id], `${id}'s default`);
    }
  }
  const missing = Object.keys(SHIPPED).filter((id) => !seen.has(id));
  assert.deepEqual(missing, [], "a renamed or dropped id loses what users set");
  const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(twice, []);
});

test("the groups are titled and ordered — what people change first, AI and Advanced last", () => {
  const cs = categories();
  const titles = cs.map((c) => c.title);
  assert.deepEqual(titles, ["General", "Changes & Staging", "Commit & Sync", "Blame", "Merge & Diff", "AI", "Advanced"]);
  assert.deepEqual(
    cs.map((c) => c.order),
    cs.map((_, i) => i + 1),
  );
  for (const c of cs) {
    assert.match(c.id ?? "", /^gitstudio\.[a-z]+$/, `${c.title} has an id`);
    const orders = Object.values(c.properties).map((p) => p.order);
    assert.ok(
      orders.every((o) => typeof o === "number"),
      `${c.title}: every setting has an order, so the editor does not sort it by key`,
    );
    assert.equal(new Set(orders).size, orders.length, `${c.title}: no two share a place`);
  }
  // Each group holds its own kind: a setting's section says where it lives.
  const where = (id: string) => cs.find((c) => id in c.properties)?.title;
  for (const id of Object.keys(SHIPPED)) {
    if (id.startsWith("gitstudio.ai.")) assert.equal(where(id), "AI", id);
    if (id.startsWith("gitstudio.blame.")) assert.equal(where(id), "Blame", id);
    if (id.startsWith("gitstudio.merge.")) assert.equal(where(id), "Merge & Diff", id);
    if (id.startsWith("gitstudio.staging.") || id.startsWith("gitstudio.changes")) assert.equal(where(id), "Changes & Staging", id);
  }
  // The first setting of each group is the one people reach for.
  const first = (title: string) =>
    Object.entries(cs.find((c) => c.title === title)!.properties).find(([, p]) => p.order === 1)![0];
  assert.equal(first("Changes & Staging"), "gitstudio.changes.stagingModel");
  assert.equal(first("AI"), "gitstudio.ai.provider");
  assert.equal(first("Blame"), "gitstudio.blame.inlineEnabled");
});
