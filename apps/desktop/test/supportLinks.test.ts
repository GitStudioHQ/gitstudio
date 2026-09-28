// Support GitStudio: the two pages, and Help ▸ Sponsor GitStudio on GitHub… /
// Buy Me a Coffee….
//
// The owner's rule for it: visible, not annoying. The app offers the two ways
// only where people go looking (Help, Settings ▸ About, ⌘K) and on one quiet
// line at the foot of Home — the renderer's half is the harness's
// (home-ends-on-one-quiet-support-line, the-about-card-offers-both-ways-to-
// support, the-palette-offers-both-ways-to-support). Here: the list every one
// of them reads, the menu items built from it, and that main.ts puts those
// items in Help and opens them through openExternalSafely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SUPPORT_LEAD, SUPPORT_LINKS, SUPPORT_SENTENCE } from "../src/shared/support";
import { supportMenuItems } from "../src/main/supportMenu";

const SPONSOR = "https://github.com/sponsors/antonarnaudov";
const COFFEE = "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d";

test("the two ways, in the READMEs' words, to exactly the two pages", () => {
  assert.deepEqual(
    SUPPORT_LINKS.map((l) => [l.id, l.url, l.icon, l.label, l.blurb]),
    [
      ["sponsor", SPONSOR, "heart", "Sponsor on GitHub", "recurring support"],
      ["coffee", COFFEE, "coffee", "Buy me a coffee", "a one-off tip"],
    ],
  );
  assert.equal(SUPPORT_SENTENCE, "GitStudio is free and open source. If it saves you time, you can support it.");
  assert.equal(SUPPORT_LEAD, "GitStudio is free and open source.");
  // The same pages as the repository's own Sponsor button.
  const funding = readFileSync(join(__dirname, "..", "..", "..", ".github", "FUNDING.yml"), "utf8");
  assert.match(funding, /^github: \[antonarnaudov\]$/m);
  assert.ok(funding.includes(`custom: ["${COFFEE}"]`));
});

test("every icon is a codicon the app ships", () => {
  const css = readFileSync(join(__dirname, "..", "src", "renderer", "styles", "codicons-full.css"), "utf8");
  for (const l of SUPPORT_LINKS) assert.ok(css.includes(`.codicon-${l.icon}:before`), `codicon-${l.icon}`);
});

test("the Help menu's two items: their words, their order, and the page each opens", () => {
  const opened: string[] = [];
  const items = supportMenuItems((url) => opened.push(url));
  assert.deepEqual(
    items.map((i) => i.label),
    ["Sponsor GitStudio on GitHub…", "Buy Me a Coffee…"],
  );
  for (const i of items) {
    assert.equal(i.type, undefined, "plain items");
    assert.equal(i.accelerator, undefined, "no shortcut of their own");
    (i.click as () => void)();
  }
  assert.deepEqual(opened, [SPONSOR, COFFEE]);
  // openExternalSafely hands only http(s) and mailto to the OS: both pass.
  for (const url of opened) assert.equal(new URL(url).protocol, "https:");
});

test("main.ts puts them in Help, between Report an Issue and the crash-report switch, through openExternalSafely", () => {
  const src = readFileSync(join(__dirname, "..", "src", "main", "main.ts"), "utf8");
  const help = src.slice(src.indexOf('role: "help"'), src.indexOf("Menu.setApplicationMenu"));
  assert.ok(help.length > 0, "the Help menu is where it was");
  const report = help.indexOf('label: "Report an Issue"');
  const support = help.indexOf("...supportMenuItems(openExternalSafely)");
  const crash = help.indexOf('label: "Send Anonymous Crash Reports"');
  assert.ok(report >= 0 && support > report && crash > support, "Report an Issue, then support, then crash reports");
  // A separator on each side: a group of its own.
  const between = (a: number, b: number) => help.slice(a, b).match(/type: "separator"/g)?.length ?? 0;
  assert.equal(between(report, support), 1, "a separator before them");
  assert.equal(between(support, crash), 1, "and one after");
  assert.equal(src.match(/supportMenuItems\(/g)?.length, 1, "Help is the only menu that has them");
});

test("nothing offers them by itself: every place that names the pages is shared/support.ts", () => {
  const SRC = join(__dirname, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(name)) files.push(p);
    }
  };
  walk(SRC);
  const naming = files
    .filter((f) => /sponsors\/antonarnaudov|checkout\.revolut\.com/.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).split("\\").join("/"));
  assert.deepEqual(naming, ["shared/support.ts"]);
  // Read only where they are offered, each a place you go to: the Help menu
  // (main/supportMenu.ts), Settings ▸ About and ⌘K (renderer.ts), and Home's
  // foot line (views/dashboard.ts).
  const readers = files
    .filter((f) => /from "(\.\.\/)+shared\/support"/.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).split("\\").join("/"))
    .sort();
  assert.deepEqual(readers, ["main/supportMenu.ts", "renderer/renderer.ts", "renderer/views/dashboard.ts"]);
});
