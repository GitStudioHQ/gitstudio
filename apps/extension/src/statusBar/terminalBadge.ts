import * as l10n from "@vscode/l10n";
/**
 * What the terminal status-bar button shows.
 *
 * Pure, so it can be tested without vscode. The behaviour it describes is
 * modelled on krish-r's Toggle Terminal, improving on two things that extension
 * documents about itself: it does not show a count (terminal names are an
 * opt-in, experimental hover), and clicking it often fails to hide the terminal,
 * so its own README tells you to click twice.
 */

/**
 * The terminal glyph.
 *
 * Deliberately the plain one. The shell-specific codicons (terminal-bash,
 * terminal-powershell, …) carry a shell mark inside an already small box, and at
 * status-bar size that reads as clutter rather than as information — and the
 * shell is not something you need told twelve times an hour. The clean glyph is
 * the one VS Code uses for the terminal everywhere else, which is also the point:
 * a button that opens a terminal should look like the terminal.
 */
export function terminalIcon(): string {
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
    ? l10n.t("Hide the terminal")
    : names.length === 0
      ? l10n.t("Open a terminal at the repository root")
      : l10n.t("Show the terminal");
  if (names.length === 0) return l10n.t("GitStudio: {0}", action);
  const heading = names.length === 1 ? l10n.t("1 terminal") : l10n.t("{0} terminals", names.length);
  return [l10n.t("GitStudio: {0}", action), "", heading, ...names.map((n) => `• ${n}`)].join("\n");
}
