import { test } from "node:test";
import assert from "node:assert/strict";
import { shellIcon, terminalLabel, terminalTooltip } from "../src/statusBar/terminalBadge";

// The terminal status-bar button. Modelled on krish-r's Toggle Terminal and
// improving on the two things that extension documents about itself: no count,
// and terminal names hidden behind an experimental opt-in.

test("the icon follows the shell, so it says WHICH shell you will get", () => {
  assert.equal(shellIcon("/bin/zsh"), "terminal-bash");
  assert.equal(shellIcon("/bin/bash"), "terminal-bash");
  assert.equal(shellIcon("/usr/bin/fish"), "terminal-bash");
  assert.equal(shellIcon("C:\\Program Files\\PowerShell\\pwsh.exe"), "terminal-powershell");
  assert.equal(shellIcon("C:\\Windows\\System32\\cmd.exe"), "terminal-cmd");
  assert.equal(shellIcon("C:\\Program Files\\Git\\bin\\git-bash.exe"), "terminal-git-bash");
  assert.equal(shellIcon("/usr/bin/tmux"), "terminal-tmux");
});

test("an unknown or missing shell falls back to a real icon, never a blank", () => {
  // A codicon name that does not exist renders as an empty box in the bar.
  assert.equal(shellIcon(undefined), "terminal");
  assert.equal(shellIcon(""), "terminal");
  assert.equal(shellIcon("/opt/weird/nushell-x"), "terminal");
});

test("git-bash is matched before bash, since its path contains both", () => {
  assert.equal(shellIcon("/c/Program Files/Git/git-bash.exe"), "terminal-git-bash");
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
