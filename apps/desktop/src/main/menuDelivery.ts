// Where a menu command goes when the window it is for may not be there.
//
// Menu items hand their work to the renderer (menu:command) — the renderer is
// what knows whether a dialog is open in the tab in front, and a switch under
// an open dialog would let its verb run in another tab (issue #32). But on
// macOS the app keeps running with its window closed, and a message sent to no
// window goes nowhere: File ▸ Open Recent ▸ <repo>, ⌘O and Clone… did nothing
// at all, where before the tabs they opened the repository and the next
// window showed it. Opening a repository is a reason to have a window again.

import type { IpcEvents } from "../shared/ipc";

export type MenuCommand = IpcEvents["menu:command"];

/** The window, as far as a menu command is concerned. */
export type WindowState = "none" | "loading" | "ready";

/**
 * - `send`: the renderer is listening — hand it over.
 * - `afterLoad`: the window is still loading; its listeners are not there yet.
 * - `createThenSend`: no window, and the command is a reason to have one.
 * - `drop`: no window, and nothing to do without one (Refresh, Undo…).
 */
export type Delivery = "send" | "afterLoad" | "createThenSend" | "drop";

/** The commands that open a repository — each one brings the window back. */
const OPENS: ReadonlySet<MenuCommand["command"]> = new Set<MenuCommand["command"]>([
  "openPath",
  "openRepo",
  "cloneRepo",
]);

export function menuDelivery(win: WindowState, command: MenuCommand["command"]): Delivery {
  if (win === "ready") return "send";
  if (win === "loading") return "afterLoad";
  return OPENS.has(command) ? "createThenSend" : "drop";
}
