import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalIcon, terminalLabel, terminalTooltip } from "../src/statusBar/terminalBadge";

// The terminal status-bar button. Modelled on krish-r's Toggle Terminal and
// improving on the two things that extension documents about itself: no count,
// and terminal names hidden behind an experimental opt-in.

test("the glyph is the plain terminal one, not a shell variant", () => {
  // The shell-specific codicons put a shell mark inside an already small box;
  // at status-bar size that reads as clutter, and the shell is not something
  // worth being told every time you glance down.
  assert.equal(terminalIcon(), "terminal");
});

test("one terminal shows no number; two or more do", () => {
  // A permanent "1" is noise — the icon already says a terminal exists.
  assert.equal(terminalLabel("terminal-bash", 0), "$(terminal-bash)");
  assert.equal(terminalLabel("terminal-bash", 1), "$(terminal-bash)");
  assert.equal(terminalLabel("terminal-bash", 2), "$(terminal-bash) 2");
  assert.equal(terminalLabel("terminal-bash", 11), "$(terminal-bash) 11");
});

test("with no terminals the hover offers to open one at the repo root", () => {
  assert.equal(
    terminalTooltip([], false),
    "GitStudio: Open a terminal at the repository root",
  );
});

test("the hover lists every terminal by name, unconditionally", () => {
  const t = terminalTooltip(["GitStudio: gitstudio", "zsh", "build watch"], false);
  assert.match(t, /3 terminals/);
  for (const n of ["GitStudio: gitstudio", "zsh", "build watch"]) {
    assert.ok(t.includes(n), `expected ${n} in the hover`);
  }
});

test("the hover says which way the click will go", () => {
  assert.match(terminalTooltip(["zsh"], true), /^GitStudio: Hide the terminal/);
  assert.match(terminalTooltip(["zsh"], false), /^GitStudio: Show the terminal/);
});

test("one terminal is singular in the hover", () => {
  assert.match(terminalTooltip(["zsh"], false), /\n1 terminal\n/);
});
