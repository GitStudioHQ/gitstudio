// Copy that tells the user to run a command names one that exists.
//
// The Anthropic provider's "key missing" error and the ai.provider setting both
// said to run "GitStudio: Set AI API Key", and there is no such command (it is
// "Set Anthropic API Key…", and the guided one is "Connect AI Provider"). The
// walkthrough's "Set AI API Key" button opened the Anthropic-only prompt, not
// the panel that connects any provider.
//
// A reference is a command name in curly quotes or bold — “GitStudio: X”,
// **GitStudio: X**, *GitStudio: X* — or after "via". Toasts that merely begin
// with "GitStudio:" are not references.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readManifest } from "./manifest";

const ROOT = join(__dirname, "..");
const pkg = readManifest() as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    walkthroughs: { steps: { id: string; description: string; completionEvents?: string[] }[] }[];
  };
};

/** "GitStudio: Title", without a trailing ellipsis (copy may drop it). */
const bare = (s: string): string => s.trim().replace(/…$/, "");
const titles = new Set(pkg.contributes.commands.map((c) => bare(`${c.category ?? ""}: ${c.title}`)));

function strings(o: unknown, out: string[] = []): string[] {
  if (typeof o === "string") out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => strings(v, out));
  else if (o && typeof o === "object") Object.values(o).forEach((v) => strings(v, out));
  return out;
}

function sources(dir: string, out: [string, string][] = []): [string, string][] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".ts")) out.push([relative(ROOT, p), readFileSync(p, "utf8")]);
  }
  return out;
}

const REFERENCE = /(?:“|\*\*?|via )(GitStudio: [A-Z][^”*\n)"]*?)(?:”|\*|\)|")/g;

test("every command the copy tells you to run exists", () => {
  const texts: [string, string][] = [
    ...sources(join(ROOT, "src")),
    ["README.md", readFileSync(join(ROOT, "README.md"), "utf8")],
    ...strings(pkg.contributes).map((s, i): [string, string] => [`package.json#${i}`, s]),
  ];
  const missing: string[] = [];
  let seen = 0;
  for (const [where, text] of texts) {
    for (const m of text.matchAll(REFERENCE)) {
      seen++;
      if (!titles.has(bare(m[1]))) missing.push(`${where}: ${m[1]}`);
    }
  }
  assert.ok(seen >= 5, `the census found the references (${seen})`);
  assert.deepEqual(missing, []);
});

test("the walkthrough's AI button opens Connect AI Provider, which covers every provider", () => {
  const step = pkg.contributes.walkthroughs[0].steps.find((s) => s.id === "gitstudio.walkthrough.connect");
  assert.ok(step);
  assert.match(step.description, /\]\(command:gitstudio\.ai\.connect\)/);
  assert.doesNotMatch(step.description, /command:gitstudio\.ai\.setApiKey/);
  assert.ok(step.completionEvents?.includes("onCommand:gitstudio.ai.connect"));
});
