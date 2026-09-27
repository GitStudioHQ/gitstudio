// What the README and the walkthrough say, checked against what ships.
//
// - The README said "`Enter` commits" in the commit box; Enter is a newline,
//   and committing is the Commit button (commitView.ts, by design).
// - Its shortcut table left out Ctrl/Cmd+Alt+G T.
// - It and the walkthrough said AI is "off by default" / "off until you turn
//   it on", while gitstudio.ai.provider defaults to "auto", which uses
//   Copilot's (or Cursor's) model the moment there is one.
// - The walkthrough put the Commits view "at the top of the GitStudio
//   sidebar" (Changes is at the top) and the graph "full-screen in an editor
//   tab" (Open Commit Graph opens the bottom panel).
// - Two images in media/ were used by nothing and shipped in every VSIX.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configurationProperties } from "@gitstudio/merge-vscode/contract";

const ROOT = join(__dirname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const manifestText = readFileSync(join(ROOT, "package.json"), "utf8");
const pkg = JSON.parse(manifestText) as {
  contributes: {
    keybindings: { command: string; key: string; mac?: string }[];
    configuration: unknown;
    views: Record<string, { id: string; name: string }[]>;
    walkthroughs: { steps: { id: string; description: string }[] }[];
  };
};
const step = (id: string): string => pkg.contributes.walkthroughs[0].steps.find((s) => s.id === id)?.description ?? "";

/** "ctrl+alt+g t" → "`Ctrl+Alt+G` `T`", as the README's table writes a chord. */
function chord(key: string): string {
  return key
    .split(" ")
    .map((part) => "`" + part.split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join("+") + "`")
    .join(" ");
}

test("the README's shortcut table lists every contributed binding", () => {
  const missing = pkg.contributes.keybindings.filter((k) => !readme.includes(chord(k.key))).map((k) => `${k.command} ${k.key}`);
  assert.deepEqual(missing, []);
});

test("the README does not promise Enter commits", () => {
  assert.doesNotMatch(readme, /`Enter` commits/);
  assert.match(
    readFileSync(join(ROOT, "src", "changes", "commitView.ts"), "utf8"),
    /Enter is just a newline — committing is button-only, by design/,
    "the premise: Enter in the commit box is a newline",
  );
});

test("nothing says AI is off by default while the provider defaults to auto", () => {
  const props = configurationProperties(pkg.contributes.configuration) as Record<string, { default?: unknown }>;
  assert.equal(props["gitstudio.ai.provider"].default, "auto");
  const offByDefault = /[Oo]ff by default|[Oo]ff until you turn it on/;
  assert.doesNotMatch(readme, offByDefault);
  assert.doesNotMatch(step("gitstudio.walkthrough.connect"), offByDefault);
});

test("the walkthrough places the graph where it is", () => {
  const views = pkg.contributes.views.gitstudio.map((v) => v.name);
  assert.equal(views[0], "Changes", "the premise: Changes is at the top of the sidebar");
  assert.equal(pkg.contributes.views.gitstudioPanel[0].name, "Commit Graph", "…and the graph command's panel");
  const graph = step("gitstudio.walkthrough.graph");
  assert.doesNotMatch(graph, /at the top of the GitStudio sidebar/);
  assert.doesNotMatch(graph, /editor tab/);
  assert.match(graph, /\*\*Commits\*\* view/);
  assert.match(graph, /\*\*Commit Graph\*\* panel/);
});

test("the README's sidebar names only views that ship; stashes are under Changes, as the walkthrough says", () => {
  const views = new Set(pkg.contributes.views.gitstudio.map((v) => v.name));
  assert.equal(views.has("Stashes"), false, "the premise: there is no Stashes view any more");
  const sidebar = /The sidebar reads top-to-bottom as a workflow: (.*?)\. /.exec(readme)?.[1] ?? "";
  const named = [...sidebar.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
  assert.ok(named.length > 0, "the README still says how the sidebar reads");
  assert.deepEqual(named.filter((n) => !views.has(n)), [], "every view the README names is one the sidebar has");
  assert.doesNotMatch(readme, /Stashes\*\* get a first-class view/);
  assert.match(step("gitstudio.walkthrough.stage"), /stashes are listed under your changes/);
});

test("every image in media/ is used by the manifest, the README or the code", () => {
  const sources = [manifestText, readme];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) sources.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  const unused = readdirSync(join(ROOT, "media"))
    .filter((f) => f.endsWith(".png"))
    .filter((f) => !sources.some((s) => s.includes(f)));
  assert.deepEqual(unused, []);
});
