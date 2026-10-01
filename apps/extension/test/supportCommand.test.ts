// Support GitStudio… — where it is offered, what it asks, and what it opens.
//
// The owner's rule for it: visible, but not annoying. So it is only ever
// ASKED FOR: the command palette, the very bottom of the Changes view's "…"
// menu, one line at the end of the walkthrough, and the ♥ Sponsor button the
// manifest's `sponsor` field puts on the extension's page. Nothing offers it by
// itself — no toast, no status-bar item, no timer, no count.
//
// The question is GitStudio's own pick dialog (noVsCodePrompts bans the quick
// input), and it is run below from the shipped Changes view template, in
// Dark+ and Light+.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readManifest } from "./manifest";
import { GITSTUDIO_SUPPORT_COMMAND } from "../src/merge/mergeIds";
import { askAndOpenSupport, COFFEE_URL, SPONSOR_URL, supportPickSpec, supportUrl } from "../src/ui/support";
import { changesViewPage, findChrome, runChangesView, statePayload, type ThemeName } from "./changesViewPage";

const ROOT = join(__dirname, "..");
const REPO = join(ROOT, "..", "..");

interface MenuEntry {
  command?: string;
  when?: string;
  group?: string;
}
const pkg = readManifest() as {
  sponsor?: { url?: string };
  badges: { url: string; href: string; description: string }[];
  contributes: {
    commands: { command: string; title: string; category?: string; icon?: string }[];
    menus: Record<string, MenuEntry[]>;
    walkthroughs: { steps: { id: string; description: string; completionEvents?: string[] }[] }[];
  };
};

test("the pages are exactly the two the READMEs and the repository's FUNDING.yml name", () => {
  assert.equal(SPONSOR_URL, "https://github.com/sponsors/antonarnaudov");
  assert.equal(COFFEE_URL, "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d");
  // The ♥ Sponsor button on the extension's page is the manifest's field.
  assert.equal(pkg.sponsor?.url, SPONSOR_URL);
  assert.equal(pkg.badges.find((b) => /Sponsor/.test(b.url))?.href, SPONSOR_URL, "the Sponsor badge");
  // The repository's own Sponsor button.
  const funding = readFileSync(join(REPO, ".github", "FUNDING.yml"), "utf8");
  assert.match(funding, /^github: \[antonarnaudov\]$/m);
  assert.ok(funding.includes(`custom: ["${COFFEE_URL}"]`), funding);
});

test("the command: declared, in the palette, in the product's words", () => {
  assert.equal(GITSTUDIO_SUPPORT_COMMAND, "gitstudio.support");
  const cmd = pkg.contributes.commands.find((c) => c.command === GITSTUDIO_SUPPORT_COMMAND);
  assert.deepEqual(cmd, { command: "gitstudio.support", title: "Support GitStudio…", category: "GitStudio", icon: "$(heart)" });
  const palette = pkg.contributes.menus.commandPalette.find((e) => e.command === GITSTUDIO_SUPPORT_COMMAND);
  assert.ok(!palette || palette.when !== "false", "listed in the palette");
});

test("it sits at the very bottom of the Changes view's … menu, and in no other menu", () => {
  const where: string[] = [];
  for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
    if (menu === "commandPalette") continue;
    for (const e of entries) if (e.command === GITSTUDIO_SUPPORT_COMMAND) where.push(`${menu} | ${e.when} | ${e.group}`);
  }
  assert.deepEqual(where, ["view/title | view == gitstudio.commit | z_support@1"]);
  // VS Code orders a menu's groups by name, "navigation" first and a missing
  // group LAST: every other entry of that view's title has a group, and each
  // sorts before z_support, so Support is the last line of the "…" menu.
  const group = (e: MenuEntry) => (e.group ?? "").split("@")[0];
  const others = pkg.contributes.menus["view/title"].filter(
    (e) => e.command !== GITSTUDIO_SUPPORT_COMMAND && /\bview == gitstudio\.commit\b/.test(e.when ?? ""),
  );
  assert.ok(others.length >= 3, `the Changes view has its own title actions (${others.length})`);
  for (const e of others) {
    assert.ok(group(e), `${e.command} has a group`);
    assert.ok(group(e).localeCompare("z_support") < 0, `${e.command} (${group(e)}) sorts before z_support`);
  }
});

test("the walkthrough ends on one quiet line: a link inside a sentence, not a button, not a step", () => {
  const steps = pkg.contributes.walkthroughs[0].steps;
  assert.equal(steps.length, 6, "no step of its own");
  const last = steps[steps.length - 1];
  const lines = last.description.split("\n");
  // A line that is ONLY a link renders as a button; text around it keeps it a link.
  assert.equal(lines[lines.length - 1], "GitStudio is free and open source. [Support GitStudio…](command:gitstudio.support)");
  assert.ok(!(last.completionEvents ?? []).some((e) => e.includes(GITSTUDIO_SUPPORT_COMMAND)), "supporting is never a task to tick off");
  for (const s of steps.slice(0, -1)) assert.doesNotMatch(s.description, /gitstudio\.support/, `${s.id} does not ask`);
});

test("the question: the two ways, in the README's words, with codicons that exist", () => {
  const spec = supportPickSpec();
  assert.equal(spec.title, "Support GitStudio");
  assert.equal(spec.message, "GitStudio is free and open source. If it saves you time, you can support it.");
  assert.deepEqual(spec.choices, [
    { id: "sponsor", label: "Sponsor on GitHub", icon: "heart", description: "Recurring support" },
    { id: "coffee", label: "Buy me a coffee", icon: "coffee", description: "A one-off tip" },
  ]);
  assert.equal(spec.filter, false, "two rows need no filter box");
  // The font the webviews load (esbuild copies it from here).
  const codicons = readFileSync(join(REPO, "node_modules", "@vscode", "codicons", "dist", "codicon.css"), "utf8");
  for (const c of spec.choices) assert.ok(codicons.includes(`.codicon-${c.icon}:before`), `codicon-${c.icon} exists`);
});

test("an answer opens exactly its page; a dismissed dialog opens nothing", async () => {
  assert.equal(supportUrl("sponsor"), SPONSOR_URL);
  assert.equal(supportUrl("coffee"), COFFEE_URL);
  assert.equal(supportUrl(undefined), undefined);
  assert.equal(supportUrl("https://example.com"), undefined, "only the two known answers");
  for (const [answer, want] of [
    ["sponsor", [SPONSOR_URL]],
    ["coffee", [COFFEE_URL]],
    [undefined, []],
  ] as const) {
    const opened: string[] = [];
    const asked: unknown[] = [];
    await askAndOpenSupport(
      async (spec) => {
        asked.push(spec);
        return answer;
      },
      async (url) => opened.push(url),
    );
    assert.deepEqual(asked, [supportPickSpec()], "asked once, with the question above");
    assert.deepEqual(opened, want, String(answer));
  }
});

test("nothing offers it by itself: the command is only registered, and only ui/support.ts names the pages", () => {
  const SRC = join(ROOT, "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) files.push(p);
    }
  };
  walk(SRC);
  const naming: string[] = [];
  const running: string[] = [];
  for (const f of files) {
    const rel = relative(SRC, f).split("\\").join("/");
    const text = readFileSync(f, "utf8");
    if (/sponsors\/antonarnaudov|checkout\.revolut\.com/.test(text)) naming.push(rel);
    if (/executeCommand\(\s*(["'`]gitstudio\.support["'`]|GITSTUDIO_SUPPORT_COMMAND)/.test(text)) running.push(rel);
  }
  assert.deepEqual(naming, ["ui/support.ts"]);
  assert.deepEqual(running, [], "no code runs Support GitStudio… on the user's behalf");
  const entry = readFileSync(join(SRC, "extension.ts"), "utf8");
  assert.match(
    entry,
    /registerCommand\(GITSTUDIO_SUPPORT_COMMAND, \(\) =>\s*askAndOpenSupport\(\s*\(spec\) => promptPick\(spec\),\s*\(url\) => vscode\.env\.openExternal\(vscode\.Uri\.parse\(url\)\),?\s*\),?\s*\)/,
    "the command asks in GitStudio's dialog and opens the answer in the browser",
  );
});

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

for (const theme of ["dark", "light"] as ThemeName[]) {
  test(`${theme}: the dialog shows both ways with their icons, and a click answers with that one`, { skip }, async () => {
    const spec = { kind: "pick", ...supportPickSpec() };
    const page = changesViewPage({
      theme,
      harness: `
      post(${JSON.stringify(statePayload())});
      await tick();
      const spec = ${JSON.stringify(spec)};
      post({ type: "dialog", dialogId: "s1", spec });
      await tick();
      const panel = document.querySelector(".rp-panel");
      expect(panel, "the pick dialog opens");
      if (panel) {
        const text = (r, sel) => ((r.querySelector(sel) || { textContent: "" }).textContent || "").trim();
        expect(text(panel, ".rp-title") === "Support GitStudio", "titled Support GitStudio: " + text(panel, ".rp-title"));
        expect(text(panel, ".rp-msg") === spec.message, "the sentence says why: " + text(panel, ".rp-msg"));
        expect(!panel.querySelector(".rp-inputwrap input"), "no filter box for two rows");
        const rows = [...panel.querySelectorAll(".rp-choice")];
        notes.rows = rows.map((r) => [text(r, ".rp-choice-label"), text(r, ".rp-choice-desc")]);
        expect(rows.length === 2, "two ways: " + rows.length);
        expect(JSON.stringify(notes.rows) === JSON.stringify([["Sponsor on GitHub", "Recurring support"], ["Buy me a coffee", "A one-off tip"]]),
          "in the README's words");
        for (const [row, icon] of [[rows[0], "heart"], [rows[1], "coffee"]]) {
          const g = row && row.querySelector(".codicon-" + icon);
          const glyph = g ? getComputedStyle(g, "::before").content : "";
          expect(g && glyph && glyph !== "none" && glyph !== "normal", icon + " draws a codicon glyph (" + glyph + ")");
        }
        rows[1] && rows[1].click();
        const answer = posted.filter((m) => m && m.type === "dialogResult").pop();
        expect(answer && answer.dialogId === "s1" && answer.dialogValue === "coffee", "a click answers with that way: " + JSON.stringify(answer));
        expect(!document.querySelector(".rp-panel"), "and closes the dialog");
      }
      `,
    });
    const v = await runChangesView(CHROME!, page);
    assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
  });
}
