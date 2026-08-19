/**
 * What the terminal status-bar button shows.
 *
 * Pure, so it can be tested without vscode. The behaviour it describes is
 * modelled on krish-r's Toggle Terminal, improving on two things that extension
 * documents about itself: it does not show a count (terminal names are an
 * opt-in, experimental hover), and clicking it often fails to hide the terminal,
 * so its own README tells you to click twice.
 */

/** Codicons that exist for shells, so an unknown shell cannot produce a blank. */
const SHELL_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/git-?bash/i, "terminal-git-bash"],
  [/powershell|pwsh/i, "terminal-powershell"],
  [/cmd\.exe$|^cmd$/i, "terminal-cmd"],
  [/tmux/i, "terminal-tmux"],
  [/bash|zsh|sh$|fish/i, "terminal-bash"],
  [/ubuntu/i, "terminal-ubuntu"],
  [/debian/i, "terminal-debian"],
];

/**
 * The codicon for a shell path, e.g. "/bin/zsh" -> "terminal-bash".
 *
 * Shell-specific rather than the generic glyph, because at a glance it also
 * tells you WHICH shell you are about to get — the generic one says only that
 * a terminal exists, which you can already see.
 */
export function shellIcon(shellPath: string | undefined): string {
  if (!shellPath) return "terminal";
  for (const [pattern, icon] of SHELL_ICONS) {
    if (pattern.test(shellPath)) return icon;
  }
  return "terminal";
}

/**
 * The button's label: the icon, plus a count once there is more than one.
 *
 * One terminal needs no number — the icon already says there is a terminal, and
 * a permanent "1" is noise. Two or more is information you cannot get without
 * opening the panel.
 */
export function terminalLabel(icon: string, count: number): string {
  return count > 1 ? `$(${icon}) ${count}` : `$(${icon})`;
}

/**
 * The hover: what clicking will do, then the terminals by name.
 *
 * Names are listed unconditionally. They are the reason to hover at all, and
 * hiding them behind an experimental setting means nobody ever sees them.
 */
export function terminalTooltip(
  names: readonly string[],
  willHide: boolean,
): string {
  const action = willHide
    ? "Hide the terminal"
    : names.length === 0
      ? "Open a terminal at the repository root"
      : "Show the terminal";
  if (names.length === 0) return `GitStudio: ${action}`;
  const heading = names.length === 1 ? "1 terminal" : `${names.length} terminals`;
  return [`GitStudio: ${action}`, "", heading, ...names.map((n) => `• ${n}`)].join("\n");
}
